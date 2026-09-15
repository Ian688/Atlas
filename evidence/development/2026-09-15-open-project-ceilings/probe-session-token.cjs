// 会话换令牌这条路径：先用失效令牌加载，再只换 fragment（等价于"在内置浏览器里打开
// 那条新的带令牌地址"），看页面是否就地接上新令牌，以及"打开并分析"是否恢复可用。
const os = require('os');
const path = require('path');
const { chromium } = require('/tmp/atlas-repro/node_modules/playwright-core');

const EXEC = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);
const BASE = process.env.ATLAS_BASE || 'http://127.0.0.1:8791';
const DEAD = process.env.DEAD_TOKEN;
const LIVE = process.env.LIVE_TOKEN;

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const page = await browser.newPage();
  const seen = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/')) seen.push(`${r.request().method()} /api/${r.url().split('/api/')[1]} -> ${r.status()}`);
  });

  const read = async () => ({
    nav: (await page.locator('#nav-connection-text').textContent().catch(() => null)) || '',
    project: (await page.locator('#nav-project-button').textContent().catch(() => null)) || '',
    status: (await page.locator('#status').textContent().catch(() => null)) || '',
    disabled: await page.locator('#home-open-button').isDisabled().catch(() => 'n/a'),
    card: ((await page.locator('.home-open').textContent().catch(() => null)) || '').replace(/\s+/g, ' ').slice(0, 240),
  });
  const dump = async (label) => {
    const s = await read();
    console.log(`--- ${label} ---`);
    console.log(`  nav=${JSON.stringify(s.nav)} project=${JSON.stringify(s.project)} open-button-disabled=${s.disabled}`);
    console.log(`  status=${JSON.stringify(s.status)}`);
    console.log(`  card=${JSON.stringify(s.card)}`);
  };

  await page.goto(`${BASE}/#token=${DEAD}`, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  await dump('1. 用失效令牌加载（页面此刻的状态）');

  // 只换 fragment：与"在内置浏览器里再打开一次新的带令牌地址"是同一种导航，
  // 浏览器不会重新加载文档。
  await page.evaluate((t) => { location.hash = `token=${t}`; }, LIVE);
  await page.waitForTimeout(2000);
  await dump('2. 只换 fragment 换上新令牌（不刷新页面）');

  await page.locator('.wb-nav [data-go="home"]').click();
  await page.waitForTimeout(300);
  await page.locator('#home-open-path').fill('/Users/yinsijie/CodeRepo/Atlas/examples/tour');
  await page.locator('#home-open-button').click();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const s = await page.locator('#status').textContent();
    if (/新项目已加载|已切换到|打开未完成|打开失败/.test(s || '')) break;
  }
  await dump('3. 接上新令牌之后再"打开并分析"');
  console.log('--- api responses ---');
  console.log(seen.join('\n'));
  await browser.close();
})();
