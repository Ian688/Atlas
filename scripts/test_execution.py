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
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

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

    def test_an_unnamed_global_read_needs_acknowledgement_not_a_fake_declaration(self):
        # `CONFIG` is read as a bare identifier, and the published facts carry
        # no name for it. Atlas therefore does not demand a declaration it
        # cannot name; it asks for the acknowledgement and lets the run produce
        # a real answer -- which is a ReferenceError until the caller states the
        # value. Both halves are asserted, because "we ran it" is only useful if
        # what happened is reported.
        profile = self.profile("readConfig")
        self.assertIn("unknown_calls", profile["required_grants"])
        self.assertEqual(profile["required_globals"], [],
                         "an unnamed external must not invent a name")
        undeclared = self.exec("readConfig", grants=GRANTS)
        self.assertEqual(undeclared["verdict"], "threw")
        self.assertEqual(undeclared["thrown"]["name"], "ReferenceError",
                         "the honest answer is the real error, not a fabricated value")
        declared = self.exec("readConfig", grants=GRANTS,
                             extra=["--global", 'CONFIG={"value":"declared"}'])
        self.assertEqual(declared["verdict"], "returned", declared.get("thrown"))
        self.assertEqual(decode(declared["value"]), "declared")
        self.assertEqual(declared["isolation"]["declared_context"]["globals"], ["CONFIG"])
        self.assertEqual(declared["trace"]["events"][-1]["declared_globals"], ["CONFIG"])

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
