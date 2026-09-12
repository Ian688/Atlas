// Behavioural tests for web/city3d.js.
//
// The WebGL renderer cannot run without a GPU, but the part that can actually
// be *wrong about the program* is the mapping: which directory becomes a plate,
// how tall a column is drawn, and whether a call that could not be resolved is
// shown or quietly dropped. A renderer bug produces a blank canvas; a mapping
// bug produces a confident picture of something the analysis never said. These
// tests cover the mapping, and assert that loading the file performs no query.
//
// No dependencies: stdlib only. Exits non-zero on the first failing assertion.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CITY = path.join(HERE, '..', 'city3d.js');
// Both pages load hierarchy.js before their own script, and the shared
// definitions are what keep the two projections from drifting. The
// harness loads them in the same order a browser would: without this
// the shared names are simply undefined, which is how this was caught.
const HIERARCHY = path.join(HERE, '..', 'hierarchy.js');

const fileNode = (p, count) => ({
  id: `file:${p}`, kind: 'file', path: p, name: p.split('/').pop(),
  parent: null, start: 0, end: 0, function_count: count, disposition: 'captured',
});
const fnNode = (p, name, start) => ({
  id: `symbol:${p}:${start}:${start + 10}`, kind: 'function', path: p, name,
  parent: `file:${p}`, start, end: start + 10, function_count: 0, disposition: 'syntax_extracted',
});
const call = (id, source, target) => ({
  id, kind: 'call_candidate', source, target, path: 'x', start: 0, end: 1,
  label: 'l', basis: target ? 'lexical_declaration_candidate' : 'dynamic_external_or_missing_binding',
});

function boot() {
  const sandbox = {
    console,
    // Loading the file must not query anything; a fetch here fails the test.
    fetch: () => { throw new Error('city3d.js must not fetch while loading'); },
    document: { getElementById: () => null, createElement: () => ({ style: {} }) },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(HIERARCHY, 'utf8'), context, { filename: 'web/hierarchy.js' });
  vm.runInContext(readFileSync(CITY, 'utf8'), context, { filename: 'web/city3d.js' });
  return { run: (expr) => vm.runInContext(expr, context) };
}

const checks = [];
function check(name, fn) { checks.push([name, fn]); }

check('loading the module performs no query and needs no GPU', () => {
  // boot() itself throws if the file fetches or touches a canvas on load.
  const t = boot();
  assert.equal(typeof t.run('buildCityLayout'), 'function', 'the mapping must be reachable');
  assert.equal(t.run('typeof buildCityLayout([], []).columns.length'), 'number');
});

check('districts are the top-level directories, and root files get their own', () => {
  const t = boot();
  const layout = t.run(`buildCityLayout(${JSON.stringify([
    fileNode('src/a.js', 1), fileNode('src/b.js', 1),
    fileNode('web/c.js', 1), fileNode('root.js', 0),
  ])}, [])`);
  // Spread into a host array: values built inside the vm realm have that
  // realm's Array prototype, which deepStrictEqual refuses to match.
  assert.deepEqual([...layout.districts].map((d) => d.name), ['', 'src', 'web']);
  const root = layout.districts.find((d) => d.name === '');
  assert.equal(root.label, '项目根目录', 'the root district must be named, not blank');
});

check('column height follows the engine count, and missing slabs are reported', () => {
  const t = boot();
  // A file that DECLARES 40 functions while only 2 function nodes were loaded:
  // drawing it as a 2-function file would be a quieter, more believable lie.
  const layout = t.run(`buildCityLayout(${JSON.stringify([
    fileNode('src/big.js', 40), fnNode('src/big.js', 'f1', 0), fnNode('src/big.js', 'f2', 20),
    fileNode('src/small.js', 2), fnNode('src/small.js', 'g1', 0), fnNode('src/small.js', 'g2', 20),
  ])}, [])`);
  const big = layout.columns.find((c) => c.path === 'src/big.js');
  const small = layout.columns.find((c) => c.path === 'src/small.js');
  assert.equal(big.functionCount, 40, 'the declared count must be kept');
  assert.equal(big.loadedSlabs, 2, 'only two function nodes were loaded');
  assert.ok(big.height > small.height, 'the taller declaration must draw taller');
  assert.ok(big.collapsedSlabs >= 38, 'the undrawn functions must be counted');
  assert.equal(big.slabsIncomplete, true, 'a gap between declared and loaded must be reported');
  assert.equal(small.slabsIncomplete, false, 'a complete file must not be flagged');
  assert.equal(layout.stats.truncated.slabs, true, 'the slab cap must surface in stats');
});

check('an unresolved call becomes a visible stub, never a dropped edge', () => {
  const t = boot();
  const layout = t.run(`buildCityLayout(${JSON.stringify([
    fileNode('src/a.js', 1), fnNode('src/a.js', 'fa', 0),
  ])}, ${JSON.stringify([
    call('c1', 'symbol:src/a.js:0:10', null),
    call('c2', 'symbol:src/a.js:0:10', null),
  ])})`);
  assert.equal(layout.stats.unresolvedCalls, 2, 'unresolved calls must be counted');
  assert.equal(layout.columns[0].unresolved, 2, 'they must attach to the file that made them');
  assert.equal(layout.pipes.length, 0, 'an unresolved call has no pipe to draw');
});

check('calls are aggregated per file pair, and self-calls are not drawn', () => {
  const t = boot();
  const nodes = [
    fileNode('src/a.js', 2), fnNode('src/a.js', 'a1', 0), fnNode('src/a.js', 'a2', 20),
    fileNode('src/b.js', 1), fnNode('src/b.js', 'b1', 0),
  ];
  const edges = [
    call('c1', 'symbol:src/a.js:0:10', 'symbol:src/b.js:0:10'),
    call('c2', 'symbol:src/a.js:20:30', 'symbol:src/b.js:0:10'),
    call('c3', 'symbol:src/a.js:0:10', 'symbol:src/a.js:20:30'),
  ];
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, ${JSON.stringify(edges)})`);
  assert.equal(layout.pipes.length, 1, 'two call sites between one file pair are one pipe');
  assert.equal(layout.pipes[0].count, 2, 'the pipe must carry how many sites say so');
  assert.equal(layout.pipes[0].from, 'src/a.js');
  assert.equal(layout.pipes[0].to, 'src/b.js');
  assert.equal(layout.stats.resolvedPairs, 1, 'a self-call is not a connection between files');
});

check('every cap is reported instead of quietly shrinking the picture', () => {
  const t = boot();
  const nodes = [];
  for (let i = 0; i < 10; i++) nodes.push(fileNode(`src/f${i}.js`, 1));
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, [], {maxFiles: 4, maxPipes: 0})`);
  assert.equal(layout.stats.files, 10, 'the real total must survive the cap');
  assert.equal(layout.stats.shownFiles, 4, 'the drawn total must be reported separately');
  assert.equal(layout.stats.truncated.files, true, 'the file cap must be flagged');
  assert.match(t.run(`cityCoverageLine(${JSON.stringify(layout.stats)})`), /已按预算截断：文件/,
    'the coverage line must say the picture is bounded');
});

check('the layout is deterministic and columns never overlap', () => {
  const t = boot();
  const nodes = [];
  for (let i = 0; i < 12; i++) nodes.push(fileNode(`src/deep/f${i}.js`, 1 + (i % 3)));
  for (let i = 0; i < 6; i++) nodes.push(fileNode(`web/f${i}.js`, 2));
  const expr = `buildCityLayout(${JSON.stringify(nodes)}, [])`;
  const first = t.run(expr);
  const second = t.run(expr);
  assert.deepEqual(
    first.columns.map((c) => [c.x, c.z, c.height]),
    second.columns.map((c) => [c.x, c.z, c.height]),
    'the same facts must always draw the same city',
  );
  const cols = first.columns;
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const a = cols[i], b = cols[j];
      const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2;
      assert.ok(apart, `columns ${a.path} and ${b.path} overlap`);
    }
  }
  for (let i = 0; i < first.districts.length; i++) {
    for (let j = i + 1; j < first.districts.length; j++) {
      const a = first.districts[i], b = first.districts[j];
      const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2;
      assert.ok(apart, `districts ${a.name} and ${b.name} overlap`);
    }
  }
});

check('a file that was never analysed is not drawn as an analysed one', () => {
  const t = boot();
  const layout = t.run(`buildCityLayout(${JSON.stringify([
    fileNode('src/a.js', 1), fnNode('src/a.js', 'fa', 0),
    { ...fileNode('vendor/lib.js', 0), disposition: 'ignored' },
    { ...fileNode('big.js', 0), disposition: 'oversize' },
  ])}, [])`);
  const ignored = [...layout.columns].find((c) => c.path === 'vendor/lib.js');
  assert.equal(ignored.analyzed, false, 'an ignored file must not claim to be analysed');
  assert.equal([...layout.columns].find((c) => c.path === 'src/a.js').analyzed, true,
    'a captured file must still read as analysed');
  assert.equal(layout.stats.unanalyzedFiles, 2, 'both non-captured files must be counted');
  assert.match(t.run(`cityCoverageLine(${JSON.stringify(layout.stats)})`), /未分析文件 2/,
    'the coverage line must say how many files are not analysed');
});

check('an empty analysis produces an empty city, not a broken one', () => {
  const t = boot();
  const layout = t.run('buildCityLayout([], [])');
  assert.equal(layout.columns.length, 0);
  assert.equal(layout.districts.length, 0);
  assert.equal(layout.stats.files, 0);
  assert.equal(layout.stats.truncated.files, false);
  assert.equal(
    t.run(`cityCoverageLine(${JSON.stringify(layout.stats)})`),
    '文件 0/0 · 函数 0 · 管道 0/0 · 未解析调用 0 · 未截断',
  );
  assert.equal(t.run('cityCoverageLine(null)'), '尚未加载');
});

check('picking agrees with the camera the city was drawn with', () => {
  const t = boot();
  const layout = {
    columns: [
      { id: 'file:a.js', path: 'a.js', name: 'a.js', x: 0, z: 0, w: 1.6, d: 1.6, height: 3 },
      { id: 'file:b.js', path: 'b.js', name: 'b.js', x: 40, z: 0, w: 1.6, d: 1.6, height: 3 },
    ],
  };
  const camera = { target: [0, 1.5, 0], distance: 12, azimuth: 0, elevation: 0.4 };
  const hit = t.run(`cityPick(${JSON.stringify(layout)}, ${JSON.stringify(camera)}, 0, 0, 1.6)`);
  assert.ok(hit, 'the centre ray must hit the column the camera is aimed at');
  assert.equal(hit.path, 'a.js', 'and it must be the near column, not an arbitrary one');
  assert.equal(t.run(`cityPick(${JSON.stringify(layout)}, ${JSON.stringify(camera)}, 0.98, 0.98, 1.6)`), null,
    'a ray into empty space must hit nothing rather than guess');
  // A camera on the far side must pick the far column, so the ray is not
  // accidentally ignoring the camera entirely.
  const flipped = { target: [40, 1.5, 0], distance: 12, azimuth: 0, elevation: 0.4 };
  const far = t.run(`cityPick(${JSON.stringify(layout)}, ${JSON.stringify(flipped)}, 0, 0, 1.6)`);
  assert.equal(far && far.path, 'b.js', 'moving the camera must move what gets picked');
});

check('without WebGL2 it says so rather than showing an empty stage', async () => {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, textContent: '', className: '', value: '', style: {},
        append() {}, replaceChildren() {}, addEventListener() {},
      });
    }
    return elements.get(id);
  };
  const canvas = {
    id: 'city-canvas', clientWidth: 800, clientHeight: 600,
    getContext: () => null, addEventListener() {}, setPointerCapture() {},
  };
  const sandbox = {
    console,
    document: {
      getElementById: (id) => (id === 'city-canvas' ? canvas : el(id)),
      createElement: () => ({ style: {}, append() {}, addEventListener() {} }),
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(HIERARCHY, 'utf8'), context, { filename: 'web/hierarchy.js' });
  vm.runInContext(readFileSync(CITY, 'utf8'), context, { filename: 'web/city3d.js' });
  await vm.runInContext('city3dStart(document.getElementById("city-canvas"))', context);
  const status = el('city-status').textContent;
  assert.match(status, /WebGL2/, 'the page must name what is missing');
  assert.match(status, /2D 工作台/, 'and must say the 2D workbench is unaffected');
});

// --- W09: the second projection must agree about the same selection ---------
// These exercise the pure decision, so every refusal is asserted rather than
// hoped for. A "yes" here highlights a column; a "no" leaves the view alone and
// says why, which is the only honest outcome for a selection from a version
// this projection is not showing.
check('a shared selection resolves to the column that really holds that entity', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 2), fnNode('src/a.js', 'fnA', 0), fileNode('web/c.js', 1)];
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, [])`);
  const target = t.run(`citySelectionTarget(${JSON.stringify({ entity_id: 'symbol:src/a.js:0:10', analysis: 'A1' })}, "A1", ${JSON.stringify(nodes)}, ${JSON.stringify(layout)})`);
  assert.equal(target.ok, true, JSON.stringify(target));
  assert.equal(target.path, 'src/a.js');
  assert.equal(target.name, 'fnA');
});

check('a selection from another analysis is refused with its version named', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 1)];
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, [])`);
  const target = t.run(`citySelectionTarget(${JSON.stringify({ entity_id: 'file:src/a.js', analysis: 'OLD' })}, "NEW", ${JSON.stringify(nodes)}, ${JSON.stringify(layout)})`);
  assert.equal(target.ok, false);
  assert.equal(target.code, 'stale_selection_version');
  assert.equal(target.selection_analysis, 'OLD');
  assert.equal(target.served_analysis, 'NEW');
  assert.equal(target.path, undefined, 'a refused selection must not name a column to highlight');
});

check('a selection for an entity this projection does not have is refused, not approximated', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 1)];
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, [])`);
  const unknown = t.run(`citySelectionTarget(${JSON.stringify({ entity_id: 'symbol:gone.js:0:1', analysis: 'A1' })}, "A1", ${JSON.stringify(nodes)}, ${JSON.stringify(layout)})`);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'entity_not_loaded');
  const outside = t.run(`citySelectionTarget(${JSON.stringify({ entity_id: 'file:other/z.js', analysis: 'A1' })}, "A1", ${JSON.stringify([fileNode('other/z.js', 1)])}, ${JSON.stringify(layout)})`);
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'entity_not_in_layout');
  assert.equal(outside.path, 'other/z.js', 'the refusal must still say which file it was about');
});

// --- W09: observed runs, kept separate from static candidates -----------------
// The work order asks for run-derived paths to be shown under their own legend
// and for LOD to never change fact counts. These check the mapping: it reads the
// layout, never changes it, and reports a record it cannot place instead of
// dropping it.
check('run markers map onto the layout without changing the static picture', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 2), fnNode('src/a.js', 'fnA', 0), fileNode('web/c.js', 1)];
  const edges = [call('call:1', 'file:src/a.js', 'file:web/c.js')];
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, ${JSON.stringify(edges)})`);
  const before = JSON.stringify(layout);
  const markers = [
    { symbol: 'symbol:src/a.js:0:10', path: 'src/a.js', name: 'fnA', verdict: 'returned' },
    { symbol: 'symbol:src/a.js:20:30', path: 'src/a.js', name: 'fnB', verdict: 'threw' },
    { symbol: 'symbol:gone.js:0:1', path: 'src/gone.js', name: 'ghost', verdict: 'refused' },
  ];
  const observed = t.run(`cityRunMarkers(${JSON.stringify(markers)}, ${JSON.stringify(layout)})`);
  assert.equal(observed.total, 3);
  assert.equal(observed.placed, 2, 'two markers belong to a file in the layout');
  // Objects from the vm realm have their own Array/Object prototypes, so these
  // are compared as JSON rather than by identity.
  assert.equal(JSON.stringify(observed.unplaced), JSON.stringify(['src/gone.js']),
    'an unplaceable record must be reported, not dropped');
  assert.equal(JSON.stringify(observed.counts), JSON.stringify({ returned: 1, threw: 1, refused: 1 }));
  assert.equal(observed.records.length, 1, 'both runs are on one file');
  assert.equal(observed.records[0].runs, 2);
  assert.equal(JSON.stringify(observed.records[0].verdicts), JSON.stringify({ returned: 1, threw: 1 }));
  assert.equal(JSON.stringify(layout), before,
    'mapping observations must not add a file, change a height, or resolve a call');
});

check('the observed line names the verdicts and admits what it could not place', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 1)];
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, [])`);
  const markers = [
    { path: 'src/a.js', name: 'fnA', verdict: 'returned' },
    { path: 'src/a.js', name: 'fnB', verdict: 'timeout' },
    { path: 'src/other.js', name: 'x', verdict: 'returned' },
  ];
  const observed = t.run(`cityRunMarkers(${JSON.stringify(markers)}, ${JSON.stringify(layout)})`);
  const line = t.run(`cityObservedLine(${JSON.stringify(observed)})`);
  assert.match(line, /观测（运行入口）3/);
  assert.match(line, /returned 2/);
  assert.match(line, /timeout 1/);
  assert.match(line, /落在 1 个柱体 \/ 1 个文件/);
  assert.match(line, /未落在当前布局 1/, 'a record outside the layout must be visible');
  // And with nothing run, there is no line to misread.
  assert.equal(t.run('cityObservedLine(cityRunMarkers([], ' + JSON.stringify(layout) + '))'), null);
});

check('observed runs and static candidates use different wire colours', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 1), fileNode('src/b.js', 1)];
  const layout = t.run(`buildCityLayout(${JSON.stringify(nodes)}, [])`);
  const plain = t.run(`cityWireInstances(${JSON.stringify(layout)}, null, null)`);
  const withRuns = t.run(`cityWireInstances(${JSON.stringify(layout)}, null, new Set(['src/a.js']))`);
  assert.notEqual(JSON.stringify(withRuns[0].color), JSON.stringify(plain[0].color),
    'a file with observed runs must not be drawn like one without');
  assert.equal(JSON.stringify(withRuns[1].color), JSON.stringify(plain[1].color),
    'other files are unaffected');
  const selected = t.run(`cityWireInstances(${JSON.stringify(layout)}, 'src/a.js', new Set(['src/a.js']))`);
  assert.notEqual(JSON.stringify(selected[0].color), JSON.stringify(withRuns[0].color),
    'selection and "has been run" are different claims and must not share a colour');
});

// --- W09: the formal hierarchy, and LOD that cannot change fact counts -------
// The work order states the rule as "LOD must not change fact counts". These
// checks make that a property of the data rather than a promise: the hierarchy
// is uncapped and re-added at every level, and a coarse view must report what it
// did not draw instead of absorbing it.
check('the hierarchy survives a bounded file budget: caps change what is drawn, not what is counted', () => {
  const t = boot();
  const nodes = [];
  for (let i = 0; i < 10; i++) nodes.push(fileNode(`src/f${i}.js`, i + 1));
  const edges = [call('c1', 'file:src/f0.js', 'file:src/f1.js')];
  const bounded = t.run(`buildCityLayout(${JSON.stringify(nodes)}, ${JSON.stringify(edges)}, {maxFiles: 3})`);
  const full = t.run(`buildCityLayout(${JSON.stringify(nodes)}, ${JSON.stringify(edges)})`);
  assert.equal(bounded.stats.files, 10, 'the real file count survives the cap');
  assert.equal(full.stats.files, 10);
  assert.equal(bounded.stats.declaredFunctions, full.stats.declaredFunctions,
    'the declared function total must not depend on the file budget');
  assert.equal(bounded.stats.declaredFunctions, 55, '1+2+...+10');
  assert.equal(bounded.stats.shownFiles, 3);
  assert.ok(bounded.stats.omitted.functions > 0, 'what was not drawn must be reported');
  assert.equal(bounded.invariants.ok, true, JSON.stringify(bounded.invariants.violations));
  // The invariant is about the hierarchy, so it holds even when nothing is drawn.
  const none = t.run(`buildCityLayout(${JSON.stringify(nodes)}, [], {maxFiles: 0})`);
  assert.equal(none.stats.shownFiles, 0);
  assert.equal(none.stats.declaredFunctions, 55, 'an empty picture is not an empty analysis');
  assert.equal(none.invariants.ok, true);
});

check('every level aggregates to the same facts, and says so', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 3), fnNode('src/a.js', 'fnA', 0), fileNode('src/b.js', 2),
    fileNode('web/c.js', 1), fileNode('root.js', 0)];
  const edges = [call('c1', 'file:src/a.js', 'file:web/c.js'), call('c2', 'file:src/b.js', 'symbol:src/a.js:0:10')];
  const hierarchy = t.run(`buildCityHierarchy(${JSON.stringify(nodes)}, ${JSON.stringify(edges)})`);
  const invariants = t.run(`cityLevelInvariants(${JSON.stringify(hierarchy)})`);
  assert.equal(invariants.ok, true, JSON.stringify(invariants.violations));
  assert.equal(invariants.totals.files, 4);
  assert.equal(invariants.totals.declaredFunctions, 6);
  assert.equal(invariants.totals.analyzedFiles, 4);

  const totals = {};
  const blocks = {};
  for (const level of ['project', 'district', 'file']) {
    const view = t.run(`cityLevelView(${JSON.stringify(hierarchy)}, ${JSON.stringify(level)})`);
    totals[level] = JSON.stringify({
      declared: view.stats.declaredFunctions, files: view.stats.files,
      unresolved: view.stats.unresolvedCalls, analyzed: view.stats.analyzedFiles,
      loaded: view.stats.loadedFunctions,
    });
    blocks[level] = view.stats.drawnBlocks;
    assert.equal(view.level, level);
    assert.equal(view.invariants.ok, true);
  }
  // The facts are equal across levels; what is drawn is not, and that
  // difference is the whole point of a level.
  assert.equal(totals.project, totals.district, 'project and district must agree on the facts');
  assert.equal(totals.project, totals.file, 'and the file level too');
  assert.equal(blocks.project, 1, 'the project level draws one block');
  assert.equal(blocks.district, 3, 'the district level draws one block per district');
  assert.ok(blocks.file > blocks.district, 'the file level draws more objects');
});

check('a coarse level reports the facts it did not draw as a level property', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 4), fnNode('src/a.js', 'fnA', 0), fileNode('src/b.js', 1)];
  const edges = [call('c1', 'file:src/a.js', 'file:src/b.js'), call('noTarget', 'file:src/a.js', null)];
  const hierarchy = t.run(`buildCityHierarchy(${JSON.stringify(nodes)}, ${JSON.stringify(edges)})`);
  const project = t.run(`cityLevelView(${JSON.stringify(hierarchy)}, "project")`);
  const district = t.run(`cityLevelView(${JSON.stringify(hierarchy)}, "district")`);
  const file = t.run(`cityLevelView(${JSON.stringify(hierarchy)}, "file")`);

  // Facts that are NOT rendering choices must be identical at every level.
  for (const view of [project, district, file]) {
    assert.equal(view.stats.unresolvedCalls, 1, 'an unresolved call is a fact at every level');
    assert.equal(view.stats.declaredFunctions, 5);
    assert.equal(view.stats.unanalyzedFiles, 0);
  }
  // Aggregation is visible, not implied: both files are inside one district, so
  // at the district level the call between them has no pipe to draw -- and it
  // is counted rather than dropped.
  assert.equal(district.stats.internalPairs, 1, 'an intra-district call must be counted, not lost');
  assert.equal(district.pipes.length, 0, 'there is no pipe between two objects that are one object here');
  assert.equal(file.stats.resolvedPairs, 1);
  assert.equal(file.pipes.length, 1);
  assert.equal(project.stats.internalPairs, 1, 'at the project level every call is internal');
  assert.equal(project.pipes.length, 0);
  // The blocks say they are aggregates, and an aggregate has no single source.
  assert.equal(district.columns[0].aggregate, true);
  assert.equal(district.columns[0].files, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(district.columns[0].filePaths)), ['src/a.js', 'src/b.js']);
  assert.equal(t.run(`citySelectionQuery(${JSON.stringify(district.columns[0])})`), null,
    'an aggregate must not offer a source read');
  assert.equal(file.columns[0].aggregate, false);
  assert.equal(t.run(`citySelectionQuery(${JSON.stringify(file.columns[0])})`).path, 'src/a.js');
  // And the level line says which of the two happened.
  const line = t.run(`cityLevelLine(${JSON.stringify(district.stats)}, ${JSON.stringify(district.invariants)})`);
  assert.match(line, /层级 目录/);
  assert.match(line, /层级定义，不是渲染预算/, 'a level omission must not read as a budget cut');
  assert.match(line, /同层内部调用 1/);
  assert.match(line, /层级聚合守恒/);
});

check('a level view cannot disagree with the hierarchy it came from', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 5), fnNode('src/a.js', 'fnA', 0), fileNode('web/c.js', 2),
    { ...fileNode('src/ignored.js', 9), disposition: 'ignored' }];
  const hierarchy = t.run(`buildCityHierarchy(${JSON.stringify(nodes)}, [])`);
  // Break the total so it no longer equals the sum of its parts. An invariant
  // that cannot fail is not evidence, so this one is made to fail on purpose.
  const broken = JSON.parse(JSON.stringify(hierarchy));
  broken.totals.declaredFunctions = broken.totals.declaredFunctions - 1;
  const check = t.run(`cityLevelInvariants(${JSON.stringify(broken)})`);
  assert.equal(check.ok, false, 'a wrong aggregation must be reported, not smoothed over');
  assert.ok(check.violations.some((v) => v.key === 'declaredFunctions'),
    JSON.stringify(check.violations));
  // And the same for a fact that only the file level carries.
  const brokenCalls = JSON.parse(JSON.stringify(hierarchy));
  brokenCalls.totals.unresolvedCalls = 5;
  const callCheck = t.run(`cityLevelInvariants(${JSON.stringify(brokenCalls)})`);
  assert.equal(callCheck.ok, false);
  assert.ok(callCheck.violations.some((v) => v.key === 'unresolvedCalls'));
  // A non-captured file is a fact too: it must not be counted as analysed.
  const invariants = t.run(`cityLevelInvariants(${JSON.stringify(hierarchy)})`);
  assert.equal(invariants.totals.unanalyzedFiles, 1);
  assert.equal(invariants.totals.files, 3);
  assert.equal(invariants.totals.declaredFunctions, 16);
});

check('a run marker at a coarse level is placed, and named as an aggregate', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 2), fnNode('src/a.js', 'fnA', 0), fileNode('web/c.js', 1)];
  const hierarchy = t.run(`buildCityHierarchy(${JSON.stringify(nodes)}, [])`);
  const district = t.run(`cityLevelView(${JSON.stringify(hierarchy)}, "district")`);
  const markers = [
    { path: 'src/a.js', name: 'fnA', verdict: 'returned' },
    { path: 'src/gone.js', name: 'ghost', verdict: 'refused' },
  ];
  const observed = t.run(`cityRunMarkers(${JSON.stringify(markers)}, ${JSON.stringify(district)})`);
  assert.equal(observed.level, 'district');
  assert.equal(observed.placed, 1);
  assert.equal(observed.aggregated, 1, 'the block it landed on stands for more than one file');
  assert.equal(observed.records[0].path, 'src/a.js', 'the record still names the real file');
  assert.equal(observed.columns[0].path, 'district:src', 'but it is placed on the aggregate block');
  assert.deepEqual(JSON.parse(JSON.stringify(observed.unplaced)), ['src/gone.js']);
  const line = t.run(`cityObservedLine(${JSON.stringify(observed)})`);
  assert.match(line, /层级 目录/);
  assert.match(line, /这是聚合，不是“整个目录都跑过”/);
});

check('a selection at a coarse level names the file and admits the aggregation', () => {
  const t = boot();
  // Two files in one district, so the block really is an aggregation rather
  // than a district that happens to hold a single file.
  const nodes = [fileNode('src/a.js', 2), fnNode('src/a.js', 'fnA', 0), fileNode('src/b.js', 1)];
  const hierarchy = t.run(`buildCityHierarchy(${JSON.stringify(nodes)}, [])`);
  const district = t.run(`cityLevelView(${JSON.stringify(hierarchy)}, "district")`);
  const pending = { entity_id: 'symbol:src/a.js:0:10', analysis: 'A1' };
  const target = t.run(`citySelectionTarget(${JSON.stringify(pending)}, "A1", ${JSON.stringify(nodes)}, ${JSON.stringify(district)})`);
  assert.equal(target.ok, true, JSON.stringify(target));
  assert.equal(target.path, 'district:src', 'the block that really represents it');
  assert.equal(target.file_path, 'src/a.js', 'and the file the user actually picked');
  assert.equal(target.aggregated, true);
  assert.equal(target.level, 'district');
  // A stale version is still refused first: level handling must not weaken the
  // rule that a selection is pinned to an analysis.
  const stale = t.run(`citySelectionTarget(${JSON.stringify({ ...pending, analysis: 'OLD' })}, "A1", ${JSON.stringify(nodes)}, ${JSON.stringify(district)})`);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_selection_version');
  // And an entity that is not in the analysis at all is still refused.
  const gone = t.run(`citySelectionTarget(${JSON.stringify({ entity_id: 'file:other/z.js', analysis: 'A1' })}, "A1", ${JSON.stringify([fileNode('other/z.js', 1)])}, ${JSON.stringify(district)})`);
  assert.equal(gone.ok, false);
  assert.equal(gone.code, 'entity_not_in_layout');
});

check('a coarse block is drawn, and a one-file district is still that file', () => {
  const t = boot();
  const single = [fileNode('src/a.js', 4)];
  const pair = [fileNode('src/a.js', 4), fileNode('src/b.js', 1)];
  const oneView = t.run(`cityLevelView(buildCityHierarchy(${JSON.stringify(single)}, []), "district")`);
  const pairView = t.run(`cityLevelView(buildCityHierarchy(${JSON.stringify(pair)}, []), "district")`);
  // Drawn solid at every camera distance: a coarse level that vanished when the
  // camera came near would make the level unusable exactly when it is examined.
  for (const view of [oneView, pairView]) {
    const solid = t.run(`cityColumnInstances(${JSON.stringify(view)}, "function", null)`);
    assert.ok(solid.some((instance) => instance.scale[1] > 2),
      'the block must keep its height in near view, not collapse to a plinth');
    assert.equal(view.columns[0].slabDetail, false, 'a coarse block has no layers to expand');
  }
  // A district that holds exactly one file *is* that file at this level.
  assert.equal(oneView.columns[0].aggregate, false);
  assert.equal(t.run(`citySelectionQuery(${JSON.stringify(oneView.columns[0])})`).entity, 'file:src/a.js',
    'one file is not an aggregation, so its source stays readable');
  // Two files are an aggregation, and an aggregation has no single source.
  assert.equal(pairView.columns[0].aggregate, true);
  assert.equal(t.run(`citySelectionQuery(${JSON.stringify(pairView.columns[0])})`), null);
  // The file level always expands: that is what it is for.
  const fileView = t.run(`cityLevelView(buildCityHierarchy(${JSON.stringify(pair)}, []), "file")`);
  assert.equal(fileView.columns[0].slabDetail, true);
});

check('switching level keeps the object, re-derives the markers and never re-anchors', () => {
  const t = boot();
  const nodes = [fileNode('src/a.js', 3), fnNode('src/a.js', 'fnA', 0), fileNode('src/b.js', 1)];
  const markers = [{ path: 'src/a.js', name: 'fnA', verdict: 'returned' }];
  const state = {
    hierarchy: t.run(`buildCityHierarchy(${JSON.stringify(nodes)}, [])`),
    layout: null, selected: 'src/a.js', selectedFile: 'src/a.js',
    observed: t.run(`cityRunMarkers(${JSON.stringify(markers)}, buildCityLayout(${JSON.stringify(nodes)}, []))`),
    observedSource: markers,
  };
  const toDistrict = t.run(`cityLevelSwitch(${JSON.stringify(state)}, "district")`);
  assert.equal(toDistrict.ok, true);
  assert.equal(toDistrict.level, 'district');
  assert.equal(toDistrict.selected, 'district:src', 'the block that represents the selected file');
  assert.equal(toDistrict.selectedFile, 'src/a.js', 'the object the user picked is kept');
  assert.equal(toDistrict.lost, null);
  assert.equal(toDistrict.observed.placed, 1, 'the marker is re-derived for the new layout');
  assert.equal(toDistrict.observed.columns[0].path, 'district:src');
  assert.equal(toDistrict.runPaths.has('district:src'), true, 'the wire colour follows the block');

  // A budget that hides the selected file must drop it and say so, not
  // highlight some other column.
  const capped = { ...state, selected: 'src/b.js', selectedFile: 'src/b.js' };
  const toCapped = t.run(`cityLevelSwitch(${JSON.stringify(capped)}, "file", {maxFiles: 0})`);
  assert.equal(toCapped.ok, true);
  assert.equal(toCapped.column, undefined);
  assert.equal(toCapped.selected, null);
  assert.equal(toCapped.lost, 'src/b.js', 'the lost object must be named');
  // And a level switch with no hierarchy at all is refused rather than guessed.
  const none = t.run(`cityLevelSwitch({ layout: null }, "district")`);
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no_layout');
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
console.log(failed ? `\n${failed}/${checks.length} city3d checks failed` : `\nall ${checks.length} city3d checks passed`);
process.exit(failed ? 1 : 0);
