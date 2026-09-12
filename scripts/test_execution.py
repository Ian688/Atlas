#!/usr/bin/env python3
"""W08: controlled execution under a real, enforced boundary.

These tests drive the real binary, the real Node runtime and the real Node
permission model. Nothing here is a mock: when a test asserts that a write was
denied, the file really is absent afterwards, and when it asserts that a call
returned, the value came out of a child process that ran the pinned snapshot
bytes.

The boundary is the point. A runner that reports "denied" because Atlas
*decided* not to run would be an animation; these tests require the denial to
come from the operating system through Node, and they check the side effect did
not happen.

Standard-library only.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"

PACKAGE = '{"name":"exec-lab","version":"1.0.0","type":"module"}\n'

BASIC = """import fs from 'node:fs';

export function add(a, b) { return a + b; }

export function divide(a, b) {
  if (b === 0) { throw new Error('Division by zero'); }
  return a / b;
}

export function spin(limit) {
  let n = 0;
  while (limit > 0) { n = n + 1; }
  return n;
}

export function writeOutside(text) {
  fs.writeFileSync('/tmp/atlas-exec-escape.txt', text);
  return 'wrote';
}

export function writeInside() {
  fs.writeFileSync('inside.txt', 'x');
  return 'wrote';
}

export function readOutside() {
  return fs.readFileSync('/etc/hosts', 'utf8').length;
}

export async function spawnEcho() {
  const { execSync } = await import('node:child_process');
  return execSync('echo hi').toString();
}

export async function fetchLocal() {
  const http = await import('node:http');
  return await new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:1/', () => resolve('connected'));
    request.on('error', error => reject(error));
  });
}

export async function later(value) { return value * 2; }

export function shout(text) {
  console.log('shout', text);
  return text.toUpperCase();
}

export function big() {
  let s = '';
  for (let i = 0; i < 200; i = i + 1) { s = s + '0123456789'; }
  return s;
}

function hidden(x) { return x; }

export function callsHidden(x) { return hidden(x); }

export function self() { return this; }

export function readConfig() { return CONFIG.value; }

export function writeField(target) { target.value = 2; return target.value; }

export const BASE = 10;

export function useModuleConst(x) { return x + BASE; }
"""

# Every function here talks to something outside the parameter list, so the
# static profile requires the same explicit opt-in a human would need. Reading a
# global is *not* a permission -- it is an input the caller must state, so it is
# declared with `--global` rather than granted.
GRANTS = "unknown_calls"

# Nested functions. `increment` captures `value`, which exists only while
# `makeCounter` runs; the other modules cover the two ways a `via` run can be
# honest about not getting the target: the enclosing call returned something
# else entirely, or it returned a different function whose source does not match.
CLOSURES = """export function makeCounter(start) {
  let value = start;
  return function increment(step) {
    value = value + step;
    return value;
  };
}

export function factory(pick) {
  const value = 1;
  function alpha(step) { return value + step; }
  function beta(step) { return value * step; }
  return pick ? alpha : beta;
}

export function maybe(flag) {
  const base = 7;
  if (flag) { return function whenTrue(x) { return base + x; }; }
  return 2;
}

export function outerFactory(start) {
  const base = start;
  return function middle() {
    return function inner(x) { return base + x; };
  };
}

export function outerPair(pick) {
  const base = 20;
  function midA() { return function leafA(x) { return base + x; }; }
  function midB() { return function leafB(x) { return base - x; }; }
  return pick ? midA : midB;
}
"""


# A small module graph for the materialisation cases: `a` imports `b` imports
# `c`, `sibling` is never imported by anything, and `reader` reads a data file
# and imports a module whose specifier is computed at runtime. That is exactly
# the set of things a static closure can and cannot carry.
SLICE_CHAIN = {
    "src/chain/a.js": "import { fromB } from './b.js';\nexport function run(x) { return fromB(x) + 1; }\n",
    "src/chain/b.js": "import { fromC } from './c.js';\nexport function fromB(x) { return fromC(x) * 2; }\n",
    "src/chain/c.js": "export function fromC(x) { return x + 3; }\n",
    "src/chain/sibling.js": "export function never() { return 'never'; }\n",
    "src/chain/data.txt": "unrelated data file\n",
    "src/chain/reader.js": (
        "import fs from 'node:fs';\n"
        "export function readSibling() { return fs.readFileSync('src/chain/data.txt', 'utf8').length; }\n"
        "export async function readDynamic(name) {\n"
        "  const mod = await import('./' + name + '.js');\n"
        "  return Object.keys(mod).length;\n"
        "}\n"
    ),
}


def decode(value):
    """Mirror of the harness' tagged encoding, for readable assertions."""
    if not isinstance(value, dict) or "kind" not in value:
        return value
    kind = value["kind"]
    if kind == "null":
        return None
    if kind in ("number", "string", "boolean", "bigint"):
        return value.get("value")
    if kind == "array":
        return [decode(item) for item in value.get("items", [])]
    if kind == "object":
        return {key: decode(item) for key, item in value.get("entries", {}).items()}
    return {"kind": kind}


class Execution(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-exec-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "package.json").write_text(PACKAGE, encoding="utf-8")
        self.basic = self.project / "src" / "basic.js"
        self.basic.write_text(BASIC, encoding="utf-8")
        # A second module for the closure cases: a nested function is only
        # reachable through the function that actually encloses it.
        self.closures = self.project / "src" / "closures.js"
        self.closures.write_text(CLOSURES, encoding="utf-8")
        (self.project / "src" / "chain").mkdir(parents=True)
        for relative, text in SLICE_CHAIN.items():
            (self.project / relative).write_text(text, encoding="utf-8")
        self.store = self.base / "store"
        self.analysis = self.index()
        self.escape = Path("/tmp/atlas-exec-escape.txt")
        if self.escape.exists():
            self.escape.unlink()
        self.addCleanup(lambda: self.escape.exists() and self.escape.unlink())

    # -- harness ---------------------------------------------------------
    def cli(self, *args, expect=0, timeout=300):
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=timeout,
        )
        self.assertEqual(
            result.returncode, expect,
            f"exit {result.returncode} for {args}\nstdout={result.stdout}\nstderr={result.stderr}",
        )
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def index(self):
        return self.cli("index", self.project)["id"]

    def exec(self, entity, args=None, grants=None, timeout_ms=None, extra=()):
        command = ["exec", self.analysis, entity, "--args", json.dumps(args if args is not None else [])]
        if grants:
            command += ["--allow-effects", grants]
        if timeout_ms is not None:
            command += ["--timeout-ms", str(timeout_ms)]
        command += list(extra)
        return self.cli(*command)

    def profile(self, entity):
        return self.cli("profile", self.analysis, entity)

    def closure(self, entity, args=None, via=None, via_args=None, extra=()):
        """Run a nested function through its enclosing function.

        `via` is a symbol reference. Nothing here fabricates a scope: the
        enclosing function is a real published symbol, and the flags say exactly
        which one and with what arguments.
        """
        command = [
            "exec", self.analysis, entity,
            "--args", json.dumps(args if args is not None else []),
            "--allow-effects", GRANTS,
        ]
        if via is not None:
            command += ["--via", via, "--via-args", json.dumps(via_args if via_args is not None else [])]
        command += list(extra)
        return self.cli(*command)

    def declared_context(self, entity):
        """The flags a caller must supply for this function, from its profile.

        Derived rather than hard-coded so a test that is *about* enforcement
        does not silently stop enforcing when the profile gains a requirement:
        if the profile asks for a global that this cannot supply, the test fails
        instead of running with an undeclared input.
        """
        profile = self.profile(entity)
        extra = []
        if "this_arg" in profile["required_context"]:
            extra += ["--this", "{}"]
        for name in profile["required_globals"]:
            extra += ["--global", f"{name}=null"]
        return extra

    # -- the static half -------------------------------------------------
    def test_a_clean_function_is_profiled_pure_and_the_reasons_cite_evidence(self):
        profile = self.profile("add")
        self.assertEqual(profile["classification"], "pure_callable")
        self.assertTrue(profile["runnable"])
        self.assertEqual(profile["arity"], 2)
        self.assertEqual([param["name"] for param in profile["params"]], ["a", "b"])
        self.assertEqual(profile["reasons"], [], "a clean derivation has nothing to report")

    def test_a_function_that_reads_the_outside_world_is_not_called_pure(self):
        profile = self.profile("writeOutside")
        self.assertNotEqual(profile["classification"], "pure_callable")
        codes = {reason["code"] for reason in profile["reasons"]}
        self.assertTrue(
            codes & {"external_binding", "reads_global", "unknown_call", "may_call"},
            f"the classifier said nothing about external state: {codes}",
        )
        for reason in profile["reasons"]:
            self.assertTrue(reason["evidence"], "every reason must name the fact field it came from")

    def test_a_non_exported_function_is_never_executed(self):
        # `hidden` exists in the snapshot but is not exported, so no module
        # namespace can reach it. The harness matches by source identity, so it
        # refuses instead of guessing at a same-named export.
        record = self.exec("hidden", [1])
        self.assertEqual(record["verdict"], "target_not_exported")
        self.assertNotIn("returned", json.dumps(record["trace"]["events"]))

    def test_a_refusal_starts_no_process(self):
        record = self.exec("writeOutside", ["x"])
        self.assertEqual(record["verdict"], "refused")
        self.assertEqual(record["refusal"]["code"], "missing_requirements")
        self.assertTrue(record["refusal"]["detail"])
        self.assertFalse(record["isolation"]["started"])
        self.assertFalse(self.escape.exists(), "a refused run must not have run anything")
        self.assertEqual(record["duration_ms"], 0)

    def test_the_plan_stage_reports_the_decision_without_running(self):
        plan = self.cli("exec", self.analysis, "writeOutside", "--args", '["x"]', "--plan")
        self.assertFalse(plan["will_start_process"])
        self.assertFalse(plan["decision"]["allowed"])
        self.assertEqual(plan["decision"]["refusal"]["code"], "missing_requirements")
        self.assertFalse(self.escape.exists())

    # -- the executing half ----------------------------------------------
    def test_a_pure_call_returns_the_real_value(self):
        record = self.exec("add", [20, 22])
        self.assertEqual(record["verdict"], "returned")
        self.assertEqual(decode(record["value"]), 42)
        self.assertEqual(record["exit_code"], 0)
        last = record["trace"]["events"][-1]
        self.assertEqual(last["kind"], "returned")
        self.assertEqual(last["export_name"], "add")
        self.assertEqual(last["matched_by"], "source_identity")

    def test_arguments_are_really_used_by_the_called_code(self):
        # A harness that ignored the arguments would still "return" something.
        self.assertEqual(decode(self.exec("add", [1, 2])["value"]), 3)
        self.assertEqual(decode(self.exec("add", ["a", "b"])["value"]), "ab")

    def test_a_throw_is_observed_with_its_source_location(self):
        record = self.exec("divide", [1, 0], grants=GRANTS, extra=self.declared_context("divide"))
        self.assertEqual(record["verdict"], "threw")
        self.assertEqual(record["thrown"]["name"], "Error")
        self.assertEqual(record["thrown"]["message"], "Division by zero")
        location = record["trace"]["events"][-1]["source_location"]
        self.assertIsNotNone(location, "the runtime reported a frame; it must be mapped")
        self.assertEqual(location["path"], "src/basic.js")
        self.assertEqual(location["line"], 6)
        self.assertIn("Division by zero", location["line_text"])
        # The offset is the byte offset into the *pinned* source, so a consumer
        # can point at the same bytes the analysis saw.
        source = self.basic.read_bytes()
        self.assertEqual(source[location["byte_offset"]:location["byte_offset"] + 4], b"  if")

    def test_an_async_function_is_awaited_and_marked_as_awaited(self):
        record = self.exec("later", [21], grants=GRANTS, extra=self.declared_context("later"))
        self.assertEqual(record["verdict"], "returned")
        self.assertEqual(decode(record["value"]), 42)
        self.assertTrue(record["trace"]["events"][-1]["awaited"])

    def test_console_output_is_captured_separately_from_the_result(self):
        record = self.exec("shout", ["hi"], grants=GRANTS, extra=self.declared_context("shout"))
        self.assertEqual(record["verdict"], "returned")
        self.assertEqual(decode(record["value"]), "HI")
        self.assertIn("shout hi", "\n".join(record["console"]["harness_lines"]))

    def test_the_trace_never_claims_more_than_was_observed(self):
        record = self.exec("add", [1, 2])
        trace = record["trace"]
        self.assertEqual(trace["coverage"], "not_sampled")
        self.assertEqual(trace["unknown_paths"], "not_observed")
        self.assertEqual(trace["kind"], "observed-entry-call")
        kinds = [event["kind"] for event in trace["events"]]
        self.assertEqual(kinds, ["call", "returned"],
                         "only the entry call and its outcome were observed")

    # -- enforcement ------------------------------------------------------
    def test_a_file_write_is_denied_by_the_operating_system_not_by_atlas(self):
        record = self.exec("writeOutside", ["x"], grants=GRANTS, extra=self.declared_context("writeOutside"))
        self.assertEqual(record["verdict"], "threw")
        self.assertEqual(record["thrown"]["code"], "ERR_ACCESS_DENIED")
        self.assertFalse(self.escape.exists(), "the write really did not happen")

    def test_reading_outside_the_isolated_copy_is_denied(self):
        record = self.exec("readOutside", grants=GRANTS, extra=self.declared_context("readOutside"))
        self.assertEqual(record["verdict"], "threw")
        self.assertEqual(record["thrown"]["code"], "ERR_ACCESS_DENIED")

    def test_a_granted_write_lands_in_the_copy_and_never_in_the_project(self):
        record = self.exec("writeInside", grants=GRANTS + ",fs_write",
                           extra=self.declared_context("writeInside"))
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(decode(record["value"]), "wrote")
        self.assertFalse((self.project / "src" / "inside.txt").exists(),
                         "the original project must never be written to")
        self.assertFalse((self.project / "inside.txt").exists())
        self.assertTrue(record["isolation"]["files_materialised"] >= 2)

    def test_child_processes_are_denied_without_the_grant(self):
        record = self.exec("spawnEcho", grants=GRANTS, extra=self.declared_context("spawnEcho"))
        self.assertEqual(record["verdict"], "threw")
        self.assertEqual(record["thrown"]["code"], "ERR_ACCESS_DENIED")

    def test_network_is_denied_without_the_grant(self):
        record = self.exec("fetchLocal", grants=GRANTS, extra=self.declared_context("fetchLocal"))
        self.assertEqual(record["verdict"], "threw")
        self.assertEqual(record["thrown"]["code"], "ERR_ACCESS_DENIED")

    def test_the_permission_model_is_probed_rather_than_assumed(self):
        record = self.exec("add", [1, 1])
        probe = record["isolation"]["permission_probe"]
        self.assertTrue(probe["available"])
        self.assertTrue(probe["enforced"], "accepting the flag is not the same as enforcing it")
        self.assertIn("DENIED", probe["probe_stdout"])

    def test_an_exhausted_output_budget_is_not_reported_as_a_harness_error(self):
        # The report itself is what the budget truncates, so the run must say
        # "the budget was exhausted" instead of blaming the harness -- and it
        # must not invent the value it could not read back.
        record = self.exec("big", [], extra=["--output-limit", "512"])
        self.assertEqual(record["verdict"], "output_limit_exceeded", record.get("thrown"))
        self.assertIsNone(record["value"])
        self.assertTrue(record["trace"]["events"][-1]["stdout_truncated"])
        # The same call with a normal budget really does return the value.
        ok = self.exec("big", [])
        self.assertEqual(ok["verdict"], "returned")
        self.assertEqual(len(decode(ok["value"])), 2000)

    def test_a_timeout_kills_the_run_and_is_reported_as_a_timeout(self):
        record = self.exec("spin", [1], timeout_ms=700)
        self.assertEqual(record["verdict"], "timeout")
        self.assertLess(record["duration_ms"], 15_000, "a timeout must not wait for the loop")
        self.assertEqual(record["trace"]["events"][-1]["kind"], "timeout")

    # -- pinning and records ----------------------------------------------
    def test_execution_uses_the_pinned_bytes_after_the_project_changes(self):
        before = self.exec("add", [1, 2])
        self.assertEqual(decode(before["value"]), 3)
        # Change the checkout, not the snapshot. The published analysis is
        # immutable, so a run must still execute the bytes it was pinned to.
        self.basic.write_text(BASIC.replace("return a + b;", "return a - b;"), encoding="utf-8")
        after = self.exec("add", [1, 2])
        self.assertEqual(decode(after["value"]), 3,
                         "the run followed the checkout instead of the pinned snapshot")
        self.assertEqual(after["id"], before["id"], "the same pinned question is the same record")

    def test_the_same_spec_is_the_same_record(self):
        first = self.exec("add", [1, 2])
        second = self.exec("add", [1, 2])
        self.assertEqual(first["id"], second["id"])
        different = self.exec("add", [1, 3])
        self.assertNotEqual(first["id"], different["id"], "a different question is a different record")
        history = self.cli("exec", self.analysis, "add", "--history")
        ids = [record["id"] for record in history["records"]]
        self.assertIn(first["id"], ids)
        self.assertIn(different["id"], ids)

    def test_records_are_immutable_and_readable_back(self):
        record = self.exec("add", [2, 2])
        self.assertEqual(record["schema"], "atlas.execution-record.v1")
        self.assertTrue(record["source_binding"]["bytes_verified"])
        self.assertEqual(record["source_binding"]["analysis_id"], self.analysis)

    def test_a_fixture_run_says_it_used_fixtures(self):
        record = self.exec("add", [1, 2], extra=["--fixtures", "--fixture-note", "hand-built case"])
        self.assertTrue(record["isolation"]["mocks"])
        self.assertEqual(record["isolation"]["fixture_note"], "hand-built case")
        # The default must not claim a mock run was the real environment.
        plain = self.exec("add", [1, 2])
        self.assertFalse(plain["isolation"]["mocks"])

    # -- cancellation -----------------------------------------------------
    def test_sigint_cancels_a_running_call_and_reports_it_as_cancelled(self):
        # W08 acceptance lists cancellation alongside timeout. The difference
        # matters: a timeout is a bound Atlas chose, a cancellation is an
        # operator stopping it, and the record has to say which happened.
        proc = subprocess.Popen(
            [str(BIN), "--store", str(self.store), "exec", self.analysis, "spin",
             "--args", "[1]", "--timeout-ms", "60000"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            time.sleep(1.5)  # let the child start and enter its loop
            self.assertIsNone(proc.poll(), "the run must still be going before the signal")
            proc.send_signal(signal.SIGINT)
            stdout, stderr = proc.communicate(timeout=30)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
        self.assertEqual(proc.returncode, 0, stderr)
        record = json.loads(stdout)
        self.assertEqual(record["verdict"], "cancelled")
        self.assertLess(record["duration_ms"], 20_000, "cancellation must not wait for the loop")
        self.assertEqual(record["trace"]["events"][-1]["kind"], "cancelled")
        # The record is published, not discarded: a cancelled run is a fact too.
        self.cli("exec", self.analysis, "add", "--args", "[1,2]")
        history = self.cli("exec", self.analysis, "spin", "--history")
        self.assertIn(record["id"], [item["id"] for item in history["records"]])

    def test_a_cancelled_scenario_stops_instead_of_marching_through_the_cases(self):
        # Five cases, the first one hangs. After cancellation the remaining
        # cases must be reported as not attempted rather than as five cancelled
        # runs, which would read as "we tried them all".
        path = self.base / "scenario.json"
        path.write_text(json.dumps({
            "schema": "atlas.scenario.v1",
            "name": "cancel-me",
            "cases": [
                {"name": "hangs", "args": [1], "expect": {"returns": 0}},
                {"name": "never-reached", "args": [2], "expect": {"returns": 0}},
                {"name": "never-reached-2", "args": [3], "expect": {"returns": 0}},
            ],
        }), encoding="utf-8")
        proc = subprocess.Popen(
            [str(BIN), "--store", str(self.store), "exec", self.analysis, "spin",
             "--scenario", str(path), "--timeout-ms", "60000"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            time.sleep(1.5)
            self.assertIsNone(proc.poll())
            proc.send_signal(signal.SIGINT)
            stdout, stderr = proc.communicate(timeout=30)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
        self.assertEqual(proc.returncode, 0, stderr)
        result = json.loads(stdout)
        self.assertEqual(result["declared_cases"], 3)
        self.assertEqual(result["stopped"], "cancelled")
        self.assertLess(result["attempted_cases"], result["declared_cases"],
                        "unattempted cases must not be counted as attempted")
        self.assertEqual([case["name"] for case in result["cases"]], ["hangs"])

    # -- effect journal ---------------------------------------------------
    def test_a_denied_attempt_is_journalled_with_its_permission_and_target(self):
        record = self.exec("writeOutside", ["x"], grants=GRANTS,
                           extra=self.declared_context("writeOutside"))
        journal = record["effect_journal"]
        self.assertEqual(journal["schema"], "atlas.effect-journal.v1")
        self.assertEqual(journal["denied_count"], 1)
        entry = journal["entries"][0]
        self.assertEqual(entry["permission"], "FileSystemWrite")
        self.assertIn("atlas-exec-escape.txt", entry["resource"],
                      "the journal must name what the run tried to touch")
        self.assertEqual(entry["outcome"], "denied")

    def test_the_journal_names_the_permission_kind_for_each_blocked_attempt(self):
        child = self.exec("spawnEcho", grants=GRANTS, extra=self.declared_context("spawnEcho"))
        self.assertEqual(child["effect_journal"]["entries"][0]["permission"], "ChildProcess")
        read = self.exec("readOutside", grants=GRANTS, extra=self.declared_context("readOutside"))
        self.assertEqual(read["effect_journal"]["entries"][0]["permission"], "FileSystemRead")
        self.assertIn("/etc/hosts", read["effect_journal"]["entries"][0]["resource"])

    def test_an_allowed_run_does_not_claim_it_had_no_effects(self):
        # Node reports denials, not allowances, so an empty journal means "no
        # denied attempt was reported" -- never "nothing happened". The note and
        # the granted set are what keep that distinction visible.
        record = self.exec("add", [1, 2])
        journal = record["effect_journal"]
        self.assertEqual(journal["denied_count"], 0)
        self.assertEqual(journal["observed"], 0)
        self.assertIn("不声称", journal["note"])
        self.assertFalse(journal["granted"]["fs_write"])
        granted = self.exec("writeInside", grants=GRANTS + ",fs_write",
                            extra=self.declared_context("writeInside"))
        self.assertTrue(granted["effect_journal"]["granted"]["fs_write"],
                        "the bound must be recorded alongside the attempts")

    # -- declared context -------------------------------------------------
    def test_a_receiver_is_declared_by_the_caller_and_recorded_as_declared(self):
        profile = self.profile("self")
        self.assertEqual(profile["classification"], "needs_context")
        self.assertEqual(profile["required_context"], ["this_arg"])
        # Without a declaration the run is refused before any process exists.
        refused = self.exec("self")
        self.assertEqual(refused["verdict"], "refused")
        self.assertEqual(refused["refusal"]["missing_context"], ["this_arg"])
        self.assertFalse(refused["isolation"]["started"])
        # With one, it runs -- and the record says the receiver was declared,
        # because the observation is only as good as the declaration.
        record = self.exec("self", extra=["--this", '{"base":7}'])
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(decode(record["value"]), {"base": 7})
        self.assertTrue(record["isolation"]["declared_context"]["this_arg"])
        self.assertTrue(record["trace"]["events"][-1]["receiver_declared"])

    def test_a_true_global_is_named_so_the_caller_knows_what_to_declare(self):
        # `CONFIG` is read as a bare identifier. The `read_external` op names it,
        # so the refusal can say exactly which value is missing instead of
        # asking the caller to guess.
        profile = self.profile("readConfig")
        self.assertEqual(profile["required_globals"], ["CONFIG"])
        self.assertIn("globals", profile["required_context"])
        refused = self.exec("readConfig", grants=GRANTS)
        self.assertEqual(refused["verdict"], "refused")
        self.assertEqual(refused["refusal"]["missing_context"], ["global:CONFIG"])
        declared = self.exec("readConfig", grants=GRANTS,
                             extra=["--global", 'CONFIG={"value":"declared"}'])
        self.assertEqual(declared["verdict"], "returned", declared.get("thrown"))
        self.assertEqual(decode(declared["value"]), "declared")
        self.assertEqual(declared["isolation"]["declared_context"]["globals"], ["CONFIG"])
        self.assertEqual(declared["trace"]["events"][-1]["declared_globals"], ["CONFIG"])

    def test_a_runtime_builtin_is_never_asked_for_as_an_input(self):
        # `divide` throws `new Error(...)`. The engine used to report `Error` as
        # a global to declare, and declaring it as JSON replaced the real
        # constructor -- the run then failed with a TypeError that had nothing to
        # do with the function. Built-ins belong to the runtime, not the caller.
        profile = self.profile("divide")
        self.assertEqual(profile["required_globals"], [])
        self.assertNotIn("globals", profile["required_context"])
        record = self.exec("divide", [1, 0], grants=GRANTS)
        self.assertEqual(record["verdict"], "threw")
        self.assertEqual(record["thrown"]["name"], "Error",
                         "the real constructor must still be the real one")

    def test_an_imported_binding_is_not_a_global_to_declare(self):
        # `fs`, `helper` and friends are module state: the copied module already
        # has them. Asking the caller to declare one would be asking for a value
        # that is already there, and would hide the real global behind it.
        for entity in ["writeOutside", "readOutside", "spawnEcho", "fetchLocal",
                       "shout", "useModuleConst"]:
            profile = self.profile(entity)
            self.assertEqual(profile["required_globals"], [],
                             f"{entity}: an import must not be reported as a global")
        # These read only their own import (or their own module state), so the
        # global-access effect must not fire either. (`spawnEcho`/`fetchLocal`
        # use a dynamic import whose local binding Atlas cannot resolve, and
        # `shout` reads the runtime's `console` -- both are genuinely unresolved
        # or global reads, so they are deliberately not in this list.)
        for entity in ["writeOutside", "readOutside", "useModuleConst"]:
            self.assertFalse(self.profile(entity)["effects"]["may_access_global"],
                             f"{entity}: reading its own import is not a global access")

    def test_an_unknown_effect_grant_name_is_rejected(self):
        # The old `globals` grant must fail loudly rather than be ignored, or a
        # caller would believe they had supplied something they had not.
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), "exec", self.analysis, "readConfig",
             "--args", "[]", "--allow-effects", "unknown_calls,globals"],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown_effect_grant", result.stderr)

    def test_module_level_state_is_present_rather_than_declared(self):
        # `BASE` is module state. It lives in the copied module, so the run needs
        # the acknowledgement for the unmodelled facts but no declaration of the
        # value itself.
        # Module-level state is inside the copied module, so it needs no
        # declaration -- only the acknowledgement that module state is not a
        # parameter.
        record = self.exec("useModuleConst", [5], grants=GRANTS)
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(decode(record["value"]), 15)

    def test_missing_facts_need_an_acknowledgement_not_a_declaration(self):
        profile = self.profile("writeField")
        self.assertIn("unknown_calls", profile["required_grants"])
        self.assertEqual(profile["required_context"], [],
                         "an object argument is supplied as an argument, not as context")
        refused = self.exec("writeField", [{}])
        self.assertEqual(refused["refusal"]["code"], "missing_requirements")
        self.assertEqual(refused["refusal"]["missing_grants"], ["unknown_calls"])
        record = self.exec("writeField", [{"value": 0}], grants=GRANTS,
                           extra=self.declared_context("writeField"))
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(decode(record["value"]), 2)

    # -- nested functions -------------------------------------------------
    def test_a_nested_closure_cannot_be_run_directly_and_says_how_it_can(self):
        profile = self.profile("src/closures.js:increment")
        self.assertEqual(profile["classification"], "needs_context")
        self.assertFalse(profile["runnable"])
        self.assertEqual(profile["unsatisfiable_context"], ["captures"])
        self.assertEqual(profile["captures"], ["value"],
                         "the captured binding must be named, not just counted")
        enclosing = profile["enclosing_symbol"]
        self.assertTrue(enclosing and enclosing.startswith("symbol:src/closures.js:"), enclosing)

        refused = self.exec("src/closures.js:increment", [1], grants=GRANTS)
        self.assertEqual(refused["verdict"], "refused")
        self.assertEqual(refused["refusal"]["code"], "context_required")
        self.assertIn("value", refused["refusal"]["detail"])
        self.assertIn(enclosing, refused["refusal"]["detail"],
                      "the refusal must name the function that can produce the instance")
        self.assertFalse(refused["isolation"]["started"],
                         "no process may start for a context Atlas cannot declare")

    def test_a_closure_runs_through_the_function_that_encloses_it(self):
        profile = self.profile("src/closures.js:increment")
        record = self.closure("src/closures.js:increment", [5],
                              via=profile["enclosing_symbol"], via_args=[100])
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(decode(record["value"]), 105,
                         "the closure must see the scope the enclosing call really created")

        stage = record["via"]["stage_report"]
        self.assertEqual(stage["stage"], "enclosing")
        self.assertEqual(stage["export_name"], "makeCounter")
        self.assertEqual(stage["closure"]["name"], "increment")
        self.assertEqual(stage["closure"]["matched_by"], "source_identity",
                         "the returned function must be accepted by source, not by name")
        # Both stages are in the record, in order, and each says which call it
        # was: a reader must never have to infer where the instance came from.
        stages = [event.get("stage") for event in record["trace"]["events"] if event["kind"] == "call"]
        self.assertEqual(stages, ["enclosing", "target"])
        self.assertTrue(record["via"]["source_binding"]["bytes_verified"])
        self.assertEqual(record["via"]["source_binding"]["path"], record["source_binding"]["path"])
        self.assertNotEqual(record["via"]["source_binding"]["start"],
                            record["source_binding"]["start"],
                            "the enclosing function is a different slice of the same file")

    def test_a_via_symbol_that_is_not_the_enclosing_function_is_refused(self):
        foreign = self.profile("factory")["symbol"]
        refused = self.exec("src/closures.js:increment", [1], grants=GRANTS,
                            extra=["--via", foreign])
        self.assertEqual(refused["verdict"], "refused")
        self.assertEqual(refused["refusal"]["code"], "via_not_the_enclosing_symbol")
        self.assertFalse(refused["isolation"]["started"])

    def test_an_enclosing_call_that_returns_a_different_function_is_not_a_target_call(self):
        # `factory(true)` returns `alpha`; the pinned target is `beta`. Both are
        # real functions with similar shapes, so accepting the value by name or
        # position would silently run the wrong one.
        beta = "src/closures.js:beta"
        profile = self.profile(beta)
        mismatch = self.closure(beta, [3], via=profile["enclosing_symbol"], via_args=[True])
        self.assertEqual(mismatch["verdict"], "closure_identity_mismatch")
        self.assertIsNone(mismatch["value"], "no target call happened, so there is no target value")
        stage = mismatch["via"]["stage_report"]
        self.assertEqual(stage["value"]["kind"], "function")
        self.assertIsNone(stage["closure"]["matched_by"])
        self.assertIn("alpha", stage["closure"]["observed_source"],
                      "the observed source must be shown so the mismatch is checkable")
        # The same run with the pick that does return the target works, so the
        # refusal is about identity and not about the closure being unrunnable.
        matching = self.closure(beta, [3], via=profile["enclosing_symbol"], via_args=[False])
        self.assertEqual(matching["verdict"], "returned", matching.get("thrown"))
        self.assertEqual(decode(matching["value"]), 3)

    def test_an_enclosing_call_that_returns_a_non_function_is_recorded_as_such(self):
        target = "src/closures.js:whenTrue"
        via = self.profile(target)["enclosing_symbol"]
        not_returned = self.closure(target, [1], via=via, via_args=[False])
        self.assertEqual(not_returned["verdict"], "closure_not_returned")
        self.assertEqual(decode(not_returned["via"]["stage_report"]["value"]), 2,
                         "what the enclosing call really returned must be kept")
        self.assertTrue(not_returned["isolation"]["started"],
                        "the enclosing call did run, so a process did exist")
        ran = self.closure(target, [7], via=via, via_args=[True])
        self.assertEqual(ran["verdict"], "returned", ran.get("thrown"))
        self.assertEqual(decode(ran["value"]), 14)

    def test_a_chain_deeper_than_one_level_is_refused_by_name(self):
        profile = self.profile("src/closures.js:inner")
        refused = self.closure("src/closures.js:inner", [3], via="src/closures.js:middle")
        self.assertEqual(refused["verdict"], "refused")
        self.assertEqual(refused["refusal"]["code"], "closure_depth_not_supported")
        self.assertIn("middle", refused["refusal"]["detail"])
        self.assertIn("outerFactory", refused["refusal"]["detail"],
                      "the refusal must name the function that could produce the missing level")
        self.assertNotEqual(profile["enclosing_symbol"], None)
        # One level is real: `outerFactory()` returns `middle`, and the run says
        # so instead of pretending the returned function was called.
        middle = self.closure("src/closures.js:middle", [],
                              via=self.profile("src/closures.js:middle")["enclosing_symbol"],
                              via_args=[4])
        self.assertEqual(middle["verdict"], "returned", middle.get("thrown"))
        self.assertEqual(middle["value"], {"kind": "function", "name": "inner"},
                         "the value is the function `middle` returned, reported as a value")

    def test_a_chain_deeper_than_one_level_runs_when_the_ancestors_are_named(self):
        # inner < middle < outerFactory: three levels. The value proves the scope
        # came from the outermost call (base=4), so this is not just "some
        # function was called".
        record = self.cli(
            "exec", self.analysis, "src/closures.js:inner", "--args", "[3]",
            "--allow-effects", GRANTS,
            "--via", "src/closures.js:middle",
            "--via-chain", json.dumps([{"symbol": "src/closures.js:outerFactory", "args": [4]}]),
        )
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(decode(record["value"]), 7, "outerFactory(4) -> base 4, inner(3) = 7")
        via = record["via"]
        self.assertEqual(via["chain_length"], 2)
        self.assertEqual(len(via["chain"]), 2)
        self.assertEqual(via["name"], "middle", "the top-level fields still describe the nearest enclosing function")
        self.assertEqual([ancestor["name"] for ancestor in via["ancestors"]], ["outerFactory"])
        self.assertEqual([stage["name"] for stage in via["stage_report"]["stages"]], ["middle", "inner"],
                         "each stage names the symbol it must produce")
        for stage in via["stage_report"]["stages"]:
            self.assertEqual(stage["closure"]["matched_by"], "source_identity",
                             f"stage {stage['index']} was not verified by source")
        self.assertIsNone(via["stage_report"]["failed_stage"])
        # Every link is bound to its own re-hashed bytes, not just the last one.
        for stage in [via] + via["ancestors"]:
            self.assertTrue(stage["source_binding"]["bytes_verified"])
        stages = [event.get("stage_index") for event in record["trace"]["events"] if event["kind"] == "call"]
        self.assertEqual(stages, [0, 1, None], "one call event per ancestor, then the target")

    def test_a_chain_that_returns_the_wrong_function_fails_at_that_stage(self):
        # outerPair(false) returns midB; the chain asks for midA. Accepting it by
        # name or position would run a different closure from a nearby scope.
        target = "src/closures.js:leafA"
        profile = self.profile(target)
        self.assertEqual(profile["enclosing_symbol"], self.profile("src/closures.js:midA")["symbol"])
        mismatch = self.cli(
            "exec", self.analysis, target, "--args", "[1]", "--allow-effects", GRANTS,
            "--via", "src/closures.js:midA",
            "--via-chain", json.dumps([{"symbol": "src/closures.js:outerPair", "args": [False]}]),
        )
        self.assertEqual(mismatch["verdict"], "closure_identity_mismatch")
        self.assertIsNone(mismatch["value"], "the target was never called, so there is no target value")
        stage_report = mismatch["via"]["stage_report"]
        self.assertEqual(stage_report["stage_count"], 2)
        self.assertEqual(stage_report["failed_stage"], 0)
        self.assertIsNone(stage_report["stages"][0]["closure"]["matched_by"])
        self.assertIn("midB", stage_report["stages"][0]["closure"]["observed_source"])
        # The same chain with the pick that really does produce midA runs, so the
        # refusal is about identity and not about the chain being unrunnable.
        matching = self.cli(
            "exec", self.analysis, target, "--args", "[1]", "--allow-effects", GRANTS,
            "--via", "src/closures.js:midA",
            "--via-chain", json.dumps([{"symbol": "src/closures.js:outerPair", "args": [True]}]),
        )
        self.assertEqual(matching["verdict"], "returned", matching.get("thrown"))
        self.assertEqual(decode(matching["value"]), 21, "base 20 + 1")

    def test_a_chain_that_is_not_a_containment_path_is_rejected(self):
        # makeCounter is top-level, but it does not enclose middle, so the chain
        # is not a path in the containment graph. This is a malformed request,
        # not a decision about the analysis, so the command fails.
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), "exec", self.analysis,
             "src/closures.js:inner", "--args", "[1]", "--allow-effects", GRANTS,
             "--via", "src/closures.js:middle",
             "--via-chain", json.dumps([{"symbol": "src/closures.js:makeCounter", "args": [1]}])],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("via_chain_not_connected", result.stderr)

    def test_ancestors_without_the_enclosing_function_are_rejected(self):
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), "exec", self.analysis,
             "src/closures.js:inner", "--args", "[1]", "--allow-effects", GRANTS,
             "--via-chain", json.dumps([{"symbol": "src/closures.js:outerFactory", "args": [1]}])],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("via_chain_without_via", result.stderr)

    def test_the_plan_for_a_via_run_names_both_stages(self):
        plan = self.cli("exec", self.analysis, "src/closures.js:increment",
                        "--args", "[1]", "--plan", "--allow-effects", GRANTS,
                        "--via", self.profile("src/closures.js:increment")["enclosing_symbol"])
        self.assertTrue(plan["decision"]["allowed"])
        self.assertTrue(plan["via"]["decision"]["allowed"])
        self.assertEqual(plan["via"]["name"], "makeCounter")
        self.assertTrue(plan["will_start_process"])
        # A wrong enclosing symbol is refused at plan time, before any process.
        bad = self.cli("exec", self.analysis, "src/closures.js:increment",
                       "--args", "[1]", "--plan", "--allow-effects", GRANTS,
                       "--via", self.profile("factory")["symbol"])
        self.assertFalse(bad["decision"]["allowed"])
        self.assertEqual(bad["decision"]["refusal"]["code"], "via_not_the_enclosing_symbol")
        self.assertFalse(bad["will_start_process"])

    # -- what the isolated copy is made of ---------------------------------
    def test_a_dependency_slice_carries_the_transitive_import_closure(self):
        record = self.exec("src/chain/a.js:run", [4], grants=GRANTS,
                           extra=["--materialise", "dependencies"])
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(decode(record["value"]), 15, "c(4)=7, b=14, a=15")
        materialisation = record["isolation"]["materialisation"]
        self.assertEqual(materialisation["mode"], "dependencies")
        written = set(materialisation["written"])
        self.assertEqual(written, {"package.json", "src/chain/a.js", "src/chain/b.js", "src/chain/c.js"},
                         "the closure is transitive, and nothing else comes along")
        self.assertEqual(materialisation["closure"]["reached"], 3)
        self.assertEqual(materialisation["closure"]["seed"], "src/chain/a.js")
        # A bare specifier (`node:fs` elsewhere in the project) is not this
        # run's problem; a *relative* import Atlas could not map would be.
        self.assertEqual(materialisation["closure"]["unresolved_relative"], [])
        self.assertFalse(materialisation["closure"]["bounded"])
        self.assertLess(materialisation["files_written"], materialisation["files_in_snapshot"])
        self.assertEqual(record["isolation"]["files_materialised"], materialisation["files_written"])

    def test_the_default_copy_is_still_the_whole_snapshot(self):
        record = self.exec("src/chain/a.js:run", [4], grants=GRANTS)
        materialisation = record["isolation"]["materialisation"]
        self.assertEqual(materialisation["mode"], "snapshot", "the default must not narrow anything")
        self.assertEqual(materialisation["files_written"], materialisation["files_in_snapshot"])
        written = set(materialisation["written"])
        self.assertIn("src/chain/sibling.js", written, "a snapshot copy keeps files the target never imports")
        self.assertIn("src/chain/data.txt", written)
        self.assertEqual(materialisation["known_risk"], [])

    def test_a_slice_narrows_the_read_boundary_and_the_record_says_how_to_recheck(self):
        # The point of a slice: a file the target never imports but reads at
        # runtime is no longer in the copy. The run fails honestly, and the
        # record names the risk and the way to re-check.
        sliced = self.exec("src/chain/reader.js:readSibling", [], grants=GRANTS,
                           extra=["--materialise", "dependencies"])
        self.assertEqual(sliced["verdict"], "threw")
        self.assertEqual(sliced["thrown"]["name"], "Error")
        self.assertIn("ENOENT", sliced["thrown"]["message"])
        self.assertEqual(set(sliced["isolation"]["materialisation"]["written"]),
                         {"package.json", "src/chain/reader.js"})
        self.assertTrue(sliced["isolation"]["materialisation"]["known_risk"],
                        "a slice must state what it cannot carry")
        self.assertIn("--materialise snapshot", sliced["isolation"]["materialisation"]["fallback"])
        # The same call against the whole snapshot succeeds, so the difference is
        # the copy's extent and not the function.
        whole = self.exec("src/chain/reader.js:readSibling", [], grants=GRANTS,
                          extra=["--materialise", "snapshot"])
        self.assertEqual(whole["verdict"], "returned", whole.get("thrown"))
        self.assertEqual(decode(whole["value"]), len("unrelated data file\n"))

    def test_a_computed_dynamic_import_is_a_named_risk_not_a_silent_success(self):
        # A specifier computed at runtime is not in the static graph, so the
        # module it names cannot be in the closure. The limitation is declared in
        # advance, and the run fails loudly rather than returning something else.
        sliced = self.exec("src/chain/reader.js:readDynamic", ["c"], grants=GRANTS,
                           extra=["--materialise", "dependencies"])
        self.assertEqual(sliced["verdict"], "threw")
        self.assertIn("Cannot find module", sliced["thrown"]["message"])
        risks = " ".join(sliced["isolation"]["materialisation"]["known_risk"])
        self.assertIn("动态 import", risks, "the dynamic-import risk must be declared in the record")
        whole = self.exec("src/chain/reader.js:readDynamic", ["c"], grants=GRANTS,
                          extra=["--materialise", "snapshot"])
        self.assertEqual(whole["verdict"], "returned", whole.get("thrown"))
        self.assertEqual(decode(whole["value"]), 1)

    def test_an_unknown_materialise_mode_is_rejected(self):
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), "exec", self.analysis, "add",
             "--args", "[1,2]", "--materialise", "everything"],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid_materialise_mode", result.stderr)

    # -- scenarios --------------------------------------------------------
    def scenario(self, cases):
        path = self.base / "scenario.json"
        path.write_text(json.dumps({
            "schema": "atlas.scenario.v1",
            "name": "basic",
            "cases": cases,
        }), encoding="utf-8")
        return self.cli("exec", self.analysis, "add", "--scenario", path)

    def test_a_scenario_reports_passes_and_failures_separately(self):
        result = self.scenario([
            {"name": "adds", "args": [1, 2], "expect": {"returns": 3}},
            {"name": "wrong", "args": [1, 2], "expect": {"returns": 4}},
        ])
        self.assertEqual(result["passed"], 1)
        self.assertEqual(result["failed"], 1)
        by_name = {case["name"]: case for case in result["cases"]}
        self.assertEqual(by_name["adds"]["outcome"], "passed")
        self.assertEqual(by_name["wrong"]["outcome"], "failed")
        self.assertTrue(by_name["wrong"]["failures"])

    def test_a_scenario_matches_thrown_errors(self):
        path = self.base / "scenario.json"
        path.write_text(json.dumps({
            "schema": "atlas.scenario.v1",
            "name": "throws",
            "cases": [
                {"name": "divide by zero", "args": [1, 0],
                 "expect": {"throws": {"name": "Error", "message_contains": "Division"}}},
            ],
        }), encoding="utf-8")
        result = self.cli("exec", self.analysis, "divide", "--scenario", path,
                          "--allow-effects", GRANTS)
        self.assertEqual(result["passed"], 1, result["cases"])

    def test_a_scenario_result_is_published_and_readable_back(self):
        # A scenario is evidence. It used to exist only on stdout, so a consumer
        # had to capture a stream to ask what a scenario did last time.
        first = self.scenario([
            {"name": "adds", "args": [1, 2], "expect": {"returns": 3}},
            {"name": "wrong", "args": [1, 2], "expect": {"returns": 4}},
        ])
        self.assertTrue(first["id"], "the scenario result must be published with an id")
        history = self.cli("exec", self.analysis, "add", "--scenario-history")["scenarios"]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["id"], first["id"])
        self.assertEqual(history[0]["passed"], 1)
        self.assertEqual(history[0]["failed"], 1)
        self.assertEqual(history[0]["declared_cases"], 2)
        # The same scenario over the same pinned analysis is the same record.
        again = self.scenario([
            {"name": "adds", "args": [1, 2], "expect": {"returns": 3}},
            {"name": "wrong", "args": [1, 2], "expect": {"returns": 4}},
        ])
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(len(self.cli("exec", self.analysis, "add", "--scenario-history")["scenarios"]), 1)

    def test_a_scenario_case_that_is_refused_is_not_a_pass(self):
        path = self.base / "scenario.json"
        path.write_text(json.dumps({
            "schema": "atlas.scenario.v1",
            "name": "refused",
            "cases": [{"name": "outside", "args": ["x"], "expect": {"returns": "wrote"}}],
        }), encoding="utf-8")
        result = self.cli("exec", self.analysis, "writeOutside", "--scenario", path)
        self.assertEqual(result["passed"], 0)
        self.assertEqual(result["refused"], 1)
        self.assertEqual(result["failed"], 0, "a refusal is not a failed assertion")
        self.assertFalse(self.escape.exists())

    def test_an_invalid_scenario_is_rejected(self):
        path = self.base / "scenario.json"
        path.write_text(json.dumps({"name": "no schema", "cases": []}), encoding="utf-8")
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), "exec", self.analysis, "add", "--scenario", str(path)],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid_scenario_schema", result.stderr)


class HttpClosure(unittest.TestCase):
    """A closure run over the local HTTP boundary.

    The page can offer "run this through the function that encloses it", so the
    server has to resolve that symbol in this analysis and carry the two stages
    through the same decision the CLI uses. Only the closure module is indexed
    here: a run that needs nothing else should not depend on anything else.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-exec-http-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "package.json").write_text(PACKAGE, encoding="utf-8")
        (self.project / "src" / "closures.js").write_text(CLOSURES, encoding="utf-8")
        self.store = self.base / "store"
        indexed = subprocess.run(
            [str(BIN), "--store", str(self.store), "index", str(self.project)],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
        self.assertEqual(indexed.returncode, 0, indexed.stderr)
        self.analysis = json.loads(indexed.stdout)["id"]
        self.proc = subprocess.Popen(
            [str(BIN), "--store", str(self.store), "serve", self.analysis],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.addCleanup(self.stop)
        with selectors.DefaultSelector() as ready:
            ready.register(self.proc.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(15), "HTTP server readiness deadline")
        boot = json.loads(self.proc.stdout.readline())
        session = json.loads(Path(boot["session_file"]).read_text())
        self.base_url = session["url"]
        self.auth = {
            "Authorization": "Bearer " + session["token"],
            "Content-Type": "application/json",
        }
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)

    def post(self, path, body, headers=None):
        return self.opener.open(urllib.request.Request(
            self.base_url + path, headers=headers or self.auth,
            data=json.dumps(body).encode(), method="POST"), timeout=60)

    def test_a_closure_runs_over_http_through_its_enclosing_function(self):
        record = json.load(self.post("api/exec", {
            "symbol": "src/closures.js:increment",
            "args": [5],
            "allow_effects": ["unknown_calls"],
            "via": {"symbol": "makeCounter", "args": [100]},
        }))
        self.assertEqual(record["verdict"], "returned", record.get("thrown"))
        self.assertEqual(record["value"], {"kind": "number", "value": 105})
        self.assertEqual(record["via"]["stage_report"]["closure"]["matched_by"], "source_identity")
        self.assertTrue(record["via"]["source_binding"]["bytes_verified"])

    def test_an_http_via_that_is_not_the_enclosing_function_is_refused(self):
        record = json.load(self.post("api/exec", {
            "symbol": "src/closures.js:increment",
            "args": [5],
            "allow_effects": ["unknown_calls"],
            "via": {"symbol": "factory", "args": [True]},
        }))
        self.assertEqual(record["verdict"], "refused")
        self.assertEqual(record["refusal"]["code"], "via_not_the_enclosing_symbol")
        self.assertFalse(record["isolation"]["started"])

    def test_an_http_via_run_without_the_acknowledgement_is_refused_not_run(self):
        record = json.load(self.post("api/exec", {
            "symbol": "src/closures.js:increment",
            "args": [5],
            "via": {"symbol": "makeCounter", "args": [100]},
        }))
        self.assertEqual(record["verdict"], "refused")
        self.assertEqual(record["refusal"]["code"], "missing_requirements")
        self.assertFalse(record["isolation"]["started"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
