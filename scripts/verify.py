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
import platform
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]

CHECKS = [
    ("rust-format", ["cargo", "fmt", "--all", "--check"]),
    ("rust-clippy", ["cargo", "clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]),
    ("rust-tests", ["cargo", "test", "--workspace", "--locked"]),
    ("rust-build", ["cargo", "build", "--workspace", "--locked"]),
    ("worker-tests", ["npm", "test", "--prefix", "workers/typescript"]),
    ("integration", [sys.executable, "scripts/test_integration.py"]),
    ("calculator", ["node", "examples/calculator/demo.mjs"]),
    ("web-syntax", ["node", "--check", "web/app.js"]),
    ("whitespace", ["git", "diff", "--check"]),
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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

    ran = [c for c in record["commands"] if c["exit_code"] is not None]
    record["status"] = (
        "PASS"
        if ran
        and all(c["exit_code"] == 0 for c in ran)
        and len(ran) == len(CHECKS)
        and not errors
        else "FAIL"
    )
    (out / "verification.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {"status": record["status"], "out": record["out_dir"], "modus_check": modus.get("checked"), "document_errors": errors},
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
