import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = fs.readFileSync('/tmp/u1.log', 'utf8');
const m = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f-]+)/.exec(log);
const url = `http://127.0.0.1:${m[1]}/`, token = m[2];
const OUT = '/tmp/u1-shots';
const errors = [];
const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('response', r => { if (r.status() === 404) errors.push('404: ' + r.url()); });
await page.goto(`${url}#token=${token}`);
await page.locator('#fn-list button').first().waitFor({ timeout: 30000 });
await wait(1200);

const pages = {};
for (const name of ['home', 'explore', 'city', 'run', 'review', 'agent']) {
  await page.evaluate(p => setPage(p), name);
  await wait(700);
  const info = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.wb-page[data-page]')].filter(s => !s.hidden).map(s => s.dataset.page);
    return { visible, current: state.page, title: document.getElementById('page-title').textContent, text: (document.querySelector('.wb-page:not([hidden])')?.innerText || '').replace(/\s+/g, ' ').slice(0, 220) };
  });
  pages[name] = info;
  await page.screenshot({ path: `${OUT}-${name}.png`, fullPage: false });
  console.log(`### ${name}`, JSON.stringify({ visible: info.visible, title: info.title }));
  console.log('   ', info.text);
}

// U1 主线：查找 → 点关系 → 读源码 → 进入运行
await page.evaluate(() => setPage('explore'));
await page.locator('#fn-search').click();
await page.locator('#fn-search').pressSequentially('redeem', { delay: 30 });
await page.waitForFunction(() => /redeem/.test(document.querySelector('#fn-list button')?.textContent || ''), null, { timeout: 20000 });
await page.locator('#fn-list button').first().click();
await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'redeem', null, { timeout: 20000 });
await page.waitForFunction(() => /export function/.test(document.getElementById('source')?.textContent || ''), null, { timeout: 20000 });
const selected = await page.evaluate(() => ({
  project: document.getElementById('project-name').textContent,
  name: document.getElementById('selection-name').textContent,
  path: document.getElementById('selection-path').textContent,
  sourcePath: document.getElementById('sourcepath').textContent,
  source: (document.getElementById('source').textContent || '').slice(0, 120),
  status: document.getElementById('selection-status').textContent,
}));
console.log('### 选中', JSON.stringify(selected, null, 1));

await page.waitForFunction(() => document.querySelectorAll('#graph g.node-group').length > 1, null, { timeout: 20000 });
await wait(1200);
const neighbour = await page.evaluate(() => {
  const g = [...document.querySelectorAll('#graph g.node-group')].find(el => !/redeem/.test(el.querySelector('text')?.textContent || ''));
  return g ? g.querySelector('text').textContent : null;
});
await page.locator('#graph g.node-group', { hasNotText: 'redeem' }).first().click({ position: { x: 20, y: 8 }, timeout: 8000 }).catch(() => {});
await page.waitForFunction(n => document.getElementById('selection-name')?.textContent === n, neighbour, { timeout: 20000 });
const afterClick = await page.evaluate(() => ({
  name: document.getElementById('selection-name').textContent,
  sourcePath: document.getElementById('sourcepath').textContent,
  source: (document.getElementById('source').textContent || '').slice(0, 80),
}));
console.log('### 点关系后', JSON.stringify(afterClick, null, 1));
await page.screenshot({ path: `${OUT}-relation.png` });

await page.locator('#run-shortcut').click();
await wait(900);
await page.waitForFunction(() => /执行画像|不可运行|可运行/.test(document.getElementById('exec-body')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
const runState = await page.evaluate(() => ({
  page: state.page,
  profile: (document.getElementById('exec-body')?.textContent || '').replace(/\s+/g, ' ').slice(0, 90),
  panelHidden: document.getElementById('exec-panel').hidden,
  target: document.getElementById('selection-name').textContent,
}));
console.log('### 进入运行', JSON.stringify(runState));
await page.screenshot({ path: `${OUT}-run.png` });

// 迟到响应不能覆盖新选区（A/B 快速切换）
await page.evaluate(() => setPage('explore'));
await page.locator('#fn-search').fill('');
await page.locator('#fn-search').pressSequentially('validate', { delay: 20 });
await page.waitForFunction(() => /validate/.test(document.querySelector('#fn-list button')?.textContent || ''), null, { timeout: 20000 });
await page.locator('#fn-list button').first().click();
await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'validate', null, { timeout: 20000 });
await page.locator('#fn-search').fill('');
await page.locator('#fn-search').pressSequentially('clampRate', { delay: 15 });
await wait(400);
const quick = await page.evaluate(() => ({ name: document.getElementById('selection-name').textContent }));
console.log('### 快速切换后', JSON.stringify(quick));

// 1024 宽度
await page.setViewportSize({ width: 1024, height: 900 });
await wait(500);
const at1024 = await page.evaluate(() => {
  const cols = getComputedStyle(document.querySelector('.explore-cols')).gridTemplateColumns;
  const search = document.getElementById('fn-search').getBoundingClientRect();
  return { cols, searchVisible: search.width > 40 && search.height > 10, bodyScroll: document.body.scrollWidth > window.innerWidth + 2 };
});
console.log('### 1024', JSON.stringify(at1024));
await page.screenshot({ path: `${OUT}-1024.png` });

console.log('### 页面错误', errors.length ? JSON.stringify(errors.slice(0, 8)) : '无');
await browser.close();
