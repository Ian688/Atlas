// 复现：在真实浏览器里走"项目总览 → 输入本机路径 → 打开并分析"，
// 记录页面显示的状态文字、控制台错误与所有 /api 请求的响应。
const os = require('os');
const path = require('path');
const { chromium } = require('/tmp/atlas-repro/node_modules/playwright-core');

const EXEC = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);
const BASE = process.env.ATLAS_BASE || 'http://127.0.0.1:8791';
const TOKEN = process.env.ATLAS_TOKEN;
const TARGET = process.argv[2];

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const page = await browser.newPage();
  const logs = [];
  const api = [];
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} :: ${r.failure() && r.failure().errorText}`));
  page.on('response', async (r) => {
    if (r.url().includes('/api/')) api.push(`${r.request().method()} ${r.url()} -> ${r.status()}`);
  });

  await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const connected = await page.locator('#nav-connection-text').textContent().catch(() => null);
  console.log('nav-connection:', connected);
  console.log('project:', await page.locator('#nav-project-button').textContent().catch(() => null));

  await page.locator('.wb-nav [data-go="home"]').click();
  await page.waitForTimeout(400);

  await page.locator('#home-open-path').fill(TARGET);
  await page.locator('#home-open-button').click();

  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(1000);
    const s = await page.locator('#status').textContent();
    const p = await page.locator('#home-open-progress').textContent();
    if (i % 5 === 0 || /已切换到|打开未完成|打开失败|打开作业/.test(s || '')) {
      console.log(`t+${i + 1}s status=${JSON.stringify(s)} progress=${JSON.stringify(p)}`);
    }
    if (/已切换到|打开未完成|打开失败|打开作业/.test(s || '')) break;
  }

  console.log('--- api calls ---');
  console.log(api.join('\n'));
  console.log('--- console ---');
  console.log(logs.join('\n'));
  await page.screenshot({ path: '/tmp/atlas-repro/shot.png', fullPage: true });
  await browser.close();
})();
