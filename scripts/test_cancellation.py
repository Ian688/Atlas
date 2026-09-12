#!/usr/bin/env python3
"""Exercise real CLI cancellation, owned-worker teardown and atomic publication.

The parser cache is produced by Atlas's real TypeScript parser from the exact
scan request. It isolates the post-worker Rust/publication window; it is not a
replacement analysis. An owned worker handshake lets the test acquire a SQLite
write lock after snapshot publication. Worker exit/reaping, signal acceptance
and database state provide synchronization; there are no fixed stage sleeps.

These are local POSIX lifecycle tests, not durable queue or platform acceptance.
Run after `cargo build --workspace --locked`.
"""

import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"


@unittest.skipUnless(os.name == "posix", "SIGINT/SIGTERM process tests require POSIX")
class Cancellation(unittest.TestCase):
    def setUp(self):
        if not Path("/proc/self/fd").is_dir() and shutil.which("lsof") is None:
            self.skipTest("post-worker synchronization needs /proc fd inspection or lsof")
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-cancellation-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        self.project.mkdir()
        self.store = self.base / "store"
        self.source = self.project / "sample.js"
        self.source.write_text("export function answer() { return 1; }\n")
        self.old = self.cli("index", self.project)
        self.symbol = self.cli(
            "nodes", self.old["id"], "--kind", "function"
        )["items"][0]["id"]
        self.old_flow = self.cli("flow", self.old["id"], self.symbol)
        self.old_source = self.cli("source", self.old["id"], self.symbol)
        self.counts_before = self.counts()

        # The proposed revision has a real, distinguishable result. A later
        # successful retry must publish it while the earlier analysis survives.
        self.source.write_text("export function answer() { return 2; }\n")
        self.cached = self.base / "facts.json"
        capture = self.base / "capture.mjs"
        capture.write_text(
            f"import {{parse}} from {json.dumps(str(ROOT / 'workers/typescript/src/parse.mjs'))};\n"
            "import {writeFileSync} from 'node:fs';\n"
            "const chunks=[]; for await (const c of process.stdin) chunks.push(c);\n"
            "const request=JSON.parse(Buffer.concat(chunks));\n"
            "const result=parse(request);\n"
            f"writeFileSync({json.dumps(str(self.cached))}, JSON.stringify(result));\n"
            # Cache generation must not publish the proposed analysis itself.
            "process.exit(23);\n"
        )
        captured = self.run_cli("index", self.project, "--worker", capture)
        self.assertNotEqual(captured.returncode, 0)
        self.assertIn("worker_exit_failed", captured.stderr)
        self.assertTrue(self.cached.is_file(), "real parser material must exist")
        self.assertEqual(self.counts(), self.counts_before)

        self.ready = self.base / "worker-ready.json"
        self.release = self.base / "release-worker"
        self.exited = self.base / "worker-exited.json"
        self.worker = self.base / "cached-worker.mjs"
        self.worker.write_text(
            "import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';\n"
            "import {setTimeout as delay} from 'node:timers/promises';\n"
            "function mark(path,value) {writeFileSync(path+'.tmp',JSON.stringify(value)); renameSync(path+'.tmp',path);}\n"
            "const chunks=[]; for await (const c of process.stdin) chunks.push(c);\n"
            "const request=JSON.parse(Buffer.concat(chunks));\n"
            f"const bytes=readFileSync({json.dumps(str(self.cached))});\n"
            "const facts=JSON.parse(bytes);\n"
            "if (request.snapshot_id !== facts.snapshot_id) throw Error('cache_snapshot_mismatch');\n"
            f"mark({json.dumps(str(self.ready))}, {{pid:process.pid}});\n"
            "const deadline=Date.now()+30000;\n"
            f"while (!existsSync({json.dumps(str(self.release))})) {{\n"
            "  if (Date.now()>deadline) throw Error('test_handshake_deadline');\n"
            "  await delay(5);\n"
            "}\n"
            "await new Promise((resolve,reject)=>process.stdout.write(bytes,e=>e?reject(e):resolve()));\n"
            f"process.on('exit', code => mark({json.dumps(str(self.exited))}, {{pid:process.pid,code}}));\n"
        )

    def run_cli(self, *args):
        return subprocess.run(
            [str(BIN), "--store", str(self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )

    def cli(self, *args):
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def counts(self):
        with sqlite3.connect(self.store / "atlas.db") as conn:
            return {
                table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("analyses", "facts", "nodes", "edges")
            }

    @staticmethod
    def pid_exists(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    def until(self, predicate, description, proc, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            if proc.poll() is not None:
                stdout, stderr = proc.communicate(timeout=2)
                self.fail(
                    f"atlas exited before {description}: rc={proc.returncode}; "
                    f"stdout={stdout!r}; stderr={stderr!r}"
                )
            # Bounded predicate polling, not an assumed duration for a stage.
            time.sleep(0.01)
        self.fail(f"timed out waiting for {description}")

    def cleanup_process(self, proc):
        # Restrict emergency cleanup to this test's uniquely named worker.
        # Checking ppid alone misses an orphan left after the parent exits.
        # Discover it even if the test failed before the ready marker appeared.
        processes = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for process in processes.splitlines():
            fields = process.split(None, 1)
            if len(fields) == 2 and str(self.worker) in fields[1]:
                try:
                    os.kill(int(fields[0]), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if proc.poll() is None:
            proc.kill()
        proc.communicate(timeout=5)
        proc.stdout.close()
        proc.stderr.close()

    def database_open(self, proc):
        """Observe a real Rust database access after the worker stage.

        Store holds a path, not a persistent connection. The handshake also
        verifies there is no database FD while worker::parse is waiting. A new
        database FD after worker reaping therefore proves the caller has
        advanced into Rust analysis/publication, including its SQL lock wait.
        """
        target = str((self.store / "atlas.db").resolve())
        fd_dir = Path(f"/proc/{proc.pid}/fd")
        if fd_dir.is_dir():
            for fd in fd_dir.iterdir():
                try:
                    if os.readlink(fd) == target:
                        return True
                except FileNotFoundError:
                    pass  # An unrelated FD closed during observation.
            return False
        inspected = subprocess.run(
            ["lsof", "-a", "-p", str(proc.pid), "-F", "n"],
            capture_output=True, text=True, timeout=3,
        )
        self.assertIn(inspected.returncode, (0, 1), inspected.stderr)
        return f"n{target}" in inspected.stdout.splitlines()

    def start_cached(self, *extra):
        proc = subprocess.Popen(
            [str(BIN), "--store", str(self.store), "index", str(self.project),
             "--worker", str(self.worker), *extra],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.addCleanup(self.cleanup_process, proc)
        self.until(self.ready.exists, "worker request handshake", proc)
        pid = json.loads(self.ready.read_text())["pid"]
        self.assertTrue(self.pid_exists(pid))
        self.assertFalse(
            self.database_open(proc), "worker handshake must precede Rust database access"
        )
        return proc, pid

    def lock_publication(self):
        conn = sqlite3.connect(self.store / "atlas.db", timeout=1)
        self.addCleanup(conn.close)
        # Called only after the worker has read its request, proving that the
        # scan and snapshot publication have already completed.
        conn.execute("BEGIN IMMEDIATE")
        return conn

    def finish_worker(self, proc, pid):
        self.release.touch()
        self.until(self.exited.exists, "cached worker normal exit marker", proc)
        self.assertEqual(json.loads(self.exited.read_text()), {"pid": pid, "code": 0})
        # A zombie still passes kill(pid, 0). ESRCH proves actual reaping,
        # including when a broken parent would otherwise orphan its child.
        self.until(lambda: not self.pid_exists(pid), "worker to be reaped", proc)
        self.until(
            lambda: self.database_open(proc), "post-worker Rust database access", proc
        )
        self.assertIsNone(proc.poll(), "SQLite lock must keep publication pending")

    def wait_for_signal_ack(self, proc):
        """Wait for the real signal listener before releasing the SQL lock."""
        received = bytearray()
        deadline = time.monotonic() + 3
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stderr, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                events = selector.select(max(0, deadline - time.monotonic()))
                if not events:
                    break
                chunk = os.read(proc.stderr.fileno(), 8192)
                if not chunk:
                    break
                received.extend(chunk)
                if b"index_cancellation_requested" in received:
                    return bytes(received)
        self.fail(f"no signal acceptance diagnostic: {bytes(received)!r}")

    def assert_preserved_then_retry(self):
        self.assertEqual(self.counts(), self.counts_before, "failed job added published rows")
        self.assertEqual(self.cli("report", self.old["id"]), self.old)
        self.assertEqual(self.cli("flow", self.old["id"], self.symbol), self.old_flow)
        self.assertEqual(self.cli("source", self.old["id"], self.symbol), self.old_source)
        retried = self.cli("index", self.project)  # Retry uses the real worker.
        self.assertNotEqual(retried["id"], self.old["id"])
        flow = self.cli("flow", retried["id"], self.symbol)
        self.assertEqual(flow["returns"]["constants"], [2.0])
        self.assertEqual(self.cli("flow", self.old["id"], self.symbol), self.old_flow)
        self.assertEqual(self.counts()["analyses"], self.counts_before["analyses"] + 1)

    def cancel_after_worker(self, sig):
        proc, pid = self.start_cached()
        lock = self.lock_publication()
        self.finish_worker(proc, pid)
        start = time.monotonic()
        proc.send_signal(sig)
        prefix = self.wait_for_signal_ack(proc)
        # The cancellation has been accepted while another connection prevents
        # commits. Unlocking must not let stale successful results be published.
        lock.rollback()
        stdout, stderr = proc.communicate(timeout=3)
        signal_elapsed = time.monotonic() - start
        stderr = (prefix + stderr).decode()
        self.assertNotEqual(proc.returncode, 0, stderr)
        self.assertGreater(proc.returncode, 0, "must exit cooperatively, not from a fatal signal")
        self.assertIn("index_cancelled_no_analysis_published", stderr)
        self.assertEqual(stdout, b"", "cancelled job must not print successful metadata")
        self.assertFalse(self.pid_exists(pid), "owned worker leaked")
        self.assert_preserved_then_retry()
        print(json.dumps({
            "case": f"{signal.Signals(sig).name}_after_worker_under_publication_lock",
            "exit_code": proc.returncode,
            "signal_to_exit_seconds": round(signal_elapsed, 3),
            "worker_reaped": True, "publication_unchanged": True, "retry_exit_code": 0,
        }))

    def cancel_waiting_worker(self, sig):
        proc, pid = self.start_cached()
        proc.send_signal(sig)
        stdout, stderr = proc.communicate(timeout=3)
        self.assertNotEqual(proc.returncode, 0, stderr)
        self.assertGreater(proc.returncode, 0, "must exit cooperatively")
        self.assertIn(b"cancelled_by_signal", stderr)
        self.assertEqual(stdout, b"")
        self.assertFalse(self.pid_exists(pid), "owned worker must be killed and reaped")
        self.assertFalse(self.exited.exists(), "worker was waiting, not normally completed")
        self.assert_preserved_then_retry()

    def test_sigint_after_worker_cannot_publish_when_lock_releases(self):
        self.cancel_after_worker(signal.SIGINT)

    def test_sigterm_after_worker_cannot_publish_when_lock_releases(self):
        self.cancel_after_worker(signal.SIGTERM)

    def test_sigint_while_worker_waits_reaps_child_and_allows_retry(self):
        self.cancel_waiting_worker(signal.SIGINT)

    def test_sigterm_while_worker_waits_reaps_child_and_allows_retry(self):
        self.cancel_waiting_worker(signal.SIGTERM)

    def test_pipeline_deadline_includes_publication_lock_wait(self):
        started = time.monotonic()
        proc, pid = self.start_cached("--index-deadline-seconds", "2")
        lock = self.lock_publication()
        self.finish_worker(proc, pid)
        # Retain the lock until the process exits. The pipeline deadline must
        # beat SQLite's ordinary 5-second busy timeout and classify the failure.
        stdout, stderr = proc.communicate(timeout=4)
        elapsed = time.monotonic() - started
        lock.rollback()
        self.assertNotEqual(proc.returncode, 0, stderr)
        self.assertIn(b"analysis_deadline_exceeded_no_analysis_published", stderr)
        self.assertLess(elapsed, 4, "pipeline deadline did not bound SQL lock wait")
        self.assertEqual(stdout, b"")
        self.assertFalse(self.pid_exists(pid))
        self.assert_preserved_then_retry()
        print(json.dumps({
            "case": "pipeline_deadline_under_publication_lock",
            "exit_code": proc.returncode, "elapsed_seconds": round(elapsed, 3),
            "publication_unchanged": True, "retry_exit_code": 0,
        }))


if __name__ == "__main__":
    if not BIN.exists():
        raise SystemExit("Run cargo build --workspace --locked first")
    unittest.main(verbosity=2)
