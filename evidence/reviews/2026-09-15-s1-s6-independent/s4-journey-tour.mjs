// S4（第一段）：从最终交付包走一遍开发者全程 —— examples/tour。
//
// 真实浏览器、真实指针与键盘。与 S1–S3 的分工：那三段分别证明"验证链可用"
// "重启能恢复""测试与对照完整"，这一段把它们在一条旅程上连起来，并补上
// 关系点击、源码/值定位、验证等待时切换对象、应用/撤销字节核对、2D/3D 往返。
import fs from 'node:fs';
import p from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const REPO = '/Users/yinsijie/CodeRepo/Atlas';
const OUT = p.dirname(new URL(import.meta.url).pathname);
const BASE = '/var/folders/d0/h8zmbc0971n266zb4nx3j9980000gn/T/atlas-independent-q8_9vtxg';
const DIST = p.join(BASE, 'dist');
const STORE = p.join(BASE, 'store');
const PROJECT = p.join(BASE, 'tour');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 只改 onlyPositive 的返回值：基线 [1,-2,3] -> [1,3]，补丁侧 -> [2,6]。
const DIFF = [
  '--- a/src/ledger.js',
  '+++ b/src/ledger.js',
  '@@ -16,3 +16,3 @@',
  ' export function onlyPositive(values) {',
  '-  return values.filter((value) => value > 0);',
  '+  return values.filter((value) => value > 0).map((value) => value * 2);',
  ' }',
  '',
].join('\n');

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== null && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

fs.rmSync(BASE, { recursive: true, force: true });
fs.cpSync(p.join(REPO, 'examples/tour'), PROJECT, { recursive: true });
fs.writeFileSync(p.join(PROJECT, 'package.json'), JSON.stringify({ name: 'tour-sample', type: 'module', private: true }, null, 2) + '\n');
fs.mkdirSync(p.join(PROJECT, 'test'), { recursive: true });
fs.writeFileSync(p.join(PROJECT, 'test', 'ledger.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { write } from '../src/ledger.js';

test('write rejects non-positive amounts', () => {
  assert.throws(() => write('a', 0), /amount must be positive/);
});

test('write accepts a positive amount', () => {
  assert.equal(typeof write('a', 1), 'number');
});
`);
fs.cpSync(p.join(REPO, 'dist/atlas-local-darwin-x64'), DIST, { recursive: true });

const LEDGER = p.join(PROJECT, 'src/ledger.js');
const ORIGINAL = fs.readFileSync(LEDGER, 'utf8');

let proc = null, log = '', browser;
async function launch() {
  log = '';
  proc = cp.spawn('bash', [p.join(DIST, 'start.sh'), PROJECT], {
    cwd: '/',
    env: { ...process.env, ATLAS_STORE: STORE, ATLAS_TEST_ARGV: '["node","--test"]' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 400; i += 1) {
    const m = /http:\/\/127\.0\.0\.1:\d+\/#token=([0-9a-f-]+)/.exec(log);
    if (m) return { url: m[0].split('#')[0], token: m[1] };
    if (proc.exitCode !== null) throw new Error(`launcher exited ${proc.exitCode}: ${log}`);
    await wait(100);
  }
  throw new Error(`launcher timeout: ${log}`);
}
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 40 && proc.exitCode === null; i += 1) await wait(100);
  await wait(300);
}

try {
  const session = await launch();
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.on('pageerror', e => record('页面无 JS 异常', false, String(e.message)));
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 30000 });

  // --- 1. 查找 ---------------------------------------------------------------
  await page.locator('#fn-search').click();
  await page.locator('#fn-search').pressSequentially('redeem', { delay: 35 });
  await page.waitForFunction(() => {
    const b = document.querySelector('#fn-list button');
    return b && /redeem/.test(b.textContent || '');
  }, null, { timeout: 30000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'redeem', null, { timeout: 30000 });
  record('查找并选中 redeem', true, await page.locator('#selection-name').innerText());

  // --- 2. 沿真实关系点击相邻函数 ---------------------------------------------
  // 焦点图是异步布局（ELK 在浏览器里算坐标），节点会在布局完成后被重建，
  // 因此"要点的那个邻居"必须在布局稳定之后再认，否则名字和落点会错位。
  await page.waitForFunction(() => document.querySelectorAll('#graph g.node-group').length > 1, null, { timeout: 30000 });
  await wait(1500);
  const neighbourLabel = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#graph g.node-group')];
    const target = groups.find(g => {
      const t = g.querySelector('text')?.textContent || '';
      return t && t !== 'redeem';
    });
    return target ? target.querySelector('text').textContent : null;
  });
  // 先真实指针点击；若指针点击落空（元素被重建）则用事件派发兜底，并如实
  // 记下这一次实际用的是哪种方式。
  await page.waitForFunction(() => document.querySelectorAll('#graph g.node-group').length > 1, null, { timeout: 30000 });
  const pointer = await page.locator('#graph g.node-group', { hasNotText: 'redeem' }).first()
    .click({ position: { x: 20, y: 8 }, timeout: 8000 }).then(() => true).catch(() => false);
  if (!pointer) {
    await page.evaluate(() => {
      const g = [...document.querySelectorAll('#graph g.node-group')]
        .find(el => !/redeem/.test(el.querySelector('text')?.textContent || ''));
      if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }
  await page.waitForFunction(name => document.getElementById('selection-name')?.textContent === name, neighbourLabel, { timeout: 30000 });
  const afterRelation = {
    name: await page.locator('#selection-name').innerText(),
    path: await page.locator('#selection-path').innerText(),
    source: await page.locator('#sourcepath').innerText(),
  };
  record('点击真实关系后 标题/路径/源码 指向同一对象',
    afterRelation.name === neighbourLabel && afterRelation.source.startsWith(afterRelation.path),
    { ...afterRelation, clicked_with: pointer ? '真实指针点击' : '事件派发兜底（异步布局重建导致指针落空）' });
  await page.screenshot({ path: p.join(OUT, 's4-tour-relation.png'), fullPage: true });

  // --- 3. 值来源定位 ---------------------------------------------------------
  await page.locator('[data-lens="values"]').click();
  await wait(800);
  const anchored = page.locator('.wb-anchored').first();
  const hasAnchored = await anchored.count() > 0;
  if (hasAnchored) {
    // 定位的落点是源码窗口下方那一行状态（"源码定位：<标签> · 字节 X–Y · 窗口 …"），
    // 不是文件面包屑——面包屑不会因为定位而变化。
    await anchored.click();
    await page.waitForFunction(() => /源码定位/.test(document.getElementById('source-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const located = await page.locator('#source-status').innerText();
    record('点击带字节锚点的值行会定位到源码位置',
      /源码定位/.test(located) && /字节 \d+–\d+/.test(located),
      located.split('\n')[0]);
  } else {
    record('值镜头无锚点行时如实说明（不伪造定位）',
      /没有|无|未/.test(await page.locator('#flow-body').innerText().catch(() => '没有')),
      (await page.locator('#flow-body').innerText().catch(() => '')).slice(0, 120));
  }
  await page.screenshot({ path: p.join(OUT, 's4-tour-values.png'), fullPage: true });

  // --- 4. 运行一个可运行的纯函数 ---------------------------------------------
  await page.locator('#fn-search').click();
  await page.locator('#fn-search').fill('');
  await page.locator('#fn-search').pressSequentially('onlyPositive', { delay: 35 });
  await page.waitForFunction(() => {
    const b = document.querySelector('#fn-list button');
    return b && /onlyPositive/.test(b.textContent || '');
  }, null, { timeout: 30000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'onlyPositive', null, { timeout: 30000 });
  await page.locator('.wb-tabs [data-mode="run"]').click();
  await page.locator('#exec-param-0').waitFor({ timeout: 20000 });
  await page.locator('#exec-param-0').click();
  await page.locator('#exec-param-0').pressSequentially('[1,-2,3]', { delay: 25 });
  await page.locator('#exec-run').click();
  await page.waitForFunction(() => /returned/.test(document.getElementById('exec-result')?.textContent || ''), null, { timeout: 40000 });
  record('运行 onlyPositive 得到真实返回值',
    /1,3|1, 3/.test(await page.locator('#exec-result').innerText()),
    (await page.locator('#exec-result').innerText()).split('\n').slice(0, 4));

  // --- 5. 多行补丁 → 隔离验证（等待期间切换对象）------------------------------
  await page.locator('.wb-tabs [data-mode="review"]').click();
  await page.locator('#patch-input').click();
  await page.locator('#patch-input').fill(DIFF);
  await page.locator('#patch-propose').click();
  await page.waitForFunction(() => /提案已登记|已经登记过|未通过固定快照校验/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 20000 });
  const proposeState = await page.locator('#status').innerText();
  if (/未通过固定快照校验/.test(proposeState)) record('多行补丁通过固定快照校验', false, proposeState);
  await page.locator('#patch-body button', { hasText: '验证（隔离副本重新派生分析）' }).first().click();
  // 验证还在跑的时候切到别的函数：结果不能落到别人名下。
  await page.locator('#fn-search').fill('');
  await page.locator('#fn-search').pressSequentially('validate', { delay: 20 });
  await page.waitForFunction(() => {
    const b = document.querySelector('#fn-list button');
    return b && /validate/.test(b.textContent || '');
  }, null, { timeout: 30000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'validate', null, { timeout: 30000 });
  const otherPatches = await page.locator('#patch-body').innerText();
  record('验证等待期间切换对象：别人名下不出现这次的提案',
    !/隔离副本重新派生分析/.test(otherPatches),
    otherPatches.split('\n').slice(0, 2));
  // 回到原函数，验证结果应该在它名下。
  await page.locator('#fn-search').fill('');
  await page.locator('#fn-search').pressSequentially('onlyPositive', { delay: 20 });
  await page.waitForFunction(() => /onlyPositive/.test(document.querySelector('#fn-list button')?.textContent || ''), null, { timeout: 30000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => /观测：测试命令/.test(document.getElementById('patch-body')?.textContent || ''), null, { timeout: 180000 });
  const verifiedText = await page.locator('#patch-body').innerText();
  record('切换回来后验证结果落在正确的提案上，且测试真的跑了',
    /退出码\s*0/.test(verifiedText) && /通过/.test(verifiedText),
    verifiedText.split('\n').filter(l => /观测/.test(l)).slice(0, 2));
  await page.screenshot({ path: p.join(OUT, 's4-tour-verified.png'), fullPage: true });

  // --- 6. 前后对照 -----------------------------------------------------------
  // 诊断：对照的实参默认应该沿用「运行」页签已经填好的那份声明输入。
  const prefillDiag = await page.evaluate(() => {
    const prof = state.execProfile;
    const draft = (state.execDrafts || {})[prof?.symbol];
    let formResult = null, formError = null;
    try { formResult = JSON.stringify(execFormValue(prof)); }
    catch (e) { formError = String((e && e.message) || e); }
    return {
      profileSymbol: prof?.symbol || null,
      selectedId: state.selected?.id || null,
      params: (prof?.params || []).map(x => ({ index: x.index, name: x.name })),
      draft,
      formResult,
      formError,
      argsValue: document.querySelector('[id^="compare-args-"]')?.value ?? null,
    };
  });
  record('对照实参默认沿用运行页签的声明输入', prefillDiag.argsValue === '[[1,-2,3]]', prefillDiag);
  await page.locator('#patch-body button', { hasText: '以相同输入运行两侧' }).first().click();
  await page.waitForFunction(() => /两侧同一输入/.test(document.querySelector('[id^="compare-result-"]')?.textContent || ''), null, { timeout: 60000 });
  const compareText = await page.locator('[id^="compare-result-"]').first().innerText();
  record('前后对照两侧都真实运行且结果不同（[1,3] / [2,6]）',
    /1,3|1, 3/.test(compareText) && /2,6|2, 6/.test(compareText),
    compareText.split('\n').slice(0, 8));
  await page.screenshot({ path: p.join(OUT, 's4-tour-compare.png'), fullPage: true });

  // --- 7. 应用 / 撤销：核对真实字节 ------------------------------------------
  await page.locator('#patch-body button', { hasText: '应用（写入' }).first().click();
  await page.waitForFunction(() => /已应用|写入未发生/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 30000 });
  const appliedText = await page.locator('#status').innerText();
  const appliedBytes = fs.readFileSync(LEDGER, 'utf8');
  record('应用到授权目录后文件字节等于补丁内容',
    /已应用/.test(appliedText) && appliedBytes !== ORIGINAL && /value \* 2/.test(appliedBytes),
    { status: appliedText, bytes: appliedBytes.length });
  await page.locator('#patch-body button', { hasText: '一键撤销' }).first().click();
  await page.waitForFunction(() => /已撤销|写入未发生/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 30000 });
  const revertedBytes = fs.readFileSync(LEDGER, 'utf8');
  record('撤销后逐字节回到原始内容', revertedBytes === ORIGINAL,
    { status: await page.locator('#status').innerText(), equal: revertedBytes === ORIGINAL });
  await page.screenshot({ path: p.join(OUT, 's4-tour-applied-reverted.png'), fullPage: true });

  // --- 8. 2D / 3D 往返 -------------------------------------------------------
  await page.locator('[data-lens="calls"]').click().catch(() => {});
  const href = await page.locator('#open-3d').getAttribute('href');
  await page.locator('#open-3d').click();
  await page.waitForFunction(() => /3D|CODE CITY/.test(document.title) || Boolean(document.getElementById('city-canvas')), null, { timeout: 30000 });
  await page.waitForFunction(() => /已连接|文件/.test(document.getElementById('city-status')?.textContent || ''), null, { timeout: 30000 });
  const citySelection = await page.locator('#city-selected').innerText();
  // 3D 是文件级柱体，函数级选区落到它所属的那根柱子上并指名真实文件。
  record('3D 用同一选区打开并指名真实文件',
    /selection=/.test(href) && /ledger\.js/.test(citySelection),
    { href: href.slice(0, 90), citySelection });
  await page.screenshot({ path: p.join(OUT, 's4-tour-city3d.png'), fullPage: true });
  await page.locator('a:has-text("2D 工作台")').first().click();
  await page.waitForFunction(() => Boolean(document.getElementById('fn-list')), null, { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'onlyPositive', null, { timeout: 30000 });
  record('从 3D 回到 2D 仍是同一个选区', true, await page.locator('#selection-name').innerText());
  await page.screenshot({ path: p.join(OUT, 's4-tour-back-to-2d.png'), fullPage: true });

  await page.close();
  await context.close();
} catch (error) {
  record('harness', false, String(error && error.stack || error));
} finally {
  if (browser) await browser.close();
  await stop();
  const exit_code = checks.some(c => c.result === 'FAIL') ? 1 : 0;
  fs.writeFileSync(p.join(OUT, 's4-tour-results.json'), JSON.stringify({
    scope: '最终分发包 + 真实 Chrome；examples/tour 全程',
    checks, exit_code,
  }, null, 2));
  console.log(`\n${checks.filter(c => c.result === 'PASS').length}/${checks.length} 通过`);
  process.exitCode = exit_code;
}
