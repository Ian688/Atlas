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
// index.html loads hierarchy.js before app.js, and both projections read the
// same hierarchy. The harness loads them in that order for the same reason the
// city harness does: a shared name that is missing here is a broken page, not
// a test detail.
const HIERARCHY = path.join(HERE, '..', 'hierarchy.js');
// index.html also loads the shared layout module and the vendored engine. The
// harness loads layout.js and deliberately leaves `ELK` undefined, so the
// synchronous local ordering runs here; the pinned engine's own path is
// measured in scripts/bench_view_layout.mjs, in plain node, where it is
// reliable (it returned no coordinates at all inside node:vm).
const LAYOUT = path.join(HERE, '..', 'layout.js');

class El {
  constructor(id) {
    this._id = id;
    this._text = [];
    this._children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.title = '';
  }
  // Elements created by app code register themselves under their id, so
  // getElementById can reach dynamically built forms, not just static markup.
  set id(v) { this._id = v; if (typeof v === 'string' && !v.startsWith('#') && registerEl) registerEl(v, this); }
  get id() { return this._id; }
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

function makeDom(options = {}) {
  const elements = new Map();
  registerEl = null;
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new El(id));
    return elements.get(id);
  };
  registerEl = (id, node) => { elements.set(id, node); };
  const document = {
    getElementById: (id) => el(id),
    createElement: (tag) => Object.assign(new El(`#${tag}`), { tagName: tag.toUpperCase() }),
    createElementNS: (_ns, tag) => Object.assign(new El(`#${tag}`), { tagName: tag.toUpperCase() }),
  };
  return { document, el };
}

// `__status` on a route makes `fetch` answer with that HTTP status instead.
function makeFetch(routes, requests) {
  // 受控运行现在是后台任务：exec 立刻回 run id，终态由 exec/run 查询给出。
  // 这两个端点在这里合成，测试仍然只声明"这一次执行会得到什么记录"。
  const runs = new Map();
  let runSeq = 0;
  return async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1');
    const name = u.pathname.replace(/^\/api\//, '');
    const headers = init.headers || {};
    const auth = headers.Authorization || headers.authorization || '';
    requests.push({ name, auth, params: Object.fromEntries(u.searchParams) });
    if (init.body !== undefined) requests[requests.length - 1].body = init.body;

    if (name === 'exec/run') {
      const id = u.searchParams.get('id');
      if (!runs.has(id)) return { ok: false, status: 404, json: async () => ({ error: 'run_not_found' }) };
      let record = runs.get(id);
      // __runningTimes 用于验证"运行中"这段时间：前 n 次查询回答 running。
      if (record && typeof record === 'object' && record.__runningTimes > 0) {
        runs.set(id, { ...record, __runningTimes: record.__runningTimes - 1 });
        return { ok: true, status: 200, json: async () => ({ schema: 'atlas.exec-run.v1', run_id: id, state: 'running' }) };
      }
      const verdict = record && record.verdict;
      const state = verdict === 'cancelled' ? 'cancelled' : (verdict === 'failed' ? 'failed' : 'completed');
      return { ok: true, status: 200, json: async () => ({ schema: 'atlas.exec-run.v1', run_id: id, state, record }) };
    }
    if (name === 'exec/cancel') {
      let body = {};
      try { body = JSON.parse(init.body); } catch {}
      if (!runs.has(body.id)) return { ok: false, status: 404, json: async () => ({ error: 'run_not_found' }) };
      const current = runs.get(body.id);
      // 取消是协作式的：终态由记录给出，这里只把记录换成 cancelled 版本。
      if (current && typeof current === 'object') {
        if (current.__cancelRecord !== undefined) runs.set(body.id, current.__cancelRecord);
        else runs.set(body.id, { ...current, verdict: 'cancelled' });
      }
      return { ok: true, status: 200, json: async () => ({ schema: 'atlas.exec-run.v1', run_id: body.id, state: 'cancelling' }) };
    }

    const route = routes[name];
    if (route === undefined) return { ok: false, status: 404, json: async () => ({ error: 'unknown_query' }) };
    const out = typeof route === 'function' ? route(Object.fromEntries(u.searchParams)) : route;
    if (out && out.__status) return { ok: false, status: out.__status, json: async () => ({ error: 'x' }) };

    if (name === 'exec' && init.body !== undefined) {
      let parsed = {};
      try { parsed = JSON.parse(init.body); } catch {}
      if (parsed.background) {
        runSeq += 1;
        const runId = `run-${runSeq}`;
        runs.set(runId, out);
        requests[requests.length - 1].run_id = runId;
        return { ok: true, status: 200, json: async () => ({ schema: 'atlas.exec-run.v1', run_id: runId, state: 'running' }) };
      }
    }
    return { ok: true, status: 200, json: async () => out };
  };
}

function boot(routes, options = {}) {
  const { document, el } = makeDom(options);
  const requests = [];
  const location = { hash: options.hash || '', pathname: options.pathname || '/' };
  const storage = options.sharedStorage || new Map();
  const localStorageStub = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  };
  const sandbox = {
    document,
    localStorage: localStorageStub,
    location,
    // The page writes its pinned selection and view state through
    // replaceState; a stub that ignores the write would make hash assertions
    // read a page that never moved.
    history: { replaceState(_s, _t, url) {
      const u = new URL(url, 'http://127.0.0.1');
      location.pathname = u.pathname;
      location.hash = u.hash;
    } },
    navigator: { clipboard: { writeText: async () => {} } },
    URL, URLSearchParams, Blob, TextEncoder, console,
    fetch: makeFetch(routes, requests),
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  // A layout engine can be injected, so the asynchronous path is exercised with
  // a controlled engine instead of the real one: the vendored engine returned
  // no coordinates at all inside node:vm, so measuring it here would report
  // whichever answer it happened to give. It is measured in plain node by
  // scripts/bench_view_layout.mjs.
  if (options.ELK) sandbox.ELK = options.ELK;
  sandbox.URL.createObjectURL = () => 'blob:test';
  sandbox.URL.revokeObjectURL = () => {};
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(HIERARCHY, 'utf8'), context, { filename: 'web/hierarchy.js' });
  vm.runInContext(readFileSync(LAYOUT, 'utf8'), context, { filename: 'web/layout.js' });
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

let registerEl = null;
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
  // The values view is a lens now: the flow renders under「值从哪来」.
  assert.equal(t.run("setLens('values')"), true, 'the values lens must exist');
  assert.equal(t.el('flow-panel').hidden, false, 'fnA flow must render in the values lens');
  assert.match(t.el('flow-body').textContent, /CONST_A/, 'fnA facts must be on screen');

  // fnB's source/reach now fail: the panel must not keep fnA's conclusion.
  // Resources load independently now, so fnB's own flow query still runs and
  // happens to answer with fnA's fact — the panel must refuse it by name.
  t.routes.source = { __status: 401 };
  t.routes.reach = { __status: 401 };
  await t.run(`select(${JSON.stringify(FN_B)})`);
  const flowShown = t.el('flow-body').textContent;
  assert.doesNotMatch(flowShown, /CONST_A/, 'fnA facts must not survive under fnB');
  if (!t.el('flow-panel').hidden) {
    assert.match(flowShown, /已拒绝显示/, 'a visible panel must be an explicit refusal, not leftover facts');
  }
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
  assert.match(texts, /层级：文件/, 'the canvas must name the level it is drawing');
  assert.match(texts, /1 候选/, 'the overview must count aggregated candidates');
  assert.match(t.el('graph-status').textContent, /层级 文件/, 'the status line must name the level');
  assert.match(t.el('graph-status').textContent, /索引 \d+ 盒 \/ \d+ 格/, 'the pick index must be reported, not assumed');
});

// ---------------------------------------------------------------------------
// The level switch. The 2D canvas used to draw "the first twelve loaded files"
// and had no notion of a level at all, while the 3D city had project ->
// district -> file with conservation checks. Two definitions of the same thing
// drift, and each view stays internally consistent while disagreeing, so what
// is asserted here is that both levels come from one hierarchy and that the
// aggregated facts do not move when the level does.
const TWO_FILES = {
  items: [
    { id: 'file:lib/a.js', kind: 'file', name: 'a.js', path: 'lib/a.js', function_count: 2, disposition: 'captured' },
    { id: 'file:lib/b.js', kind: 'file', name: 'b.js', path: 'lib/b.js', function_count: 3, disposition: 'captured' },
    { id: 'file:top.js', kind: 'file', name: 'top.js', path: 'top.js', function_count: 1, disposition: 'captured' },
    { ...FN_A, parent: 'file:lib/a.js', path: 'lib/a.js' },
    { ...FN_B, parent: 'file:lib/a.js', path: 'lib/a.js' },
    { ...FN_B, id: 'symbol:lib/b.js:0:5', parent: 'file:lib/b.js', path: 'lib/b.js', name: 'fnC', start: 0, end: 5 },
    { ...FN_B, id: 'symbol:top.js:0:5', parent: 'file:top.js', path: 'top.js', name: 'fnD', start: 0, end: 5 },
  ],
  next_cursor: null, total: 7, analysis_id: report.id,
};
const CROSS = {
  items: [{ id: 'call:1', kind: 'call_candidate', source: FN_A.id, target: 'symbol:lib/b.js:0:5', label: 'g', basis: 'lexical_declaration_candidate', path: 'lib/a.js', start: 1, end: 2 }],
  next_cursor: null, total: 1, analysis_id: report.id,
};

async function bootLevels() {
  const t = boot({ ...routeBase(), nodes: TWO_FILES, edges: CROSS });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  return t;
}

check('the same hierarchy backs both projections and conserves every counted fact', async () => {
  const t = await bootLevels();
  const hierarchy = t.evalIn('state.hierarchy');
  assert.equal(hierarchy.schema, 'atlas.hierarchy.v1', 'both pages must read the shared hierarchy');
  // The vm context has its own Array prototype, so compare the contents.
  assert.equal(JSON.stringify(hierarchy.levels), JSON.stringify(['project', 'district', 'file']));
  const invariants = t.evalIn('atlasLevelInvariants(state.hierarchy)');
  assert.equal(invariants.ok, true, JSON.stringify(invariants.violations));
  assert.equal(invariants.totals.declaredFunctions, 6, 'declared functions are the sum over all three files');
  assert.equal(invariants.totals.files, 3);
  assert.equal(invariants.totals.loadedFunctions, 4, 'and the loaded count is what this page actually has');
});

check('switching level changes what a block stands for, never what is counted', async () => {
  const t = await bootLevels();
  const totals = [];
  const blocks = [];
  for (const level of ['project', 'district', 'file']) {
    assert.equal(t.run(`setLevel(${JSON.stringify(level)})`), true);
    const view = t.evalIn('state.levelView');
    assert.equal(view.level, level);
    totals.push(JSON.stringify(view.totals));
    blocks.push(view.blocks.length);
    assert.match(t.el('graph-status').textContent, new RegExp(`层级 ${view.levelLabel}`));
  }
  // One block for the project, one per district, one per enumerated file: the
  // block set is what the level decides, and it is the only thing it decides.
  assert.equal(JSON.stringify(blocks), JSON.stringify([1, 2, 3]));
  assert.equal(new Set(totals).size, 1, 'aggregated facts must be identical at every level');
  // The same two calls are a drawn pipe between two files and an internal pair
  // inside one district. Neither is a different number of calls.
  assert.equal(t.run('setLevel("file") && state.levelView.pairs.length'), 1);
  assert.equal(t.run('setLevel("district") && state.levelView.pairs.length'), 0);
  assert.equal(t.run('state.levelView.internalPairs'), 1, 'the intra-district call is counted, not dropped');
});

check('a coarse block says it is an aggregate and refuses to open one file of many', async () => {
  const t = await bootLevels();
  t.run('setLevel("district")');
  const view = t.evalIn('state.levelView');
  const multi = view.blocks.find((b) => b.filePaths.length > 1);
  assert.ok(multi, 'a district holding two files must exist');
  assert.equal(multi.path, 'district:lib');
  assert.equal(multi.fileId, null, 'an aggregate has no single source to open');
  const single = view.blocks.find((b) => b.filePaths.length === 1);
  assert.ok(single, 'a district holding exactly one file still exists');
  assert.equal(single.fileId, `file:${single.filePaths[0]}`,
    'a one-file district is that file, so its source stays readable');
  const texts = collect(t.el('graph')).map((n) => n.textContent || '').join(' | ');
  assert.match(texts, /聚合/, 'the block must be labelled as an aggregate');
  const picked = t.run('levelPickAt(0, 0)');
  assert.equal(picked.ok, false, 'a point outside every box is not a pick');
  assert.equal(picked.code, 'outside_the_index');
});

check('the pick index answers a real query and reports a named miss', async () => {
  const t = await bootLevels();
  t.run('setLevel("file")');
  const view = t.evalIn('state.levelView');
  const index = t.evalIn('state.index');
  assert.equal(index.boxes, view.blocks.length, 'one box per drawn block');
  const first = view.blocks[0];
  assert.equal(first.path, 'lib/a.js', 'file blocks are enumerated in path order');
  // The layout places the first block at x=40..250 with its top at y=53.
  const hit = t.run('levelHitAt(100, 80)');
  assert.equal(hit.ok, true, JSON.stringify(hit));
  assert.equal(hit.blockId, first.id);
  assert.equal(hit.fileId, first.fileId, 'a file block carries the identity to open');
  assert.ok(hit.scanned <= index.boxes, 'the index must not scan more boxes than exist');
  const miss = t.run('levelHitAt(100000, 100000)');
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'outside_the_index');
});

check('a file-level budget is reported as a budget, not as level omission', async () => {
  const t = await bootLevels();
  // 60 is the canvas budget; a project with more files than that is the case
  // where "not drawn" and "not enumerated by this level" must not be conflated.
  const many = [];
  for (let i = 0; i < 70; i++) many.push({ id: `file:f${i}.js`, kind: 'file', name: `f${i}.js`, path: `f${i}.js`, function_count: 1, disposition: 'captured' });
  t.routes.nodes = { items: many, next_cursor: null, total: many.length, analysis_id: report.id };
  t.routes.edges = { items: [], next_cursor: null, total: 0, analysis_id: report.id };
  await t.run('connect()');
  const view = t.evalIn('state.levelView');
  assert.equal(view.blocks.length, 60, 'the budget decides what is drawn');
  assert.equal(view.totals.files, 70, 'and it must not decide what is counted');
  assert.equal(view.budget.files, true);
  assert.match(t.el('graph-status').textContent, /预算截断：文件层只画前 60 个文件（70 中）/);
  t.run('setLevel("project")');
  const coarse = t.evalIn('state.levelView');
  assert.equal(coarse.budget.files, false, 'the project level enumerates no file, so it truncates none');
  assert.equal(coarse.enumeratedFiles, 70);
  assert.match(t.el('graph-status').textContent, /层级 项目/);
});

check('a level over a partially loaded page says so instead of totalling the project', async () => {
  const t = await bootLevels();
  // The page holds one page of objects. The level must still aggregate what it
  // has, and it must not present that subset as the project's totals.
  t.routes.nodes = { items: TWO_FILES.items, next_cursor: 'cursor', total: 900, analysis_id: report.id };
  await t.run('connect()');
  const line = t.el('graph-status').textContent;
  assert.match(line, /仅已加载子集/, 'aggregated facts must be labelled as a subset');
  assert.match(line, /本页已加载 7\/900 对象/, 'and the loaded fraction must be stated');
});

check('the level switch never re-anchors a focused function', async () => {
  const t = await bootLevels();
  await t.run(`select(state.nodes.find(n => n.id === ${JSON.stringify(FN_A.id)}))`);
  const before = t.evalIn('state.selected.id');
  t.run('setLevel("project")');
  assert.equal(t.evalIn('state.selected.id'), before, 'the selection must survive a level change');
  assert.match(t.el('status').textContent, /当前仍是焦点图/, 'and the page must say the level did not replace it');
  assert.equal(t.run('setLevel("nope")'), false, 'an unknown level is refused, not coerced');
});

check('neither page carries a private copy of the level definitions', () => {
  const root = path.join(HERE, '..');
  for (const [page, own] of [['index.html', '/app.js'], ['city3d.html', '/city3d.js']]) {
    const html = readFileSync(path.join(root, page), 'utf8');
    const shared = html.indexOf('/hierarchy.js');
    assert.ok(shared !== -1, `${page} must load the shared hierarchy`);
    assert.ok(shared < html.indexOf(own), `${page} must load it before ${own}`);
  }
  for (const file of ['app.js', 'city3d.js']) {
    const source = readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /const\s+ATLAS_LEVELS\s*=\s*\[/, `${file} must not redefine the levels`);
    assert.doesNotMatch(source, /const\s+ATLAS_FACT_KEYS\s*=\s*\[/, `${file} must not redefine the fact keys`);
  }
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
  const shown = t.el('exec-result').textContent;
  assert.match(shown, /授予边界：fs_write=false/, 'the granted bound must be visible');
  assert.match(shown, /FileSystemWrite/, 'the blocked permission kind must be shown');
  assert.match(shown, /\/tmp\/escape\.txt/, 'the target of the blocked attempt must be shown');

  // And with nothing denied, the panel must not claim there were no effects.
  t.routes.exec = record();
  await t.run('runControlled()');
  const quiet = t.el('exec-result').textContent;
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
  await t.run(`execDraft(${JSON.stringify(FN_A.id)}).advanced = true`);
  await t.run('renderExecForm(state.execProfile)');
  await t.run('runControlled()');
  const posted = t.requests.filter((r) => r.name === 'exec');
  assert.equal(posted.length, 1, 'exactly one run must be requested');
  assert.equal(posted[0].auth, 'Bearer TOKEN-1', 'the run must carry the session token');
  const body = JSON.parse(posted[0].body);
  assert.equal(body.symbol, FN_A.id, 'the run must be pinned to the selected symbol');
  assert.deepEqual(body.args, [1, 2], 'the page must send the arguments it displayed');
  assert.deepEqual(body.allow_effects, ['unknown_calls'], 'only the profile-required grants are forwarded');

  const shown = t.el('exec-result').textContent;
  assert.match(shown, /观测结果 returned/, 'the observed verdict must be shown');
  assert.match(shown, /返回值 3/, 'the real returned value must be shown');
  assert.match(shown, /coverage=not_sampled/, 'the observation boundary must always be stated');
  assert.match(shown, /unknown_paths=not_observed/, 'unobserved paths must stay unknown');
  assert.doesNotMatch(shown, /执行路线/, 'the panel must not claim an execution path');
});

check('a run is a background task, and its terminal state comes from the server record', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.routes.exec = { ...record(), __runningTimes: 1 };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  t.el('exec-args').value = '[1,2]';
  await t.run(`execDraft(${JSON.stringify(FN_A.id)}).advanced = true`);
  await t.run('renderExecForm(state.execProfile)');
  const running = t.run('runControlled()');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(t.el('exec-cancel').hidden, false, '运行期间取消按钮必须可见');
  assert.match(t.el('exec-run').textContent, /运行中/, '运行按钮原位变成取消/运行中');
  await running;
  const body = JSON.parse(t.requests.find(r => r.name === 'exec').body);
  assert.equal(body.background, true, '一次运行必须是后台任务，不是一个从头等到尾的请求');
  assert.equal(t.el('exec-cancel').hidden, true, '终态之后不再显示取消');
  assert.match(t.el('exec-result').textContent, /观测结果 returned/, '终态记录来自服务端查询');
});

check('cancelling asks the server and waits for its terminal record', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.routes.exec = { ...record(), verdict: 'cancelled', __runningTimes: 2 };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  t.el('exec-args').value = '[1,2]';
  await t.run(`execDraft(${JSON.stringify(FN_A.id)}).advanced = true`);
  await t.run('renderExecForm(state.execProfile)');
  const running = t.run('runControlled()');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(await t.run('cancelCurrentRun()'), true, '取消要真的发给服务端');
  assert.ok(t.requests.some(r => r.name === 'exec/cancel'), '必须有 exec/cancel 请求');
  await running;
  assert.match(t.el('exec-result').textContent, /cancelled/, '终态是服务端发布的 cancelled 记录，不是 HTTP 断开');
  assert.equal(t.el('exec-cancel').hidden, true, '终态之后不再显示取消');
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
  const shown = t.el('exec-result').textContent;
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
  const shown = t.el('exec-result').textContent;
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
      chain: ['symbol:a.js:40:80'], chain_length: 1, ancestors: [],
      stage_report: {
        stage: 'enclosing', stage_count: 1, failed_stage: null,
        export_name: 'makeCounter', matched_by: 'source_identity',
        awaited: false, thrown: null, value: { kind: 'function', name: 'increment' },
        closure: { matched_by: 'source_identity', name: 'increment', observed_source: 'function increment(step) {}' },
        stages: [{
          stage: 'enclosing', index: 0, name: 'increment', args: [100],
          awaited: false, thrown: null, value: { kind: 'function', name: 'increment' },
          closure: { matched_by: 'source_identity', name: 'increment', expected: 'increment', observed_source: 'function increment(step) {}' },
        }],
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
  await t.run(`execDraft(${JSON.stringify(FN_A.id)}).advanced = true`);
  await t.run('renderExecForm(state.execProfile)');
  await t.run('runControlled()');
  const posted = t.requests.filter((r) => r.name === 'exec');
  assert.equal(posted.length, 1, 'exactly one run must be requested');
  const body = JSON.parse(posted[0].body);
  assert.deepEqual(body.via, { symbol: 'symbol:a.js:40:80', args: [100] }, 'the enclosing call must be stated, not guessed');
  assert.deepEqual(body.args, [5], 'the closure keeps its own arguments');

  const shown = t.el('exec-result').textContent;
  assert.match(shown, /阶段 1 调用 increment/, 'the enclosing stage must be shown, not hidden');
  assert.match(shown, /下一级源码同一性 source_identity/, 'the closure instance must be shown as identity-checked');
});

check('a closure nested three levels deep discovers its ancestors and posts the chain', async () => {
  const t = boot(routeBase());
  const enclosing = 'symbol:a.js:40:80';
  const ancestor = 'symbol:a.js:90:140';
  t.routes.profile = profile({
    classification: 'needs_context', runnable: false,
    unsatisfiable_context: ['captures'], captures: ['base'],
    enclosing_symbol: enclosing, reasons: [],
  });
  // The walk asks the analysis for each ancestor in turn: the enclosing
  // function's own profile names the next one up.
  t.routes.profile = (params) => {
    if (params.entity === ancestor) {
      return profile({ symbol: ancestor, classification: 'pure_callable', runnable: true, enclosing_symbol: null });
    }
    if (params.entity === enclosing) {
      return profile({ symbol: enclosing, classification: 'pure_callable', runnable: true, enclosing_symbol: ancestor });
    }
    return profile({ classification: 'needs_context', runnable: false,
      unsatisfiable_context: ['captures'], captures: ['base'], enclosing_symbol: enclosing, reasons: [] });
  };
  t.routes.exec = record({
    via: {
      symbol: enclosing, path: 'a.js', name: 'middle',
      chain: [ancestor, enclosing], chain_length: 2,
      ancestors: [{ symbol: ancestor, path: 'a.js', name: 'outer',
        source_binding: { path: 'a.js', blob: 'd'.repeat(64), start: 90, end: 140, bytes_verified: true },
        decision: { allowed: true, refusal: null } }],
      source_binding: { path: 'a.js', blob: 'c'.repeat(64), start: 40, end: 80, bytes_verified: true },
      decision: { allowed: true, refusal: null },
      stage_report: {
        stage: 'enclosing', stage_count: 2, failed_stage: null,
        stages: [
          { index: 0, name: 'middle', value: { kind: 'function', name: 'middle' },
            closure: { matched_by: 'source_identity', name: 'middle', observed_source: 'function middle() {}' } },
          { index: 1, name: 'inner', value: { kind: 'function', name: 'inner' },
            closure: { matched_by: 'source_identity', name: 'inner', observed_source: 'function inner(x) {}' } },
        ],
        value: { kind: 'function', name: 'inner' }, thrown: null, awaited: false,
      },
    },
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  // The chain is discovered, not typed: the field is pre-filled with the
  // ancestors above the enclosing function, outermost first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(t.el('exec-via-chain').value, JSON.stringify([{ symbol: ancestor, args: [] }]),
    'the ancestor chain must come from the published profiles');
  const shownBefore = t.el('exec-body').textContent;
  assert.match(shownBefore, /嵌了 2 层/, 'the panel must say how deep the nesting is');
  assert.equal(t.el('exec-via-enable').checked, true, 'the only possible path is pre-selected');

  t.el('exec-args').value = '[3]';
  t.el('exec-via-args').value = '[]';
  await t.run(`execDraft(${JSON.stringify(FN_A.id)}).advanced = true`);
  await t.run('renderExecForm(state.execProfile)');
  await t.run('runControlled()');
  const posted = t.requests.filter((r) => r.name === 'exec');
  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0].body);
  assert.deepEqual(body.via, { symbol: enclosing, args: [] });
  assert.deepEqual(body.via_chain, [{ symbol: ancestor, args: [] }],
    'the ancestors are posted outermost first, with their own arguments');
  const shown = t.el('exec-result').textContent;
  assert.match(shown, /祖先链（由外到内）outer → middle/, 'every ancestor must be shown, not just the nearest one');
  assert.match(shown, /阶段 2 调用 inner/, 'each stage is reported separately');
  assert.match(shown, /下一级源码同一性 source_identity/, 'each link is shown as identity-checked');
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
  const shown = t.el('exec-result').textContent;
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
  // 面板本身跟着选区出现（它承载"为什么不能运行"），但运行按钮必须是禁用的，
  // 而且面板要说明原因——不能把失败渲染成"可以运行"。
  assert.equal(t.el('exec-panel').hidden, false, 'the run panel follows the selection');
  assert.equal(t.el('exec-run').disabled, true, 'no profile means no run');
  assert.match(t.el('exec-body').textContent, /画像|失败|不可运行/, 'the panel must say why it cannot run');
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
  const href = t.el('city-open')['href'] || '';
  assert.match(href, /^\/city3d#selection=/, `the 3D link must carry the same selection (got ${JSON.stringify(href)})`);
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
  assert.match(shown, /应用与撤销只能在本机 CLI 上做/, 'the write boundary must be stated (verify is a page action now)');
});

check('a create or delete proposal is shown as that, not as an edit', async () => {
  const t = boot(routeBase());
  t.routes.patches = { proposals: [{ id: 'p'.repeat(64), state: 'proposed', proposed_by: 'session-1',
    proposal: { intent: true, code_exists: false, target_exists: false, summary: 'add a file',
      diff: '--- /dev/null +++ b/src/new.js',
      validation: { ok: true, hunks: 1, patched_paths: ['src/new.js'], deleted_paths: [],
        forms: [{ path: 'src/new.js', form: 'create' }] } } }] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /新建 src\/new\.js/, 'a creation must be named as one');
  assert.match(shown, /revert 会删除它/, 'and the revert semantics stated');
  assert.match(shown, /target_exists=false/, 'a create names a path with no entity yet');
  // A deletion carries its own wording and its removed paths.
  t.routes.patches = { proposals: [{ id: 'q'.repeat(64), state: 'verified', proposed_by: 'session-1',
    proposal: { intent: true, code_exists: false, target_exists: true, summary: 'drop a file',
      diff: '--- a/src/old.js +++ /dev/null',
      validation: { ok: true, hunks: 1, patched_paths: [], deleted_paths: ['src/old.js'],
        forms: [{ path: 'src/old.js', form: 'delete' }] } },
    verification: { graph_diff: { nodes: {} } } }] };
  await t.run(`loadPatches(state.selected)`);
  const deleted = t.el('patch-body').textContent;
  assert.match(deleted, /删除 src\/old\.js/);
  assert.match(deleted, /apply 只在磁盘上仍是提案所依据的字节时删除/);
  assert.match(deleted, /删除路径：src\/old\.js/);
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

check('a one-click revert appears only when the operator allowed writes', async () => {
  const t = boot(routeBase());
  const id = 'w'.repeat(64);
  const applied = () => ({ proposals: [{ id, state: 'applied', proposed_by: 'session-1', target: '/tmp/checkout',
    proposal: { intent: true, code_exists: false, target_exists: true, summary: 'edit',
      diff: '--- a/src/math.js +++ b/src/math.js',
      validation: { ok: true, hunks: 1, patched_paths: ['src/math.js'], deleted_paths: [],
        forms: [{ path: 'src/math.js', form: 'modify' }] } } }] });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  // No contract with writes in it: the page must not offer a write it cannot do.
  t.routes.patches = applied();
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const withoutWrites = t.el('patch-body').textContent;
  assert.doesNotMatch(withoutWrites, /一键撤销/, 'no write buttons without an explicit opt-in');
  assert.match(withoutWrites, /没有 --allow-writes/, 'and the reason must be stated');

  // Now the server says writes are enabled into one named directory.
  t.routes.contract = { writes: { enabled: true, root: '/tmp/checkout' }, endpoints: [] };
  t.routes.patches = applied();
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const withWrites = t.el('patch-body').textContent;
  assert.match(withWrites, /一键撤销/, 'an applied proposal may be reverted from the page');
  assert.match(withWrites, /\/tmp\/checkout/, 'the directory that would be written must be shown');
  assert.match(withWrites, /页面不能指定目录/, 'and the boundary must be stated, not implied');

  t.routes['patch/revert'] = { proposal: { id, state: 'reverted' } };
  await t.run(`writePatch('patch/revert','${id}','/tmp/checkout')`);
  const posted = t.requests.filter((r) => r.name === 'patch/revert');
  assert.equal(posted.length, 1, 'the click must post exactly once');
  const body = JSON.parse(posted[0].body);
  assert.equal(body.id, id);
  assert.equal(body.confirm_path, '/tmp/checkout', 'the page echoes the published directory');
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


// ---------------------------------------------------------------------------
// The 2D call view is laid out. It used to be three columns in load order, with
// every edge leaving from the middle of a box edge: no layers, no ports, and
// nothing in the geometry that a reader could follow. These assertions cover
// the properties that make it a layout, and the two ways it must refuse to
// pretend: an engine that answers without coordinates, and a layout that
// arrives after the selection moved on.
const REACH_FAN = {
  analysis_id: report.id, direction: 'both', root: FN_A.id, semantics: 'static candidates',
  nodes: [FN_A, FN_B],
  edges: [
    { id: 'c1', kind: 'call_candidate', source: 'symbol:caller1.js:0:1', target: FN_A.id, label: 'from1', basis: 'lexical_declaration_candidate', path: 'a.js', start: 1, end: 2 },
    { id: 'c2', kind: 'call_candidate', source: 'symbol:caller2.js:0:1', target: FN_A.id, label: 'from2', basis: 'lexical_declaration_candidate', path: 'a.js', start: 2, end: 3 },
    { id: 'd1', kind: 'call_candidate', source: FN_A.id, target: FN_B.id, label: 'to1', basis: 'lexical_declaration_candidate', path: 'a.js', start: 3, end: 4 },
    { id: 'd2', kind: 'call_candidate', source: FN_A.id, target: 'symbol:deep.js:0:1', label: 'to2', basis: 'lexical_declaration_candidate', path: 'a.js', start: 4, end: 5 },
  ],
  unresolved: [{ id: 'u1', kind: 'call_candidate', source: FN_A.id, target: null, label: 'dyn', basis: 'dynamic_external_or_missing_binding', path: 'a.js', start: 5, end: 6 }],
  truncated: false,
};

const FAN_NODES = {
  items: [
    FN_A, FN_B,
    { id: 'symbol:caller1.js:0:1', kind: 'function', name: 'caller1', path: 'caller1.js', parent: 'file:caller1.js' },
    { id: 'symbol:caller2.js:0:1', kind: 'function', name: 'caller2', path: 'caller2.js', parent: 'file:caller2.js' },
    { id: 'symbol:deep.js:0:1', kind: 'function', name: 'deep', path: 'deep.js', parent: 'file:deep.js' },
  ],
  next_cursor: null, total: 5, analysis_id: report.id,
};

async function bootFan(options = {}) {
  const t = boot({ ...routeBase(), nodes: FAN_NODES, reach: REACH_FAN }, options);
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  return t;
}

check('the call view is layered and every edge leaves from its own port', async () => {
  const t = await bootFan();
  const plan = t.evalIn('state.focusLayout');
  assert.ok(plan, 'a plan must exist after selecting a function');
  // Layers: the target sits between its callers and its callees on the x axis.
  const target = plan.boxes.find((b) => b.role === 'target');
  const upstream = plan.boxes.filter((b) => b.role === 'upstream');
  const downstream = plan.boxes.filter((b) => b.role === 'downstream');
  assert.ok(upstream.length >= 2 && downstream.length >= 2, 'both directions must be present');
  for (const box of upstream) assert.ok(box.x < target.x, `${box.label} must sit upstream of the target`);
  for (const box of downstream) assert.ok(box.x > target.x, `${box.label} must sit downstream of the target`);
  // Ports: two edges leaving the target must not share an attachment point.
  const targetPorts = plan.ports.get(target.id).slots.filter((slot) => slot.side === 'right');
  assert.ok(targetPorts.length >= 2, 'the target must expose a port per outgoing edge');
  const ys = new Set(targetPorts.map((slot) => slot.y));
  assert.equal(ys.size, targetPorts.length, 'each outgoing edge must have its own port');
  // And the drawn picture uses them: edges are anchored at port coordinates.
  const paths = collect(t.el('graph')).filter((n) => (n.class || '').split(' ').includes('edge'));
  assert.ok(paths.length >= 4, `edges must be drawn (${paths.length})`);
  for (const path of paths) {
    const match = /^M ([\d.-]+) ([\d.-]+)/.exec(path.d || '');
    assert.ok(match, 'an edge must start at a coordinate');
    const port = [...plan.ports.values()].flatMap((entry) => entry.slots)
      .some((slot) => Math.abs(slot.x - Number(match[1])) < 0.001 && Math.abs(slot.y - Number(match[2])) < 0.001);
    assert.ok(port, `edge ${path.d} must start at a port, not at a box centre`);
  }
  assert.match(t.el('graph-status').textContent, /交叉 \d+/, 'the status must report crossings');
  assert.match(t.el('graph-status').textContent, /标签碰撞 \d+/, 'and label collisions');
});

check('the node budget folds instead of dropping, and says what it folded', async () => {
  const t = await bootFan();
  // Fold everything beyond the target and one hop by shrinking the budget.
  const plan = t.run('planFocusLayout(state.focus, state.nodes, { rootId: state.selected.id, maxNodes: 2 })');
  assert.equal(plan.budget.exceeded, true, 'a budget that bites must say so');
  assert.ok(plan.folded.length > 0, 'folded members must be attributed, not dropped');
  const total = plan.folded.reduce((sum, entry) => sum + entry.viaCount, 0);
  assert.ok(total > 0, 'the fold must carry members');
  for (const entry of plan.folded) {
    assert.ok(entry.members.every((id) => typeof id === 'string'), 'members must be listable, not just counted');
  }
  // Summary edges exist, are marked as folded chains, and are drawn distinctly.
  const summary = plan.edges.filter((edge) => edge.kind === 'summary');
  assert.ok(summary.length > 0, 'a fold must produce a summary edge or a fold marker');
  assert.ok(summary.every((edge) => edge.declared === 'folded_chain' || edge.declared === 'folded_tail'));
  assert.ok(summary.every((edge) => edge.viaCount === edge.members.length));
});

check('an engine that answers without coordinates is refused, not drawn at the origin', async () => {
  class CoordlessElk {
    layout(graph) {
      // Exactly the shape the real engine produced inside node:vm: children
      // with sizes but no positions.
      return Promise.resolve({ id: graph.id, children: graph.children.map((c) => ({ id: c.id, width: c.width, height: c.height })) });
    }
  }
  const t = await bootFan({ ELK: CoordlessElk });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const plan = t.evalIn('state.focusLayout');
  assert.ok(plan, 'the page must still produce a picture');
  assert.equal(plan.engine, 'fallback_local', 'a coordinate-less result must fall back');
  assert.match(String(plan.engineError), /elk_returned_no_coordinates/);
  const atOrigin = plan.boxes.filter((box) => box.x === 0 && box.y === 0).length;
  assert.equal(atOrigin, 0, 'no box may be left at the origin: that picture looks deliberate and means nothing');
  assert.match(t.el('graph-status').textContent, /本地回退/);
  assert.match(t.el('graph-status').textContent, /elk_returned_no_coordinates/);
});

check('a layout that arrives after the selection moved on is discarded', async () => {
  const release = [];
  class SlowElk {
    layout(graph) {
      return new Promise((resolve) => release.push(() => resolve({ id: graph.id, children: graph.children.map((c, i) => ({ id: c.id, x: 10 + i * 20, y: 10, width: c.width, height: c.height })) })));
    }
  }
  const t = await bootFan({ ELK: SlowElk });
  const firstGeneration = t.evalIn('state.layoutGen');
  assert.ok(release.length >= 1, 'the first selection must have started a layout');
  const started = release.length;
  // The selection moves on before that layout comes back.
  await t.run(`select(${JSON.stringify(FN_B)})`);
  assert.notEqual(t.evalIn('state.layoutGen'), firstGeneration, 'the generation must have advanced');
  // Release every layout started for the old selection; none may be adopted.
  for (let i = 0; i < started; i++) release[i]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stale = t.evalIn('state.focusLayout');
  assert.ok(!stale || stale.stale !== true, 'a stale result must not be adopted');
  if (stale) assert.notEqual(stale.model.targetId, FN_A.id, 'the target must be the new selection');
});
// --- F1: the workspace shell -------------------------------------------------
// The left rail is a server search now. What the page must never do again is
// page through id-ordered nodes locally and call that "the project searched".
// These checks pin: the /api/search contract is used and echoed honestly, an
// empty result reads differently from a failure, a delayed answer from a
// previous keystroke or selection lands nowhere, and one resource failing does
// not blank the ones that succeeded.
function searchPage(query, items, over = {}) {
  return Object.assign({
    analysis_id: report.id, query, total: items.length, items, next_cursor: null,
  }, over);
}

check('the left rail searches the server and shows matches, not a local filter', async () => {
  const t = boot(routeBase());
  const calls = [];
  t.routes.search = (params) => {
    calls.push(params);
    const q = String(params.q || '');
    const items = [FN_A, FN_B].filter((n) => n.name.toLowerCase().includes(q.toLowerCase()));
    return searchPage(q, items, { total: items.length + 40, next_cursor: items.length ? 'cur:100' : null });
  };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.ok(calls.length >= 1, 'connect must seed the rail with a search');
  assert.equal(calls[0].kind, 'function', 'the rail asks for functions');
  assert.ok(String(calls[0].limit) > 0, 'the rail bounds its page');

  t.el('fn-search').value = 'fnB';
  await t.run('runSearch()');
  assert.equal(calls[calls.length - 1].q, 'fnB', 'the query travels to the server');
  const texts = collect(t.el('fn-list')).map((n) => n.textContent || '').join(' | ');
  assert.match(texts, /fnB/, 'the matching function is listed');
  assert.match(texts, /a\.js/, 'grouped by file so same names are tellable apart');
  assert.match(t.el('fn-count').textContent, /匹配 41 个 · 已显示前 1 个/, 'the rail reports match count and shown count, not silent truncation');
  assert.equal(t.el('fn-more').hidden, false, 'a next_cursor offers more, it does not hide the tail');
});

check('an empty search result and a failed search read differently', async () => {
  const t = boot(routeBase());
  t.routes.search = searchPage('zzz', []);
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  t.el('fn-search').value = 'zzz';
  await t.run('runSearch()');
  const texts = collect(t.el('fn-list')).map((n) => n.textContent || '').join(' | ');
  assert.match(texts, /没有匹配的函数/, 'an empty result is said, with the query echoed');
  assert.equal(t.el('fn-list').className, '', 'no error styling on an honest empty');

  t.routes.search = { __status: 500 };
  await t.run('runSearch()');
  const failed = collect(t.el('fn-list')).map((n) => n.textContent || '').join(' | ');
  assert.match(failed, /搜索失败/, 'a failure must be named');
  assert.match(failed, /重试/, 'and a retry must be offered');
  assert.equal(t.el('fn-more').hidden, true, 'no pagination offered past a failure');
});

check('a slow search answer from an older keystroke never renders', async () => {
  const t = boot(routeBase());
  const release = [];
  t.routes.search = (params) => new Promise((resolve) => {
    if (params.q === 'slow') release.push(() => resolve(searchPage('slow', [FN_A])));
    else resolve(searchPage(params.q, [FN_B]));
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()'); // immediate empty-q answer
  t.el('fn-search').value = 'slow';
  const slow = t.run('runSearch()');
  t.el('fn-search').value = 'fast';
  await t.run('runSearch()'); // the newer keystroke wins the race
  const textsNow = collect(t.el('fn-list')).map((n) => n.textContent || '').join(' | ');
  assert.match(textsNow, /fnB/, 'the newer query has rendered');
  release[0]();
  await slow;
  const textsAfter = collect(t.el('fn-list')).map((n) => n.textContent || '').join(' | ');
  assert.doesNotMatch(textsAfter, /fnA/, 'the stale answer must be dropped, not appended');
  assert.match(textsAfter, /fnB/, 'and the current answer must stay');
});

check('function A proposals that land after switching to B go nowhere', async () => {
  const t = boot(routeBase());
  const release = [];
  t.routes.patches = (params) => new Promise((resolve) => {
    if (params.entity === FN_A.id) release.push(() => resolve({
      analysis_id: report.id, entity_id: FN_A.id, proposals: [proposal()],
    }));
    else resolve({ analysis_id: report.id, entity_id: FN_B.id, proposals: [] });
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  const first = t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run(`select(${JSON.stringify(FN_B)})`); // reader moves on before A answers
  release[0]();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /当前选区还没有提案/, "B's empty proposal list is what is shown");
  assert.doesNotMatch(shown, /make it exact/, "A's late proposal must not render under B");
  assert.equal(t.evalIn('state.patches.length'), 0, 'and must not enter the shared state');
});

check('source and relations fail independently, with a retry on the failed one', async () => {
  const t = boot(routeBase());
  t.routes.source = { __status: 500 };
  t.routes.reach = {
    analysis_id: report.id, direction: 'out', root: FN_A.id,
    nodes: [FN_A, FN_B],
    edges: [{ id: 'c1', kind: 'call_candidate', source: FN_A.id, target: FN_B.id, label: 'fnB', basis: 'x', path: 'a.js', start: 1, end: 2 }],
    unresolved: [], truncated: false,
  };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const sourceArea = t.el('source-status').textContent;
  assert.match(sourceArea, /源码读取失败/, 'the source panel must name its own failure');
  assert.match(collect(t.el('source-status')).map((n) => n.textContent || '').join(' '), /重试/, 'and offer its own retry');
  const graphTexts = collect(t.el('graph')).map((n) => n.textContent || '').join(' | ');
  assert.match(graphTexts, /fnB/, 'relations succeeded, so the graph must still draw');
  assert.doesNotMatch(t.el('source').textContent, /^读取固定快照/, 'the source panel must not sit on a loading line forever');

  // The retry re-asks only the failed resource, on the same generation.
  t.routes.source = { content: 'function fnA(){}', start: 0, end: 10, truncated: false, blob: 'b'.repeat(64) };
  await t.run('state.sourceRes && loadSource(state.selected, state.request)');
  assert.doesNotMatch(t.el('source-status').textContent, /源码读取失败/, 'a successful retry clears the error');
  assert.match(t.el('source').textContent, /function fnA/, 'and shows the source');
});

check('selection navigation keeps a back stack and a recent list', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.equal(t.el('nav-back').disabled, true, 'back starts disabled');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run(`select(${JSON.stringify(FN_B)})`);
  assert.equal(t.el('nav-back').disabled, false, 'a second selection enables back');
  assert.match(t.el('selection-name').textContent, /fnB/);
  await t.run('navBack()');
  assert.match(t.el('selection-name').textContent, /fnA/, 'back returns to the previous object');
  assert.equal(t.el('nav-back').disabled, true, 'and the stack is empty again');
  const recent = collect(t.el('recent-list')).map((n) => n.textContent || '').join(' | ');
  assert.match(recent, /fnB/, 'the recent list remembers the other object');
  const published = t.el('inspector');
  assert.equal(published['data-selection-entity'], FN_A.id, 'the pinned selection follows the back navigation');
});

check('task tabs exist and the run shortcut follows the selection kind', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.evalIn('setPage("review")'), true, 'the review page exists');
  assert.equal(t.evalIn('setPage("nope")'), false, 'an unknown page is refused');
  assert.equal(t.evalIn('setLens("nope")'), false, 'an unknown lens is refused');
  assert.equal(t.el('run-shortcut').disabled, false, 'a function offers the run shortcut');
  assert.equal(t.evalIn('setPage("run")'), true);
  assert.equal(t.evalIn('state.page'), 'run', 'the run page is current');
  assert.equal(t.el('exec-panel').hidden, false, 'with a profile, the execution panel shows');
  t.run('resetDetail()');
  assert.equal(t.el('run-shortcut').disabled, true, 'no selection, no run shortcut');
});

// --- F2: values and unknowns locate real source windows ----------------------
// The point of F2 is that a conclusion can show where it comes from: a value
// row or an unknown row carries a real UTF-8 byte anchor, clicking loads a
// bounded window of the pinned blob (not the disk file) with line numbers and
// a highlight, and an unknown without an anchor says so instead of pretending.
function flowFactAnchored(symbol) {
  const fact = flowFact(symbol, ['CONST_A']);
  fact.ops = [
    { index: 0, kind: 'read_local', detail: 'b:a.js:0:x', start: 0, end: 5, may_throw: false },
    { index: 1, kind: 'assign_local', detail: 'b:a.js:0:x', start: 0, end: 9, may_throw: false },
    { index: 2, kind: 'return_local', detail: 'b:a.js:0:x', start: 5, end: 10, may_throw: false },
    { index: 3, kind: 'property_read', detail: 'for_in_of_element_unknown', start: 7, end: 8, may_throw: true },
  ];
  fact.blocks = [{ id: 0, term: 'return', ops: [1, 2], successors: [] }];
  fact.block_states = [
    { block: 0, completion: 'Normal', truncated: false, bindings: [
      { binding: 'b:x', name: 'written', init: 'Initialized', defs: [1], value: {
        constants: [], typed_constants: [], targets: [], origins: ['CallResult(op1)'], reasons: [], unknown: false,
      } },
    ] },
  ];
  fact.def_use = [{ binding: 'b:x', name: 'written', defs: [1], uses: [] }];
  fact.unknown_reasons = ['for_in_of_element_unknown', 'untracked_summary_only'];
  fact.returns = { constants: [], typed_constants: [], targets: [], origins: [], reasons: [], unknown: false };
  fact.throws = { constants: [], typed_constants: [], targets: [], origins: [], reasons: [], unknown: false };
  return fact;
}

async function bootAnchored(options = {}) {
  const windows = [];
  const t = boot({
    ...routeBase(),
    flow: flowFactAnchored(FN_A.id),
    source: (params) => {
      windows.push({ start: Number(params.start), end: Number(params.end), entity: params.entity });
      return {
        content: 'line one\nline two\nline three\n', start: Number(params.start ?? 0),
        end: Number(params.end ?? 30), truncated: false, blob: 'b'.repeat(64),
        file_total_bytes: 90, start_line: Number(params.start) === 0 ? 1 : 2,
        entity_id: params.entity, path: 'a.js',
      };
    },
  }, options);
  t.windows = windows;
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  return t;
}

check('value rows carry byte anchors and clicking loads a bounded source window', async () => {
  const t = await bootAnchored();
  t.run("setLens('values')");
  const shown = t.el('flow-body').textContent;
  assert.match(shown, /written \[Initialized\]/, 'the binding row names the variable');
  assert.match(shown, /CallResult\(op1\)/, 'the origin summary comes from the published value');

  const rows = collect(t.el('flow-body')).filter((n) => (n.className || '').includes('wb-anchored'));
  assert.ok(rows.length >= 1, 'at least the binding row is anchored');
  rows[0].onclick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const win = t.windows[t.windows.length - 1];
  assert.deepEqual(
    { start: win.start, end: win.end },
    { start: 0, end: 9 + 300 > 10 ? 10 : win.end },
    'the window stays inside the entity span (pad clamped to byte 10)',
  );
  assert.equal(win.entity, FN_A.id, 'the window is pinned to the selected entity');
  const lines = collect(t.el('source')).filter((n) => (n.className || '').includes('src-line'));
  assert.ok(lines.length >= 3, 'the window renders as numbered lines');
  assert.match(t.el('source-status').textContent, /源码定位/, 'the panel names what was located');
  assert.match(t.el('source-status').textContent, /显示完整对象/, 'and offers the way back');
});

check('unknown rows with anchors locate, anchor-less unknowns say so', async () => {
  const t = await bootAnchored();
  t.run("setLens('unknowns')");
  const shown = t.el('unknown-body').textContent;
  assert.match(shown, /for_in_of_element_unknown · 1 处可定位/, 'an anchored unknown offers a locate');
  assert.match(shown, /untracked_summary_only · 无单一源码锚点/, 'a summary-only unknown admits it has no anchor');

  const anchored = collect(t.el('unknown-body')).find((n) => (n.className || '').includes('wb-anchored'));
  anchored.onclick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const win = t.windows[t.windows.length - 1];
  // op bytes are 7-8; the padded window is clamped to the entity's own span (0..10).
  assert.deepEqual({ start: win.start, end: win.end }, { start: 0, end: 10 }, 'the unknown locates its op bytes, clamped to the entity');
  const hl = collect(t.el('source')).filter((n) => (n.className || '').includes('src-hl'));
  assert.ok(hl.length >= 1, 'the located line is highlighted');
});

check('a failed source window reports the failure and keeps the old view', async () => {
  const t = await bootAnchored();
  t.routes.source = { __status: 400 };
  t.run("setLens('values')");
  const rows = collect(t.el('flow-body')).filter((n) => (n.className || '').includes('wb-anchored'));
  rows[0].onclick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(t.el('status').textContent, /源码定位失败/, 'the failure must be named');
  assert.ok(t.el('source').textContent.includes('line'), 'the previous source view is not blanked');
});

check('diagnostics unknowns open the file at the real byte window', async () => {
  const t = boot(routeBase());
  t.routes.report = { ...report, diagnostics: [
    { code: 'unparsed_construct', path: 'a.js', detail: 'dynamic_dispatch 4 9' },
  ] };
  const windows = [];
  t.routes.source = (params) => {
    windows.push({ start: Number(params.start), end: Number(params.end) });
    return { content: 'abcd efgh ij', start: Number(params.start ?? 0), end: Number(params.end ?? 12),
      truncated: false, blob: 'b'.repeat(64), file_total_bytes: 12, start_line: 1, entity_id: params.entity };
  };
  t.routes.node = (params) => ({ analysis_id: report.id, node: { id: 'file:a.js', kind: 'file', name: 'a.js', path: 'a.js', start: 0, end: 12 } });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  t.run("setLens('unknowns')");
  await t.run(`openUnknownRegion(${JSON.stringify({ code: 'unparsed_construct', path: 'a.js', detail: 'dynamic_dispatch 4 9' })})`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(t.windows || windows.length, 'a window request must have been made');
  const win = windows[windows.length - 1];
  assert.deepEqual({ start: win.start, end: win.end }, { start: 0, end: 12 },
    'the file window is padded around the reported bytes and clamped to the file');
});

// --- F3: the run form ---------------------------------------------------------
// The form is the product surface of a run: per-parameter inputs driven by the
// published profile, declared receiver/globals only where the profile asks for
// them, inline input errors that never POST, and a history that can refill an
// input without auto-running. The run button follows the profile exactly as
// before; the form changes where the arguments come from.
function profileWithParams() {
  return profile({
    params: [{ index: 0, name: 'coupon' }, { index: 1, name: 'order' }],
    arity: 2,
    required_context: ['this_arg', 'globals'],
    required_globals: ['MAX_DISCOUNT'],
  });
}

check('the form renders per-parameter inputs and posts the declared inputs', async () => {
  const t = boot(routeBase());
  t.routes.profile = profileWithParams();
  t.routes.exec = record();
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('exec-form').hidden, false, 'the form shows for a classified function');
  assert.equal(t.el('exec-param-0').tagName, 'TEXTAREA', 'parameter 0 has its own field');
  assert.match(collect(t.el('exec-fields')).map((n) => n.textContent || '').join(' '), /coupon/, 'the published parameter name labels the field');
  assert.ok(t.el('exec-receiver'), 'a this_arg requirement gets a receiver input');
  const globalsInputs = collect(t.el('exec-context')).filter((n) => (n.id || '').startsWith('exec-global'));
  assert.ok(globalsInputs.length >= 1, 'named globals get inputs');

  // Fill per parameter: draft lives per selection.
  t.el('exec-param-0').value = '{"amount":100}';
  t.el('exec-param-0').oninput();
  t.el('exec-param-1').value = '[1,2]';
  t.el('exec-param-1').oninput();
  t.el('exec-receiver').value = '{"account":"A"}';
  t.el('exec-receiver').oninput();
  t.el('exec-global-0').value = '500';
  t.el('exec-global-0').oninput();
  await t.run('runControlled()');
  const posted = t.requests.filter((r) => r.name === 'exec');
  assert.equal(posted.length, 1, 'exactly one run requested');
  const body = JSON.parse(posted[0].body);
  assert.deepEqual(body.args, [{ amount: 100 }, [1, 2]], 'the per-parameter fields become the positional args');
  assert.deepEqual(body.this_arg, { account: 'A' }, 'the receiver is declared, not guessed');
  assert.deepEqual(body.globals, { MAX_DISCOUNT: 500 }, 'named globals travel as inputs');
});

check('an empty parameter field or bad JSON shows an inline error and never POSTs', async () => {
  const t = boot(routeBase());
  t.routes.profile = profileWithParams();
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('runControlled()');
  assert.equal(t.el('exec-input-error').hidden, false, 'the error shows next to the form');
  assert.match(t.el('exec-input-error').textContent, /coupon/, 'it names the offending parameter');
  assert.equal(t.requests.filter((r) => r.name === 'exec').length, 0, 'no run is requested');

  t.el('exec-param-0').value = '{not json';
  t.el('exec-param-0').oninput();
  await t.run('runControlled()');
  assert.match(t.el('exec-input-error').textContent, /输入格式不正确/, 'bad JSON is an input error');
  assert.equal(t.requests.filter((r) => r.name === 'exec').length, 0, 'still nothing posted');
});

check('a profile without context needs shows no receiver or globals inputs', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('exec-context')._children.length, 0, 'no context inputs the profile did not ask for');
});

check('history lists records and refills the form without auto-running', async () => {
  const t = boot(routeBase());
  t.routes.profile = profileWithParams();
  t.routes['exec-records'] = [{
    id: 'r1', verdict: 'returned', duration_ms: 12, symbol: FN_A.id,
    spec: { args: [{ amount: 7 }, []], this_arg: null, globals: { MAX_DISCOUNT: 50 } },
  }];
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t.el('exec-history-panel').hidden, false, 'history shows for a function');
  assert.match(t.el('exec-history').textContent, /returned/, 'the verdict is listed');
  const before = t.requests.filter((r) => r.name === 'exec').length;
  await t.run('refillFromRecord(state.execRecords[0])');
  assert.equal(t.requests.filter((r) => r.name === 'exec').length, before, 'refill never auto-runs');
  assert.match(t.el('exec-param-0').value, /"amount":7/, 'parameter 0 was refilled from the record');
  assert.equal(t.el('exec-global-0').value, '50', 'globals refill too');
});

// --- F4: page-triggered verification -----------------------------------------
// The page may start a verification (the server owns every execution
// parameter) and must show the honest answer: a queued job that ends with
// test.ran:false is "no test ran", never "passed". A rejected proposal offers
// no verify button at all, and switching selections stops the polling from
// attaching results to another proposal.
check('a proposed patch offers verify, which queues and then reports honestly', async () => {
  const t = boot(routeBase());
  t.routes.patches = { analysis_id: report.id, entity_id: FN_A.id, proposals: [proposal()] };
  t.routes['patch/verify'] = { outcome: 'queued', job: { id: 'j1', state: 'queued' } };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const verifyButtons = collect(t.el('patch-body')).filter((n) => (n.textContent || '') === '验证（隔离副本重新派生分析）');
  assert.ok(verifyButtons.length >= 1, 'a proposed+validated proposal offers a verify action');
  assert.equal(verifyButtons.filter((n) => n.tagName === 'BUTTON').length, 1, 'exactly one verify button (not its container)');
  await t.run('startVerify(' + JSON.stringify('p'.repeat(64)) + ')');
  const posted = t.requests.filter((r) => r.name === 'patch/verify' && r.body);
  assert.equal(posted.length, 1, 'verify POSTs to the server endpoint');
  assert.equal(JSON.parse(posted[0].body).id, 'p'.repeat(64), 'the proposal id travels unchanged');
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /验证中…/, 'the button shows the in-flight state');
});

check('a rejected proposal offers no verify button', async () => {
  const t = boot(routeBase());
  t.routes.patches = { analysis_id: report.id, entity_id: FN_A.id, proposals: [proposal({
    proposal: { validation: { ok: false, reason: 'patch_does_not_apply:src/a.js:上下文不匹配' } },
    outer: { state: 'rejected' },
  })] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const shown = t.el('patch-body').textContent;
  assert.doesNotMatch(shown, /验证（隔离副本重新派生分析）/, 'an unverifiable proposal has no verify button');
});

check('a finished verification poll refreshes the proposal list for the same selection', async () => {
  const t = boot(routeBase());
  t.routes.patches = { analysis_id: report.id, entity_id: FN_A.id, proposals: [proposal()] };
  t.routes['patch/verify'] = { outcome: 'queued', job: { id: 'j1', state: 'queued' } };
  let pollCount = 0;
  t.routes['patch/verify'] = (params) => {
    pollCount += 1;
    if (pollCount < 2) return { proposal: proposal(), job: { id: 'j1', state: 'running' } };
    return { proposal: proposal({
      outer: { state: 'verified',
        verification: { base_analysis_id: report.id, patched_analysis_id: 'q'.repeat(64),
          graph_diff: { nodes: { changed_count: 1 } }, test: { observed: false, ran: false } } },
    }), job: { id: 'j1', state: 'completed' } };
  };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('startVerify(' + JSON.stringify('p'.repeat(64)) + ')');
  await new Promise((resolve) => setTimeout(resolve, 4600));
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /还没有验证|变更节点/, 'after completion the list is refreshed');
  assert.match(t.el('status').textContent, /验证完成/, 'the completion is announced');
});

// --- F5: the task survives navigation ----------------------------------------
// The current task (tab + lens) travels in the URL fragment next to the
// selection, so closing the page or round-tripping through the 3D city puts
// the reader back into the same task. The fragment never carries inputs.
check('tab and lens persist in the fragment and restore on boot', async () => {
  const t = boot(routeBase(), { hash: `#page=run&lens=unknowns` });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  assert.equal(t.evalIn('state.page'), 'run', 'the fragment restores the page');
  assert.equal(t.evalIn('state.lens'), 'unknowns', 'and the lens');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const hash = await t.run('decodeURIComponent(location.hash)');
  assert.match(hash, /page=run/, 'selection updates keep the page in the fragment');
  assert.doesNotMatch(hash, /lens=/, 'a lens is only recorded where it means something');
  const set = t.run('setPage("review") && setLens("values")');
  assert.equal(set, true);
  const after = await t.run('location.hash');
  assert.match(after, /page=review/, 'a page switch rewrites the fragment');
  assert.doesNotMatch(after, /lens=/, 'lens only travels under explore');

  // 旧链接用 mode=understand/structure，落到等价的新页面而不是丢状态。
  const legacy = boot(routeBase(), { hash: '#mode=understand&lens=values' });
  legacy.el('token').value = 'TOKEN-1';
  await legacy.run('connect()');
  assert.equal(legacy.evalIn('state.page'), 'explore', 'a legacy mode link lands on explore');
  assert.equal(legacy.evalIn('state.lens'), 'values', 'and keeps its lens');
});

// --- D0: review findings R1/R4 ------------------------------------------------
check('drawn boxes sit on the layout coordinates their ports use (R4)', async () => {
  const t = await bootFan();
  const plan = t.evalIn('state.focusLayout');
  assert.ok(plan, 'a layout plan exists');
  const rects = collect(t.el('graph')).filter((n) => (n['#tag'] === 'rect') || (n.className === '' && n.x !== undefined && n.width !== undefined));
  const drawn = collect(t.el('graph')).map((n) => ({ x: Number(n.x), width: Number(n.width), tag: n['#tag'] || n.id }));
  for (const box of plan.boxes) {
    const match = drawn.find((r) => Number.isFinite(r.x) && r.width === box.w && Math.abs(r.x - box.x) < 0.001);
    assert.ok(match, `box ${box.label} must be drawn at its layout left edge ${box.x} (not its centre)`);
  }
});

check('verifying a second proposal still POSTs after navigating away mid-verify (R1)', async () => {
  const t = boot(routeBase());
  const posts = [];
  t.routes['patch/verify'] = { outcome: 'queued', job: { id: 'j1', state: 'running' } };
  t.routes.patches = (params) => ({
    analysis_id: report.id, entity_id: params.entity,
    proposals: [
      proposal({ id: 'p'.repeat(64) }),
      proposal({ id: 'q'.repeat(64) }),
    ],
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('startVerify(' + JSON.stringify('p'.repeat(64)) + ')');
  await t.run(`select(${JSON.stringify(FN_B)})`); // navigate away mid-verify
  await t.run('startVerify(' + JSON.stringify('q'.repeat(64)) + ')'); // another proposal must not be blocked
  for (const r of t.requests) if (r.name === 'patch/verify' && r.body) posts.push(JSON.parse(r.body).id);
  assert.deepEqual(posts.sort(), ['p'.repeat(64), 'q'.repeat(64)], 'both verifications reached the server');
  assert.equal(t.evalIn('Object.keys(verifyPolls).length'), 2, 'both polls track their own job');
});

check('run inputs persist locally and restore after a fresh boot', async () => {
  const sharedStorage = new Map();
  const routes0 = routeBase();
  routes0.profile = profileWithParams();
  const t = boot(routes0, { sharedStorage });
  t.routes.profile = profileWithParams();
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  t.el('exec-param-0').value = '{"amount":42}';
  t.el('exec-param-0').oninput();
  // fresh boot: same origin storage, same analysis
  const t2 = boot(routeBase(), { sharedStorage });
  t2.routes.profile = profileWithParams();
  t2.el('token').value = 'TOKEN-1';
  await t2.run('connect()');
  await t2.run(`select(${JSON.stringify(FN_A)})`);
  assert.equal(t2.el('exec-param-0').value, '{"amount":42}', 'the refilled input survives a reload');
});

// --- U2/U3/U4/U5（界面 v2 本轮）：结果层级、后台任务、提案选择、项目入口 ------
// 这些检查钉住本轮新增的用户操作：结果页签展示同一份记录的不同侧面、后台
// 任务能找回并取消、审阅页按提案选择、项目设置真实生效、项目切换入口存在。

check('the run result leads with the verdict and splits inputs and logs into tabs', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.routes.exec = record({
    console: { stdout: 'hello from stdout\n', stderr: '', truncated: false, harness_lines: [] },
  });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  t.el('exec-args').value = '[17,23]';
  await t.run(`execDraft(${JSON.stringify(FN_A.id)}).advanced = true`);
  await t.run('renderExecForm(state.execProfile)');
  await t.run('runControlled()');
  const shown = t.el('exec-result').textContent;
  assert.match(shown, /返回值/, 'the hero names the outcome kind');
  assert.match(shown, /观测结果 returned/, 'the meta line keeps the machine verdict');

  await t.run(`state.execTab = 'inputs'; renderExecResult()`);
  const inputs = t.el('exec-result').textContent;
  assert.match(inputs, /args \[17,23\]/, 'the inputs tab shows the full declared args');

  await t.run(`state.execTab = 'logs'; renderExecResult()`);
  const logs = t.el('exec-result').textContent;
  assert.match(logs, /hello from stdout/, 'the logs tab shows real stdout');
  t.routes.exec = record({ console: { stdout: '', stderr: '', truncated: false, harness_lines: [] } });
  await t.run('runControlled()');
  await t.run(`state.execTab = 'logs'; renderExecResult()`);
  assert.match(t.el('exec-result').textContent, /没有控制台输出/, 'an empty log says so');
});

check('background tasks list real runs, cancel through the server and reopen results', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.routes.exec = record({ value: { kind: 'number', value: 40 } });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('runControlled()');
  // 服务端清单里出现这一次运行（run-1 是测试 fetch 分配的 id）。
  t.routes['exec/runs'] = { runs: [{ run_id: 'run-1', symbol: FN_A.id, state: 'completed', verdict: 'returned' }] };
  await t.run('loadTasks()');
  const listed = t.el('tasks-body').textContent;
  assert.match(listed, /fnA/, 'the task names its target object');
  assert.match(listed, /已完成/, 'the terminal state comes from the server list');

  const badge = t.el('nav-task-count');
  t.routes['exec/runs'] = { runs: [{ run_id: 'run-2', symbol: FN_A.id, state: 'running' }] };
  await t.run('loadTasks()');
  assert.equal(badge.hidden, false, 'a running task is visible as a count in the nav');
  assert.match(badge.textContent, /^1$/, 'and the count is the number of running tasks');
  const running = t.el('tasks-body').textContent;
  assert.match(running, /运行中/, 'the running state is named');
  const cancelButtons = [];
  collect(t.el('tasks-body'), cancelButtons);
  assert.ok(cancelButtons.some((el) => el.textContent === '取消'), 'a running task offers a cancel');
  await t.run(`cancelTaskRun('run-2')`);
  assert.ok(t.requests.some((r) => r.name === 'exec/cancel'), 'cancelling posts to the server');

  // 「查看结果」把读者带回运行页，并显示该 run 的终态记录。
  await t.run(`openTaskResult({ run_id: 'run-1', symbol: ${JSON.stringify(FN_A.id)}, state: 'completed' })`);
  assert.equal(t.evalIn('state.page'), 'run', 'the result opens on the run page');
  assert.match(t.el('exec-result').textContent, /返回值 40/, 'the reopened result is the same record');
});

check('the review page selects one proposal and the agent entry lands on the same one', async () => {
  const idA = 'a'.repeat(64), idB = 'b'.repeat(64);
  const t = boot(routeBase());
  const mk = (id, summary) => proposal({ outer: { id, state: 'proposed', proposed_by: 'model-x' }, proposal: { summary, diff: `--- a/${summary}\n+++ b/${summary}\n@@ -1,1 +1,1 @@\n-x\n+y\n`, validation: { ok: true, hunks: 1, patched_paths: [summary] } } });
  t.routes.patches = { proposals: [mk(idA, 'first-fix.js'), mk(idB, 'second-fix.js')] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  // 默认选中第一份，但列表里两份都在。
  const listed = t.el('patch-body').textContent;
  assert.match(listed, /first-fix\.js/, 'both proposals are listed');
  assert.match(listed, /second-fix\.js/, 'and neither is hidden');
  // Agent 页跳转必须定位到指定提案。
  await t.run(`setPage('agent'); renderAgentProposals()`);
  await t.run(`locateProposal(${JSON.stringify(idB)})`);
  assert.equal(t.evalIn('state.page'), 'review', 'the entry lands on the review page');
  assert.equal(t.evalIn('state.reviewSelected'), idB, 'the named proposal is the selected one');
  const center = t.el('review-center-inner').textContent;
  assert.match(center, /second-fix\.js/, 'the center diff belongs to the selected proposal');
  assert.doesNotMatch(center, /first-fix\.js/, 'the previous proposal must not bleed into the diff');
});

check('project settings PUT the declared argv and take effect in the shown config', async () => {
  const t = boot(routeBase());
  t.routes['project/settings'] = { saved: true, test_argv: ['node', '--test'], test_timeout_ms: 45000 };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run('setPage("home"); renderPageContent("home")');
  const body = t.el('home-settings-body').textContent;
  assert.match(body, /测试命令/, 'the settings form names the declared test command');
  t.el('settings-test-argv').value = '["node","--test"]';
  t.el('settings-test-timeout').value = '45000';
  const save = (() => { const out = []; collect(t.el('home-settings-body'), out); return out.find((el) => el.textContent === '保存并生效'); })();
  assert.ok(save, 'a save control exists');
  await save.onclick();
  const posted = t.requests.filter((r) => r.name === 'project/settings');
  assert.equal(posted.length, 1, 'saving posts exactly once');
  const bodyJson = JSON.parse(posted[0].body);
  assert.deepEqual(bodyJson.test_argv, ['node', '--test'], 'the declared argv is sent');
  assert.equal(bodyJson.test_timeout_ms, 45000, 'and the timeout');
  assert.match(t.el('status').textContent, /已生效/, 'the page says the setting now applies');
});

check('the project page opens a directory, lists recent projects and switches', async () => {
  const t = boot(routeBase());
  let openCalls = 0;
  t.routes['project/open'] = (params) => {
    if (params.id) return { schema: 'atlas.project-open.v1', op_id: params.id, state: 'switched', analysis_id: 'd'.repeat(64) };
    openCalls += 1;
    return { schema: 'atlas.project-open.v1', outcome: 'indexing', op_id: 'op-1' };
  };
  t.routes.projects = { projects: [
    { path: '/tmp/one', name: 'one', analysis_id: 'c'.repeat(64), current: true },
    { path: '/tmp/two', name: 'two', analysis_id: 'd'.repeat(64), current: false },
  ] };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run('setPage("home"); renderPageContent("home")');
  const recent = t.el('home-recent-body').textContent;
  assert.match(recent, /two/, 'the recent list shows the other project');
  assert.match(recent, /继续这个项目/, 'and offers to switch to it');

  t.el('home-open-path').value = '/tmp/newproj';
  await t.run('openProjectByPath()');
  const posted = t.requests.filter((r) => r.name === 'project/open');
  assert.equal(openCalls, 1, 'opening posts once');
  assert.equal(JSON.parse(posted[0].body).path, '/tmp/newproj', 'the typed path is sent');
  await new Promise((r) => setTimeout(r, 60));
  assert.match(t.el('status').textContent, /已切换|切换|新分析|正在加载/, 'the page reports the switch');
});

check('an applied proposal from the previous analysis stays reachable for revert after a re-index', async () => {
  const t = boot(routeBase());
  // 服务已切到新分析（report.id），而提案固定在旧分析上；按实体查不到它，
  // 只有按应用目录（target=here）的查询能把它找回来。
  const oldAnalysis = 'e'.repeat(64);
  const id = 'w'.repeat(64);
  t.routes.contract = { writes: { enabled: true, root: '/tmp/checkout' }, endpoints: [] };
  t.routes.patches = (params) => {
    if (params.target === 'here') {
      return { proposals: [{ id, analysis_id: oldAnalysis, state: 'applied', proposed_by: 'session-1', target: '/tmp/checkout',
        proposal: { summary: 'fix checkout', diff: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n',
          validation: { ok: true, hunks: 1, patched_paths: ['x'] } } }] };
    }
    return { proposals: [] };
  };
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const shown = t.el('patch-body').textContent;
  assert.match(shown, /之前的分析/, 'the cross-version origin must be named');
  assert.match(shown, /一键撤销/, 'revert stays reachable from the page');
  assert.match(shown, /打开新版本/, 'so does the re-index entry');
  await t.run(`writePatch('patch/revert','${id}','/tmp/checkout')`);
  assert.ok(t.requests.some((r) => r.name === 'patch/revert'), 'revert posts once clicked');
});


check('drafts are scoped to project|version|object, never shared across projects', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run(`execDraft(${JSON.stringify(FN_A.id)}).fields[0] = '719'`);
  // 另一个项目：同一 entity id、不同分析。
  await t.run(`state.report = { id: ${JSON.stringify('f'.repeat(64))} }`);
  const fresh = await t.run(`JSON.stringify(execDraft(${JSON.stringify(FN_A.id)}).fields)`);
  assert.equal(fresh, '{}', 'the same-named function in another project must not inherit the draft');
  // 回到原分析：草稿还在。
  await t.run(`state.report = { id: ${JSON.stringify(report.id)} }`);
  const restored = await t.run(`execDraft(${JSON.stringify(FN_A.id)}).fields[0]`);
  assert.equal(restored, '719', 'the original project keeps its draft');
});

check('switching functions clears the previous result card', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.routes.exec = record({ value: { kind: 'number', value: 15 } });
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  await t.run('runControlled()');
  assert.match(t.el('exec-result').textContent, /返回值 15/, 'the run result is shown for fnA');
  await t.run(`select(${JSON.stringify(FN_B)})`);
  assert.doesNotMatch(t.el('exec-result').textContent, /返回值 15/, 'fnB must not inherit fnA\'s result card');
});

check('a task from another analysis is refused as the current result, and labeled in the list', async () => {
  const t = boot(routeBase());
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  const foreign = 'e'.repeat(64);
  t.routes['exec/runs'] = { runs: [{ run_id: 'run-9', symbol: FN_A.id, analysis_id: foreign, state: 'completed', verdict: 'returned' }] };
  await t.run('loadTasks()');
  const listed = t.el('tasks-body').textContent;
  assert.match(listed, /属于分析/, 'a foreign task is labeled with its own analysis');
  await t.run(`openTaskResult({ run_id: 'run-9', symbol: ${JSON.stringify(FN_A.id)}, analysis_id: ${JSON.stringify(foreign)}, state: 'completed' })`);
  assert.match(t.el('status').textContent, /不是当前项目|属于分析/, 'opening it as the current result is refused');
});

check('a result record is labeled with its own analysis, not the served one', async () => {
  const t = boot(routeBase());
  t.routes.profile = profile();
  t.el('token').value = 'TOKEN-1';
  await t.run('connect()');
  await t.run(`select(${JSON.stringify(FN_A)})`);
  const foreign = 'e'.repeat(64);
  const stale = record({ value: { kind: 'number', value: 15 }, analysis_id: foreign });
  await t.run(`state.execResult = { record: ${JSON.stringify(stale)}, args: [19, 4], via: null, symbol: ${JSON.stringify(FN_A.id)} }; renderExecResult()`);
  const shown = t.el('exec-result').textContent;
  assert.match(shown, /不是当前版本/, 'a foreign record is explicitly not the current observation');
  assert.match(shown, new RegExp(foreign.slice(0, 12)), 'and names its own analysis');
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
