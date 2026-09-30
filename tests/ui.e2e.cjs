'use strict';
/**
 * Browser test: renders the real HTML (Index + Admin/Partner) in Chromium and bridges
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
const link = env.api('links.issue', { code: 'BO-0001', days: 30 });
const token = new URL(link.data.url).searchParams.get('token');
// A pending change request for BO-0002 so the review queue has both kinds.
const token2 = new URL(env.api('links.issue', { code: 'BO-0002', days: 30 }).data.url).searchParams.get('token');
['대표 이미지', '상세페이지'].forEach((category, i) => env.api('partner.upload', { kind: 'asset', productId: 'PRD-0003-CCCC', category, uploadId: 'UP-SEED-000' + i, fileName: i ? 'd.pdf' : 'm.png', mimeType: i ? 'application/pdf' : 'image/png', base64: Buffer.from('x').toString('base64') }, token2));
const change = env.api('partner.submit', { requestId: 'REQ-SEED-00001', contactName: '셀리본 담당', products: [{ productId: 'PRD-0003-CCCC', data: { product_name: '립 틴트 벨벳', barcode: '8800000000035', category: ['메이크업'], retail_price: 19000 } }] }, token2);
assert.equal(change.ok, true, change.message);
assert.equal(change.data.ok, true, JSON.stringify(change.data));
env.api('partner.upload', { kind: 'doc', category: '사업자등록증', uploadId: 'DOC-SEED-0001', fileName: 'biz.pdf', mimeType: 'application/pdf', base64: Buffer.from('pdf').toString('base64') }, token2);

// Hostile text coming from Notion must render as text, never as markup.
env.notion.createPage(data.ids.brandId, { '브랜드명': { title: [{ text: { content: '<img src=x onerror="window.__xss=1">' } }] }, '브랜드 ID': { rich_text: [{ text: { content: 'BO-0099' } }] }, '진행 단계': { select: { name: '접수·검토' } } });
env.api('system.refresh');

const pages = {
  '/admin': () => env.call('doGet', { parameter: {} }).getContent(),
  '/partner': () => env.call('doGet', { parameter: { token } }).getContent()
};
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
  page.on('console', (m) => { if (m.type() === 'error' && !/pretendard|Failed to load resource|drive\.google/.test(m.text())) errors.push(url + ' console: ' + m.text()); });
  await page.exposeFunction('__api', (json) => JSON.stringify(env.call('api', JSON.parse(json))));
  await page.addInitScript(SHIM);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(900); return page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined });
  try {
    /* ----- Admin desktop ----- */
    const a = await open(browser, base + '/admin', { width: 1366, height: 900 });
    await a.waitForSelector('.stats .stat');
    assert.match(await a.textContent('.stats'), /입점 신청/);
    await shot(a, '01-admin-home');

    await a.click('a[data-path="intake"]');
    await a.waitForSelector('tr[data-code="BO-0003"]');
    await a.click('tr[data-code="BO-0003"]');
    await a.waitForSelector('#intakeStage');
    await shot(a, '02-admin-intake-drawer');
    await a.selectOption('#intakeStage', '통화 예정');
    await a.fill('#intakeNote', '다음 주 통화');
    await a.click('#intakeSave');
    await a.waitForSelector('.toast');
    await a.waitForFunction(() => !document.querySelector('#drawer'));

    await a.click('a[data-path="brands"]');
    await a.waitForSelector('tr[data-code="BO-0001"]');
    await shot(a, '03-admin-brands');
    await a.click('tr[data-code="BO-0001"]');
    await a.waitForSelector('#brandForm');
    await shot(a, '04-admin-brand-overview');
    await a.click('[data-tab="activity"]');
    await a.waitForSelector('#aContent');
    await a.fill('#aContent', '신상품 3종 제안 받음');
    await a.fill('#aNext', '샘플 요청');
    await a.click('#aSave');
    await a.waitForSelector('.timeline-item');
    await shot(a, '05-admin-brand-activity');
    await a.click('[data-tab="billing"]');
    await a.waitForSelector('#bSave');
    await a.selectOption('#bKind', '입점비');
    await a.fill('#bAmount', '330000');
    await a.click('#bSave');
    await a.waitForSelector('button[data-bill][data-field="pay"]');
    await a.click('button[data-bill][data-field="pay"]');
    await a.waitForSelector('button[data-bill][data-field="pay"][data-value="입금 대기"]');
    await shot(a, '05b-admin-brand-billing');
    await a.click('[data-tab="links"]');
    await a.waitForSelector('#linkIssue');
    await shot(a, '06-admin-brand-links');
    await a.click('[data-tab="stock"]');
    await a.waitForSelector('[data-move="-"]');
    await a.click('[data-move="-"]');
    await a.fill('#mvQty', '2');
    await a.click('#mvSave');
    await a.waitForFunction(() => !document.querySelector('#modal'));
    await a.waitForSelector('td.right.num strong');
    assert.match(await a.textContent('#bBody'), /\b8\b/);
    await a.keyboard.press('Escape');

    await a.click('a[data-path="review"]');
    await a.waitForSelector('[data-review]');
    await a.click('[data-review]:has-text("립 틴트")');
    await a.waitForSelector('table.diff');
    await shot(a, '07-admin-review-change');
    await a.click('[data-decide="approve"]');
    await a.waitForSelector('.toast.ok');
    await a.waitForFunction(() => !/립 틴트/.test(document.querySelector('#rlist').textContent));
    await a.click('[data-rtab="docs"]');
    await a.waitForSelector('[data-doc]');
    await shot(a, '08-admin-review-docs');

    await a.click('a[data-path="products"]');
    await a.waitForSelector('tr[data-page]');
    await shot(a, '09-admin-products');
    await a.click('tr[data-page]:has-text("립 틴트 벨벳")');
    await a.waitForSelector('#pdForm');
    await shot(a, '10-admin-product-drawer');
    await a.keyboard.press('Escape');

    await a.click('a[data-path="inventory"]');
    await a.waitForSelector('#itable');
    await shot(a, '11-admin-inventory');
    await a.click('a[data-path="settings"]');
    await a.waitForSelector('#sHealthBox table');
    await a.waitForSelector('#sFields table');
    await shot(a, '12-admin-settings');

    /* ----- Admin mobile ----- */
    const am = await open(browser, base + '/admin', { width: 390, height: 844 });
    await am.waitForSelector('.stats .stat');
    await shot(am, '13-admin-home-mobile');
    const overflow = await am.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) console.log(await am.evaluate(() => Array.from(document.querySelectorAll('*')).filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((el) => el.tagName + '.' + el.className + ' ' + Math.round(el.getBoundingClientRect().right) + ' ' + (el.textContent || '').slice(0, 40)).join('\n')));
    assert.ok(overflow <= 1, 'no horizontal scroll on mobile home, got ' + overflow);
    await am.click('#menuToggle');
    await shot(am, '14-admin-menu-mobile');

    /* ----- Partner ----- */
    const p = await open(browser, base + '/partner', { width: 1280, height: 900 });
    await p.waitForSelector('#plist');
    await shot(p, '15-partner-products');
    await p.click('#newProduct');
    await p.waitForSelector('#dForm');
    await p.fill('[data-field="product_name"]', '데일리 수분 토너');
    await p.fill('[data-field="barcode"]', '8800000000123');
    await p.check('[data-field="category"] input[value="스킨케어(베이직)"]');
    await p.fill('[data-field="retail_price"]', '21000');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await p.setInputFiles('[data-upload="main"]', { name: 'main.png', mimeType: 'image/png', buffer: png });
    await p.waitForSelector('text=완료');
    await p.setInputFiles('[data-upload="detail"]', { name: 'detail.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await p.waitForFunction(() => document.querySelectorAll('.file-row').length >= 2 && !/올리는 중/.test(document.querySelector('#dEditor').textContent));
    await p.waitForSelector('#dSubmitOne:not([disabled])');
    await shot(p, '16-partner-editor');
    await p.click('#dSubmitOne');
    await p.fill('#sName', '김담당');
    await p.click('#sGo');
    await p.waitForSelector('text=검수 결과', { state: 'visible' });
    await p.waitForSelector('td:has-text("데일리 수분 토너")');
    await shot(p, '17-partner-status');
    const created = Object.values(env.notion.pages).find((pg) => pg.properties['상품명'] && pg.properties['상품명'].title.map((t) => t.plain_text).join('') === '데일리 수분 토너');
    assert.ok(created, 'submitted product exists in Notion');
    assert.equal(created.properties['등록 검수 상태'].select.name, '검수 대기');
    await p.click('[data-ptab="docs"]');
    await p.waitForSelector('#docFile', { state: 'attached' });
    await shot(p, '18-partner-docs');

    // 엑셀(CSV)로 여러 상품을 불러온 뒤 사진을 파일 이름으로 한꺼번에 올린다.
    await p.click('[data-ptab="products"]');
    await p.setInputFiles('#importFile', { name: 'list.csv', mimeType: 'text/csv', buffer: Buffer.from('상품명 *,바코드,카테고리,소비자가\n선크림,8800000000201,스킨케어(베이직),15000\n립밤,,메이크업,9000\n') });
    await p.waitForSelector('#dPhotos');
    const beforeFiles = Object.values(env.drive.items).filter((f) => f.appProperties && f.appProperties.boKind === 'asset').length;
    await p.click('#dPhotos');
    await p.setInputFiles('#bpFiles', [
      { name: '8800000000201_대표.png', mimeType: 'image/png', buffer: png },
      { name: '8800000000201_상세_1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
      { name: '3_대표.png', mimeType: 'image/png', buffer: png },
      { name: 'IMG_0001.png', mimeType: 'image/png', buffer: png }
    ]);
    await p.waitForSelector('text=3 / 4개 준비됨');
    await shot(p, '18b-partner-bulk-photos');
    await p.click('#bpGo');
    await p.waitForFunction(() => !document.querySelector('#modal'));
    const afterFiles = Object.values(env.drive.items).filter((f) => f.appProperties && f.appProperties.boKind === 'asset').length;
    assert.equal(afterFiles - beforeFiles, 3, 'three matched photos uploaded');

    const pm = await open(browser, base + '/partner', { width: 390, height: 844 });
    await pm.waitForSelector('#plist');
    await shot(pm, '19-partner-mobile');
    const pOverflow = await pm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(pOverflow <= 1, 'no horizontal scroll on partner mobile, got ' + pOverflow);

    /* ----- Bad token ----- */
    const bad = await open(browser, base + '/partner'.replace('/partner', '/partner'), { width: 800, height: 600 });
    await bad.close();

    for (const pg of [a, p]) assert.equal(await pg.evaluate(() => window.__xss), undefined, 'no script injection');
    await a.click('a[data-path="intake"]');
    await a.waitForSelector('tr[data-code="BO-0099"]');
    assert.match(await a.textContent('tr[data-code="BO-0099"]'), /<img src=x/);
    assert.equal(await a.evaluate(() => window.__xss), undefined, 'no script injection from Notion text');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('UI e2e passed. Screenshots in ' + OUT);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); console.error(errors.join('\n')); process.exit(1); });
