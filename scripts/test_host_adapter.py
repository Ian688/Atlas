#!/usr/bin/env python3
"""W10: the host seam -- a host integration that talks only over the service.

The invariant under test is structural, not stylistic: the adapter has no
storage access at all. It is constructed with a URL and a token and nothing
else, and the test also reads the adapter's source to assert it contains no
database or store access. A host that read Atlas' SQLite file would be coupled
to a layout the contract explicitly does not promise.

The second half is the contract itself: the adapter may only use endpoints the
service publishes, with the transport it publishes them under. If the adapter
grows a call the contract does not describe, this test fails.

Standard-library only.
"""
import json
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"
ADAPTER = ROOT / "adapters" / "modus" / "atlas_host_client.mjs"

DRIVER = r"""
import { AtlasHostClient, AtlasHostError } from %(adapter)s;

const [url, token] = process.argv.slice(2);
const out = { steps: [], errors: [] };
const record = (name, value) => out.steps.push({ name, value });

const client = new AtlasHostClient({ url, token });

// A remote host must be refused before any request is made: a local session
// token sent off the machine is a leak, not a feature.
try {
  new AtlasHostClient({ url: 'http://example.com:8080/', token: 'x' });
  record('remote_refused', false);
} catch (error) {
  record('remote_refused', error.name === 'AtlasHostError');
}

const contract = await client.contract();
record('contract_schema', contract.schema);
record('contract_endpoints', contract.endpoints.map(e => `${e.name}|${e.transport}`));
record('contract_host_rules', contract.host_rules.length);

const report = await client.report();
record('report_id', report.id);
record('report_functions', report.function_count);

const nodes = await client.nodes({ kind: 'function', limit: 50 });
record('node_count', nodes.items.length);

const flow = await client.flow({ entity: 'double' });
record('flow_status', flow.status);
record('flow_return_origins', flow.returns.origins);
record('flow_known_returns', flow.returns.constants);

const source = await client.source({ entity: 'double' });
record('source_contains', source.content.includes('value * 2'));

const profile = await client.profile({ entity: 'double' });
record('profile_classification', profile.classification);

const context = await client.context({ entity: 'double' });
record('context_selection', context.selection_id);
record('context_analysis', context.context.analysis_id);

const selection = await client.selection({ entity: 'double' });
record('selection_version', selection.version === report.id);

const annotation = await client.annotate({ entity: 'double', body: 'host: keep it exact' });
record('annotation_exists', annotation.annotation.exists);
record('annotation_author', annotation.annotation.proposed_by);

const listed = await client.annotations({ entity: 'double' });
record('annotation_count', listed.annotations.length);

const queued = await client.agentRequest({ owner: 'host', requestKey: 'e2e', kind: 'inspect', entity: 'double' });
record('agent_state', queued.request.state);
const worked = await client.agentWork({ max: 2 });
record('agent_ran', worked.ran);
record('agent_observed', worked.outcomes[0].result.observed);

const proposalsBefore = await client.patches({ entity: 'double' });
record('patches_before', proposalsBefore.proposals.length);
const proposed = await client.proposePatch({
  entity: 'double',
  diff: '--- a/src/lib.js\n+++ b/src/lib.js\n@@ -1,1 +1,1 @@\n-export function double(value) { return value * 2; }\n+export function double(value) { return value + value; }\n',
});
record('proposal_state', proposed.proposal.state);
record('proposal_exists', proposed.proposal.proposal.code_exists);
const detail = await client.patch({ id: proposed.proposal.id });
record('patch_detail_state', detail.state);

const plan = await client.exec({ symbol: 'double', args: [21], plan: true });
record('plan_starts_process', plan.will_start_process);
const run = await client.exec({ symbol: 'double', args: [21] });
record('run_verdict', run.verdict);
record('run_value', run.value);
record('run_trace_coverage', run.trace.coverage);

// A closure is reached through its enclosing function, and the host says which
// one: it never hands Atlas a function and never claims to have made a scope.
const closure = await client.exec({
  symbol: 'src/lib.js:addTo', args: [5],
  allowEffects: ['unknown_calls'],
  via: { symbol: 'makeAdder', args: [100] },
});
record('closure_verdict', closure.verdict);
record('closure_value', closure.value);
record('closure_stage', closure.via.stage_report.closure.matched_by);

// A chain, outermost first: the host states the ancestors and Atlas verifies
// every link, so the host never supplies a function value.
const chain = await client.exec({
  symbol: 'src/lib.js:addToChain', args: [5],
  allowEffects: ['unknown_calls'],
  via: { symbol: 'makeAdderFromFactory', args: [] },
  viaChain: [{ symbol: 'makeAdderFactory', args: [200] }],
});
record('chain_verdict', chain.verdict);
record('chain_value', chain.value);
record('chain_length', chain.via.chain_length);
record('chain_stages', chain.via.stage_report.stages.map(s => s.closure.matched_by));

// A bad token must fail loudly rather than silently returning nothing.
try {
  const bad = new AtlasHostClient({ url, token: 'not-the-token' });
  await bad.report();
  record('bad_token_rejected', false);
} catch (error) {
  record('bad_token_rejected', error instanceof AtlasHostError && error.status === 401);
}

// Read last: the executed call above is itself an observation, so this also
// checks that the projection sees it.
const markers = await client.runMarkers();
record('run_markers', markers.markers.length);
record('run_markers_note', markers.note.includes('不是调用路径'));

const scenarios = await client.scenarios();
record('scenario_count', scenarios.scenarios.length);

const relocation = await client.relocate({ entity: 'double', fromAnalysis: report.id });
record('relocate_same_version', relocation.relocation.matched_by);

record('required_endpoints', AtlasHostClient.requiredEndpoints());
process.stdout.write(JSON.stringify(out));
"""


class HostSeam(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-host-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "package.json").write_text('{"name":"host-lab","type":"module"}\n', encoding="utf-8")
        (self.project / "src" / "lib.js").write_text(
            "export function double(value) { return value * 2; }\n"
            # A nested function, so the host seam covers the one thing a host
            # cannot obtain by naming it: an instance of an enclosing scope.
            "export function makeAdder(base) {\n"
            "  return function addTo(value) { return base + value; };\n"
            "}\n"
            # Three levels deep, so the host seam covers a chain and not just a
            # single enclosing call.
            "export function makeAdderFactory(base) {\n"
            "  return function makeAdderFromFactory() {\n"
            "    return function addToChain(value) { return base + value; };\n"
            "  };\n"
            "}\n",
            encoding="utf-8",
        )
        self.store = self.base / "store"
        indexed = subprocess.run(
            [str(BIN), "--store", str(self.store), "index", str(self.project)],
            cwd=ROOT, capture_output=True, text=True, timeout=180,
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
        self.url, self.token = session["url"], session["token"]

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)

    def drive(self):
        """Run the adapter as a host would: a URL and a token, nothing else."""
        driver = self.base / "driver.mjs"
        driver.write_text(DRIVER % {"adapter": json.dumps(ADAPTER.as_uri())}, encoding="utf-8")
        result = subprocess.run(
            ["node", str(driver), self.url, self.token],
            cwd=self.base, capture_output=True, text=True, timeout=300,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        return {step["name"]: step["value"] for step in report["steps"]}

    # -- the invariants ---------------------------------------------------
    def test_the_adapter_has_no_storage_access(self):
        source = ADAPTER.read_text(encoding="utf-8")
        forbidden = [
            r"rusqlite", r"sqlite", r"atlas\.db", r"\.db\b", r"blobs/",
            r"require\(['\"]node:fs", r"from ['\"]node:fs", r"readFile", r"openSync",
        ]
        for pattern in forbidden:
            self.assertIsNone(
                re.search(pattern, source),
                f"the host adapter must not touch storage; it matched /{pattern}/",
            )
        # And it must not accept a store path in the first place.
        self.assertNotIn("store", re.findall(r"constructor\(\{([^}]*)\}", source)[0])

    def test_the_adapter_only_uses_published_endpoints(self):
        report = self.drive()
        published = {entry.split("|")[0]: entry.split("|")[1] for entry in report["contract_endpoints"]}
        for name in report["required_endpoints"]:
            self.assertIn(name, published, f"the adapter uses {name}, which the contract does not publish")
            self.assertEqual(published[name], "http", f"{name} is published over {published[name]}")
        self.assertEqual(report["contract_schema"], "atlas.host-contract.v1")
        self.assertGreaterEqual(report["contract_host_rules"], 3)

    def test_a_host_can_work_end_to_end_over_the_service(self):
        report = self.drive()
        self.assertTrue(report["remote_refused"], "a non-loopback URL must be refused")
        self.assertEqual(report["report_id"], self.analysis)
        self.assertGreaterEqual(report["node_count"], 1)
        self.assertEqual(report["flow_status"], "complete_within_profile")
        # `double` returns its parameter, so the honest derived fact is a
        # parameter origin, not a folded constant.
        self.assertIn("Parameter(0)", report["flow_return_origins"],
                      "flow facts must be the real derived ones")
        self.assertEqual(report["flow_known_returns"], [])
        self.assertTrue(report["source_contains"])
        self.assertEqual(report["profile_classification"], "pure_callable")
        self.assertEqual(report["context_analysis"], self.analysis)
        self.assertTrue(report["selection_version"], "a selection is pinned to the served version")
        self.assertFalse(report["annotation_exists"], "an Intent is not existing code")
        # Authorship over HTTP is the service's to record, not the caller's to
        # claim: the only identity it can verify is the session token.
        self.assertTrue(report["annotation_author"].startswith("session-"),
                        report["annotation_author"])
        self.assertGreaterEqual(report["annotation_count"], 1)

    def test_a_host_can_ask_what_an_old_selection_becomes_here(self):
        report = self.drive()
        self.assertEqual(report["relocate_same_version"], "same_version")
        # No scenario was run by this driver; an empty list is the honest answer.
        self.assertEqual(report["scenario_count"], 0)

    def test_a_host_can_register_and_read_a_patch_proposal(self):
        report = self.drive()
        # The executed call above is itself an observation, and the projection
        # must say so without pretending it is a call path.
        self.assertGreaterEqual(report["run_markers"], 1)
        self.assertTrue(report["run_markers_note"])
        self.assertEqual(report["patches_before"], 0)
        self.assertEqual(report["proposal_state"], "proposed")
        self.assertFalse(report["proposal_exists"], "a proposal is an Intent, not code")
        self.assertEqual(report["patch_detail_state"], "proposed")
        # Registering a proposal must not rewrite the project.
        self.assertIn("value * 2", (self.project / "src" / "lib.js").read_text(encoding="utf-8"))

    def test_the_bounded_bridge_is_reachable_from_a_host(self):
        report = self.drive()
        self.assertEqual(report["agent_state"], "queued")
        self.assertEqual(report["agent_ran"], 1)
        self.assertFalse(report["agent_observed"], "a bridge action is not an execution observation")

    def test_a_host_can_plan_and_then_run_a_controlled_call(self):
        report = self.drive()
        self.assertTrue(report["plan_starts_process"])
        self.assertEqual(report["run_verdict"], "returned")
        self.assertEqual(report["run_value"], {"kind": "number", "value": 42})
        self.assertEqual(report["run_trace_coverage"], "not_sampled",
                         "a host must be able to see that no coverage was sampled")
        self.assertTrue(report["bad_token_rejected"])

    def test_a_host_reaches_a_closure_through_its_enclosing_function(self):
        report = self.drive()
        self.assertEqual(report["closure_verdict"], "returned")
        self.assertEqual(report["closure_value"], {"kind": "number", "value": 105},
                         "the closure must see the scope its enclosing call created")
        self.assertEqual(report["closure_stage"], "source_identity",
                         "the returned function must be accepted by source, not by name")

    def test_a_host_can_name_a_chain_of_enclosing_functions(self):
        report = self.drive()
        self.assertEqual(report["chain_verdict"], "returned")
        self.assertEqual(report["chain_value"], {"kind": "number", "value": 205},
                         "makeAdderFactory(200) -> makeAdder() -> addTo(5) = 205")
        self.assertEqual(report["chain_length"], 2)
        self.assertEqual(report["chain_stages"], ["source_identity", "source_identity"],
                         "every link must be verified, not just the last one")

    # -- the seam itself --------------------------------------------------
    def test_the_contract_does_not_leak_the_store_layout(self):
        request = urllib.request.Request(
            self.url + "api/contract",
            headers={"Authorization": "Bearer " + self.token},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode()
        self.assertNotIn(str(self.store), body, "the contract must not name the store path")
        self.assertNotIn("atlas.db", body)
        contract = json.loads(body)
        names = {entry["name"] for entry in contract["endpoints"]}
        for promised in ["report", "nodes", "edges", "flow", "source", "context", "profile", "exec"]:
            self.assertIn(promised, names)

    def test_the_contract_requires_the_session_like_every_other_query(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.url + "api/contract", timeout=20)
        self.assertEqual(error.exception.code, 401)
        error.exception.close()


if __name__ == "__main__":
    if not BIN.exists():
        raise SystemExit("Run cargo build --workspace first")
    unittest.main(verbosity=2)
