// Atlas 3D code city -- a second projection of the *same* Analysis the 2D
// workbench reads. No third-party renderer: the whole file is either pure data
// mapping or hand-written WebGL2, so it stays inside the `script-src 'self'`
// policy and adds no dependency to a workbench that has none.
//
// Everything here is a projection, never a new fact. Directories become ground
// plates, files become columns whose height encodes the engine's declared
// function count, functions become the slabs stacked inside a column, and call
// candidates become ground pipes. Two rules are non-negotiable:
//   * an unresolved call is drawn, not dropped -- it becomes a stub on the
//     column that made it, because "we could not resolve this" is a fact too;
//   * every cap is reported in `stats.truncated`, so a bounded picture can
//     never be mistaken for a complete one.

const CITY_MAX_FILES = 400;
const CITY_MAX_PIPES = 400;
const CITY_MAX_SLABS = 18;
const CITY_COLUMN_W = 2.6;
const CITY_COLUMN_D = 2.6;
const CITY_SLAB_H = 0.85;
const CITY_BASE_H = 1.3;
const CITY_DISTRICT_PAD = 3.4;
const CITY_DISTRICT_GAP = 7.0;
// Breathing room between two blocks inside one plate. Without it a coarse
// level whose blocks are exactly one cell wide would draw them touching, and
// two files with different facts would read as one object.
const CITY_BLOCK_GAP = 1.0;

// The hierarchy and its path helpers live in web/hierarchy.js, shared with the
// 2D workbench. These aliases stay because the city's internals and tests read
// these names; a private copy here is exactly the drift this round removes.
const cityTopDirectory = atlasTopDirectory;
const cityDistrictLabel = atlasDistrictLabel;
const cityShortName = atlasShortName;

// ---------------------------------------------------------------------------
// The formal hierarchy and its levels of detail (LOD).
//
// The city used to be one fixed picture: directories were plates, files were
// columns, functions were slabs. That is a *level*, not the model. This is the
// model: project -> district -> file, with the facts each level aggregates, and
// a view per level derived from it.
//
// The rule the work order states as "LOD must not change fact counts" is
// enforced structurally rather than promised:
//   * the hierarchy is uncapped -- no rendering budget appears in it;
//   * `cityLevelInvariants` re-adds every level and refuses to call the
//     aggregation consistent unless project == sum(districts) == sum(files) for
//     every counted fact;
//   * a level view reports what it did not draw (`omitted`) and what it left
//     out as a *level* property rather than a budget one, so the two can never
//     be confused.
// Level identity, labels and fact keys are the shared ones. Keeping a second
// list here is how "the same thing" quietly becomes two things.
const CITY_LEVELS = ATLAS_LEVELS;
const CITY_LEVEL_LABELS = ATLAS_LEVEL_LABELS;
const CITY_LEVEL_DEPTH = ATLAS_LEVEL_DEPTH;
const CITY_FACT_KEYS = ATLAS_FACT_KEYS;
const cityLevelName = atlasLevelName;
const cityEmptyFacts = atlasEmptyFacts;
const cityAddFacts = atlasAddFacts;

/// The uncapped hierarchy. A rendering budget may decide what is drawn from
/// this; it can never decide what is counted here.
/// The uncapped hierarchy, built by the shared definition in hierarchy.js.
/// The city keeps the name because its tests and the level views read it;
/// there is exactly one implementation, so the two projections cannot drift
/// into disagreeing totals.
function buildCityHierarchy(nodes, edges) {
  return buildAtlasHierarchy(nodes, edges);
}

/// Re-add every level and report any fact whose parts do not sum to the whole.
/// The point is that a wrong aggregation is a *shown* failure, not a picture
/// that quietly disagrees with the analysis.
/// Delegate: the conservation check belongs to the hierarchy, not to a view of it.
function cityLevelInvariants(hierarchy) {
  return atlasLevelInvariants(hierarchy);
}

/// Pack plates that each hold a grid of blocks, without overlap.
///
/// The level views only differ in what a plate and a block stand for, so the
/// packing is shared: one code path means a coarse level cannot quietly get
/// different overlap behaviour from the file level.
function cityPackPlates(plates) {
  const footprints = plates.map((plate) => {
    const cellW = Math.max(CITY_COLUMN_W * 0.62, ...plate.blocks.map((b) => b.w)) + CITY_BLOCK_GAP;
    const cellD = Math.max(CITY_COLUMN_D * 0.62, ...plate.blocks.map((b) => b.d)) + CITY_BLOCK_GAP;
    const cols = Math.max(1, Math.ceil(Math.sqrt(plate.blocks.length || 1)));
    const rows = Math.ceil((plate.blocks.length || 1) / cols);
    return {
      plate, cellW, cellD, cols, rows,
      w: cols * cellW + CITY_DISTRICT_PAD,
      d: rows * cellD + CITY_DISTRICT_PAD,
    };
  });
  const shelfWidth = footprints.length
    ? Math.max(...footprints.map((f) => f.w)) * Math.ceil(Math.sqrt(footprints.length))
    : 0;

  const districts = [], columns = [];
  let cursorX = 0, cursorZ = 0, rowDepth = 0;
  for (const fp of footprints) {
    if (cursorX > 0 && cursorX + fp.w > shelfWidth) {
      cursorZ += rowDepth + CITY_DISTRICT_GAP;
      cursorX = 0;
      rowDepth = 0;
    }
    const originX = cursorX, originZ = cursorZ;
    districts.push({
      name: fp.plate.key, label: fp.plate.label,
      x: originX + fp.w / 2, z: originZ + fp.d / 2,
      w: fp.w, d: fp.d,
      files: fp.plate.blocks.reduce((total, block) => total + block.files, 0),
      level: fp.plate.level,
      blocks: fp.plate.blocks.length,
    });
    fp.plate.blocks.forEach((block, index) => {
      const gx = index % fp.cols, gz = Math.floor(index / fp.cols);
      columns.push({
        ...block,
        // A block that stands for more than one file must never be mistaken for
        // a file: it has no single source to read and no single identity to
        // publish, and the view says so instead of guessing one. `slabDetail`
        // is separate: it says whether the camera may expand this block into
        // function layers at all, which is a property of the level.
        aggregate: (block.filePaths || []).length > 1,
        slabDetail: block.slabDetail === true,
        district: fp.plate.key,
        x: originX + CITY_DISTRICT_PAD / 2 + fp.cellW * (gx + 0.5),
        z: originZ + CITY_DISTRICT_PAD / 2 + fp.cellD * (gz + 0.5),
      });
    });
    cursorX += fp.w + CITY_DISTRICT_GAP;
    rowDepth = Math.max(rowDepth, fp.d);
  }
  return { districts, columns };
}

/// Resolved call pairs whose two ends would be one object at the district
/// level. They are counted rather than drawn: a pipe from a district to itself
/// would be a line from an object to itself, which says nothing.
function cityInternalPairCount(hierarchy) {
  const all = hierarchy.filePairs.reduce((total, pair) => total + pair.count, 0);
  const cross = hierarchy.districtPairs.reduce((total, pair) => total + pair.count, 0);
  return Math.max(all - cross, 0);
}

/// Height in world units: the shared scale contract times one slab layer, plus
/// the plinth. The scale is piecewise monotone (linear for the first eight
/// layers, logarithmic and capped after that) because a linear height drew
/// 92.1% of rxjs' non-empty files under 1% of the tallest column -- invisible --
/// and let one 1056-function bundle flatten the whole picture.
function cityBlockHeight(declared) {
  return CITY_BASE_H + atlasScaleHeight(declared) * CITY_SLAB_H;
}

/// The drawable view of one level. The same facts, grouped differently.
/// The drawable view of one level: the shared level blocks, given geometry.
///
/// The *set* of blocks and every number attached to them come from
/// `atlasLevelBlocks`, so the 2D canvas and the city draw the same objects at
/// the same level, with the same totals, by construction. What is added here is
/// what a viewer needs and a fact does not: footprints, heights, slab layers,
/// and plate packing.
function cityLevelView(hierarchy, level, options) {
  const opts = options || {};
  // An explicit 0 is a budget, not a missing value: `|| CITY_MAX_FILES` used to
  // turn "draw nothing" into "draw everything", which is the opposite of what
  // the caller asked for and invisible in the result.
  const maxFiles = opts.maxFiles === undefined ? CITY_MAX_FILES : Math.max(opts.maxFiles, 0);
  const maxPipes = opts.maxPipes === undefined ? CITY_MAX_PIPES : Math.max(opts.maxPipes, 0);
  const chosen = ATLAS_LEVEL_DEPTH[level] === undefined ? 'file' : level;
  const levelBlocks = atlasLevelBlocks(hierarchy, chosen, { maxFiles });

  // Footprint and slab policy, per level. Everything else about a block is the
  // shared fact: a block's `facts` are identical here and in the 2D canvas.
  const geometry = (block) => {
    const declared = block.facts.declaredFunctions;
    const common = {
      analyzed: block.analyzed,
      files: block.facts.files,
      functionCount: declared,
      unresolved: block.facts.unresolvedCalls,
      unanalyzedFiles: block.facts.unanalyzedFiles,
      analyzedFiles: block.facts.analyzedFiles,
      level: chosen,
      filePaths: block.filePaths,
      file_id: block.fileId,
    };
    if (chosen === 'file') {
      const compression = atlasScaleCompression(declared);
      // A compressed column has fewer layer slots than the file has functions,
      // so the drawn layers are bounded by the height that is actually there.
      // Otherwise the layers would stack past the top of their own column.
      const layerSlots = Math.max(Math.floor(compression.height), 1);
      const visible = Math.min(block.functions.length, CITY_MAX_SLABS, layerSlots);
      // Radius is a second, weaker channel: it must not become the thing a
      // reader compares instead of the fact.
      const radius = atlasScaleRadius(declared);
      return {
        ...block, ...common,
        loadedSlabs: block.functions.length,
        visibleSlabs: visible,
        collapsedSlabs: Math.max(declared - visible, 0),
        slabsIncomplete: block.functions.length < declared,
        slabs: block.functions.slice(0, visible).map((s) => ({ id: s.id, name: s.name, start: s.start, end: s.end })),
        w: CITY_COLUMN_W * 0.62 * radius, d: CITY_COLUMN_D * 0.62 * radius,
        height: cityBlockHeight(declared),
        tier: compression.tier,
        compressed: compression.compressed,
        scaleLayerHeight: compression.height,
        linearLayerHeight: compression.linearHeight,
      };
    }
    if (chosen === 'district') {
      const scale = 1.2 + Math.min(Math.sqrt(Math.max(block.facts.files, 1)), 4) * 0.45;
      return {
        ...block, ...common,
        loadedSlabs: 0, visibleSlabs: 0, collapsedSlabs: 0, slabsIncomplete: false, slabs: [],
        w: CITY_COLUMN_W * scale, d: CITY_COLUMN_D * scale,
        height: cityBlockHeight(declared),
      };
    }
    return {
      ...block, ...common,
      loadedSlabs: 0, visibleSlabs: 0, collapsedSlabs: 0, slabsIncomplete: false, slabs: [],
      w: CITY_COLUMN_W * 3.4, d: CITY_COLUMN_D * 3.4,
      height: cityBlockHeight(declared),
    };
  };

  const plates = levelBlocks.plates.map((plate) => ({
    key: plate.key,
    label: chosen === 'project' ? '项目（全部目录）' : plate.label,
    level: chosen,
    blocks: plate.blockIds.map((id) => geometry(levelBlocks.blocks.find((b) => b.id === id))),
  }));

  // A pipe is a budget at every level, and the pipe universe is reported next to
  // it so "this level has fewer connections" can never be read as "the analysis
  // found fewer connections".
  const pairs = levelBlocks.pairs.slice(0, maxPipes);
  const internalPairs = levelBlocks.internalPairs;
  const shownFiles = levelBlocks.enumeratedFiles;

  const packed = cityPackPlates(plates);
  const districts = packed.districts, columns = packed.columns;

  // Centre the whole city on the origin so the camera can frame it.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const d of districts) {
    minX = Math.min(minX, d.x - d.w / 2); maxX = Math.max(maxX, d.x + d.w / 2);
    minZ = Math.min(minZ, d.z - d.d / 2); maxZ = Math.max(maxZ, d.z + d.d / 2);
  }
  if (!districts.length) { minX = maxX = minZ = maxZ = 0; }
  const offsetX = (minX + maxX) / 2, offsetZ = (minZ + maxZ) / 2;
  for (const d of districts) { d.x -= offsetX; d.z -= offsetZ; }
  for (const c of columns) { c.x -= offsetX; c.z -= offsetZ; }

  const totals = levelBlocks.totals;
  const drawnFunctions = columns.reduce((total, column) => total + column.functionCount, 0);
  // Readability of the scale, over every file in the hierarchy rather than over
  // the ones this budget happened to draw. It carries the linear result too, so
  // the page shows what the previous scale would have produced instead of
  // asking anyone to remember it.
  const declaredCounts = hierarchy.files.map(
    (file) => (hierarchy.byPath[file.path] ? hierarchy.byPath[file.path].facts.declaredFunctions : 0));
  const scale = atlasScaleReport(declaredCounts);
  const ruler = atlasScaleRuler(declaredCounts);
  const stats = {
    schema: 'atlas.city-level-stats.v1',
    level: chosen,
    levelLabel: cityLevelName(chosen),
    // Aggregated facts: identical at every level, because they come from the
    // hierarchy rather than from what this level happened to draw.
    files: totals.files,
    functions: totals.loadedFunctions,
    declaredFunctions: totals.declaredFunctions,
    loadedFunctions: totals.loadedFunctions,
    analyzedFiles: totals.analyzedFiles,
    unanalyzedFiles: totals.unanalyzedFiles,
    unresolvedCalls: totals.unresolvedCalls,
    callSites: totals.callSites,
    calls: hierarchy.candidateCalls,
    // Drawn facts: these are what the level decides.
    shownFiles,
    drawnBlocks: columns.length,
    districts: districts.length,
    loadedSlabs: columns.reduce((total, column) => total + column.loadedSlabs, 0),
    drawnSlabs: columns.reduce((total, column) => total + column.visibleSlabs, 0),
    resolvedPairs: levelBlocks.pairUniverse,
    shownPipes: pairs.length,
    internalPairs,
    omitted: { ...levelBlocks.omitted },
    budget: { ...levelBlocks.budget },
    scale,
    ruler,
    truncated: {
      files: levelBlocks.budget.files,
      pipes: levelBlocks.pairUniverse > pairs.length,
      slabs: columns.some((c) => c.collapsedSlabs > 0 || c.slabsIncomplete),
    },
  };

  return {
    schema: 'atlas.city-layout.v1',
    level: chosen,
    hierarchy,
    districts,
    columns,
    pipes: pairs,
    stats,
    invariants: cityLevelInvariants(hierarchy),
    bounds: { minX, maxX, minZ, maxZ },
    radius: Math.max(maxX - minX, maxZ - minZ, 24) / 2,
  };
}

/// The file level of the same hierarchy: the layout the rest of the workbench
/// and the 2D/3D agreement checks already consume.
function buildCityLayout(nodes, edges, options) {
  const opts = options || {};
  const hierarchy = buildCityHierarchy(nodes, edges);
  const layout = cityLevelView(hierarchy, opts.level || 'file', opts);
  // Kept for callers that only ever wanted the drawable city.
  return layout;
}

/// The state transition behind a level switch. Pure, so it can be tested
/// without a GPU -- which is exactly where an untested branch would hide: the
/// failure mode is a selection that silently re-anchors or a marker that stays
/// on a block that no longer represents its file.
function cityLevelSwitch(state, level, options) {
  const hierarchy = state.hierarchy || (state.layout && state.layout.hierarchy);
  if (!hierarchy) return { ok: false, code: 'no_layout', level };
  const keep = state.selectedFile || state.selected || null;
  const layout = cityLevelView(hierarchy, level, options || {});
  const observed = state.observed ? cityRunMarkers(state.observedSource || [], layout) : null;
  const column = keep
    ? layout.columns.find((entry) => entry.path === keep || (entry.filePaths || []).includes(keep))
    : null;
  return {
    ok: true,
    level: layout.level,
    layout,
    observed,
    runPaths: observed ? observed.paths : null,
    column,
    // The block to highlight, the object the user picked, and -- when the object
    // is genuinely not in this level's picture (the file level is capped) -- the
    // thing that was lost. Nothing is ever re-anchored to something else.
    selected: column ? column.path : null,
    selectedFile: column ? keep : null,
    lost: keep && !column ? keep : null,
  };
}

/// What the current level means, including anything it did not draw. A level is
/// not a budget: the two are reported separately or a reader would take "not
/// drawn at this level" for "not in the analysis".
function cityLevelLine(stats, invariants) {
  if (!stats) return '尚未加载';
  const parts = [
    `层级 ${stats.levelLabel || cityLevelName(stats.level)}`,
    `声明函数 ${stats.declaredFunctions}`,
    `柱体 ${stats.drawnBlocks}/${stats.files} 文件`,
  ];
  if (stats.level !== 'file') {
    parts.push('本层级不画函数层与逐文件柱体：这是层级定义，不是渲染预算');
  }
  if (stats.omitted.functions) {
    parts.push(`本层级未画出 ${stats.omitted.functions} 个函数（${stats.omitted.files} 个文件未入选）`);
  }
  if (stats.internalPairs) parts.push(`同层内部调用 ${stats.internalPairs} 未画成管道`);
  const check = invariants || { ok: null };
  parts.push(check.ok === true ? '层级聚合守恒 ✓'
    : (check.ok === false ? `层级聚合不守恒：${(check.violations || []).map((v) => v.key).join('、')}` : '层级聚合未校验'));
  return parts.join(' · ');
}

/// One line that states what the picture covers. A visual that cannot say how
/// much of the analysis it left out is not evidence, so this is always shown.
// Map published execution records onto the layout.
//
// Pure, so the mapping is testable without a GPU -- and so it is obvious that
// it only *reads* the static layout: an observation never adds a file, changes
// a height, or turns an unresolved call into a resolved one. A record whose file
// is not in the layout is reported as unplaced rather than dropped, because
// "we ran something not shown here" is information.
function cityRunMarkers(markers, layout) {
  const perPath = new Map();
  const perColumn = new Map();
  const unplaced = [];
  const verdicts = {};
  const columns = (layout && layout.columns) || [];
  // A record names a file. At a coarse level that file is represented by an
  // aggregate block, so the marker is *placed on* that block while the record
  // still says which file it was. Aggregating silently would let one run on one
  // file read as a run on the whole directory.
  const columnOf = (path) => columns.find((entry) => entry.path === path
    || (entry.filePaths || []).includes(path));
  for (const marker of markers || []) {
    const verdict = String(marker.verdict || 'unknown');
    verdicts[verdict] = (verdicts[verdict] || 0) + 1;
    const path = marker.path;
    const column = columnOf(path);
    if (!column) { unplaced.push(path || marker.symbol || '(unknown)'); continue; }
    if (!perPath.has(path)) perPath.set(path, { path, runs: 0, verdicts: {}, entries: [] });
    const record = perPath.get(path);
    record.runs += 1;
    record.verdicts[verdict] = (record.verdicts[verdict] || 0) + 1;
    record.entries.push({ symbol: marker.symbol, name: marker.name, verdict });
    if (!perColumn.has(column.path)) {
      perColumn.set(column.path, { path: column.path, runs: 0, files: [], aggregated: column.path !== path });
    }
    const block = perColumn.get(column.path);
    block.runs += 1;
    if (!block.files.includes(path)) block.files.push(path);
  }
  const placed = [...perPath.values()].sort((a, b) => b.runs - a.runs || a.path.localeCompare(b.path));
  const blocks = [...perColumn.values()].sort((a, b) => b.runs - a.runs || a.path.localeCompare(b.path));
  return {
    level: (layout && layout.level) || 'file',
    // The set the renderer colours by: column paths, so a coarse level colours
    // the block that really carries the run rather than nothing at all.
    paths: new Set(blocks.map((block) => block.path)),
    records: placed,
    columns: blocks,
    aggregated: blocks.filter((block) => block.aggregated).length,
    counts: verdicts,
    total: (markers || []).length,
    placed: placed.reduce((sum, record) => sum + record.runs, 0),
    unplaced,
  };
}

function cityObservedLine(observed) {
  if (!observed || !observed.total) return null;
  const parts = Object.entries(observed.counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([verdict, count]) => `${verdict} ${count}`);
  const blocks = observed.columns ? observed.columns.length : observed.records.length;
  const level = observed.level && observed.level !== 'file'
    ? `（层级 ${cityLevelName(observed.level)}：一个柱体代表多个文件，这是聚合，不是“整个目录都跑过”）`
    : '';
  const line = `观测（运行入口）${observed.total}：${parts.join(' · ')} · 落在 ${blocks} 个柱体 / ${observed.records.length} 个文件${level}`;
  return observed.unplaced.length ? `${line} · 未落在当前布局 ${observed.unplaced.length}` : line;
}

/// The scale, stated. A reader who cannot see the mapping from N to height
/// cannot tell a tall column from a compressed one, so the ruler travels with
/// the picture and the compression is named.
function cityScaleLine(stats) {
  if (!stats || !stats.scale) return '尚未加载';
  const scale = stats.scale;
  const ticks = (stats.ruler && stats.ruler.ticks ? stats.ruler.ticks : [])
    .map((tick) => `${tick.label}=${tick.height.toFixed(2)}层`).join(' · ');
  const parts = [
    `尺度 线性前 ${scale.scale.free} 层，其后对数压缩（每倍 +${scale.scale.gain} 层）`,
    `标尺 ${ticks}`,
    `中位柱/最高柱 ${scale.ratios.medianOverMax.toFixed(3)}`,
    `不足最高柱 1% 的列 ${scale.under.onePct}/${scale.under.of}`,
  ];
  if (scale.linear.onePct) parts.push(`（线性尺度下会是 ${scale.linear.onePct}/${scale.under.of}）`);
  if (scale.empty) parts.push(`N=0 矮柱 ${scale.empty}`);
  parts.push(scale.monotone ? '单调 ✓' : '单调 ✗ 尺度函数有缺陷');
  parts.push('压缩后的高度不是 LOC、耗时或质量分');
  return parts.join(' · ');
}

function cityCoverageLine(stats) {
  if (!stats) return '尚未加载';
  const parts = [
    `文件 ${stats.shownFiles}/${stats.files}`,
    `函数 ${stats.declaredFunctions}`,
    `管道 ${stats.shownPipes}/${stats.resolvedPairs}`,
    `未解析调用 ${stats.unresolvedCalls}`,
  ];
  if (stats.unanalyzedFiles) parts.push(`未分析文件 ${stats.unanalyzedFiles}`);
  const capped = [];
  if (stats.truncated.files) capped.push('文件');
  if (stats.truncated.pipes) capped.push('管道');
  if (stats.truncated.slabs) capped.push('函数层');
  parts.push(capped.length ? `已按预算截断：${capped.join('、')}` : '未截断');
  return parts.join(' · ');
}

/// What a column click should ask the engine for.
// Decide what a shared selection points at, without touching the DOM or the
// GPU. Kept pure so the decision -- including every refusal -- is testable:
// a wrong "yes" here would highlight the wrong column, and a wrong "no" would
// look like the two projections disagree when they do not.
function citySelectionTarget(pending, analysisId, nodes, layout) {
  if (!pending || !pending.entity_id) return { ok: false, code: 'no_selection' };
  if (pending.analysis && pending.analysis !== analysisId) {
    return {
      ok: false, code: 'stale_selection_version',
      selection_analysis: pending.analysis, served_analysis: analysisId || null,
    };
  }
  const node = (nodes || []).find(entry => entry.id === pending.entity_id);
  if (!node) return { ok: false, code: 'entity_not_loaded' };
  const column = layout && layout.columns.find((entry) => entry.path === node.path
    || (entry.filePaths || []).includes(node.path));
  if (!column) return { ok: false, code: 'entity_not_in_layout', path: node.path };
  // At a coarse level the selected file is represented by an aggregate block.
  // Highlighting it is correct *because the target is named*, and the answer
  // says the block is an aggregate: a reader must not conclude that the
  // directory itself is the object they picked in 2D.
  return {
    ok: true,
    path: column.path,
    file_path: node.path,
    entity_id: node.id,
    name: node.name,
    level: (layout && layout.level) || 'file',
    aggregated: (column.filePaths || [column.path]).length > 1,
  };
}

function citySelectionQuery(column) {
  if (!column) return null;
  // An aggregate block has no single object behind it, so there is no source to
  // read and no entity id to publish. Returning one would make the inspector
  // claim a directory is a file.
  if (column.aggregate) return null;
  if (column.file_id) return { entity: column.file_id, path: (column.filePaths || [])[0] || column.path, name: column.name };
  return { entity: column.id, path: column.path, name: column.name };
}

// ---------------------------------------------------------------------------
// Minimal vector/matrix maths. Column-major, because that is what WebGL wants.
// ---------------------------------------------------------------------------
function citySub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cityDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cityCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function cityNormalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
function cityPerspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
function cityLookAt(eye, center, up) {
  const z = cityNormalize(citySub(eye, center));
  const x = cityNormalize(cityCross(up, z));
  const y = cityCross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -cityDot(x, eye), -cityDot(y, eye), -cityDot(z, eye), 1,
  ]);
}
/// Distance from `origin` along `dir` to an axis-aligned box, or null.
/// Used for picking, so it must agree with what was actually drawn.
function cityRayBox(origin, dir, min, max) {
  let near = -Infinity, far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const d = dir[axis];
    if (Math.abs(d) < 1e-8) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    let t1 = (min[axis] - origin[axis]) / d;
    let t2 = (max[axis] - origin[axis]) / d;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  return far < 0 ? null : Math.max(near, 0);
}

// ---------------------------------------------------------------------------
// Unit geometry, generated once. Instancing carries the per-object transform.
// ---------------------------------------------------------------------------
function cityBoxSolid() {
  const faces = [
    { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { n: [1, 0, 0], v: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { n: [-1, 0, 0], v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ];
  const positions = [], normals = [], indices = [];
  faces.forEach((face, index) => {
    const base = index * 4;
    for (const vertex of face.v) positions.push(...vertex);
    for (let i = 0; i < 4; i++) normals.push(...face.n);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}
function cityCylinderSolid(segments) {
  const positions = [], normals = [], indices = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle) * 0.5, z = Math.sin(angle) * 0.5;
    positions.push(x, 0.5, z); normals.push(Math.cos(angle), 0, Math.sin(angle));
    positions.push(x, -0.5, z); normals.push(Math.cos(angle), 0, Math.sin(angle));
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // Caps, so a column never reads as a hollow tube from above.
  for (const side of [1, -1]) {
    const centre = positions.length / 3;
    positions.push(0, side * 0.5, 0); normals.push(0, side, 0);
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(angle) * 0.5, side * 0.5, Math.sin(angle) * 0.5);
      normals.push(0, side, 0);
    }
    for (let i = 0; i < segments; i++) {
      if (side > 0) indices.push(centre, centre + 1 + i, centre + 2 + i);
      else indices.push(centre, centre + 2 + i, centre + 1 + i);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}
function cityBoxWire() {
  const c = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const positions = [];
  for (const [a, b] of pairs) positions.push(...c[a], ...c[b]);
  return { positions: new Float32Array(positions) };
}
function cityCylinderWire(segments) {
  const positions = [];
  for (const y of [0.5, -0.5]) {
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2, a2 = ((i + 1) / segments) * Math.PI * 2;
      positions.push(Math.cos(a1) * 0.5, y, Math.sin(a1) * 0.5, Math.cos(a2) * 0.5, y, Math.sin(a2) * 0.5);
    }
  }
  return { positions: new Float32Array(positions) };
}

// ---------------------------------------------------------------------------
// Shaders. Deliberately plain: the light is fixed and the camera is the only
// thing that moves, so the picture cannot imply anything the data did not say.
// ---------------------------------------------------------------------------
const CITY_SOLID_VS = `#version 300 es
in vec3 aPos; in vec3 aNormal;
in vec3 iOffset; in vec3 iScale; in vec3 iColor; in float iGlow;
uniform mat4 uProj; uniform mat4 uView;
out vec3 vNormal; out vec3 vColor; out float vGlow; out vec3 vWorld;
void main() {
  vec3 world = aPos * iScale + iOffset;
  // Axis-aligned non-uniform scale: the correct normal transform is the
  // inverse, which for a diagonal scale is a component-wise divide.
  vNormal = normalize(aNormal / max(iScale, vec3(0.001)));
  vWorld = world; vColor = iColor; vGlow = iGlow;
  gl_Position = uProj * uView * vec4(world, 1.0);
}`;
const CITY_SOLID_FS = `#version 300 es
precision highp float;
in vec3 vNormal; in vec3 vColor; in float vGlow; in vec3 vWorld;
uniform vec3 uEye;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.42, 0.82, 0.38));
  float diff = max(dot(n, lightDir), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 base = vColor * (0.32 + 0.72 * diff) + vColor * 0.22 * hemi + vColor * vGlow;
  vec3 viewDir = normalize(uEye - vWorld);
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0);
  outColor = vec4(base + vColor * rim * 0.30, 1.0);
}`;
const CITY_WIRE_VS = `#version 300 es
in vec3 aPos; in vec3 iOffset; in vec3 iScale; in vec4 iColor;
uniform mat4 uProj; uniform mat4 uView;
out vec4 vColor;
void main() {
  vColor = iColor;
  gl_Position = uProj * uView * vec4(aPos * iScale + iOffset, 1.0);
}`;
const CITY_WIRE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;
const CITY_LINE_VS = `#version 300 es
in vec3 aPos; in vec4 aColor;
uniform mat4 uProj; uniform mat4 uView;
out vec4 vColor;
void main() { vColor = aColor; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;
const CITY_LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

function cityCompile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('shader: ' + log);
  }
  return shader;
}
function cityProgram(gl, vsSource, fsSource) {
  const program = gl.createProgram();
  gl.attachShader(program, cityCompile(gl, gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, cityCompile(gl, gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(program));
  }
  return program;
}
function cityBuffer(gl, data, target) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return buffer;
}
function cityAttribute(gl, program, name) {
  const location = gl.getAttribLocation(program, name);
  return location < 0 ? null : location;
}

/// An instanced mesh: one unit geometry drawn once per instance, with the
/// per-instance offset/scale/colour in their own buffers. This is what keeps a
/// thousand columns to a single draw call.
function cityInstances(gl, program, geometry, list, options) {
  const opts = options || {};
  const count = list.length;
  const offset = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const color = new Float32Array(count * (opts.rgba ? 4 : 3));
  const glow = new Float32Array(count);
  const stride = opts.rgba ? 4 : 3;
  list.forEach((item, index) => {
    offset.set(item.offset, index * 3);
    scale.set(item.scale, index * 3);
    for (let i = 0; i < stride; i++) color[index * stride + i] = item.color[i];
    glow[index] = item.glow || 0;
  });
  const mesh = {
    program, count,
    buffers: {
      offset: cityBuffer(gl, offset, gl.ARRAY_BUFFER),
      scale: cityBuffer(gl, scale, gl.ARRAY_BUFFER),
      color: cityBuffer(gl, color, gl.ARRAY_BUFFER),
      glow: cityBuffer(gl, glow, gl.ARRAY_BUFFER),
    },
    geometry: {
      position: cityBuffer(gl, geometry.positions, gl.ARRAY_BUFFER),
      normal: geometry.normals ? cityBuffer(gl, geometry.normals, gl.ARRAY_BUFFER) : null,
      index: geometry.indices ? cityBuffer(gl, geometry.indices, gl.ELEMENT_ARRAY_BUFFER) : null,
      vertices: geometry.indices ? geometry.indices.length : geometry.positions.length / 3,
    },
  };
  return mesh;
}
function cityDrawInstances(gl, mesh, prog) {
  if (!mesh || !mesh.count) return;
  gl.useProgram(mesh.program);
  gl.uniformMatrix4fv(prog.uProj, false, prog.projection);
  gl.uniformMatrix4fv(prog.uView, false, prog.view);
  if (prog.uEye) gl.uniform3fv(prog.uEye, prog.eye);
  const bind = (buffer, name, size, divisor) => {
    const location = cityAttribute(gl, mesh.program, name);
    if (location === null) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, divisor);
  };
  bind(mesh.geometry.position, 'aPos', 3, 0);
  if (mesh.geometry.normal) bind(mesh.geometry.normal, 'aNormal', 3, 0);
  bind(mesh.buffers.offset, 'iOffset', 3, 1);
  bind(mesh.buffers.scale, 'iScale', 3, 1);
  bind(mesh.buffers.color, 'iColor', prog.rgbaInstances ? 4 : 3, 1);
  if (mesh.geometry.normal) bind(mesh.buffers.glow, 'iGlow', 1, 1);
  if (mesh.geometry.index) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.geometry.index);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.geometry.vertices, gl.UNSIGNED_SHORT, 0, mesh.count);
  } else {
    gl.drawArraysInstanced(gl.LINES, 0, mesh.geometry.vertices, mesh.count);
  }
}

// ---------------------------------------------------------------------------
// Scene. Colours repeat the 2D legend exactly, so a reader who learned the
// workbench does not have to learn a second language: blue is a resolved
// candidate, amber is something the analysis could not resolve.
// ---------------------------------------------------------------------------
const CITY_FOV = Math.PI / 4;
const CITY_PALETTE = {
  plate: [0.88, 0.91, 0.94],
  plateWire: [0.66, 0.75, 0.81, 1],
  grid: [0.84, 0.88, 0.91, 1],
  slabA: [0.30, 0.66, 0.76],
  slabB: [0.37, 0.72, 0.81],
  collapsed: [0.70, 0.66, 0.58],
  // The compression ring is deliberately not a data colour: it is a statement
  // about the scale, not about the code.
  compression: [0.69, 0.54, 0.24],
  unanalyzed: [0.80, 0.78, 0.74],
  stub: [0.80, 0.63, 0.33],
  pipe: [0.33, 0.66, 0.76, 0.42],
  pipeHot: [0.08, 0.53, 0.66, 0.95],
  selected: [0.05, 0.46, 0.58],
  wire: [0.48, 0.64, 0.74, 0.75],
  wireSelected: [0.05, 0.42, 0.54, 1],
  // Observed, not static: a file whose functions Atlas has actually run. Kept
  // visually separate from `pipeHot` (a resolved static candidate) because
  // "we ran this" and "this may call that" are different kinds of claim.
  wireObserved: [0.10, 0.62, 0.42, 1],
};

/// One solid instance list for the whole city: slabs, their base plinth, and
/// the amber stub that stands for "this file makes calls we could not resolve".
function cityColumnInstances(layout, mode, selectedPath) {
  const list = [];
  for (const column of layout.columns) {
    const selected = column.path === selectedPath;
    const unanalyzed = !column.analyzed;
    // A file that was never analysed keeps its own solid marker: still visible,
    // so it is not hidden from the picture, but plainly a different kind of
    // object from a column that carries analysed function layers.
    // A block with no function layers under it is drawn as a solid block at
    // every camera distance. Without this a coarse level would collapse to a
    // bare plinth as soon as the camera came near -- a level that disappears
    // when you look at it is worse than no level at all.
    if (mode === 'file' || unanalyzed || column.slabDetail === false) {
      list.push({
        offset: [column.x, column.height / 2, column.z],
        scale: [column.w, column.height, column.d],
        color: selected ? CITY_PALETTE.selected : (unanalyzed ? CITY_PALETTE.unanalyzed : CITY_PALETTE.slabA),
        glow: selected ? 0.22 : 0.05,
      });
    } else {
      list.push({
        offset: [column.x, CITY_BASE_H / 2, column.z],
        scale: [column.w * 1.20, CITY_BASE_H, column.d * 1.20],
        color: CITY_PALETTE.plate,
        glow: 0,
      });
      column.slabs.forEach((slab, index) => {
        list.push({
          offset: [column.x, CITY_BASE_H + index * CITY_SLAB_H + CITY_SLAB_H / 2, column.z],
          scale: [column.w, CITY_SLAB_H * 0.86, column.d],
          color: selected ? CITY_PALETTE.selected : (index % 2 ? CITY_PALETTE.slabB : CITY_PALETTE.slabA),
          glow: selected ? 0.28 : 0.04,
        });
      });
      if (column.collapsedSlabs > 0) {
        // The remainder runs to the top of the column that exists. On a
        // compressed column that is far less than one layer per remaining
        // function, and the marker below says so instead of leaving the reader
        // to measure it.
        const bottom = CITY_BASE_H + column.visibleSlabs * CITY_SLAB_H;
        const height = Math.max(column.height - bottom, 0);
        list.push({
          offset: [column.x, bottom + height / 2, column.z],
          scale: [column.w * 0.86, Math.max(height, 1e-3), column.d * 0.86],
          color: CITY_PALETTE.collapsed,
          glow: 0,
        });
      }
      if (column.compressed) {
        // "Compressed scale marker": a ring at the layer where linearity stops.
        // A compressed height that is not drawn as compressed is a wrong number
        // with a nicer finish.
        list.push({
          offset: [column.x, CITY_BASE_H + ATLAS_SCALE_FREE * CITY_SLAB_H, column.z],
          scale: [column.w * 1.16, CITY_SLAB_H * 0.30, column.d * 1.16],
          color: CITY_PALETTE.compression,
          glow: 0.1,
        });
      }
    }
    if (column.unresolved > 0) {
      const height = Math.min(column.unresolved, 6) * 0.55;
      list.push({
        offset: [column.x + column.w * 0.95, height / 2, column.z],
        scale: [0.36, height, 0.36],
        color: CITY_PALETTE.stub,
        glow: 0.15,
      });
    }
  }
  for (const district of layout.districts) {
    list.push({
      offset: [district.x, -0.22, district.z],
      scale: [district.w, 0.44, district.d],
      color: CITY_PALETTE.plate,
      glow: 0,
    });
  }
  return list;
}
function cityWireInstances(layout, selectedPath, runPaths) {
  const list = [];
  for (const column of layout.columns) {
    const selected = column.path === selectedPath;
    const observed = runPaths ? runPaths.has(column.path) : false;
    list.push({
      offset: [column.x, column.height / 2, column.z],
      scale: [column.w * 1.02, column.height, column.d * 1.02],
      color: selected ? CITY_PALETTE.wireSelected
        : (observed ? CITY_PALETTE.wireObserved
          : (column.analyzed ? CITY_PALETTE.wire : CITY_PALETTE.plateWire)),
    });
  }
  for (const district of layout.districts) {
    list.push({ offset: [district.x, -0.22, district.z], scale: [district.w, 0.44, district.d], color: CITY_PALETTE.plateWire });
  }
  return list;
}
function cityGridSegments(layout) {
  const positions = [], colors = [];
  const step = 4;
  const n = Math.max(6, Math.ceil((layout.radius * 1.25) / step));
  const push = (x1, z1, x2, z2) => {
    positions.push(x1, 0, z1, x2, 0, z2);
    colors.push(...CITY_PALETTE.grid, ...CITY_PALETTE.grid);
  };
  for (let i = -n; i <= n; i++) {
    push(i * step, -n * step, i * step, n * step);
    push(-n * step, i * step, n * step, i * step);
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}
/// A pipe is a quadratic arc between two columns. It is drawn once and never
/// animated: motion would read as execution order, and this is a static graph.
function cityPipeSegments(layout, selectedPath) {
  const positions = [], colors = [];
  const byPath = new Map(layout.columns.map((c) => [c.path, c]));
  const push = (a, b, color) => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    colors.push(...color, ...color);
  };
  for (const pipe of layout.pipes) {
    const from = byPath.get(pipe.from), to = byPath.get(pipe.to);
    if (!from || !to) continue;
    const p0 = [from.x, 0.4, from.z], p2 = [to.x, 0.4, to.z];
    const span = Math.hypot(p0[0] - p2[0], p0[2] - p2[2]);
    const mid = [(p0[0] + p2[0]) / 2, 1.8 + span * 0.14, (p0[2] + p2[2]) / 2];
    const color = selectedPath && (pipe.from === selectedPath || pipe.to === selectedPath)
      ? CITY_PALETTE.pipeHot : CITY_PALETTE.pipe;
    const steps = 14;
    let previous = p0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      const point = [
        u * u * p0[0] + 2 * u * t * mid[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * mid[1] + t * t * p2[1],
        u * u * p0[2] + 2 * u * t * mid[2] + t * t * p2[2],
      ];
      push(previous, point, color);
      previous = point;
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}

// ---------------------------------------------------------------------------
// Camera. Spherical orbit around the city centre; the projection is a real
// perspective one, which is what separates this from a tilted flat drawing.
// ---------------------------------------------------------------------------
function cityDefaultCamera(layout) {
  return {
    target: [0, 4, 0],
    distance: layout.radius * 1.5 + 24,
    azimuth: -0.7,
    elevation: 0.62,
  };
}
function cityEye(camera) {
  const cosE = Math.cos(camera.elevation), sinE = Math.sin(camera.elevation);
  return [
    camera.target[0] + camera.distance * cosE * Math.cos(camera.azimuth),
    camera.target[1] + camera.distance * sinE,
    camera.target[2] + camera.distance * cosE * Math.sin(camera.azimuth),
  ];
}
function cityRay(camera, ndcX, ndcY, aspect) {
  const eye = cityEye(camera);
  const forward = cityNormalize(citySub(camera.target, eye));
  const right = cityNormalize(cityCross(forward, [0, 1, 0]));
  const up = cityCross(right, forward);
  const tan = Math.tan(CITY_FOV / 2);
  const dir = cityNormalize([
    forward[0] + right[0] * ndcX * tan * aspect + up[0] * ndcY * tan,
    forward[1] + right[1] * ndcX * tan * aspect + up[1] * ndcY * tan,
    forward[2] + right[2] * ndcX * tan * aspect + up[2] * ndcY * tan,
  ]);
  return { origin: eye, dir };
}
/// Picking must agree with what was drawn, so it tests the same boxes the
/// instance buffers were built from.
function cityPick(layout, camera, ndcX, ndcY, aspect) {
  const ray = cityRay(camera, ndcX, ndcY, aspect);
  let best = null, bestDistance = Infinity;
  for (const column of layout.columns) {
    const distance = cityRayBox(ray.origin, ray.dir,
      [column.x - column.w / 2, 0, column.z - column.d / 2],
      [column.x + column.w / 2, column.height, column.z + column.d / 2]);
    if (distance !== null && distance < bestDistance) { bestDistance = distance; best = column; }
  }
  return best;
}
function cityTransform(matrix, point) {
  const x = point[0], y = point[1], z = point[2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
  ];
}

// ---------------------------------------------------------------------------
// Data access. Same session token, same fixed Analysis, same boundaries as the
// 2D workbench: this page can read a published analysis and nothing else.
// ---------------------------------------------------------------------------
async function cityLoadPages(api, name, params, maxPages) {
  const items = [];
  let cursor = null, total = 0, complete = false;
  for (let page = 0; page < maxPages; page++) {
    const query = Object.assign({ limit: 500 }, params || {}, cursor ? { cursor } : {});
    const result = await api(name, query);
    items.push(...result.items);
    total = result.total;
    cursor = result.next_cursor;
    if (!cursor) { complete = true; break; }
  }
  return { items, total, complete };
}

function cityWireMesh(gl, bundle, geometry, list) {
  const mesh = cityInstances(gl, bundle.program, geometry, list, { rgba: true });
  mesh.uniforms = bundle.uniforms;
  return mesh;
}
function citySolidMesh(gl, bundle, geometry, list) {
  const mesh = cityInstances(gl, bundle.program, geometry, list, {});
  mesh.uniforms = bundle.uniforms;
  return mesh;
}
function cityLineMesh(gl, bundle, segments) {
  return {
    program: bundle.program,
    uniforms: bundle.uniforms,
    position: cityBuffer(gl, segments.positions, gl.ARRAY_BUFFER),
    color: cityBuffer(gl, segments.colors, gl.ARRAY_BUFFER),
    vertices: segments.positions.length / 3,
  };
}
function cityFrame(bundle, projection, view, eye, rgbaInstances) {
  return {
    uProj: bundle.uniforms.uProj,
    uView: bundle.uniforms.uView,
    uEye: bundle.uniforms.uEye || null,
    projection, view, eye, rgbaInstances,
  };
}
function cityDrawLines(gl, mesh, projection, view) {
  if (!mesh || !mesh.vertices) return;
  gl.useProgram(mesh.program);
  const position = cityAttribute(gl, mesh.program, 'aPos');
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.position);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(position, 0);
  const color = cityAttribute(gl, mesh.program, 'aColor');
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.color);
  gl.enableVertexAttribArray(color);
  gl.vertexAttribPointer(color, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(color, 0);
  gl.uniformMatrix4fv(mesh.uniforms.uProj, false, projection);
  gl.uniformMatrix4fv(mesh.uniforms.uView, false, view);
  gl.drawArrays(gl.LINES, 0, mesh.vertices);
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------
function cityText(id, value) {
  const element = typeof document === 'undefined' ? null : document.getElementById(id);
  if (element) element.textContent = value;
}

async function city3dStart(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true });
  if (!gl) {
    cityText('city-status', '此浏览器或设备没有可用的 WebGL2，3D 城市无法渲染。2D 工作台不受影响。');
    return;
  }
  let solidProgram, wireProgram, lineProgram;
  try {
    solidProgram = { program: cityProgram(gl, CITY_SOLID_VS, CITY_SOLID_FS) };
    wireProgram = { program: cityProgram(gl, CITY_WIRE_VS, CITY_WIRE_FS) };
    lineProgram = { program: cityProgram(gl, CITY_LINE_VS, CITY_LINE_FS) };
    for (const bundle of [solidProgram, wireProgram, lineProgram]) {
      bundle.uniforms = {
        uProj: gl.getUniformLocation(bundle.program, 'uProj'),
        uView: gl.getUniformLocation(bundle.program, 'uView'),
        uEye: gl.getUniformLocation(bundle.program, 'uEye'),
      };
    }
  } catch (error) {
    cityText('city-status', '着色器编译失败：' + String(error.message || error));
    return;
  }
  const solidGeometry = { box: cityBoxSolid(), cylinder: cityCylinderSolid(24) };
  const wireGeometry = { box: cityBoxWire(), cylinder: cityCylinderWire(24) };

  const state = {
    token: '', api: null, layout: null,
    // A valid camera from the first frame: the loop starts before any data is
    // loaded, and a null camera used to throw before the next frame was even
    // scheduled, which killed the loop for the rest of the session.
    camera: cityDefaultCamera({ radius: 40 }),
    shape: 'box', mode: 'function', level: 'file', selected: null,
    analysisId: null, selection: null, pendingSelection: null,
    observed: null, observedSource: [], runPaths: null,
    meshes: { solid: null, wire: null, grid: null, pipes: null },
    // Everything the projection is allowed to know about the analysis, kept so
    // a level switch re-reads the same facts instead of querying again.
    hierarchy: null, nodes: [],
    labels: [],
    dragging: null, moved: 0,
  };

  const labelHost = typeof document === 'undefined' ? null : document.getElementById('city-labels');

  function describeLevel() {
    if (!state.layout) return;
    cityText('city-level', cityLevelLine(state.layout.stats, state.layout.invariants));
    cityText('city-scale', cityScaleLine(state.layout.stats));
  }

  function rebuildScene() {
    if (!state.layout) return;
    const columns = cityColumnInstances(state.layout, state.mode, state.selected);
    state.meshes.solid = citySolidMesh(gl, solidProgram, solidGeometry[state.shape], columns);
    state.meshes.wire = cityWireMesh(gl, wireProgram, wireGeometry[state.shape], cityWireInstances(state.layout, state.selected, state.runPaths));
    state.meshes.grid = cityLineMesh(gl, lineProgram, cityGridSegments(state.layout));
    state.meshes.pipes = cityLineMesh(gl, lineProgram, cityPipeSegments(state.layout, state.selected));
    if (labelHost) {
      labelHost.replaceChildren();
      state.labels = state.layout.districts.map((district) => {
        const element = document.createElement('div');
        element.className = 'city-label';
        element.textContent = `${district.label} · ${district.files}`;
        labelHost.append(element);
        return { element, district };
      });
    }
    describeLevel();
  }

  /// Switch the level of detail. The layout is rebuilt from the same hierarchy,
  /// so the facts cannot change with the level; only what is drawn does. A
  /// selection is kept and re-resolved at the new level rather than dropped:
  /// the user's *object* did not change even though the picture did.
  function setLevel(level) {
    // The decision is the pure `cityLevelSwitch`; this only pushes the result
    // into the scene.
    const next = cityLevelSwitch(state, level);
    state.level = next.level || level;
    if (!next.ok) return;
    state.layout = next.layout;
    if (state.observed) {
      state.observed = next.observed;
      state.runPaths = next.runPaths;
      const line = cityObservedLine(next.observed);
      if (line) cityText('city-observed', line);
    }
    if (!next.column) {
      state.selected = null;
      state.selectedFile = null;
      rebuildScene();
      if (next.lost) cityText('city-selected', `原选区 ${next.lost} 不在当前层级的绘制范围内，已取消高亮；切换层级或重新选择。`);
      return;
    }
    selectColumn(next.column, next.selectedFile);
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(canvas.clientWidth, 1), height = Math.max(canvas.clientHeight, 1);
    const pixelWidth = Math.floor(width * ratio), pixelHeight = Math.floor(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
  }

  function updateLabels(view, projection) {
    if (!labelHost || !state.labels.length) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    for (const label of state.labels) {
      const point = cityTransform(view, [label.district.x, 0.6, label.district.z]);
      const clip = cityTransform(projection, point);
      if (clip[3] <= 0.001) { label.element.style.display = 'none'; continue; }
      label.element.style.display = '';
      label.element.style.transform =
        `translate(-50%,-50%) translate(${(clip[0] / clip[3] * 0.5 + 0.5) * width}px,${(1 - (clip[1] / clip[3] * 0.5 + 0.5)) * height}px)`;
    }
  }

  function frame() {
    // Scheduled before any work: a single bad frame must not be able to stop
    // the loop, because a stopped loop looks exactly like "nothing to draw".
    requestAnimationFrame(frame);
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.965, 0.976, 0.984, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!state.layout) return;

    const near = state.layout.radius * 1.7 + 34;
    const held = state.mode === 'function' ? near * 1.25 : near * 0.8;
    const wanted = state.camera.distance < held ? 'function' : 'file';
    if (wanted !== state.mode) { state.mode = wanted; rebuildScene(); }

    const eye = cityEye(state.camera);
    const view = cityLookAt(eye, state.camera.target, [0, 1, 0]);
    const projection = cityPerspective(CITY_FOV, canvas.width / Math.max(canvas.height, 1), 0.5, 4000);

    cityDrawLines(gl, state.meshes.grid, projection, view);
    gl.depthMask(false);
    cityDrawLines(gl, state.meshes.pipes, projection, view);
    gl.depthMask(true);
    cityDrawInstances(gl, state.meshes.solid, cityFrame(solidProgram, projection, view, eye, false));
    cityDrawInstances(gl, state.meshes.wire, cityFrame(wireProgram, projection, view, eye, true));
    updateLabels(view, projection);
  }

  // A shared selection: an entity id plus the analysis version it was chosen
  // in. The city is a second projection of the same analysis, so it is the
  // right place to prove the two views agree -- and the right place to refuse
  // when they do not.
  function cityPublishSelection(entityId) {
    state.selection = entityId ? { analysis_id: state.analysisId || '', entity_id: entityId } : null;
    const note = typeof document === 'undefined' ? null : document.getElementById('city-selection-note');
    const stage = typeof document === 'undefined' ? null : document.getElementById('city-stage');
    if (stage) {
      if (entityId) { stage.setAttribute('data-selection-entity', entityId); stage.setAttribute('data-analysis-id', state.analysisId || ''); }
      else { stage.removeAttribute('data-selection-entity'); stage.removeAttribute('data-analysis-id'); }
    }
    if (note && entityId) note.textContent = '共享选区：' + entityId;
    if (typeof history !== 'undefined') {
      const hash = entityId ? `#selection=${encodeURIComponent(entityId)}&analysis=${encodeURIComponent(state.analysisId || '')}` : '';
      history.replaceState(null, '', location.pathname + hash);
    }
  }

  async function cityApplySelection(pending, nodes) {
    const note = typeof document === 'undefined' ? null : document.getElementById('city-selection-note');
    if (!pending || !pending.entity_id) return;
    const target = citySelectionTarget(pending, state.analysisId, nodes.items, state.layout);
    if (!target.ok) {
      // Refuse rather than re-anchor. Highlighting something here would say
      // "this is the object you selected" about an object that may not exist in
      // the version this projection is serving.
      const message = {
        stale_selection_version: `该选区固定在另一个分析版本（${String(target.selection_analysis).slice(0, 12)}），未在此视图中高亮。请在此重新选择，或打开那个版本。`,
        entity_not_loaded: '选区指向的对象不在当前已加载的节点里，未高亮。',
        entity_not_in_layout: `选区属于 ${target.path}，但该文件不在当前已加载的布局里，未高亮。`,
        no_selection: '',
      }[target.code] || `选区无法应用（${target.code}），未高亮。`;
      if (note) note.textContent = message;
      return;
    }
    if (note) {
      note.textContent = target.aggregated
        ? `共享选区来自 2D：${target.name} · ${target.file_path}；当前层级（${cityLevelName(target.level)}）里它由聚合柱体代表，未做精确高亮。`
        : `共享选区来自 2D：${target.name} · ${target.path}`;
    }
    const column = state.layout.columns.find((entry) => entry.path === target.path
      || (entry.filePaths || []).includes(target.file_path || target.path));
    await selectColumn(column, target.file_path || target.path);
    cityPublishSelection(target.entity_id);
  }

  async function selectColumn(column, filePath) {
    state.selected = column ? column.path : null;
    // What the user picked, which at a coarse level is not the block's own
    // identity. Kept apart so switching levels can keep the *object* rather
    // than the aggregate that happened to represent it.
    state.selectedFile = column ? (filePath || (column.aggregate ? null : column.path)) : null;
    rebuildScene();
    const query = citySelectionQuery(column);
    if (!query) {
      cityText('city-selected', column && column.aggregate
        ? `${column.name} · 聚合柱体（${column.files} 个文件，声明 ${column.functionCount} 函数，未解析调用 ${column.unresolved}）· 没有单一源码可读；切到「文件」层级再点选具体文件。`
        : '未选中对象。点选一根柱体，查看它对应的文件。');
      cityText('city-source', '');
      cityText('city-source-meta', '');
      return;
    }
    cityText('city-selected',
      `${column.name} · ${column.path} · 声明 ${column.functionCount} 函数 · 已展开 ${column.visibleSlabs} 层 · 未解析调用 ${column.unresolved}`);
    cityText('city-source', '读取固定快照…');
    cityRenderMembers(filePath);
    try {
      const source = await state.api('source', { entity: query.entity });
      cityText('city-source', source.content);
      cityText('city-source-meta',
        `${source.start}–${source.end} 字节 · ${source.truncated ? '已截断' : '本次选区已展示'} · 来自快照，不读当前工作目录`);
    } catch (error) {
      cityText('city-source', '该对象可能没有可读取的源码：' + String(error.message || error));
      cityText('city-source-meta', '');
    }
  }

  // D2 文件成员：所选文件在这份分析里的真实函数成员。每个成员都能带回 2D
  // 工作台——选区、分析版本与令牌走 fragment（不进 HTTP 请求），抵达后 2D
  // 选中同一个对象。聚合柱体没有单一文件，列不出成员就明说。
  function cityRenderMembers(filePath) {
    const host = typeof document === 'undefined' ? null : document.getElementById('city-members');
    if (!host) return;
    host.replaceChildren();
    if (!filePath || !state.nodes.length) {
      const empty = document.createElement('p');
      empty.className = 'subtle';
      empty.textContent = filePath ? '这个柱体没有单一文件，切到「文件」层级点选具体文件后列出成员。' : '点选一根文件柱体，这里列出它的函数成员。';
      host.append(empty);
      return;
    }
    const members = state.nodes.filter((n) => n.kind === 'function' && n.path === filePath);
    if (!members.length) {
      const empty = document.createElement('p');
      empty.className = 'subtle';
      empty.textContent = `这一份分析没有给出 ${filePath} 的函数成员。`;
      host.append(empty);
      return;
    }
    for (const member of members.slice(0, 40)) {
      const link = document.createElement('a');
      link.className = 'city-member';
      link.textContent = member.name || member.id;
      link.title = `在 2D 工作台打开 ${member.name || member.id}（同一对象、同一版本）`;
      const params = new URLSearchParams();
      params.set('selection', member.id);
      params.set('analysis', state.analysisId || '');
      params.set('page', 'explore');
      if (state.token) params.set('token', state.token);
      link.setAttribute('href', `/#${params.toString()}`);
      host.append(link);
    }
    if (members.length > 40) {
      const note = document.createElement('p');
      note.className = 'subtle';
      note.textContent = `另有 ${members.length - 40} 个成员按显示上限省略。`;
      host.append(note);
    }
  }

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    state.dragging = { x: event.clientX, y: event.clientY, button: event.button, alt: event.altKey || event.shiftKey };
    state.moved = 0;
  });
  canvas.addEventListener('pointermove', (event) => {
    const drag = state.dragging;
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    state.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.button === 0 && !drag.alt) {
      state.camera.azimuth -= dx * 0.006;
      state.camera.elevation = Math.max(0.08, Math.min(1.45, state.camera.elevation + dy * 0.005));
    } else {
      const scale = state.camera.distance * 0.0016;
      const cosA = Math.cos(state.camera.azimuth), sinA = Math.sin(state.camera.azimuth);
      state.camera.target[0] -= (dx * cosA - dy * sinA) * scale;
      state.camera.target[2] -= (dx * sinA + dy * cosA) * scale;
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    const drag = state.dragging;
    state.dragging = null;
    // Clicking before an analysis is loaded has nothing to pick against; it
    // must be a no-op rather than a thrown exception.
    if (!drag || !state.layout || state.moved > 5 || drag.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    selectColumn(cityPick(state.layout, state.camera, ndcX, ndcY, rect.width / Math.max(rect.height, 1)));
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const limit = state.layout ? state.layout.radius * 14 + 200 : 2000;
    state.camera.distance = Math.max(8, Math.min(limit, state.camera.distance * Math.exp(event.deltaY * 0.0012)));
  }, { passive: false });

  const shapeButton = typeof document === 'undefined' ? null : document.getElementById('city-shape');
  const SHAPES = [['box', '方柱'], ['cylinder', '圆柱']];
  if (shapeButton) {
    shapeButton.onclick = () => {
      const index = SHAPES.findIndex((entry) => entry[0] === state.shape);
      state.shape = SHAPES[(index + 1) % SHAPES.length][0];
      shapeButton.textContent = '柱体：' + SHAPES.find((entry) => entry[0] === state.shape)[1];
      rebuildScene();
    };
  }
  const resetButton = typeof document === 'undefined' ? null : document.getElementById('city-reset');
  if (resetButton) {
    resetButton.onclick = () => { if (state.layout) state.camera = cityDefaultCamera(state.layout); };
  }
  // Formal LOD controls. Keyboard 1/2/3 and the buttons do the same thing, and
  // the level is a property of the projection -- not of the camera -- so it
  // survives a view reset.
  const levelButtons = typeof document === 'undefined' ? [] : CITY_LEVELS
    .map((level) => ({ level, element: document.getElementById(`city-level-${level}`) }))
    .filter((entry) => entry.element);
  function applyLevel(level) {
    setLevel(level);
    for (const entry of levelButtons) {
      entry.element.setAttribute('aria-pressed', entry.level === state.level ? 'true' : 'false');
    }
  }
  for (const entry of levelButtons) entry.element.onclick = () => applyLevel(entry.level);
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', (event) => {
      if (event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName || '')) return;
      const index = ['1', '2', '3'].indexOf(event.key);
      if (index === -1) return;
      // 1 = project, 2 = district, 3 = file: coarsest first, matching the
      // order in CITY_LEVELS.
      applyLevel(CITY_LEVELS[index]);
    });
  }

  async function connect() {
    const field = document.getElementById('city-token');
    const typed = field && field.value.trim();
    if (typed) state.token = typed;
    if (!state.token) { cityText('city-status', '请粘贴启动命令返回的 session_file 中的 token'); return; }
    cityText('city-status', '正在读取本地分析…');
    state.api = async (name, params) => {
      const response = await fetch(`/api/${name}?${new URLSearchParams(params || {})}`, {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!response.ok) throw new Error(`查询未完成 (${response.status})`);
      return response.json();
    };
    try {
      const report = await state.api('report');
      const nodes = await cityLoadPages(state.api, 'nodes', { kind: 'all' }, 8);
      const edges = await cityLoadPages(state.api, 'edges', { kind: 'call_candidate' }, 4);
      state.analysisId = report.id;
      state.nodes = nodes.items;
      // One hierarchy, then a view per level: the level can change without
      // re-querying, and cannot change what was counted.
      state.hierarchy = buildCityHierarchy(nodes.items, edges.items);
      state.layout = cityLevelView(state.hierarchy, state.level, {});
      // Observed runs are a separate query and a separate channel. If it fails,
      // the view says so rather than showing an empty observed layer, which
      // would read as "nothing has ever been run".
      try {
        const observedPage = await state.api('run-markers', { limit: 200 });
        state.observedSource = observedPage.markers || [];
        state.observed = cityRunMarkers(state.observedSource, state.layout);
        state.runPaths = state.observed.paths;
      } catch (error) {
        state.observed = null;
        state.runPaths = null;
        cityText('city-observed', '观测层不可用：运行记录查询失败，未显示任何"已运行"标记');
      }
      state.camera = cityDefaultCamera(state.layout);
      state.mode = 'function';
      rebuildScene();
      applyLevel(state.level);
      cityText('city-analysis', `分析版本 ${String(report.id).slice(0, 12)} · 文件 ${report.file_count} · 函数 ${report.function_count} · 调用点 ${report.call_count}`);
      const bounded = nodes.complete && edges.complete ? '' : '（分页达到上限，视图基于已加载的部分事实）';
      cityText('city-coverage', cityCoverageLine(state.layout.stats) + bounded);
      const observedLine = cityObservedLine(state.observed);
      if (observedLine) {
        cityText('city-observed', observedLine);
      } else if (state.observed) {
        cityText('city-observed', '观测（运行入口）0：还没有入口被运行过。管线是静态调用候选，与运行无关。');
      }
      cityText('city-status', '已连接 · 固定版本 · 本地只读查询');
      await cityApplySelection(state.pendingSelection, nodes);
      if (field) field.value = '';
    } catch (error) {
      cityText('city-status', `${error.message} · 无法读取分析`);
    }
  }
  const connectButton = typeof document === 'undefined' ? null : document.getElementById('city-connect');
  if (connectButton) connectButton.onclick = connect;
  const tokenField = typeof document === 'undefined' ? null : document.getElementById('city-token');
  if (tokenField) tokenField.addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });

  // The semantic surface for an external agent. Read-only plus highlight: the
  // city cannot write anything, and it must not pretend to.
  if (typeof globalThis !== 'undefined') {
    globalThis.atlasBridge = {
      version: 'atlas.agent-bridge.v1',
      bounded_actions: ['getSelection', 'highlight', 'openProjection'],
      getSelection() { return state.selection ? { ...state.selection } : null; },
      async highlight(entityId) {
        if (!state.layout) return { ok: false, error: 'no_layout' };
        // The bridge names an entity (a file or a function): resolve it through
        // the layout's own node ids and file membership, so a coarse level
        // highlights the block that really represents it and says it is an
        // aggregate instead of reporting "not in layout".
        const wanted = String(entityId).replace(/^file:/, '');
        const node = (state.nodes || []).find((entry) => entry.id === entityId);
        const path = node ? node.path : wanted;
        const column = state.layout.columns.find((c) => c.id === entityId || c.path === path
          || (c.filePaths || []).includes(path));
        if (!column) return { ok: false, error: 'entity_not_in_layout', path };
        await selectColumn(column, path);
        cityPublishSelection(entityId);
        return { ok: true, path: column.path, aggregated: Boolean(column.aggregate), level: state.layout.level };
      },
      openProjection(view) {
        const target = view === '2d' ? '/' : '/city3d';
        if (typeof location !== 'undefined') location.href = target;
        return target;
      },
    };
  }

  requestAnimationFrame(frame);
  // A fragment never travels in an HTTP request. It carries the token and,
  // optionally, the selection the 2D workbench was looking at.
  if (typeof location !== 'undefined' && location.hash) {
    const fragment = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
    if (fragment.selection || fragment.analysis) {
      state.pendingSelection = { entity_id: fragment.selection || '', analysis: fragment.analysis || '' };
    }
    if (fragment.token) {
      // 回 2D 的链接带上当前 fragment 中的选区:往返不丢当前对象。
      // (令牌本身从链接上剥掉——它已经进过一次页面,不再继续传递。)
      const back = document.querySelector('a.version[href="/"]');
      if (back && fragment.selection) {
        const roundTrip = new URLSearchParams();
        roundTrip.set('selection', fragment.selection);
        if (fragment.analysis) roundTrip.set('analysis', fragment.analysis);
        if (fragment.token) roundTrip.set('token', fragment.token);
        // 任务状态(页签/镜头)跟选区一起往返,读者回来还在同一项工作里。
        if (fragment.page) roundTrip.set('page', fragment.page);
        if (fragment.mode) roundTrip.set('mode', fragment.mode);
        if (fragment.lens) roundTrip.set('lens', fragment.lens);
        back.setAttribute('href', `/#${roundTrip.toString()}`);
      }
      history.replaceState(null, '', location.pathname);
      if (tokenField) tokenField.value = fragment.token;
      connect();
    }
  }
}

if (typeof document !== 'undefined') {
  const cityCanvas = document.getElementById('city-canvas');
  if (cityCanvas && typeof cityCanvas.getContext === 'function') {
    Promise.resolve()
      .then(() => city3dStart(cityCanvas))
      .catch((error) => cityText('city-status', '初始化失败：' + String((error && error.message) || error)));
  }
}
