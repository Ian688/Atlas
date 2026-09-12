// Layered layout for the 2D relationship canvas.
//
// The canvas used to place blocks in a fixed three-column grid, in load order.
// That is not a layout: a call graph drawn in load order has no layers, no
// ports and no relation between geometry and structure, so it cannot be read
// even when every number in it is correct. This file turns a bounded focus
// graph -- the target, its callers, its callees, and the boundary stubs for
// what could not be resolved -- into positioned boxes, ports, and edges that
// leave from those ports.
//
// Division of labour, which is the whole point of the file:
//   * what exists, what is unknown, what a budget cut, and what identity a
//     selection carries: Atlas, from the immutable facts;
//   * where a box goes: elkjs (vendored, pinned, coordinates only) or, if it is
//     unavailable or fails, a local layered ordering that *says it is the
//     fallback* rather than passing itself off as layout.
//
// Geometry is never a claim about the code. A box that moves does not change a
// fact, and nothing here may add, merge or re-target an edge: folding is
// reported as folding, with members, so a summary edge can never be mistaken
// for a direct call.

const ATLAS_LAYOUT_SCHEMA = 'atlas.focus-layout.v1';
const LAYOUT_NODE_W = 208;
const LAYOUT_NODE_H = 46;
const LAYOUT_UNRESOLVED_H = 40;
const LAYOUT_GAP_X = 96;
const LAYOUT_GAP_Y = 26;
const LAYOUT_PAD = 46;
const LAYOUT_PORT_H = 12;
// Above this the graph is folded instead of drawn. The cap is a budget and is
// reported as one; it is not a statement about the analysis.
const LAYOUT_MAX_NODES = 120;
// A character-width estimate for collision measurement. It is an estimate, and
// it is used to compare the same picture before and after, never to claim a
// pixel-accurate label metric.
const LAYOUT_CHAR_W = 6.6;

function layoutTruncate(text, max) {
  const value = String(text == null ? '' : text);
  return value.length <= max ? value : `${value.slice(0, Math.max(max - 1, 1))}…`;
}

/// Edges the focus query reported, split by what they actually claim.
/// `unresolved` targets are not nodes and never become one: they get a stub, so
/// "we could not resolve this" stays visible instead of shrinking the graph.
function layoutEdgeKind(edge) {
  if (edge && edge.unresolved) return 'unresolved';
  if (edge && edge.target) return 'direct';
  return 'unresolved';
}

/// BFS layers around the target, upstream negative and downstream positive.
/// Depth comes from the edges the analysis returned, so a node's layer is a
/// fact about the query, not a guess made for tidiness.
function layoutAssignLayers(rootId, adjacency) {
  const distance = new Map([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    const base = distance.get(current);
    for (const step of adjacency.get(current) || []) {
      if (distance.has(step.to)) continue;
      distance.set(step.to, base + step.sign);
      queue.push(step.to);
    }
  }
  const layers = new Map();
  for (const [id, value] of distance) {
    if (!layers.has(value)) layers.set(value, []);
    layers.get(value).push(id);
  }
  return { distance, layers };
}

/// Build the drawable model. Pure: no DOM, no GPU, no ELK.
function buildFocusModel(focus, nodes, options) {
  const opts = options || {};
  const maxNodes = opts.maxNodes === undefined ? LAYOUT_MAX_NODES : Math.max(opts.maxNodes, 0);
  const reach = focus || { edges: [], unresolved: [] };
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const rootId = opts.rootId;
  const parts = (reach.edges || []).filter((e) => e.target);
  const unresolved = (reach.unresolved || []).slice();

  // Which ids are real, drawable entities: the target plus everything the
  // focus query reached that this page actually loaded.
  const adjacency = new Map();
  const link = (from, to, sign) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ to, sign });
  };
  for (const edge of parts) {
    link(edge.source, edge.target, 1);
    link(edge.target, edge.source, -1);
  }
  const { distance, layers } = layoutAssignLayers(rootId, adjacency);

  const candidateIds = [...distance.keys()].filter((id) => id === rootId || byId.has(id));
  const candidateSet = new Set(candidateIds);

  // Fold outward layers when the picture would exceed the budget. A folded node
  // is attributed to the nearest drawn node on its path to the target, and the
  // summary edge carries the members -- so "A ... B" can never read as "A calls B".
  const ordered = candidateIds.slice().sort((a, b) => {
    const da = Math.abs(distance.get(a) || 0), db = Math.abs(distance.get(b) || 0);
    return (da - db) || String(a).localeCompare(String(b));
  });
  const drawnIds = new Set(ordered.slice(0, maxNodes));
  drawnIds.add(rootId);
  const foldedIds = candidateIds.filter((id) => !drawnIds.has(id));

  // A folded node has to be attributed to a *drawn* endpoint, at one end or
  // both, or the fold is invisible. The first version of this attributed the
  // fold to the folded node itself, so every summary edge was dropped by the
  // "both ends must be drawn" guard: the budget cut the picture and the picture
  // said nothing. Found by the layout bench reporting `summaryEdges: 0` for a
  // scenario with 81 folded nodes.
  const stepTowards = (id, outward) => {
    const here = distance.get(id);
    const steps = adjacency.get(id) || [];
    const wanted = steps.filter((step) => {
      const d = distance.get(step.to);
      if (d === undefined || here === undefined) return false;
      return outward ? Math.abs(d) > Math.abs(here) : Math.abs(d) < Math.abs(here);
    });
    const next = (wanted[0] || {}).to;
    return next && next !== id ? next : null;
  };
  const walkToDrawn = (id, outward) => {
    let current = id;
    const guard = new Set();
    while (current && !drawnIds.has(current) && !guard.has(current)) {
      guard.add(current);
      current = stepTowards(current, outward);
    }
    return current && drawnIds.has(current) ? current : null;
  };

  // Two shapes of fold, kept apart because they mean different things:
  //   * a chain between two drawn objects (A ... B): a summary edge whose
  //     members are the folded intermediates, labelled "via N" -- it must never
  //     read as a direct call;
  //   * a tail hanging off one drawn object with nothing drawn beyond it: a
  //     fold marker box, because there is no second drawn endpoint to draw to.
  const chains = new Map();
  const tails = new Map();
  let unattributed = 0;
  for (const id of foldedIds) {
    const inward = walkToDrawn(id, false);
    const outward = walkToDrawn(id, true);
    if (inward && outward && inward !== outward) {
      const key = `${inward}\u0000${outward}`;
      if (!chains.has(key)) chains.set(key, { from: inward, to: outward, members: [] });
      chains.get(key).members.push(id);
    } else if (inward) {
      // Grouped by anchor: one marker saying "N more are folded here". Keying
      // this by the member produced one marker per folded node, i.e. a budget
      // that folded 81 nodes into 81 boxes and saved nothing.
      if (!tails.has(inward)) tails.set(inward, { from: inward, members: [] });
      tails.get(inward).members.push(id);
    } else {
      unattributed += 1;
    }
  }

  const boxOf = (id) => {
    const node = byId.get(id);
    if (id === rootId) {
      return {
        id, role: 'target', unresolved: false,
        label: layoutTruncate(opts.rootLabel || (node ? node.name : id), 26),
        sub: layoutTruncate(node ? node.path : '', 34),
        fileId: node ? node.id : null,
      };
    }
    return {
      id, role: (distance.get(id) || 0) < 0 ? 'upstream' : 'downstream', unresolved: false,
      label: layoutTruncate(node ? node.name : id, 26),
      sub: layoutTruncate(node ? node.path : '（未载入本分析）', 34),
      // A node missing from this page has no identity to open, and saying so is
      // better than opening a same-named function from somewhere else.
      fileId: node ? node.id : null,
    };
  };

  const boxes = [...drawnIds].filter((id) => id === rootId || byId.has(id)).map(boxOf);
  const edges = [];
  // Anything with a box is drawable, which includes the fold markers created
  // below: they are boxes like any other, and a summary edge to one is how a
  // folded tail gets onto the picture at all.
  const drawable = new Set(drawnIds);
  const drawnEdge = (from, to, kind, label, extra) => {
    if (!drawable.has(from) || !drawable.has(to)) return;
    edges.push({
      id: `${kind}:${from}->${to}`, from, to, kind,
      label: layoutTruncate(label || 'call', 16), ...(extra || {}),
    });
  };
  for (const edge of parts) {
    if (!candidateSet.has(edge.source) || !candidateSet.has(edge.target)) continue;
    drawnEdge(edge.source, edge.target, 'direct', edge.label || 'call');
  }
  const foldedSummary = [];
  for (const entry of chains.values()) {
    const members = entry.members.slice().sort();
    foldedSummary.push({ from: entry.from, to: entry.to, members, viaCount: members.length });
    drawnEdge(entry.from, entry.to, 'summary', `经 ${members.length} 个函数`, {
      viaCount: members.length, members,
      // The declared relationship is "a folded chain runs between these two",
      // never "these two call each other".
      declared: 'folded_chain',
    });
  }
  for (const entry of tails.values()) {
    const members = entry.members.slice().sort();
    const id = `folded:${entry.from}:${members.length}`;
    boxes.push({
      id, role: 'folded', unresolved: false, folded: true,
      label: `折叠 ${members.length} 个函数`, sub: '预算之外的成员 · 可展开 · 未丢弃',
      fileId: null, members: members.slice(0, 24),
    });
    drawable.add(id);
    foldedSummary.push({ from: entry.from, to: id, members, viaCount: members.length });
    drawnEdge(entry.from, id, 'summary', `折叠 ${members.length}`, {
      viaCount: members.length, members, declared: 'folded_tail',
    });
  }
  // Fold markers are boxes like any other, so they get positions from the same
  // engine. A marker without a position would be a fold that is not on the
  // picture at all -- which is why they are pushed above, before planning.
  for (let index = 0; index < unresolved.length; index++) {
    const entry = unresolved[index];
    const id = `unresolved:${index}:${entry.label || ''}`;
    boxes.push({
      id, role: 'boundary', unresolved: true,
      label: `? ${layoutTruncate(entry.label || '未解析目标', 22)}`,
      sub: '未解析目标 · 边界桩 · 不丢弃',
      fileId: null,
    });
    edges.push({
      id: `unresolved:${rootId}->${id}`, from: rootId, to: id, kind: 'unresolved',
      label: layoutTruncate(entry.label || '未解析', 16),
    });
  }

  // Two boxes with one id is not a layout problem, it is a model problem, and
  // handing it to the engine produces a result nobody can interpret. Deduped
  // here, with the collision reported so it cannot pass as normal.
  const uniqueBoxes = [];
  const seenBoxIds = new Set();
  const duplicateBoxIds = [];
  for (const box of boxes) {
    if (seenBoxIds.has(box.id)) { duplicateBoxIds.push(box.id); continue; }
    seenBoxIds.add(box.id);
    uniqueBoxes.push(box);
  }

  const omittedNodes = foldedIds.length + unattributed;
  return {
    schema: ATLAS_LAYOUT_SCHEMA,
    targetId: rootId,
    boxes: uniqueBoxes,
    duplicateBoxIds,
    edges,
    folded: foldedSummary.sort((a, b) => (a.from.localeCompare(b.from)) || a.to.localeCompare(b.to)),
    omitted: { nodes: omittedNodes, unattributed, unresolved: unresolved.length },
    budget: { maxNodes, exceeded: candidateIds.length > maxNodes || omittedNodes > 0 },
    distance: Object.fromEntries([...distance.entries()]),
  };
}

/// A local layered ordering used only when the layout engine is unavailable.
/// It is deliberately simple: layers become columns, and within a column nodes
/// keep a stable order. It states what it is, because a fallback that looks
/// like a layout is worse than an admitted one.
function layoutFallback(model) {
  const columns = new Map();
  for (const box of model.boxes) {
    const depth = model.distance[box.id] === undefined ? 0 : model.distance[box.id];
    const key = box.unresolved ? 'boundary' : String(depth);
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(box);
  }
  const keys = [...columns.keys()].sort((a, b) => {
    if (a === 'boundary') return 1;
    if (b === 'boundary') return -1;
    return Number(a) - Number(b);
  });
  const placed = new Map();
  let x = LAYOUT_PAD;
  for (const key of keys) {
    const list = columns.get(key).slice().sort((a, b) => a.id.localeCompare(b.id));
    let y = LAYOUT_PAD;
    for (const box of list) {
      const height = box.unresolved ? LAYOUT_UNRESOLVED_H : LAYOUT_NODE_H;
      placed.set(box.id, { x, y, w: LAYOUT_NODE_W, h: height });
      y += height + LAYOUT_GAP_Y;
    }
    x += LAYOUT_NODE_W + LAYOUT_GAP_X;
  }
  return placed;
}

/// Ports: every edge gets its own attachment point, ordered by the vertical
/// position of the far end. Edges that share a box must not leave from the same
/// pixel -- "an edge crossing is geometry, a connection is a port".
function layoutPorts(placed, edges) {
  const ports = new Map();
  const ensure = (id) => {
    if (!ports.has(id)) ports.set(id, { id, left: [], right: [] });
    return ports.get(id);
  };
  for (const edge of edges) {
    const from = placed.get(edge.from), to = placed.get(edge.to);
    if (!from || !to) continue;
    const forward = (to.x + to.w / 2) >= (from.x + from.w / 2);
    const outSide = forward ? 'right' : 'left';
    const inSide = forward ? 'left' : 'right';
    ensure(edge.from)[outSide].push({ edge: edge.id, edgeRef: edge, sort: to.y });
    if (edge.to !== edge.from) ensure(edge.to)[inSide].push({ edge: edge.id, edgeRef: edge, sort: from.y });
  }
  const resolved = new Map();
  for (const [id, entry] of ports) {
    const box = placed.get(id);
    const side = (sideName) => {
      const list = entry[sideName].slice().sort((a, b) => (a.sort - b.sort) || a.edge.localeCompare(b.edge));
      const span = Math.max(box.h - LAYOUT_PORT_H, LAYOUT_PORT_H);
      return list.map((slot, index) => ({
        edge: slot.edge, edgeRef: slot.edgeRef, side: sideName,
        x: sideName === 'right' ? box.x + box.w : box.x,
        y: box.y + LAYOUT_PORT_H / 2 + (list.length === 1 ? span / 2 : (span * index) / (list.length - 1)),
      }));
    };
    resolved.set(id, { id, slots: [...side('left'), ...side('right')] });
  }
  return resolved;
}

/// Chord crossing count. The renderer draws a curve, so this counts crossings
/// of the straight chord between the two ports -- an estimate, but the same
/// estimate before and after a change, which is what makes it comparable.
function layoutSegmentCrossings(chords) {
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const cross = (a, b) => {
    const d1 = side({ x: a.x, y: a.y }, { x: a.x2, y: a.y2 }, { x: b.x, y: b.y });
    const d2 = side({ x: a.x, y: a.y }, { x: a.x2, y: a.y2 }, { x: b.x2, y: b.y2 });
    const d3 = side({ x: b.x, y: b.y }, { x: b.x2, y: b.y2 }, { x: a.x, y: a.y });
    const d4 = side({ x: b.x, y: b.y }, { x: b.x2, y: b.y2 }, { x: a.x2, y: a.y2 });
    return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
  };
  let count = 0;
  for (let i = 0; i < chords.length; i++) {
    for (let j = i + 1; j < chords.length; j++) {
      const a = chords[i], b = chords[j];
      if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue;
      if (cross(a, b)) count += 1;
    }
  }
  return count;
}

function layoutBoxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/// Labels sit beside the middle of their edge. Collisions are counted rather
/// than hidden: a label nobody can read is a fact about the picture.
function layoutLabelBoxes(placed, edges) {
  const boxes = [];
  for (const edge of edges) {
    const from = placed.get(edge.from), to = placed.get(edge.to);
    if (!from || !to) continue;
    const text = String(edge.label || '');
    const w = Math.max(text.length * LAYOUT_CHAR_W, 8);
    const h = 12;
    const mx = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
    const my = (from.y + from.h / 2 + to.y + to.h / 2) / 2 - 9;
    boxes.push({ edge: edge.id, kind: edge.kind, x: mx - w / 2, y: my - h / 2, w, h });
  }
  return boxes;
}

function layoutMetrics(placed, edges, nodes) {
  const chords = [];
  for (const edge of edges) {
    const from = placed.get(edge.from), to = placed.get(edge.to);
    if (!from || !to) continue;
    chords.push({
      edge: edge.id, from: edge.from, to: edge.to,
      x: from.x + from.w / 2, y: from.y + from.h / 2,
      x2: to.x + to.w / 2, y2: to.y + to.h / 2,
    });
  }
  const labelBoxes = layoutLabelBoxes(placed, edges);
  const collisions = [];
  for (let i = 0; i < labelBoxes.length; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      if (layoutBoxesOverlap(labelBoxes[i], labelBoxes[j])) {
        collisions.push({ a: labelBoxes[i].edge, b: labelBoxes[j].edge, kind: 'label_label' });
      }
    }
    for (const node of nodes) {
      if (layoutBoxesOverlap(labelBoxes[i], node)) {
        collisions.push({ a: labelBoxes[i].edge, b: node.id, kind: 'label_node' });
      }
    }
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    labelCollisions: collisions.length,
    collisions: collisions.slice(0, 12),
    crossings: layoutSegmentCrossings(chords),
    crossingBasis: 'straight_chord_between_ports',
    labelBasis: 'char_width_' + LAYOUT_CHAR_W,
  };
}

/// Assemble the finished picture from a model and a placement. Shared by both
/// entry points so the fallback and the engine cannot diverge in what they
/// report -- only in where the boxes ended up.
function layoutAssemble(model, placed, engine, engineError, started) {
  const ports = layoutPorts(placed, model.edges);
  const metrics = layoutMetrics(placed, model.edges, model.boxes);
  let width = 0, height = 0;
  for (const box of placed.values()) {
    width = Math.max(width, box.x + box.w);
    height = Math.max(height, box.y + box.h);
  }
  return {
    schema: ATLAS_LAYOUT_SCHEMA,
    engine,
    engineError,
    model,
    boxes: model.boxes.map((box) => ({ ...box, ...(placed.get(box.id) || {}) })),
    ports,
    edges: model.edges,
    bounds: { width: width + LAYOUT_PAD, height: height + LAYOUT_PAD },
    metrics: { ...metrics, layoutMs: Date.now() - started },
    folded: model.folded,
    omitted: model.omitted,
    budget: model.budget,
    duplicateBoxIds: model.duplicateBoxIds || [],
    // Which engine ran is part of the result, because a fallback picture and a
    // laid-out picture must not be indistinguishable to a reader.
    engineLabel: engine === 'elk_pinned' ? 'elkjs 0.12.0（本地钉版）' : '本地分层回退（布局引擎不可用）',
  };
}

/// The elkjs graph for a model. Pure, so what Atlas asks the engine for is
/// testable without running the engine.
function layoutElkGraph(model) {
  return {
    id: 'atlas-focus',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYOUT_GAP_X),
      'elk.spacing.nodeNode': String(LAYOUT_GAP_Y),
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: model.boxes.map((box) => ({
      id: box.id,
      width: LAYOUT_NODE_W,
      height: box.unresolved ? LAYOUT_UNRESOLVED_H : LAYOUT_NODE_H,
    })),
    edges: model.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
}

/// Read positions out of an elkjs result. Throws on a shape that is not a
/// layout, so a broken engine becomes a named refusal instead of a picture of
/// everything at the origin.
function layoutFromElkResult(result) {
  if (!result || !Array.isArray(result.children)) throw new Error('elk_returned_no_layout');
  const placed = new Map();
  let missing = 0;
  for (const child of result.children) {
    // A result without coordinates is a failed layout, not a layout at the
    // origin. Defaulting to 0 was the worst possible answer: every box stacked
    // at (0,0) is a picture that looks deliberate and says nothing. Measured
    // while evaluating the engine: the same graph through the same API returns
    // positions in one host and none in another, so this has to be a refusal.
    if (!Number.isFinite(child.x) || !Number.isFinite(child.y)) { missing += 1; continue; }
    placed.set(child.id, {
      x: child.x, y: child.y,
      w: Number.isFinite(child.width) ? child.width : LAYOUT_NODE_W,
      h: Number.isFinite(child.height) ? child.height : LAYOUT_NODE_H,
    });
  }
  if (missing) throw new Error(`elk_returned_no_coordinates:${missing}/${result.children.length}`);
  if (placed.size !== result.children.length) {
    throw new Error(`elk_returned_duplicate_box_ids:${result.children.length - placed.size}`);
  }
  return placed;
}

/// Synchronous planning, using an injected placement function. Tests use this
/// to exercise both engines without a promise; the fallback is used when no
/// placement is supplied.
function planFocusLayout(focus, nodes, options) {
  const started = Date.now();
  const opts = options || {};
  const model = buildFocusModel(focus, nodes, opts);
  if (typeof opts.place === 'function') {
    try {
      return layoutAssemble(model, opts.place(layoutElkGraph(model)), opts.engineName || 'injected', null, started);
    } catch (error) {
      return layoutAssemble(model, layoutFallback(model), 'fallback_local',
        String((error && error.message) || error), started);
    }
  }
  return layoutAssemble(model, layoutFallback(model), 'fallback_local', null, started);
}

/// Asynchronous planning with the pinned engine.
///
/// elkjs 0.12.0 exposes no synchronous API -- `layout()` returns a promise --
/// so the page has to await a layout, and an awaited layout can arrive after
/// the selection has moved on. That is the exact hazard the work order names
/// ("布局任务标记 generation，迟到结果不得覆盖新选区"), so this function takes a
/// `generation` and refuses to return a result whose generation is no longer
/// current. A discarded layout is reported as discarded, not silently dropped.
async function planFocusLayoutAsync(focus, nodes, options) {
  const started = Date.now();
  const opts = options || {};
  const model = buildFocusModel(focus, nodes, opts);
  const current = () => (typeof opts.generation === 'function' ? opts.generation() : null);
  const mine = current();
  const stale = () => mine !== null && current() !== mine;

  const elk = opts.elk;
  if (!elk || typeof elk.layout !== 'function') {
    return layoutAssemble(model, layoutFallback(model), 'fallback_local', 'elk_unavailable', started);
  }
  let result;
  try {
    result = await elk.layout(layoutElkGraph(model));
  } catch (error) {
    return layoutAssemble(model, layoutFallback(model), 'fallback_local',
      String((error && error.message) || error), started);
  }
  if (stale()) {
    return {
      schema: ATLAS_LAYOUT_SCHEMA,
      engine: 'discarded',
      engineLabel: '布局结果已过期（选区已改变），未采用',
      stale: true,
      generation: mine,
      model,
      boxes: [], ports: new Map(), edges: [],
      bounds: { width: 0, height: 0 },
      metrics: { nodes: 0, edges: 0, labelCollisions: 0, collisions: [], crossings: 0, layoutMs: Date.now() - started },
      folded: model.folded, omitted: model.omitted, budget: model.budget,
    };
  }
  let placed;
  try {
    placed = layoutFromElkResult(result);
  } catch (error) {
    return layoutAssemble(model, layoutFallback(model), 'fallback_local',
      String((error && error.message) || error), started);
  }
  return layoutAssemble(model, placed, 'elk_pinned', null, started);
}
