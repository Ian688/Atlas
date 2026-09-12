#!/usr/bin/env python3
"""W07 GE-2/GE-3 evidence: cold / hot / edit / delete cost, peak RSS and
coverage denominators on a REAL medium third-party JS/TS project.

The target is the pinned npm tarball ``rxjs@7.8.1``. Its sha256 is verified
before any index runs, so the numbers below describe exactly those bytes.

Evidence discipline
-------------------
* Nothing here is synthetic: the project is the published tarball.
* Every measured command records its argv, exit code, wall seconds and peak
  RSS exactly as reported by ``time(1)``.
* A value that could not be measured is ``null`` plus a reason string. No
  number is ever invented.
* The load-bearing assertion is id equality: an incremental run must publish
  the same ``analysis id`` as a plain full derivation of the same tree.

Standard library only.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Extensions the Atlas scan counts as analysable JS/TS source.
SOURCE_EXTS = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts")

DEFAULT_SHA256 = "c532167725ab7d085123209156c93cef22f2479cb9c8527060f1cd903aa9d149"
DEFAULT_PACKAGE = "rxjs@7.8.1"
DEFAULT_OUT = "evidence/development/2026-09-12-real-project/rxjs/bench.json"
DEFAULT_WORKER = str(ROOT / "workers" / "typescript" / "worker.mjs")

QUALIFICATION = (
    "Proves: on this one machine, against the pinned rxjs@7.8.1 tarball whose "
    "sha256 was verified before indexing, the recorded cold/hot/edit/delete wall "
    "seconds, peak process RSS, coverage denominators and on-disk store cost of "
    "this build of target/debug/atlas; and that the incremental runs published an "
    "analysis id identical to a plain full derivation of the same tree. "
    "Does NOT prove: large-repo or monorepo scale qualification (one ~1k-file "
    "package is not a monorepo), multi-language qualification (only JS/TS was "
    "indexed), concurrent or parallel-worker qualification, Windows "
    "qualification, cross-machine or cross-toolchain generalisation, or any "
    "semantic correctness of the analysis beyond id equality. Peak RSS is the "
    "OS-reported process maximum from time(1) and is NOT a heap profile: it "
    "cannot attribute bytes to scanner, worker, derivation or SQLite. It does "
    "NOT prove that a plain (non-incremental) cold index leaves a reusable "
    "record: the engine records the reuse key only on --incremental runs, which "
    "the embedded reuse_record_probe measures directly; scenario 'cold' is "
    "therefore the first --incremental run on a fresh store."
)


# --------------------------------------------------------------------------
# measurements
# --------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_bytes(root: Path) -> tuple[int, int]:
    """(total regular-file bytes, file count) under root, following no links."""
    total = 0
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink() or not path.is_file():
                continue
            total += path.stat().st_size
            count += 1
    return total, count


def project_tree_digest(root: Path) -> dict:
    """sha256 over sorted ``relpath\\0sha256(content)`` lines."""
    entries: list[str] = []
    symlinks = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink():
                symlinks += 1
                continue
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            entries.append(f"{rel}\0{sha256_file(path)}")
    entries.sort()
    payload = "\n".join(entries).encode("utf-8")
    return {
        "algorithm": "sha256 over sorted 'relpath\\0sha256(content)' lines",
        "digest": sha256_bytes(payload),
        "files": len(entries),
        "symlinks_skipped": symlinks,
    }


def source_inventory(root: Path) -> dict:
    by_ext: dict[str, dict[str, int]] = {}
    total_bytes = 0
    total_files = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink() or not path.is_file():
                continue
            ext = path.suffix
            if ext not in SOURCE_EXTS:
                continue
            size = path.stat().st_size
            bucket = by_ext.setdefault(ext, {"files": 0, "bytes": 0})
            bucket["files"] += 1
            bucket["bytes"] += size
            total_files += 1
            total_bytes += size
    return {
        "extensions": SOURCE_EXTS,
        "by_extension": by_ext,
        "file_count": total_files,
        "total_bytes": total_bytes,
    }


# --------------------------------------------------------------------------
# command runner with peak RSS
# --------------------------------------------------------------------------

_PEAK_DARWIN = re.compile(r"(\d+)\s+maximum resident set size")
_PEAK_LINUX = re.compile(r"Maximum resident set size \(kbytes\):\s*(\d+)")


def peak_rss_plan() -> dict:
    """Decide how peak RSS will be measured on this host."""
    time_bin = Path("/usr/bin/time")
    if not time_bin.exists():
        return {"available": False, "wrapper": None, "reason": "/usr/bin/time not present"}
    system = platform.system()
    if system == "Darwin":
        return {
            "available": True,
            "wrapper": ["/usr/bin/time", "-l"],
            "method": "darwin /usr/bin/time -l: 'maximum resident set size' (bytes)",
        }
    if system == "Linux":
        return {
            "available": True,
            "wrapper": ["/usr/bin/time", "-v"],
            "method": "linux /usr/bin/time -v: 'Maximum resident set size (kbytes)' -> bytes",
        }
    return {
        "available": False,
        "wrapper": None,
        "reason": f"unsupported platform {system!r}; only darwin/linux time(1) formats are parsed",
    }


def parse_peak_rss(stderr_text: str, system: str) -> tuple[int | None, str | None]:
    if system == "Darwin":
        match = _PEAK_DARWIN.search(stderr_text)
        if match:
            return int(match.group(1)), None
        return None, "field_absent_in_time_output"
    if system == "Linux":
        match = _PEAK_LINUX.search(stderr_text)
        if match:
            return int(match.group(1)) * 1024, None
        return None, "field_absent_in_time_output"
    return None, "unsupported_platform"


def run_command(
    label: str,
    argv: list[str],
    log_dir: Path,
    cwd: Path | None = None,
    timeout: float | None = None,
    plan: dict | None = None,
) -> dict:
    """Run one command, capturing wall seconds, exit code, streams and peak RSS."""
    plan = plan or peak_rss_plan()
    system = platform.system()
    if plan["available"]:
        executed = [*plan["wrapper"], *argv]
    else:
        executed = list(argv)

    started = time.monotonic()
    timed_out = False
    exit_code: int | None = None
    stdout_bytes = b""
    stderr_bytes = b""
    try:
        completed = subprocess.run(
            executed,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        exit_code = completed.returncode
        stdout_bytes = completed.stdout
        stderr_bytes = completed.stderr
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout_bytes = exc.stdout or b""
        stderr_bytes = exc.stderr or b""
    except FileNotFoundError as exc:
        stderr_bytes = f"FileNotFoundError: {exc}".encode("utf-8")
        exit_code = None
    seconds = time.monotonic() - started

    stdout = stdout_bytes.decode("utf-8", "replace")
    stderr = stderr_bytes.decode("utf-8", "replace")

    if not plan["available"]:
        peak_rss, peak_reason = None, plan.get("reason", "unavailable")
    else:
        peak_rss, peak_reason = parse_peak_rss(stderr, system)

    record = {
        "label": label,
        "argv": list(argv),
        "executed_argv": executed,
        "cwd": str(cwd) if cwd else None,
        "exit_code": exit_code,
        "seconds": round(seconds, 6),
        "timed_out": timed_out,
        "peak_rss": peak_rss,
        "peak_rss_unavailable": peak_reason,
        "peak_rss_method": plan.get("method"),
        "stdout": stdout,
        "stderr": stderr,
    }

    log_path = log_dir / f"{label}.log"
    write_log(log_path, record)
    record["log"] = str(log_path)
    return record


def write_log(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"$ {' '.join(record['executed_argv'])}",
        f"cwd: {record['cwd']}",
        "--- stdout ---",
        record["stdout"].rstrip("\n"),
        "--- stderr ---",
        record["stderr"].rstrip("\n"),
        f"[exit code: {record['exit_code'] if record['exit_code'] is not None else 'none (not executed / timeout)'}]",
        f"[wall seconds: {record['seconds']}]",
        f"[peak rss: {record['peak_rss'] if record['peak_rss'] is not None else 'unavailable'} "
        f"({record['peak_rss_unavailable'] or 'measured'})]",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def public_command(record: dict) -> dict:
    """The command record without the (large) captured streams."""
    return {key: value for key, value in record.items() if key not in ("stdout", "stderr")}


# --------------------------------------------------------------------------
# project preparation
# --------------------------------------------------------------------------


def tarball_name_for(package: str) -> str | None:
    if "@" not in package:
        return None
    name, _, version = package.rpartition("@")
    if not name or not version:
        return None
    # scoped packages keep their scope in the file name: @scope/pkg -> scope-pkg
    flat = name.lstrip("@").replace("/", "-")
    return f"{flat}-{version}.tgz"


def extract_tarball(tarball: Path, project: Path) -> dict:
    """Extract, stripping the leading 'package/' component."""
    if project.exists():
        shutil.rmtree(project)
    project.mkdir(parents=True, exist_ok=True)

    files = 0
    directories = 0
    symlinks = 0
    total_bytes = 0
    skipped = 0
    with tarfile.open(tarball, "r:gz") as tar:
        for member in tar:
            parts = Path(member.name).parts
            if not parts or parts[0] != "package":
                skipped += 1
                continue
            relative = Path(*parts[1:]) if len(parts) > 1 else Path()
            if not relative.parts:
                continue
            target = project / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                directories += 1
            elif member.issym() or member.islnk():
                symlinks += 1
            elif member.isfile():
                stream = tar.extractfile(member)
                data = stream.read() if stream else b""
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                files += 1
                total_bytes += len(data)
            else:
                skipped += 1
    return {
        "files_written": files,
        "directories_written": directories,
        "symlinks_skipped": symlinks,
        "members_skipped": skipped,
        "bytes_written": total_bytes,
        "stripped_component": "package/",
    }


# --------------------------------------------------------------------------
# leaf selection for edit / delete
# --------------------------------------------------------------------------

_IMPORT_SPEC = re.compile(r"""(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]""")


def importers_map(project: Path) -> dict[str, set[str]]:
    """relpath -> set of relpaths that statically name it via a relative specifier."""
    source_files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(project):
        dirnames.sort()
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink() or not path.is_file():
                continue
            if path.suffix in SOURCE_EXTS:
                source_files.append(path)

    importers: dict[str, set[str]] = {}
    for path in source_files:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel_self = path.relative_to(project).as_posix()
        for match in _IMPORT_SPEC.finditer(text):
            specifier = match.group(1)
            if not specifier.startswith("."):
                continue
            base = os.path.normpath(os.path.join(str(path.parent), specifier))
            resolved: Path | None = None
            direct = Path(base)
            if direct.is_file():
                resolved = direct
            else:
                for ext in SOURCE_EXTS:
                    candidate = Path(base + ext)
                    if candidate.is_file():
                        resolved = candidate
                        break
                if resolved is None:
                    for ext in SOURCE_EXTS:
                        candidate = Path(base) / f"index{ext}"
                        if candidate.is_file():
                            resolved = candidate
                            break
            if resolved is None:
                continue
            try:
                rel_target = resolved.relative_to(project).as_posix()
            except ValueError:
                continue
            importers.setdefault(rel_target, set()).add(rel_self)
    return importers


def select_leaf_candidates(project: Path, scope: str = "src/internal") -> tuple[list[dict], list[dict]]:
    """Return (candidates, all_leaves). Candidates are leaves under `scope`."""
    importers = importers_map(project)
    all_leaves: list[dict] = []
    scoped: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(project):
        dirnames.sort()
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink() or not path.is_file():
                continue
            if path.suffix not in SOURCE_EXTS:
                continue
            rel = path.relative_to(project).as_posix()
            if rel in importers:
                continue
            entry = {
                "path": rel,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "importers": sorted(importers.get(rel, ())),
            }
            all_leaves.append(entry)
            if rel.startswith(scope + "/"):
                scoped.append(entry)
    key = lambda item: (item["bytes"], item["path"])
    scoped.sort(key=key)
    all_leaves.sort(key=key)
    return scoped, all_leaves


# --------------------------------------------------------------------------
# index invocation
# --------------------------------------------------------------------------


def index_argv(
    atlas: Path,
    store: Path,
    project: Path,
    node: str,
    worker: str,
    incremental: bool,
) -> list[str]:
    argv = [
        str(atlas),
        "--store",
        str(store),
        "index",
        str(project),
        "--node",
        node,
        "--worker",
        worker,
        "--timeout-seconds",
        "600",
        "--scan-deadline-seconds",
        "300",
        "--index-deadline-seconds",
        "1800",
    ]
    if incremental:
        argv.append("--incremental")
    return argv


def parse_index_stdout(stdout: str) -> tuple[dict | None, str | None]:
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return None, f"stdout is not JSON: {exc}"
    if not isinstance(value, dict):
        return None, "stdout JSON is not an object"
    return value, None


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Measure Atlas cold/hot/incremental cost on a real npm project.",
    )
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--sha256", default=DEFAULT_SHA256)
    parser.add_argument("--cache", default="local-state/bench/cache")
    parser.add_argument("--project", default="local-state/bench/rxjs")
    parser.add_argument("--store", default="local-state/bench/store")
    parser.add_argument("--atlas", default="target/debug/atlas")
    parser.add_argument("--node", default="node")
    parser.add_argument("--worker", default=DEFAULT_WORKER)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--label", default="rxjs-7.8.1")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument(
        "--command-timeout-seconds",
        type=float,
        default=3600.0,
        help="python-side watchdog per command; atlas has its own deadlines",
    )
    return parser


def resolve(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (ROOT / path)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    atlas = resolve(args.atlas)
    cache = resolve(args.cache)
    project = resolve(args.project)
    store = resolve(args.store)
    worker = args.worker if os.path.isabs(args.worker) else str((ROOT / args.worker).resolve())
    out = resolve(args.out)
    log_dir = out.parent
    log_dir.mkdir(parents=True, exist_ok=True)
    plan = peak_rss_plan()

    doc: dict = {
        "schema": "atlas.real-project-bench.v1",
        "label": args.label,
        "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "repo_root": str(ROOT),
        "project_spec": {
            "package": args.package,
            "tarball_sha256_expected": args.sha256,
            "tarball_sha256_actual": None,
            "tarball_sha256_match": None,
            "tarball_path": None,
            "tarball_bytes": None,
            "project_dir": str(project),
            "store_dir": str(store),
            "worker": worker,
            "node_command": args.node,
            "atlas_binary": str(atlas),
            "cache_dir": str(cache),
            "extract": None,
            "tree_digest_initial": None,
            "tree_digest_restored": None,
            "source_inventory": None,
        },
        "environment": {
            "platform": platform.platform(),
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "python_version": sys.version,
            "peak_rss_plan": plan,
        },
        "commands": {},
        "scenarios": {},
        "probe": {},
        "assertions": {},
        "disk": {},
        "coverage_denominators": None,
        "metadata_keys_observed": [],
        "errors": [],
        "qualification": QUALIFICATION,
    }

    def fail(message: str) -> None:
        doc["errors"].append(message)
        print(f"ERROR: {message}", file=sys.stderr)

    def emit() -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    command_timeout = args.command_timeout_seconds

    # -- environment versions -------------------------------------------------
    for label, cmd in (
        ("node-version", [args.node, "--version"]),
        ("rustc-version", ["rustc", "--version"]),
        ("cargo-version", ["cargo", "--version"]),
    ):
        version_record = run_command(label, cmd, log_dir, cwd=ROOT, timeout=120, plan=plan)
        doc["commands"][label] = public_command(version_record)
        doc["environment"][label.replace("-", "_")] = version_record["stdout"].strip()

    # -- atlas binary identity ------------------------------------------------
    doc["environment"]["atlas_exists"] = atlas.is_file()
    if atlas.is_file():
        doc["environment"]["atlas_sha256"] = sha256_file(atlas)
        doc["environment"]["atlas_bytes"] = atlas.stat().st_size
    else:
        doc["environment"]["atlas_sha256"] = None
        doc["environment"]["atlas_bytes"] = None
        fail(f"atlas binary missing at {atlas}; run `cargo build --workspace --locked` first")
        doc["assertions"]["atlas_binary_present"] = False
        emit()
        return 1
    doc["assertions"]["atlas_binary_present"] = True

    # -- step 1: download and verify -----------------------------------------
    cache.mkdir(parents=True, exist_ok=True)
    expected_name = tarball_name_for(args.package)
    tarball: Path | None = None
    if expected_name and (cache / expected_name).is_file():
        tarball = cache / expected_name
    if not args.skip_download:
        # --skip-download keeps an already-fetched tarball; otherwise refresh it.
        doc["commands"]["npm-pack"] = public_command(
            run_command(
                "npm-pack",
                ["npm", "pack", args.package, "--pack-destination", str(cache)],
                log_dir,
                cwd=cache,
                timeout=command_timeout,
                plan=plan,
            )
        )
        if doc["commands"]["npm-pack"]["exit_code"] != 0:
            fail("npm pack failed; no index was run")
        candidates = sorted(
            cache.glob("*.tgz"), key=lambda path: path.stat().st_mtime, reverse=True
        )
        if expected_name and (cache / expected_name).is_file():
            tarball = cache / expected_name
        elif candidates:
            tarball = candidates[0]
    elif tarball is None:
        candidates = sorted(
            cache.glob("*.tgz"), key=lambda path: path.stat().st_mtime, reverse=True
        )
        tarball = candidates[0] if candidates else None

    if tarball is None or not tarball.is_file():
        fail(f"no tarball found under {cache} for package {args.package}")
        doc["assertions"]["tarball_sha256_matches"] = False
        emit()
        return 1

    doc["project_spec"]["tarball_path"] = str(tarball)
    doc["project_spec"]["tarball_bytes"] = tarball.stat().st_size
    actual_sha = sha256_file(tarball)
    doc["project_spec"]["tarball_sha256_actual"] = actual_sha
    pin_ok = actual_sha == args.sha256
    doc["project_spec"]["tarball_sha256_match"] = pin_ok
    doc["assertions"]["tarball_sha256_matches"] = pin_ok

    if not pin_ok:
        print(
            "tarball sha256 mismatch:\n"
            f"  expected {args.sha256}\n"
            f"  actual   {actual_sha}\n"
            "refusing to index a different tree",
            file=sys.stderr,
        )
        fail("tarball sha256 mismatch; no index was run")
        emit()
        return 1

    # -- step 1b: extract -----------------------------------------------------
    doc["project_spec"]["extract"] = extract_tarball(tarball, project)
    doc["project_spec"]["source_inventory"] = source_inventory(project)
    doc["project_spec"]["tree_digest_initial"] = project_tree_digest(project)
    original_digest = doc["project_spec"]["tree_digest_initial"]["digest"]

    # -- reuse-record probe (small, real fixture; justifies the cold flags) ---
    probe_root = project.parent / "reuse-probe"
    probe_project = probe_root / "project"
    probe_store_plain = probe_root / "store-plain"
    probe_store_inc = probe_root / "store-inc"
    shutil.rmtree(probe_root, ignore_errors=True)
    (probe_project / "lib").mkdir(parents=True)
    (probe_project / "lib" / "u.js").write_text(
        "export function add(a, b) { return a + b; }\n", encoding="utf-8"
    )
    (probe_project / "a.js").write_text(
        'import { add } from "./lib/u.js";\nexport function f(x) { return add(x, 1); }\n',
        encoding="utf-8",
    )
    probe_steps = [
        ("reuse-probe-cold-plain", probe_store_plain, False),
        ("reuse-probe-hot-incremental", probe_store_plain, True),
        ("reuse-probe-cold-incremental", probe_store_inc, True),
        ("reuse-probe-hot2-incremental", probe_store_inc, True),
    ]
    for label, probe_store, incremental in probe_steps:
        record = run_command(
            label,
            index_argv(atlas, probe_store, probe_project, args.node, worker, incremental),
            log_dir,
            cwd=ROOT,
            timeout=command_timeout,
            plan=plan,
        )
        doc["commands"][label] = public_command(record)
        parsed, error = parse_index_stdout(record["stdout"])
        entry = {
            "store": str(probe_store),
            "incremental_flag": incremental,
            "exit_code": record["exit_code"],
            "id": parsed.get("id") if parsed else None,
            "outcome": (parsed.get("incremental") or {}).get("outcome") if parsed else None,
            "error": error,
        }
        doc["probe"][label] = entry
    doc["probe"]["conclusion"] = {
        "plain_cold_then_incremental_hot_outcome": doc["probe"]
        .get("reuse-probe-hot-incremental", {})
        .get("outcome"),
        "cold_incremental_then_incremental_hot_outcome": doc["probe"]
        .get("reuse-probe-hot2-incremental", {})
        .get("outcome"),
        "note": (
            "A plain index does not record the reuse key, so a following --incremental run "
            "still derives. Scenario 'cold' below is therefore the first --incremental run "
            "on a fresh store, which is the only way to measure a real hot reuse."
        ),
    }

    # -- scenario runner ------------------------------------------------------
    index_failures: list[str] = []

    def run_index_scenario(
        key: str, target_store: Path, incremental: bool, wipe: bool
    ) -> dict:
        if wipe:
            shutil.rmtree(target_store, ignore_errors=True)
        record = run_command(
            key,
            index_argv(atlas, target_store, project, args.node, worker, incremental),
            log_dir,
            cwd=ROOT,
            timeout=command_timeout,
            plan=plan,
        )
        doc["commands"][key] = public_command(record)
        parsed, error = parse_index_stdout(record["stdout"])
        if record["exit_code"] != 0:
            index_failures.append(f"{key} exited {record['exit_code']}")
        if error:
            index_failures.append(f"{key}: {error}")
        entry = {
            "store": str(target_store),
            "incremental_flag": incremental,
            "exit_code": record["exit_code"],
            "seconds": record["seconds"],
            "peak_rss": record["peak_rss"],
            "peak_rss_unavailable": record["peak_rss_unavailable"],
            "metadata": parsed,
            "id": parsed.get("id") if parsed else None,
            "snapshot_id": parsed.get("snapshot_id") if parsed else None,
            "incremental": (parsed.get("incremental") if parsed else None),
            "stdout_parse_error": error,
            "stderr_excerpt": "\n".join(
                line for line in record["stderr"].splitlines() if line.strip()
            )[:2000],
        }
        doc["scenarios"][key] = entry
        return entry

    # -- a. cold (fresh store, --incremental: the first run records the key) --
    cold = run_index_scenario("cold", store, True, wipe=True)
    if cold["metadata"]:
        doc["coverage_denominators"] = cold["metadata"].get("coverage")
        doc["metadata_keys_observed"] = sorted(cold["metadata"].keys())
        doc["environment"]["atlas_binary_fingerprint"] = cold["metadata"].get(
            "binary_fingerprint"
        )
    doc["assertions"]["cold_first_run_outcome_derived"] = (
        (cold["incremental"] or {}).get("outcome") == "derived"
    )
    bytes_cold, files_cold = tree_bytes(store)
    doc["disk"]["store_bytes_after_cold"] = bytes_cold
    doc["disk"]["store_files_after_cold"] = files_cold

    # -- b. hot (same store, --incremental; must reuse) ----------------------
    hot = run_index_scenario("hot", store, True, wipe=False)
    hot_outcome = (hot["incremental"] or {}).get("outcome")
    doc["assertions"]["hot_id_equals_cold_id"] = bool(
        cold["id"] and hot["id"] and cold["id"] == hot["id"]
    )
    doc["assertions"]["hot_outcome_reused"] = hot_outcome == "reused"
    doc["assertions"]["hot_derivation_seconds_zero"] = (
        (hot["incremental"] or {}).get("seconds", {}).get("derivation") == 0.0
        if hot["incremental"]
        else None
    )
    bytes_hot, files_hot = tree_bytes(store)
    doc["disk"]["store_bytes_after_hot"] = bytes_hot
    doc["disk"]["store_files_after_hot"] = files_hot

    # -- c. edit one leaf ----------------------------------------------------
    scoped, all_leaves = select_leaf_candidates(project)
    pool = scoped if len(scoped) >= 2 else all_leaves
    pool_reason = (
        f"leaves under src/internal ({len(scoped)} found)"
        if len(scoped) >= 2
        else f"fallback to all leaves ({len(all_leaves)} found; fewer than 2 under src/internal)"
    )
    doc["scenarios"]["leaf_selection"] = {
        "scope": "src/internal",
        "scoped_leaf_count": len(scoped),
        "all_leaf_count": len(all_leaves),
        "pool_reason": pool_reason,
    }

    backup_dir = project.parent / "backup"
    shutil.rmtree(backup_dir, ignore_errors=True)
    backup_dir.mkdir(parents=True, exist_ok=True)

    edit_target: dict | None = pool[0] if pool else None
    delete_target: dict | None = pool[1] if len(pool) >= 2 else None

    edit_info: dict = {"applied": False}
    if edit_target:
        edit_path = project / edit_target["path"]
        before = edit_path.read_bytes()
        (backup_dir / "edited.bin").write_bytes(before)
        edited = before + b"\n// atlas bench edit marker\n"
        edit_path.write_bytes(edited)
        edit_info = {
            "applied": True,
            "path": edit_target["path"],
            "bytes_before": len(before),
            "bytes_after": len(edited),
            "sha256_before": sha256_bytes(before),
            "sha256_after": sha256_bytes(edited),
            "importers": edit_target["importers"],
            "why": (
                "smallest source file under src/internal that no other source file imports "
                "(leaf), so appending a comment invalidates exactly this file and has nowhere "
                "to propagate; the appended line is a real byte change, which the run key "
                "depends on."
            ),
        }
    else:
        fail("could not select any leaf source file to edit")
    doc["scenarios"]["edit_plan"] = edit_info

    after_edit = run_index_scenario("edit", store, True, wipe=False)
    after_edit["edit"] = edit_info

    # -- d. edit_full (plain full derivation, separate fresh store) ----------
    edit_full_store = Path(str(store) + "-edit-full")
    edit_full = run_index_scenario("edit_full", edit_full_store, False, wipe=True)
    doc["assertions"]["edit_id_equals_edit_full_id"] = bool(
        after_edit["id"] and edit_full["id"] and after_edit["id"] == edit_full["id"]
    )
    doc["assertions"]["edit_own_content_count"] = (
        (after_edit["incremental"] or {}).get("files", {}).get("own_content")
    )
    doc["assertions"]["edit_by_dependency_count"] = (
        (after_edit["incremental"] or {}).get("files", {}).get("by_dependency")
    )

    # -- e. delete a different small leaf ------------------------------------
    delete_info: dict = {"applied": False}
    if delete_target:
        delete_path = project / delete_target["path"]
        before = delete_path.read_bytes()
        (backup_dir / "deleted.bin").write_bytes(before)
        delete_path.unlink()
        delete_info = {
            "applied": True,
            "path": delete_target["path"],
            "bytes": len(before),
            "sha256_before": sha256_bytes(before),
            "importers": delete_target["importers"],
            "why": (
                "second-smallest source file under src/internal that no other source file "
                "imports (a different leaf from the edited one), so withdrawing it removes "
                "exactly one parsed file without breaking an importer."
            ),
        }
    else:
        fail("could not select a second leaf source file to delete")
    doc["scenarios"]["delete_plan"] = delete_info

    after_delete = run_index_scenario("delete", store, True, wipe=False)
    after_delete["delete"] = delete_info

    # -- f. delete_full (plain full derivation, another fresh store) ---------
    delete_full_store = Path(str(store) + "-delete-full")
    delete_full = run_index_scenario("delete_full", delete_full_store, False, wipe=True)
    doc["assertions"]["delete_id_equals_delete_full_id"] = bool(
        after_delete["id"] and delete_full["id"] and after_delete["id"] == delete_full["id"]
    )
    doc["assertions"]["delete_withdrawn"] = (after_delete["incremental"] or {}).get("withdrawn")
    doc["assertions"]["delete_withdrawn_equals_deleted_file"] = (
        (after_delete["incremental"] or {}).get("withdrawn") == [delete_target["path"]]
        if delete_target
        else None
    )
    bytes_delete, files_delete = tree_bytes(store)
    doc["disk"]["store_bytes_after_delete"] = bytes_delete
    doc["disk"]["store_files_after_delete"] = files_delete

    # -- verify the published analysis is retrievable -------------------------
    final_id = after_delete["id"] or after_edit["id"] or cold["id"]
    if final_id:
        report_record = run_command(
            "verify-report",
            [str(atlas), "--store", str(store), "report", final_id],
            log_dir,
            cwd=ROOT,
            timeout=command_timeout,
            plan=plan,
        )
        doc["commands"]["verify-report"] = public_command(report_record)
        report_meta, report_error = parse_index_stdout(report_record["stdout"])
        doc["scenarios"]["verify-report"] = {
            "analysis_id": final_id,
            "exit_code": report_record["exit_code"],
            "id_matches": bool(report_meta and report_meta.get("id") == final_id),
            "metadata": report_meta,
            "stdout_parse_error": report_error,
        }
        doc["assertions"]["report_retrieves_same_id"] = bool(
            report_meta and report_meta.get("id") == final_id
        )

    # -- restore mutated files byte-for-byte ---------------------------------
    restore: dict = {"edit": None, "delete": None}
    if edit_target and edit_info.get("applied"):
        restore["edit"] = {
            "path": edit_target["path"],
            "restored_sha256": sha256_bytes((backup_dir / "edited.bin").read_bytes()),
            "expected_sha256": edit_info["sha256_before"],
        }
        (project / edit_target["path"]).write_bytes((backup_dir / "edited.bin").read_bytes())
        restore["edit"]["actual_sha256"] = sha256_file(project / edit_target["path"])
        restore["edit"]["verified"] = (
            restore["edit"]["actual_sha256"] == edit_info["sha256_before"]
        )
    if delete_target and delete_info.get("applied"):
        (project / delete_target["path"]).write_bytes((backup_dir / "deleted.bin").read_bytes())
        restored_sha = sha256_file(project / delete_target["path"])
        restore["delete"] = {
            "path": delete_target["path"],
            "expected_sha256": delete_info["sha256_before"],
            "actual_sha256": restored_sha,
            "verified": restored_sha == delete_info["sha256_before"],
        }
    doc["scenarios"]["restore"] = restore
    doc["assertions"]["restore_verified_sha256"] = all(
        item is None or item.get("verified") for item in restore.values()
    )

    final_digest = project_tree_digest(project)
    doc["project_spec"]["tree_digest_restored"] = final_digest
    doc["assertions"]["tree_digest_restored_equals_initial"] = (
        final_digest["digest"] == original_digest
    )

    # -- exit gate -----------------------------------------------------------
    all_index_zero = not index_failures
    doc["assertions"]["all_index_commands_exit_zero"] = all_index_zero
    doc["assertions"]["index_failures"] = index_failures

    gate = (
        pin_ok
        and all_index_zero
        and doc["assertions"].get("edit_id_equals_edit_full_id") is True
        and doc["assertions"].get("delete_id_equals_delete_full_id") is True
        and doc["assertions"].get("restore_verified_sha256") is True
    )
    doc["assertions"]["exit_gate_passed"] = gate
    emit()

    # -- human summary -------------------------------------------------------
    print("=" * 72)
    print(f"Atlas real-project bench: {args.label}")
    print(f"  tarball sha256 match : {pin_ok} ({actual_sha})")
    print(f"  project              : {project}")
    print(
        "  source inventory     : "
        f"{doc['project_spec']['source_inventory']['file_count']} files, "
        f"{doc['project_spec']['source_inventory']['total_bytes']} bytes"
    )
    print(f"  tree digest          : {original_digest}")
    for key in ("cold", "hot", "edit", "edit_full", "delete", "delete_full"):
        entry = doc["scenarios"].get(key)
        if not entry:
            continue
        outcome = (entry.get("incremental") or {}).get("outcome")
        peak = entry.get("peak_rss")
        peak_text = f"{peak} B" if peak is not None else f"unavailable ({entry.get('peak_rss_unavailable')})"
        print(
            f"  {key:<11}: exit={entry['exit_code']} wall={entry['seconds']}s "
            f"peak_rss={peak_text} outcome={outcome} id={str(entry.get('id'))[:12]}"
        )
    print(
        "  assertions           : "
        f"hot_id_eq={doc['assertions'].get('hot_id_equals_cold_id')} "
        f"hot_reused={doc['assertions'].get('hot_outcome_reused')} "
        f"edit_eq={doc['assertions'].get('edit_id_equals_edit_full_id')} "
        f"delete_eq={doc['assertions'].get('delete_id_equals_delete_full_id')} "
        f"restore={doc['assertions'].get('restore_verified_sha256')}"
    )
    errors = doc["errors"] + index_failures
    if errors:
        print("  errors:")
        for item in errors:
            print(f"    - {item}")
    print(f"  bench json           : {out}")
    print(f"  logs                 : {log_dir}")
    print(f"  EXIT                 : {0 if gate else 1}")
    print("=" * 72)
    return 0 if gate else 1


if __name__ == "__main__":
    sys.exit(main())
