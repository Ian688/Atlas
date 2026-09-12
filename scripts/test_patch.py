#!/usr/bin/env python3
"""W09 continuation: the AI Coding chain, end to end.

The chain is propose -> verify -> apply/revert, and the parts worth testing are
the refusals, because every one of them protects something a reader would
otherwise believe:

* a diff that does not match the pinned bytes is refused with the line that
  disagreed (no fuzzy apply that could relocate a change into a similar-looking
  function);
* verification re-indexes an *isolated copy*, and the user's checkout is
  untouched by it;
* "no test was run" is never reported as a pass;
* apply refuses if the target's bytes moved since the proposal was verified, and
  revert refuses if the target moved since apply -- overwriting work that
  happened after review is a loss, not a merge.

Standard-library only.
"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"

MATH = (
    "export function add(left, right) { return left + right; }\n"
    "export function subtract(left, right) { return left - right; }\n"
)


class PatchChain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-patch-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "package.json").write_text('{"name":"patch-lab","type":"module"}\n', encoding="utf-8")
        self.math = self.project / "src" / "math.js"
        self.math.write_text(MATH, encoding="utf-8")
        self.store = self.base / "store"
        self.analysis = self.cli("index", self.project)["id"]

    # -- helpers ----------------------------------------------------------
    def cli(self, *args, ok=True):
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def diff_file(self, name, text):
        path = self.base / name
        path.write_text(text, encoding="utf-8")
        return path

    def edit_diff(self, replacement="export function add(left, right) { return left + right + 0; }"):
        return self.diff_file("edit.patch", (
            "--- a/src/math.js\n"
            "+++ b/src/math.js\n"
            "@@ -1,1 +1,1 @@\n"
            "-export function add(left, right) { return left + right; }\n"
            f"+{replacement}\n"
        ))

    def propose(self, diff=None, entity="add", ok=True):
        return self.cli("patch", "propose", self.analysis, entity,
                        "--diff", diff or self.edit_diff(), "--summary", "bench", ok=ok)

    # -- propose ----------------------------------------------------------
    def test_a_proposal_is_intent_and_validated_against_pinned_bytes(self):
        result = self.propose()
        self.assertEqual(result["outcome"], "proposed")
        proposal = result["proposal"]
        self.assertEqual(proposal["state"], "proposed")
        body = proposal["proposal"]
        self.assertTrue(body["intent"])
        self.assertFalse(body["code_exists"], "a proposal is not code that exists")
        self.assertTrue(body["validation"]["ok"])
        self.assertEqual(body["validation"]["hunks"], 1)
        self.assertEqual(body["validation"]["patched_paths"], ["src/math.js"])
        # Nothing was written anywhere.
        self.assertEqual(self.math.read_text(encoding="utf-8"), MATH)

    def test_the_same_proposal_twice_is_one_record(self):
        first = self.propose()
        again = self.propose()
        self.assertEqual(again["outcome"], "already_proposed")
        self.assertEqual(again["proposal"]["id"], first["proposal"]["id"])
        self.assertEqual(len(self.cli("patch", "list", self.analysis)["proposals"]), 1)

    def test_a_diff_that_does_not_match_the_snapshot_is_rejected_with_the_line(self):
        diff = self.diff_file("bad.patch", (
            "--- a/src/math.js\n"
            "+++ b/src/math.js\n"
            "@@ -2,1 +2,1 @@\n"
            "-export function subtract(left, right) { return left * right; }\n"
            "+export function subtract(left, right) { return left - right - 0; }\n"
        ))
        result = self.propose(diff, ok=False)
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(result["proposal"]["state"], "rejected")
        reason = result["proposal"]["terminal_reason"]
        self.assertIn("patch_does_not_apply", reason)
        self.assertIn("left * right", reason, "the line that disagreed must be quoted")
        # A rejected proposal cannot be verified.
        self.cli("patch", "verify", result["proposal"]["id"], ok=False)

    def test_a_diff_for_a_file_outside_the_snapshot_is_rejected(self):
        diff = self.diff_file("outside.patch", (
            "--- a/src/other.js\n+++ b/src/other.js\n@@ -1,1 +1,1 @@\n-a\n+b\n"
        ))
        result = self.propose(diff, ok=False)
        self.assertEqual(result["proposal"]["state"], "rejected")
        self.assertIn("patch_target_not_in_snapshot", result["proposal"]["terminal_reason"])

    def test_a_crlf_target_is_refused_rather_than_normalised(self):
        (self.project / "src" / "crlf.js").write_bytes(b"export const a = 1;\r\n")
        analysis = self.cli("index", self.project)["id"]
        diff = self.diff_file("crlf.patch", (
            "--- a/src/crlf.js\n+++ b/src/crlf.js\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n"
        ))
        result = self.cli("patch", "propose", analysis, "crlf.js", "--diff", diff, ok=False)
        self.assertIn("CRLF", result["proposal"]["terminal_reason"])

    # -- verify -----------------------------------------------------------
    def test_verification_reindexes_an_isolated_copy_and_leaves_the_checkout_alone(self):
        proposal = self.propose()["proposal"]
        verified = self.cli("patch", "verify", proposal["id"])
        self.assertEqual(verified["state"], "verified")
        verification = verified["verification"]
        self.assertNotEqual(verification["patched_analysis_id"], self.analysis,
                            "the patched tree must be its own analysis")
        self.assertEqual(verification["base_analysis_id"], self.analysis)
        self.assertFalse(verification["isolation"]["user_checkout_touched"])
        self.assertEqual(self.math.read_text(encoding="utf-8"), MATH,
                         "verification must not touch the user's checkout")
        diff = verification["graph_diff"]
        changed = {(entry["path"], entry["name"]) for entry in diff["nodes"]["changed"]}
        self.assertIn(("src/math.js", "add"), changed, "the edited function must show as changed")
        self.assertEqual(diff["nodes"]["removed_count"], 0,
                         "an edit must not read as a removal plus an addition")
        self.assertEqual(diff["counts"]["functions"]["before"], diff["counts"]["functions"]["after"])
        # Static evidence, not observed.
        self.assertFalse(verification["test"]["ran"])
        self.assertFalse(verification["test"]["observed"])
        self.assertIn("不是通过", verification["test"]["note"])

    def test_a_declared_test_runs_in_the_copy_and_reports_its_real_exit_code(self):
        proposal = self.propose()["proposal"]
        passing = self.cli("patch", "verify", proposal["id"], "--test-argv",
                           json.dumps(["node", "-e", "process.exit(0)"]))
        self.assertTrue(passing["verification"]["test"]["observed"])
        self.assertTrue(passing["verification"]["test"]["ran"])
        self.assertEqual(passing["verification"]["test"]["exit_code"], 0)
        self.assertTrue(passing["verification"]["test"]["passed"])

    def test_a_failing_test_is_reported_as_failed_with_its_exit_code(self):
        proposal = self.propose()["proposal"]
        verified = self.cli("patch", "verify", proposal["id"], "--test-argv",
                            json.dumps(["node", "-e", "process.exit(3)"]))
        test = verified["verification"]["test"]
        self.assertTrue(test["observed"])
        self.assertEqual(test["exit_code"], 3)
        self.assertFalse(test["passed"])

    def test_a_test_that_reads_the_patched_file_sees_the_patched_bytes(self):
        proposal = self.propose()["proposal"]
        script = ("const fs=require('fs');"
                  "if(!fs.readFileSync('src/math.js','utf8').includes('right + 0'))process.exit(9);"
                  "process.exit(0)")
        verified = self.cli("patch", "verify", proposal["id"], "--test-argv",
                            json.dumps(["node", "-e", script]))
        self.assertEqual(verified["verification"]["test"]["exit_code"], 0,
                         "the isolated copy must really contain the patched bytes")

    def test_a_test_timeout_is_not_a_pass(self):
        proposal = self.propose()["proposal"]
        verified = self.cli("patch", "verify", proposal["id"], "--test-argv",
                            json.dumps(["node", "-e", "setInterval(()=>{},1000)"]),
                            "--test-timeout-ms", "700")
        test = verified["verification"]["test"]
        self.assertTrue(test.get("timed_out"))
        self.assertFalse(test.get("passed", False))

    # -- apply / revert ---------------------------------------------------
    def test_apply_writes_verified_bytes_and_revert_restores_the_pinned_ones(self):
        proposal = self.propose()["proposal"]
        self.cli("patch", "verify", proposal["id"])
        applied = self.cli("patch", "apply", proposal["id"], "--target", self.project)
        self.assertEqual(applied["state"], "applied")
        self.assertIn("right + 0", self.math.read_text(encoding="utf-8"))
        # Applying twice is refused: the checkout is no longer the base.
        self.cli("patch", "apply", proposal["id"], "--target", self.project, ok=False)
        reverted = self.cli("patch", "revert", proposal["id"])
        self.assertEqual(reverted["state"], "reverted")
        self.assertEqual(self.math.read_text(encoding="utf-8"), MATH)

    def test_apply_refuses_when_the_target_moved_after_verification(self):
        proposal = self.propose()["proposal"]
        self.cli("patch", "verify", proposal["id"])
        self.math.write_text(MATH.replace("left + right", "left + right + 1"), encoding="utf-8")
        self.cli("patch", "apply", proposal["id"], "--target", self.project, ok=False)
        self.assertIn("right + 1", self.math.read_text(encoding="utf-8"),
                      "the user's newer edit must survive the refusal")

    def test_apply_before_verification_is_refused(self):
        proposal = self.propose()["proposal"]
        self.cli("patch", "apply", proposal["id"], "--target", self.project, ok=False)

    def test_revert_refuses_when_the_target_changed_after_apply(self):
        proposal = self.propose()["proposal"]
        self.cli("patch", "verify", proposal["id"])
        self.cli("patch", "apply", proposal["id"], "--target", self.project)
        self.math.write_text("# a later edit\n" + self.math.read_text(encoding="utf-8"), encoding="utf-8")
        self.cli("patch", "revert", proposal["id"], ok=False)
        self.assertTrue(self.math.read_text(encoding="utf-8").startswith("# a later edit"),
                        "revert over a newer edit would delete that edit")

    def test_the_proposal_survives_and_is_queryable_by_entity(self):
        proposal = self.propose()["proposal"]
        listed = self.cli("patch", "list", self.analysis)["proposals"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], proposal["id"])
        status = self.cli("patch", "status", proposal["id"])
        self.assertEqual(status["proposal"]["diff"].count("right + 0"), 1)
        self.assertEqual(self.cli("patch", "list", self.analysis, "--entity", "subtract")["proposals"], [])

    def test_a_proposal_records_who_proposed_it(self):
        proposal = self.cli("patch", "propose", self.analysis, "add",
                            "--diff", self.edit_diff(), "--proposed-by", "model-x")["proposal"]
        self.assertEqual(proposal["proposed_by"], "model-x")
        self.assertEqual(proposal["proposal"]["proposed_by"], "model-x")


if __name__ == "__main__":
    if not BIN.exists():
        raise SystemExit("Run cargo build --workspace first")
    unittest.main(verbosity=2)
