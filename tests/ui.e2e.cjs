'use strict';
/**
 * Browser test: builds the real ops.beautyora.kr page (scripts/build-web.cjs → Index + Common + Admin),
 * signs in through a stand-in for Google Identity Services, and routes the page's fetch() to the
 * Apps Script doPost running on the fake Notion/Drive harness.
 * Run: NODE_PATH=$(npm root -g) node tests/ui.e2e.cjs [screenshotDir]
 */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
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
  env.notion.handle('patch', 'https://api.notion.com/v1/pages/' + data.b1.id, { properties: { [props['구글 드라이브'].id]: { url: 'https://drive.google.com/drive/folders/' + folder }, [props['자료 공유 이메일'].id]: { rich_text: [{ text: { content: 'ceo@brand.example, 오타' } }] } } });
}
env.api('system.refresh');

// 실제 배포와 같은 정적 페이지를 만든다(클라이언트 ID는 서버에서 받는 경로를 확인).
const APP_URL = 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec';
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-ops-site-'));
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-web.cjs'), 'admin', SITE], { stdio: 'ignore', env: Object.assign({}, process.env, { BO_OPS_APP_URL: APP_URL, BO_GOOGLE_CLIENT_ID: '' }) });
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] !== '/admin') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(SITE, 'index.html')));
});

// Google Identity Services 대역: 버튼을 누르면 지금 로그인할 계정의 ID 토큰을 콜백으로 준다.
const GIS = `window.google = window.google || {};
google.accounts = { id: {
  initialize(cfg) { window.__gis = cfg; window.__gisClient = cfg.client_id; },
  renderButton(el) { el.innerHTML = '<button id="fakeGoogleSignIn" type="button">Google 계정으로 로그인</button>'; el.firstChild.onclick = async () => window.__gis.callback({ credential: await window.__mintToken() }); },
  prompt() {}, disableAutoSelect() { window.__autoSelectOff = true; }
} };`;
let signInAs = 'admin@beautyora.test';
let slowAction = '';
const errors = [];
async function open(browser, url, viewport, options) {
  options = options || {};
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(url + ': ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/pretendard|Failed to load resource/.test(m.text())) errors.push(url + ' console: ' + m.text()); });
  await page.exposeFunction('__mintToken', () => env.idToken(signInAs));
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await page.route(APP_URL, async (route) => {
    const req = route.request();
    if (slowAction && JSON.parse(req.postData()).action === slowAction) await new Promise((r) => setTimeout(r, 1500));
    assert.equal(req.method(), 'POST');
    assert.equal(req.headers().cookie, undefined, 'no cookies are sent to Apps Script');
    const body = env.call('doPost', { postData: { contents: req.postData() } }).getContent();
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (options.signIn !== false) {
    await page.click('#fakeGoogleSignIn');
    await page.waitForSelector('#authScreen', { state: 'detached' });
  }
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(600); return page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  try {
    /* ----- First visit: Google sign-in screen, styled, before anything else ----- */
    const login = await open(browser, base + '/admin', { width: 1366, height: 900 }, { signIn: false });
    await login.waitForSelector('#authScreen #fakeGoogleSignIn');
    assert.match(await login.textContent('#authScreen'), /운영센터 로그인[\s\S]*운영진으로 등록된 Google 계정/);
    assert.equal(await login.evaluate(() => window.__gisClient), '1234-test.apps.googleusercontent.com', 'client ID comes from the server');
    const box = await login.$eval('.auth-card', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, w: r.width }; });
    assert.ok(box.x > 400 && box.w <= 400, 'login card is centered, not an unstyled corner');
    await shot(login, '00-login');
    const bootStyle = await login.$eval('.boot', (el) => getComputedStyle(el).display);
    assert.equal(bootStyle, 'grid', 'the loading screen behind it is styled');
    await login.close();

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

    // 브랜드 폴더 공유: 창에서 Notion '자료 공유 이메일'을 보고 고친 뒤 저장 → Notion과 Drive 편집자가 그 목록이 된다.
    await a.click('[data-share="BO-0001"]');
    await a.waitForSelector('#modal:has-text("브랜드 폴더 공유")');
    assert.equal(await a.inputValue('#shareEmails'), 'ceo@brand.example');
    assert.match(await a.textContent('#modal'), /이메일이 아닌 값은 저장하면 빠집니다: 오타/);
    assert.match(await a.textContent('#shareStatus'), /ceo@brand\.example\s*저장하면 공유/);
    assert.equal(await a.locator('#modal :text("알림 메일 보내기")').count(), 0, 'no notification option');
    await a.fill('#shareEmails', 'ceo@brand.example\nwrong@');
    assert.match(await a.textContent('#shareStatus'), /wrong@\s*이메일 형식 확인/);
    assert.equal(await a.isDisabled('#modal [data-save]'), true, 'cannot save with a typo');
    await a.fill('#shareEmails', 'ceo@brand.example, md@brand.example');
    await shot(a, '02b-share');
    await a.click('#modal [data-save]');
    await a.waitForSelector('.toast:has-text("저장했습니다")');
    const ruemFolder = Object.keys(env.drive.items).find((id) => env.drive.items[id].name === '루엠 주식회사 | 루엠 [BO-0001]');
    const shared = env.drive.permissionsOf(ruemFolder).filter((p) => p.role === 'writer' && /brand\.example/.test(p.emailAddress)).map((p) => p.emailAddress).sort();
    assert.deepEqual(shared, ['ceo@brand.example', 'md@brand.example']);
    assert.ok((env.drive.notifications || []).every((n) => !n.notify), 'no Google share mail');
    assert.equal(env.notion.pages[data.b1.id].properties['자료 공유 이메일'].rich_text.map((t) => t.plain_text || t.text.content).join(''), 'ceo@brand.example, md@brand.example');

    // Notion text is shown as text; unsafe links are not rendered as links.
    assert.match(await a.textContent('tr[data-code="BO-0099"]'), /<img src=x/);
    assert.equal(await a.locator('tr[data-code="BO-0099"] a[href^="javascript:"]').count(), 0);
    assert.equal(await a.evaluate(() => window.__xss), undefined, 'no script injection from Notion text');

    // 서버가 늦으면 끝없이 기다리지 않고 알린다.
    await a.evaluate(() => { Api.TIMEOUT_MS = 400; Api.invalidate(); });
    slowAction = 'brands.list';
    await a.click('a[data-path="brands"]');
    await a.waitForSelector('#view:has-text("넘게 없어 멈췄습니다")');
    assert.equal(await a.locator('#view [data-retry]').count(), 1, 'retry button offered');
    slowAction = '';
    await a.evaluate(() => { Api.TIMEOUT_MS = 90000; });
    await a.click('#view [data-retry]');
    await a.waitForSelector('tr[data-code="BO-0001"]');

    // 홈을 다시 열면 지난 결과를 먼저 그린다.
    await a.click('a[data-path="home"]');
    await a.waitForSelector('#actBody tr[data-status="writing"]');
    assert.match(await a.textContent('#actStamp'), /기준|확인하는 중/);

    await a.click('a[data-path="settings"]');
    await a.waitForFunction(() => location.hash === '#/settings' && Live.timer === null, null, { timeout: 5000 }); // polling stops when leaving home
    await a.waitForSelector('#sHealthBox table');
    // 운영진 계정: 로그인 허용 목록과 최상위 폴더 편집 권한.
    await a.waitForSelector('#aBox tr[data-admin="admin@beautyora.test"]');
    assert.match(await a.textContent('#aBox'), /최상위 폴더 편집 권한이 없는 운영진 2명/);
    assert.equal(await a.locator('#aBox [data-remove="admin@beautyora.test"]').count(), 0, 'cannot remove yourself');
    await a.click('#aSync');
    await a.click('#modal [data-ok]');
    await a.waitForSelector('#aBox tr[data-admin="second@beautyora.test"]:has-text("편집자")');
    await a.fill('#aEmail', 'new.staff@gmail.com');
    await a.click('#aForm button[type=submit]');
    await a.click('#modal [data-ok]');
    await a.waitForSelector('#aBox tr[data-admin="new.staff@gmail.com"]:has-text("편집자")');
    assert.match(env.props.BO_ADMIN_EMAILS, /new\.staff@gmail\.com/);
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
    signInAs = 'stranger@gmail.com';
    const s = await open(browser, base + '/admin', { width: 800, height: 600 });
    await s.waitForSelector('text=운영센터를 열 수 없습니다');
    assert.match(await s.textContent('#root'), /stranger@gmail\.com[\s\S]*운영진으로 등록되어 있지 않습니다/);
    await shot(s, '06-not-admin');
    await s.click('#switchAccount');
    await s.waitForSelector('#authScreen #fakeGoogleSignIn');
    signInAs = 'admin@beautyora.test';

    assert.deepEqual(errors, [], 'no page errors');
    console.log('UI e2e passed. Screenshots in ' + OUT);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(SITE, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); console.error(errors.join('\n')); process.exit(1); });
