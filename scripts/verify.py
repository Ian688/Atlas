#!/usr/bin/env python3
"""Replay Atlas checks and record exit codes, source hashes, and scope limits.

Output goes to a per-run directory so historical evidence is never rewritten:
default `evidence/daily/<local-date>/<label>/`, or an explicit `--out DIR`.
The Modus sibling-repo protection check is optional: it runs only when a
baseline hash file is passed via `--modus-baseline`, and it reports "cannot
verify" instead of asserting protection when the Modus checkout is absent.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import os
import platform
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]

CHECKS = [
    ("rust-format", ["cargo", "fmt", "--all", "--check"]),
    ("rust-clippy", ["cargo", "clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]),
    ("rust-tests", ["cargo", "test", "--workspace", "--locked"]),
    ("rust-build", ["cargo", "build", "--workspace", "--locked"]),
    ("worker-tests", ["npm", "test", "--prefix", "workers/typescript"]),
    ("integration", [sys.executable, "scripts/test_integration.py"]),
    ("cancellation", [sys.executable, "scripts/test_cancellation.py"]),
    ("jobs", [sys.executable, "scripts/test_jobs.py"]),
    # Two processes, one store. The defect this pins was found by running three
    # real concurrent indexes against rxjs: two died on a raw "database is
    # locked". The writer lock must be waited for (cancellably), a spent budget
    # must be a named refusal, and a reader must not queue behind a publisher.
    ("store-concurrency", [sys.executable, "scripts/test_store_concurrency.py"]),
    # Incremental reuse is only sound if it publishes the same analysis a full
    # run would; every case here asserts that id equality, not just the hit rate.
    ("incremental", [sys.executable, "scripts/test_incremental.py"]),
    ("semantic-contracts", [sys.executable, "scripts/test_semantic_contracts.py"]),
    # Controlled execution is only meaningful if the boundary is real: these
    # cases require each denial to come from the operating system through Node,
    # and check that the side effect did not happen.
    ("execution", [sys.executable, "scripts/test_execution.py"]),
    # The bridge is where a model is allowed to act. These cases pin the two
    # things that keep that safe: a selection is refused rather than re-anchored
    # across versions, and only a closed set of actions is ever performed.
    ("bridge", [sys.executable, "scripts/test_bridge.py"]),
    # The AI Coding chain. Every case here is a refusal that protects something:
    # an unapplicable diff, a checkout that moved after review, a test that
    # never ran being read as a pass.
    ("patch", [sys.executable, "scripts/test_patch.py"]),
    # The host seam. The check that matters is structural: a host integration
    # that reads Atlas' store would be coupled to a layout the contract
    # explicitly does not promise.
    ("host-adapter", [sys.executable, "scripts/test_host_adapter.py"]),
    # Relocating a pinned selection across versions: the reported relocations and
    # the refusals, which are the part that keeps an old name off a new function.
    ("relocate", [sys.executable, "scripts/test_relocate.py"]),
    ("calculator", ["node", "examples/calculator/demo.mjs"]),
    # Readability as a number: a column that carries functions must not be
    # drawn invisibly, and the criterion must be able to fail (the linear scale
    # it replaced is checked against the same bar). No store, no network.
    ("view-readability", [sys.executable, "scripts/bench_view_readability.py", "--self-check"]),
    # Layout criteria, measured against the pinned engine in plain node. It is
    # deliberately not measured inside node:vm: the engine returned no
    # coordinates there at all, so a vm-based number would describe the host.
    ("view-layout", ["node", "scripts/bench_view_layout.mjs"]),
    ("web-syntax", ["node", "--check", "web/app.js"]),
    # The shared hierarchy: both projections read it, so a parse error here
    # would take down both pages at once.
    ("web-syntax-hierarchy", ["node", "--check", "web/hierarchy.js"]),
    ("city3d-syntax", ["node", "--check", "web/city3d.js"]),
    # Real behaviour, not just parseability: drives web/app.js in a DOM inside
    # node:vm. Both defects this replaced (a second connect() wiping the live
    # session, and a failed query leaving the previous selection's flow facts
    # under the new name) parse fine, which is why `--check` alone missed them.
    ("web-behaviour", ["node", "web/tests/app.behavior.test.mjs"]),
    # The 3D city's mapping is where a bug would draw a confident picture of
    # something the analysis never said, so it is checked without a GPU.
    ("city3d-behaviour", ["node", "web/tests/city3d.behavior.test.mjs"]),
    ("whitespace", ["git", "diff", "--check"]),
]

# Controls that are *expected* to fail: each one forces a bug that an existing
# assertion claims to catch. They cannot sit in CHECKS -- a permanently red gate
# is useless -- but they must run every time, or "is that assertion vacuous?"
# stays a one-off action somebody has to remember. A control passes only when
# the target exits non-zero *with unittest assertion failures*, so a crash, a
# missing binary or an environment error cannot be mistaken for the control
# working.
NEGATIVE_CONTROLS = [
    (
        "entry-backfill-frontier",
        [sys.executable, "scripts/test_semantic_contracts.py"],
        {"ATLAS_FORCE_ENTRY_BACKFILL": "1"},
        "forces the V-09 job-level entry backfill; the frontier assertions must go red",
    ),
]


def acquire_verify_lock(timeout_seconds: int):
    """Serialize verify.py runs against one workspace.

    Concurrent runs share `target/`, so a second run can read the first run's
    intermediate state and emit a red result that is not on disk -- or a green
    one built from stale artifacts. Both are false evidence. It waits rather
    than skipping, because a skipped check must never be reported as a pass.
    """
    path = ROOT / ".atlas-verify.lock"
    handle = open(path, "w")
    try:
        import fcntl
    except ImportError:
        # Non-POSIX: say so instead of pretending we serialized.
        handle.write(f"pid={os.getpid()} fcntl_unavailable=true\n")
        handle.flush()
        return handle
    deadline = time.monotonic() + max(timeout_seconds, 60)
    while True:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.monotonic() > deadline:
                handle.close()
                sys.exit(
                    "another verification run holds "
                    f"{path}; refusing to report results that may have been "
                    "built from its intermediate state"
                )
            time.sleep(1)
    handle.write(f"pid={os.getpid()}\n")
    handle.flush()
    return handle


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_fingerprint() -> str:
    """Recompute the build fingerprint the same way crates/atlas-engine/build.rs
    does: sha256 over `crates/**/*.rs`, `Cargo.lock`, and the workbench assets
    that `include_str!` bakes into the binary, keyed by workspace-relative path.
    Content-derived (no timestamp), so it is stable across rebuilds and can be
    compared against what the binary reports.
    """
    entries = {
        str(p.relative_to(ROOT)).replace(os.sep, "/"): p
        for p in ROOT.glob("crates/**/*.rs")
    }
    entries["Cargo.lock"] = ROOT / "Cargo.lock"
    for relative in (
        "web/index.html",
        "web/app.js",
        "web/hierarchy.js",
        "web/layout.js",
        "web/vendor/elk.bundled.js",
        "web/style.css",
        "web/city3d.html",
        "web/city3d.js",
    ):
        path = ROOT / relative
        if path.is_file():
            entries[relative] = path
    hasher = hashlib.sha256()
    for name in sorted(entries):
        hasher.update(name.encode())
        hasher.update(b"\0")
        path = entries[name]
        if path.is_file():
            hasher.update(path.read_bytes())
        hasher.update(b"\0")
    return hasher.hexdigest()


def check_fingerprint_pairing(timeout_seconds: int) -> dict:
    """A fingerprint nobody can check is decoration.

    Recompute it from source and compare against the value the binary reports.
    This turns "is this binary the one my source produces?" from a diagnosis a
    human has to remember into a gate the run answers: a stale binary now fails
    here instead of silently agreeing with every number it prints.
    """
    expected = source_fingerprint()
    binary = ROOT / "target" / "debug" / "atlas"
    result = {"checked": False, "match": False, "expected": expected, "actual": None}
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        not in ("ATLAS_MAX_TRANSFERS", "ATLAS_MAX_TOTAL_TRANSFERS", "ATLAS_FORCE_ENTRY_BACKFILL")
    }
    try:
        with tempfile.TemporaryDirectory(prefix="atlas-fingerprint-") as tmp:
            project = Path(tmp) / "project"
            project.mkdir()
            (project / "a.mjs").write_text("export function f(){ return 1; }\n")
            store = Path(tmp) / "store"
            indexed = subprocess.run(
                [str(binary), "--store", str(store), "index", str(project)],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout_seconds,
            )
            if indexed.returncode != 0:
                result["error"] = f"index failed: {indexed.stderr[-300:]}"
                return result
            analysis = json.loads(indexed.stdout)
            reported = subprocess.run(
                [str(binary), "--store", str(store), "report", analysis["id"]],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout_seconds,
            )
            if reported.returncode != 0:
                result["error"] = f"report failed: {reported.stderr[-300:]}"
                return result
            result["actual"] = json.loads(reported.stdout).get("binary_fingerprint")
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        result["error"] = str(error)
        return result
    result["checked"] = True
    result["match"] = result["actual"] == expected
    return result


def tree_fingerprint(skip: Path) -> dict:
    """Hash the tracked and untracked sources this run compiles or reads.

    The hazard these checks cannot see is a writer editing sources *while* the
    run compiles them: the result then describes a revision that is no longer
    on disk, or a mixture of two revisions. A lock that only verifiers take does
    not cover that, so the result is bound to a fingerprint instead, and a run
    whose sources moved is refused rather than reported.
    """
    listing = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=15,
    ).stdout.split("\n")
    # `--out` may be relative to the process cwd, so match on a resolved path
    # rather than assuming it is already under ROOT.
    try:
        skip_rel = skip.resolve().relative_to(ROOT)
    except ValueError:
        skip_rel = None
    fingerprints = {}
    for rel in listing:
        if not rel:
            continue
        candidate = Path(rel)
        if skip_rel is not None and (candidate == skip_rel or skip_rel in candidate.parents):
            continue
        # Local fact stores are per-run scratch, not verified source.
        if rel.split("/")[0].startswith("local-state"):
            continue
        path = ROOT / rel
        if path.is_file():
            fingerprints[rel] = digest(path)
    return fingerprints


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="check", help="verification label used for the default output directory")
    parser.add_argument("--out", default=None, help="explicit output directory (never evidence/foundation)")
    parser.add_argument("--modus-baseline", default=None, help="optional JSON file of Modus relative paths -> sha256 to protect")
    parser.add_argument("--timeout", type=int, default=180, help="per-command timeout in seconds")
    parser.add_argument("--keep-going", action="store_true", help="run remaining checks after a failure")
    args = parser.parse_args()

    if args.out:
        out = Path(args.out)
        if out.resolve() == (ROOT / "evidence/foundation").resolve():
            parser.error("--out must not point at evidence/foundation; historical evidence is append-only")
    else:
        local_date = datetime.datetime.now().astimezone().strftime("%Y-%m-%d")
        out = ROOT / "evidence/daily" / local_date / args.label
    out.mkdir(parents=True, exist_ok=True)

    record = {
        "schema": "atlas.verification.v2",
        "label": args.label,
        "time_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "platform": platform.platform(),
        "cwd": str(ROOT),
        "out_dir": str(out.relative_to(ROOT)) if out.is_relative_to(ROOT) else str(out),
        "commands": [],
        "negative_controls": [],
        "qualification": "scoped to the checks listed; not full AL/ET/GE/MT/HI/DV or mature Atlas acceptance",
    }
    for name, cmd in [
        ("rustc", ["rustc", "--version"]),
        ("cargo", ["cargo", "--version"]),
        ("node", ["node", "--version"]),
        ("npm", ["npm", "--version"]),
        ("python", [sys.executable, "--version"]),
    ]:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=15)
        record[name] = (r.stdout + r.stderr).strip()

    git_log = subprocess.run(["git", "log", "--oneline", "-1"], cwd=ROOT, capture_output=True, text=True)
    record["git"] = {
        "head_exists": git_log.returncode == 0,
        "head": git_log.stdout.strip() or None,
        "whitespace_check_scope": (
            "git diff --check covers tracked/index diffs only; with no commits it inspects almost nothing, "
            "so a PASS here is not a whitespace audit of untracked files"
            if git_log.returncode != 0
            else "git diff --check covers uncommitted diffs of tracked files"
        ),
    }

    # Cargo already serializes concurrent builds against one `target/` and
    # reports results for a real revision, so this lock is not what protects the
    # result. It only keeps two verification runs from fighting over the same
    # output directory and the same build queue.
    verify_lock = acquire_verify_lock(args.timeout)
    fingerprint_before = tree_fingerprint(out)
    record["concurrency"] = {
        "lock": str(Path(verify_lock.name).relative_to(ROOT)),
        "serialized": True,
        "note": (
            "serializes verify.py runs only. It cannot stop a writer editing "
            "sources mid-run; sources_changed_during_run is what covers that."
        ),
    }

    for name, cmd in CHECKS:
        start = time.monotonic()
        try:
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=args.timeout)
            code, log = r.returncode, r.stdout + r.stderr
        except subprocess.TimeoutExpired as error:
            code = 124
            log = f"TIMEOUT after {args.timeout}s: {error}\n"
        (out / f"{name}.log").write_text(log)
        record["commands"].append(
            {"name": name, "argv": cmd, "exit_code": code, "seconds": round(time.monotonic() - start, 3), "log": f"{name}.log"}
        )
        print(f"{'PASS' if code == 0 else 'FAIL'} {name}: exit {code}", flush=True)
        if code and not args.keep_going:
            remaining = [n for n, _ in CHECKS[len(record["commands"]):]]
            record["commands"].extend({"name": n, "argv": None, "exit_code": None, "note": "not_run_after_failure"} for n in remaining)
            break

    # Controls need the workspace built, so they only run when every CHECKS item
    # ran. A control that never ran is recorded, never silently skipped: the pass
    # condition below requires one record per control.
    checks_ran = len(record["commands"]) == len(CHECKS) and all(
        c["exit_code"] is not None for c in record["commands"]
    )
    if checks_ran:
        for name, cmd, env_extra, why in NEGATIVE_CONTROLS:
            start = time.monotonic()
            try:
                r = subprocess.run(
                    cmd,
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    timeout=args.timeout,
                    env={**os.environ, **env_extra},
                )
                code, log = r.returncode, r.stdout + r.stderr
            except subprocess.TimeoutExpired as error:
                code = 124
                log = f"TIMEOUT after {args.timeout}s: {error}\n"
            controlled = code != 0 and "FAILED (failures=" in log
            (out / f"negative-{name}.log").write_text(log)
            record["negative_controls"].append(
                {
                    "name": name,
                    "argv": cmd,
                    "env": env_extra,
                    "why": why,
                    "exit_code": code,
                    "controlled": controlled,
                    "seconds": round(time.monotonic() - start, 3),
                    "log": f"negative-{name}.log",
                }
            )
            print(f"{'PASS' if controlled else 'FAIL'} negative-control {name}: exit {code}", flush=True)

        # Pair the build fingerprint only once the build artifact exists. An
        # absent pairing is recorded as a miss, never as a pass.
        record["fingerprint"] = check_fingerprint_pairing(args.timeout)
        print(
            f"{'PASS' if record['fingerprint'].get('match') else 'FAIL'} "
            f"fingerprint pairing: binary={record['fingerprint'].get('actual')} "
            f"source={record['fingerprint'].get('expected')}",
            flush=True,
        )

    record["source_hashes"] = {
        str(p.relative_to(ROOT)): digest(p)
        for base in [ROOT / "crates", ROOT / "workers/typescript", ROOT / "web", ROOT / "examples", ROOT / "scripts"]
        for p in sorted(base.rglob("*"))
        if p.is_file() and "node_modules" not in p.parts and "__pycache__" not in p.parts
    }
    for name in ["Cargo.toml", "Cargo.lock", "AGENTS.md", "README.md", "scripts/verify.py"]:
        record["source_hashes"][name] = digest(ROOT / name)

    modus = {"checked": False}
    if args.modus_baseline:
        modus["checked"] = True
        modus["baseline_file"] = args.modus_baseline
        protected = json.loads(Path(args.modus_baseline).read_text())
        repo = ROOT.parent / "Modus"
        modus["modus_dir_present"] = repo.is_dir()
        if repo.is_dir():
            modus["checked_files"] = len(protected)
            modus["changed_or_missing"] = sorted(
                p for p, h in protected.items() if not (repo / p).is_file() or digest(repo / p) != h
            )
            modus["meaning"] = "observed baseline drift; do not overwrite concurrent work"
        else:
            modus["changed_or_missing"] = None
            modus["meaning"] = "cannot verify: Modus checkout absent; no protection is asserted for an unchecked tree"
    record["modus_protected_files"] = modus

    errors = []
    for p in [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md")), ROOT / "docs/specs/README.md"]:
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", p.read_text()):
            if "://" in target or target.startswith("#"):
                continue
            if not (p.parent / target.split("#")[0]).exists():
                errors.append(f"{p.relative_to(ROOT)} -> {target}")
    record["current_document_links"] = {
        "errors": errors,
        "scope": "new current entry docs only; original imported requirement links retain Modus context",
    }

    fingerprint_after = tree_fingerprint(out)
    moved = sorted(
        k
        for k in set(fingerprint_before) | set(fingerprint_after)
        if fingerprint_before.get(k) != fingerprint_after.get(k)
    )
    record["sources_changed_during_run"] = {
        "count": len(moved),
        "paths": moved[:20],
        "meaning": (
            "sources moved while this run compiled them, so the result "
            "describes no single revision; a pass is refused and a failure "
            "may not reproduce. Re-run against a still tree."
        ),
    }
    # `cargo test` rebuilds test targets, not `target/debug/atlas`. Every
    # coverage/flow number quoted from the CLI therefore belongs to whatever
    # binary is on disk, which may be older than the sources. Record its
    # identity so a quoted number can be attributed to an artifact instead of
    # to "the code" -- twice today a CLI number was read off a stale binary and
    # nearly used to "fix" logic that was already correct.
    binary = ROOT / "target" / "debug" / "atlas"
    if binary.is_file():
        built_at = binary.stat().st_mtime
        record["binary"] = {
            "path": "target/debug/atlas",
            "sha256": digest(binary),
            "sources_newer_than_binary": sorted(
                k for k in fingerprint_after if k.endswith(".rs") and (ROOT / k).stat().st_mtime > built_at
            )[:20],
            "meaning": "the artifact behind every CLI-derived number in this run",
        }
    else:
        record["binary"] = None
    ran = [c for c in record["commands"] if c["exit_code"] is not None]
    record["status"] = (
        "PASS"
        if ran
        and all(c["exit_code"] == 0 for c in ran)
        and len(ran) == len(CHECKS)
        and not errors
        and len(record["negative_controls"]) == len(NEGATIVE_CONTROLS)
        and all(c["controlled"] for c in record["negative_controls"])
        and record.get("fingerprint", {}).get("match") is True
        else "FAIL"
    )
    if record["status"] == "PASS" and moved:
        # Never emit a pass for inputs that moved under it. A failure keeps its
        # FAIL status so a real defect is not masked by a concurrency note.
        record["status"] = "UNSTABLE"
    (out / "verification.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {
                "status": record["status"],
                "out": record["out_dir"],
                "modus_check": modus.get("checked"),
                "document_errors": errors,
                "sources_changed": len(moved),
                "binary_stale": bool(record["binary"] and record["binary"]["sources_newer_than_binary"]),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
