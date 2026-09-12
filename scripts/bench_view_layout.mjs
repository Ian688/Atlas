// Evaluate the pinned layout engine on realistic bounded graphs, in plain node.
//
// Why the engine is measured here and not inside `node:vm`: while wiring this
// up, the same graph through the same API returned positions in one host and no
// positions at all in another. ELK in a bare `node:vm` context is therefore not
// evidence of anything, and a benchmark that ran there would report whichever
// answer it happened to get. Plain node is deterministic, so the evaluation
// numbers come from here, and the page tests inject a controlled engine and
// assert that a coordinate-less result is refused rather than drawn at (0,0).
//
// Prints one JSON document: the layout evaluation. Exits non-zero only if the
// engine is unusable, since "the engine is slow" is a measurement, not a bug.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ELK from '../web/vendor/elk.bundled.js';

const LAYOUT = readFileSync(new URL('../web/layout.js', import.meta.url), 'utf8');

// The adapter is a plain script; load it into a context and give that context a
// *fake* engine so the pure planning logic can be exercised without ELK. The
// real engine runs out here, in node, where it is reliable.
function adapter() {
  const context = vm.createContext({ console, Date });
  vm.runInContext(LAYOUT, context, { filename: 'web/layout.js' });
  return {
    run: (expr) => vm.runInContext(expr, context),
    inject: (name, value) => { context[name] = value; },
  };
}

/// A focus neighbourhood shaped like the real thing: one target, a handful of
/// callers, a wider set of callees, and unresolved boundary stubs.
export function focusFixture({ callers = 4, callees = 12, unresolved = 2, depth2 = 0 } = {}) {
  const nodes = [{ id: 'symbol:target.ts:0:1', kind: 'function', name: 'redeemCoupon', path: 'src/coupon.ts' }];
  const edges = [];
  const unresolvedList = [];
  for (let i = 0; i < callers; i++) {
    const id = `symbol:caller${i}.ts:0:1`;
    nodes.push({ id, kind: 'function', name: `caller${i}`, path: `src/caller${i}.ts` });
    edges.push({ id: `c${i}`, source: id, target: nodes[0].id, label: 'call' });
  }
  for (let i = 0; i < callees; i++) {
    const id = `symbol:callee${i}.ts:0:1`;
    nodes.push({ id, kind: 'function', name: `callee${i}`, path: `src/callee${i}.ts` });
    edges.push({ id: `d${i}`, source: nodes[0].id, target: id, label: 'call' });
    if (depth2 && i < depth2) {
      const deep = `symbol:deep${i}.ts:0:1`;
      nodes.push({ id: deep, kind: 'function', name: `deep${i}`, path: `src/deep${i}.ts` });
      edges.push({ id: `e${i}`, source: id, target: deep, label: 'call' });
    }
  }
  for (let i = 0; i < unresolved; i++) unresolvedList.push({ label: `dyn${i}()` });
  return { nodes, focus: { edges, unresolved: unresolvedList }, rootId: nodes[0].id };
}

/// Run the adapter's async entry point against the real engine, which lives in
/// this realm. The adapter context only ever sees a plain object with `layout`.
async function planWithRealEngine(fixture, options = {}) {
  const elks = new ELK();
  const { run, inject } = adapter();
  inject('fixtureFocus', fixture.focus);
  inject('fixtureNodes', fixture.nodes);
  inject('fixtureRoot', fixture.rootId);
  inject('fixtureMax', options.maxNodes === undefined ? 120 : options.maxNodes);
  inject('model', run('buildFocusModel(fixtureFocus, fixtureNodes, { rootId: fixtureRoot, maxNodes: fixtureMax })'));
  const model = run('model');
  const graph = run('layoutElkGraph(model)');
  // The graph is built by the adapter (one realm) and handed to the engine
  // (another). ELK silently returns no coordinates for a graph it does not
  // recognise as its own -- measured, not assumed -- so the boundary is made
  // explicit: the graph is plain data, and it is converted at the boundary. In
  // the page both live in the same realm, so this step does not exist there.
  const plainGraph = JSON.parse(JSON.stringify(graph));
  const started = performance.now();
  const raw = JSON.parse(JSON.stringify(await elks.layout(plainGraph)));
  const engineMs = performance.now() - started;
  inject('raw', raw);
  const placed = run('layoutFromElkResult(raw)');
  inject('placed', placed);
  inject('model', model);
  const assembled = run('layoutAssemble(model, placed, "elk_pinned", null, 0)');
  return { assembled, engineMs, boxes: placed.size };
}

const scenarios = [
  { name: 'focus_small', fixture: { callers: 2, callees: 4, unresolved: 1 } },
  { name: 'focus_typical', fixture: { callers: 4, callees: 12, unresolved: 2 } },
  { name: 'focus_depth2', fixture: { callers: 6, callees: 20, unresolved: 3, depth2: 10 } },
  { name: 'focus_folded', fixture: { callers: 20, callees: 60, unresolved: 4, depth2: 40 }, options: { maxNodes: 40 } },
];

const results = [];
for (const scenario of scenarios) {
  const fixture = focusFixture(scenario.fixture);
  const { assembled, engineMs, boxes } = await planWithRealEngine(fixture, scenario.options || {});
  results.push({
    scenario: scenario.name,
    requested: fixture.nodes.length,
    drawn: boxes,
    folded: assembled.folded.reduce((total, entry) => total + entry.viaCount, 0),
    omitted: assembled.omitted,
    budgetExceeded: assembled.budget.exceeded,
    engineMs: Number(engineMs.toFixed(1)),
    metrics: {
      nodes: assembled.metrics.nodes,
      edges: assembled.metrics.edges,
      crossings: assembled.metrics.crossings,
      labelCollisions: assembled.metrics.labelCollisions,
      crossingBasis: assembled.metrics.crossingBasis,
      labelBasis: assembled.metrics.labelBasis,
    },
    bounds: assembled.bounds,
    ports: [...assembled.ports.values()].reduce((total, entry) => total + entry.slots.length, 0),
    summaryEdges: assembled.edges.filter((edge) => edge.kind === 'summary').length,
  });
}

// Determinism: the same fixture twice must produce byte-identical boxes.
const repeatFixture = focusFixture({ callers: 4, callees: 12, unresolved: 2 });
const first = await planWithRealEngine(repeatFixture);
const second = await planWithRealEngine(repeatFixture);
const deterministic = JSON.stringify(first.assembled.boxes) === JSON.stringify(second.assembled.boxes);

// The refusal path: an engine that answers without coordinates must not be
// drawn at the origin.
const { run: bare } = adapter();
let refusal = null;
try {
  const empty = bare('layoutFromElkResult({ children: [{ id: "a", width: 10, height: 10 }] })');
  refusal = empty instanceof Map ? null : 'no_refusal';
} catch (error) {
  refusal = String(error.message);
}

// Criteria. Each is a claim a reader can check, and each is asserted rather
// than printed: a benchmark nobody can fail is a brochure.
const criteria = [];
const add = (ok, message) => criteria.push({ ok, message });
add(deterministic, 'the same fixture must produce the same boxes');
add(String(refusal || '').startsWith('elk_returned_no_coordinates'),
  'a coordinate-less engine result must be refused, not drawn at the origin');
for (const result of results) {
  add(result.metrics.labelCollisions === 0, `${result.scenario}: labels must not collide`);
  add(result.metrics.crossings <= Math.max(2, Math.floor(result.metrics.edges / 2)),
    `${result.scenario}: crossings ${result.metrics.crossings} must stay below half the edges`);
  add(result.drawn <= 200, `${result.scenario}: drawn boxes must stay bounded`);
}
const typical = results.find((r) => r.scenario === 'focus_typical');
add(typical && typical.engineMs < 250, 'a typical focus graph must lay out within 250 ms');
const folded = results.find((r) => r.scenario === 'focus_folded');
add(folded && folded.folded > 0, 'the folded scenario must actually fold');
add(folded && folded.summaryEdges > 0,
  'a fold must produce summary edges, or the budget cut the picture without saying so');
add(folded && folded.drawn < folded.requested, 'folding must reduce what is drawn');

const failed = criteria.filter((entry) => !entry.ok);
if (failed.length) {
  for (const entry of failed) process.stderr.write(`layout criterion failed: ${entry.message}\n`);
}

process.stdout.write(`${JSON.stringify({
  schema: 'atlas.layout-evaluation.v1',
  engine: 'elkjs@0.12.0 (web/vendor/elk.bundled.js, pinned, unmodified)',
  host: `node ${process.version}`,
  scenarios: results,
  deterministic,
  coordinate_less_result: refusal,
  criteria: { passed: criteria.filter((entry) => entry.ok).length, total: criteria.length,
    failed: failed.map((entry) => entry.message) },
  notes: [
    'Engine time is layout only; it excludes building the model from facts.',
    'Crossings count straight chords between ports, not the drawn curves.',
    'Label boxes are estimated from character count, so collisions are comparable, not pixel-exact.',
  ],
}, null, 2)}\n`);
if (failed.length) process.exit(1);
