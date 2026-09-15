// 失效会话下，项目页（用户此刻看的这一页）到底写了什么。
const os = require('os');
const path = require('path');
const { chromium } = require('/tmp/atlas-repro/node_modules/playwright-core');

const EXEC = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);
const BASE = process.env.ATLAS_BASE || 'http://127.0.0.1:8791';
const TOKEN = process.env.ATLAS_TOKEN;

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  await page.locator('.wb-nav [data-go="home"]').click();
  await page.waitForTimeout(400);
  console.log('nav      :', JSON.stringify(await page.locator('#nav-connection-text').textContent()));
  console.log('disabled :', await page.locator('#home-open-button').isDisabled());
  console.log('status   :', JSON.stringify(await page.locator('#status').textContent()));
  console.log('card     :', ((await page.locator('.home-open').textContent()) || '').replace(/\s+/g, ' '));
  await browser.close();
})();
