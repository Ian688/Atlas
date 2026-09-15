#!/usr/bin/env node
/* 真实浏览器探针：用 CDP 驱动本机 Chrome，点击真实页面并断言看到了什么。
 *
 * 这个文件不是 DOM 单元测试：它启动一个真的浏览器、真的加载最终页面、真的
 * 用鼠标点节点，并把每一步的可见文本与截图留下。DOM 断言只用来确认"页面上
 * 真的出现了这个东西"，不能代替点击本身。
 *
 * 无第三方依赖：Node 自带 WebSocket 与 fetch。
 *
 * 用法：
 *   node scripts/probe_explore.mjs --url 'http://127.0.0.1:PORT/#token=...' \
 *        --out evidence/development/<dir>/shots [--steps m1|m2|all]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = 'true';
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.session = null; this.logs = []; }
  static async launch(port, profile) {
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1600,1000',
      'about:blank',
    ], { stdio: 'ignore' });
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        version = await res.json();
        break;
      } catch (e) { /* 还没起来 */ }
    }
    if (!version) { child.kill('SIGKILL'); throw new Error('chrome did not expose a devtools port'); }
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const browser = new Browser(ws);
    browser.child = child;
    ws.addEventListener('message', (event) => browser.onMessage(event));
    return browser;
  }
  onMessage(event) {
    const msg = JSON.parse(String(event.data));
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || 'cdp error'} ${JSON.stringify(msg.error.data || '')}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.args) {
      this.logs.push(msg.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      this.logs.push('EXCEPTION: ' + String((msg.params.exceptionDetails.exception?.description) || msg.params.exceptionDetails.text || ''));
    }
  }
  send(method, params = {}) {
    const id = (this.id += 1);
    const payload = { id, method, params };
    if (this.session) payload.sessionId = this.session;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 20000);
    });
  }
  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.session = sessionId;
    this.targetId = targetId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    const loaded = new Promise((resolve) => {
      const handler = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.method === 'Page.loadEventFired') { this.ws.removeEventListener('message', handler); resolve(); }
      };
      this.ws.addEventListener('message', handler);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(1200);
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error('page error: ' + String(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    return res.result.value;
  }
  async waitFor(expression, timeout = 12000, label = expression) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await this.evaluate(expression).catch(() => null);
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`waitFor timeout: ${label}`);
  }
  async rect(selector) {
    return this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width && !r.height) return null; return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  }
  async click(selector, options = {}) {
    const point = options.point || (await this.rect(selector));
    if (!point) throw new Error(`no element to click: ${selector}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(options.wait ?? 450);
  }
  async dblclick(selector) {
    const point = await this.rect(selector);
    if (!point) throw new Error(`no element to dblclick: ${selector}`);
    for (let i = 0; i < 2; i += 1) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: i + 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: i + 1 });
    }
    await sleep(700);
  }
  async type(selector, text) {
    // 刷新后浏览器会回填上次输入的值，真实用户会先全选再输入，探针也一样。
    await this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e) { e.focus(); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await this.send('Input.insertText', { text });
    await sleep(600);
  }
  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(res.data, 'base64'));
  }
  async close() {
    try { if (this.session) await this.send('Target.closeTarget', { targetId: this.targetId }); } catch (e) { /* ignore */ }
    try { this.ws.close(); } catch (e) { /* ignore */ }
    if (this.child) this.child.kill('SIGKILL');
  }
}

// --- 断言 ------------------------------------------------------------------
const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail: detail || '' });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const url = args.url;
  const outDir = args.out || '.tmp-accept/shots';
  const port = Number(args.port || 9333);
  const profile = path.join(tmpdir(), `atlas-probe-${Date.now()}`);
  if (!url) { console.error('--url 是必需参数'); process.exit(2); }
  mkdirSync(outDir, { recursive: true });
  const browser = await Browser.launch(port, profile);
  let shots = 0;
  const shot = async (name) => { shots += 1; const file = path.join(outDir, `${String(shots).padStart(2, '0')}-${name}.png`); await browser.shot(file); return file; };
  try {
    // 每次探针都从干净的工作区开始：服务端那份按项目保存的布局会让上一轮的
    // 展开状态回来（这是要验收的能力），但它会掩盖"首次打开看到什么"。清空
    // 在浏览器启动之前做，否则页面自己的自动保存会把刚清掉的状态又写回去。
    const token = decodeURIComponent(String(url).replace(/^.*#token=/, '').split('&')[0] || '');
    const origin = String(url).replace(/#.*$/, '').replace(/\/$/, '');
    if (token) {
      const res = await fetch(`${origin}/api/ui-state`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'explore-map', state: { schema: 'atlas.explore-workspace.v1', areas: [] } })
      });
      if (!res.ok) console.log(`   警告：工作区清空失败 (${res.status})，下面看到的可能是上次保存的状态`);
    }
    await browser.open(url);
    // 上一次会话可能停在别的页面（app.js 会记住当前页），真实用户会点左栏
    // 「探索代码」回到这一页；不点的话地图在隐藏的 section 里，量不到尺寸。
    await browser.evaluate('(() => { const b = document.querySelector(\'.nav-button[data-go="explore"]\'); if (b) b.click(); })()');
    await browser.waitFor('(() => { const s = document.querySelector(\'.wb-page[data-page="explore"]\'); return s && !s.hidden && document.querySelectorAll(".mnode").length > 0; })()', 15000, '探索页可见且地图画出了节点');
    await shot('root-map');

    // 1. 根节点是真实项目名，首层成员来自真实包含结构
    const rootName = await browser.evaluate('(() => { const n = document.querySelector(".mnode .mnode-name"); return n ? n.textContent : null; })()');
    const firstLevel = await browser.evaluate('Array.from(document.querySelectorAll(".mnode .mnode-name")).map((n) => n.textContent).slice(0, 12)');
    check('根节点是真实项目名（A）', rootName === 'A', `root=${rootName} first=${firstLevel.join(', ')}`);
    check('首层成员包含真实目录与文件', firstLevel.some((t) => t.startsWith('src/')) && firstLevel.some((t) => t.includes('README.md')), firstLevel.join(', '));

    // 2. 逐层展开：src → pricing → money.ts → 函数
    // 展开后节点可能落到画布可视区之外：真实用户会点「适应画布」把它带回来，
    // 探针也这么点，而不是直接派发一个 DOM 事件假装点到。
    const fitView = async () => {
      await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".area-btn")).find((x) => x.textContent === "适应画布"); if (b) b.click(); })()');
      await sleep(600);
    };
    const clickNode = async (name) => {
      await fitView();
      const point = await browser.evaluate(`(() => {
        const cards = Array.from(document.querySelectorAll('.mnode'));
        const target = cards.find((c) => (c.querySelector('.mnode-name')||{}).textContent === ${JSON.stringify(name)});
        if (!target) return null;
        const btn = target.querySelector('.mnode-toggle');
        const r = (btn || target).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error(`节点不在地图上：${name}`);
      await browser.click('.map-canvas', { point, wait: 900 });
    };
    await clickNode('src/');
    await browser.waitFor('Array.from(document.querySelectorAll(".mnode .mnode-name")).some((n) => n.textContent === "pricing/")', 10000, 'src 展开后出现 pricing');
    await clickNode('pricing/');
    await browser.waitFor('Array.from(document.querySelectorAll(".mnode .mnode-name")).some((n) => n.textContent.indexOf("money.ts") >= 0)', 10000, 'pricing 里出现 money.ts');
    await clickNode('money.ts');
    await browser.waitFor('Array.from(document.querySelectorAll(".mnode .mnode-name")).some((n) => n.textContent.indexOf("charge()") >= 0)', 10000, 'money.ts 的函数被加载');
    const deep = await browser.evaluate('Array.from(document.querySelectorAll(".mnode .mnode-name")).map((n) => n.textContent)');
    check('至少三层目录后到达真实函数', deep.some((t) => t.indexOf('charge()') >= 0) && deep.some((t) => t.indexOf('clampRate()') >= 0), deep.join(', '));
    await shot('three-levels');

    // 3. 单击函数 → 右侧详情显示真实算法摘要
    await fitView();
    const fnPoint = await browser.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.mnode'));
      const target = cards.find((c) => (c.querySelector('.mnode-name')||{}).textContent.indexOf('charge()') >= 0);
      const r = target.querySelector('.mnode-main').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await browser.click('.map-canvas', { point: fnPoint, wait: 900 });
    const title = await browser.evaluate('(() => { const e = document.querySelector(".inspector-title"); return e ? e.textContent : null; })()');
    check('单击节点把详情切到该节点', title && title.indexOf('charge') >= 0, `inspector=${title}`);
    await browser.waitFor('document.querySelectorAll(".fact-row").length > 0', 12000, '算法摘要渲染出事实行');
    const facts = await browser.evaluate('Array.from(document.querySelectorAll(".fact-row")).map((r) => (r.querySelector(".fact-label")||{}).textContent + "=" + (r.querySelector(".fact-text")||{}).textContent).slice(0, 6)');
    check('Atlas 摘要有真实内容（不是空态/JSON）', facts.length > 0 && facts.join(' ').length > 40, facts.join(' | '));
    await shot('inspector-summary');

    // 4. 源码注释来源：有注释的节点显示原文与出处
    await browser.evaluate('(() => { const tabs = Array.from(document.querySelectorAll(".source-tab")); const t = tabs.find((b) => b.textContent.indexOf("代码注释") >= 0); if (t) t.click(); })()');
    await sleep(600);
    const comments = await browser.evaluate('Array.from(document.querySelectorAll(".comment-card")).map((c) => (c.querySelector(".comment-loc")||{}).textContent + " " + (c.querySelector(".comment-text")||{}).textContent.slice(0, 40))');
    check('源码注释显示原文与文件行号', comments.length > 0 && /money\.ts:\d+/.test(comments.join(' ')), comments.join(' | '));
    await shot('inspector-comments');

    // 5. 解析记录：引用来源 → 手动修改 → 保存 → 历史可读
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".ref-chip")).find((x) => x.textContent.indexOf("引用源码注释") >= 0); if (b) b.click(); })()');
    await sleep(300);
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".record-refs .wb-retry")).find((x) => x.textContent.indexOf("放进编辑区") >= 0); if (b) b.click(); })()');
    await sleep(500);
    console.log('   面板状态：' + JSON.stringify(await browser.evaluate('window.atlasExplore ? window.atlasExplore.debug() : null')));
    const draftLen = await browser.evaluate('(() => { const t = document.querySelector(".record-input"); return t ? t.value.length : 0; })()');
    check('引用来源后编辑区有真实文字', draftLen > 20, `draft=${draftLen} 字符`);
    await browser.evaluate(`(() => {
      const t = document.querySelector('.record-input');
      t.value = t.value + '\\n【探针补写】这个函数按整数分值计算，避免浮点误差。';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      const b = Array.from(document.querySelectorAll('.record .wb-primary')).find((x) => x.textContent.indexOf('保存') >= 0);
      if (b) b.click();
    })()`);
    await sleep(1400);
    console.log('   保存后：' + JSON.stringify(await browser.evaluate('window.atlasExplore ? window.atlasExplore.debug() : null'))
      + ' note=' + await browser.evaluate('(() => { const e = document.querySelector(".record-note"); return e ? e.textContent : ""; })()'));
    // 保存成功后页面自己就展开历史；只有没展开时才点开关（否则这一下会收起它）。
    await browser.evaluate('(() => { if (document.querySelector(".history-card")) return; const b = Array.from(document.querySelectorAll(".record .wb-retry")).find((x) => x.textContent.indexOf("历史修订") >= 0); if (b) b.click(); })()');
    await sleep(700);
    const history = await browser.evaluate('Array.from(document.querySelectorAll(".history-card")).map((c) => (c.querySelector(".history-body")||{}).textContent || "").slice(0, 3)');
    check('解析记录保存后有历史修订（含补写文字）', history.some((t) => t.indexOf('探针补写') >= 0), `history=${history.length} 条`);
    await shot('interpretation-saved');

    // 6. 搜索一个未加载的节点并定位
    await browser.type('#map-search-input', 'clampRate');
    await browser.waitFor('document.querySelectorAll(".search-item").length > 0', 10000, '搜索有命中');
    const hits = await browser.evaluate('Array.from(document.querySelectorAll(".search-item")).map((s) => s.textContent)');
    check('全项目搜索找到节点并保留路径', hits.length > 0 && hits.join(' ').indexOf('money.ts') >= 0, hits.join(' | '));
    await shot('search-hit');
    await browser.click('.search-item');
    await sleep(1200);
    const afterSearch = await browser.evaluate('(() => { const e = document.querySelector(".inspector-title"); return e ? e.textContent : ""; })()');
    check('打开搜索结果后详情是同一个节点', afterSearch.indexOf('clampRate') >= 0, `inspector=${afterSearch}`);

    // 7. 内容视图读到真实源码字节
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".view-btn")).find((x) => x.textContent === "内容"); if (b) b.click(); })()');
    await browser.waitFor('(document.querySelector(".source-code")||{}).textContent && document.querySelector(".source-code").textContent.length > 10', 12000, '内容视图读到了源码');
    const source = await browser.evaluate('(() => { const e = document.querySelector(".source-code"); return e ? e.textContent : ""; })()');
    check('内容视图显示真实源码（含函数体）', source.indexOf('function') >= 0 || source.indexOf('=>') >= 0, source.slice(0, 60).replace(/\n/g, ' '));
    await shot('content-source');

    // ===== M2 多展示区与多标签 ============================================
    const counts = () => browser.evaluate('({ areas: document.querySelectorAll(".map-area").length, tabs: document.querySelectorAll(".area-tab").length })');
    const areaRoots = () => browser.evaluate('Array.from(document.querySelectorAll(".map-area")).map((a) => { const n = a.querySelector(".mnode .mnode-name"); return n ? n.textContent : ""; })');
    const cardNames = (areaIndex) => browser.evaluate(`(() => { const a = document.querySelectorAll(".map-area")[${areaIndex}]; return a ? Array.from(a.querySelectorAll(".mnode .mnode-name")).map((n) => n.textContent) : []; })()`);

    // 回到地图视图，准备多区域操作
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".view-btn")).find((x) => x.textContent === "地图"); if (b) b.click(); })()');
    await sleep(600);

    // 1. 目录节点菜单 → 在新展示区域打开：原区域保留，新区域以该目录为根
    const openMenuOn = async (name) => {
      await fitView();
      const point = await browser.evaluate(`(() => {
        const cards = Array.from(document.querySelectorAll('.mnode'));
        const target = cards.find((c) => (c.querySelector('.mnode-name')||{}).textContent === ${JSON.stringify(name)});
        if (!target) return null;
        const r = target.querySelector('.mnode-menu').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error(`菜单节点不在地图上：${name}`);
      await browser.click('.map-canvas', { point, wait: 500 });
    };
    await openMenuOn('pricing/');
    const menuItems = await browser.evaluate('Array.from(document.querySelectorAll(".map-menu-item")).map((b) => b.textContent)');
    check('节点菜单按目录类型给出动作', menuItems.some((t) => t.indexOf('聚焦这个子树') >= 0) && menuItems.some((t) => t.indexOf('搜索这个目录') >= 0), menuItems.slice(0, 8).join(' | '));
    await shot('node-menu');
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".map-menu-item")).find((x) => x.textContent.indexOf("在新展示区域打开") >= 0); if (b) b.click(); })()');
    await sleep(1500);
    const afterNewArea = await counts();
    const roots = await areaRoots();
    check('在新展示区域打开：两个区域并存且各有自己的根', afterNewArea.areas === 2 && roots[1] === 'pricing/', `areas=${afterNewArea.areas} roots=${roots.join(' , ')}`);
    await shot('two-areas');

    // 2. 新区域默认展开自己的根；折叠/展开只影响这一棵树，另一个区域不动
    const area2Open = await cardNames(1);
    await browser.evaluate('(() => { const a = document.querySelectorAll(".map-area")[1]; const t = a.querySelector(".mnode-toggle"); if (t) t.click(); })()');
    await sleep(700);
    const area2Closed = await cardNames(1);
    await browser.evaluate('(() => { const a = document.querySelectorAll(".map-area")[1]; const t = a.querySelector(".mnode-toggle"); if (t) t.click(); })()');
    await sleep(1000);
    const area2Reopen = await cardNames(1);
    const area1Names = await cardNames(0);
    check('区域 2 展开自己的树，区域 1 内容不变',
      area2Open.some((t) => t.indexOf('money.ts') >= 0) && area2Closed.length === 1 && area2Reopen.length === area2Open.length && area1Names.indexOf('A') === 0,
      `area2 展开=${area2Open.length} 折叠=${area2Closed.length} 再展开=${area2Reopen.length} | area1=${area1Names.slice(0, 5).join(',')}`);

    // 3. 双击节点在当前区新建标签；同节点同版本不会重复建
    await fitView();
    const dblPoint = await browser.evaluate(`(() => {
      const a = document.querySelectorAll(".map-area")[1];
      const cards = Array.from(a.querySelectorAll('.mnode'));
      const target = cards.find((c) => (c.querySelector('.mnode-name')||{}).textContent.indexOf('money.ts') >= 0);
      if (!target) return null;
      const r = target.querySelector('.mnode-main').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (dblPoint) {
      for (let i = 0; i < 2; i += 1) {
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblPoint.x, y: dblPoint.y, button: 'left', clickCount: i + 1 });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblPoint.x, y: dblPoint.y, button: 'left', clickCount: i + 1 });
      }
      await sleep(1200);
    }
    const afterDbl = await counts();
    const area2Tabs = await browser.evaluate('document.querySelectorAll(".map-area")[1].querySelectorAll(".area-tab").length');
    check('双击节点在当前区新建标签', area2Tabs >= 2, `area2 tabs=${area2Tabs} 总标签=${afterDbl.tabs}`);

    // 4. 关闭标签 → 恢复刚关闭
    await browser.evaluate('(() => { const a = document.querySelectorAll(".map-area")[1]; const btns = a.querySelectorAll(".area-tab-close"); if (btns.length) btns[btns.length - 1].click(); })()');
    await sleep(700);
    const afterClose = await browser.evaluate('document.querySelectorAll(".map-area")[1].querySelectorAll(".area-tab").length');
    await browser.evaluate('(() => { const a = document.querySelectorAll(".map-area")[1]; const b = Array.from(a.querySelectorAll(".area-btn")).find((x) => x.textContent.indexOf("恢复刚关闭") >= 0); if (b) b.click(); })()');
    await sleep(900);
    const afterRestore = await browser.evaluate('document.querySelectorAll(".map-area")[1].querySelectorAll(".area-tab").length');
    check('关闭标签后可以恢复刚关闭的标签', afterClose === afterRestore - 1, `关闭后=${afterClose} 恢复后=${afterRestore}`);

    // 5. 布局切换与拖动分隔线
    await browser.evaluate('(() => { const b = document.getElementById("map-layout"); if (b) b.click(); })()');
    await sleep(700);
    const layout = await browser.evaluate('document.getElementById("map-groups").className');
    check('布局切换到上下分区', layout.indexOf('is-rows') >= 0, layout);
    await browser.evaluate('(() => { const b = document.getElementById("map-layout"); if (b) b.click(); })()');
    await sleep(700);
    const before = await browser.evaluate('Array.from(document.querySelectorAll(".map-area")).map((a) => a.style.flex)');
    const divider = await browser.rect('.map-divider');
    if (divider) {
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: divider.x, y: divider.y, button: 'left', clickCount: 1 });
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider.x - 120, y: divider.y, button: 'left' });
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: divider.x - 120, y: divider.y, button: 'left', clickCount: 1 });
      await sleep(600);
    }
    const after = await browser.evaluate('Array.from(document.querySelectorAll(".map-area")).map((a) => a.style.flex)');
    check('拖动分隔线真的改变了两个区域的大小', before.join('|') !== after.join('|'), `${before.join(' , ')} → ${after.join(' , ')}`);

    // 6. 最大化与还原
    await browser.evaluate('(() => { const a = document.querySelectorAll(".map-area")[1]; const b = Array.from(a.querySelectorAll(".area-btn")).find((x) => x.textContent === "⤢"); if (b) b.click(); })()');
    await sleep(700);
    const maxCount = await browser.evaluate('document.querySelectorAll(".map-area").length');
    await browser.evaluate('(() => { const a = document.querySelector(".map-area"); const b = Array.from(a.querySelectorAll(".area-btn")).find((x) => x.textContent === "⤡"); if (b) b.click(); })()');
    await sleep(700);
    const restoreCount = await browser.evaluate('document.querySelectorAll(".map-area").length');
    check('最大化只显示一个区域，还原后都回来', maxCount === 1 && restoreCount === 2, `最大化=${maxCount} 还原=${restoreCount}`);

    // 7. 保存工作区 → 真正重新加载页面（不是改 fragment）后恢复
    const beforeReload = await counts();
    const beforeRoots = await areaRoots();
    await browser.evaluate('(() => { const b = document.getElementById("map-save"); if (b) b.click(); })()');
    await sleep(900);
    await browser.send('Page.navigate', { url });
    await sleep(2500);
    await browser.waitFor('document.querySelectorAll(".map-area").length > 0', 15000, '刷新后展示区恢复');
    const afterReload = await counts();
    const restoredRoots = await areaRoots();
    check('保存后真正刷新页面：区域与标签按项目恢复',
      afterReload.areas === beforeReload.areas && afterReload.tabs === beforeReload.tabs && restoredRoots.join('|') === beforeRoots.join('|'),
      `刷新前 areas=${beforeReload.areas} tabs=${beforeReload.tabs} roots=${beforeRoots.join(' , ')} → 刷新后 areas=${afterReload.areas} tabs=${afterReload.tabs} roots=${restoredRoots.join(' , ')}`);
    await shot('after-reload');

    // ===== M3 批注、关注与跨版本记录 ======================================
    // 选中 charge()：搜索定位到它，保证后面每一步都锚在同一个对象上。
    await browser.type('#map-search-input', 'charge');
    await sleep(1200);
    console.log('   搜索状态：' + JSON.stringify(await browser.evaluate('({ value: (document.getElementById("map-search-input")||{}).value, hidden: (document.getElementById("map-search-panel")||{}).hidden, text: ((document.getElementById("map-search-panel")||{}).textContent || "").slice(0, 120), items: document.querySelectorAll(".search-item").length })')));
    await browser.waitFor('document.querySelectorAll(".search-item").length > 0', 10000, '搜索命中 charge');
    await browser.click('.search-item');
    await sleep(1400);
    const selTitle = await browser.evaluate('(() => { const e = document.querySelector(".inspector-title"); return e ? e.textContent : ""; })()');
    check('搜索后详情锚定到 charge()', selTitle.indexOf('charge') >= 0, selTitle);

    // 批注
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".inspector-tab")).find((x) => x.textContent === "批注"); if (b) b.click(); })()');
    await sleep(500);
    await browser.type('.note-input', '探针批注：折扣率必须先经 clampRate，越界输入要在这里说清楚。');
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".inspector-body .wb-primary")).find((x) => x.textContent.indexOf("保存批注") >= 0); if (b) b.click(); })()');
    await sleep(1200);
    const notes = await browser.evaluate('Array.from(document.querySelectorAll(".note-card")).map((c) => (c.querySelector(".note-body")||{}).textContent || "")');
    check('批注保存到节点并可读回', notes.some((t) => t.indexOf('探针批注') >= 0), `批注 ${notes.length} 条`);
    await shot('annotation-saved');

    // 关注（点菜单会切换当前激活区域，所以之后要重新选中目标节点）
    await fitView();
    await openMenuOn('pricing/');
    const favMenu = await browser.evaluate('Array.from(document.querySelectorAll(".map-menu-item")).map((b) => b.textContent)');
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".map-menu-item")).find((x) => x.textContent.indexOf("关注这个节点") >= 0); if (b) b.click(); })()');
    await sleep(800);
    const favs = await browser.evaluate('Array.from(document.querySelectorAll("#rail-favorites .rail-item-name")).map((n) => n.textContent)');
    check('关注节点出现在左栏关注列表', favs.some((t) => t.indexOf('pricing') >= 0), `菜单=${favMenu.length} 项 关注列表=${favs.join(' , ') || '空'}`);

    // ===== M4 交接、外部 Agent 与运行入口 ==================================
    // 交接：保存草稿（不发送），复制记为已导出而不是已发送
    const selectBySearch = async (name) => {
      await browser.type('#map-search-input', name);
      await browser.waitFor('document.querySelectorAll(".search-item").length > 0', 10000, `搜索命中 ${name}`);
      await browser.click('.search-item');
      await sleep(1400);
    };
    await selectBySearch('charge');
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".inspector-tab")).find((x) => x.textContent === "交接"); if (b) b.click(); })()');
    await sleep(500);
    await browser.type('.handoff-goal', '解释 charge 的取整与折扣边界，并指出可能越界的输入。');
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".inspector-body .wb-primary")).find((x) => x.textContent.indexOf("保存草稿") >= 0); if (b) b.click(); })()');
    await sleep(1300);
    const handoffState = await browser.evaluate('Array.from(document.querySelectorAll(".handoff-card")).map((c) => (c.querySelector(".handoff-head")||{}).textContent || "")');
    check('交接草稿保存后有身份与状态（draft，不是已发送）', handoffState.length > 0 && handoffState.join(' ').indexOf('draft') >= 0, handoffState.join(' | '));
    await shot('handoff-draft');

    // 外部 Agent：只通过公开 HTTP 接口读范围、登记讨论并提交提案
    const agent = {
      async api(name, params) {
        const query = new URLSearchParams(params || {});
        const res = await fetch(`${origin}/api/${name}?${query}`, { headers: { Authorization: `Bearer ${token}` } });
        return res.json();
      },
      async post(name, body) {
        const res = await fetch(`${origin}/api/${name}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
        });
        return res.json();
      }
    };
    const contract = await agent.api('contract');
    const endpointNames = (contract.endpoints || []).map((e) => e.name);
    check('公开接口清单里有本轮用到的接口', ['tree', 'knowledge', 'handoffs', 'patch/propose', 'context'].every((n) => endpointNames.includes(n)), endpointNames.slice(0, 12).join(','));
    const handoffs = await agent.api('handoffs', { entity: 'src/pricing/money.ts:charge' });
    const handoff = (handoffs.handoffs || [])[0];
    check('外部 Agent 能读到同一条交接（持久身份）', Boolean(handoff && handoff.id), handoff ? `${handoff.id.slice(0, 12)} · ${handoff.state}` : 'none');
    if (handoff) {
      await agent.post('handoff/message', { id: handoff.id, text: '外部 Agent：先读 clampRate 的边界，再给 charge 的取整结论。' });
      const source = await agent.api('source', { entity: 'src/pricing/money.ts:charge' });
      const diff = ['--- a/src/pricing/money.ts', '+++ b/src/pricing/money.ts', '@@ -1,3 +1,4 @@', ' // 金额计算：以整数分值运算，避免浮点误差。', '+// Agent 提案：为 charge 补一句边界说明，说明 rate 必须先被 clampRate 收敛。', ' export function charge(amount: number, rate: number): number {', '   return Math.round(amount * (1 - rate));', ' }'].join('\n') + '\n';
      const proposed = await agent.post('patch/propose', { entity: 'src/pricing/money.ts:charge', diff, note: '外部 Agent 依据交接提交的提案' });
      const proposalId = proposed && proposed.proposal && proposed.proposal.id;
      check('外部 Agent 通过公开接口提交真实提案', Boolean(proposalId), proposalId ? proposalId.slice(0, 12) : JSON.stringify(proposed).slice(0, 120));
      if (proposalId) {
        const linked = await agent.post('handoff/proposal', { id: handoff.id, proposal_id: proposalId });
        check('提案与交接关联到同一个 proposalId', Boolean(linked && linked.handoff && linked.handoff.proposal_id === proposalId), linked && linked.handoff ? linked.handoff.proposal_id.slice(0, 12) : 'none');
        // 页面重新读取：重新选中同一节点（重新读服务端），交接卡片上应能看到关联提案
        await selectBySearch('charge');
        await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".inspector-tab")).find((x) => x.textContent === "交接"); if (b) b.click(); })()');
        await sleep(1200);
        const linkedOnPage = await browser.evaluate('Array.from(document.querySelectorAll(".handoff-link")).map((e) => e.textContent)');
        check('页面显示同一提案的关联', linkedOnPage.some((t) => t.indexOf(proposalId.slice(0, 12)) >= 0), linkedOnPage.join(' | '));
        await shot('handoff-linked-proposal');
      }
      check('外部 Agent 读到的源码是真实字节', Boolean(source && source.content && source.content.indexOf('charge') >= 0), source ? source.content.slice(0, 50).replace(/\n/g, ' ') : 'none');
    }

    // 运行入口：带着同一个对象去运行验证页
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".inspector-tab")).find((x) => x.textContent === "操作"); if (b) b.click(); })()');
    await sleep(500);
    await browser.evaluate('(() => { const b = Array.from(document.querySelectorAll(".action-item")).find((x) => x.textContent.indexOf("带这个对象去运行验证") >= 0); if (b) b.click(); })()');
    await sleep(2500);
    const runPage = await browser.evaluate('(() => { const s = document.querySelector(".wb-page[data-page=\'run\']"); return { visible: s ? !s.hidden : false, title: (document.getElementById("selection-name")||{}).textContent || "" }; })()');
    check('从节点进入运行页且目标就是同一个对象', runPage.visible && runPage.title.indexOf('charge') >= 0, JSON.stringify(runPage));
    await shot('run-page-from-node');
  } catch (error) {
    check('探针执行完成', false, String((error && error.message) || error));
  } finally {
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} 浏览器探针通过`);
    if (browser.logs.length) console.log('控制台：\n' + browser.logs.slice(-12).map((l) => '  ' + l).join('\n'));
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }
}

main();
