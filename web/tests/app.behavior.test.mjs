// Behavioural tests for web/app.js.
//
// `verify.py` used to cover the workbench with `node --check` only, so two real
// defects shipped: a second connect() wiped the live session (every later query
// 401) and a failed query left the previous selection's flow facts under the new
// selection's name. Both are visible only by running the file, so this harness
// evaluates the real `web/app.js` in a minimal DOM inside `node:vm` and drives
// `connect()` / `select()` with a mocked `fetch`.
//
// No dependencies: stdlib only. Exits non-zero on the first failing assertion.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'app.js');

class El {
  constructor(id) {
    this.id = id;
    this._text = [];
    this._children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.title = '';
  }
  set textContent(v) { this._text = v == null ? [] : [String(v)]; }
  get textContent() { return this._text.join(''); }
  append(...nodes) {
    for (const n of nodes) {
      this._children.push(n);
      if (n && Array.isArray(n._text)) this._text.push(n._text.join(''));
    }
  }
  replaceChildren(...nodes) { this._children = []; this._text = []; this.append(...nodes); }
  setAttribute(k, v) { this[k] = String(v); }
  removeAttribute(k) { delete this[k]; }
  addEventListener() {}
  getBoundingClientRect() { return { width: 1, height: 1, top: 0, left: 0 }; }
}

function makeDom() {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new El(id));
    return elements.get(id);
  };
  const document = {
    getElementById: (id) => el(id),
    createElement: (tag) => new El(`#${tag}`),
    createElementNS: (_ns, tag) => new El(`#${tag}`),
  };
  return { document, el };
}

// `__status` on a route makes `fetch` answer with that HTTP status instead.
function makeFetch(routes, requests) {
  return async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1');
    const name = u.pathname.replace(/^\/api\//, '');
    const headers = init.headers || {};
    const auth = headers.Authorization || headers.authorization || '';
    requests.push({ name, auth, params: Object.fromEntries(u.searchParams) });
    const route = routes[name];
    if (route === undefined) return { ok: false, status: 404, json: async () => ({ error: 'unknown_query' }) };
    if (init.body !== undefined) requests[requests.length - 1].body = init.body;
    const out = typeof route === 'function' ? route(Object.fromEntries(u.searchParams)) : route;
    if (out && out.__status) return { ok: false, status: out.__status, json: async () => ({ error: 'x' }) };
    return { ok: true, status: 200, json: async () => out };
  };
}

function boot(routes) {
  const { document, el } = makeDom();
  const requests = [];
  const sandbox = {
    document,
    location: { hash: '', pathname: '/' },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    URL, URLSearchParams, Blob, TextEncoder, console,
    fetch: makeFetch(routes, requests),
    setTimeout, clearTimeout,
  };
  sandbox.URL.createObjectURL = () => 'blob:test';
  sandbox.URL.revokeObjectURL = () => {};
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(APP, 'utf8'), context, { filename: 'web/app.js' });
  return {
    el,
    requests,
    routes,
    run: (expr) => vm.runInContext(expr, context),
    evalIn: (expr) => vm.runInContext(expr, context),
  };
}

const FN_A = { id: 'symbol:a.js:0:10', kind: 'function', name: 'fnA', path: 'a.js', start: 0, end: 10 };
const FN_B = { id: 'symbol:a.js:20:30', kind: 'function', name: 'fnB', path: 'a.js', start: 20, end: 30 };

const report = { id: 'a'.repeat(64), file_count: 1, function_count: 2, call_count: 1 };
const nodes = { items: [FN_A, FN_B], next_cursor: null, total: 2, analysis_id: report.id };
const edges = { items: [], next_cursor: null, total: 0, analysis_id: report.id };

const value = (constants) => ({
  constants, origins: ['Constant'], reasons: [], targets: [], typed_constants: [], unknown: false,
});
function flowFact(symbol, constants) {
  return {
    symbol, name: 'fnA', path: 'a.js',
    algorithm: { id: 'atlas-local-absint', version: '0.2.1' },
    status: 'complete_within_profile',
    coverage: { cfg_blocks: 2, supported_op_transfers: 3, flow_functions: 2, flow_complete_within_profile: 2 },
    returns: value(constants),
    throws: { constants: [], origins: [], reasons: ['no_throw_observed'], targets: [], typed_constants: [], unknown: true },
    effects: { may_call: [], unknown_call: false, may_write_heap: false, may_read_heap: false, may_access_global: false, registers_callback: false, escaped_local_value: false, may_throw: true },
    interprocedural: null,
    unknown_reasons: [],
    blocks: [{ id: 0, term: 'return', ops: [1, 2], successors: [] }],
    block_states: [{ block: 0, bindings: [], truncated: false }],
    frontier: [], pruned_edges: [],
  };
}

const routeBase = () => ({
  report,
  nodes,
  edges,
  source: (p) => ({
    content: `function ${p.entity === FN_A.id ? 'fnA' : 'fnB'}(){}`,
    start: 0, end: 10, truncated: false, blob: 'b'.repeat(64), analysis_id: report.id,
  }),
  reach: { nodes: [], edges: [], unresolved: [], truncated: false, analysis_id: report.id },
  flow: flowFact(FN_A.id, ['CONST_A']),
});

const checks = [];
function check(name, fn) { checks.push([name, fn]); }

check('a second connect() with the emptied field keeps the live session', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.equal(t.evalIn('state.token'), 'TOKEN-1', 'session token must be stored');
  assert.equal(t.el('token').value, '', 'field is cleared after a successful connect (precondition)');
  for (const r of t.requests) assert.equal(r.auth, 'Bearer TOKEN-1', `first connect sent ${r.auth}`);

  const before = t.requests.length;
  await t.run('connect()'); // the field is empty now — this is the regression
  const second = t.requests.slice(before);
  assert.ok(second.length > 0, 'the second connect must still talk to the server');
  for (const r of second) {
    assert.equal(r.auth, 'Bearer TOKEN-1', `second connect sent "${r.auth}" — it wiped the session`);
  }
  assert.equal(t.evalIn('state.token'), 'TOKEN-1', 'token must survive an empty-field reconnect');
});

check('an empty field with no session asks for a token instead of querying', async () => {
  const t = boot(routeBase());
  await t.run('connect()');
  assert.equal(t.requests.length, 0, 'no request may be sent without a token');
  assert.match(t.el('status').textContent, /会话令牌/, 'the user must be told to paste a token');
});

check('a failed selection clears the previous flow facts', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('flow-panel').hidden, false, 'fnA flow must render');
  assert.match(t.el('flow-body').textContent, /CONST_A/, 'fnA facts must be on screen');

  // fnB's source/reach now fail: the panel must not keep fnA's conclusion.
  t.routes.source = { __status: 401 };
  t.routes.reach = { __status: 401 };
  await t.run(`select(${JSON.stringify(FN_B)})`);
  assert.equal(t.el('flow-panel').hidden, true, 'the flow panel must be cleared on failure');
  assert.doesNotMatch(t.el('flow-body').textContent, /CONST_A/, 'fnA facts must not survive under fnB');
  assert.match(t.el('selection-name').textContent, /fnB/, 'the header names the new selection');
  assert.match(t.el('selection-facts').textContent, /会话已失效/, 'a 401 must be explained, not hidden');
});

check('a flow fact from another symbol is refused, not rendered', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  t.routes.flow = flowFact('symbol:OTHER:0:9', ['FOREIGN']);
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const body = t.el('flow-body').textContent;
  assert.match(body, /已拒绝显示/, 'a mismatched fact must be refused');
  assert.doesNotMatch(body, /FOREIGN/, 'the foreign conclusion must not be displayed');
});

check('reset clears the inspector as one unit', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  t.run('resetDetail()');
  assert.equal(t.el('flow-panel').hidden, true, 'reset must hide the flow panel');
  assert.equal(t.el('flow-body').textContent, '', 'reset must empty the flow body');
  assert.equal(t.el('selection-name').textContent, '选择一个函数');
});

function collect(el, out = []) {
  for (const c of el._children || []) {
    if (c && typeof c === 'object') { out.push(c); collect(c, out); }
  }
  return out;
}

check('the selection canvas draws resolved targets, unresolved targets and edge labels', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  t.routes.reach = {
    analysis_id: report.id, direction: 'out', root: FN_A.id, semantics: 'static candidates',
    nodes: [FN_A, FN_B],
    edges: [{ id: 'call:a.js:1:2', kind: 'call_candidate', source: FN_A.id, target: FN_B.id, label: 'fnB', basis: 'lexical_declaration_candidate', path: 'a.js', start: 1, end: 2 }],
    unresolved: [{ id: 'call:a.js:3:4', kind: 'call_candidate', source: FN_A.id, target: null, label: 'dyn', basis: 'dynamic_external_or_missing_binding', path: 'a.js', start: 3, end: 4 }],
    truncated: false,
  };
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const items = collect(t.el('graph'));
  const classes = items.map((n) => n.class || '').join(' ');
  const texts = items.map((n) => n.textContent || '').join(' | ');
  assert.match(classes, /unresolved/, 'an unresolved target must render as a distinct node');
  assert.match(texts, /fnB/, 'the resolved target must be named on the canvas');
  assert.match(texts, /dyn/, 'the unresolved target label must be shown');
  assert.match(t.el('graph-status').textContent, /未解析 1/, 'the status must count unresolved targets');
});

check('the overview aggregates file-to-file candidates, not a function list', async () => {
  const t = boot(routeBase());
  const fnB2 = { ...FN_B, id: 'symbol:b.js:0:10', path: 'b.js', parent: 'file:b.js', name: 'fnB2' };
  t.routes.nodes = {
    items: [
      { id: 'file:a.js', kind: 'file', name: 'a.js', path: 'a.js', function_count: 1 },
      { id: 'file:b.js', kind: 'file', name: 'b.js', path: 'b.js', function_count: 1 },
      { ...FN_A, parent: 'file:a.js' }, fnB2,
    ],
    next_cursor: null, total: 4, analysis_id: report.id,
  };
  t.routes.edges = {
    items: [{ id: 'call:1', kind: 'call_candidate', source: FN_A.id, target: fnB2.id, label: 'g', basis: 'lexical_declaration_candidate', path: 'a.js', start: 1, end: 2 }],
    next_cursor: null, total: 1, analysis_id: report.id,
  };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  const texts = collect(t.el('graph')).map((n) => n.textContent || '').join(' | ');
  assert.match(texts, /文件之间的调用候选/, 'the canvas must say it is a relationship view');
  assert.match(t.el('graph-status').textContent, /1 条文件间候选/, 'the overview must count aggregated candidates');
});

// The state map is where a reader decides "is this value known here?". Three
// distinct failures are possible and all three are asserted below: a cell for
// a binding that has no record in that block must not borrow the mark used for
// an explicit unknown; a constant that also carries an unknown component must
// not read as a plain constant; and a MaybeInitialized binding must not read as
// a plain one. Any of those would make the matrix assert something the engine
// never said.
function flowFactWithBindings(symbol) {
  const fact = flowFact(symbol, ['CONST_A']);
  const mk = (over) => Object.assign({
    constants: [], typed_constants: [], targets: [], origins: [], unknown: false, reasons: [],
  }, over);
  const cst = (v) => mk({ constants: [v], typed_constants: [{ kind: 'number', value: v }] });
  fact.blocks = [
    { id: 0, term: 'branch', ops: [1], successors: [[1, 'true'], [2, 'false']] },
    { id: 1, term: 'return', ops: [2], successors: [] },
    { id: 2, term: 'return', ops: [3], successors: [] },
  ];
  fact.block_states = [
    { block: 0, completion: 'Normal', truncated: false, bindings: [
      { binding: 'b:x', name: 'x', init: 'Initialized', defs: [1], value: cst(1) },
      { binding: 'b:y', name: 'y', init: 'Initialized', defs: [], value: mk({
        origins: ['Parameter(0)'], unknown: true, reasons: ['parameter_value_unknown'],
      }) },
    ] },
    { block: 1, completion: 'Normal', truncated: false, bindings: [
      { binding: 'b:x', name: 'x', init: 'MaybeInitialized', defs: [1, 4], value: cst(2) },
      { binding: 'b:w', name: 'w', init: 'Initialized', defs: [], value: mk({
        unknown: true, reasons: ['cap_exceeded'],
      }) },
    ] },
    { block: 2, completion: 'Normal', truncated: true, bindings: [
      { binding: 'b:z', name: 'z', init: 'NotInitialized', defs: [], value: mk({ unknown: true }) },
      { binding: 'b:p', name: 'p', init: 'Initialized', defs: [7], value: mk({
        constants: [0], typed_constants: [{ kind: 'number', value: 0 }],
        origins: ['Derived(op11)'], unknown: true, reasons: ['cap_exceeded'],
      }) },
    ] },
  ];
  return fact;
}

check('the block-by-binding state map marks each kind without inventing records', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  t.routes.flow = flowFactWithBindings(FN_A.id);
  await t.run(`select(${JSON.stringify(FN_A)})`);

  const items = collect(t.el('flow-body'));
  const classes = items.map((n) => n.className || '').join(' ');
  assert.match(classes, /flow-heat/, 'the state map must render');
  assert.match(classes, /heat-const/, 'a folded constant must be marked as a constant');
  assert.match(classes, /heat-origin/, 'a known origin with an unknown value is not plain unknown');
  assert.match(classes, /heat-unknown/, 'an unqualified unknown must be marked unknown');
  assert.match(classes, /heat-empty/, 'a binding with no record in a block must render as no-record');

  const cells = items.filter((n) => (n.className || '').includes('heat-cell'));
  assert.equal(cells.length, 15, '3 blocks x 5 bindings must produce 15 cells');
  // Row order is block 0,1,2; column order is first appearance: x,y,w,z,p.
  assert.match(cells[0].className, /heat-const/, 'block 0 x is a constant');
  assert.doesNotMatch(cells[0].className, /heat-partial/, 'a plain constant carries no unknown wedge');
  assert.match(cells[1].className, /heat-origin/, 'block 0 y has a known origin and unknown value');
  assert.match(cells[2].className, /heat-empty/, 'block 0 has no record for w');
  assert.doesNotMatch(cells[2].className, /heat-unknown/, 'no record must not be drawn as unknown');
  assert.match(cells[5].className, /heat-const/, 'block 1 x still folds to a constant');
  assert.match(cells[5].className, /heat-init-maybe/, 'a MaybeInitialized binding must keep its warning');
  assert.match(cells[7].className, /heat-unknown/, 'block 1 w is an unqualified unknown');
  assert.match(cells[13].className, /heat-unknown/, 'block 2 z is unknown');
  assert.match(cells[13].className, /heat-init-none/, 'block 2 z was read before initialization');
  assert.match(cells[14].className, /heat-const/, 'block 2 p folds to a constant');
  assert.match(cells[14].className, /heat-partial/, 'a constant with an unknown component must show both');

  assert.match(t.el('flow-body').textContent, /绑定状态矩阵/, 'the map must name itself');
  assert.match(t.el('flow-body').textContent, /预算截断/, 'a truncated block state must be called out');
});

// --- W08: the execution panel ------------------------------------------------
// The panel is where a reader could most easily be misled, because it can start
// a real process. These checks pin the three ways it must refuse to overstate:
// a profile that is not runnable must disable the button and say which fact
// field caused it, a refused record must never be drawn as a result, and an
// observed record must always carry its observation boundary (no coverage
// sampling, unknown paths stay unknown).
function profile(over = {}) {
  return Object.assign({
    schema: 'atlas.execution-profile.v1',
    analysis_id: report.id,
    symbol: FN_A.id, path: 'a.js', name: 'fnA',
    classification: 'pure_callable', runnable: true,
    reasons: [], params: [], arity: 0,
    flow_status: 'complete_within_profile', flow_profile: 'js-structured-control.v1',
    unknown_reasons: [], effects: {}, required_grants: [], notes: [],
  }, over);
}

function record(over = {}) {
  return Object.assign({
    schema: 'atlas.execution-record.v1', id: 'r'.repeat(64),
    analysis_id: report.id, snapshot_id: 's'.repeat(64), symbol: FN_A.id,
    path: 'a.js', name: 'fnA', verdict: 'returned', refusal: null,
    value: { kind: 'number', value: 3 }, thrown: null,
    console: { stdout: '', stderr: '', truncated: false, harness_lines: [] },
    duration_ms: 42, exit_code: 0,
    isolation: { mocks: false, permission_model: 'node --permission (probe-verified: an attempted write was denied)', effective_flags: ['--permission', '--allow-fs-read=/tmp/x'] },
    source_binding: { analysis_id: report.id, snapshot_id: 's'.repeat(64), path: 'a.js', blob: 'b'.repeat(64), bytes_verified: true },
    trace: { kind: 'observed-entry-call', coverage: 'not_sampled', unknown_paths: 'not_observed', events: [] },
  }, over);
}

check('a refused profile disables the run button and names the evidence', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile({
    classification: 'needs_context', runnable: false,
    reasons: [{ code: 'captured_binding', detail: '1 个值来源是 Capture', evidence: 'block_states[].bindings[].value.origins' }],
    required_grants: [],
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('exec-panel').hidden, false, 'the panel must appear for a classified function');
  assert.equal(t.el('exec-run').disabled, true, 'a non-runnable profile must not offer a run');
  const body = t.el('exec-body').textContent;
  assert.match(body, /captured_binding/, 'the reason code must be shown');
  assert.match(body, /block_states/, 'the fact field behind the reason must be shown');
  assert.match(body, /不是执行结果/, 'the panel must state that a classification is not an execution');
});

check('an unknown arity disables the run instead of guessing arguments', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile({ arity: null, params: [] });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('exec-run').disabled, true, 'the page must not invent arguments');
  assert.match(t.el('exec-run').title, /参数个数未知/, 'the reason must be on the control');
});

check('pressing run posts the pinned request and draws the observed boundary', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile({ required_grants: ['unknown_calls'] });
  t.routes.exec = record();
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('exec-run').disabled, false, 'a pure callable must be runnable');

  t.el('exec-args').value = '[1,2]';
  await t.run('runControlled()');
  const posted = t.requests.filter((r) => r.name === 'exec');
  assert.equal(posted.length, 1, 'exactly one run must be requested');
  assert.equal(posted[0].auth, 'Bearer TOKEN-1', 'the run must carry the session token');
  const body = JSON.parse(posted[0].body);
  assert.equal(body.symbol, FN_A.id, 'the run must be pinned to the selected symbol');
  assert.deepEqual(body.args, [1, 2], 'the page must send the arguments it displayed');
  assert.deepEqual(body.allow_effects, ['unknown_calls'], 'only the profile-required grants are forwarded');

  const shown = t.el('exec-body').textContent;
  assert.match(shown, /观测结果 returned/, 'the observed verdict must be shown');
  assert.match(shown, /返回值 3/, 'the real returned value must be shown');
  assert.match(shown, /coverage=not_sampled/, 'the observation boundary must always be stated');
  assert.match(shown, /unknown_paths=not_observed/, 'unobserved paths must stay unknown');
  assert.doesNotMatch(shown, /执行路线/, 'the panel must not claim an execution path');
});

check('a refused record is shown as a refusal, never as a result', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile({ required_grants: ['unknown_calls'] });
  t.routes.exec = record({
    verdict: 'refused', value: null, exit_code: null, duration_ms: 0,
    refusal: { code: 'missing_grants', detail: '未授予：unknown_calls', evidence: 'execution_profile.required_grants' },
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('runControlled()');
  const shown = t.el('exec-body').textContent;
  assert.match(shown, /拒绝执行/, 'the refusal must be named');
  assert.match(shown, /missing_grants/, 'the refusal code must be shown');
  assert.match(shown, /没有进程被启动/, 'a refusal must not read as a failed execution');
  assert.doesNotMatch(shown, /观测结果 returned/, 'a refusal must not borrow the success line');
});

check('a mock-labelled run says so and an observed record keeps its identity', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.routes.exec = record({
    isolation: { mocks: true, fixture_note: 'hand-built case', permission_model: 'node --permission', effective_flags: ['--permission'] },
    thrown: { name: 'TypeError', message: 'boom', code: null, stack: [] },
    value: null, verdict: 'threw',
    trace: { kind: 'observed-entry-call', coverage: 'not_sampled', unknown_paths: 'not_observed',
      events: [{ kind: 'threw', source_location: { path: 'a.js', line: 3, column: 9, line_text: 'throw new TypeError()' } }] },
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('runControlled()');
  const shown = t.el('exec-body').textContent;
  assert.match(shown, /mock\/fixture/, 'a fixture run must be labelled');
  assert.match(shown, /不得当作真实环境观测/, 'a fixture result must not read as a real observation');
  assert.match(shown, /TypeError: boom/, 'the thrown error must be shown');
  assert.match(shown, /a\.js:3:9/, 'the observed source location must be shown');
});

check('a profile from another symbol is refused, not rendered', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile({ symbol: 'symbol:OTHER:0:9', classification: 'needs_context', runnable: false });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const shown = t.el('exec-body').textContent;
  assert.match(shown, /已拒绝显示/, 'a mismatched profile must be refused');
  assert.equal(t.el('exec-run').disabled, true, 'a refused profile must not be runnable');
});

check('a missing profile leaves the run button disabled and says why', async () => {
  const t = boot(routeBase());
  t.routes.profile = { __status: 400 };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('exec-panel').hidden, true, 'no profile means no execution panel');
  assert.equal(t.el('exec-run').disabled, true, 'no profile means no run');
  if (t.evalIn('state.execProfile') !== null) throw new Error('a failed profile query must clear the profile');
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`);
  }
}
console.log(failed ? `\n${failed}/${checks.length} web behaviour checks failed` : `\nall ${checks.length} web behaviour checks passed`);
process.exit(failed ? 1 : 0);
