#!/usr/bin/env python3
"""What an isolated copy costs, on a REAL project, by materialisation mode.

`atlas exec` copies the pinned snapshot into a throwaway 0700 directory before
it starts a process. For a small project that copy is invisible; for a big one
it is paid on every single run. This measures the two modes on the pinned
rxjs@7.8.1 tree with the pinned rxjs store, and records the copy's own numbers
(files and bytes written, from the record) next to the wall seconds the OS
reported for the whole run.

The target is `dist/cjs/internal/util/isFunction.js:isFunction`: a real CommonJS
module from the published tarball, which the harness can actually load and call.
`isFunction(3)` is `false`, so the run also proves the copy executed the real
bytes rather than failing quietly.

Nothing here is synthetic, and nothing is claimed beyond what was measured:
wall seconds include Node startup, the permission probe, the copy and the call,
so they are not a copy benchmark.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bench_real_project import (  # noqa: E402
    DEFAULT_SHA256,
    parse_peak_rss,
    peak_rss_plan,
    sha256_file,
    tarball_name_for,
    write_log,
)

DEFAULT_OUT = "evidence/development/2026-09-12-w08-materialise-slice/slice.json"
DEFAULT_PACKAGE = "rxjs@7.8.1"
DEFAULT_TARGET = "dist/cjs/internal/util/isFunction.js:isFunction"

QUALIFICATION = (
    "Proves: on this one machine, against the pinned rxjs@7.8.1 tree (sha256 "
    "verified) and the pinned store, what `--materialise snapshot` and "
    "`--materialise dependencies` each wrote into the isolated copy and what "
    "the whole run cost in wall seconds and peak process RSS, for one real "
    "module that the harness loaded and called. Does NOT prove: that a slice is "
    "complete for every target (a slice is the static import closure, so a "
    "runtime-only dependency or a computed dynamic import is absent by design "
    "and reported in the record); that wall seconds are a copy benchmark (they "
    "include Node startup, the permission probe and the call); or anything "
    "about another machine, another project or another build."
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--sha256", default=DEFAULT_SHA256)
    parser.add_argument("--cache", default="local-state/bench/cache")
    parser.add_argument("--project", default="local-state/bench/rxjs")
    parser.add_argument("--store", default="local-state/bench/store")
    parser.add_argument("--atlas", default="target/debug/atlas")
    parser.add_argument("--analysis", required=True,
                        help="the pinned analysis id to run against (from `atlas index`)")
    parser.add_argument("--target", default=DEFAULT_TARGET)
    parser.add_argument("--args", default="[3]")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--label", default="rxjs-7.8.1-materialise")
    args = parser.parse_args(argv)

    def resolve(value: str) -> Path:
        path = Path(value)
        return path if path.is_absolute() else ROOT / path

    atlas, cache, project = resolve(args.atlas), resolve(args.cache), resolve(args.project)
    store, out = resolve(args.store), resolve(args.out)
    log_dir = out.parent / "slice"
    log_dir.mkdir(parents=True, exist_ok=True)
    plan = peak_rss_plan()

    doc: dict = {
        "schema": "atlas.materialisation-bench.v1",
        "label": args.label,
        "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "repo_root": str(ROOT),
        "analysis_id": args.analysis,
        "target": args.target,
        "args": json.loads(args.args),
        "project_spec": {"project_dir": str(project), "store_dir": str(store),
                         "cache_dir": str(cache), "atlas_binary": str(atlas)},
        "environment": {"platform": platform.platform(), "machine": platform.machine(),
                        "python_version": sys.version, "peak_rss_plan": plan,
                        "atlas_sha256": sha256_file(atlas) if atlas.is_file() else None,
                        "store_writer_budget_env": os.environ.get("ATLAS_STORE_BUSY_TIMEOUT_MS")},
        "tarball": {"path": None, "sha256_expected": args.sha256, "sha256_actual": None, "match": None},
        "runs": {},
        "errors": [],
        "qualification": QUALIFICATION,
    }

    def fail(message: str) -> None:
        doc["errors"].append(message)
        print(f"ERROR: {message}", file=sys.stderr)

    def emit() -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    name = tarball_name_for(args.package)
    tarball = cache / name if name else None
    if not tarball or not tarball.is_file():
        fail(f"tarball_missing:{tarball}")
        emit()
        return 1
    doc["tarball"]["path"] = str(tarball)
    actual = sha256_file(tarball)
    doc["tarball"]["sha256_actual"] = actual
    doc["tarball"]["match"] = actual == args.sha256
    if actual != args.sha256:
        fail(f"tarball_sha256_mismatch:expected={args.sha256}:actual={actual}")
        emit()
        return 1
    if not project.is_dir() or not store.is_dir():
        fail("project_or_store_missing: run scripts/bench_real_project.py first")
        emit()
        return 1

    for mode in ("snapshot", "dependencies"):
        records = []
        for index in range(args.repeat):
            label = f"{mode}-{index + 1}"
            argv_public = [str(atlas), "--store", str(store), "exec", args.analysis, args.target,
                           "--args", args.args, "--allow-effects", "unknown_calls",
                           "--materialise", mode]
            executed = [*plan["wrapper"], *argv_public] if plan["available"] else argv_public
            started = time.monotonic()
            completed = subprocess.run(executed, cwd=str(ROOT), capture_output=True)
            seconds = round(time.monotonic() - started, 6)
            stdout = completed.stdout.decode("utf-8", "replace")
            stderr = completed.stderr.decode("utf-8", "replace")
            peak, reason = (parse_peak_rss(stderr, platform.system())
                            if plan["available"] else (None, "unavailable"))
            record = {
                "label": label, "mode": mode, "argv": argv_public,
                "executed_argv": executed, "cwd": str(ROOT),
                "exit_code": completed.returncode, "seconds": seconds,
                "peak_rss": peak, "peak_rss_unavailable": reason,
                "stdout": stdout, "stderr": stderr,
            }
            write_log(log_dir / f"{label}.log", record)
            record["log"] = str(log_dir / f"{label}.log")
            try:
                payload = json.loads(stdout)
            except json.JSONDecodeError as error:
                fail(f"{label}:stdout_not_json:{error}")
                payload = {}
            record["verdict"] = payload.get("verdict")
            record["value"] = payload.get("value")
            materialisation = (payload.get("isolation") or {}).get("materialisation") or {}
            record["files_written"] = materialisation.get("files_written")
            record["files_in_snapshot"] = materialisation.get("files_in_snapshot")
            record["bytes_written"] = materialisation.get("bytes_written")
            record["closure"] = materialisation.get("closure")
            records.append(record)
        doc["runs"][mode] = records

    def summarise(mode: str) -> dict:
        records = doc["runs"].get(mode) or []
        if not records:
            return {}
        return {
            "runs": len(records),
            "exit_codes": [record["exit_code"] for record in records],
            "verdicts": sorted({record["verdict"] for record in records}),
            "files_written": sorted({record["files_written"] for record in records}),
            "bytes_written": sorted({record["bytes_written"] for record in records}),
            "seconds": [record["seconds"] for record in records],
            "peak_rss": [record["peak_rss"] for record in records],
        }

    doc["summary"] = {mode: summarise(mode) for mode in ("snapshot", "dependencies")}
    snap, dep = doc["summary"]["snapshot"], doc["summary"]["dependencies"]
    def first(summary: dict, key: str):
        values = summary.get(key) or []
        return values[0] if values else None

    snapshot_files, slice_files = first(snap, "files_written"), first(dep, "files_written")
    snapshot_bytes, slice_bytes = first(snap, "bytes_written"), first(dep, "bytes_written")
    doc["assertions"] = {
        "both_modes_ran_the_real_module": (
            snap.get("verdicts") == ["returned"] and dep.get("verdicts") == ["returned"]
        ),
        "slice_is_smaller": (
            snapshot_files is not None and slice_files is not None and slice_files < snapshot_files
        ),
        "slice_wrote_fewer_bytes": (
            snapshot_bytes is not None and slice_bytes is not None and slice_bytes < snapshot_bytes
        ),
    }
    doc["assertions"]["all"] = all(doc["assertions"].values())
    emit()

    print("=" * 72)
    print(f"materialisation bench: {args.label}")
    for mode in ("snapshot", "dependencies"):
        summary = doc["summary"][mode]
        print(f"  {mode:13s} files={summary.get('files_written')} "
              f"bytes={summary.get('bytes_written')} verdicts={summary.get('verdicts')} "
              f"seconds={summary.get('seconds')}")
    print(f"  assertions: {doc['assertions']}")
    print(f"  json      : {out}")
    print(f"  logs      : {log_dir}")
    print(f"  EXIT      : {0 if doc['assertions']['all'] and not doc['errors'] else 1}")
    print("=" * 72)
    return 0 if doc["assertions"]["all"] and not doc["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
