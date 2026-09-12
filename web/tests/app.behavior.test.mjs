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

function boot(routes, options = {}) {
  const { document, el } = makeDom();
  const requests = [];
  const sandbox = {
    document,
    location: { hash: options.hash || '', pathname: options.pathname || '/' },
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
    effect_journal: {
      schema: 'atlas.effect-journal.v1', entries: [], denied_count: 0, observed: 0,
      granted: { fs_write: false, child_process: false, network: false },
      note: '被允许的操作没有逐条日志，因此这里不声称没有效果。',
    },
  }, over);
}

check('the effect journal is shown, and an empty journal is not read as "no effects"', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.routes.exec = record({
    effect_journal: {
      schema: 'atlas.effect-journal.v1', denied_count: 1, observed: 1,
      granted: { fs_write: false, child_process: false, network: false },
      entries: [{ outcome: 'denied', permission: 'FileSystemWrite', resource: '/tmp/escape.txt', error_code: 'ERR_ACCESS_DENIED' }],
      note: 'x',
    },
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('runControlled()');
  const shown = t.el('exec-body').textContent;
  assert.match(shown, /授予边界：fs_write=false/, 'the granted bound must be visible');
  assert.match(shown, /FileSystemWrite/, 'the blocked permission kind must be shown');
  assert.match(shown, /\/tmp\/escape\.txt/, 'the target of the blocked attempt must be shown');

  // And with nothing denied, the panel must not claim there were no effects.
  t.routes.exec = record();
  await t.run('runControlled()');
  const quiet = t.el('exec-body').textContent;
  assert.match(quiet, /不等于没有副作用/, 'an empty journal must not read as "nothing happened"');
});

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

check('a nested closure is offered only through its real enclosing function', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile({
    classification: 'needs_context', runnable: false,
    unsatisfiable_context: ['captures'], captures: ['value'],
    enclosing_symbol: 'symbol:a.js:40:80',
    reasons: [{ code: 'captured_binding', detail: '1 个值来源是 Capture', evidence: 'block_states[].bindings[].value.origins' }],
  });
  t.routes.exec = record({
    via: {
      symbol: 'symbol:a.js:40:80', path: 'a.js', name: 'makeCounter',
      source_binding: { path: 'a.js', blob: 'c'.repeat(64), start: 40, end: 80, bytes_verified: true },
      decision: { allowed: true, refusal: null },
      stage_report: {
        stage: 'enclosing', export_name: 'makeCounter', matched_by: 'source_identity',
        awaited: false, thrown: null, value: { kind: 'function', name: 'increment' },
        closure: { matched_by: 'source_identity', name: 'increment', observed_source: 'function increment(step) {}' },
      },
    },
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);

  // The direct path is impossible (captures), so the enclosing path is what the
  // checkbox offers, and the button follows the checkbox rather than the
  // classification alone.
  assert.match(t.el('exec-body').textContent, /包含函数 symbol:a\.js:40:80/, 'the enclosing symbol must be named');
  assert.equal(t.el('exec-via-enable').checked, true, 'the only possible path must be pre-selected');
  assert.equal(t.el('exec-run').disabled, false, 'a closure is runnable through its enclosing function');

  t.el('exec-args').value = '[5]';
  t.el('exec-via-args').value = '[100]';
  await t.run('runControlled()');
  const posted = t.requests.filter((r) => r.name === 'exec');
  assert.equal(posted.length, 1, 'exactly one run must be requested');
  const body = JSON.parse(posted[0].body);
  assert.deepEqual(body.via, { symbol: 'symbol:a.js:40:80', args: [100] }, 'the enclosing call must be stated, not guessed');
  assert.deepEqual(body.args, [5], 'the closure keeps its own arguments');

  const shown = t.el('exec-body').textContent;
  assert.match(shown, /阶段 1 包含函数 makeCounter/, 'the enclosing stage must be shown, not hidden');
  assert.match(shown, /源码同一性 source_identity/, 'the closure instance must be shown as identity-checked');
});

check('an unmatched closure instance is shown as an observation, not as the target', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile({
    classification: 'needs_context', runnable: false,
    unsatisfiable_context: ['captures'], captures: ['value'],
    enclosing_symbol: 'symbol:a.js:40:80', reasons: [],
  });
  t.routes.exec = record({
    verdict: 'closure_identity_mismatch', value: null,
    via: {
      symbol: 'symbol:a.js:40:80', path: 'a.js', name: 'factory',
      source_binding: { path: 'a.js', blob: 'c'.repeat(64), start: 40, end: 80, bytes_verified: true },
      decision: { allowed: true, refusal: null },
      stage_report: {
        stage: 'enclosing', export_name: 'factory', matched_by: 'source_identity',
        awaited: false, thrown: null, value: { kind: 'function', name: 'alpha' },
        closure: { matched_by: null, name: 'alpha', observed_source: 'function alpha(step) { return value + step; }' },
      },
    },
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('runControlled()');
  const shown = t.el('exec-body').textContent;
  assert.match(shown, /closure_identity_mismatch/, 'the verdict must name the mismatch');
  assert.match(shown, /源码同一性 不匹配/, 'the mismatch must be stated explicitly');
  assert.match(shown, /function alpha/, 'the observed (different) source must be shown');
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

// --- W09: one selection, two projections -----------------------------------
// The cases that matter are the refusals. A selection carries the analysis it
// was made in; a projection must not re-anchor it to whatever analysis it
// happens to be serving, because that silently attaches an old name to a new
// function. The bridge is checked for the same reason: it must expose bounded
// actions and no way to write source.
check('selecting publishes a pinned selection and points the other projection at it', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const published = t.el('inspector');
  assert.equal(published['data-selection-entity'], FN_A.id, 'the semantic DOM must carry the selection');
  assert.equal(published['data-analysis-id'], report.id, 'and the version it was pinned to');
  const href = t.el('open-3d')['href'] || '';
  assert.match(href, /^\/city3d#selection=/, 'the 3D link must carry the same selection');
  assert.match(href, /analysis=/, 'and the analysis version');
  const bridgeSelection = t.run('atlasBridge.getSelection()');
  assert.equal(bridgeSelection.entity_id, FN_A.id);
  assert.equal(bridgeSelection.analysis_id, report.id);
});

check('an Intent is registered as a proposal, never as existing code', async () => {
  const t = boot(routeBase());
  t.routes.annotation = { outcome: 'created', annotation: {
    id: 'n'.repeat(64), schema: 'atlas.annotation.v1', analysis_id: report.id,
    entity_id: FN_A.id, selection_id: 's', kind: 'constraint', body: 'must not raise',
    proposed_by: 'human', exists: false, created_at: 1,
  } };
  t.routes.annotations = { analysis_id: report.id, entity_id: FN_A.id, annotations: [{
    id: 'n'.repeat(64), kind: 'constraint', body: 'must not raise', proposed_by: 'human', exists: false,
  }] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  t.el('annotation-input').value = 'must not raise';
  await t.run('proposeAnnotation()');
  const posted = t.requests.filter((r) => r.name === 'annotation');
  assert.equal(posted.length, 1, 'exactly one Intent must be posted');
  assert.equal(JSON.parse(posted[0].body).entity, FN_A.id, 'the Intent is pinned to the selection');
  assert.equal(JSON.parse(posted[0].body).proposed_by, undefined,
    'the page must not claim authorship: the service records the session');
  const shown = t.el('annotation-body').textContent;
  assert.match(shown, /must not raise/, 'the Intent must be visible');
  assert.match(shown, /提案（尚未存在）/, 'a proposal must not read as existing code');
  assert.match(shown, /不是已存在的代码|不是事实/, 'the panel must say what an Intent is');
});

check('a shared selection from the same analysis is applied on connect', async () => {
  const t = boot(routeBase(), { hash: `#selection=${encodeURIComponent(FN_B.id)}&analysis=${report.id}` });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.match(t.el('selection-name').textContent, /fnB/, 'the shared selection must be selected');
  assert.equal(t.el('inspector')['data-selection-entity'], FN_B.id);
});

check('a shared selection from another analysis is relocated with its evidence stated', async () => {
  const t = boot(routeBase(), { hash: `#selection=${encodeURIComponent(FN_A.id)}&analysis=${'f'.repeat(64)}` });
  t.routes.relocate = {
    relocation: {
      schema: 'atlas.selection-relocation.v1', from_analysis: 'f'.repeat(64),
      to_analysis: report.id, entity_id: FN_A.id, relocated: true,
      matched_entity_id: FN_A.id, matched_by: 'path_and_name', bytes_changed: true,
      refusal: null, candidate_count: 1,
    },
    selection: { entity_id: FN_A.id, analysis_id: report.id, version: report.id },
  };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.match(t.el('selection-name').textContent, /fnA/, 'a confident relocation selects the counterpart');
  const shown = t.el('status').textContent;
  assert.match(shown, /重定位/, 'the relocation must be reported, not silent');
  assert.match(shown, /path_and_name/, 'the evidence that carried it must be shown');
  assert.match(shown, /源码字节已变化/, 'and whether the bytes changed');
});

check('a refused relocation leaves the selection alone and says why', async () => {
  const t = boot(routeBase(), { hash: `#selection=${encodeURIComponent(FN_A.id)}&analysis=${'f'.repeat(64)}` });
  t.routes.relocate = {
    relocation: {
      from_analysis: 'f'.repeat(64), to_analysis: report.id, entity_id: FN_A.id,
      relocated: false, matched_entity_id: null, matched_by: null, bytes_changed: null,
      refusal: 'no_counterpart', candidate_count: 3,
    },
    detail: { note: '没有同名或字节相同的对应物；选区保持原样，不重指。' },
    selection: null,
  };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.doesNotMatch(t.el('selection-name').textContent, /fnA/,
    'a refused relocation must not select anything');
  assert.match(t.el('status').textContent, /no_counterpart/, 'the refusal code must be shown');
  assert.match(t.el('status').textContent, /保持原样/, 'and the reason in the engine\'s own words');
});

check('a failed relocation query is reported as a failure, not as a refusal', async () => {
  const t = boot(routeBase(), { hash: `#selection=${encodeURIComponent(FN_A.id)}&analysis=${'f'.repeat(64)}` });
  t.routes.relocate = { __status: 500 };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.match(t.el('status').textContent, /重定位查询失败/,
    'a broken query must not read as "the service decided not to relocate"');
  assert.doesNotMatch(t.el('selection-name').textContent, /fnA/);
});

check('the bridge exposes bounded actions only, and none of them writes code', async () => {
  const t = boot(routeBase());
  const bridge = t.run('atlasBridge');
  assert.equal(bridge.version, 'atlas.agent-bridge.v1');
  for (const name of ['getSelection', 'getAnnotations', 'select', 'propose', 'openProjection']) {
    assert.ok(bridge.bounded_actions.includes(name), `${name} must be declared bounded`);
  }
  // Reading or proposing a patch is not a code write, so the check is on the
  // verbs that change something rather than on the noun.
  const forbidden = ['write', 'apply', 'revert', 'exec', 'delete', 'index'];
  for (const action of bridge.bounded_actions) {
    for (const word of forbidden) {
      assert.ok(!action.toLowerCase().includes(word), `${action} looks like a code-writing action`);
    }
  }
  assert.ok(bridge.bounded_actions.includes('proposePatch'),
    'registering a proposal is allowed; it is an Intent, not a write');
  for (const absent of ['applyPatch', 'revertPatch', 'verifyPatch']) {
    assert.ok(!bridge.bounded_actions.includes(absent),
      `${absent} must not be reachable from a page: verify re-indexes and apply writes a checkout`);
  }
  const missing = await t.run('atlasBridge.select("symbol:not-loaded:0:1")');
  assert.equal(missing.ok, false, 'selecting an unloaded entity must fail loudly');
});

// --- W09: the patch review surface ------------------------------------------
// The panel is where a proposal could most easily be mistaken for a change.
// These checks pin the two readings that must never happen: a rejected proposal
// shown as reviewable, and a verified proposal shown as applied.
function proposal(over = {}) {
  const inner = Object.assign({
    schema: 'atlas.patch-proposal.v1', analysis_id: report.id, entity_id: FN_A.id,
    proposed_by: 'model-x', summary: 'make it exact', intent: true, code_exists: false,
    diff: '--- a/src/a.js\n+++ b/src/a.js\n@@ -1,1 +1,1 @@\n-return a + b;\n+return a + b + 0;\n',
    validation: { ok: true, hunks: 1, patched_paths: ['src/a.js'] },
  }, over.proposal || {});
  return Object.assign({
    schema: 'atlas.patch-proposal.v1', id: 'p'.repeat(64), analysis_id: report.id,
    entity_id: FN_A.id, proposed_by: 'model-x', state: 'proposed', proposal: inner,
    verification: null, target: null, terminal_reason: null, created_at: 1, updated_at: 1,
  }, over.outer || {});
}

check('a rejected proposal is shown as unreviewable, never as verified', async () => {
  const t = boot(routeBase());
  t.routes.patches = { analysis_id: report.id, entity_id: FN_A.id, proposals: [proposal({
    proposal: { validation: { ok: false, reason: 'patch_does_not_apply:src/a.js:上下文不匹配' } },
    outer: { state: 'rejected' },
  })] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /rejected/, 'the state must be shown');
  assert.match(shown, /校验未通过/, 'the refusal must be named');
  assert.match(shown, /上下文不匹配/, 'the reason must be quoted');
  assert.match(shown, /还没有写进任何检出目录/, 'a proposal must not read as an applied change');
});

check('a verified proposal shows the graph diff, the observed test and the CLI-only boundary', async () => {
  const t = boot(routeBase());
  t.routes.patches = { analysis_id: report.id, entity_id: FN_A.id, proposals: [proposal({
    outer: {
      state: 'verified',
      verification: {
        base_analysis_id: report.id, patched_analysis_id: 'q'.repeat(64),
        graph_diff: { nodes: { added_count: 0, removed_count: 0, changed_count: 3 },
          counts: { unresolved_calls: { before: 2, after: 1 } } },
        test: { observed: true, ran: true, passed: true, exit_code: 0, argv: ['node', '--test'] },
        isolation: { user_checkout_touched: false },
      },
    },
  })] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /变更节点 3/, 'the graph diff must be shown');
  assert.match(shown, /未解析调用 前 2 → 后 1/, 'the derived analysis must be compared');
  assert.match(shown, /退出码 0/, 'the observed test result must be shown');
  assert.match(shown, /验证与应用只能在本机 CLI 上做/, 'the boundary must be stated');
});

check('a proposal with no verification says so instead of implying one', async () => {
  const t = boot(routeBase());
  t.routes.patches = { analysis_id: report.id, entity_id: FN_A.id, proposals: [proposal()] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /还没有验证/, 'an unverified proposal must say it has not been verified');
  assert.match(shown, /没有派生补丁树，也没有跑测试/, 'and must not imply a test ran');
});

check('proposing posts the diff and reports a refusal without pretending it worked', async () => {
  const t = boot(routeBase());
  t.routes['patch/propose'] = { __status: 400 };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  t.el('patch-input').value = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n';
  await t.run('proposePatch()');
  const posted = t.requests.filter((r) => r.name === 'patch/propose');
  assert.equal(posted.length, 1, 'exactly one proposal must be posted');
  assert.match(JSON.parse(posted[0].body).diff, /\+\+\+ b\/x/, 'the diff must be sent unchanged');
  assert.match(t.el('status').textContent, /未通过固定快照校验/, 'a refusal must be reported as one');
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
