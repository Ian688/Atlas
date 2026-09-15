/* Atlas 探索页：项目地图与多展示区。
 *
 * 这一页是产品实现，不是原型：所有节点来自 /api/tree 的真实包含结构，
 * 所有简介来自 /api/knowledge 的已发布事实与捕获字节，所有解析记录、批注
 * 与交接都写进服务端（按项目隔离），刷新与重启后能读回。
 *
 * 三条贯穿全文件的规则：
 *  1. 每个展示区有自己的标签、选区、展开、滚动与缩放，区域之间不共享一个
 *     全局 selected。
 *  2. 每次异步请求记下发起时的区域代次；切标签/关区域之后到达的迟到响应
 *     直接丢弃，不写进当前对象。
 *  3. 没有能力的事情如实说：未配置模型就说未配置，没有语义分析就说明没有
 *     语义分析，不会用固定文本冒充生成结果。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'atlas.session.v1';
  var UI_STATE_NAME = 'explore-map';
  var ROOT_ID = 'dir:';
  var PAGE_SIZE = 40;
  var NODE_W = 178, NODE_H = 52, VGAP = 12, LEVEL_W = 220, PAD = 32;
  var MAX_CARDS = 320;
  var KIND_LABEL = { project: '项目', directory: '目录', file: '文件', function: '函数', section: '文档章节' };
  var FILE_LABEL = { code: '代码文件', markdown: '文档', config: '配置', text: '文本', binary: '二进制' };
  var SOURCE_EXTS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];
  var BINARY_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tar', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'wasm', 'so', 'dylib', 'dll', 'exe', 'class', 'jar', 'pyc'];
  var CONFIG_EXTS = ['json', 'jsonc', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'env'];

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined && txt !== null) e.textContent = String(txt);
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function lower(path) { var i = String(path || '').lastIndexOf('.'); return i < 0 ? '' : String(path).slice(i + 1).toLowerCase(); }
  function fileKindOf(path) {
    if (SOURCE_EXTS.indexOf(lower(path)) >= 0) return 'code';
    var ext = lower(path);
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
    if (CONFIG_EXTS.indexOf(ext) >= 0) return 'config';
    if (BINARY_EXTS.indexOf(ext) >= 0) return 'binary';
    return 'text';
  }
  function bytesText(n) {
    if (n === null || n === undefined) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function short(id, n) { return id ? String(id).slice(0, n || 8) : ''; }
  function timeText(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var p = function (v) { return v < 10 ? '0' + v : String(v); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function errorText(status, body) {
    var detail = body && typeof body === 'object' ? (body.detail || body.error || '') : null;
    if (detail) return detail + ' (' + status + ')';
    if (status === 401) return '会话已失效或令牌不正确 (401)';
    return '查询未完成 (' + status + ')';
  }

  // --- 会话 ---------------------------------------------------------------
  var session = { token: '', analysis: '', projectKey: '', projectName: '', contract: null, connected: false, error: null, loading: false };

  function readToken() {
    var token = '';
    try {
      var f = new URLSearchParams(String(location.hash || '').slice(1));
      token = f.get('token') || '';
    } catch (e) { token = ''; }
    if (!token) { try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; } }
    return token;
  }
  async function api(name, params) {
    var query = new URLSearchParams();
    if (params) for (var key in params) if (params[key] !== undefined && params[key] !== null) query.set(key, String(params[key]));
    var r = await fetch('/api/' + name + '?' + query.toString(), { headers: { Authorization: 'Bearer ' + session.token } });
    var body = await r.json().catch(function () { return null; });
    if (!r.ok) { var e = new Error(errorText(r.status, body)); e.status = r.status; e.body = body; throw e; }
    return body;
  }
  async function apiJson(name, payload, method) {
    var r = await fetch('/api/' + name, {
      method: method || 'POST',
      headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    var body = await r.json().catch(function () { return null; });
    if (!r.ok) { var e = new Error(errorText(r.status, body)); e.status = r.status; e.body = body; throw e; }
    return body;
  }

  // --- 工作区模型 ---------------------------------------------------------
  var ws = { areas: [], active: 0, layout: 'columns', outline: false, inspectorOpen: true, seq: 1, favorites: [], maximized: null, closedAreas: [], sizes: [], dirty: false };
  var ui = {
    tab: 'summary', source: 'facts', draft: '', refs: ['atlas-summary'],
    knowledge: null, knowledgeError: null,
    annotations: [], annotationsError: null,
    interpretations: [], interpretationsError: null,
    handoffs: [], handoffsError: null, handoffGoal: '', handoffBusy: null,
    // 按需 LLM：连接状态、配置表单、配置提示与当前作业都按项目与节点保存。
    llmState: null, llmConfigError: null, llmForm: null, llmConfigNote: null, llmConfigOpen: false, llmJob: null,
    busy: false, note: null
  };

  function activeArea() { return ws.areas[ws.active] || null; }
  function activeTab() { var a = activeArea(); return a ? a.tabs[a.activeTab] || null : null; }
  function activeSelection() { var t = activeTab(); return t && t.selection ? t.selection : null; }
  function nextId(prefix) { ws.seq += 1; return prefix + ws.seq + '-' + Math.random().toString(36).slice(2, 6); }

  function newTab(spec) {
    return {
      id: nextId('t'),
      analysis: spec.analysis || session.analysis,
      entityId: spec.entityId || ROOT_ID,
      root: spec.root || null,
      name: spec.name || '',
      path: spec.path || '',
      kind: spec.kind || 'project',
      view: spec.view || 'map',
      expanded: spec.expanded || {},
      children: {},
      selection: spec.selection || null,
      scroll: spec.scroll || { x: 0, y: 0 },
      zoom: spec.zoom || 1,
      gen: 1,
      closedTabs: [],
      content: { status: 'idle', data: null, error: null },
      relations: { status: 'idle', out: null, in: null, error: null },
      stale: false,
      staleNote: null
    };
  }
  function newArea(spec) {
    var area = {
      id: nextId('a'),
      title: spec && spec.title ? spec.title : '项目地图',
      tabs: [],
      activeTab: 0,
      gen: 1,
      closedTabs: []
    };
    var tab = newTab(spec || {});
    area.tabs.push(tab);
    return area;
  }
  function toTreeNode(node) {
    if (!node) return null;
    var fk = node.kind === 'file' ? fileKindOf(node.path) : null;
    var merged = node;
    merged.file_kind = node.file_kind || fk;
    if (merged.child_count === undefined) merged.child_count = node.function_count || 0;
    if (merged.has_children === undefined) {
      merged.has_children = node.kind === 'directory'
        ? true
        : node.kind === 'file' ? (node.function_count > 0 || merged.file_kind === 'markdown') : node.kind === 'function';
    }
    if (merged.unsupported_semantics === undefined) {
      merged.unsupported_semantics = node.kind === 'directory' ? true : node.kind === 'file' ? merged.file_kind !== 'code' : node.kind !== 'function';
    }
    return merged;
  }
  function nodeLabel(node) {
    if (!node) return '?';
    if (node.kind === 'project') return node.name || '项目';
    if (node.kind === 'directory') return (node.name || node.path || '/') + '/';
    if (node.kind === 'function') return (node.name || '?') + '()';
    return node.name || node.path || node.id;
  }
  function kindLabel(node) {
    if (!node) return '';
    if (node.kind === 'file') return FILE_LABEL[node.file_kind || fileKindOf(node.path)] || '文件';
    if (node.kind === 'project') return '项目';
    return KIND_LABEL[node.kind] || node.kind;
  }
  function nodeNote(node) {
    if (!node) return '';
    if (node.kind === 'project') return '直属成员 ' + (node.child_count || 0);
    if (node.kind === 'directory') return '直属成员 ' + (node.child_count || 0);
    if (node.kind === 'file') {
      var parts = [];
      parts.push(kindLabel(node));
      if (node.bytes) parts.push(bytesText(node.bytes));
      if (node.function_count > 0) parts.push(node.function_count + ' 个声明');
      else if (node.file_kind === 'code') parts.push('没有可定位的声明');
      else parts.push('没有函数级分析');
      return parts.join(' · ');
    }
    if (node.kind === 'function') return '函数 · 字节 ' + node.start + '–' + node.end;
    if (node.kind === 'section') return (node.note || '章节') + ' · ' + bytesText(node.bytes);
    return node.disposition || '';
  }

  // --- 数据加载 -----------------------------------------------------------
  async function loadMembers(tab, nodeId, opts) {
    var options = opts || {};
    var cache = tab.children[nodeId];
    if (!cache) { cache = tab.children[nodeId] = { items: [], total: 0, next: null, notes: [], status: 'idle', error: null }; }
    if (options.more && !cache.next) return;
    if (cache.status === 'loading') return;
    var gen = tab.gen;
    cache.status = 'loading'; cache.error = null;
    paintAreas();
    try {
      var params = { limit: PAGE_SIZE };
      if (nodeId !== ROOT_ID) params.parent = nodeId;
      if (options.more) params.cursor = cache.next;
      var res = await api('tree', params);
      if (gen !== tab.gen) return;
      if (res.root) { tab.root = toTreeNode(res.root); tab.root.kind = 'project'; if (!tab.name) tab.name = tab.root.name; }
      cache.items = options.more ? cache.items.concat(res.items || []) : (res.items || []);
      cache.total = res.total || cache.items.length;
      cache.next = res.next_cursor || null;
      cache.notes = res.notes || [];
      cache.status = 'ready';
    } catch (e) {
      if (gen !== tab.gen) return;
      cache.status = 'error';
      cache.error = String((e && e.message) || e);
    }
    paintAreas();
    scheduleSave();
  }
  async function ensureRoot(tab) {
    if (tab.root) return tab.root;
    if (tab.stale) return null;
    try {
      if (tab.entityId === ROOT_ID) {
        var res = await api('tree', { limit: PAGE_SIZE });
        if (res.root) { tab.root = toTreeNode(res.root); tab.root.kind = 'project'; }
        tab.children[ROOT_ID] = { items: res.items || [], total: res.total || 0, next: res.next_cursor || null, notes: res.notes || [], status: 'ready', error: null };
      } else {
        var node = await api('node', { entity: tab.entityId });
        tab.root = toTreeNode(node && node.node);
      }
    } catch (e) {
      tab.rootError = String((e && e.message) || e);
    }
    return tab.root;
  }
  async function ensureTabReady(tab) {
    if (tab.stale) return;
    if (!tab.root) await ensureRoot(tab);
    if (!tab.root) return;
    // 根节点默认展开：用户先看到首层成员，再决定往哪一层走。折叠过就保持折叠。
    if (tab.expanded[tab.root.id] === undefined) tab.expanded[tab.root.id] = true;
    var shouldLoad = [];
    if (tab.children[tab.root.id] === undefined) shouldLoad.push(tab.root.id);
    for (var key in tab.expanded) {
      if (!tab.expanded[key]) continue;
      if (tab.children[key] === undefined) shouldLoad.push(key);
    }
    for (var i = 0; i < shouldLoad.length; i++) await loadMembers(tab, shouldLoad[i]);
  }
  function expand(tab, nodeId, on) {
    if (on) {
      tab.expanded[nodeId] = true;
      if (!tab.children[nodeId] || (tab.children[nodeId].status === 'error')) loadMembers(tab, nodeId);
      else if (tab.children[nodeId].status === 'idle') loadMembers(tab, nodeId);
    } else {
      delete tab.expanded[nodeId];
    }
    paintAreas();
    scheduleSave();
  }
  // 把祖先链逐层加载并展开，让一个搜索命中的节点在地图上可见。
  async function revealNode(tab, node) {
    if (!node) return;
    var chain = [];
    var cursor = node;
    var guard = 0;
    while (cursor && guard < 64) {
      guard += 1;
      chain.unshift(cursor);
      var parentId = cursor.parent;
      if (!parentId || parentId === ROOT_ID || parentId === 'dir:') break;
      var parent = null;
      try { var res = await api('node', { entity: parentId }); parent = res && res.node; } catch (e) { parent = null; }
      if (!parent) break;
      cursor = parent;
    }
    for (var i = 0; i < chain.length; i++) {
      var entry = chain[i];
      tab.expanded[entry.id] = true;
      var cache = tab.children[entry.id];
      if (!cache || (cache.items.length === 0 && cache.status !== 'loading')) {
        await loadMembers(tab, entry.id);
      }
    }
    selectNode(tab, node);
  }

  // --- 整齐树布局 ---------------------------------------------------------
  function buildEntries(tab) {
    var used = 0;
    function build(node, depth) {
      used += 1;
      var entry = { node: node, depth: depth, kids: [], expanded: Boolean(tab.expanded[node.id]), cache: tab.children[node.id], more: false };
      if (used >= MAX_CARDS) return entry;
      if (entry.expanded && entry.cache && entry.cache.items) {
        for (var i = 0; i < entry.cache.items.length; i++) {
          entry.kids.push(build(entry.cache.items[i], depth + 1));
        }
      }
      if (entry.expanded && entry.cache && entry.cache.next) entry.more = true;
      return entry;
    }
    if (!tab.root) return null;
    return build(tab.root, 0);
  }
  function measure(entry) {
    if (!entry.kids.length && !entry.more) { entry.h = NODE_H; return NODE_H; }
    var total = 0;
    for (var i = 0; i < entry.kids.length; i++) total += measure(entry.kids[i]) + VGAP;
    if (entry.more) total += NODE_H + VGAP;
    entry.h = Math.max(NODE_H, total - VGAP);
    return entry.h;
  }
  function place(entry, x, yTop, out, edges) {
    entry.x = x;
    entry.y = yTop + (entry.h - NODE_H) / 2;
    out.push(entry);
    var cy = yTop;
    var cx = x + LEVEL_W;
    for (var i = 0; i < entry.kids.length; i++) {
      var kid = entry.kids[i];
      place(kid, cx, cy, out, edges);
      edges.push({ from: entry, to: kid });
      cy += kid.h + VGAP;
    }
    if (entry.more) {
      out.push({ more: true, parentId: entry.node.id, x: cx, y: cy + 0, depth: entry.depth + 1, kids: [], h: NODE_H });
      edges.push({ from: entry, to: out[out.length - 1] });
    }
  }
  function layout(tab) {
    var root = buildEntries(tab);
    if (!root) return { entries: [], edges: [], width: 0, height: 0 };
    measure(root);
    var out = [], edges = [];
    place(root, PAD, PAD, out, edges);
    var width = 0, height = 0;
    for (var i = 0; i < out.length; i++) {
      width = Math.max(width, out[i].x + NODE_W + PAD);
      height = Math.max(height, out[i].y + NODE_H + PAD);
    }
    return { entries: out, edges: edges, width: width, height: height };
  }

  // --- 选区 ---------------------------------------------------------------
  function selectNode(tab, node) {
    if (!node) return;
    tab.selection = { analysis: tab.analysis, entityId: node.id, node: node };
    ui.knowledge = null; ui.knowledgeError = null;
    ui.annotations = []; ui.annotationsError = null;
    ui.interpretations = []; ui.interpretationsError = null;
    ui.handoffs = []; ui.handoffsError = null;
    ui.draft = ''; ui.refs = ['atlas-summary'];
    tab.content = { status: 'idle', data: null, error: null };
    tab.relations = { status: 'idle', out: null, in: null, error: null };
    paintAreas();
    paintInspector();
    loadInspectorData(node);
    if (tab.view === 'content') loadContent(tab, node.id);
    if (tab.view === 'relations') loadRelations(tab, node.id);
    scheduleSave();
  }

  // --- 内容视图 -----------------------------------------------------------
  async function loadContent(tab, entityId) {
    var gen = tab.gen;
    tab.content = { status: 'loading', data: null, error: null };
    paintAreas();
    try {
      var data;
      if (String(entityId).indexOf('section:') === 0) {
        // 文档章节不是存储里的节点：正文由 knowledge 从捕获字节给出。
        var know = await api('knowledge', { entity: entityId });
        if (gen !== tab.gen) return;
        data = { path: (know.node && know.node.path) || '', content: (know.comments && know.comments[0] && know.comments[0].text) || '', start_line: 1, truncated: false, section: true };
      } else {
        data = await api('source', { entity: entityId });
        if (gen !== tab.gen) return;
      }
      tab.content = { status: 'ready', data: data, error: null };
    } catch (e) {
      if (gen !== tab.gen) return;
      tab.content = { status: 'error', data: null, error: String((e && e.message) || e) };
    }
    paintAreas();
  }
  async function loadRelations(tab, entityId) {
    var gen = tab.gen;
    tab.relations = { status: 'loading', out: null, in: null, error: null };
    paintAreas();
    try {
      var out = await api('reach', { entity: entityId, direction: 'out' });
      if (gen !== tab.gen) return;
      var inbound = await api('reach', { entity: entityId, direction: 'in' });
      if (gen !== tab.gen) return;
      tab.relations = { status: 'ready', out: out, in: inbound, error: null };
    } catch (e) {
      if (gen !== tab.gen) return;
      tab.relations = { status: 'error', out: null, in: null, error: String((e && e.message) || e) };
    }
    paintAreas();
  }

  // --- 渲染：左栏 ---------------------------------------------------------
  function paintRail() {
    var group = $('rail-areas-group');
    var favGroup = $('rail-favorites-group');
    if (group) group.hidden = !session.connected;
    if (favGroup) favGroup.hidden = !session.connected;
    var list = $('rail-areas');
    if (list) {
      clear(list);
      for (var i = 0; i < ws.areas.length; i++) {
        (function (index) {
          var area = ws.areas[index];
          var tab = area.tabs[area.activeTab];
          var b = el('button', 'rail-item' + (index === ws.active ? ' active' : ''));
          b.appendChild(el('span', 'rail-item-name', area.title));
          b.appendChild(el('span', 'rail-item-sub', tab ? (tab.selection ? nodeLabel(tab.selection.node) : nodeLabel(tab.root)) : '空'));
          b.addEventListener('click', function () { ws.active = index; paint(); });
          list.appendChild(b);
        })(i);
      }
      var count = $('rail-area-count');
      if (count) count.textContent = String(ws.areas.length);
      if (ws.closedAreas.length) {
        var restore = el('button', 'rail-item rail-restore', '恢复刚关闭的展示区（' + ws.closedAreas.length + '）');
        restore.addEventListener('click', function () { restoreArea(); });
        list.appendChild(restore);
      }
    }
    var favs = $('rail-favorites');
    if (favs) {
      clear(favs);
      if (!ws.favorites.length) favs.appendChild(el('div', 'rail-empty', '还没有关注节点'));
      for (var f = 0; f < ws.favorites.length; f++) {
        (function (item) {
          var row = el('div', 'rail-fav');
          var b = el('button', 'rail-item');
          b.appendChild(el('span', 'rail-item-name', item.name));
          b.appendChild(el('span', 'rail-item-sub', item.path || ''));
          b.addEventListener('click', function () { openFavorite(item); });
          var x = el('button', 'rail-x', '×');
          x.title = '取消关注';
          x.addEventListener('click', function (e) {
            e.stopPropagation();
            ws.favorites = ws.favorites.filter(function (v) { return v.entityId !== item.entityId; });
            paint(); scheduleSave();
          });
          row.appendChild(b); row.appendChild(x);
          favs.appendChild(row);
        })(ws.favorites[f]);
      }
    }
  }
  function openFavorite(item) {
    var target = item.analysis === session.analysis ? item.entityId : null;
    var node = { id: item.entityId, name: item.name, path: item.path, kind: item.kind };
    if (item.analysis !== session.analysis) {
      setStatus('这条关注固定在另一个代码版本上（' + short(item.analysis) + '），当前版本已切换；请重新定位或重新关注。');
      return;
    }
    var area = activeArea();
    if (!area) { ws.areas.push(newArea({ entityId: item.entityId, name: item.name, kind: item.kind })); ws.active = ws.areas.length - 1; }
    else openInArea(ws.active, node);
    ensureTabReady(activeTab());
    paint();
  }

  // --- 渲染：展示区 -------------------------------------------------------
  function paintAreas() {
    var host = $('map-groups');
    if (!host) return;
    clear(host);
    host.className = 'map-groups is-' + ws.layout + (ws.maximized ? ' is-maximized' : '');
    if (!session.connected) {
      var empty = el('div', 'map-empty');
      empty.appendChild(el('h2', null, session.loading ? '正在读取本地分析…' : '还没有连接本机服务'));
      empty.appendChild(el('p', 'subtle', session.error ? session.error : '在右上角「连接会话」粘贴启动命令输出的令牌，打开后这里是以当前项目为根的项目地图。'));
      var retry = el('button', 'wb-primary', '重试连接');
      retry.addEventListener('click', function () { connect(true); });
      empty.appendChild(retry);
      host.appendChild(empty);
      return;
    }
    for (var i = 0; i < ws.areas.length; i++) {
      if (ws.maximized && ws.areas[i].id !== ws.maximized) continue;
      host.appendChild(renderArea(ws.areas[i], i));
      if (i < ws.areas.length - 1 && !ws.maximized) host.appendChild(renderDivider(i));
    }
    if (!ws.areas.length) {
      var hint = el('div', 'map-empty');
      hint.appendChild(el('h2', null, '没有打开的展示区'));
      hint.appendChild(el('p', 'subtle', '点右上角「＋ 新建展示区」打开一个项目地图；也可以从节点菜单里「在新展示区域打开」。'));
      var b = el('button', 'wb-primary', '＋ 新建展示区');
      b.addEventListener('click', function () { createArea(); });
      hint.appendChild(b);
      host.appendChild(hint);
    }
    paintOutline();
  }
  function renderDivider(index) {
    var d = el('div', 'map-divider');
    d.setAttribute('role', 'separator');
    d.setAttribute('aria-orientation', ws.layout === 'columns' ? 'vertical' : 'horizontal');
    d.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var host = $('map-groups');
      var rect = host.getBoundingClientRect();
      var move = function (ev) {
        var pct = ws.layout === 'columns' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        pct = Math.max(0.15, Math.min(0.85, pct));
        var sizes = ws.sizes.length === ws.areas.length ? ws.sizes.slice() : ws.areas.map(function () { return 1 / ws.areas.length; });
        var before = index, after = ws.areas.length - index - 1;
        var sum = 0;
        for (var k = 0; k < sizes.length; k++) if (k !== index && k !== index + 1) sum += sizes[k];
        var rest = 1 - sum;
        sizes[index] = rest * pct;
        sizes[index + 1] = rest * (1 - pct);
        ws.sizes = sizes;
        applySizes();
      };
      var up = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        scheduleSave();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return d;
  }
  function applySizes() {
    var host = $('map-groups');
    if (!host) return;
    var areas = host.querySelectorAll('.map-area');
    for (var i = 0; i < areas.length; i++) {
      var pct = ws.sizes[i] || (1 / Math.max(1, ws.areas.length));
      areas[i].style.flex = '1 1 ' + (pct * 100).toFixed(2) + '%';
    }
  }
  function renderArea(area, index) {
    var section = el('section', 'map-area' + (index === ws.active ? ' is-active' : ''));
    section.dataset.area = String(index);
    // 激活另一个区域时只改高亮与详情归属，不重建展示区 DOM：整块重建会把用户
    // 正在按的那个按钮换掉，于是这一次点击（菜单、展开）在 mouseup 之前就丢了。
    section.addEventListener('pointerdown', function () {
      if (ws.active === index) return;
      ws.active = index;
      var host = $('map-groups');
      var sections = host ? host.querySelectorAll('.map-area') : [];
      for (var k = 0; k < sections.length; k++) {
        if (k === index) sections[k].classList.add('is-active');
        else sections[k].classList.remove('is-active');
      }
      paintRail();
      paintInspector();
      scheduleSave();
    });

    var tabs = el('div', 'area-tabs');
    tabs.setAttribute('role', 'tablist');
    for (var t = 0; t < area.tabs.length; t++) {
      (function (ti) {
        var tab = area.tabs[ti];
        var wrap = el('div', 'area-tab' + (ti === area.activeTab ? ' is-active' : ''));
        var label = el('button', 'area-tab-main');
        label.appendChild(el('span', 'area-tab-name', tab.selection ? nodeLabel(tab.selection.node) : nodeLabel(tab.root)));
        if (tab.stale) label.appendChild(el('span', 'area-tab-flag', '旧版本'));
        label.title = (tab.path || tab.name || '') + ' · 版本 ' + short(tab.analysis);
        label.addEventListener('click', function () { switchTab(index, ti); });
        label.addEventListener('dblclick', function () { });
        var menuBtn = el('button', 'area-tab-menu', '⋯');
        menuBtn.title = '标签操作';
        menuBtn.addEventListener('click', function (e) { e.stopPropagation(); openTabMenu(menuBtn, area, ti); });
        var closeBtn = el('button', 'area-tab-close', '×');
        closeBtn.title = '关闭标签';
        closeBtn.addEventListener('click', function (e) { e.stopPropagation(); closeTab(index, ti); });
        wrap.appendChild(label); wrap.appendChild(menuBtn); wrap.appendChild(closeBtn);
        tabs.appendChild(wrap);
      })(t);
    }
    var addTab = el('button', 'area-tab-add', '＋');
    addTab.title = '新建标签（以当前选中的节点为根）';
    addTab.addEventListener('click', function () { openTabFromSelection(index); });
    tabs.appendChild(addTab);
    var spacer = el('div', 'area-tabs-fill');
    tabs.appendChild(spacer);
    if (area.closedTabs && area.closedTabs.length) {
      var restore = el('button', 'area-btn', '恢复刚关闭');
      restore.addEventListener('click', function () { restoreTab(index); });
      tabs.appendChild(restore);
    }
    var maxBtn = el('button', 'area-btn', ws.maximized === area.id ? '⤡' : '⤢');
    maxBtn.title = ws.maximized === area.id ? '还原所有展示区' : '只看这一个展示区';
    maxBtn.addEventListener('click', function () { ws.maximized = ws.maximized === area.id ? null : area.id; paint(); });
    tabs.appendChild(maxBtn);
    var closeArea = el('button', 'area-btn', '×');
    closeArea.title = '关闭这个展示区';
    closeArea.addEventListener('click', function () { closeAreaByIndex(index); });
    tabs.appendChild(closeArea);
    section.appendChild(tabs);

    var tab = area.tabs[area.activeTab];
    var bar = el('div', 'area-bar');
    bar.appendChild(el('span', 'area-path', tab ? (tab.path || nodeLabel(tab.root) || '项目') : ''));
    var views = el('div', 'area-views');
    views.setAttribute('role', 'group');
    ['map', 'content', 'relations'].forEach(function (v) {
      var b = el('button', 'view-btn', v === 'map' ? '地图' : v === 'content' ? '内容' : '关系');
      b.setAttribute('aria-pressed', String(tab && tab.view === v));
      b.addEventListener('click', function () { setView(index, v); });
      views.appendChild(b);
    });
    bar.appendChild(views);
    var locate = el('button', 'area-btn', '在项目中定位');
    locate.addEventListener('click', function () { locateInProject(index); });
    bar.appendChild(locate);
    var minus = el('button', 'area-btn', '－');
    minus.addEventListener('click', function () { zoomBy(index, -0.1); });
    bar.appendChild(minus);
    var zoomLabel = el('span', 'area-zoom', Math.round((tab ? tab.zoom : 1) * 100) + '%');
    bar.appendChild(zoomLabel);
    var plus = el('button', 'area-btn', '＋');
    plus.addEventListener('click', function () { zoomBy(index, 0.1); });
    bar.appendChild(plus);
    var fit = el('button', 'area-btn', '适应画布');
    fit.addEventListener('click', function () { fitToView(index); });
    bar.appendChild(fit);
    section.appendChild(bar);

    if (tab && tab.stale) {
      var warn = el('div', 'area-warn');
      warn.appendChild(el('span', null, '这个标签固定在代码版本 ' + short(tab.analysis) + ' 上，当前服务提供的是 ' + short(session.analysis) + '。' + (tab.staleNote ? ' ' + tab.staleNote : '')));
      var reloc = el('button', 'wb-retry', '重定位到当前版本');
      reloc.addEventListener('click', function () { relocateTab(index); });
      warn.appendChild(reloc);
      section.appendChild(warn);
    }

    var body = el('div', 'area-body');
    if (!tab) {
      body.appendChild(el('div', 'map-empty', '这个展示区没有标签'));
    } else if (tab.view === 'content') {
      body.appendChild(renderContent(area, tab));
    } else if (tab.view === 'relations') {
      body.appendChild(renderRelations(area, tab));
    } else {
      body.appendChild(renderMap(area, tab));
    }
    section.appendChild(body);
    return section;
  }
  function renderMap(area, tab) {
    var index = ws.areas.indexOf(area);
    var canvas = el('div', 'map-canvas');
    if (!tab.root) {
      var box = el('div', 'map-empty');
      box.appendChild(el('p', 'subtle', tab.rootError ? ('根节点加载失败：' + tab.rootError) : '正在加载这个展示区的根节点…'));
      canvas.appendChild(box);
      return canvas;
    }
    var model = layout(tab);
    var stage = el('div', 'map-stage');
    stage.style.transform = 'translate(' + tab.scroll.x + 'px,' + tab.scroll.y + 'px) scale(' + tab.zoom + ')';
    stage.style.width = model.width + 'px';
    stage.style.height = model.height + 'px';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'map-edges');
    svg.setAttribute('width', model.width);
    svg.setAttribute('height', model.height);
    for (var i = 0; i < model.edges.length; i++) {
      var e = model.edges[i];
      var x1 = e.from.x + NODE_W, y1 = e.from.y + NODE_H / 2;
      var x2 = e.to.x, y2 = e.to.y + NODE_H / 2;
      var mx = (x1 + x2) / 2;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
      path.setAttribute('class', 'map-edge');
      svg.appendChild(path);
    }
    stage.appendChild(svg);

    var selectedId = tab.selection ? tab.selection.entityId : null;
    for (var n = 0; n < model.entries.length; n++) {
      (function (entry) {
        if (entry.more) {
          var more = el('button', 'map-more');
          more.style.left = entry.x + 'px'; more.style.top = entry.y + 'px';
          more.textContent = '继续加载更多成员';
          more.addEventListener('click', function () { loadMembers(tab, entry.parentId, { more: true }); });
          stage.appendChild(more);
          return;
        }
        var node = entry.node;
        var card = el('div', 'mnode' + (selectedId === node.id ? ' is-selected' : '') + (node.unsupported_semantics ? ' is-plain' : ''));
        card.style.left = entry.x + 'px';
        card.style.top = entry.y + 'px';
        card.dataset.id = node.id;
        var canExpand = node.has_children || node.child_count > 0 || node.kind === 'directory' || node.kind === 'project';
        var toggle = el('button', 'mnode-toggle', '');
        toggle.title = entry.expanded ? '折叠' : '展开';
        toggle.textContent = entry.expanded ? '▾' : (canExpand ? '▸' : '·');
        if (!canExpand) toggle.classList.add('is-leaf');
        toggle.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!canExpand) return;
          expand(tab, node.id, !entry.expanded);
        });
        card.appendChild(toggle);
        var main = el('button', 'mnode-main');
        main.appendChild(el('span', 'mnode-name', nodeLabel(node)));
        var note = nodeNote(node);
        if (entry.expanded && entry.cache && entry.cache.status === 'loading') note = '正在加载成员…';
        if (entry.expanded && entry.cache && entry.cache.status === 'error') note = '成员加载失败：' + entry.cache.error;
        main.appendChild(el('span', 'mnode-note', note));
        main.title = (node.path || '') + (node.kind === 'function' ? ' · 字节 ' + node.start + '–' + node.end : '');
        main.addEventListener('click', function () { selectNode(tab, node); });
        main.addEventListener('dblclick', function () { openTabInArea(index, node); });
        main.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); openTabInArea(index, node); }
          else if (ev.key === 'ArrowRight' && canExpand) { ev.preventDefault(); expand(tab, node.id, true); }
          else if (ev.key === 'ArrowLeft') { ev.preventDefault(); expand(tab, node.id, false); }
        });
        card.appendChild(main);
        var acts = el('div', 'mnode-acts');
        var info = el('button', 'mnode-i', 'i');
        info.title = '简介（算法摘要 / 源码注释 / LLM 解释）';
        info.addEventListener('click', function (ev) { ev.stopPropagation(); selectNode(tab, node); ui.tab = 'summary'; ui.source = 'facts'; paintInspector(); });
        var menu = el('button', 'mnode-menu', '…');
        menu.title = '这个节点可以做的事';
        menu.addEventListener('click', function (ev) { ev.stopPropagation(); openNodeMenu(menu, node, tab, index); });
        acts.appendChild(info); acts.appendChild(menu);
        card.appendChild(acts);
        stage.appendChild(card);
      })(model.entries[n]);
    }
    // 平移与缩放：滚轮平移，Ctrl/⌘+滚轮缩放。
    canvas.addEventListener('wheel', function (ev) {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        zoomBy(index, ev.deltaY < 0 ? 0.08 : -0.08);
      } else {
        ev.preventDefault();
        tab.scroll.x -= ev.deltaX;
        tab.scroll.y -= ev.deltaY;
        applyTransform(index);
      }
    }, { passive: false });
    canvas.addEventListener('pointerdown', function (ev) {
      if (ev.target !== canvas && ev.target !== stage && ev.target !== svg) return;
      var startX = ev.clientX, startY = ev.clientY, ox = tab.scroll.x, oy = tab.scroll.y;
      canvas.setPointerCapture(ev.pointerId);
      var move = function (e2) { tab.scroll.x = ox + (e2.clientX - startX); tab.scroll.y = oy + (e2.clientY - startY); applyTransform(index); };
      var up = function () {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        scheduleSave();
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
    canvas.appendChild(stage);
    var status = el('div', 'map-canvas-status');
    var cache = tab.children[tab.root.id];
    var loaded = 0;
    for (var k in tab.children) loaded += (tab.children[k].items || []).length;
    status.textContent = '已加载 ' + model.entries.length + ' 个节点 · 包含关系 · 版本 ' + short(tab.analysis) + (cache && cache.total ? ' · 首层共 ' + cache.total + ' 个' : '');
    canvas.appendChild(status);
    return canvas;
  }
  function applyTransform(index) {
    var area = ws.areas[index];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    var host = $('map-groups');
    if (!host || !tab) return;
    var stage = host.querySelectorAll('.map-area')[index];
    if (!stage) return;
    var s = stage.querySelector('.map-stage');
    if (s) s.style.transform = 'translate(' + tab.scroll.x + 'px,' + tab.scroll.y + 'px) scale(' + tab.zoom + ')';
    var z = stage.querySelector('.area-zoom');
    if (z) z.textContent = Math.round(tab.zoom * 100) + '%';
  }
  function zoomBy(index, delta) {
    var area = ws.areas[index];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    if (!tab) return;
    tab.zoom = Math.max(0.3, Math.min(1.8, Math.round((tab.zoom + delta) * 100) / 100));
    paintAreas();
    scheduleSave();
  }
  function fitToView(index) {
    var area = ws.areas[index];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    if (!tab) return;
    var host = $('map-groups');
    var model = layout(tab);
    if (!model.width) return;
    var section = host ? host.querySelectorAll('.map-area')[index] : null;
    var canvas = section ? section.querySelector('.map-canvas') : null;
    var w = canvas ? canvas.clientWidth : 600;
    var h = canvas ? canvas.clientHeight : 400;
    var zoom = Math.min(w / model.width, h / model.height, 1);
    tab.zoom = Math.max(0.3, Math.min(1.2, Math.round(zoom * 100) / 100));
    tab.scroll = { x: 0, y: 0 };
    paintAreas();
    scheduleSave();
  }
  function renderContent(area, tab) {
    var box = el('div', 'area-content');
    var entityId = tab.selection ? tab.selection.entityId : (tab.root ? tab.root.id : null);
    var node = tab.selection ? tab.selection.node : tab.root;
    var head = el('div', 'content-head');
    head.appendChild(el('span', 'content-title', node ? nodeLabel(node) : ''));
    if (node) head.appendChild(el('span', 'content-path', node.path || ''));
    box.appendChild(head);
    if (tab.content.status === 'loading') box.appendChild(el('p', 'subtle', '正在读取真实字节…'));
    else if (tab.content.status === 'error') {
      box.appendChild(el('p', 'wb-error', '读不到源码：' + tab.content.error));
      if (node && node.kind === 'file') {
        var meta = el('div', 'content-meta');
        meta.appendChild(el('div', null, '类型：' + kindLabel(node) + (node.file_kind === 'binary' ? '（二进制，不提供文本预览）' : '')));
        meta.appendChild(el('div', null, '大小：' + bytesText(node.bytes)));
        meta.appendChild(el('div', null, '路径：' + (node.path || '')));
        box.appendChild(meta);
      }
    } else if (tab.content.data) {
      var d = tab.content.data;
      var wrap = el('div', 'source-wrap');
      var lines = el('div', 'source-lines');
      var total = d.content ? d.content.split('\n').length : 0;
      var startLine = d.start_line || 1;
      var nums = [];
      for (var i = 0; i < total; i++) nums.push(String(startLine + i));
      lines.textContent = nums.join('\n');
      var pre = el('pre', 'source-code');
      pre.textContent = d.content || '';
      wrap.appendChild(lines); wrap.appendChild(pre);
      box.appendChild(wrap);
      var foot = el('p', 'subtle', (d.path || '') + ' · 第 ' + startLine + ' 行起' + (d.truncated ? ' · 已按字节预算截断' : '') + (d.file_total_bytes ? ' · 文件共 ' + bytesText(d.file_total_bytes) : ''));
      box.appendChild(foot);
    } else {
      box.appendChild(el('p', 'subtle', '选一个节点看它的原文。'));
      var b = el('button', 'wb-retry', '读取当前节点');
      b.addEventListener('click', function () { if (entityId) loadContent(tab, entityId); });
      box.appendChild(b);
    }
    return box;
  }
  function renderRelations(area, tab) {
    var box = el('div', 'area-relations');
    var node = tab.selection ? tab.selection.node : tab.root;
    box.appendChild(el('div', 'content-title', node ? nodeLabel(node) : '关系'));
    if (tab.relations.status === 'loading') { box.appendChild(el('p', 'subtle', '正在读取调用关系…')); return box; }
    if (tab.relations.status === 'error') { box.appendChild(el('p', 'wb-error', '关系读取失败：' + tab.relations.error)); return box; }
    if (!tab.relations.out) {
      box.appendChild(el('p', 'subtle', '选一个函数或文件，这里显示它的调用候选。'));
      if (node) {
        var b = el('button', 'wb-retry', '读取关系');
        b.addEventListener('click', function () { loadRelations(tab, node.id); });
        box.appendChild(b);
      }
      return box;
    }
    box.appendChild(el('p', 'subtle', '这是静态调用候选（词法声明级），不是这次运行实际走过的路径。'));
    box.appendChild(relationGroup('被调用方（它调用了谁）', tab.relations.out, tab));
    box.appendChild(relationGroup('调用方（谁调用了它）', tab.relations.in, tab));
    return box;
  }
  function relationGroup(title, data, tab) {
    var box = el('div', 'relation-group');
    box.appendChild(el('h4', null, title));
    if (!data) { box.appendChild(el('p', 'subtle', '没有数据')); return box; }
    var nodes = data.nodes || [];
    if (nodes.length <= 1) { box.appendChild(el('p', 'subtle', '这一侧没有候选')); }
    for (var i = 0; i < nodes.length; i++) {
      (function (n) {
        if (n.id === data.root) return;
        var row = el('button', 'relation-item');
        row.appendChild(el('span', 'relation-name', nodeLabel(n)));
        row.appendChild(el('span', 'relation-path', n.path || ''));
        row.addEventListener('click', function () { openInArea(ws.areas.indexOf(tab.__area || activeArea()), n); });
        box.appendChild(row);
      })(nodes[i]);
    }
    var unresolved = data.unresolved || [];
    if (unresolved.length) {
      box.appendChild(el('p', 'subtle', '未解析的调用 ' + unresolved.length + ' 处（名字没能在本分析里定位）：' + unresolved.slice(0, 6).map(function (e) { return e.label; }).join('、')));
    }
    if (data.truncated) box.appendChild(el('p', 'subtle', '已按预算截断：只画到上限，不是完整闭包。'));
    return box;
  }

  // --- 标签与区域管理 -----------------------------------------------------
  function switchTab(areaIndex, tabIndex) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    area.gen += 1;
    area.activeTab = tabIndex;
    var tab = area.tabs[tabIndex];
    if (tab) tab.gen += 1;
    ws.active = areaIndex;
    ui.knowledge = null; ui.knowledgeError = null;
    ui.annotations = []; ui.interpretations = []; ui.handoffs = [];
    ensureTabReady(tab);
    if (tab && tab.selection) loadInspectorData(tab.selection.node);
    else paintInspector();
    paint();
    scheduleSave();
  }
  function setView(areaIndex, view) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    if (!tab) return;
    tab.view = view;
    var entityId = tab.selection ? tab.selection.entityId : (tab.root ? tab.root.id : null);
    if (view === 'content' && entityId && tab.content.status === 'idle') loadContent(tab, entityId);
    if (view === 'relations' && entityId && tab.relations.status === 'idle' && (tab.selection ? tab.selection.node.kind : tab.root.kind) === 'function') loadRelations(tab, entityId);
    paintAreas();
    scheduleSave();
  }
  function openTabInArea(areaIndex, node) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    var existing = -1;
    for (var i = 0; i < area.tabs.length; i++) {
      if (area.tabs[i].entityId === node.id && area.tabs[i].analysis === session.analysis) { existing = i; break; }
    }
    if (existing >= 0) { switchTab(areaIndex, existing); return; }
    var tab = newTab({ entityId: node.id, name: node.name, path: node.path, kind: node.kind, root: toTreeNode(node) });
    tab.expanded[node.id] = true;
    area.tabs.push(tab);
    switchTab(areaIndex, area.tabs.length - 1);
    loadMembers(tab, node.id);
  }
  function openTabFromSelection(areaIndex) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    var node = tab && tab.selection ? tab.selection.node : (tab && tab.root);
    if (!node) { setStatus('先单击一个节点再新建标签'); return; }
    openTabInArea(areaIndex, node);
  }
  function openInArea(areaIndex, node) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    if (!tab) return;
    revealNode(tab, node);
  }
  function closeTab(areaIndex, tabIndex) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    var tab = area.tabs[tabIndex];
    if (!tab) return;
    area.gen += 1;
    area.closedTabs = area.closedTabs || [];
    area.closedTabs.push({ entityId: tab.entityId, analysis: tab.analysis, name: tab.name, path: tab.path, kind: tab.kind, view: tab.view });
    area.tabs.splice(tabIndex, 1);
    if (area.activeTab >= area.tabs.length) area.activeTab = Math.max(0, area.tabs.length - 1);
    paint();
    scheduleSave();
  }
  function restoreTab(areaIndex) {
    var area = ws.areas[areaIndex];
    if (!area || !area.closedTabs || !area.closedTabs.length) return;
    var spec = area.closedTabs.pop();
    var tab = newTab(spec);
    tab.expanded[tab.entityId] = true;
    area.tabs.push(tab);
    switchTab(areaIndex, area.tabs.length - 1);
    if (spec.analysis !== session.analysis) { tab.stale = true; paint(); return; }
    ensureTabReady(tab);
    loadMembers(tab, tab.entityId);
  }
  function createArea(spec) {
    var area = newArea(spec || {});
    ws.areas.push(area);
    ws.active = ws.areas.length - 1;
    ws.sizes = [];
    ensureTabReady(area.tabs[0]);
    paint();
    scheduleSave();
    return area;
  }
  function closeAreaByIndex(index) {
    var area = ws.areas[index];
    if (!area) return;
    ws.closedAreas.push(area);
    ws.areas.splice(index, 1);
    ws.sizes = [];
    if (ws.maximized === area.id) ws.maximized = null;
    if (ws.active >= ws.areas.length) ws.active = Math.max(0, ws.areas.length - 1);
    paint();
    scheduleSave();
  }
  function restoreArea() {
    var area = ws.closedAreas.pop();
    if (!area) return;
    ws.areas.push(area);
    ws.active = ws.areas.length - 1;
    ws.sizes = [];
    paint();
    scheduleSave();
  }
  function restoreClosedAreaButton() {
    var b = el('button', 'map-restore-area', '恢复刚关闭的展示区');
    b.addEventListener('click', function () { restoreArea(); });
    return b;
  }
  async function relocateTab(areaIndex) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    if (!tab) return;
    try {
      var res = await api('relocate', { entity: tab.entityId, from: tab.analysis });
      var summary = res.relocation || {};
      if (summary.relocated && res.selection) {
        tab.entityId = res.selection.entity_id;
        tab.analysis = session.analysis;
        tab.root = null;
        tab.children = {};
        tab.expanded = {};
        tab.selection = null;
        tab.stale = false;
        tab.staleNote = '已依据 ' + (summary.matched_by || 'unknown') + ' 重定位' + (summary.bytes_changed ? '（字节已变化）' : '（字节相同）');
        area.gen += 1; tab.gen += 1;
        await ensureTabReady(tab);
        paint();
        setStatus('已重定位到当前版本：' + (summary.matched_by || 'unknown'));
      } else {
        tab.staleNote = '重定位被拒绝（' + (summary.refusal || 'unknown') + '）';
        paintAreas();
        setStatus('重定位被拒绝：' + (summary.refusal || 'unknown'));
      }
    } catch (e) {
      setStatus('重定位失败：' + String((e && e.message) || e));
    }
    scheduleSave();
  }
  function locateInProject(areaIndex) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    var tab = area.tabs[area.activeTab];
    var node = tab && tab.selection ? tab.selection.node : (tab ? tab.root : null);
    var root = null;
    for (var i = 0; i < ws.areas.length; i++) {
      for (var t = 0; t < ws.areas[i].tabs.length; t++) {
        if (ws.areas[i].tabs[t].entityId === ROOT_ID && ws.areas[i].tabs[t].analysis === session.analysis) root = { area: i, tab: t };
      }
    }
    if (!root) {
      var area2 = createArea({ entityId: ROOT_ID, title: '项目地图', kind: 'project' });
      root = { area: ws.areas.indexOf(area2), tab: 0 };
    }
    switchTab(root.area, root.tab);
    if (node && node.id !== ROOT_ID) revealNode(ws.areas[root.area].tabs[root.tab], node);
  }

  // --- 节点菜单 -----------------------------------------------------------
  var menuEl = null;
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onDocDown(ev) { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); }
  function onMenuKey(ev) { if (ev.key === 'Escape') { closeMenu(); } }
  function openMenu(anchor, items) {
    closeMenu();
    var menu = el('div', 'map-menu');
    menu.setAttribute('role', 'menu');
    items.forEach(function (item) {
      if (item.divider) { menu.appendChild(el('div', 'map-menu-divider')); return; }
      if (item.head) { menu.appendChild(el('div', 'map-menu-head', item.head)); return; }
      var b = el('button', 'map-menu-item' + (item.disabled ? ' is-disabled' : ''));
      b.appendChild(el('span', null, item.label));
      if (item.hint) b.appendChild(el('span', 'map-menu-hint', item.hint));
      if (!item.disabled) b.addEventListener('click', function () { closeMenu(); item.run(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    var rect = anchor.getBoundingClientRect();
    var top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    var left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.left = Math.max(8, left) + 'px';
    menuEl = menu;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  }
  function commonActions(node, tab, areaIndex) {
    var area = ws.areas[areaIndex];
    var isFav = ws.favorites.some(function (f) { return f.entityId === node.id; });
    return [
      { label: '在新展示区域打开', hint: '以这个节点为根', run: function () { createArea({ entityId: node.id, name: node.name, path: node.path, kind: node.kind }); } },
      { label: '在当前区新建标签', run: function () { openTabInArea(areaIndex, node); } },
      { label: '在项目中定位', run: function () { locateInProject(areaIndex); } },
      { label: '查看简介', run: function () { selectNode(area ? area.tabs[area.activeTab] : tab, node); ui.tab = 'summary'; paintInspector(); } },
      { label: '写批注', run: function () { selectNode(area ? area.tabs[area.activeTab] : tab, node); ui.tab = 'notes'; paintInspector(); } },
      { label: isFav ? '取消关注' : '关注这个节点', run: function () {
        if (isFav) ws.favorites = ws.favorites.filter(function (f) { return f.entityId !== node.id; });
        else ws.favorites.push({ analysis: session.analysis, entityId: node.id, name: nodeLabel(node), path: node.path, kind: node.kind });
        paint(); scheduleSave();
      } },
      { label: '复制路径', run: function () { copyText(node.path || node.id, '已复制路径'); } },
      { label: '复制固定引用', run: function () { copyText(node.id + ' @ ' + (tab ? tab.analysis : session.analysis), '已复制固定引用（实体 + 分析版本）'); } }
    ];
  }
  function typeActions(node, tab, areaIndex) {
    var kind = node.kind;
    var isCode = node.kind === 'file' && node.file_kind === 'code';
    var items = [];
    if (kind === 'project') {
      items.push({ head: '项目' });
      items.push({ label: '查看项目成员与范围', run: function () { focusSubtree(node, areaIndex); } });
      items.push({ label: '搜索这个项目', run: function () { focusSearch(node.name || ''); } });
      items.push({ label: '查看本项目提案', run: function () { gotoPage('review', node.id); } });
    } else if (kind === 'directory') {
      items.push({ head: '目录' });
      items.push({ label: '聚焦这个子树（新区域）', run: function () { createArea({ entityId: node.id, name: node.name, path: node.path, kind: node.kind }); } });
      items.push({ label: '搜索这个目录', run: function () { focusSearch(node.path || ''); } });
      items.push({ label: '按目录审阅改动', run: function () { gotoPage('review', node.id); } });
    } else if (kind === 'file') {
      items.push({ head: kindLabel(node) });
      items.push({ label: '查看源码/原文', hint: '内容视图', run: function () { switchToView(areaIndex, 'content', node); } });
      if (isCode) items.push({ label: '查看引用与依赖', hint: '关系视图', run: function () { switchToView(areaIndex, 'relations', node); } });
      items.push({ label: '查看文件变更', run: function () { gotoPage('review', node.id); } });
      items.push({ label: '交给 Agent：解释这个文件', run: function () { startHandoff(node, 'explain'); } });
      items.push({ label: '交给 Agent：修改', run: function () { startHandoff(node, 'change'); } });
      items.push({ label: '交给 Agent：补测试', run: function () { startHandoff(node, 'test'); } });
    } else if (kind === 'function') {
      items.push({ head: '函数' });
      items.push({ label: '查看源码', hint: '内容视图', run: function () { switchToView(areaIndex, 'content', node); } });
      items.push({ label: '调用方 / 被调用方', hint: '关系视图', run: function () { switchToView(areaIndex, 'relations', node); } });
      items.push({ label: '值从哪来', hint: '简介里的算法摘要', run: function () { selectNode(ws.areas[areaIndex].tabs[ws.areas[areaIndex].activeTab], node); ui.tab = 'summary'; ui.source = 'facts'; paintInspector(); } });
      items.push({ label: '带这个对象去运行验证', run: function () { gotoPage('run', node.id); } });
      items.push({ label: '查看这个函数的修改', run: function () { gotoPage('review', node.id); } });
      items.push({ label: '在 3D 地图中查看同一对象', hint: '同一实体与版本', run: function () { gotoPage('city', node.id); } });
      items.push({ label: '交给 Agent：解释', run: function () { startHandoff(node, 'explain'); } });
      items.push({ label: '交给 Agent：找问题', run: function () { startHandoff(node, 'review'); } });
      items.push({ label: '交给 Agent：补测试', run: function () { startHandoff(node, 'test'); } });
      items.push({ label: '交给 Agent：修改/重构', run: function () { startHandoff(node, 'change'); } });
    } else if (kind === 'section') {
      items.push({ head: '文档章节' });
      items.push({ label: '阅读这个章节', hint: '内容视图', run: function () { switchToView(areaIndex, 'content', node); } });
      items.push({ label: '给这个章节写批注', run: function () { selectNode(ws.areas[areaIndex].tabs[ws.areas[areaIndex].activeTab], node); ui.tab = 'notes'; paintInspector(); } });
      items.push({ label: '交给 Agent：完善文档', run: function () { startHandoff(node, 'document'); } });
      items.push({ label: '交给 Agent：检查描述与源码是否一致', run: function () { startHandoff(node, 'review'); } });
    }
    return items;
  }
  function openNodeMenu(anchor, node, tab, areaIndex) {
    var items = commonActions(node, tab, areaIndex).concat([{ divider: true }]).concat(typeActions(node, tab, areaIndex));
    openMenu(anchor, items);
  }
  function openTabMenu(anchor, area, tabIndex) {
    var items = [{ head: '标签' }];
    for (var i = 0; i < ws.areas.length; i++) {
      if (i === ws.areas.indexOf(area)) continue;
      (function (target) {
        items.push({ label: '移到展示区 ' + (target + 1), run: function () { moveTab(ws.areas.indexOf(area), tabIndex, target); } });
      })(i);
    }
    items.push({ divider: true });
    items.push({ label: '关闭其他标签', run: function () {
      var keep = area.tabs[tabIndex];
      for (var k = area.tabs.length - 1; k >= 0; k--) if (area.tabs[k] !== keep) closeTab(ws.areas.indexOf(area), k);
    } });
    items.push({ label: '关闭这个标签', run: function () { closeTab(ws.areas.indexOf(area), tabIndex); } });
    openMenu(anchor, items);
  }
  function moveTab(fromArea, tabIndex, toArea) {
    var a = ws.areas[fromArea], b = ws.areas[toArea];
    if (!a || !b) return;
    var tab = a.tabs[tabIndex];
    if (!tab) return;
    a.gen += 1; b.gen += 1; tab.gen += 1;
    b.tabs.push(tab);
    a.tabs.splice(tabIndex, 1);
    if (a.activeTab >= a.tabs.length) a.activeTab = Math.max(0, a.tabs.length - 1);
    switchTab(toArea, b.tabs.length - 1);
  }
  function focusSubtree(node, areaIndex) { createArea({ entityId: node.id, name: node.name, path: node.path, kind: node.kind }); }
  function switchToView(areaIndex, view, node) {
    var area = ws.areas[areaIndex];
    if (!area) return;
    selectNode(area.tabs[area.activeTab], node);
    setView(areaIndex, view);
  }
  function copyText(text, note) {
    var done = function () { setStatus(note || '已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); done();
      } catch (e) { setStatus('复制失败：' + String(e && e.message)); }
    }
  }
  function gotoPage(page, entityId) {
    if (window.atlasUi && typeof window.atlasUi.openInPage === 'function') {
      window.atlasUi.openInPage(page, entityId).then(function (res) {
        if (res && res.ok) setStatus('已切到「' + page + '」页，目标是 ' + nodeLabelOf(entityId));
        else setStatus('没能切到「' + page + '」页：' + ((res && res.error) || 'unknown'));
      });
      return;
    }
    setStatus('运行/审阅页的入口还没接上（当前页面还没导出切换接口）。');
  }
  function nodeLabelOf(entityId) {
    var sel = activeSelection();
    return sel && sel.entityId === entityId ? nodeLabel(sel.node) : entityId;
  }

  // --- 搜索 ---------------------------------------------------------------
  var searchTimer = null;
  var searchState = { q: '', items: [], total: 0, status: 'idle', error: null, open: false };
  function focusSearch(seed) {
    var input = $('map-search-input');
    if (!input) return;
    input.value = seed || '';
    input.focus();
    if (seed) runSearch(seed);
  }
  function runSearch(q) {
    var panel = $('map-search-panel');
    searchState.q = q;
    if (!q || q.length < 1) { searchState.status = 'idle'; searchState.items = []; if (panel) panel.hidden = true; return; }
    searchState.status = 'loading';
    paintSearch();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async function () {
      try {
        var res = await api('search', { q: q, kind: 'all', limit: 40 });
        if (res.query !== q) return;
        searchState.items = res.items || [];
        searchState.total = res.total || 0;
        searchState.status = 'ready';
        searchState.error = null;
      } catch (e) {
        searchState.status = 'error';
        searchState.error = String((e && e.message) || e);
      }
      paintSearch();
    }, 180);
  }
  function paintSearch() {
    var panel = $('map-search-panel');
    if (!panel) return;
    clear(panel);
    if (searchState.status === 'idle' || !searchState.q) { panel.hidden = true; return; }
    panel.hidden = false;
    var head = el('div', 'search-head');
    head.appendChild(el('span', null, '“' + searchState.q + '” 命中 ' + searchState.total + ' 个（全项目，不依赖已加载节点）'));
    var close = el('button', 'wb-retry', '关闭');
    close.addEventListener('click', function () { panel.hidden = true; });
    head.appendChild(close);
    panel.appendChild(head);
    if (searchState.status === 'loading') { panel.appendChild(el('p', 'subtle', '正在搜索…')); return; }
    if (searchState.status === 'error') { panel.appendChild(el('p', 'wb-error', '搜索失败：' + searchState.error)); return; }
    if (!searchState.items.length) { panel.appendChild(el('p', 'subtle', '没有命中。搜索按名称或路径子串匹配，大小写不敏感。')); return; }
    for (var i = 0; i < searchState.items.length; i++) {
      (function (item) {
        var b = el('button', 'search-item');
        b.appendChild(el('span', 'search-item-name', nodeLabel(item)));
        b.appendChild(el('span', 'search-item-kind', kindLabel(item)));
        b.appendChild(el('span', 'search-item-path', item.path || ''));
        b.addEventListener('click', function () {
          panel.hidden = true;
          var area = activeArea();
          if (!area) createArea({ entityId: ROOT_ID, title: '项目地图', kind: 'project' });
          var tab = activeTab();
          revealNode(tab, item);
        });
        panel.appendChild(b);
      })(searchState.items[i]);
    }
    if (searchState.total > searchState.items.length) panel.appendChild(el('p', 'subtle', '只显示前 ' + searchState.items.length + ' 条，继续输入可以缩小范围。'));
  }

  // --- 目录索引（列表形式的树） -------------------------------------------
  var outlineState = { expanded: {}, children: {} };
  function paintOutline() {
    var host = $('map-outline');
    if (!host) return;
    host.hidden = !ws.outline;
    if (!ws.outline) return;
    clear(host);
    host.appendChild(el('div', 'outline-head', '目录索引'));
    var root = el('div', 'outline-tree');
    root.appendChild(outlineNode(ROOT_ID, '项目', 0));
    host.appendChild(root);
  }
  function outlineNode(id, label, depth) {
    var box = el('div', 'outline-row');
    box.style.paddingLeft = (depth * 14) + 'px';
    var cache = outlineState.children[id];
    var expanded = Boolean(outlineState.expanded[id]);
    var toggle = el('button', 'outline-toggle', expanded ? '▾' : '▸');
    toggle.addEventListener('click', function () {
      outlineState.expanded[id] = !expanded;
      if (!expanded && (!cache || !cache.items)) loadOutlineChildren(id);
      paintOutline();
    });
    var name = el('button', 'outline-name', label);
    name.addEventListener('click', function () {
      var tab = activeTab();
      if (tab) revealNode(tab, { id: id, name: label, path: id.indexOf(':') >= 0 ? id.slice(id.indexOf(':') + 1) : '', kind: id.indexOf('file:') === 0 ? 'file' : id.indexOf('dir:') === 0 ? 'directory' : 'function' });
    });
    box.appendChild(toggle); box.appendChild(name);
    var wrap = el('div', 'outline-wrap');
    wrap.appendChild(box);
    if (expanded && cache && cache.items) {
      for (var i = 0; i < cache.items.length; i++) {
        if (cache.items[i].kind === 'function') continue;
        wrap.appendChild(outlineNode(cache.items[i].id, nodeLabel(cache.items[i]), depth + 1));
      }
    }
    if (expanded && !cache) loadOutlineChildren(id);
    return wrap;
  }
  async function loadOutlineChildren(id) {
    if (outlineState.children[id] && outlineState.children[id].loading) return;
    outlineState.children[id] = outlineState.children[id] || { items: null, loading: true };
    try {
      var params = { limit: 100 };
      if (id !== ROOT_ID) params.parent = id;
      var res = await api('tree', params);
      outlineState.children[id] = { items: res.items || [], loading: false };
    } catch (e) {
      outlineState.children[id] = { items: [], loading: false, error: String((e && e.message) || e) };
    }
    paintOutline();
  }

  // --- 节点详情 -----------------------------------------------------------
  function paintInspector() {
    var host = $('map-inspector');
    if (!host) return;
    clear(host);
    var toggle = $('map-inspector-toggle');
    if (toggle) toggle.setAttribute('aria-pressed', String(ws.inspectorOpen));
    host.hidden = !ws.inspectorOpen;
    if (!ws.inspectorOpen) return;
    var sel = activeSelection();
    var head = el('div', 'inspector-head');
    head.appendChild(el('div', 'inspector-title', sel ? nodeLabel(sel.node) : '未选择节点'));
    var sub = el('div', 'inspector-sub');
    sub.appendChild(el('span', null, sel ? kindLabel(sel.node) : '点地图上的节点'));
    if (sel) sub.appendChild(el('span', 'inspector-version', '版本 ' + short(sel.analysis)));
    head.appendChild(sub);
    var close = el('button', 'inspector-close', '收起');
    close.addEventListener('click', function () { ws.inspectorOpen = false; paintInspector(); scheduleSave(); });
    head.appendChild(close);
    host.appendChild(head);

    if (!sel) {
      host.appendChild(el('p', 'subtle', '单击一个节点看它的简介；双击或回车打开标签；点节点右上角 i 直接看简介。'));
      return;
    }
    var tabs = el('div', 'inspector-tabs');
    [['summary', '简介'], ['notes', '批注'], ['actions', '操作'], ['handoff', '交接']].forEach(function (pair) {
      var b = el('button', 'inspector-tab', pair[1]);
      b.setAttribute('aria-pressed', String(ui.tab === pair[0]));
      b.addEventListener('click', function () { ui.tab = pair[0]; paintInspector(); });
      tabs.appendChild(b);
    });
    host.appendChild(tabs);
    var body = el('div', 'inspector-body');
    if (ui.tab === 'summary') renderSummary(body, sel);
    else if (ui.tab === 'notes') renderNotes(body, sel);
    else if (ui.tab === 'actions') renderActions(body, sel);
    else renderHandoff(body, sel);
    host.appendChild(body);
  }

  async function loadInspectorData(node) {
    var sel = activeSelection();
    if (!sel || sel.entityId !== node.id) return;
    try {
      ui.knowledge = await api('knowledge', { entity: node.id });
      ui.knowledgeError = null;
    } catch (e) { ui.knowledge = null; ui.knowledgeError = String((e && e.message) || e); }
    if (activeSelection() && activeSelection().entityId !== node.id) return;
    paintInspector();
    try {
      var res = await api('node-annotations', { entity: node.id });
      ui.annotations = res.annotations || []; ui.annotationsError = null;
    } catch (e) { ui.annotations = []; ui.annotationsError = String((e && e.message) || e); }
    if (activeSelection() && activeSelection().entityId !== node.id) return;
    paintInspector();
    try {
      var int = await api('interpretations', { entity: node.id });
      ui.interpretations = int.interpretations || []; ui.interpretationsError = null;
    } catch (e) { ui.interpretations = []; ui.interpretationsError = String((e && e.message) || e); }
    if (activeSelection() && activeSelection().entityId !== node.id) return;
    var latest = ui.interpretations[0];
    if (latest && !ui.draft) { ui.draft = latest.body; ui.refs = latest.source_refs && latest.source_refs.length ? latest.source_refs.slice() : ['manual']; }
    paintInspector();
    try {
      var h = await api('handoffs', { entity: node.id });
      ui.handoffs = h.handoffs || []; ui.handoffsError = null;
    } catch (e) { ui.handoffs = []; ui.handoffsError = String((e && e.message) || e); }
    if (activeSelection() && activeSelection().entityId !== node.id) return;
    paintInspector();
    // 已生成的模型解释按节点读回；未配置模型时这项为空，不影响其他来源。
    if (ui.llmState) loadLlmExplanations(node);
  }

  function renderSummary(host, sel) {
    var k = ui.knowledge;
    if (ui.knowledgeError) host.appendChild(el('p', 'wb-error', '简介读取失败：' + ui.knowledgeError));
    if (!k) { host.appendChild(el('p', 'subtle', '正在读取这个节点的真实摘要…')); return; }
    if (k.unsupported_semantics) {
      var banner = el('div', 'inspector-banner', kindLabel(k.node || sel.node) + '：这类节点没有代码语义分析，下面只有结构、正文与你的记录。');
      host.appendChild(banner);
    }
    var srcTabs = el('div', 'source-tabs');
    (k.sources || []).forEach(function (s) {
      var b = el('button', 'source-tab', s.label);
      b.setAttribute('aria-pressed', String(ui.source === s.id));
      // LLM 这一页的"可用"取决于本机配置，不是已发布事实；未配置时也要能点进去配置。
      if (!s.available && s.id !== 'llm') b.classList.add('is-off');
      b.title = s.reason || s.origin || '';
      b.addEventListener('click', function () { ui.source = s.id; paintInspector(); });
      srcTabs.appendChild(b);
    });
    host.appendChild(srcTabs);
    var box = el('div', 'source-body');
    if (ui.source === 'facts') {
      var lines = (k.summary && k.summary.lines) || [];
      if (!lines.length) box.appendChild(el('p', 'subtle', '这个节点没有可组织的算法事实。'));
      for (var i = 0; i < lines.length; i++) {
        var row = el('div', 'fact-row');
        row.appendChild(el('div', 'fact-label', lines[i].label));
        row.appendChild(el('div', 'fact-text', lines[i].text));
        box.appendChild(row);
      }
      var basis = el('p', 'subtle', '依据：' + ((k.summary && k.summary.basis) || '已发布事实') + '（不需要模型）');
      box.appendChild(basis);
    } else if (ui.source === 'comments') {
      var comments = k.comments || [];
      if (!comments.length) box.appendChild(el('p', 'subtle', '这个节点没有可引用的源码注释。'));
      for (var c = 0; c < comments.length; c++) {
        (function (cm) {
          var card = el('div', 'comment-card');
          var head = el('div', 'comment-head');
          head.appendChild(el('span', null, cm.origin || '源码注释'));
          head.appendChild(el('span', 'comment-loc', (cm.path || '') + ':' + (cm.start_line || '?') + (cm.end_line && cm.end_line !== cm.start_line ? '-' + cm.end_line : '')));
          card.appendChild(head);
          card.appendChild(el('pre', 'comment-text', cm.text || ''));
          var jump = el('button', 'wb-retry', '在内容视图里查看原文');
          jump.addEventListener('click', function () {
            var tab = activeTab();
            if (tab) { setView(ws.active, 'content'); }
          });
          card.appendChild(jump);
          box.appendChild(card);
        })(comments[c]);
      }
    } else {
      renderLlm(box, sel);
    }
    host.appendChild(box);

    var lim = k.limitations || [];
    if (lim.length) {
      var limBox = el('div', 'limitations');
      limBox.appendChild(el('div', 'limitations-head', '已知边界'));
      for (var l = 0; l < lim.length; l++) limBox.appendChild(el('div', 'limitation', '· ' + lim[l]));
      host.appendChild(limBox);
    }

    // Atlas 解析记录：引用来源 + 自己编辑 + 保存 + 历史
    var rec = el('div', 'record');
    rec.appendChild(el('div', 'record-head', 'Atlas 解析记录'));
    rec.appendChild(el('p', 'subtle', '引用下面的来源后自己改写再保存；保存的是你的记录，不会改动算法事实与源码注释。'));
    var refs = el('div', 'record-refs');
    ['atlas-summary', 'code-comments', 'llm', 'manual'].forEach(function (id) {
      var label = id === 'atlas-summary' ? '引用算法摘要' : id === 'code-comments' ? '引用源码注释' : id === 'llm' ? '引用模型解释' : '自己写';
      var b = el('button', 'ref-chip', label);
      b.setAttribute('aria-pressed', String(ui.refs.indexOf(id) >= 0));
      b.addEventListener('click', function () {
        var idx = ui.refs.indexOf(id);
        if (idx >= 0) ui.refs.splice(idx, 1); else ui.refs.push(id);
        paintInspector();
      });
      refs.appendChild(b);
    });
    var quote = el('button', 'wb-retry', '把当前来源文字放进编辑区');
    quote.addEventListener('click', function () {
      var text = '';
      if (ui.refs.indexOf('atlas-summary') >= 0 && k.summary) text += (k.summary.lines || []).map(function (l) { return l.label + '：' + l.text; }).join('\n') + '\n';
      if (ui.refs.indexOf('code-comments') >= 0) text += (k.comments || []).map(function (c) { return (c.text || ''); }).join('\n');
      if (ui.refs.indexOf('llm') >= 0) {
        var got = (llmFor(sel.node.id).explanations || []).filter(function (x) { return x.state === 'done'; });
        text += got.length ? got.map(function (x) { return x.body || ''; }).join('\n') : '（这个节点还没有生成成功的模型解释）\n';
      }
      ui.draft = (ui.draft ? ui.draft + '\n' : '') + text;
      paintInspector();
    });
    refs.appendChild(quote);
    rec.appendChild(refs);
    var area = el('textarea', 'record-input');
    area.value = ui.draft || '';
    area.setAttribute('aria-label', '解析记录正文');
    area.placeholder = '写下你对这个节点的理解…';
    area.addEventListener('input', function () { ui.draft = area.value; });
    rec.appendChild(area);
    var row = el('div', 'row-actions');
    var save = el('button', 'wb-primary', '保存为新修订');
    save.addEventListener('click', function () { saveInterpretation(sel.node); });
    row.appendChild(save);
    var histToggle = el('button', 'wb-retry', '历史修订（' + (ui.interpretations.length || 0) + '）');
    histToggle.addEventListener('click', function () { ui.showHistory = !ui.showHistory; paintInspector(); });
    row.appendChild(histToggle);
    rec.appendChild(row);
    if (ui.note) { rec.appendChild(el('div', 'record-note', ui.note)); }
    host.appendChild(rec);

    if (ui.showHistory) {
      var hist = el('div', 'history');
      hist.appendChild(el('div', 'record-head', '解析历史'));
      if (ui.interpretationsError) hist.appendChild(el('p', 'wb-error', ui.interpretationsError));
      if (!ui.interpretations.length) hist.appendChild(el('p', 'subtle', '还没有保存过解析记录。'));
      for (var h = 0; h < ui.interpretations.length; h++) {
        (function (item) {
          var card = el('div', 'history-card');
          var head = el('div', 'history-head');
          head.appendChild(el('span', null, timeText(item.created_at)));
          head.appendChild(el('span', 'history-author', item.author || ''));
          if (item.basis_analysis !== session.analysis) {
            var flag = el('span', 'history-flag', '待核对（写于版本 ' + short(item.basis_analysis) + '）');
            card.appendChild(flag);
          }
          card.appendChild(head);
          card.appendChild(el('pre', 'history-body', item.body || ''));
          var srcs = (item.source_refs || []).join('、');
          card.appendChild(el('div', 'history-refs', '来源引用：' + (srcs || '无') + ' · 依据版本 ' + short(item.basis_analysis)));
          host.appendChild(card);
          hist.appendChild(card);
        })(ui.interpretations[h]);
      }
      host.appendChild(hist);
    }
  }
  async function saveInterpretation(node) {
    var body = (ui.draft || '').trim();
    if (!body) { ui.note = '先写点内容再保存'; paintInspector(); return; }
    try {
      var res = await apiJson('interpretation', { entity: node.id, body: body, source_refs: ui.refs.slice() });
      ui.note = '已保存（' + short(res.interpretation && res.interpretation.id) + '，写于版本 ' + short(session.analysis) + '）';
      ui.interpretations = [res.interpretation].concat(ui.interpretations);
      ui.showHistory = true;
      paintInspector();
      setStatus('解析记录已保存到服务端（按项目隔离，重启后可读回）');
    } catch (e) {
      ui.note = '保存失败：' + String((e && e.message) || e);
      paintInspector();
    }
  }
  // --- 按需 LLM 解释（M5） -------------------------------------------------
  //
  // 四条不能退让的规则：
  //  1. 没有配置连接就没有请求，也没有任何占位文本；配置表单本身是能力，不是装饰。
  //  2. 生成只在点击后发生；发送范围先可见（逐条片段 + 字节数），再发送。
  //  3. 结果属于发起它的节点与版本：生成中切到别的节点，答案回到原节点。
  //  4. 模型解释与用户保存的解析记录是两份记录，生成不覆盖，只有用户点了引用才会进编辑区。
  var llmCache = {};
  function llmFor(entityId) {
    if (!llmCache[entityId]) llmCache[entityId] = { status: 'idle', explanations: [], error: null, preview: null, previewError: null };
    return llmCache[entityId];
  }
  async function loadLlmConfig() {
    try {
      ui.llmState = await api('llm/config');
      ui.llmConfigError = null;
      ui.llmForm = null;
    } catch (e) {
      ui.llmState = null;
      ui.llmConfigError = String((e && e.message) || e);
    }
    paintInspector();
  }
  function llmForm() {
    if (ui.llmForm) return ui.llmForm;
    var s = ui.llmState || {};
    var sc = s.scope || {};
    ui.llmForm = {
      base_url: s.base_url || '',
      model: s.model || '',
      api_key: '',
      adapter: s.adapter || 'adapters/llm/openai-compatible.mjs',
      timeout_ms: s.timeout_ms || 60000,
      max_context_bytes: s.max_context_bytes || 24000,
      comments: sc.comments !== false,
      callees: Boolean(sc.callees),
      callers: Boolean(sc.callers)
    };
    return ui.llmForm;
  }
  async function loadLlmExplanations(node) {
    var slot = llmFor(node.id);
    slot.status = 'loading';
    try {
      var res = await api('llm/explanations', { entity: node.id });
      slot.explanations = res.explanations || [];
      slot.error = null;
    } catch (e) {
      slot.explanations = [];
      slot.error = String((e && e.message) || e);
    }
    slot.status = 'ready';
    paintInspector();
  }

  function renderLlm(host, sel) {
    var node = sel.node;
    var state = ui.llmState;
    var configured = Boolean(state && state.configured);
    var slot = llmFor(node.id);
    var box = el('div', 'llm-box');

    // 1. 连接状态与配置
    if (ui.llmConfigError) box.appendChild(el('p', 'wb-error', '模型连接读取失败：' + ui.llmConfigError));
    var head = el('div', 'llm-line');
    if (configured) {
      head.appendChild(el('span', 'llm-dot on', '●'));
      head.appendChild(el('span', null, '已配置 ' + state.model + ' · ' + state.base_url + (state.has_api_key ? ' · 有 key' : ' · 无 key')));
    } else {
      head.appendChild(el('span', 'llm-dot', '○'));
      head.appendChild(el('span', null, state ? (state.note || '未配置') : '尚未配置模型连接'));
    }
    box.appendChild(head);

    var form = llmForm();
    var details = el('details', 'llm-config');
    if (ui.llmConfigOpen) details.open = true;
    details.appendChild(el('summary', null, configured ? '修改模型连接 / 发送范围' : '配置模型连接'));
    var grid = el('div', 'llm-form');
    function field(label, input, hint) {
      var row = el('label', 'llm-field');
      row.appendChild(el('span', 'llm-field-label', label));
      row.appendChild(input);
      if (hint) row.appendChild(el('span', 'llm-hint', hint));
      grid.appendChild(row);
    }
    function textInput(value, placeholder, type) {
      var i = el('input', 'llm-input');
      i.type = type || 'text';
      i.value = value || '';
      if (placeholder) i.placeholder = placeholder;
      return i;
    }
    var urlInput = textInput(form.base_url, 'https://host/v1');
    urlInput.addEventListener('change', function () { form.base_url = urlInput.value.trim(); });
    field('服务地址', urlInput, '只在本机配置里保存；必须 http(s)');
    var modelInput = textInput(form.model, '模型名');
    modelInput.addEventListener('change', function () { form.model = modelInput.value.trim(); });
    field('模型', modelInput);
    var keyInput = textInput('', state && state.has_api_key ? '已保存，留空表示不改' : '可选');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.addEventListener('change', function () { form.api_key = keyInput.value; });
    field('API key', keyInput, '服务端永不回传 key');
    var adapterInput = textInput(form.adapter, 'adapters/llm/openai-compatible.mjs');
    adapterInput.addEventListener('change', function () { form.adapter = adapterInput.value.trim(); });
    field('适配器命令', adapterInput, '相对路径按工作目录向上查找');
    var timeoutInput = textInput(String(form.timeout_ms), '60000', 'number');
    timeoutInput.addEventListener('change', function () { form.timeout_ms = Number(timeoutInput.value) || 60000; });
    field('超时 (ms)', timeoutInput, '1000–300000');
    var budgetInput = textInput(String(form.max_context_bytes), '24000', 'number');
    budgetInput.addEventListener('change', function () { form.max_context_bytes = Number(budgetInput.value) || 24000; });
    field('上下文上限 (字节)', budgetInput, '512–200000');
    var scopeRow = el('div', 'llm-field llm-scope');
    scopeRow.appendChild(el('span', 'llm-field-label', '发送范围'));
    [['comments', '源码注释与算法摘要'], ['callees', '被调用方源码'], ['callers', '调用方源码']].forEach(function (pair) {
      var wrap = el('label', 'llm-check');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(form[pair[0]]);
      cb.addEventListener('change', function () { form[pair[0]] = cb.checked; });
      wrap.appendChild(cb);
      wrap.appendChild(el('span', null, pair[1]));
      scopeRow.appendChild(wrap);
    });
    grid.appendChild(scopeRow);
    details.appendChild(grid);
    var formRow = el('div', 'row-actions');
    var save = el('button', 'wb-primary', '保存连接');
    save.addEventListener('click', function () { saveLlmConfig(); });
    formRow.appendChild(save);
    var preview = el('button', 'wb-retry', '预览将要发送的范围');
    preview.addEventListener('click', function () { loadLlmPreview(node); });
    formRow.appendChild(preview);
    var drop = el('button', 'wb-retry', '清除连接');
    drop.addEventListener('click', function () { clearLlmConfig(); });
    formRow.appendChild(drop);
    details.appendChild(formRow);
    if (ui.llmConfigNote) details.appendChild(el('p', 'llm-note', ui.llmConfigNote));
    box.appendChild(details);

    // 2. 范围预览：发送之前先看见要发什么
    if (slot.previewError) box.appendChild(el('p', 'wb-error', '范围预览失败：' + slot.previewError));
    if (slot.preview) {
      var pv = el('div', 'llm-preview');
      pv.appendChild(el('div', 'record-head', '将要发送的内容（' + slot.preview.pieces.length + ' 段 · ' + bytesText(slot.preview.total_bytes) + '）'));
      slot.preview.pieces.forEach(function (p) {
        var row = el('div', 'fact-row');
        row.appendChild(el('div', 'fact-label', p.label));
        row.appendChild(el('div', 'fact-text', p.path + ' · ' + p.reason + ' · ' + bytesText(p.bytes)));
        pv.appendChild(row);
      });
      if (slot.preview.truncated) pv.appendChild(el('p', 'llm-note', '有片段超出上下文上限，已整段排除，没有半截发送。'));
      pv.appendChild(el('p', 'subtle', '提示词共 ' + bytesText(slot.preview.prompt_bytes) + '；不含整个项目，只含上面列出的片段。'));
      box.appendChild(pv);
    }

    // 3. 显式生成 / 取消
    var question = el('textarea', 'llm-question');
    question.setAttribute('aria-label', '给模型的问题');
    question.placeholder = '可选：针对这个节点想问什么';
    question.value = slot.question || '';
    question.addEventListener('input', function () { slot.question = question.value; });
    box.appendChild(question);

    var job = ui.llmJob;
    var mine = job && job.entityId === node.id ? job : null;
    var actions = el('div', 'row-actions');
    var gen = el('button', 'wb-primary', mine && mine.state === 'running' ? '生成中…' : '生成解释');
    gen.disabled = !configured || Boolean(mine && mine.state === 'running');
    gen.title = configured ? '按上面的范围发送一次请求' : '先配置模型连接';
    gen.addEventListener('click', function () { startLlm(node); });
    actions.appendChild(gen);
    if (mine && mine.state === 'running') {
      var cancel = el('button', 'wb-retry', '取消生成');
      cancel.addEventListener('click', function () { cancelLlm(mine.id); });
      actions.appendChild(cancel);
    }
    box.appendChild(actions);

    if (job && job.note) box.appendChild(el('p', 'llm-note', job.note));
    if (mine && mine.state === 'failed') box.appendChild(el('p', 'wb-error', '生成失败：' + (mine.error || '未知原因') + '（可以改配置或重试）'));
    if (mine && mine.state === 'cancelled') box.appendChild(el('p', 'llm-note', '已取消：这次没有生成结果，也没有写进你的解析记录。'));

    // 4. 已生成的解释：与用户解析记录分开，可显式引用
    box.appendChild(el('div', 'record-head', '已生成的解释'));
    if (slot.error) box.appendChild(el('p', 'wb-error', slot.error));
    var list = slot.explanations || [];
    if (!list.length && slot.status !== 'loading') box.appendChild(el('p', 'subtle', '还没有生成过。生成后这里会保留模型、服务地址与对应的代码版本。'));
    if (slot.status === 'loading') box.appendChild(el('p', 'subtle', '正在读取已生成的解释…'));
    list.forEach(function (item) {
      var card = el('div', 'note-card');
      var head = el('div', 'note-head', (item.model || '') + ' · ' + timeText(item.created_at) + ' · 版本 ' + short(item.analysis_id));
      card.appendChild(head);
      if (item.base_url) card.appendChild(el('div', 'llm-note', '服务地址 ' + item.base_url));
      card.appendChild(el('pre', 'note-body', item.body || ''));
      if (item.state !== 'done') card.appendChild(el('div', 'llm-note', '状态：' + item.state + (item.error ? ' · ' + item.error : '')));
      var quote = el('button', 'wb-retry', '引用到我的解析记录');
      quote.addEventListener('click', function () {
        ui.refs = ['llm'];
        ui.draft = (ui.draft ? ui.draft + '\n' : '') + (item.body || '');
        ui.tab = 'summary';
        ui.source = 'facts';
        paintInspector();
        setStatus('已把这段模型解释放进编辑区；它不会自动覆盖你已保存的内容，保存后才会成为新修订。');
      });
      card.appendChild(quote);
      box.appendChild(card);
    });
    box.appendChild(el('p', 'subtle', '模型解释不是 Atlas 的分析结论，也不是你确认过的记录；它不会自动改写上面的解析记录。'));
    host.appendChild(box);
  }

  async function saveLlmConfig() {
    var form = llmForm();
    ui.llmConfigNote = '正在保存…';
    paintInspector();
    try {
      var res = await apiJson('llm/config', form, 'PUT');
      ui.llmState = res;
      ui.llmForm = null;
      ui.llmConfigNote = res.configured ? '已保存并生效：只有你点击生成时才发出请求。' : '已保存，但还不完整：' + (res.note || '需要 base_url、model 与适配器。');
      paintInspector();
      setStatus('模型连接已按项目保存到服务端');
    } catch (e) {
      ui.llmConfigNote = '保存失败：' + String((e && e.message) || e);
      paintInspector();
    }
  }
  async function clearLlmConfig() {
    try {
      ui.llmState = await apiJson('llm/config', {}, 'DELETE');
      ui.llmForm = null;
      ui.llmConfigNote = '已清除连接（含保存的 key）。';
    } catch (e) {
      ui.llmConfigNote = '清除失败：' + String((e && e.message) || e);
    }
    paintInspector();
  }
  async function loadLlmPreview(node) {
    var slot = llmFor(node.id);
    slot.previewError = null;
    paintInspector();
    try {
      slot.preview = await api('llm/context', { entity: node.id, q: slot.question || '' });
    } catch (e) {
      slot.preview = null;
      slot.previewError = String((e && e.message) || e);
    }
    paintInspector();
  }
  async function startLlm(node) {
    var slot = llmFor(node.id);
    try {
      var res = await apiJson('llm/explain', { entity: node.id, question: slot.question || '' });
      ui.llmJob = { id: res.id, entityId: node.id, name: node.name || node.id, state: 'running', note: '生成中：离开这个节点也会继续，结果回到这个节点。' };
      paintInspector();
      pollLlmJob(res.id, node);
    } catch (e) {
      ui.llmJob = { id: null, entityId: node.id, name: node.name || node.id, state: 'failed', error: String((e && e.message) || e), note: null };
      paintInspector();
      setStatus('生成没有开始：' + String((e && e.message) || e));
    }
  }
  async function pollLlmJob(id, node) {
    for (var attempt = 0; attempt < 240; attempt += 1) {
      await new Promise(function (r) { setTimeout(r, 1500); });
      var res;
      try {
        res = await api('llm/explain/status', { id: id });
      } catch (e) { continue; }
      var job = res && res.job;
      if (!job) continue;
      if (!ui.llmJob || ui.llmJob.id !== id) return;
      ui.llmJob.state = job.state;
      ui.llmJob.error = job.error || null;
      if (job.state === 'running') { paintInspector(); continue; }
      // 终态：把结果读回发起它的那个节点，而不是当前恰好选中的节点。
      ui.llmJob.note = job.state === 'done'
        ? '已生成（模型 ' + job.model + '，回到节点 ' + (node.name || node.id) + '）'
        : (job.state === 'cancelled' ? '已取消' : '生成失败：' + (job.error || ''));
      await loadLlmExplanations(node);
      var sel = activeSelection();
      if (!sel || sel.entityId !== node.id) {
        setStatus('「' + (node.name || node.id) + '」的' + (job.state === 'done' ? '解释已生成' : '生成' + (job.state === 'cancelled' ? '已取消' : '失败')) + '：结果回到原节点。');
      }
      paintInspector();
      return;
    }
  }
  async function cancelLlm(id) {
    try {
      var res = await apiJson('llm/explain/cancel', { id: id });
      if (ui.llmJob && ui.llmJob.id === id) {
        ui.llmJob.note = res.cancelled ? '取消信号已发出。' : '这个作业已经结束，没有可取消的进程。';
      }
    } catch (e) {
      if (ui.llmJob && ui.llmJob.id === id) ui.llmJob.note = '取消失败：' + String((e && e.message) || e);
    }
    paintInspector();
  }

  function renderNotes(host, sel) {
    host.appendChild(el('div', 'record-head', '批注（绑定这个节点与版本）'));
    if (ui.annotationsError) host.appendChild(el('p', 'wb-error', ui.annotationsError));
    if (!ui.annotations.length) host.appendChild(el('p', 'subtle', '还没有批注。批注是提案性质的记录，不是已存在的代码。'));
    for (var i = 0; i < ui.annotations.length; i++) {
      (function (a) {
        var card = el('div', 'note-card');
        card.appendChild(el('div', 'note-head', (a.proposed_by || '') + ' · ' + timeText(a.created_at) + ' · ' + a.kind));
        card.appendChild(el('div', 'note-body', a.body));
        host.appendChild(card);
      })(ui.annotations[i]);
    }
    var input = el('textarea', 'note-input');
    input.setAttribute('aria-label', '批注正文');
    input.placeholder = '写下你的意见或要 Agent 处理的问题…';
    host.appendChild(input);
    var row = el('div', 'row-actions');
    var add = el('button', 'wb-primary', '保存批注');
    add.addEventListener('click', async function () {
      var text = (input.value || '').trim();
      if (!text) { setStatus('先写批注内容'); return; }
      try {
        var res = await apiJson('node-annotation', { entity: sel.node.id, kind: 'constraint', body: text });
        input.value = '';
        ui.annotations = (ui.annotations || []).concat([res.annotation]);
        paintInspector();
        setStatus(res.outcome === 'created' ? '批注已保存' : '这条批注已经存在');
      } catch (e) { setStatus('批注保存失败：' + String((e && e.message) || e)); }
    });
    row.appendChild(add);
    host.appendChild(row);
  }
  function renderActions(host, sel) {
    host.appendChild(el('div', 'record-head', '这个节点可以做的事'));
    var node = sel.node;
    var tab = activeTab();
    var areaIndex = ws.active;
    var items = commonActions(node, tab, areaIndex).concat([{ divider: true }]).concat(typeActions(node, tab, areaIndex));
    items.forEach(function (item) {
      if (item.divider) { host.appendChild(el('div', 'map-menu-divider')); return; }
      if (item.head) { host.appendChild(el('div', 'map-menu-head', item.head)); return; }
      var b = el('button', 'action-item');
      b.appendChild(el('span', null, item.label));
      if (item.hint) b.appendChild(el('span', 'action-hint', item.hint));
      b.addEventListener('click', function () { item.run(); });
      host.appendChild(b);
    });
  }

  // --- 交接 ---------------------------------------------------------------
  var HANDOFF_INTENT = {
    explain: '解释这段代码：它做什么、依赖什么、有哪些边界。',
    review: '找出这段代码可能的问题，并说明判断依据。',
    test: '为这段代码补测试，说明要覆盖的分支与边界。',
    change: '按下面的目标修改这段代码，先给出可审阅的 diff。',
    document: '完善这段文档，让它和源码一致。'
  };
  function startHandoff(node, intent) {
    var sel = activeSelection();
    if (!sel || sel.entityId !== node.id) selectNode(activeTab(), node);
    ui.tab = 'handoff';
    ui.handoffGoal = HANDOFF_INTENT[intent] || HANDOFF_INTENT.explain;
    ui.handoffId = null;
    paintInspector();
  }
  function renderHandoff(host, sel) {
    host.appendChild(el('div', 'record-head', '交接给 Agent'));
    var scope = el('div', 'handoff-scope');
    scope.appendChild(el('div', null, '目标节点：' + nodeLabel(sel.node) + '（' + kindLabel(sel.node) + '）'));
    scope.appendChild(el('div', null, '路径：' + (sel.node.path || '') + (sel.node.kind === 'function' ? ' · 字节 ' + sel.node.start + '–' + sel.node.end : '')));
    scope.appendChild(el('div', null, '固定版本：' + sel.analysis));
    scope.appendChild(el('div', null, '服务项目：' + (session.projectName || session.projectKey || '本机项目')));
    var anns = ui.annotations || [];
    scope.appendChild(el('div', null, '附带的批注：' + (anns.length ? anns.length + ' 条' : '无')));
    host.appendChild(scope);

    var label = el('div', 'handoff-label', '要 Agent 做什么');
    host.appendChild(label);
    var goal = el('textarea', 'handoff-goal');
    goal.setAttribute('aria-label', '交接目标');
    goal.value = ui.handoffGoal || '';
    goal.addEventListener('input', function () { ui.handoffGoal = goal.value; });
    host.appendChild(goal);

    var row = el('div', 'row-actions');
    var save = el('button', 'wb-primary', '保存草稿');
    save.addEventListener('click', function () { saveHandoff(sel.node, 'draft'); });
    row.appendChild(save);
    var copy = el('button', 'wb-retry', '复制交接包');
    copy.addEventListener('click', function () { copyHandoff(sel.node); });
    row.appendChild(copy);
    var send = el('button', 'wb-retry', '发送给已连接的 Agent');
    send.disabled = true;
    send.title = '当前没有已连接的 Agent 会话：状态必须来自真实连接，不能由页面自己猜测';
    row.appendChild(send);
    host.appendChild(row);
    host.appendChild(el('p', 'subtle', '复制与导出是本地动作：服务端只记录“已导出”，不会把它显示成已发送。'));

    if (ui.handoffsError) host.appendChild(el('p', 'wb-error', ui.handoffsError));
    host.appendChild(el('div', 'record-head', '这个节点上的交接（' + (ui.handoffs.length || 0) + '）'));
    for (var i = 0; i < ui.handoffs.length; i++) {
      (function (h) {
        var card = el('div', 'handoff-card');
        card.appendChild(el('div', 'handoff-head', (h.title || '交接') + ' · ' + h.state + ' · ' + timeText(h.updated_at || h.created_at)));
        card.appendChild(el('div', 'handoff-goal', h.goal));
        var msgs = h.messages || [];
        for (var m = 0; m < msgs.length; m++) {
          card.appendChild(el('div', 'handoff-msg', (msgs[m].author || '') + '：' + msgs[m].text));
        }
        if (h.proposal_id) card.appendChild(el('div', 'handoff-link', '关联提案 ' + short(h.proposal_id, 12)));
        var msg = el('input', 'handoff-msg-input');
        msg.setAttribute('aria-label', '追加讨论');
        msg.placeholder = '追加一条意见…';
        msg.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter') return;
          appendHandoffMessage(h.id, msg.value);
        });
        card.appendChild(msg);
        host.appendChild(card);
      })(ui.handoffs[i]);
    }
  }
  async function saveHandoff(node, state) {
    var goal = (ui.handoffGoal || '').trim();
    if (!goal) { setStatus('先写下要 Agent 做什么'); return; }
    try {
      var res = await apiJson('handoff', {
        entity: node.id,
        goal: goal,
        annotations: (ui.annotations || []).map(function (a) { return a.id; }),
        scope: { analysis_id: session.analysis, entity_id: node.id, project: session.projectKey }
      });
      ui.handoffs = [res.handoff].concat(ui.handoffs.filter(function (h) { return h.id !== res.handoff.id; }));
      ui.handoffId = res.handoff.id;
      paintInspector();
      setStatus('交接草稿已保存到服务端（身份 ' + short(res.handoff.id, 12) + '）');
    } catch (e) {
      setStatus('交接保存失败：' + String((e && e.message) || e));
    }
  }
  async function copyHandoff(node) {
    try {
      var res = await apiJson('handoff', {
        entity: node.id,
        goal: (ui.handoffGoal || '').trim() || HANDOFF_INTENT.explain,
        annotations: (ui.annotations || []).map(function (a) { return a.id; }),
        scope: { analysis_id: session.analysis, entity_id: node.id, project: session.projectKey }
      });
      await apiJson('handoff/exported', { id: res.handoff.id });
      var packet = {
        schema: 'atlas.handoff-packet.v1',
        handoff_id: res.handoff.id,
        project: session.projectKey,
        project_name: session.projectName,
        analysis_id: session.analysis,
        entity_id: node.id,
        path: node.path || '',
        kind: node.kind,
        goal: res.handoff.goal,
        annotations: ui.annotations || [],
        how_to_read: '用 Atlas 公开接口读取范围：GET /api/contract 列出全部接口；上下文用 POST /api/context?entity=<entity_id>。'
      };
      copyText(JSON.stringify(packet, null, 2), '交接包已复制（未发送；服务端记为已导出）');
      var list = await api('handoffs', { entity: node.id });
      ui.handoffs = list.handoffs || [];
      paintInspector();
    } catch (e) {
      setStatus('复制交接包失败：' + String((e && e.message) || e));
    }
  }
  async function appendHandoffMessage(id, text) {
    var value = (text || '').trim();
    if (!value) return;
    try {
      var res = await apiJson('handoff/message', { id: id, text: value });
      ui.handoffs = ui.handoffs.map(function (h) { return h.id === id ? res.handoff : h; });
      paintInspector();
      setStatus('讨论已追加');
    } catch (e) { setStatus('追加失败：' + String((e && e.message) || e)); }
  }

  // --- 持久化 -------------------------------------------------------------
  var saveTimer = null;
  function scheduleSave() {
    ws.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveWorkspace(false); }, 700);
  }
  function snapshot() {
    return {
      schema: 'atlas.explore-workspace.v1',
      analysis: session.analysis,
      layout: ws.layout,
      outline: ws.outline,
      inspectorOpen: ws.inspectorOpen,
      active: ws.active,
      sizes: ws.sizes.slice(),
      favorites: ws.favorites.slice(0, 40),
      areas: ws.areas.map(function (area) {
        return {
          title: area.title,
          activeTab: area.activeTab,
          tabs: area.tabs.map(function (tab) {
            return {
              analysis: tab.analysis,
              entityId: tab.entityId,
              name: tab.name,
              path: tab.path,
              kind: tab.kind,
              view: tab.view,
              expanded: Object.keys(tab.expanded).filter(function (k) { return tab.expanded[k]; }),
              selection: tab.selection ? { analysis: tab.selection.analysis, entityId: tab.selection.entityId } : null,
              scroll: tab.scroll,
              zoom: tab.zoom
            };
          })
        };
      })
    };
  }
  async function saveWorkspace(explicit) {
    if (!session.connected) return;
    try {
      await apiJson('ui-state', { name: UI_STATE_NAME, state: snapshot() }, 'PUT');
      ws.dirty = false;
      if (explicit) setStatus('工作区已保存（按项目隔离，保存了区域、标签、展开、缩放与选区）');
    } catch (e) {
      if (explicit) setStatus('工作区保存失败：' + String((e && e.message) || e));
    }
  }
  async function restoreWorkspace() {
    try {
      var res = await api('ui-state', { name: UI_STATE_NAME });
      var saved = res && res.state;
      if (!saved || !saved.areas || !saved.areas.length) return false;
      ws.layout = saved.layout === 'rows' ? 'rows' : 'columns';
      ws.outline = Boolean(saved.outline);
      ws.inspectorOpen = saved.inspectorOpen !== false;
      ws.sizes = Array.isArray(saved.sizes) ? saved.sizes.slice() : [];
      ws.favorites = Array.isArray(saved.favorites) ? saved.favorites.slice(0, 40) : [];
      ws.areas = saved.areas.map(function (spec) {
        var area = { id: nextId('a'), title: spec.title || '项目地图', tabs: [], activeTab: spec.activeTab || 0, gen: 1, closedTabs: [] };
        area.tabs = (spec.tabs || []).map(function (ts) {
          var tab = newTab({ analysis: ts.analysis, entityId: ts.entityId, name: ts.name, path: ts.path, kind: ts.kind, view: ts.view, scroll: ts.scroll, zoom: ts.zoom });
          (ts.expanded || []).forEach(function (id) { tab.expanded[id] = true; });
          if (ts.selection) tab.pendingSelection = ts.selection;
          if (ts.analysis && ts.analysis !== session.analysis) tab.stale = true;
          return tab;
        });
        if (!area.tabs.length) area.tabs.push(newTab({}));
        if (area.activeTab >= area.tabs.length) area.activeTab = 0;
        return area;
      });
      ws.active = Math.min(Math.max(0, saved.active || 0), ws.areas.length - 1);
      for (var i = 0; i < ws.areas.length; i++) {
        var area = ws.areas[i];
        for (var t = 0; t < area.tabs.length; t++) {
          var tab = area.tabs[t];
          if (tab.stale) continue;
          await ensureTabReady(tab);
          if (tab.pendingSelection && tab.pendingSelection.analysis === session.analysis) {
            try {
              var node = await api('node', { entity: tab.pendingSelection.entityId });
              if (node && node.node) tab.selection = { analysis: session.analysis, entityId: node.node.id, node: toTreeNode(node.node) };
            } catch (e) { /* 版本换了或对象没了：保持未选，不猜 */ }
          }
        }
      }
      var sel = activeSelection();
      if (sel) loadInspectorData(sel.node);
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- 连接 ---------------------------------------------------------------
  function setStatus(text) {
    var s = $('map-status');
    if (s) s.textContent = text || '';
  }
  async function connect(retry) {
    session.token = readToken();
    if (!session.token) {
      session.connected = false;
      session.error = '还没有本机会话令牌。';
      paintAreas();
      return;
    }
    session.loading = true;
    session.error = null;
    paintAreas();
    try {
      var report = await api('report');
      var contract = null;
      try { contract = await api('contract'); } catch (e) { contract = null; }
      var switched = session.analysis && report.id && session.analysis !== report.id;
      session.analysis = report.id;
      session.contract = contract;
      var project = (contract && contract.project) || {};
      session.projectKey = project.key || '';
      session.projectName = String(project.name || (session.projectKey ? session.projectKey.split('/').filter(Boolean).pop() : '') || '本机项目');
      session.connected = true;
      session.loading = false;
      var title = $('map-title');
      if (title) title.textContent = session.projectName;
      var lede = $('map-lede');
      if (lede) lede.textContent = session.projectKey + ' · 代码版本 ' + short(report.id, 12);
      if (switched) {
        // 换了项目或换了版本：按服务端的项目键恢复该项目自己的工作区。
        ws.areas = []; ws.active = 0; ws.sizes = []; ws.closedAreas = []; ws.maximized = null;
      }
      if (!ws.areas.length) {
        var restored = await restoreWorkspace();
        if (!restored) {
          var area = newArea({ entityId: ROOT_ID, kind: 'project', title: '项目地图' });
          ws.areas.push(area);
          ws.active = 0;
          await ensureTabReady(area.tabs[0]);
          selectRoot(area.tabs[0]);
        }
      }
      loadLlmConfig();
      paint();
      setStatus('已连接 · ' + session.projectName + ' · 版本 ' + short(report.id, 8));
    } catch (e) {
      session.loading = false;
      session.connected = false;
      session.error = String((e && e.message) || e);
      paintAreas();
    }
  }
  function selectRoot(tab) {
    if (!tab.root) return;
    tab.selection = { analysis: tab.analysis, entityId: tab.root.id, node: tab.root };
    loadInspectorData(tab.root);
  }

  // --- 启动 ---------------------------------------------------------------
  function bindTools() {
    var layoutBtn = $('map-layout');
    if (layoutBtn) layoutBtn.addEventListener('click', function () {
      ws.layout = ws.layout === 'columns' ? 'rows' : 'columns';
      layoutBtn.textContent = ws.layout === 'columns' ? '▥ 上下分区' : '▥ 左右分区';
      ws.sizes = [];
      paintAreas(); scheduleSave();
    });
    var outlineBtn = $('map-outline-toggle');
    if (outlineBtn) outlineBtn.addEventListener('click', function () {
      ws.outline = !ws.outline;
      outlineBtn.setAttribute('aria-pressed', String(ws.outline));
      if (ws.outline && !outlineState.children[ROOT_ID]) loadOutlineChildren(ROOT_ID);
      paintAreas(); scheduleSave();
    });
    var inspectorBtn = $('map-inspector-toggle');
    if (inspectorBtn) inspectorBtn.addEventListener('click', function () {
      ws.inspectorOpen = !ws.inspectorOpen;
      paintInspector(); scheduleSave();
    });
    var newAreaBtn = $('map-new-area');
    if (newAreaBtn) newAreaBtn.addEventListener('click', function () { createArea(); });
    var saveBtn = $('map-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveWorkspace(true); });
    var search = $('map-search-input');
    if (search) {
      search.addEventListener('input', function () { runSearch(search.value.trim()); });
      search.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { search.value = ''; paintSearch(); }
      });
    }
    document.addEventListener('keydown', function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && String(ev.key).toLowerCase() === 'k') {
        var input = $('map-search-input');
        var section = document.querySelector('.wb-page[data-page="explore"]');
        if (input && section && !section.hidden) { ev.preventDefault(); input.focus(); input.select(); }
      }
    });
    window.addEventListener('hashchange', function () {
      var token = readToken();
      if (token && token !== session.token) { session.token = token; connect(true); }
    });
    // 项目或版本在别处被切换（页面内打开项目 / 应用后重索引）时重新对齐。
    window.addEventListener('focus', function () { recheck(); });
    setInterval(function () { recheck(); }, 15000);
  }
  var recheckBusy = false;
  async function recheck() {
    if (recheckBusy || !session.connected || !session.token) return;
    var section = document.querySelector('.wb-page[data-page="explore"]');
    if (!section || section.hidden) return;
    recheckBusy = true;
    try {
      var report = await api('report');
      if (report && report.id && report.id !== session.analysis) connect(false);
    } catch (e) { /* 服务暂时不可达：保持现有画面，不清空 */ }
    recheckBusy = false;
  }
  function paint() {
    paintRail();
    paintAreas();
    paintInspector();
    applySizes();
  }
  function boot() {
    bindTools();
    var section = document.querySelector('.wb-page[data-page="explore"]');
    if (section) {
      var observer = new MutationObserver(function () {
        if (!section.hidden && !session.connected && !session.loading) connect(false);
      });
      observer.observe(section, { attributes: true, attributeFilter: ['hidden'] });
    }
    paintAreas();
    if (section && !section.hidden) connect(false);
    window.atlasExplore = {
      connect: function () { return connect(true); },
      state: function () { return { analysis: session.analysis, project: session.projectName, areas: ws.areas.length, tabs: ws.areas.reduce(function (n, a) { return n + a.tabs.length; }, 0) }; },
      // 探针用：把当前详情面板的真实状态暴露出来，方便核对“点了之后页面处于什么状态”。
      debug: function () { return { tab: ui.tab, source: ui.source, refs: ui.refs.slice(), draftLength: (ui.draft || '').length, hasKnowledge: Boolean(ui.knowledge), interpretations: (ui.interpretations || []).length, annotations: (ui.annotations || []).length }; }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
