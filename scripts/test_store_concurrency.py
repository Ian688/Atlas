#!/usr/bin/env python3
"""Two processes, one store: the writer lock is waited for, not reported broken.

The defect this pins was found by running three real concurrent indexes against
the pinned rxjs tarball: two of them exited 1 with a raw
``SqliteFailure(DatabaseBusy) "database is locked"``. Nothing was wrong with the
store. One process was publishing, and the other two gave up after a fixed
five-second budget that is far shorter than a real publication takes.

These tests make that race deterministic instead of hoping for it: an external
connection holds the SQLite writer for a known interval, and the assertions are
about what Atlas does while it is held.

* A write must *wait* for the lock and then succeed.
* A write must give up with a named, actionable error when its budget is spent
  -- the negative control, which is what proves the wait above was real and not
  a coincidence of timing.
* A read must not wait at all: an ordinary open used to run
  ``CREATE TABLE IF NOT EXISTS`` on every command, which takes the writer lock
  even when it creates nothing, so readers queued behind a publisher.
* Concurrent first opens on an empty store, and concurrent submissions of the
  same request key, must converge instead of racing.

Standard-library only. Every Atlas command below is the real binary.
"""
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"
#: How long the holder keeps the writer lock. Comfortably longer than the old
#: fixed five-second budget, so the old behaviour fails this test and the new
#: one only passes by really waiting.
HOLD_SECONDS = 7.0


def make_project(base: Path) -> Path:
    project = base / "project"
    (project / "src").mkdir(parents=True)
    (project / "package.json").write_text('{"name":"conc-lab","type":"module"}\n', encoding="utf-8")
    for index in range(12):
        (project / "src" / f"m{index}.js").write_text(
            f"export function f{index}(x) {{ return x + {index}; }}\n",
            encoding="utf-8",
        )
    return project


class WriterHold:
    """Hold the store's writer lock from outside Atlas, for a known interval."""

    def __init__(self, db: Path, seconds: float):
        self.db = db
        self.seconds = seconds
        self.held = threading.Event()
        self.released = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        connection = sqlite3.connect(self.db, isolation_level=None, timeout=60)
        try:
            connection.execute("PRAGMA busy_timeout=60000")
            connection.execute("BEGIN IMMEDIATE")
            self.held.set()
            time.sleep(self.seconds)
            connection.execute("COMMIT")
        except Exception as error:  # noqa: BLE001 - reported, not swallowed
            self.error = error
        finally:
            self.released.set()
            connection.close()

    def __enter__(self):
        self.thread.start()
        if not self.held.wait(timeout=30):
            raise AssertionError("the external writer hold never took the lock")
        return self

    def __exit__(self, *_):
        self.released.wait(timeout=30)


class StoreConcurrency(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-conc-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = make_project(self.base)
        self.store = self.base / "store"
        self.db = self.store / "atlas.db"

    def cli(self, *args, ok=True, timeout=300, env=None):
        """Run the real binary. The wall time of the *last* call is kept in
        `self.elapsed`, which is what these tests are actually about: whether a
        write waited and whether a read did not."""
        import os

        environment = dict(os.environ)
        environment.update(env or {})
        started = time.monotonic()
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=environment,
        )
        self.elapsed = time.monotonic() - started
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout) if result.stdout.strip() else {}
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    # -- the wait ---------------------------------------------------------
    def test_a_write_waits_for_a_held_writer_instead_of_failing(self):
        # The store has to exist for the hold to be meaningful.
        self.cli("index", self.project)
        with WriterHold(self.db, HOLD_SECONDS) as hold:
            result = self.cli("job", "enqueue", self.project, "--owner", "alice",
                              "--project", "conc", "--request-key", "held")
        self.assertIsNone(hold.error, hold.error)
        self.assertEqual(result["outcome"], "queued")
        self.assertGreaterEqual(
            self.elapsed, HOLD_SECONDS - 1.0,
            "the write returned before the lock was released, so it did not wait",
        )

    def test_a_spent_budget_is_a_named_refusal_not_a_raw_sqlite_error(self):
        # The negative control. Without it, the passing case above could just be
        # a run that never needed the lock.
        self.cli("index", self.project)
        with WriterHold(self.db, HOLD_SECONDS):
            result = self.cli("job", "enqueue", self.project, "--owner", "alice",
                              "--project", "conc", "--request-key", "held", ok=False,
                              env={"ATLAS_STORE_BUSY_TIMEOUT_MS": "400"})
        self.assertIn("store_writer_timeout:budget_ms=400", result.stderr)
        self.assertIn("ATLAS_STORE_BUSY_TIMEOUT_MS", result.stderr)
        self.assertLess(self.elapsed, HOLD_SECONDS,
                        "a spent budget must refuse before the lock is released")

    def test_reading_does_not_queue_behind_a_writer(self):
        report = self.cli("index", self.project)
        with WriterHold(self.db, HOLD_SECONDS):
            read = self.cli("report", report["id"])
        self.assertEqual(read["id"], report["id"])
        self.assertLess(
            self.elapsed, HOLD_SECONDS - 1.0,
            "a read waited for the writer lock; an ordinary open must not need it",
        )

    # -- real concurrency -------------------------------------------------
    def test_concurrent_first_opens_converge_on_one_analysis(self):
        # No serial baseline first: this is the empty-store race, which is what
        # a fresh checkout with several callers actually does.
        processes = [
            subprocess.Popen(
                [str(BIN), "--store", str(self.store), "index", str(self.project)],
                cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            for _ in range(3)
        ]
        outputs = [(process.wait(timeout=600), *process.communicate()) for process in processes]
        for code, stdout, stderr in outputs:
            self.assertEqual(code, 0, stderr)
        ids = {json.loads(stdout)["id"] for _, stdout, _ in outputs}
        self.assertEqual(len(ids), 1, f"concurrent runs disagreed: {ids}")
        # And the store agrees with them: one analysis, readable, with the same
        # function count every run reported.
        counts = {json.loads(stdout)["function_count"] for _, stdout, _ in outputs}
        report = self.cli("report", ids.pop())
        self.assertEqual(report["function_count"], counts.pop())

    def test_the_same_request_key_from_two_processes_is_one_job(self):
        self.cli("index", self.project)
        processes = [
            subprocess.Popen(
                [str(BIN), "--store", str(self.store), "job", "enqueue", str(self.project),
                 "--owner", "alice", "--project", "conc", "--request-key", "shared"],
                cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            for _ in range(2)
        ]
        outputs = []
        for process in processes:
            code = process.wait(timeout=180)
            stdout, stderr = process.communicate()
            self.assertEqual(code, 0, stderr)
            outputs.append(json.loads(stdout))
        ids = {job["job"]["id"] for job in outputs}
        self.assertEqual(len(ids), 1, f"one request key produced {ids}")
        outcomes = sorted(job["outcome"] for job in outputs)
        self.assertEqual(outcomes, ["already_queued", "queued"],
                         "exactly one caller creates the job and the other reads it back")
        listed = self.cli("job", "list")
        self.assertEqual(len(listed), 1)
        # Distinct keys are still distinct jobs: the idempotency is the key,
        # not a global "one job at a time".
        self.cli("job", "enqueue", self.project, "--owner", "alice",
                 "--project", "conc", "--request-key", "other")
        self.assertEqual(len(self.cli("job", "list")), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
