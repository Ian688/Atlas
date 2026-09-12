// The formal hierarchy shared by both projections.
//
// The 2D workbench and the 3D city are two views of one Analysis, so they must
// not each own a private answer to "what is a district and what does it total".
// They used to: the 3D city had project -> district -> file with counted facts
// and conservation checks, while the 2D canvas drew "the first twelve files that
// happened to be loaded". Two definitions of the same thing drift, and the drift
// is invisible because each view is internally consistent.
//
// This file is the single definition. It is deliberately geometry-free: it knows
// identities, membership, counted facts, and level grouping, and nothing about
// columns, plates, pixels or cameras. Each projection adds its own geometry and
// its own drawing budget on top, and reports that budget separately from the
// level, because "not drawn at this level" and "cut off by a budget" are
// different statements.
//
// Two rules the work order states are enforced structurally rather than promised:
//   * the hierarchy is uncapped -- no rendering budget appears in it;
//   * `atlasLevelInvariants` re-adds every level and refuses to call the
//     aggregation consistent unless project == sum(districts) == sum(files) for
//     every counted fact, so a wrong aggregation is a shown failure rather than
//     a picture that quietly disagrees with the analysis.

const ATLAS_HIERARCHY_SCHEMA = 'atlas.hierarchy.v1';
const ATLAS_INVARIANTS_SCHEMA = 'atlas.hierarchy-invariants.v1';
const ATLAS_LEVEL_BLOCKS_SCHEMA = 'atlas.level-blocks.v1';
const ATLAS_INDEX_SCHEMA = 'atlas.spatial-index.v1';

const ATLAS_LEVELS = ['project', 'district', 'file'];
const ATLAS_LEVEL_LABELS = { project: '项目', district: '目录', file: '文件' };
const ATLAS_LEVEL_DEPTH = { project: 0, district: 1, file: 2 };
const ATLAS_FACT_KEYS = ['files', 'declaredFunctions', 'loadedFunctions', 'analyzedFiles',
  'unanalyzedFiles', 'unresolvedCalls', 'callSites'];

function atlasLevelName(level) {
  return ATLAS_LEVEL_LABELS[level] || ATLAS_LEVEL_LABELS.file;
}

function atlasEmptyFacts() {
  const facts = {};
  for (const key of ATLAS_FACT_KEYS) facts[key] = 0;
  return facts;
}

function atlasAddFacts(target, source) {
  for (const key of ATLAS_FACT_KEYS) target[key] += Number(source[key] || 0);
  return target;
}

function atlasTopDirectory(path) {
  const text = String(path == null ? '' : path);
  const slash = text.indexOf('/');
  return slash === -1 ? '' : text.slice(0, slash);
}

function atlasDistrictLabel(key) {
  return key === '' ? '项目根目录' : key;
}

function atlasShortName(path) {
  const text = String(path == null ? '' : path);
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

/// The uncapped hierarchy. A rendering budget may decide what is drawn from
/// this; it can never decide what is counted here.
function buildAtlasHierarchy(nodes, edges) {
  const files = (nodes || []).filter((n) => n.kind === 'file')
    .slice().sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const functions = (nodes || []).filter((n) => n.kind === 'function');
  const calls = (edges || []).filter((e) => e.kind === 'call_candidate');

  const functionsByPath = new Map();
  for (const fn of functions) {
    if (!functionsByPath.has(fn.path)) functionsByPath.set(fn.path, []);
    functionsByPath.get(fn.path).push(fn);
  }
  for (const list of functionsByPath.values()) {
    list.sort((a, b) => (a.start - b.start) || String(a.name).localeCompare(String(b.name)));
  }
  const pathOfOwner = new Map();
  for (const fn of functions) pathOfOwner.set(fn.id, fn.path);
  for (const file of files) pathOfOwner.set(file.id, file.path);

  const root = {
    id: 'project:', kind: 'project', level: 'project', label: '项目', path: '',
    parent: null, children: [], facts: atlasEmptyFacts(),
  };
  const byPath = {};
  for (const file of files) {
    const list = functionsByPath.get(file.path) || [];
    const declared = Number.isFinite(file.function_count) ? file.function_count : list.length;
    const analyzed = file.disposition === 'captured';
    byPath[file.path] = {
      id: `file:${file.path}`, kind: 'file', level: 'file',
      label: file.name || atlasShortName(file.path), path: file.path,
      parent: null, children: [], source: file, functions: list,
      facts: {
        files: 1,
        declaredFunctions: Math.max(declared, 0),
        loadedFunctions: list.length,
        analyzedFiles: analyzed ? 1 : 0,
        unanalyzedFiles: analyzed ? 0 : 1,
        unresolvedCalls: 0,
        callSites: 0,
      },
    };
  }

  // Calls are counted where the facts are: at the file that made them. The
  // district and project numbers are then sums, never a separate tally that
  // could drift away from the files.
  const filePairs = new Map();
  const districtPairs = new Map();
  let candidateCalls = 0;
  for (const call of calls) {
    const from = pathOfOwner.get(call.source);
    if (from === undefined) continue;
    candidateCalls++;
    const owner = byPath[from];
    if (owner) owner.facts.callSites += 1;
    if (!call.target) {
      if (owner) owner.facts.unresolvedCalls += 1;
      continue;
    }
    const to = pathOfOwner.get(call.target);
    if (to === undefined || to === from) continue;
    const key = `${from}\u0000${to}`;
    filePairs.set(key, (filePairs.get(key) || 0) + 1);
    const fromKey = atlasTopDirectory(from), toKey = atlasTopDirectory(to);
    if (fromKey === toKey) continue;
    const districtKey = `${fromKey}\u0000${toKey}`;
    districtPairs.set(districtKey, (districtPairs.get(districtKey) || 0) + 1);
  }

  const districts = {};
  for (const file of files) {
    const key = atlasTopDirectory(file.path);
    let district = Object.prototype.hasOwnProperty.call(districts, key) ? districts[key] : null;
    if (!district) {
      district = {
        id: `district:${key}`, kind: 'district', level: 'district',
        label: atlasDistrictLabel(key), path: key, key,
        parent: root.id, children: [], facts: atlasEmptyFacts(),
      };
      districts[key] = district;
      root.children.push(district.id);
    }
    const node = byPath[file.path];
    node.parent = district.id;
    district.children.push(node.id);
    atlasAddFacts(district.facts, node.facts);
  }
  const districtOrder = Object.keys(districts).sort();
  for (const key of districtOrder) atlasAddFacts(root.facts, districts[key].facts);

  const order = [root];
  for (const key of districtOrder) order.push(districts[key]);
  for (const file of files) order.push(byPath[file.path]);

  const pairsTo = (map) => [...map.entries()]
    .map(([key, count]) => {
      const split = key.split('\u0000');
      return { from: split[0], to: split[1], count };
    })
    .sort((a, b) => (b.count - a.count) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return {
    schema: ATLAS_HIERARCHY_SCHEMA,
    levels: ATLAS_LEVELS.slice(),
    root,
    districts,
    districtOrder,
    byPath,
    order,
    files,
    filePairs: pairsTo(filePairs),
    districtPairs: pairsTo(districtPairs),
    candidateCalls,
    totals: { ...root.facts },
  };
}

/// Re-add every level and report any fact whose parts do not sum to the whole.
function atlasLevelInvariants(hierarchy) {
  const sums = { project: atlasEmptyFacts(), district: atlasEmptyFacts(), file: atlasEmptyFacts() };
  if (hierarchy) {
    for (const node of hierarchy.order || []) atlasAddFacts(sums[node.level], node.facts);
  }
  const violations = [];
  for (const key of ATLAS_FACT_KEYS) {
    const project = hierarchy ? hierarchy.totals[key] : 0;
    if (sums.district[key] !== project || sums.file[key] !== project) {
      violations.push({ key, project, districts: sums.district[key], files: sums.file[key] });
    }
  }
  return {
    schema: ATLAS_INVARIANTS_SCHEMA,
    ok: violations.length === 0,
    checked: ATLAS_FACT_KEYS.slice(),
    totals: hierarchy ? { ...hierarchy.totals } : atlasEmptyFacts(),
    violated: sums.project,
    violations,
  };
}

/// Resolved call pairs whose two ends would be one object at the district
/// level. They are counted rather than drawn: a pipe from an object to itself
/// says nothing.
function atlasInternalPairCount(hierarchy) {
  const all = hierarchy.filePairs.reduce((total, pair) => total + pair.count, 0);
  const cross = hierarchy.districtPairs.reduce((total, pair) => total + pair.count, 0);
  return Math.max(all - cross, 0);
}

/// The blocks one level draws, with no geometry attached.
///
/// A block is the thing a projection renders as one object. What it stands for
/// changes with the level (the whole project, a district, a file) while its
/// *facts* always come from the hierarchy, so the aggregated numbers are
/// identical at every level and a coarse level cannot quietly invent a total.
///
/// `maxFiles` bounds how many files the file level enumerates. That is a budget
/// and is reported as one (`budget.files`), never merged into `omitted`, which
/// is the level's own property: at the project level every file is represented
/// and none is enumerated, and that is not truncation.
function atlasLevelBlocks(hierarchy, level, options) {
  const opts = options || {};
  const chosen = ATLAS_LEVEL_DEPTH[level] === undefined ? 'file' : level;
  const totals = hierarchy.totals;
  const maxFiles = opts.maxFiles === undefined ? Infinity : Math.max(Number(opts.maxFiles) || 0, 0);

  let blocks = [];
  let pairs = [];
  let internalPairs = 0;
  let enumeratedFiles = 0;

  if (chosen === 'project') {
    blocks = [{
      id: 'project:', level: 'project', kind: 'project',
      path: 'project:', name: '项目', label: '项目',
      districtKey: '', parent: null,
      analyzed: totals.analyzedFiles > 0,
      facts: { ...totals },
      filePaths: hierarchy.files.map((file) => file.path),
      fileId: null,
      functions: [],
      slabDetail: false,
    }];
    enumeratedFiles = totals.files;
    internalPairs = hierarchy.filePairs.reduce((total, pair) => total + pair.count, 0);
  } else if (chosen === 'district') {
    blocks = hierarchy.districtOrder.map((key) => {
      const district = hierarchy.districts[key];
      const filePaths = district.children.map((id) => id.replace(/^file:/, ''));
      return {
        id: district.id, level: 'district', kind: 'district',
        path: `district:${key}`, name: district.label, label: district.label,
        districtKey: key, parent: 'project:',
        analyzed: district.facts.analyzedFiles > 0,
        facts: { ...district.facts },
        filePaths,
        // A district that happens to hold exactly one file *is* that file at
        // this level, so its source stays readable instead of being refused.
        fileId: filePaths.length === 1 ? `file:${filePaths[0]}` : null,
        functions: [],
        slabDetail: false,
      };
    });
    enumeratedFiles = totals.files;
    pairs = hierarchy.districtPairs.map((pair) => ({
      ...pair, from: `district:${pair.from}`, to: `district:${pair.to}`,
    }));
    internalPairs = atlasInternalPairCount(hierarchy);
  } else {
    const ordered = hierarchy.files.slice().sort((a, b) => String(a.path).localeCompare(String(b.path)));
    const shown = ordered.slice(0, maxFiles === Infinity ? ordered.length : maxFiles);
    enumeratedFiles = shown.length;
    blocks = shown.map((file) => {
      const node = hierarchy.byPath[file.path];
      return {
        id: file.id, level: 'file', kind: 'file',
        path: file.path, name: file.name || atlasShortName(file.path), label: file.name || atlasShortName(file.path),
        districtKey: atlasTopDirectory(file.path), parent: `district:${atlasTopDirectory(file.path)}`,
        // Every captured entry becomes a file block, including ones the scan
        // deliberately ignored or could not read. Drawing those as ordinary
        // analysed files would claim they were analysed, so the disposition
        // travels with the block.
        analyzed: file.disposition === 'captured',
        facts: { ...node.facts },
        filePaths: [file.path],
        fileId: file.id,
        functions: node.functions,
        slabDetail: true,
      };
    });
    pairs = hierarchy.filePairs.slice();
    internalPairs = atlasInternalPairCount(hierarchy);
  }

  const plates = [];
  const byKey = new Map();
  for (const block of blocks) {
    const key = chosen === 'file' ? block.districtKey : '';
    if (!byKey.has(key)) {
      byKey.set(key, { key, label: chosen === 'file' ? atlasDistrictLabel(key) : '项目', blockIds: [] });
      plates.push(byKey.get(key));
    }
    byKey.get(key).blockIds.push(block.id);
  }

  const drawnFunctions = blocks.reduce((total, block) => total + block.facts.declaredFunctions, 0);
  const budgetFiles = chosen === 'file' && enumeratedFiles < totals.files;
  return {
    schema: ATLAS_LEVEL_BLOCKS_SCHEMA,
    level: chosen,
    levelLabel: atlasLevelName(chosen),
    blocks,
    plates,
    pairs,
    internalPairs,
    // Aggregated facts: identical at every level, because they come from the
    // hierarchy rather than from what this level happened to enumerate.
    totals: { ...totals },
    enumeratedFiles,
    omitted: {
      files: Math.max(totals.files - enumeratedFiles, 0),
      functions: Math.max(totals.declaredFunctions - drawnFunctions, 0),
    },
    // Separate from `omitted` on purpose: this one is a drawing budget.
    budget: {
      files: budgetFiles,
      maxFiles: budgetFiles ? maxFiles : null,
      pairs: false,
    },
    pairUniverse: pairs.length,
  };
}

/// A uniform-grid index over axis-aligned boxes.
///
/// Both projections have to answer "which drawn object is at this position?" --
/// the 3D city by ray, the 2D graph by pointer. Scanning every box is fine for
/// a dozen of them and wrong for thousands, so the answer becomes an index with
/// a measurable cost instead of a promise: `scanned` reports how many boxes an
/// actual query touched, and a miss is a named miss rather than null.
function atlasSpatialIndex(boxes) {
  const list = (boxes || []).filter((b) => b && Number.isFinite(b.x) && Number.isFinite(b.y)
    && Number.isFinite(b.w) && Number.isFinite(b.h));
  if (!list.length) {
    return {
      schema: ATLAS_INDEX_SCHEMA, cell: 0, cols: 0, rows: 0, cells: 0,
      boxes: 0, minX: 0, minY: 0, maxX: 0, maxY: 0, _grid: null,
    };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  // Cell size follows the mean box footprint: big enough that a box usually
  // lands in one cell, small enough that a cell is not the whole picture.
  const mean = list.reduce((total, b) => total + Math.max(b.w, 1) * Math.max(b.h, 1), 0) / list.length;
  const cell = Math.max(Math.sqrt(mean), 1);
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell));
  const grid = new Array(cols * rows).fill(null);
  for (const b of list) {
    const c0 = Math.min(cols - 1, Math.max(0, Math.floor((b.x - minX) / cell)));
    const c1 = Math.min(cols - 1, Math.max(0, Math.floor((b.x + b.w - 1e-9 - minX) / cell)));
    const r0 = Math.min(rows - 1, Math.max(0, Math.floor((b.y - minY) / cell)));
    const r1 = Math.min(rows - 1, Math.max(0, Math.floor((b.y + b.h - 1e-9 - minY) / cell)));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const at = r * cols + c;
        if (!grid[at]) grid[at] = [];
        grid[at].push(b);
      }
    }
  }
  return {
    schema: ATLAS_INDEX_SCHEMA, cell, cols, rows, cells: cols * rows,
    boxes: list.length, minX, minY, maxX, maxY, _grid: grid,
  };
}

/// The box at a point, plus what it cost to find it. `boxes` is every box the
/// index holds, so a caller can tell "no object here" from "the object here has
/// no identity" without asking the index twice.
function atlasIndexHit(index, x, y) {
  if (!index || !index._grid) return { hit: null, candidates: 0, scanned: 0, inBounds: false };
  const inBounds = x >= index.minX && x < index.maxX && y >= index.minY && y < index.maxY;
  if (!inBounds) return { hit: null, candidates: 0, scanned: 0, inBounds: false };
  const c = Math.min(index.cols - 1, Math.max(0, Math.floor((x - index.minX) / index.cell)));
  const r = Math.min(index.rows - 1, Math.max(0, Math.floor((y - index.minY) / index.cell)));
  const bucket = index._grid[r * index.cols + c] || [];
  let hit = null;
  for (const box of bucket) {
    if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) { hit = box; break; }
  }
  return { hit, candidates: bucket.length, scanned: bucket.length, inBounds: true };
}
