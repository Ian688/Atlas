#!/usr/bin/env python3
"""W09: one selection shared by both projections, and a bounded Agent Bridge.

The two things worth testing here are refusals and identity:

* A selection carries the analysis it was made in. A projection serving a
  different version must refuse it rather than re-anchor it, because silently
  pointing an old name at a new function is indistinguishable from a correct
  answer until somebody acts on it.
* The bridge only performs a closed set of actions. A request to do anything
  else is rejected durably, at enqueue time, with the reason recorded -- and a
  patch proposal stays a proposal (`code_exists: false`), because there is no
  apply/verify/revert path in this slice and claiming otherwise would be a lie
  the rest of the system would believe.

Standard-library only.
"""
import json
from pathlib import Path
import selectors
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"


class Harness(unittest.TestCase):
    """One indexed project on disk, shared by the CLI and HTTP cases."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-bridge-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "package.json").write_text('{"name":"bridge-lab","type":"module"}\n', encoding="utf-8")
        self.lib = self.project / "src" / "lib.js"
        self.lib.write_text(
            "export function double(value) { return value * 2; }\n"
            "export function label(value) { return 'v' + value; }\n",
            encoding="utf-8",
        )
        self.store = self.base / "store"
        self.analysis = self.cli("index", self.project)["id"]

    def cli(self, *args, ok=True):
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return json.loads(result.stdout) if result.stdout.strip() else {}


class Cli(Harness):
    # -- selection --------------------------------------------------------
    def test_a_selection_is_pinned_to_the_analysis_it_was_made_in(self):
        selection = self.cli("select", self.analysis, "double")
        self.assertEqual(selection["schema"], "atlas.selection.v1")
        self.assertEqual(selection["analysis_id"], self.analysis)
        self.assertEqual(selection["version"], self.analysis,
                         "the version is the analysis, so comparing it is a real check")
        self.assertTrue(selection["entity_id"].startswith("symbol:"))

    def test_a_different_entity_gets_a_different_selection_id(self):
        first = self.cli("select", self.analysis, "double")
        second = self.cli("select", self.analysis, "label")
        self.assertNotEqual(first["id"], second["id"])
        # Two runs of the same query agree without exchanging anything.
        self.assertEqual(self.cli("select", self.analysis, "double")["id"], first["id"])

    def test_an_unknown_entity_is_not_selected(self):
        self.cli("select", self.analysis, "no-such-function", ok=False)

    # -- annotations ------------------------------------------------------
    def test_an_intent_is_a_proposal_and_is_idempotent(self):
        first = self.cli("annotate", self.analysis, "double", "--kind", "constraint",
                         "--body", "must stay exact for integers")
        self.assertEqual(first["outcome"], "created")
        annotation = first["annotation"]
        self.assertFalse(annotation["exists"], "an Intent is never code that exists")
        self.assertEqual(annotation["proposed_by"], "human")
        again = self.cli("annotate", self.analysis, "double", "--kind", "constraint",
                         "--body", "must stay exact for integers")
        self.assertEqual(again["outcome"], "already_proposed")
        self.assertEqual(again["annotation"]["id"], annotation["id"])
        by_agent = self.cli("annotate", self.analysis, "double", "--kind", "constraint",
                            "--body", "must stay exact for integers", "--proposed-by", "agent")
        self.assertNotEqual(by_agent["annotation"]["id"], annotation["id"],
                            "a different author is a different proposal")

    def test_annotations_are_scoped_to_their_entity(self):
        self.cli("annotate", self.analysis, "double", "--body", "about double")
        self.cli("annotate", self.analysis, "label", "--body", "about label")
        self.assertEqual(len(self.cli("annotations", self.analysis)["annotations"]), 2)
        one = self.cli("annotations", self.analysis, "--entity", "double")["annotations"]
        self.assertEqual(len(one), 1)
        self.assertIn("about double", one[0]["body"])
        # An unknown entity is an error, not an empty list: an empty list would
        # read as "this object has no Intent" about an object that is not there.
        self.cli("annotations", self.analysis, "--entity", "no-such", ok=False)

    def test_an_unsupported_annotation_kind_is_refused(self):
        self.cli("annotate", self.analysis, "double", "--kind", "fact", "--body", "x", ok=False)

    # -- bridge queue -----------------------------------------------------
    def test_only_bounded_actions_are_accepted(self):
        result = self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "k1",
                          "--kind", "write_source", "--entity", "double", ok=False)
        self.assertEqual(result["request"]["state"], "rejected")
        self.assertEqual(result["request"]["terminal_reason"], "action_not_in_bounded_set")
        # A rejected request is durable and never claimable.
        self.assertIsNone(self.cli("agent", "claim")["request"])
        listed = self.cli("agent", "list", "--state", "rejected")["requests"]
        self.assertEqual(len(listed), 1)

    def test_a_request_against_an_unknown_analysis_is_rejected(self):
        result = self.cli("agent", "request", "f" * 64, "--owner", "m1", "--key", "k2",
                          "--kind", "inspect", "--entity", "double", ok=False)
        self.assertEqual(result["request"]["terminal_reason"], "unknown_analysis")

    def test_request_identity_is_the_owner_and_key_pair(self):
        first = self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "same",
                         "--kind", "inspect", "--entity", "double")
        self.assertEqual(first["outcome"], "enqueued")
        again = self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "same",
                         "--kind", "inspect", "--entity", "double")
        self.assertEqual(again["outcome"], "already_requested")
        self.assertEqual(again["request"]["id"], first["request"]["id"])
        other = self.cli("agent", "request", self.analysis, "--owner", "m2", "--key", "same",
                         "--kind", "inspect", "--entity", "double")
        self.assertNotEqual(other["request"]["id"], first["request"]["id"])

    # -- bounded actions --------------------------------------------------
    def test_inspect_returns_published_facts_and_claims_no_observation(self):
        self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "i1",
                 "--kind", "inspect", "--entity", "double")
        work = self.cli("agent", "work", "--once")
        self.assertEqual(work["ran"], 1)
        outcome = work["outcomes"][0]
        self.assertEqual(outcome["outcome"], "done", outcome.get("error"))
        result = outcome["result"]
        self.assertFalse(result["observed"], "a bridge action is not an execution observation")
        self.assertFalse(result["code_exists"])
        self.assertIn("source", result["detail"]["context"]["context"])

    def test_annotate_action_registers_a_proposal(self):
        payload = json.dumps({"kind": "scenario", "body": "double(2) === 4", "proposed_by": "agent"})
        self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "a1",
                 "--kind", "annotate", "--entity", "double", "--payload", payload)
        work = self.cli("agent", "work", "--once")
        outcome = work["outcomes"][0]
        self.assertEqual(outcome["outcome"], "done", outcome.get("error"))
        annotation = outcome["result"]["detail"]["annotation"]
        self.assertEqual(annotation["kind"], "scenario")
        self.assertEqual(annotation["proposed_by"], "agent")
        self.assertFalse(annotation["exists"])

    def test_a_patch_proposal_is_a_placeholder_and_never_applied(self):
        payload = json.dumps({"body": "--- a/src/lib.js\n+++ b/src/lib.js\n@@\n-return value * 2;\n+return value + value;"})
        self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "p1",
                 "--kind", "propose_patch", "--entity", "double", "--payload", payload)
        result = self.cli("agent", "work", "--once")["outcomes"][0]["result"]
        self.assertFalse(result["detail"]["annotation"]["exists"])
        self.assertFalse(result["applied"], "this slice has no apply path and must not imply one")
        self.assertIn("没有应用", result["applied_note"])
        self.assertIn("return value * 2;", self.lib.read_text(encoding="utf-8"),
                      "a proposal must not change the source")
        self.assertEqual(self.cli("report", self.analysis)["id"], self.analysis,
                         "a proposal must not change the published analysis")

    def test_an_action_with_a_missing_payload_fails_with_a_reason(self):
        self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "bad1",
                 "--kind", "annotate", "--entity", "double", "--payload", "{}")
        outcome = self.cli("agent", "work", "--once")["outcomes"][0]
        self.assertEqual(outcome["outcome"], "failed")
        self.assertEqual(outcome["request"]["terminal_reason"], "annotate_requires_body")

    # -- lease discipline -------------------------------------------------
    def test_only_the_lease_holder_can_finish(self):
        self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "l1",
                 "--kind", "inspect", "--entity", "double")
        claim = self.cli("agent", "claim")
        request, holder = claim["request"], claim["holder"]
        self.assertEqual(request["state"], "leased")
        self.assertIsNotNone(request["ack_at"], "the claim is the acknowledgement")
        self.cli("agent", "complete", request["id"], "--holder", "someone-else", ok=False)
        self.cli("agent", "complete", request["id"], "--holder", holder, "--result", '{"ok":true}')
        self.assertEqual(self.cli("agent", "status", request["id"])["state"], "done")

    def test_a_live_lease_is_not_reaped_and_an_expired_one_is(self):
        self.cli("agent", "request", self.analysis, "--owner", "m1", "--key", "l2",
                 "--kind", "inspect", "--entity", "double")
        request = self.cli("agent", "claim", "--lease-seconds", "5")["request"]
        self.assertEqual(self.cli("agent", "reap")["count"], 0, "a live lease must not be reaped")
        self.assertIsNone(self.cli("agent", "claim")["request"], "a live lease is not claimable twice")
        # The lease is a wall-clock fact, so proving expiry means letting it
        # expire rather than pretending a future clock.
        time.sleep(6)
        reaped = self.cli("agent", "reap")
        self.assertEqual(reaped["count"], 1, "an expired lease must be returned to the queue")
        self.assertEqual(self.cli("agent", "status", request["id"])["state"], "queued")
        reclaimed = self.cli("agent", "claim")["request"]
        self.assertEqual(reclaimed["attempt"], 2, "the retry is visible on the request")


class Http(Harness):
    """The same guarantees over the local HTTP boundary."""

    def setUp(self):
        super().setUp()
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

    def get(self, path):
        with self.opener.open(urllib.request.Request(self.base_url + path, headers=self.auth), timeout=20) as response:
            return json.load(response)

    def post(self, path, body, headers=None):
        return self.opener.open(urllib.request.Request(
            self.base_url + path, headers=headers or self.auth,
            data=json.dumps(body).encode(), method="POST"), timeout=30)

    def test_selection_and_annotations_over_http(self):
        selection = self.get("api/selection?entity=double")
        self.assertEqual(selection["analysis_id"], self.analysis)
        self.assertEqual(selection["version"], self.analysis)
        posted = json.load(self.post("api/annotation", {"entity": "double", "kind": "intent",
                                                        "body": "keep it exact"}))
        self.assertFalse(posted["annotation"]["exists"])
        self.assertEqual(len(self.get("api/annotations?entity=double")["annotations"]), 1)

    def test_the_bridge_queue_over_http(self):
        enqueued = json.load(self.post("api/agent/request", {
            "owner": "page-agent", "request_key": "h1", "kind": "inspect", "entity": "double",
        }))
        self.assertEqual(enqueued["outcome"], "enqueued")
        self.assertEqual(enqueued["request"]["analysis_id"], self.analysis,
                         "the server pins the analysis, not the caller")
        work = json.load(self.post("api/agent/work", {"max": 4}))
        self.assertEqual(work["ran"], 1)
        self.assertFalse(work["outcomes"][0]["result"]["observed"])
        self.assertEqual(len(self.get("api/agent/requests?state=done")["requests"]), 1)

    def test_an_unbounded_action_is_refused_over_http(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("api/agent/request", {
                "owner": "page-agent", "request_key": "h2", "kind": "run_shell", "entity": "double",
            })
        self.assertEqual(error.exception.code, 400)
        payload = json.load(error.exception)
        error.exception.close()
        self.assertEqual(payload["request"]["terminal_reason"], "action_not_in_bounded_set")

    def test_the_page_cannot_pin_work_to_another_analysis(self):
        # `analysis_id` is not part of the request type, so a page cannot name a
        # version this service is not serving: there is no field to read.
        enqueued = json.load(self.post("api/agent/request", {
            "owner": "page-agent", "request_key": "h3", "kind": "inspect", "entity": "double",
            "analysis_id": "f" * 64,
        }))
        self.assertEqual(enqueued["request"]["analysis_id"], self.analysis)

    def test_unauthenticated_bridge_calls_are_rejected(self):
        for path, body in [
            ("api/annotation", {"entity": "double", "body": "x"}),
            ("api/agent/request", {"owner": "o", "request_key": "k", "kind": "inspect"}),
            ("api/agent/work", {"max": 1}),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.post(path, body, headers={"Content-Type": "application/json"})
            self.assertEqual(error.exception.code, 401, path)
            error.exception.close()


if __name__ == "__main__":
    if not BIN.exists():
        raise SystemExit("Run cargo build --workspace first")
    unittest.main(verbosity=2)
