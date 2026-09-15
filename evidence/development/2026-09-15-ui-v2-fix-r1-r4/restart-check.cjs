// R4 重启恢复：服务停止再启动后，各项目的测试声明仍在；切换项目时服务
// 换读该项目的声明；写授权也按项目恢复。
const fs = require('fs');
// 复放前置：需要 playwright-core（npm i playwright-core）与本机 Chrome。
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { ({ chromium } = require('/tmp/atlas-pw/node_modules/playwright-core')); }
const BASE = 'http://127.0.0.1:63763';
const TOKEN = 'b05a3efc-bb7d-418a-9bc3-212e15bde11d';
const checks = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (v, m) => { if (!v) throw new Error(m); };
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
    page.setDefaultTimeout(20000);
    await page.goto(`${BASE}/#token=${TOKEN}`);
    await page.waitForFunction(() => state.report && state.contract);
    const settings = () => page.evaluate(async () => {
      const r = await fetch('/api/project/settings', { headers: { Authorization: `Bearer ${state.token}` } });
      return r.json();
    });
    const s1 = await settings();
    checks.push({ name: '重启后 alpha 设置恢复', result: JSON.stringify(s1.test_argv) === '["node","--test"]' ? 'PASS' : 'FAIL', detail: s1 });
    const writes1 = await page.evaluate(() => state.contract.writes);
    checks.push({ name: '重启后 alpha 写授权恢复', result: writes1.enabled && writes1.root.includes('alpha') ? 'PASS' : 'FAIL', detail: writes1 });
    // 切到 beta（最近项目，按 analysis）
    await page.locator('.wb-nav [data-go="home"]').click();
    await wait(200);
    await page.locator('.project-row').filter({ hasText: 'beta' }).locator('button').filter({ hasText: '继续这个项目' }).click();
    await page.waitForFunction(() => state.projectName === 'beta', null, { timeout: 30000 });
    const s2 = await settings();
    checks.push({ name: '切换到 beta：读 beta 自己的声明', result: Array.isArray(s2.test_argv) && s2.test_argv[1] === '-e' ? 'PASS' : 'FAIL', detail: s2 });
    const writes2 = await page.evaluate(() => state.contract.writes);
    checks.push({ name: '切换到 beta：写授权跟随 beta', result: writes2.enabled && writes2.root.includes('beta') ? 'PASS' : 'FAIL', detail: writes2 });
  } catch (e) {
    checks.push({ name: 'harness', result: 'FAIL', detail: String(e).slice(0, 600) });
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(__dirname + '/restart-results.json', JSON.stringify({ scope: 'R4 服务重启恢复', checks }, null, 2));
    const failed = checks.filter((c) => c.result === 'FAIL');
    console.log(`restart checks: ${checks.length}, failed: ${failed.length}`);
    for (const f of failed) console.log(`FAIL ${f.name}: ${JSON.stringify(f.detail).slice(0, 300)}`);
    process.exitCode = failed.length ? 1 : 0;
  }
})();
