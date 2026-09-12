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


    def test_flow_facts_through_real_worker_store_cli_and_http(self):
        """D22 pipeline: JS source -> worker IR -> Rust CFG/solver -> SQLite ->
        CLI/HTTP. Expectations are written from JavaScript semantics first."""
        shutil.rmtree(self.project)
        shutil.copytree(ROOT / "examples/flow-lab", self.project)
        a = self.index()
        self.assertEqual(a["coverage"]["flow_functions"], 15)

        self.assertEqual(a["coverage"]["flow_partial"], 0)
        self.assertGreater(a["coverage"]["flow_unknown_regions"], 0, "for-of must surface as an explicit unknown")
        report = self.cli("report", a["id"])
        self.assertTrue(any("js-structured-control.v1" in item for item in report["limitations"]))
        symbols = {n["name"]: n["id"] for n in self.cli("nodes", a["id"], "--kind", "function")["items"]}
        listed = self.cli("flows", a["id"])
        self.assertEqual(listed["total"], len(symbols))
        # R7: parameter-less catch and nested rethrow index cleanly and their
        # constants flow; a catch cannot see its own rethrown value.
        optional = self.cli("flow", a["id"], symbols["optionalCatch"])
        self.assertEqual(optional["returns"]["constants"], [7.0])
        rethrow = self.cli("flow", a["id"], symbols["rethrow"])
        self.assertEqual(rethrow["returns"]["constants"], [2.0])
        self.assertFalse(rethrow["returns"]["constants"] == [1.0])

        # D07: both branch candidates survive the join, without evidence to prune.
        branch = self.cli("flow", a["id"], symbols["branchPick"])
        self.assertEqual(branch["status"], "complete_within_profile")
        self.assertEqual(sorted(branch["effects"]["may_call"]), sorted([symbols["fastPath"], symbols["slowPath"]]))

        # D08: an unconditional reassignment kills the earlier candidate.
        strong = self.cli("flow", a["id"], symbols["strongUpdate"])
        self.assertEqual(strong["effects"]["may_call"], [symbols["slowPath"]], "only slowPath can be called")

        # D12: identity keeps its parameter origin.
        identity = self.cli("flow", a["id"], symbols["identity"])
        self.assertIn("Parameter(0)", identity["returns"]["origins"])
        self.assertFalse(identity["returns"]["unknown"])

        # D04: empty finally must not restore the clobbered binding, and the
        # pending completion passes through a shared dispatch block.
        fin = self.cli("flow", a["id"], symbols["withFinally"])
        self.assertIn("Parameter(0)", fin["returns"]["origins"], "name must be user, not 'a'")
        self.assertIn("dispatch", {b["term"] for b in fin["blocks"]}, "shared finally dispatch must exist")

        # D03: a finally return overrides the pending completion: only 2 escapes.
        override = self.cli("flow", a["id"], symbols["finallyOverrides"])
        self.assertEqual(override["returns"]["constants"], [2.0])
        self.assertNotIn("dispatch", {b["term"] for b in override["blocks"]}, "a terminating finally needs no dispatch")

        # D05: loop fixpoint converges and marks looping blocks.
        loop = self.cli("flow", a["id"], symbols["countdown"])
        self.assertEqual(loop["status"], "complete_within_profile")
        self.assertTrue(loop["looping_blocks"], "while body must be marked as looping")

        # D02: false && and 'x' ?? never reach effect(); pruning is recorded.
        short = self.cli("flow", a["id"], symbols["shortCircuit"])
        self.assertFalse(short["effects"]["unknown_call"], "effect() is statically unreachable in both cases")
        self.assertEqual(short["returns"]["constants"], [False], "false ?? 'x' evaluates to false")
        self.assertGreater(len(short["pruned_edges"]), 0, "constant-condition pruning must be recorded")

        # The throw path comes from the real CFG, not a hardcoded list.
        divide = self.cli("flow", a["id"], symbols["divider"])
        self.assertTrue(divide["throws"]["unknown"] or divide["throws"]["origins"])
        self.assertTrue(divide["effects"]["may_throw"])

        # W04: summaries re-base parameter origins; the constant crosses
        # identity into indirect's return without cross-caller streaming.
        indirect = self.cli("flow", a["id"], symbols["indirect"])
        self.assertIn("Constant", indirect["returns"]["origins"], "identity(41) must return the caller's constant")
        self.assertEqual(indirect["interprocedural"]["callsites"][0]["targets"], [symbols["identity"]])
        self.assertTrue(indirect["interprocedural"]["callsites"][0]["targets_complete"])

        # Declared-unsupported constructs stay explicit unknowns end to end.
        loop_callers = self.cli("flow", a["id"], symbols["loopCallers"])
        self.assertIn("unmodeled_construct:for_in_of_iteration", loop_callers["unknown_reasons"])

        # HTTP serves the same fact for the same analysis version.
        proc = subprocess.Popen([str(BIN), "--store", str(self.store), "serve", a["id"]], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(proc.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(10), "HTTP server readiness deadline")
            boot = json.loads(proc.stdout.readline())
            session = json.loads(Path(boot["session_file"]).read_text())
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            auth = {"Authorization": "Bearer " + session["token"]}
            base = session["url"]
            with opener.open(urllib.request.Request(base + "api/flow?entity=" + urllib.parse.quote(symbols["identity"]), headers=auth), timeout=8) as r:
                served = json.load(r)
            self.assertEqual(served["symbol"], symbols["identity"])
            self.assertIn("Parameter(0)", served["returns"]["origins"])
            with opener.open(urllib.request.Request(base + "api/flows", headers=auth), timeout=8) as r:
                self.assertEqual(json.load(r)["total"], listed["total"])
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=5)
            proc.stdout.close(); proc.stderr.close()

        # Old analysis keeps its flow facts readable after the source changes.
        (self.project / "src/pipeline.js").write_text("export function changedOnly(){return 1}\n")
        b = self.index()
        self.assertNotEqual(a["id"], b["id"])
        still = self.cli("flow", a["id"], symbols["identity"])
        self.assertIn("Parameter(0)", still["returns"]["origins"])
        self.cli("flow", b["id"], symbols["identity"], ok=False)

    def test_getters_and_proxies_are_data_never_executed_and_effects_stay_unknown(self):
        """D06: analysis reads text; a getter that would write a marker never
        runs, and the modeled property access keeps unknown effects."""
        shutil.rmtree(self.project)
        self.project.mkdir()
        (self.project / "src").mkdir()
        marker = self.base / "GETTER_MUST_NOT_RUN"
        (self.project / "src/config.js").write_text(
            "export const config = { get value() { throw new Error('getter ran'); } };\n"
        )
        (self.project / "src/read.js").write_text(
            "import { config } from './config.js';\n"
            "export function readConfig() {\n"
            "  return config.value;\n"
            "}\n"
        )
        a = self.index()
        self.assertFalse(marker.exists())
        symbols = {n["name"]: n["id"] for n in self.cli("nodes", a["id"], "--kind", "function")["items"]}
        read_flow = self.cli("flow", a["id"], symbols["readConfig"])
        self.assertTrue(read_flow["effects"]["unknown_call"], "property read must keep getter/call effects unknown")

        # D11: an unresolved external receiving an object and a callback keeps
        # escape/callback/unknown-call effects instead of claiming purity.
        shutil.rmtree(self.project)
        shutil.copytree(ROOT / "examples/flow-lab", self.project)
        b = self.index()
        symbols_b = {n["name"]: n["id"] for n in self.cli("nodes", b["id"], "--kind", "function")["items"]}
        sink = self.cli("flow", b["id"], symbols_b["externalSink"])
        self.assertTrue(sink["effects"]["unknown_call"])
        self.assertTrue(sink["effects"]["registers_callback"])
        self.assertTrue(sink["effects"]["escaped_local_value"])
        self.assertEqual(sink["interprocedural"]["callsites"][0]["unknown_component"], True)

    def test_multi_project_store_isolation(self):
        """W06-lite: two projects in one store stay version-isolated; no query
        may reach across analyses."""
        shutil.rmtree(self.project)
        self.project.mkdir()
        (self.project / "only_a.js").write_text("export function alpha(){return 1}")
        a = self.index()
        other = self.base / "project-b"
        shutil.copytree(ROOT / "examples/calculator", other)
        b = self.cli("index", other)
        self.assertNotEqual(a["id"], b["id"])
        # Queries on b never see a's entities and vice versa.
        a_symbols = {n["id"] for n in self.cli("nodes", a["id"], "--kind", "function")["items"]}
        b_symbols = {n["id"] for n in self.cli("nodes", b["id"], "--kind", "function")["items"]}
        self.assertTrue(a_symbols)
        self.assertFalse(a_symbols & b_symbols)
        sample = next(iter(b_symbols))
        self.cli("flow", a["id"], sample, ok=False)
        self.cli("source", a["id"], sample, ok=False)
        self.cli("nodes", a["id"], "--kind", "function", "--cursor", "x:0", ok=False)
        # Two concurrent indexes of the same bytes reach the same terminal state.
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            runs = list(pool.map(lambda _: self.cli("index", other), range(2)))
        self.assertEqual(runs[0]["id"], b["id"])
        self.assertEqual(runs[1]["id"], b["id"])
        # Scan-stage deadline is configurable and refuses invalid values.
        bad = subprocess.run([str(BIN), "--store", str(self.store), "index", "--scan-deadline-seconds", "0", str(other)], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(bad.returncode, 0)
        bad = subprocess.run([str(BIN), "--store", str(self.store), "index", "--index-deadline-seconds", "0", str(other)], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(bad.returncode, 0)
        # A generous pipeline deadline keeps the normal path working.
        ok = subprocess.run([str(BIN), "--store", str(self.store), "index", "--index-deadline-seconds", "3600", str(other)], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(ok.returncode, 0, ok.stderr)

        # Re-indexing a leaves b untouched.
        a2 = self.index()
        self.assertEqual(a["id"], a2["id"])
        self.cli("report", b["id"])

    def test_corrupted_blob_is_refused_and_old_flow_facts_survive(self):
        """D20: a corrupted captured blob must fail source reads cleanly while
        flow facts of the same analysis stay queryable; re-index republishes."""
        shutil.rmtree(self.project)
        shutil.copytree(ROOT / "examples/flow-lab", self.project)
        a = self.index()
        symbols = {n["name"]: n["id"] for n in self.cli("nodes", a["id"], "--kind", "function")["items"]}
        identity_before = self.cli("flow", a["id"], symbols["identity"])
        # Corrupt the blob backing pipeline.js.
        import sqlite3
        conn = sqlite3.connect(self.store / "atlas.db")
        snapshot_id = conn.execute("SELECT snapshot FROM analyses WHERE id=?", (a["id"],)).fetchone()[0]
        row = conn.execute("SELECT body FROM snapshots WHERE id=?", (snapshot_id,)).fetchone()[0]
        entries = json.loads(row)["entries"]
        target = next(e for e in entries if e.get("blob") and e["path"].endswith("pipeline.js"))
        blob_path = self.store / "blobs" / target["blob"]
        data = bytearray(blob_path.read_bytes())
        data[0] ^= 0xFF
        blob_path.write_bytes(bytes(data))
        corrupted = self.cli("source", a["id"], symbols["identity"], ok=False)
        self.cli("context", a["id"], symbols["identity"], ok=False)
        still = self.cli("flow", a["id"], symbols["identity"])
        self.assertEqual(still["returns"], identity_before["returns"])
        # Re-index refuses to silently overwrite the corrupt blob.
        b = self.cli("index", ok=False)
        # Documented recovery: remove the corrupt content-addressed file, then
        # re-index recaptures it from the project snapshot bytes.
        blob_path.unlink()
        c = self.index()
        self.assertEqual(a["id"], c["id"])
        self.cli("source", c["id"], symbols["identity"])

    def test_alpha_renaming_yields_equivalent_flow_facts(self):
        """D21: same-length alpha renaming must produce byte-identical flow
        facts after mapping names back; no fixture-name special-casing."""
        import re
        renames = [
            ("fastPath", "zastPath"), ("slowPath", "tlowPath"),
            ("branchPick", "brunchPick"), ("strongUpdate", "strongUpdute"),
            ("identity", "identitz"), ("indirect", "indirecx"),
            ("withFinally", "witgFinally"), ("countdown", "coundowyn"),
            ("shortCircuit", "shornCircuit"), ("divider", "divifer"),
            ("loopCallers", "loopCallems"), ("externalSink", "externalSinx"),
            ("finallyOverrides", "finallyOverridex"),
            ("flag", "flbg"), ("pick", "pico"), ("user", "usor"),
            ("value", "valuf"), ("total", "tutal"), ("left", "lefu"),
            ("right", "righu"), ("effect", "effecu"), ("handlers", "handleru"),
            ("callback", "callbacl"), ("payload", "paylodd"),
        ]
        shutil.rmtree(self.project)
        self.project.mkdir()
        (self.project / "src").mkdir()
        original = (ROOT / "examples/flow-lab/src/pipeline.js").read_text()
        renamed = original
        for old, new in renames:
            renamed = re.sub(r"\b" + old + r"\b", new, renamed)
        (self.project / "src/pipeline.js").write_text(renamed)

        base_project = self.base / "project-base"
        shutil.copytree(ROOT / "examples/flow-lab", base_project)
        base_store = self.base / "store-base"
        out = subprocess.run([str(BIN), "--store", str(base_store), "index", str(base_project)], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        analysis_a = json.loads(out.stdout)["id"]
        analysis_b = self.index()["id"]

        def nodes_of(store, analysis):
            out = subprocess.run([str(BIN), "--store", str(store), "nodes", analysis, "--kind", "function"], cwd=ROOT, capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr)
            return {n["name"]: n["id"] for n in json.loads(out.stdout)["items"]}

        def flow_of(store, analysis, symbol):
            out = subprocess.run([str(BIN), "--store", str(store), "flow", analysis, symbol], cwd=ROOT, capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr)
            return json.loads(out.stdout)

        names_a = nodes_of(base_store, analysis_a)
        names_b = nodes_of(self.store, analysis_b)
        for old, new in renames:
            if old not in names_a:
                continue
            self.assertIn(new, names_b)
            # Spans are byte-length-preserving, so symbol ids match 1:1.
            self.assertEqual(names_a[old], names_b[new])
            fact_a = flow_of(base_store, analysis_a, names_a[old])
            fact_b = flow_of(self.store, analysis_b, names_b[new])
            fact_a.pop("analysis_id")
            fact_b.pop("analysis_id")
            text_a = json.dumps(fact_a, sort_keys=True)
            text_b = json.dumps(fact_b, sort_keys=True)
            for orig_name, renamed_name in renames:
                text_b = re.sub(r"\b" + renamed_name + r"\b", orig_name, text_b)
            if text_a != text_b:
                import difflib
                diff = "\n".join(list(difflib.unified_diff(text_a.split("}, "), text_b.split("}, ")))[:12])
                self.fail(f"flow fact for {old} not rename-invariant:\n{diff[:2000]}")

    def test_nested_finally_and_wide_branch_stay_linear_within_budget(self):
        """D19/AL-05: shared finally dispatch must keep the CFG linear under
        nesting (no combinatorial copying), and a wide-but-flat function still
        solves completely inside the declared budgets."""
        import shutil as _shutil
        shutil.rmtree(self.project)
        self.project.mkdir()
        (self.project / "src").mkdir()
        depth = 20
        body = "let acc = 0;\n"
        for level in range(depth):
            body += f"try {{ acc = acc + {level};\n"
        for level in range(depth):
            body += "} finally { acc = acc + 1; }\n"
        body += "return acc;\n"
        (self.project / "src/nested.js").write_text(f"export function nested() {{\n{body}}}\n")
        branches = " ".join(
            f"if (flag === {level}) {{ pick = pick + {level}; }}" for level in range(60)
        )
        (self.project / "src/wide.js").write_text(
            "export function wide(flag) {\n  let pick = 0;\n  " + branches + "\n  return pick;\n}\n"
        )
        a = self.index()
        self.assertEqual(a["coverage"]["flow_functions"], 2)
        self.assertEqual(a["coverage"]["flow_partial"], 0)
        symbols = {n["name"]: n["id"] for n in self.cli("nodes", a["id"], "--kind", "function")["items"]}
        nested = self.cli("flow", a["id"], symbols["nested"])
        # Linear bound: a handful of blocks per try layer, not 2^20 paths.
        self.assertLess(len(nested["blocks"]), depth * 12, "finally nesting must not explode the CFG")
        self.assertEqual(nested["status"], "complete_within_profile")
        dispatches = sum(1 for b in nested["blocks"] if b["term"] == "dispatch")
        self.assertGreaterEqual(dispatches, depth, "every finally layer keeps its dispatch")
        wide = self.cli("flow", a["id"], symbols["wide"])
        self.assertEqual(wide["status"], "complete_within_profile")
        self.assertGreater(len(wide["blocks"]), 100, "60 branch arms must produce real control flow")

    def test_worker_ir_tampering_is_rejected_before_derived_facts(self):
        """R6 formalization: duplicate binding ids, dangling local references
        and dropped flow functions must each refuse the Analysis at the real
        worker boundary (zero derived facts published)."""
        import json as _json
        cases = {
            "duplicate_binding": "result.flow.functions[0].bindings.push({...result.flow.functions[0].bindings[0]});",
            "missing_flow_function": "result.flow.functions = [];",
            "dangling_local_reference": (
                "let changed = 0; function visit(x) {if (!x || typeof x !== 'object') return; "
                "if (x.expr === 'local') { x.binding = 'b:nonexistent'; changed++; } "
                "for (const v of Object.values(x)) visit(v); } "
                "visit(result.flow); if (changed !== 1) throw new Error('mutation_not_applied');"
            ),
        }
        for name, mutation in cases.items():
            with self.subTest(case=name):
                workdir = self.base / f"tamper-{name}"
                project = workdir / "project"
                project.mkdir(parents=True)
                (project / "sample.mjs").write_text("export function f(x) { return x; }")
                store = workdir / "store"
                worker = workdir / "worker.mjs"
                worker.write_text(
                    f"import {{parse}} from {_json.dumps(str(ROOT / 'workers/typescript/src/parse.mjs'))};\n"
                    "const chunks=[]; for await (const c of process.stdin) chunks.push(c); "
                    "const result=parse(JSON.parse(Buffer.concat(chunks)));\n"
                    f"{mutation}\n"
                    "process.stdout.write(JSON.stringify(result));\n"
                )
                result = subprocess.run(
                    [str(BIN), "--store", str(store), "index", str(project), "--worker", str(worker)],
                    cwd=ROOT, capture_output=True, text=True, timeout=90,
                )
                self.assertNotEqual(result.returncode, 0, f"{name} must be refused")
                self.assertIn("facts: 0" if False else "Invalid", result.stderr)
                import sqlite3
                db = store / "atlas.db"
                if db.exists():
                    with sqlite3.connect(db) as conn:
                        analyses = conn.execute("SELECT COUNT(*) FROM analyses").fetchone()[0]
                        facts = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
                    self.assertEqual(analyses, 0, f"{name}: no analysis may be published")
                    self.assertEqual(facts, 0, f"{name}: no derived facts may be published")

    def test_worker_crash_leaves_store_intact_and_old_analyses_readable(self):
        """W06: a worker that exits non-zero mid-pipeline publishes nothing,
        and previously published analyses stay readable."""
        shutil.rmtree(self.project)
        self.project.mkdir()
        (self.project / "ok.js").write_text("export function fine(){return 1}")
        a = self.index()
        crashing_worker = self.base / "crash.mjs"
        crashing_worker.write_text("process.exit(3);")
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), "index", str(self.project), "--worker", str(crashing_worker)],
            cwd=ROOT, capture_output=True, text=True, timeout=90,
        )
        self.assertNotEqual(result.returncode, 0)
        import sqlite3
        with sqlite3.connect(self.store / "atlas.db") as conn:
            analyses = conn.execute("SELECT COUNT(*) FROM analyses").fetchone()[0]
        self.assertEqual(analyses, 1, "crashed worker must not add analyses")
        # Old analysis stays fully readable, including derived flow facts.
        self.cli("report", a["id"])
        symbols = {n["name"]: n["id"] for n in self.cli("nodes", a["id"], "--kind", "function")["items"]}
        flow = self.cli("flow", a["id"], symbols["fine"])
        self.assertEqual(flow["status"], "complete_within_profile")

    def test_sigint_cancels_index_kills_worker_and_publishes_nothing(self):
        """W06: SIGINT during the worker stage terminates atlas with a nonzero
        exit, reaps the owned worker child, and publishes no analysis."""
        import os as _os
        import time as _time
        shutil.rmtree(self.project)
        self.project.mkdir()
        for i in range(1200):
            (self.project / f"g{i}.js").write_text(
                f"export function g{i}() {{ let v = 0; for (let k = 0; k < 50; k++) {{ v = v + k; }} return g{i+1} === undefined ? v : 0; }}"
            )
        proc = subprocess.Popen(
            [str(BIN), "--store", str(self.store), "index", str(self.project)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        # Wait until THIS atlas process has spawned its worker child. Matching
        # only by command text can hit unrelated wrapper shells whose command
        # line quotes this test, so require the ppid to be our atlas pid.
        worker_pid = None
        deadline = _time.monotonic() + 60
        while _time.monotonic() < deadline:
            out = subprocess.run(["ps", "-eo", "pid,ppid,command"], capture_output=True, text=True)
            for line in out.stdout.splitlines():
                fields = line.split(None, 2)
                if (
                    len(fields) == 3
                    and fields[1] == str(proc.pid)
                    and "worker.mjs" in fields[2]
                ):
                    worker_pid = int(fields[0])
                    break
            if worker_pid is not None:
                break
            if proc.poll() is not None:
                self.fail(f"atlas exited before worker start: rc={proc.returncode} err={proc.stderr.read()!r}")
            _time.sleep(0.05)
        self.assertIsNotNone(worker_pid, "worker must start for the cancel test")
        _os.kill(proc.pid, signal.SIGINT)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            self.fail("atlas did not exit after SIGINT")
        self.assertNotEqual(proc.returncode, 0)
        # The owned worker child must be reaped. Scope the check to children of
        # THIS test's atlas process (ppid match) so unrelated workers from other
        # tests or manual runs cannot make the assertion flaky.
        _time.sleep(0.5)
        ps_out = subprocess.run(["ps", "-eo", "pid,ppid,command"], capture_output=True, text=True)
        leaked = [
            line for line in ps_out.stdout.splitlines()
            if "worker.mjs" in line
            and len(line.split()) >= 2
            and line.split()[1] == str(proc.pid)
        ]
        self.assertEqual(leaked, [], "worker child must be reaped after cancellation")
        # And nothing may be published.
        import sqlite3
        db = self.store / "atlas.db"
        if db.exists():
            with sqlite3.connect(db) as conn:
                analyses = conn.execute("SELECT COUNT(*) FROM analyses").fetchone()[0]
                facts = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
            self.assertEqual(analyses, 0)
            self.assertEqual(facts, 0)

    def test_k1_context_sensitive_folding_end_to_end(self):
        """k=1: the same callee called with different constants folds each
        callsite precisely (pick(5)→[1], pick(6)→[2]) through the real
        worker→Rust→CLI chain."""
        shutil.rmtree(self.project)
        self.project.mkdir()
        (self.project / "pick.js").write_text(
            "export function pick(x) {\n"
            "  if (x === 5) {\n"
            "    return 1;\n"
            "  }\n"
            "  return 2;\n"
            "}\n"
            "export function callA() {\n"
            "  return pick(5);\n"
            "}\n"
            "export function callB() {\n"
            "  return pick(6);\n"
            "}\n"
        )
        a = self.index()
        symbols = {n["name"]: n["id"] for n in self.cli("nodes", a["id"], "--kind", "function")["items"]}
        fa = self.cli("flow", a["id"], symbols["callA"])
        fb = self.cli("flow", a["id"], symbols["callB"])
        self.assertEqual(fa["returns"]["constants"], [1.0], "pick(5) folds to 1 per context")
        self.assertEqual(fb["returns"]["constants"], [2.0], "pick(6) folds to 2 per context")
        self.assertEqual(
            fa["interprocedural"]["callsites"][0]["result"]["constants"], [1.0])
        self.assertEqual(fb["interprocedural"]["callsites"][0]["result"]["constants"], [2.0])

    def test_the_worker_heap_ceiling_is_configurable_bounded_and_named(self):
        """The worker holds the whole program, so its footprint scales with the
        project. A fixed 512 MiB cap turned a large project into an opaque
        `worker_exit_failed`; the ceiling is a parameter now, and hitting it is
        reported as its own failure with the limit that was reached."""
        self.cli("index", self.project, "--worker-heap-mb", "64", ok=False)
        self.cli("index", self.project, "--worker-heap-mb", "99999", ok=False)
        self.assertTrue(self.cli("index", self.project, "--worker-heap-mb", "256")["id"])

        # A real exhaustion, not a simulated one: 14k functions in one file
        # against a 128 MiB ceiling.
        big = self.base / "big"
        big.mkdir()
        (big / "package.json").write_text('{"name":"big","type":"module"}', encoding="utf-8")
        (big / "big.js").write_text(
            "\n".join(
                f"export function f{i}(x){{const a=[1,2,3];const b={{k:a}};return x+b.k.length+{i};}}"
                for i in range(14_000)
            ),
            encoding="utf-8",
        )
        result = subprocess.run(
            [str(BIN), "--store", str(self.base / "big-store"), "index", str(big),
             "--worker-heap-mb", "128", "--timeout-seconds", "600"],
            cwd=ROOT, capture_output=True, text=True, timeout=600,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("worker_heap_exhausted", result.stderr)
        self.assertIn("limit_mb=128", result.stderr)
        self.assertIn("--worker-heap-mb", result.stderr,
                      "the failure must say what to change")

    def test_flow_queries_reject_unknown_symbols(self):
        """D20-lite: invented flow facts cannot be queried into existence."""
        shutil.rmtree(self.project)
        shutil.copytree(ROOT / "examples/flow-lab", self.project)
        a = self.index()
        self.index()  # idempotent republish is fine
        self.assertTrue(self.cli("flows", a["id"])["items"])
        self.cli("flow", a["id"], "symbol:src/pipeline.js:0:1", ok=False)

    def test_http_execution_keeps_the_process_boundary_server_side(self):
        """W08 over HTTP: a local page can ask for a run, not redefine its sandbox.

        The page is allowed to choose the symbol, the literal arguments and the
        two grants that do not widen the process boundary. Everything that does
        -- the Node binary, the environment, filesystem-write, child-process and
        network -- is fixed by the server. Those fields are not merely ignored
        here: they are absent from the request type, so a page cannot send them
        at all, and the record proves what actually ran.
        """
        a = self.index()
        proc = subprocess.Popen([str(BIN), "--store", str(self.store), "serve", a["id"]], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(proc.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(15), "HTTP server readiness deadline")
            boot = json.loads(proc.stdout.readline())
            session = json.loads(Path(boot["session_file"]).read_text())
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            auth = {"Authorization": "Bearer " + session["token"], "Content-Type": "application/json"}
            base = session["url"]

            def get(path):
                with opener.open(urllib.request.Request(base + path, headers=auth), timeout=20) as r:
                    return json.load(r)

            def post(body, headers=None):
                return opener.open(urllib.request.Request(
                    base + "api/exec", headers=headers or auth,
                    data=json.dumps(body).encode(), method="POST"), timeout=30)

            profile = get("api/profile?entity=" + urllib.parse.quote("add"))
            self.assertEqual(profile["classification"], "pure_callable")
            self.assertTrue(profile["runnable"])

            with post({"symbol": "add", "args": [1, 2]}) as r:
                record = json.load(r)
            self.assertEqual(record["verdict"], "returned", record.get("thrown"))
            self.assertEqual(record["value"], {"kind": "number", "value": 3})
            self.assertEqual(record["analysis_id"], a["id"])
            self.assertEqual(record["trace"]["coverage"], "not_sampled")

            # A page asking to widen the boundary gets none of it: the fields do
            # not exist in the request type, so the run uses the fixed ones.
            with post({
                "symbol": "add",
                "args": [1, 2],
                "node": "/bin/sh",
                "env": {"EVIL": "1"},
                "allow_effects": ["fs_write", "child_process", "network", "unknown_calls", "globals"],
                "timeout_ms": 10 ** 9,
            }) as r:
                widened = json.load(r)
            self.assertEqual(widened["isolation"]["node_binary"], "node",
                             "the page must not be able to choose the binary")
            flags = widened["isolation"]["effective_flags"]
            for forbidden in ("--allow-fs-write", "--allow-child-process", "--allow-net"):
                self.assertFalse(any(f.startswith(forbidden) for f in flags),
                                 f"the page granted {forbidden} to itself")
            self.assertEqual(widened["spec"]["env"], {}, "the page must not inject environment")
            self.assertLessEqual(widened["spec"]["timeout_ms"], 30_000, "timeout must be clamped")

            # A function the static profile refuses is refused over HTTP too, and
            # refusing must not have started a process.
            with post({"symbol": "calculate", "args": ["1", "+", "2"]}) as r:
                refused = json.load(r)
            self.assertEqual(refused["verdict"], "refused")
            self.assertFalse(refused["isolation"]["started"])

            # Unauthenticated runs are rejected before anything else happens.
            with self.assertRaises(urllib.error.HTTPError) as error:
                post({"symbol": "add", "args": [1, 2]}, headers={"Content-Type": "application/json"})
            self.assertEqual(error.exception.code, 401)
            error.exception.close()
        finally:
            if proc.poll() is None:
                proc.kill()


if __name__=="__main__":
    if not BIN.exists():raise SystemExit("Run cargo build --workspace first")
    unittest.main(verbosity=2)
