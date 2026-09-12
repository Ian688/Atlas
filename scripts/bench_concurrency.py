#!/usr/bin/env python3
"""GE-3 concurrency qualification on a REAL medium project.

The defect this window started from was found by accident, by running three
concurrent ``atlas index`` processes against the pinned rxjs@7.8.1 tree: one
finished and two exited 1 with a raw
``SqliteFailure(DatabaseBusy) "database is locked"``. Nothing was wrong with the
store or with the analysis. Publishing an analysis holds the SQLite writer, and
the other two gave up after a fixed five-second budget that is far shorter than
a real publication takes.

This script measures what happens now, on that same real tree:

1. a serial baseline (one index, fresh store) — the reference analysis id;
2. N concurrent indexes into the *same* store — all must exit 0 and publish the
   *same* id as the baseline;
3. N concurrent indexes into *separate* stores — isolates CPU contention from
   store serialisation, so "N at once" can be reported without the writer lock
   in the picture;
4. a post-run read of the store the concurrent writers shared, compared against
   the baseline's own numbers, so "it did not fail" is not the only claim.

Everything is measured: wall seconds and peak process RSS per run, from
``time(1)``; a value that cannot be measured is ``null`` with a reason. Nothing
here is synthetic and no number is invented.

Standard library only. The load-bearing assertion is id equality.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bench_real_project import (  # noqa: E402 - path set above
    DEFAULT_PACKAGE,
    DEFAULT_SHA256,
    DEFAULT_WORKER,
    index_argv,
    parse_index_stdout,
    parse_peak_rss,
    peak_rss_plan,
    peak_rss_plan as _plan,
    project_tree_digest,
    public_command,
    resolve,
    sha256_file,
    source_inventory,
    tarball_name_for,
    tree_bytes,
    write_log,
)

DEFAULT_OUT = "evidence/development/2026-09-12-real-project/rxjs/concurrency.json"

QUALIFICATION = (
    "Proves: on this one machine, against the pinned rxjs@7.8.1 tarball whose "
    "sha256 was verified before indexing, that N concurrent index runs over the "
    "same tree complete and publish the same analysis id as a serial baseline, "
    "into one shared store and into separate stores, with the measured wall "
    "seconds and peak process RSS of every run. Does NOT prove: large-repo or "
    "monorepo scale (one ~1k-file package), multi-language qualification (only "
    "JS/TS was indexed), bounded-parallelism qualification (N is what this "
    "script was told, not a measured optimum), queue-worker parallelism (the "
    "job queue is exercised sequentially elsewhere), Windows qualification, or "
    "cross-machine generalisation. Peak RSS is the OS-reported process maximum "
    "from time(1), not a heap profile. Id equality proves the concurrent runs "
    "agree with each other and with a serial run; it does NOT prove the "
    "analysis is semantically correct."
)


def concurrency_spec() -> dict:
    """How many concurrent runs this host can be asked for, and why."""
    try:
        cpus = os.cpu_count() or 1
    except NotImplementedError:
        cpus = 1
    return {
        "logical_cpus": cpus,
        "default_parallelism": min(3, max(1, cpus - 1)),
        "note": "parallelism is a choice this script was given, not a measured optimum",
    }


def launch(label: str, argv: list[str], log_dir: Path, plan: dict) -> dict:
    """Start one command without waiting for it.

    `time(1)` wraps the process so peak RSS is measured by the OS exactly as in
    the serial bench; the record is completed by `collect`.
    """
    executed = [*plan["wrapper"], *argv] if plan["available"] else list(argv)
    started = time.monotonic()
    process = subprocess.Popen(executed, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return {
        "label": label,
        "argv": list(argv),
        "executed_argv": executed,
        "started_at": started,
        "process": process,
    }


def collect(handle: dict, log_dir: Path, timeout: float) -> dict:
    process = handle.pop("process")
    try:
        stdout_bytes, stderr_bytes = process.communicate(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        process.kill()
        stdout_bytes, stderr_bytes = process.communicate()
        timed_out = True
    seconds = time.monotonic() - handle.pop("started_at")
    stdout = stdout_bytes.decode("utf-8", "replace")
    stderr = stderr_bytes.decode("utf-8", "replace")
    if not _plan()["available"]:
        peak_rss, peak_reason = None, "unavailable"
    else:
        peak_rss, peak_reason = parse_peak_rss(stderr, platform.system())
    record = {
        **handle,
        "cwd": str(ROOT),
        "exit_code": process.returncode,
        "seconds": round(seconds, 6),
        "timed_out": timed_out,
        "peak_rss": peak_rss,
        "peak_rss_unavailable": peak_reason,
        "stdout": stdout,
        "stderr": stderr,
    }
    log_path = log_dir / f"{handle['label']}.log"
    write_log(log_path, record)
    record["log"] = str(log_path)
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--sha256", default=DEFAULT_SHA256)
    parser.add_argument("--cache", default="local-state/bench/cache")
    parser.add_argument("--project", default="local-state/bench/rxjs")
    parser.add_argument("--work-store", default="local-state/bench/concurrency-store")
    parser.add_argument("--store", default="local-state/bench/store")
    parser.add_argument("--atlas", default="target/debug/atlas")
    parser.add_argument("--node", default="node")
    parser.add_argument("--worker", default=DEFAULT_WORKER)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--label", default="rxjs-7.8.1-concurrency")
    parser.add_argument("--parallelism", type=int, default=0,
                        help="concurrent runs; 0 chooses from the logical CPU count")
    parser.add_argument("--command-timeout-seconds", type=float, default=3600.0)
    args = parser.parse_args(argv)

    atlas = resolve(args.atlas)
    cache = resolve(args.cache)
    project = resolve(args.project)
    work_store = resolve(args.work_store)
    serial_store = resolve(args.store)
    worker = args.worker if os.path.isabs(args.worker) else str((ROOT / args.worker).resolve())
    out = resolve(args.out)
    log_dir = out.parent / "concurrency"
    log_dir.mkdir(parents=True, exist_ok=True)
    plan = peak_rss_plan()
    spec = concurrency_spec()
    parallelism = args.parallelism or spec["default_parallelism"]

    doc: dict = {
        "schema": "atlas.concurrency-qualification.v1",
        "label": args.label,
        "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "repo_root": str(ROOT),
        "project_spec": {
            "package": args.package,
            "tarball_sha256_expected": args.sha256,
            "tarball_sha256_actual": None,
            "tarball_sha256_match": None,
            "tarball_path": None,
            "project_dir": str(project),
            "shared_store_dir": str(work_store),
            "serial_store_dir": str(serial_store),
            "worker": worker,
            "node_command": args.node,
            "atlas_binary": str(atlas),
        },
        "environment": {
            "platform": platform.platform(),
            "system": platform.system(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "python_version": sys.version,
            "peak_rss_plan": plan,
            "concurrency": {**spec, "used": parallelism},
            "store_writer_budget_env": os.environ.get("ATLAS_STORE_BUSY_TIMEOUT_MS"),
        },
        "commands": {},
        "runs": {},
        "assertions": {},
        "errors": [],
        "qualification": QUALIFICATION,
    }

    def fail(message: str) -> None:
        doc["errors"].append(message)
        print(f"ERROR: {message}", file=sys.stderr)

    def emit() -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # -- the bytes ------------------------------------------------------------
    name = tarball_name_for(args.package)
    if not name:
        fail(f"package_not_pinned:{args.package}")
        emit()
        return 1
    tarball = cache / name
    doc["project_spec"]["tarball_path"] = str(tarball)
    if not tarball.is_file():
        fail(f"tarball_missing:{tarball}")
        emit()
        return 1
    actual = sha256_file(tarball)
    doc["project_spec"]["tarball_sha256_actual"] = actual
    doc["project_spec"]["tarball_sha256_match"] = actual == args.sha256
    if actual != args.sha256:
        fail(f"tarball_sha256_mismatch:expected={args.sha256}:actual={actual}")
        emit()
        return 1
    if not project.is_dir():
        fail(f"project_missing:{project} (extract it with bench_real_project.py first)")
        emit()
        return 1
    doc["project_spec"]["tree_digest"] = project_tree_digest(project)
    doc["project_spec"]["source_inventory"] = source_inventory(project)
    doc["project_spec"]["tree_bytes"] = tree_bytes(project)
    doc["environment"]["atlas_sha256"] = sha256_file(atlas) if atlas.is_file() else None
    if not atlas.is_file():
        fail(f"atlas_binary_missing:{atlas}")
        emit()
        return 1

    # -- 1. serial baseline ---------------------------------------------------
    if serial_store.exists():
        shutil.rmtree(serial_store)
    baseline = collect(
        launch(
            "serial-baseline",
            index_argv(atlas, serial_store, project, args.node, worker, False),
            log_dir,
            plan,
        ),
        log_dir,
        args.command_timeout_seconds,
    )
    doc["runs"]["serial_baseline"] = {**public_command(baseline), "cwd": str(ROOT)}
    baseline_json, baseline_error = parse_index_stdout(baseline["stdout"])
    doc["assertions"]["serial_baseline_ok"] = (
        baseline["exit_code"] == 0 and baseline_json is not None
    )
    if baseline_error:
        fail(f"serial_baseline:{baseline_error}")
    baseline_id = (baseline_json or {}).get("id")
    baseline_counts = {
        "function_count": (baseline_json or {}).get("function_count"),
        "node_count": (baseline_json or {}).get("node_count"),
        "edge_count": (baseline_json or {}).get("edge_count"),
        "coverage": (baseline_json or {}).get("coverage"),
    }
    doc["runs"]["serial_baseline"]["analysis_id"] = baseline_id

    # -- 2. concurrent, one shared store -------------------------------------
    if work_store.exists():
        shutil.rmtree(work_store)
    shared = [
        launch(
            f"shared-store-{index + 1}",
            index_argv(atlas, work_store, project, args.node, worker, False),
            log_dir,
            plan,
        )
        for index in range(parallelism)
    ]
    started = time.monotonic()
    shared_records = [collect(handle, log_dir, args.command_timeout_seconds) for handle in shared]
    shared_wall = round(time.monotonic() - started, 6)
    shared_ids = []
    for record in shared_records:
        parsed, error = parse_index_stdout(record["stdout"])
        record["analysis_id"] = (parsed or {}).get("id")
        record["function_count"] = (parsed or {}).get("function_count")
        if error:
            fail(f"{record['label']}:{error}")
        if record["exit_code"] != 0:
            fail(f"{record['label']}:exit={record['exit_code']}:stderr={record['stderr'].strip()[:200]}")
        shared_ids.append(record["analysis_id"])
    doc["runs"]["shared_store"] = {
        "parallelism": parallelism,
        "wall_seconds": shared_wall,
        "runs": [public_command(record) | {
            "analysis_id": record["analysis_id"],
            "function_count": record["function_count"],
        } for record in shared_records],
        "distinct_analysis_ids": sorted({value for value in shared_ids if value}),
    }
    doc["assertions"]["shared_store_all_exited_zero"] = all(
        record["exit_code"] == 0 for record in shared_records
    )
    doc["assertions"]["shared_store_single_analysis_id"] = (
        len({value for value in shared_ids if value}) == 1
    )
    doc["assertions"]["shared_store_id_equals_serial"] = (
        bool(baseline_id) and {value for value in shared_ids if value} == {baseline_id}
    )

    # -- 3. concurrent, separate stores --------------------------------------
    separate_handles = []
    separate_stores = []
    for index in range(parallelism):
        store = ROOT / "local-state" / "bench" / f"concurrency-separate-{index + 1}"
        if store.exists():
            shutil.rmtree(store)
        separate_stores.append(store)
        separate_handles.append(
            launch(
                f"separate-store-{index + 1}",
                index_argv(atlas, store, project, args.node, worker, False),
                log_dir,
                plan,
            )
        )
    started = time.monotonic()
    separate_records = [
        collect(handle, log_dir, args.command_timeout_seconds) for handle in separate_handles
    ]
    separate_wall = round(time.monotonic() - started, 6)
    separate_ids = []
    for record in separate_records:
        parsed, error = parse_index_stdout(record["stdout"])
        record["analysis_id"] = (parsed or {}).get("id")
        if error:
            fail(f"{record['label']}:{error}")
        if record["exit_code"] != 0:
            fail(f"{record['label']}:exit={record['exit_code']}:stderr={record['stderr'].strip()[:200]}")
        separate_ids.append(record["analysis_id"])
    doc["runs"]["separate_stores"] = {
        "parallelism": parallelism,
        "wall_seconds": separate_wall,
        "stores": [str(store) for store in separate_stores],
        "runs": [public_command(record) | {"analysis_id": record["analysis_id"]}
                 for record in separate_records],
        "distinct_analysis_ids": sorted({value for value in separate_ids if value}),
    }
    doc["assertions"]["separate_stores_id_equals_serial"] = (
        bool(baseline_id) and {value for value in separate_ids if value} == {baseline_id}
    )

    # -- 4. the shared store is readable and agrees with the baseline ---------
    if baseline_id:
        read = subprocess.run(
            [str(atlas), "--store", str(work_store), "report", baseline_id],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
        doc["commands"]["report_after_concurrency"] = {
            "argv": [str(atlas), "--store", str(work_store), "report", baseline_id],
            "exit_code": read.returncode,
            "stderr": read.stderr.strip()[:500],
        }
        read_json = None
        try:
            read_json = json.loads(read.stdout)
        except json.JSONDecodeError as error:
            fail(f"report_after_concurrency:not_json:{error}")
        if read.returncode != 0:
            fail(f"report_after_concurrency:exit={read.returncode}:{read.stderr.strip()[:200]}")
        if read_json:
            doc["runs"]["report_after_concurrency"] = {
                key: read_json.get(key) for key in baseline_counts
            }
            doc["assertions"]["shared_store_counts_match_baseline"] = all(
                read_json.get(key) == value for key, value in baseline_counts.items()
            )
        # A second read of the *serial* store must agree too: the shared store
        # is not special.
        serial_report = subprocess.run(
            [str(atlas), "--store", str(serial_store), "report", baseline_id],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
        doc["assertions"]["serial_store_counts_match_baseline"] = (
            serial_report.returncode == 0
            and json.loads(serial_report.stdout).get("function_count")
            == baseline_counts["function_count"]
        )

    # -- summary --------------------------------------------------------------
    gate_keys = [
        "serial_baseline_ok",
        "shared_store_all_exited_zero",
        "shared_store_single_analysis_id",
        "shared_store_id_equals_serial",
        "separate_stores_id_equals_serial",
        "shared_store_counts_match_baseline",
        "serial_store_counts_match_baseline",
    ]
    doc["assertions"]["all"] = all(bool(doc["assertions"].get(key)) for key in gate_keys)
    gate = doc["assertions"]["all"] and not doc["errors"]
    doc["summary"] = {
        "parallelism": parallelism,
        "serial_wall_seconds": baseline["seconds"],
        "shared_store_wall_seconds": shared_wall,
        "separate_stores_wall_seconds": separate_wall,
        "serial_peak_rss": baseline["peak_rss"],
        "shared_peak_rss_max": max(
            (record["peak_rss"] or 0) for record in shared_records
        ) or None,
        "note": "wall seconds describe this machine under this load; they are not "
                "a throughput model and no causal claim is made about them",
    }
    emit()

    print("=" * 72)
    print(f"concurrency qualification: {args.label}")
    for key in gate_keys:
        print(f"  {key:44s}: {doc['assertions'].get(key)}")
    print(f"  serial wall            : {baseline['seconds']} s")
    print(f"  {parallelism}x shared store   : {shared_wall} s")
    print(f"  {parallelism}x separate stores: {separate_wall} s")
    print(f"  json                   : {out}")
    print(f"  logs                   : {log_dir}")
    print(f"  EXIT                   : {0 if gate else 1}")
    print("=" * 72)
    return 0 if gate else 1


if __name__ == "__main__":
    sys.exit(main())
