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
// 브랜드 자료 현황: 루엠 폴더에 브랜드가 올린 섬네일과 작성 중인 기준 시트.
{
  const props = env.notion.sources[data.ids.brandId].properties;
  const folder = env.drive.folder('루엠 주식회사 | 루엠 [BO-0001]', env.drive.root);
  const brandUser = { emailAddress: 'ceo@brand.example', displayName: '루엠 대표' };
  const sheet = env.drive.file({ name: '루엠_뷰티오라_브랜드사_상품정보목록.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: [folder] });
  Object.assign(sheet, { createdTime: new Date(Date.now() - 3600000).toISOString(), modifiedTime: new Date(Date.now() - 120000).toISOString(), lastModifyingUser: brandUser, owners: [{ emailAddress: 'admin@beautyora.test' }] });
  sheet.sheetTabs = { '상품리스트': [['번호', '브랜드 · 상품 정보', '', '', '', '온라인 최저가', '거래 유형', '공급가 (VAT 포함)', ''], ['', '브랜드명', '제품이미지', '상품명 (옵션명)', '바코드번호', '', '', '매입 시', '위탁 시'], ['1', '루엠', '', '시카 앰플', '', '19,000', '매입', '7,000', '']] };
  const photo = env.drive.file({ name: '앰플.jpg', mimeType: 'image/jpeg', parents: [folder] });
  Object.assign(photo, { createdTime: new Date(Date.now() - 600000).toISOString(), modifiedTime: new Date(Date.now() - 600000).toISOString(), owners: [brandUser], lastModifyingUser: brandUser });
  env.notion.handle('patch', 'https://api.notion.com/v1/pages/' + data.b1.id, { properties: { [props['구글 드라이브'].id]: { url: 'https://drive.google.com/drive/folders/' + folder } } });
}
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
    // 브랜드 자료 현황: 작성 중 상태, 누락 표시, 실시간 갱신 표시와 상태 거르기.
    await a.waitForSelector('#actBody tr[data-status="writing"]');
    assert.match(await a.textContent('#actBody tr[data-status="writing"]'), /루엠[\s\S]*작성 중[\s\S]*상품 1행[\s\S]*필수 누락 1행/);
    assert.match(await a.textContent('#actStamp'), /실시간 · 1분마다 확인/);
    assert.equal(await a.getAttribute('#actBody tr[data-status="writing"] .cell-title a', 'target'), '_blank', 'brand name opens the Drive folder');
    await a.click('#actBody [data-filter="no_folder"]');
    assert.equal(await a.locator('#actBody tbody tr[data-status="no_folder"]').count(), 3);
    assert.equal(await a.locator('#actBody tbody tr[data-status="writing"]').count(), 0);
    await a.click('#actBody [data-filter="active"]');
    assert.ok(await a.evaluate(() => !!Live.timer), 'home keeps polling while open');
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
    assert.equal(await a.evaluate(() => Live.timer), null, 'polling stops when leaving home');
    await a.waitForSelector('#sHealthBox table');
    await a.waitForSelector('#mBuild');
    assert.match(await a.textContent('#mBox'), /아직 만들지 않았습니다/);
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
