import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../src/parse.mjs';

const facts = files => parse({schema:'atlas.parse-request.v1',snapshot_id:'fixed-snapshot',files:Object.entries(files).map(([path,content])=>({path,content}))});
const flowOf = (f, name) => f.flow.functions.find(fn => fn.name === name);

test('flow IR carries version, profile and per-function anchors', () => {
  const f = facts({'a.js': 'function add(a, b) { return a + b; }'});
  assert.equal(f.flow.schema, 'atlas.flow-ir.v1');
  assert.equal(f.flow.profile, 'js-structured-control.v1');
  const add = flowOf(f, 'add');
  assert.equal(add.path, 'a.js');
  assert.equal(add.start, f.symbols.find(s => s.name === 'add').start);
  assert.equal(add.params.length, 2);
  assert.equal(add.bindings.find(b => b.kind === 'param' && b.name === 'a').scope, add.scopes[0].id);
});

test('block shadowing produces distinct binding ids (D01)', () => {
  const f = facts({'a.js': 'function f(x) { let y = 1; { let y = 2; y = y + 1; } return y; }'});
  const outer = f.flow.functions[0].bindings.filter(b => b.name === 'y');
  assert.equal(outer.length, 2, 'shadowed y must be two distinct bindings');
  assert.notEqual(outer[0].id, outer[1].id);
  assert.ok(outer.every(b => b.decl_start !== b.decl_end || b.id.startsWith('b:')));
});

test('TDZ use-before-declare still resolves to the real binding (D01)', () => {
  const f = facts({'a.js': 'function f() { run(); let late = 1; function run() { return late; } }'});
  const run = flowOf(f, 'run');
  const reads = JSON.stringify(run.body);
  assert.ok(!reads.includes('b:a.js:0:late') || run.captures.length === 1, `late must resolve or be captured: ${reads}`);
  assert.deepEqual(run.captures, ['b:a.js:26:late']);
});

test('short-circuit and conditional operators become structured control (D02)', () => {
  const f = facts({'a.js': 'function f(a, b) { return a && b() || null; }'});
  const ret = f.flow.functions[0].body[0];
  const alt = ret.value;
  assert.equal(alt.expr, 'short_circuit');
  assert.equal(alt.op, '||');
  assert.equal(alt.left.expr, 'short_circuit');
  assert.equal(alt.left.op, '&&');
});

test('try/catch/finally lowers with catch param binding and anchors (D03/D04)', () => {
  const f = facts({'a.js': 'function f() { try { risky(); } catch (error) { log(error); } finally { done(); } }'});
  const tryStmt = f.flow.functions[0].body[0];
  assert.equal(tryStmt.stmt, 'try');
  assert.ok(tryStmt.catch_param.startsWith('b:a.js:'));
  assert.equal(f.flow.functions[0].bindings.find(b => b.id === tryStmt.catch_param).kind, 'catch');
});

test('labeled break/continue keep labels (D05)', () => {
  const f = facts({'a.js': 'function f() { outer: for (let i = 0; i < 3; i = i + 1) { while (true) { break outer; } } }'});
  const labeled = f.flow.functions[0].body[0];
  assert.equal(labeled.stmt, 'labeled');
  assert.equal(labeled.label, 'outer');
  assert.equal(labeled.body.stmt, 'for');
});

test('unsupported constructs are explicit unknowns with reasons (profile boundary)', () => {
  const f = facts({'a.js': 'function f(list) { for (const item of list) { item(); } }'});
  assert.equal(f.flow.functions[0].body[0].stmt, 'unknown');
  assert.equal(f.flow.functions[0].body[0].reason, 'for_in_of_iteration');
  assert.ok(f.flow.diagnostics.some(d => d.code === 'FLOW_UNKNOWN_REGION'));
});

test('module peers resolve to bindings and are recorded as captures (D14 setup)', () => {
  const f = facts({'a.js': 'function inner() { return helper(); } function helper() { return 1; }'});
  const inner = flowOf(f, 'inner');
  const callExpr = inner.body[0].value;
  assert.equal(inner.body[0].stmt, 'return');
  assert.equal(callExpr.expr, 'call');
  const callee = callExpr.callee;
  assert.equal(callee.expr, 'local');
  assert.ok(callee.binding.startsWith('b:a.js:'));
  assert.deepEqual(inner.captures, [callee.binding]);
});

test('object and array literals keep field names and element anchors', () => {
  const f = facts({'a.js': 'function f(a) { return {x: a, y: 2}; }'});
  const ret = f.flow.functions[0].body[0];
  assert.equal(ret.value.expr, 'object_literal');
  assert.deepEqual(ret.value.fields.map(field => field.name), ['x', 'y']);
});

test('destructuring declarations become explicit unknowns, not silent copies (profile)', () => {
  const f = facts({'a.js': 'function f(pair) { const [x, y] = pair; return x; }'});
  const body = JSON.stringify(f.flow.functions[0].body);
  assert.ok(body.includes('destructuring_declaration'), body);
});

test('alpha-renaming preserves flow structure modulo identity (D21)', () => {
  const strip = (fn) => JSON.stringify(fn.body, (key, value) =>
    ['binding', 'name', 'captures', 'start', 'end', 'decl_start', 'decl_end', 'scope', 'decl_end'].includes(key) ? undefined : value);
  const a = facts({'a.js': 'function f(score) { let total = 0; while (total < 10) { total = total + score; } return total; }'});
  const b = facts({'a.js': 'function f(s) { let t = 0; while (t < 10) { t = t + s; } return t; }'});
  assert.equal(strip(a.flow.functions[0]), strip(b.flow.functions[0]),
    'alpha-renamed functions must lower to the same flow structure');
});

// The worker folds some global names to constants by text. That fold is only
// valid while no binding shadows the name, so every folded name needs a
// shadowing case here; adding a fold without adding a case is the regression
// these tests exist to catch.
test('a folded global name loses to a shadowing binding (V-08b)', () => {
  const reads = {
    param: () => flowOf(facts({'a.js': 'function f(undefined) { return undefined; }'}), 'f').body[0].value,
    let: () => flowOf(facts({'a.js': 'function f() { let undefined = 1; return undefined; }'}), 'f').body[1].value,
    var: () => flowOf(facts({'a.js': 'function f() { var undefined = 1; return undefined; }'}), 'f').body[1].value,
    nested: () => flowOf(facts({'a.js': 'function f() { function g(undefined) { return undefined; } return g; }'}), 'g').body[0].value,
    catch: () => flowOf(facts({'a.js': 'function f() { try { risky(); } catch (undefined) { return undefined; } }'}), 'f').body[0].catch_body[0].value,
  };
  for (const [kind, read] of Object.entries(reads)) {
    const value = read();
    assert.equal(value.expr, 'local', `${kind}: a shadowing binding must be read, not folded: ${JSON.stringify(value)}`);
    assert.ok(value.binding.startsWith('b:'), `${kind}: the read must point at a real binding: ${JSON.stringify(value)}`);
  }
});

test('the unshadowed global undefined still folds to a constant (V-08b)', () => {
  const value = flowOf(facts({'a.js': 'function f() { return undefined; }'}), 'f').body[0].value;
  assert.equal(value.expr, 'const');
  assert.equal(value.value.const, 'undefined');
});

test('non-finite numeric literals are explicit unknowns, not unwireable constants', () => {
  const fn = flowOf(facts({'a.js': 'function f() { return 1e999; }'}), 'f');
  const value = fn.body[0].value;
  assert.equal(value.expr, 'unknown');
  assert.equal(value.reason, 'non_finite_numeric_literal');
  // The whole response must survive JSON, because Infinity becomes null there
  // and the engine rejects a null number for every file, not just this one.
  assert.equal(JSON.stringify(fn).includes('"num"'), false, 'a non-finite literal must not be emitted as a num constant');
  assert.equal(JSON.parse(JSON.stringify(fn)).body[0].value.reason, 'non_finite_numeric_literal');
});

test('finite numeric literals are unaffected by the non-finite guard', () => {
  const value = flowOf(facts({'a.js': 'function f() { return 1e308; }'}), 'f').body[0].value;
  assert.equal(value.expr, 'const');
  assert.equal(value.value.const, 'num');
  assert.equal(value.value.value, 1e308);
});

test('a nested function keeps its own declarations out of the enclosing function (GE-2 regression)', () => {
  // Found by indexing the real rxjs@7.8.1 tree: `src/internal/Observable.ts`
  // declares `let value` inside a Promise executor arrow. The enclosing method
  // used to claim that binding for itself while collecting declarations, so the
  // arrow's own declarator referenced a binding it did not declare and the Rust
  // validator refused the whole response as flow_reference_unknown_binding.
  const source = [
    'class A {',
    '  m() {',
    '    return new Promise((resolve, reject) => {',
    '      let value;',
    '      this.subscribe(',
    '        (x) => (value = x),',
    '        (err) => reject(err),',
    '        () => resolve(value)',
    '      );',
    '    });',
    '  }',
    '}',
  ].join('\n');
  const parsed = facts({'a.ts': source});
  // The invariant the Rust validator enforces, checked here over every emitted
  // function: each binding reference must be declared or captured by that same
  // function. A violation would fail validation for the whole response.
  const violations = [];
  for (const fn of parsed.flow.functions) {
    const declared = new Set([...fn.bindings.map(b => b.id), ...fn.captures]);
    const collect = value => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (!value || typeof value !== 'object') return;
      if (typeof value.binding === 'string' && !declared.has(value.binding)) {
        violations.push(`${fn.name} -> ${value.binding}`);
      }
      Object.values(value).forEach(collect);
    };
    collect(fn.body);
  }
  assert.deepEqual(violations, [], 'every binding reference must be declared or captured in its function');
  // The declaration must belong to the function that declares it, not to an
  // enclosing one that merely walked past it.
  const executor = parsed.flow.functions.find(fn => fn.bindings.some(b => b.name === 'value'));
  assert.ok(executor, 'the promise executor must declare its own `value` binding');
  assert.equal(executor.bindings.find(b => b.name === 'value').kind, 'let');
  const valueId = executor.bindings.find(b => b.name === 'value').id;
  assert.ok(
    parsed.flow.functions.some(fn => fn !== executor && fn.captures.includes(valueId)),
    'a nested arrow reading `value` must record it as a capture',
  );
  // The enclosing method must not have claimed it.
  const method = flowOf(parsed, 'm');
  assert.equal(method.bindings.some(b => b.name === 'value'), false,
    'an enclosing function must not declare a nested function\'s local');
});


test('runtime imports are named on every function, and type-only imports are not', () => {
  // The engine subtracts these from the external reads it asks a caller to
  // declare. Listing a type-only import would make an erased binding look like
  // module state the module actually provides.
  const parsed = facts({
    'a.ts': [
      "import fs from 'node:fs';",
      "import * as path from 'node:path';",
      "import { helper, other as renamed } from './helper.js';",
      "import type { Shape } from './types.js';",
      'export function f(x: Shape) { return helper(x) + path.sep.length + renamed(1) + fs.constants.F_OK; }',
    ].join('\n'),
    'helper.js': 'export function helper(x) { return x; }\nexport function other(x) { return x; }',
    'types.js': 'export type Shape = { a: number };',
  });
  const fn = flowOf(parsed, 'f');
  assert.deepEqual(fn.imports, ['fs', 'helper', 'path', 'renamed']);
  assert.equal(fn.imports.includes('Shape'), false,
    'a type-only import has no runtime binding and must not be listed');
});
