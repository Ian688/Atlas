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

function cityTopDirectory(path) {
  const text = String(path == null ? '' : path);
  const slash = text.indexOf('/');
  return slash === -1 ? '' : text.slice(0, slash);
}

function cityDistrictLabel(key) {
  return key === '' ? '项目根目录' : key;
}

function cityShortName(path) {
  const text = String(path == null ? '' : path);
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

/// Pure mapping from published nodes/edges to a drawable city. Deterministic:
/// the same facts always produce the same coordinates, so a picture can be
/// compared across runs and versions.
function buildCityLayout(nodes, edges, options) {
  const opts = options || {};
  const maxFiles = opts.maxFiles || CITY_MAX_FILES;
  const maxPipes = opts.maxPipes || CITY_MAX_PIPES;

  const files = (nodes || []).filter((n) => n.kind === 'file');
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

  const ordered = files.slice().sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const shownFiles = ordered.slice(0, Math.max(maxFiles, 0));

  const districtOrder = [];
  const districtFiles = new Map();
  for (const file of shownFiles) {
    const key = cityTopDirectory(file.path);
    if (!districtFiles.has(key)) { districtFiles.set(key, []); districtOrder.push(key); }
    districtFiles.get(key).push(file);
  }
  districtOrder.sort();

  // Shelf packing: each district is one rectangular plate, districts are laid
  // out left to right and wrapped, so no two plates can overlap.
  const footprints = districtOrder.map((key) => {
    const list = districtFiles.get(key);
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    const rows = Math.ceil(list.length / cols);
    return {
      key, list, cols, rows,
      w: cols * CITY_COLUMN_W + CITY_DISTRICT_PAD,
      d: rows * CITY_COLUMN_D + CITY_DISTRICT_PAD,
    };
  });
  const shelfWidth = footprints.length
    ? Math.max(...footprints.map((f) => f.w)) * Math.ceil(Math.sqrt(footprints.length))
    : 0;

  const districts = [];
  const columns = [];
  const columnByPath = new Map();
  let cursorX = 0, cursorZ = 0, rowDepth = 0;

  for (const fp of footprints) {
    if (cursorX > 0 && cursorX + fp.w > shelfWidth) {
      cursorZ += rowDepth + CITY_DISTRICT_GAP;
      cursorX = 0;
      rowDepth = 0;
    }
    const originX = cursorX, originZ = cursorZ;
    districts.push({
      name: fp.key,
      label: cityDistrictLabel(fp.key),
      x: originX + fp.w / 2,
      z: originZ + fp.d / 2,
      w: fp.w,
      d: fp.d,
      files: fp.list.length,
    });

    fp.list.forEach((file, index) => {
      const gx = index % fp.cols;
      const gz = Math.floor(index / fp.cols);
      const fns = functionsByPath.get(file.path) || [];
      // The engine's own count governs the height. Slab meshes only show what
      // this page actually loaded, and the gap between the two is reported
      // rather than smoothed over.
      const declared = Number.isFinite(file.function_count) ? file.function_count : fns.length;
      const visible = Math.min(fns.length, CITY_MAX_SLABS);
      columns.push({
        id: file.id,
        path: file.path,
        name: file.name || cityShortName(file.path),
        // Every captured entry becomes a file node, including ones the scan
        // deliberately ignored or could not read. Drawing those as ordinary
        // columns would claim they were analysed, so the disposition travels
        // with the column and the renderer gives them their own treatment.
        analyzed: file.disposition === 'captured',
        district: fp.key,
        x: originX + CITY_DISTRICT_PAD / 2 + CITY_COLUMN_W * (gx + 0.5),
        z: originZ + CITY_DISTRICT_PAD / 2 + CITY_COLUMN_D * (gz + 0.5),
        w: CITY_COLUMN_W * 0.62,
        d: CITY_COLUMN_D * 0.62,
        functionCount: Math.max(declared, 0),
        loadedSlabs: fns.length,
        visibleSlabs: visible,
        collapsedSlabs: Math.max(declared - visible, 0),
        slabsIncomplete: fns.length < declared,
        height: CITY_BASE_H + Math.max(declared, 1) * CITY_SLAB_H,
        slabs: fns.slice(0, visible).map((s) => ({ id: s.id, name: s.name, start: s.start, end: s.end })),
        unresolved: 0,
      });
      columnByPath.set(file.path, columns[columns.length - 1]);
    });

    cursorX += fp.w + CITY_DISTRICT_GAP;
    rowDepth = Math.max(rowDepth, fp.d);
  }

  // Calls are aggregated to file level: a pipe answers "these two files are
  // connected", and its label carries how many call sites say so.
  const pathOfOwner = new Map();
  for (const fn of functions) pathOfOwner.set(fn.id, fn.path);
  for (const file of files) pathOfOwner.set(file.id, file.path);

  const pairCount = new Map();
  let unresolvedCalls = 0;
  for (const call of calls) {
    const from = pathOfOwner.get(call.source);
    if (from === undefined) continue;
    if (!call.target) {
      unresolvedCalls++;
      const column = columnByPath.get(from);
      if (column) column.unresolved++;
      continue;
    }
    const to = pathOfOwner.get(call.target);
    if (to === undefined || to === from) continue;
    const key = from + '\u0000' + to;
    pairCount.set(key, (pairCount.get(key) || 0) + 1);
  }
  const allPipes = [...pairCount.entries()]
    .map(([key, count]) => {
      const split = key.split('\u0000');
      return { from: split[0], to: split[1], count };
    })
    .sort((a, b) => (b.count - a.count) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const pipes = allPipes.slice(0, Math.max(maxPipes, 0));

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

  const stats = {
    files: files.length,
    shownFiles: shownFiles.length,
    districts: districts.length,
    functions: functions.length,
    loadedSlabs: columns.reduce((n, c) => n + c.loadedSlabs, 0),
    drawnSlabs: columns.reduce((n, c) => n + c.visibleSlabs, 0),
    declaredFunctions: columns.reduce((n, c) => n + c.functionCount, 0),
    calls: calls.length,
    resolvedPairs: allPipes.length,
    shownPipes: pipes.length,
    unresolvedCalls,
    unanalyzedFiles: columns.filter((c) => !c.analyzed).length,
    truncated: {
      files: files.length > shownFiles.length,
      pipes: allPipes.length > pipes.length,
      slabs: columns.some((c) => c.collapsedSlabs > 0 || c.slabsIncomplete),
    },
  };

  return {
    districts,
    columns,
    pipes,
    stats,
    bounds: { minX, maxX, minZ, maxZ },
    radius: Math.max(maxX - minX, maxZ - minZ, 24) / 2,
  };
}

/// One line that states what the picture covers. A visual that cannot say how
/// much of the analysis it left out is not evidence, so this is always shown.
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
  const column = layout && layout.columns.find(entry => entry.path === node.path);
  if (!column) return { ok: false, code: 'entity_not_in_layout', path: node.path };
  return { ok: true, path: column.path, entity_id: node.id, name: node.name };
}

function citySelectionQuery(column) {
  if (!column) return null;
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
  unanalyzed: [0.80, 0.78, 0.74],
  stub: [0.80, 0.63, 0.33],
  pipe: [0.33, 0.66, 0.76, 0.42],
  pipeHot: [0.08, 0.53, 0.66, 0.95],
  selected: [0.05, 0.46, 0.58],
  wire: [0.48, 0.64, 0.74, 0.75],
  wireSelected: [0.05, 0.42, 0.54, 1],
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
    if (mode === 'file' || unanalyzed) {
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
        const bottom = CITY_BASE_H + column.visibleSlabs * CITY_SLAB_H;
        const height = column.collapsedSlabs * CITY_SLAB_H;
        list.push({
          offset: [column.x, bottom + height / 2, column.z],
          scale: [column.w * 0.86, height, column.d * 0.86],
          color: CITY_PALETTE.collapsed,
          glow: 0,
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
function cityWireInstances(layout, selectedPath) {
  const list = [];
  for (const column of layout.columns) {
    const selected = column.path === selectedPath;
    list.push({
      offset: [column.x, column.height / 2, column.z],
      scale: [column.w * 1.02, column.height, column.d * 1.02],
      color: selected ? CITY_PALETTE.wireSelected
        : (column.analyzed ? CITY_PALETTE.wire : CITY_PALETTE.plateWire),
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
    shape: 'box', mode: 'function', selected: null,
    analysisId: null, selection: null, pendingSelection: null,
    meshes: { solid: null, wire: null, grid: null, pipes: null },
    labels: [],
    dragging: null, moved: 0,
  };

  const labelHost = typeof document === 'undefined' ? null : document.getElementById('city-labels');

  function rebuildScene() {
    if (!state.layout) return;
    const columns = cityColumnInstances(state.layout, state.mode, state.selected);
    state.meshes.solid = citySolidMesh(gl, solidProgram, solidGeometry[state.shape], columns);
    state.meshes.wire = cityWireMesh(gl, wireProgram, wireGeometry[state.shape], cityWireInstances(state.layout, state.selected));
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
    if (note) note.textContent = `共享选区来自 2D：${target.name} · ${target.path}`;
    const column = state.layout.columns.find(entry => entry.path === target.path);
    await selectColumn(column);
    cityPublishSelection(target.entity_id);
  }

  async function selectColumn(column) {
    state.selected = column ? column.path : null;
    rebuildScene();
    const query = citySelectionQuery(column);
    if (!query) {
      cityText('city-selected', '未选中对象。点选一根柱体，查看它对应的文件。');
      cityText('city-source', '');
      return;
    }
    cityText('city-selected',
      `${column.name} · ${column.path} · 声明 ${column.functionCount} 函数 · 已展开 ${column.visibleSlabs} 层 · 未解析调用 ${column.unresolved}`);
    cityText('city-source', '读取固定快照…');
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
      state.layout = buildCityLayout(nodes.items, edges.items);
      state.camera = cityDefaultCamera(state.layout);
      state.mode = 'function';
      rebuildScene();
      cityText('city-analysis', `分析版本 ${String(report.id).slice(0, 12)} · 文件 ${report.file_count} · 函数 ${report.function_count} · 调用点 ${report.call_count}`);
      const bounded = nodes.complete && edges.complete ? '' : '（分页达到上限，视图基于已加载的部分事实）';
      cityText('city-coverage', cityCoverageLine(state.layout.stats) + bounded);
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
        const column = state.layout.columns.find(c => c.path === entityId || c.path === String(entityId).replace(/^file:/, ''));
        if (!column) return { ok: false, error: 'entity_not_in_layout' };
        await selectColumn(column);
        cityPublishSelection(entityId);
        return { ok: true, path: column.path };
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
