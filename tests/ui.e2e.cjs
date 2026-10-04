'use strict';
/**
 * Browser test: renders the real HTML (Index + Common + Admin) in Chromium and bridges
 * google.script.run → the real server code running on the fake Notion/Drive harness.
 * Run: NODE_PATH=$(npm root -g) node tests/ui.e2e.cjs [screenshotDir]
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createEnv, seed } = require('./harness.cjs');

const OUT = process.argv[2] || path.join(__dirname, '..', '.ui-shots');
fs.mkdirSync(OUT, { recursive: true });

const env = createEnv();
const data = seed(env);
const setup = env.api('system.setup');
assert.equal(setup.ok, true, setup.message);

// Hostile text coming from Notion must render as text, never as markup.
env.notion.createPage(data.ids.brandId, { '브랜드명': { title: [{ text: { content: '<img src=x onerror="window.__xss=1">' } }] }, '브랜드 ID': { rich_text: [{ text: { content: 'BO-0099' } }] }, '진행 단계': { select: { name: '접수·검토' } }, '구글 드라이브': { url: 'javascript:alert(1)' } });
env.api('system.refresh');

const pages = { '/admin': () => env.call('doGet', { parameter: {} }).getContent() };
const server = http.createServer((req, res) => {
  const route = pages[req.url.split('?')[0]];
  if (!route) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(route());
});

const SHIM = `
window.google = { script: { run: (function make(ok, fail) {
  return {
    withSuccessHandler: (f) => make(f, fail),
    withFailureHandler: (f) => make(ok, f),
    api: (req) => { window.__api(JSON.stringify(req)).then((r) => ok && ok(JSON.parse(r))).catch((e) => fail && fail(e)); }
  };
})(null, null) } };`;

const errors = [];
async function open(browser, url, viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(url + ': ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/pretendard|Failed to load resource/.test(m.text())) errors.push(url + ' console: ' + m.text()); });
  await page.exposeFunction('__api', (json) => JSON.stringify(env.call('api', JSON.parse(json))));
  await page.addInitScript(SHIM);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(600); return page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  try {
    /* ----- Desktop ----- */
    const a = await open(browser, base + '/admin', { width: 1366, height: 900 });
    await a.waitForSelector('.stats .stat');
    assert.deepEqual(await a.$$eval('.nav-item span', (els) => els.map((e) => e.textContent)), ['홈', '브랜드', '설정']);
    assert.match(await a.textContent('.stats'), /접수·검토/);
    await shot(a, '01-home');

    // A stage tile opens the brand list filtered to that stage.
    await a.click('.stats .stat:has-text("확정")');
    await a.waitForSelector('tr[data-code="BO-0001"]');
    assert.equal(await a.locator('tbody tr').count(), 1);
    assert.equal(await a.inputValue('#bstage'), '확정');
    await a.selectOption('#bstage', '');
    await a.waitForSelector('tr[data-code="BO-0002"]');
    await a.fill('#bq', '셀리본');
    assert.equal(await a.locator('tbody tr').count(), 1);
    await a.fill('#bq', '');
    const notionHref = await a.getAttribute('tr[data-code="BO-0001"] .cell-title a', 'href');
    assert.match(notionHref, /^https:\/\/www\.notion\.so\//, 'brand name opens the Notion page');
    assert.equal(await a.getAttribute('tr[data-code="BO-0001"] .cell-title a', 'target'), '_blank');
    await shot(a, '02-brands');

    // Notion text is shown as text; unsafe links are not rendered as links.
    assert.match(await a.textContent('tr[data-code="BO-0099"]'), /<img src=x/);
    assert.equal(await a.locator('tr[data-code="BO-0099"] a[href^="javascript:"]').count(), 0);
    assert.equal(await a.evaluate(() => window.__xss), undefined, 'no script injection from Notion text');

    await a.click('a[data-path="settings"]');
    await a.waitForSelector('#sHealthBox table');
    await a.click('#sSetup');
    await a.click('#modal [data-ok]');
    await a.waitForSelector('#modal:has-text("초기 설정 결과")');
    await shot(a, '03-settings');
    await a.click('#modal [data-close]');

    /* ----- Mobile ----- */
    const am = await open(browser, base + '/admin', { width: 390, height: 844 });
    await am.waitForSelector('.stats .stat');
    await shot(am, '04-home-mobile');
    const overflow = await am.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, 'no horizontal scroll on mobile home, got ' + overflow);
    await am.click('#menuToggle');
    await am.click('a[data-path="brands"]');
    await am.waitForSelector('tr[data-code="BO-0001"]');
    const listOverflow = await am.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(listOverflow <= 1, 'no horizontal scroll on mobile brand list, got ' + listOverflow);
    await shot(am, '05-brands-mobile');

    /* ----- Not an admin ----- */
    env.setUser('stranger@gmail.com');
    const s = await open(browser, base + '/admin', { width: 800, height: 600 });
    await s.waitForSelector('text=운영센터를 열 수 없습니다');
    assert.match(await s.textContent('#root'), /관리자로 등록되어 있지 않습니다/);
    env.setUser('admin@beautyora.test');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('UI e2e passed. Screenshots in ' + OUT);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); console.error(errors.join('\n')); process.exit(1); });
