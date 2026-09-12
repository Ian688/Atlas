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
