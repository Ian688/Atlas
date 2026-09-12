#!/usr/bin/env python3
"""Exercise persistent job ownership: idempotency, lease, and crash recovery.

Standard-library only. These drive the real CLI against a real store. The crash
case is not simulated with a flag: a row is rewound to `running` with an already
expired lease, which is precisely the state a killed process leaves behind --
the lease is the only evidence that its owner stopped.

This is not a large-project qualification and not an Atlas target-code run.
"""
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"


def make_project(base: Path, files: int) -> Path:
    """A project big enough that a run is observable while it holds its lease."""
    project = base / f"project-{files}"
    project.mkdir(parents=True)
    for index in range(files):
        (project / f"m{index}.js").write_text(
            f"export function a{index}(x){{ let y = x + {index}; return y * 2; }}\n"
            f"export function b{index}(x){{ if (x > 0) {{ return a{index}(x) }} else {{ return 0 }} }}\n",
            encoding="utf-8",
        )
    return project


class Jobs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-jobs-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.store = self.base / "store"
        self.project = shutil.copytree(ROOT / "examples/calculator", self.base / "calculator")

    def cli(self, *args, ok=True, timeout=180):
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=timeout,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def submit(self, *extra, project=None, owner="alice"):
        return self.cli(
            "job", "submit", project or self.project,
            "--owner", owner, "--project", "calc", *extra,
        )

    def enqueue(self, key, priority=0, project=None, owner="alice"):
        return self.cli(
            "job", "enqueue", project or self.project,
            "--owner", owner, "--project", "calc",
            "--request-key", key, "--priority", str(priority),
        )

    def test_a_store_created_before_the_queue_existed_is_migrated_additively(self):
        store = self.base / "old-store"
        store.mkdir()
        connection = sqlite3.connect(store / "atlas.db")
        # The jobs table exactly as it shipped before `priority` and `options`.
        connection.execute(
            """CREATE TABLE jobs(
                 id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL,
                 request_key TEXT NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL,
                 attempt INTEGER NOT NULL DEFAULT 0, lease_holder TEXT,
                 lease_expires_at INTEGER, heartbeat_at INTEGER,
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                 terminal_reason TEXT, analysis_id TEXT,
                 UNIQUE(owner,project,request_key))"""
        )
        connection.execute(
            "INSERT INTO jobs(id,owner,project,request_key,root,state,attempt,created_at,updated_at)"
            " VALUES('legacy','alice','calc','old','/tmp/p','completed',1,1,1)"
        )
        connection.commit()
        connection.close()

        self.store = store
        jobs = self.cli("job", "list")
        self.assertEqual([j["id"] for j in jobs], ["legacy"], "the existing row must survive")
        self.assertEqual(jobs[0]["priority"], 0, "an added column must take its default")
        self.assertIsNone(jobs[0]["options"])
        # And the queue is usable on a migrated store, not just readable.
        self.enqueue("fresh")
        worked = self.cli("job", "work")
        self.assertEqual(worked["ran"], 1, "a migrated store must serve the queue")

    def test_the_same_request_runs_once_and_replays_its_result(self):
        first = self.submit("--request-key", "r1")
        self.assertEqual(first["outcome"], "completed")
        self.assertTrue(first["recorded"], "the run held its lease, so it must record its result")
        self.assertEqual(first["job"]["attempt"], 1)
        analysis = first["analysis_id"]

        second = self.submit("--request-key", "r1")
        self.assertEqual(second["outcome"], "already_completed",
                         "a completed request must report its result instead of running again")
        self.assertEqual(second["job"]["id"], first["job"]["id"])
        self.assertEqual(second["job"]["analysis_id"], analysis)
        self.assertEqual(second["job"]["attempt"], 1, "no second attempt may be recorded")

        jobs = self.cli("job", "list")
        self.assertEqual(len(jobs), 1, "one request must leave exactly one job row")

    def test_identity_separates_owners_of_the_same_request_key(self):
        alice = self.submit("--request-key", "r1", owner="alice")
        bob = self.submit("--request-key", "r1", owner="bob")
        self.assertNotEqual(alice["job"]["id"], bob["job"]["id"],
                            "two owners asking for the same key are two requests")
        self.assertEqual(bob["outcome"], "completed")

    def test_enqueueing_queues_without_running_and_a_worker_drains_it(self):
        queued = self.enqueue("q1")
        self.assertEqual(queued["outcome"], "queued")
        self.assertEqual(queued["job"]["state"], "queued")
        self.assertIsNone(queued["job"]["analysis_id"], "enqueueing must not run anything")
        self.assertIsNone(queued["job"]["lease_expires_at"], "a queued job holds no lease")

        again = self.enqueue("q1")
        self.assertEqual(again["outcome"], "already_queued")
        self.assertEqual(again["job"]["id"], queued["job"]["id"])
        self.assertEqual(len(self.cli("job", "list")), 1, "one request stays one row")

        worked = self.cli("job", "work")
        self.assertEqual(worked["ran"], 1)
        self.assertEqual(worked["outcomes"][0]["outcome"], "completed")
        self.assertEqual(self.cli("job", "status", queued["job"]["id"])["state"], "completed")

    def test_a_worker_serves_priority_before_age(self):
        self.enqueue("low-1", 0)
        self.enqueue("urgent", 5)
        self.enqueue("low-2", 0)
        worked = self.cli("job", "work")
        order = [o["job"]["request_key"] for o in worked["outcomes"]]
        self.assertEqual(worked["ran"], 3, "the worker must drain the queue")
        self.assertEqual(order[0], "urgent", f"priority must be served first, got {order}")
        self.assertEqual(set(order), {"urgent", "low-1", "low-2"})

    def test_a_queued_request_can_be_cancelled_before_it_runs(self):
        queued = self.enqueue("cancel-me", 9)
        cancelled = self.cli("job", "cancel", queued["job"]["id"], "--reason", "superseded")
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual(cancelled["job"]["state"], "cancelled")
        worked = self.cli("job", "work")
        self.assertEqual(worked["ran"], 0, "a cancelled request must not be served")
        after = self.cli("job", "status", queued["job"]["id"])
        self.assertEqual(after["terminal_reason"], "superseded")
        self.assertIsNone(after["analysis_id"])

    def test_cancelling_a_job_that_is_not_queued_is_refused(self):
        queued = self.enqueue("done", 0)
        self.cli("job", "work")
        refused = self.cli("job", "cancel", queued["job"]["id"], ok=False)
        self.assertIn("queued", refused.stderr,
                      "the refusal must say what is actually cancellable")
        self.assertEqual(self.cli("job", "status", queued["job"]["id"])["state"], "completed",
                         "a refused cancellation must not change the job")

    def test_an_unsatisfied_request_may_be_retried(self):
        first = self.submit("--request-key", "r-retry")
        self.assertEqual(first["outcome"], "completed")
        # Mark it failed as if the worker had crashed after claiming the lease.
        connection = sqlite3.connect(self.store / "atlas.db")
        connection.execute(
            "UPDATE jobs SET state='failed', terminal_reason='worker_crashed', analysis_id=NULL WHERE id=?",
            (first["job"]["id"],),
        )
        connection.commit()
        connection.close()
        retry = self.submit("--request-key", "r-retry")
        self.assertEqual(retry["outcome"], "completed", "a failed request must be retryable")
        self.assertEqual(retry["job"]["attempt"], 2)

    def test_concurrent_submits_elect_exactly_one_runner(self):
        # Small on purpose: the processes only have to overlap, and a test that
        # crowds the runner's timeout is a flaky gate rather than a strict one.
        project = make_project(self.base, 80)
        argv = [
            str(BIN), "--store", str(self.store), "job", "submit", str(project),
            "--owner", "racer", "--project", "big", "--request-key", "race",
            "--lease-seconds", "30",
        ]
        processes = [
            subprocess.Popen(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for _ in range(2)
        ]
        outcomes = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=240)
            self.assertEqual(process.returncode, 0, stderr)
            outcomes.append(json.loads(stdout)["outcome"])
        self.assertEqual(outcomes.count("completed"), 1,
                         f"exactly one process may run the request, got {outcomes}")
        other = next(o for o in outcomes if o != "completed")
        self.assertIn(other, ("held_by_another_run", "already_completed"), outcomes)
        self.assertEqual(len(self.cli("job", "list")), 1,
                         "two processes and one request must leave one job row")

    def test_a_crashed_run_is_reaped_and_its_request_can_be_retried(self):
        submitted = self.submit("--request-key", "r-crash", owner="carol")
        job_id = submitted["job"]["id"]
        # Rewind to the state a killed process leaves: running, lease expired,
        # nobody renewing it. Nothing else about the store changes.
        connection = sqlite3.connect(self.store / "atlas.db")
        expired = int(time.time() * 1000) - 60_000
        connection.execute(
            "UPDATE jobs SET state='running', lease_holder='dead-process', "
            "lease_expires_at=?, heartbeat_at=?, analysis_id=NULL WHERE id=?",
            (expired, expired, job_id),
        )
        connection.commit()
        connection.close()

        self.assertEqual(self.cli("job", "status", job_id)["state"], "running")
        reaped = self.cli("job", "reap")
        self.assertEqual(reaped["reaped"], [job_id], "only the stale run may be reaped")

        after = self.cli("job", "status", job_id)
        self.assertEqual(after["state"], "failed")
        self.assertEqual(after["terminal_reason"], "lease_expired")
        self.assertIsNone(after["lease_expires_at"], "a terminal job must hold no lease")

        retry = self.submit("--request-key", "r-crash", owner="carol")
        self.assertEqual(retry["outcome"], "completed", "recovering is only useful if the request can be satisfied")
        self.assertEqual(retry["job"]["attempt"], 2)

    def test_a_live_run_renews_its_lease(self):
        project = make_project(self.base, 120)
        argv = [
            str(BIN), "--store", str(self.store), "job", "submit", str(project),
            "--owner", "dave", "--project", "big", "--request-key", "live",
            "--lease-seconds", "6",
        ]
        process = subprocess.Popen(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        samples = []
        try:
            for _ in range(80):
                time.sleep(0.5)
                running = [j for j in self.cli("job", "list") if j["state"] == "running"]
                if running:
                    samples.append(running[0]["heartbeat_at"])
                elif process.poll() is not None:
                    break
        finally:
            stdout, stderr = process.communicate(timeout=240)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(json.loads(stdout)["outcome"], "completed")
        self.assertGreaterEqual(len(samples), 2, "the run must be observable while it holds the lease")
        self.assertGreater(samples[-1], samples[0],
                           "the heartbeat must advance, or a healthy long run would be reaped as dead")


if __name__ == "__main__":
    unittest.main(verbosity=2)
