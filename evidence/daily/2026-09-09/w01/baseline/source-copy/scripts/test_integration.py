#!/usr/bin/env python3
"""Exercise the actual Rust CLI, Node worker, SQLite queries and HTTP boundary.

Standard-library only. Every child is owned, bounded and reaped. This is not a
large-project qualification or an Atlas target-code execution test.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"


class Integration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-integration-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        shutil.copytree(ROOT / "examples/calculator", self.project)
        self.store = self.base / "store"

    def cli(self, *args, ok=True):
        result = subprocess.run([str(BIN), "--store", str(self.store), *map(str,args)], cwd=ROOT, capture_output=True, text=True, timeout=90)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def index(self):
        return self.cli("index", self.project)

    def test_calculator_actual_cross_file_chain_and_unknown_denominator(self):
        a = self.index()
        self.assertEqual(a["function_count"], 10)  # 7 named functions and 3 assert.throws callbacks.
        self.assertEqual(a["coverage"]["parsed_source_files"], 4)
        functions = self.cli("nodes", a["id"], "--kind", "function")["items"]
        calc = next(n for n in functions if n["name"] == "calculate")
        reach = self.cli("reach", a["id"], calc["id"])
        self.assertEqual({n["name"] for n in reach["nodes"]}, {"calculate", "parseInput", "validateNumber", "evaluate", "add", "subtract", "divide"})
        self.assertGreater(len(reach["unresolved"]), 0)
        self.assertFalse(reach["truncated"])
        edges = self.cli("edges", a["id"])["items"]
        self.assertEqual(a["call_count"], len(edges))
        self.assertEqual(a["unresolved_call_count"], sum(e["target"] is None for e in edges))
        self.assertEqual(self.cli("source", a["id"], calc["id"])["content"], "export function calculate(leftText, operator, rightText) {\n  const left = parseInput(leftText);\n  const right = parseInput(rightText);\n  return evaluate(operator, left, right);\n}")

    def test_old_revision_context_and_query_cursor_survive_reindex(self):
        a = self.index()
        page = self.cli("nodes", a["id"], "--limit", "2")
        context = self.cli("context", a["id"], "file:src/math.js")
        (self.project / "src/math.js").write_text("export function changed(){return 99}")
        b = self.index()
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(context, self.cli("context", a["id"], "file:src/math.js"))
        self.assertIn("divide", self.cli("source", a["id"], "file:src/math.js")["content"])
        self.cli("nodes", b["id"], "--limit", "2", "--cursor", page["next_cursor"], ok=False)
        self.assertEqual(b["id"], self.index()["id"])

    def test_index_does_not_execute_project_or_load_ambient_node_options(self):
        marker = self.base / "SHOULD_NOT_EXIST"
        (self.project / "hostile.js").write_text(f"import fs from 'node:fs'; fs.writeFileSync({json.dumps(str(marker))},'BAD'); while(true){{}}")
        prior = os.environ.get("NODE_OPTIONS")
        os.environ["NODE_OPTIONS"] = "--definitely-invalid-node-option"
        try:
            a = self.index()
        finally:
            if prior is None: os.environ.pop("NODE_OPTIONS", None)
            else: os.environ["NODE_OPTIONS"] = prior
        self.assertFalse(marker.exists())
        self.assertEqual(a["coverage"]["parsed_source_files"], 5)

    def test_synthetic_pagination_counts_all_1200_functions_without_claiming_scale(self):
        shutil.rmtree(self.project)
        self.project.mkdir()
        for i in range(120):
            lines = [f"import {{ f{(i+1)*10} }} from './f{i+1}.ts';"] if i < 119 else []
            for j in range(10):
                n = i*10+j
                call = f"f{n+1}()" if n < 1199 else "0"
                lines.append(f"export function f{n}(){{return {call};}}")
            (self.project / f"f{i}.ts").write_text("\n".join(lines))
        start = time.monotonic();a = self.index()
        self.assertEqual(a["function_count"], 1200)
        self.assertEqual(a["coverage"]["parsed_source_files"], 120)
        all_nodes = [];cursor = None
        while True:
            args = ["nodes", a["id"], "--kind", "function", "--limit", "500"]
            if cursor: args += ["--cursor", cursor]
            page = self.cli(*args);self.assertEqual(page["total"],1200);all_nodes += page["items"];cursor=page["next_cursor"]
            if cursor is None: break
        self.assertEqual(len({n["id"] for n in all_nodes}),1200)
        root = next(n["id"] for n in all_nodes if n["name"]=="f0")
        reach = self.cli("reach",a["id"],root,"--max-nodes","500","--max-edges","2000")
        self.assertEqual(len(reach["nodes"]),500);self.assertTrue(reach["truncated"]);self.assertGreater(len(reach["frontier"]),0)
        print(f"Synthetic boundary: 120 files / 1200 functions / {time.monotonic()-start:.2f}s incl. CLI queries; not GE qualification")

    def test_local_web_authorization_revision_and_shutdown(self):
        a = self.index()
        proc = subprocess.Popen([str(BIN),"--store",str(self.store),"serve",a["id"]],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(proc.stdout,selectors.EVENT_READ)
                self.assertTrue(ready.select(10),"HTTP server readiness deadline")
            boot = json.loads(proc.stdout.readline())
            session_path = Path(boot["session_file"])
            session = json.loads(session_path.read_text())
            if os.name == "posix": self.assertEqual(stat.S_IMODE(session_path.stat().st_mode),0o600)
            self.assertNotIn("token",boot)
            url=session["url"]
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def request(path,headers=None,method="GET"):
                return opener.open(urllib.request.Request(url+path,headers=headers or {},method=method),timeout=8)
            for bad in [{},{"Authorization":"Bearer wrong"},{"Authorization":"Bearer "+session["token"],"Origin":"https://untrusted.example"},{"Authorization":"Bearer "+session["token"],"Host":"untrusted.example"}]:
                with self.assertRaises(urllib.error.HTTPError) as error: request("api/report",bad)
                self.assertEqual(error.exception.code,401)
                error.exception.close()
            auth={"Authorization":"Bearer "+session["token"]}
            with request("api/report",auth) as r:self.assertEqual(json.load(r)["id"],a["id"])
            with request("api/context?entity=file%3Asrc%2Fmath.js",auth,"POST") as r:self.assertEqual(json.load(r)["context"]["analysis_id"],a["id"])
            with request("") as r:self.assertIn("frame-ancestors 'none'",r.headers["Content-Security-Policy"]);self.assertIn("ATLAS",r.read().decode())
            for asset in ["app.js","style.css"]:
                with request(asset) as r:self.assertGreater(len(r.read()),100)
            proc.send_signal(signal.SIGINT);stdout,stderr=proc.communicate(timeout=10)
            self.assertEqual(proc.returncode,0,stderr);self.assertFalse(session_path.exists())
        finally:
            if proc.poll() is None:proc.kill()
            proc.communicate(timeout=5)
            proc.stdout.close();proc.stderr.close()


if __name__=="__main__":
    if not BIN.exists():raise SystemExit("Run cargo build --workspace first")
    unittest.main(verbosity=2)
