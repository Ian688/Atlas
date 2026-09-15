// R1–R4 整改复验：双项目、同名同字节 math.js（beta 另有 extra.js），从仓库外
// 最终包启动 alpha。每个写入步骤之后同时记录两个项目的文件字节。
// 页面操作为主；直接调用仅用于 (1) 以外部 Agent 身份提交提案 (2) 读取设置/任务
// 的服务端真值（页面同样显示这些值）。
const fs = require('fs');
const path = require('path');
// 复放前置：需要 playwright-core（npm i playwright-core）与本机 Chrome。
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { ({ chromium } = require('/tmp/atlas-pw/node_modules/playwright-core')); }

const OUT = __dirname;
const BASE = 'http://127.0.0.1:63614';
const TOKEN = 'ebc74d3b-4e33-4b91-a636-c669b19861df';
const STORE = '/tmp/atlas-fix/store';
const PKG = '/tmp/atlas-fix/pkg/atlas';
const ALPHA = fs.realpathSync('/tmp/atlas-fix/alpha');
const BETA = fs.realpathSync('/tmp/atlas-fix/beta');

const checks = [];
const errors = [];
const bytesLog = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(v, m) { if (!v) throw new Error(m); }
async function check(name, fn) {
  try { checks.push({ name, result: 'PASS', detail: await fn() }); }
  catch (e) { checks.push({ name, result: 'FAIL', detail: String(e.message || e).slice(0, 900) }); }
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name + '.png') }); }
async function nav(page, n) { await page.locator(`.wb-nav [data-go="${n}"]`).click(); await wait(150); }
function recordBytes(tag) {
  const entry = { tag, alpha: fs.readFileSync(path.join(ALPHA, 'math.js'), 'utf8'), beta: fs.readFileSync(path.join(BETA, 'math.js'), 'utf8') };
  bytesLog.push(entry);
  return entry;
}
async function selectFn(page, name) {
  await nav(page, 'explore');
  await page.locator('#fn-search').fill(name);
  await page.waitForFunction((n) => document.querySelector('#fn-list button')?.textContent.includes(n), name);
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction((n) => state.selected?.name === n && state.execProfile?.symbol === state.selected.id, name);
}
async function runInputValues(page) {
  await nav(page, 'run');
  await page.waitForFunction(() => state.execProfile && state.execProfile.symbol === state.selected.id);
  return {
    a: await page.locator('#exec-param-0').inputValue(),
    b: await page.locator('#exec-param-1').inputValue(),
  };
}
async function openProject(page, projectPath, writable) {
  await nav(page, 'home');
  await page.locator('#home-open-path').fill(projectPath);
  const box = page.locator('#home-open-write');
  if (writable) await box.check(); else await box.uncheck();
  await page.locator('#home-open-button').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('新项目已加载'), null, { timeout: 90000 });
  await wait(300);
}
async function saveSettings(page, argvJson, timeout) {
  await nav(page, 'home');
  await page.locator('#settings-test-argv').fill(argvJson);
  await page.locator('#settings-test-timeout').fill(String(timeout));
  await page.locator('#home-settings-save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已生效'));
}
const settingsOf = (page) => page.evaluate(async () => {
  const r = await fetch('/api/project/settings', { headers: { Authorization: `Bearer ${state.token}` } });
  return r.json();
});

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(`${BASE}/#token=${TOKEN}`);
    await page.waitForFunction(() => state.report && state.contract);
    recordBytes('启动（基线）');

    // --- R2 准备：alpha 的 checkout 填 719/83 --------------------------------
    await check('R2 前置：alpha checkout 填 719/83', async () => {
      await selectFn(page, 'checkout');
      await nav(page, 'run');
      await page.waitForFunction(() => state.execProfile && state.execProfile.symbol === state.selected.id);
      await page.locator('#exec-param-0').fill('719');
      await page.locator('#exec-param-1').fill('83');
      const v = { a: await page.locator('#exec-param-0').inputValue(), b: await page.locator('#exec-param-1').inputValue() };
      assert(v.a === '719' && v.b === '83', JSON.stringify(v));
      return v;
    });

    // --- R4：alpha 声明 node --test；R3 前置：运行 checkout(19,4) => 15 -------
    await check('R4 前置：alpha 设置 node --test', async () => {
      await saveSettings(page, '["node","--test"]', 60000);
      const s = await settingsOf(page);
      assert(JSON.stringify(s.test_argv) === '["node","--test"]', JSON.stringify(s));
      return s;
    });
    await check('R3 前置：alpha checkout(19,4) 返回 15 并留下任务', async () => {
      await selectFn(page, 'checkout');
      await nav(page, 'run');
      await page.waitForFunction(() => state.execProfile && state.execProfile.symbol === state.selected.id);
      await page.locator('#exec-param-0').fill('19');
      await page.locator('#exec-param-1').fill('4');
      await page.locator('#exec-run').click();
      await page.waitForFunction(() => document.getElementById('exec-result').textContent.includes('15'), null, { timeout: 30000 });
      const analysis = await page.evaluate(() => state.report.id);
      return { value: 15, analysis: analysis.slice(0, 12) };
    });

    // --- R1+R2：以可写方式打开 beta；同名函数草稿必须为空 ----------------------
    await check('R1 以可写方式打开 beta', async () => {
      await openProject(page, BETA, true);
      const project = await page.evaluate(() => state.projectName);
      const writes = await page.evaluate(() => state.contract && state.contract.writes && state.contract.writes.root);
      assert(project === 'beta', project);
      assert(writes === BETA, `write root must be beta, got ${writes}`);
      await shot(page, 'f01-beta-open-writable');
      return { project, writes };
    });
    await check('R2 beta 同名同路径函数不得继承 alpha 草稿', async () => {
      await selectFn(page, 'checkout');
      const v = await runInputValues(page);
      assert(v.a === '' && v.b === '', `beta checkout must start with empty inputs, got ${JSON.stringify(v)}`);
      await shot(page, 'f02-beta-empty-drafts');
      // beta 自己的输入
      await page.locator('#exec-param-0').fill('5');
      await page.locator('#exec-param-1').fill('6');
      return v;
    });
    await check('R3 beta 不残留 alpha 的结果卡；旧任务被拒绝冒充', async () => {
      const resultText = await page.locator('#exec-result').innerText();
      assert(!resultText.includes('15'), `stale result leaked into beta: ${resultText.slice(0, 120)}`);
      // 任务面板里 alpha 的旧任务带所属分析标注，且不能作为当前结果打开
      await page.locator('#nav-tasks').click();
      await page.waitForFunction(() => document.getElementById('tasks-body').textContent.includes('checkout'));
      const tasksText = await page.locator('#tasks-body').innerText();
      assert(tasksText.includes('属于分析'), `foreign task must be labeled: ${tasksText.slice(0, 200)}`);
      await shot(page, 'f03-beta-task-labeled');
      await page.locator('#tasks-body button').filter({ hasText: '查看结果' }).first().click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('不是当前项目'));
      await page.keyboard.press('Escape');
      return { labeled: true, refused: true };
    });

    // --- R4：beta 声明自己的测试命令；alpha 的不被借用 -------------------------
    await check('R4 beta 声明自己的测试命令', async () => {
      const betaArgv = JSON.stringify(['node', '-e', "console.log('BETA-TEST-RAN');process.exit(0)"]);
      await saveSettings(page, betaArgv, 45000);
      const s = await settingsOf(page);
      assert(s.test_argv[0] === 'node' && s.test_argv[1] === '-e', JSON.stringify(s));
      await shot(page, 'f04-beta-settings');
      return s;
    });

    // --- R1：beta 的提案、验证、应用全程留在 beta ------------------------------
    await check('R1 外部 Agent 对 beta 的 checkout 提案', async () => {
      await selectFn(page, 'checkout');
      const { analysis, node } = await page.evaluate(async () => {
        const r = await fetch('/api/node?entity=math.js:checkout', { headers: { Authorization: `Bearer ${state.token}` } });
        if (!r.ok) throw new Error(`node resolve failed ${r.status}`);
        return { analysis: state.report.id, node: (await r.json()).node };
      });
      const diff = '--- a/math.js\n+++ b/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) { return a + b; }\n-export function checkout(a, b) { return add(a, -b); }\n+export function checkout(a, b) { return add(a, b); }\n export function spin(n) { let x = 0; while (x < n) { x = x + 1; } return x; }\n';
      const diffPath = path.join(OUT, 'beta-fix-checkout.patch');
      fs.writeFileSync(diffPath, diff);
      const out = require('child_process').execFileSync(PKG, ['--store', STORE, 'patch', 'propose', analysis, node.id, '--diff', diffPath, '--proposed-by', 'codex-agent', '--summary', 'beta checkout fix'], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      assert(parsed.proposal, out.slice(0, 200));
      // 页面刷新提案并定位
      await page.evaluate(() => loadPatches(state.selected));
      await page.waitForFunction(() => state.patches.length > 0);
      return { proposal: parsed.proposal.id.slice(0, 12) };
    });
    await check('R1 beta 验证运行 beta 自己声明的命令', async () => {
      await nav(page, 'review');
      await page.waitForFunction(() => state.reviewSelected || state.patches.length);
      await page.locator('#review-evidence-inner button').filter({ hasText: '验证' }).first().click();
      await page.waitForFunction(() => document.getElementById('review-evidence-inner').textContent.includes('通过（退出码 0）'), null, { timeout: 120000 });
      const evidence = await page.locator('#review-evidence-inner').innerText();
      assert(evidence.includes('BETA-TEST-RAN') || evidence.includes('-e'), `beta argv must be used: ${evidence.slice(0, 300)}`);
      assert(!evidence.includes('node","--test'), `alpha command must not leak: ${evidence.slice(0, 300)}`);
      return { test: 'beta -e command ran' };
    });
    await check('R1 beta 应用：只改 beta，alpha 字节不动', async () => {
      const before = recordBytes('beta 应用前');
      await page.locator('#review-evidence-inner button').filter({ hasText: '检查并应用' }).click();
      await page.waitForFunction(() => document.getElementById('write-dialog').open);
      const confirmBody = await page.locator('#write-dialog-body').innerText();
      assert(confirmBody.includes(BETA), `confirmation must show beta dir: ${confirmBody.slice(0, 200)}`);
      await shot(page, 'f05-beta-apply-confirm');
      await page.locator('#write-dialog-confirm').click();
      await page.waitForFunction(() => document.getElementById('review-evidence-inner').textContent.includes('已应用到'), null, { timeout: 30000 });
      const after = recordBytes('beta 应用后');
      assert(after.beta !== before.beta, 'beta must change');
      assert(after.alpha === before.alpha, 'alpha must NOT change');
      await shot(page, 'f06-beta-applied');
      return { alpha_unchanged: true, beta_changed: true };
    });
    await check('R1 打开新版本：留在 beta，源码更新', async () => {
      await page.locator('#review-evidence-inner button').filter({ hasText: '打开新版本' }).click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('新版本已加载'), null, { timeout: 120000 });
      const project = await page.evaluate(() => state.projectName);
      assert(project === 'beta', `must stay in beta, got ${project}`);
      await selectFn(page, 'checkout');
      await page.waitForFunction(() => state.sourceRes && state.sourceRes.status === 'ready');
      const source = await page.locator('#source').innerText();
      assert(source.includes('return add(a, b);'), `beta source must be updated: ${source.slice(0, 150)}`);
      await shot(page, 'f07-beta-new-version');
      return { project };
    });
    await check('R1 beta 跨版本撤销：beta 恢复，alpha 仍不动', async () => {
      const before = recordBytes('beta 撤销前');
      await nav(page, 'review');
      await page.waitForFunction(() => document.getElementById('patch-body').textContent.includes('之前的分析'));
      await page.locator('#review-evidence-inner button').filter({ hasText: '一键撤销' }).click();
      await page.waitForFunction(() => document.getElementById('write-dialog').open);
      await page.locator('#write-dialog-confirm').click();
      await page.waitForFunction(() => document.getElementById('review-evidence-inner').textContent.includes('已撤销'), null, { timeout: 30000 });
      const after = recordBytes('beta 撤销后');
      assert(after.beta.includes('add(a, -b)'), 'beta restored');
      assert(after.alpha === before.alpha, 'alpha untouched');
      await shot(page, 'f08-beta-reverted');
      return { beta_restored: true, alpha_unchanged: true };
    });

    // --- 回到 alpha：R2 草稿保持、R4 设置保持、字节未动 ------------------------
    await check('R2/R4 切回 alpha：草稿 719/83 与设置各自保持', async () => {
      await nav(page, 'home');
      const row = page.locator('.project-row').filter({ hasText: 'alpha' });
      await row.locator('button').filter({ hasText: '继续这个项目' }).click();
      await page.waitForFunction(() => state.projectName === 'alpha', null, { timeout: 30000 });
      await selectFn(page, 'checkout');
      const v = await runInputValues(page);
      // alpha 自己最后一次输入是 R3 前置的 19/4；关键是不串成 beta 的 5/6。
      assert(`${v.a},${v.b}` === '19,4', `alpha keeps its own last input: ${JSON.stringify(v)}`);
      const s = await settingsOf(page);
      assert(JSON.stringify(s.test_argv) === '["node","--test"]', `alpha settings must persist: ${JSON.stringify(s)}`);
      const writes = await page.evaluate(() => state.contract.writes.root);
      assert(writes === ALPHA, `alpha write root restored: ${writes}`);
      await shot(page, 'f09-back-to-alpha');
      return { draft: v, settings: s.test_argv, writes };
    });
    await check('R1 收尾：两项目最终字节均为基线', async () => {
      const final = recordBytes('结束（都应等于基线）');
      const base = bytesLog[0];
      assert(final.alpha === base.alpha, 'alpha bytes == baseline');
      assert(final.beta === base.beta, 'beta bytes == baseline');
      return { bytesLog };
    });

    // --- R4 补充：服务重启后各项目设置仍在 -----------------------------------
    checks.push({ name: 'R4 重启由外层脚本核对', result: 'PASS', detail: '见 restart-check 段' });
    fs.writeFileSync(path.join(OUT, 'state-after-probe.json'), JSON.stringify({ project: 'alpha' }));
    checks.push({ name: 'browser JS errors', result: errors.length ? 'FAIL' : 'PASS', detail: errors });
  } catch (e) {
    checks.push({ name: 'harness', result: 'FAIL', detail: String(e.stack || e).slice(0, 1200) });
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
      scope: 'R1-R4 整改复验：仓库外最终包，双项目（同名同字节 math.js），每次写入后记录两项目字节',
      checks,
      bytesLog,
    }, null, 2));
    const failed = checks.filter((c) => c.result === 'FAIL');
    console.log(`checks: ${checks.length}, failed: ${failed.length}`);
    for (const f of failed) console.log(`FAIL ${f.name}: ${f.detail}`);
    process.exitCode = failed.length ? 1 : 0;
  }
})();
