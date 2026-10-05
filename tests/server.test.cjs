'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createEnv, seed } = require('./harness.cjs');

function setup(opts) {
  const env = createEnv(opts);
  const data = seed(env);
  return { env, data };
}

function ok(result) {
  assert.equal(result.ok, true, result.message);
  return JSON.parse(JSON.stringify(result.data));
}

test('setup preserves unrelated triggers and normalizes only owned triggers', () => {
  const { env } = setup();
  // 관계없는 등록/외부 동기화 트리거는 객체와 ID까지 그대로 보존한다.
  env.call('(function () { ScriptApp.newTrigger("onBrandFormSubmit").forForm("form-1").onFormSubmit().create(); })');
  const res = ok(env.api('system.setup'));
  assert.equal(res.ok, true, res.report.join('\n'));
  const unrelated = env.triggers.find(t => t.getHandlerFunction() === 'onBrandFormSubmit');
  assert.deepEqual(env.triggers.map(t => t.getHandlerFunction()), ['onBrandFormSubmit', 'scheduledHealthCheck', 'scheduledBrandFolders']);
  env.call('(function () { ScriptApp.newTrigger("scheduledBrandFolders").timeBased().everyHours(12).create(); ScriptApp.newTrigger("externalSync").timeBased().everyHours(1).create(); })');
  const external = env.triggers.find(t => t.getHandlerFunction() === 'externalSync');
  const again = ok(env.api('system.setup'));
  assert.equal(again.health.ok, true, JSON.stringify(again.health.results));
  assert.ok(env.triggers.includes(unrelated));
  assert.ok(env.triggers.includes(external));
  for (const [handler, cadence] of [['scheduledHealthCheck', { hours: 6 }], ['scheduledBrandFolders', { minutes: 1 }]]) {
    const owned = env.triggers.filter(t => t.getHandlerFunction() === handler);
    assert.equal(owned.length, 1);
    assert.deepEqual(owned[0].cadence, cadence);
  }
  assert.equal(again.health.results.find(r => r.target === '트리거').status, '정상');
});

test('setup keeps going when one step fails and says how to fix it', () => {
  const { env } = setup();
  env.notion.failNext = Object.assign(/^GET \/data_sources\//, { status: 404 });
  const res = ok(env.api('system.setup'));
  assert.equal(res.ok, false);
  assert.ok(res.report.some((l) => /^실패: Notion 브랜드 목록 확인/.test(l) && /연결/.test(l)), res.report.join('\n'));
  assert.ok(env.triggers.some((t) => t.getHandlerFunction() === 'scheduledHealthCheck'), 'triggers still installed');
  assert.equal(ok(env.api('system.setup')).ok, true);
});

test('non-admin users are rejected for every admin action, unknown actions are refused', () => {
  const { env } = setup();
  env.setUser('stranger@gmail.com');
  Object.keys(env.call('adminActions_')).forEach((action) => {
    const res = env.api(action, {});
    assert.equal(res.ok, false, action);
    assert.equal(res.code, 'NOT_ADMIN', action);
  });
  env.setUser('');
  assert.equal(env.api('dashboard').code, 'NO_EMAIL');
  env.setUser('admin@beautyora.test');
  ['partner.bootstrap', 'products.list', 'links.issue', '__proto__', ''].forEach((action) => {
    const res = env.api(action, {});
    assert.equal(res.ok, false, action);
    assert.match(res.message, /지원하지 않는 요청/, action);
  });
});

test('dashboard counts brands by stage and lists recent Notion edits', () => {
  const { env } = setup();
  const d = ok(env.api('dashboard'));
  assert.equal(d.totals.brands, 3);
  assert.deepEqual(d.stages, [{ stage: '접수·검토', count: 1 }, { stage: '조건 협의', count: 1 }, { stage: '확정', count: 1 }]);
  assert.equal(d.recent.length, 3);
  assert.ok(d.recent.every((r) => r.url && r.code), 'each recent item links to its Notion page');
  assert.deepEqual(d.warnings, []);
});

test('dashboard still renders when Notion is unreachable and says why', () => {
  const { env } = setup();
  env.props.BO_NOTION_TOKEN = 'wrong';
  const d = ok(env.api('dashboard'));
  assert.equal(d.totals.brands, 0);
  assert.ok(d.warnings.some((w) => /^브랜드: Notion 연결 토큰/.test(w)), d.warnings.join(' / '));
});

test('brand list is read-only data from Notion with filter options', () => {
  const { env } = setup();
  const r = ok(env.api('brands.list'));
  assert.deepEqual(r.brands.map((b) => b.code).sort(), ['BO-0001', 'BO-0002', 'BO-0003']);
  const b1 = r.brands.find((b) => b.code === 'BO-0001');
  assert.equal(b1.name, '루엠');
  assert.equal(b1.company, '루엠 주식회사');
  assert.equal(b1.bizNo, '123-45-67890');
  assert.ok(b1.url, 'Notion page link');
  assert.deepEqual(r.options.stage, ['접수·검토', '조건 협의', '통화 예정', '통화 완료', '확정', '보류']);
  assert.deepEqual(r.options.priority, ['1순위', '2순위', '3순위']);
});

test('lists pick up edits made directly in Notion without waiting for the cache', () => {
  const { env, data } = setup();
  env.call('(function () { BO_LIST_SYNC_GAP_MS_ = 0; })');
  assert.equal(ok(env.api('brands.list')).brands.find((b) => b.code === 'BO-0002').stage, '조건 협의');
  const stageProp = env.notion.sources[data.ids.brandId].properties['진행 단계'].id;
  // 영업 직원이 Notion에서 직접 단계를 바꾼다.
  env.notion.handle('patch', 'https://api.notion.com/v1/pages/' + data.b2.id, { properties: { [stageProp]: { select: { name: '확정' } } } });
  const brands = ok(env.api('brands.list')).brands;
  assert.equal(brands.find((b) => b.code === 'BO-0002').stage, '확정', 'direct Notion edit shows up on the next list call');
  assert.equal(brands.length, 3, 'no duplicates after merging');
  env.notion.handle('post', 'https://api.notion.com/v1/pages', { parent: { data_source_id: data.ids.brandId }, properties: { '브랜드명': { title: [{ text: { content: '새브랜드' } }] }, '브랜드 ID': { rich_text: [{ text: { content: 'BO-0050' } }] }, '진행 단계': { select: { name: '확정' } } } });
  assert.ok(ok(env.api('brands.list')).brands.some((b) => b.code === 'BO-0050'), 'new pages show up too');
  assert.deepEqual(ok(env.api('dashboard')).stages.find((s) => s.stage === '확정'), { stage: '확정', count: 3 }, 'dashboard follows too');
});

test('health check reports missing configuration clearly', () => {
  const { env } = setup();
  delete env.props.BO_NOTION_ACTIVITY_DATA_SOURCE_ID;
  let h = ok(env.api('system.health'));
  assert.ok(h.results.some((r) => r.target === '연락 · 진행 이력' && r.status === '주의'), 'activity DB is optional');
  delete env.props.BO_ROOT_FOLDER_ID;
  env.props.BO_NOTION_TOKEN = 'wrong';
  h = ok(env.api('system.health'));
  assert.equal(h.ok, false);
  assert.ok(h.results.some((r) => r.target === 'Notion 연결' && r.status === '오류'));
  assert.ok(h.results.some((r) => r.target === 'Google Drive' && r.status === '오류'));
});

test('doGet renders the staff shell only; a leftover brand-link token is ignored', () => {
  const { env } = setup();
  const page = env.call('doGet', { parameter: { token: 'abc"><script>alert(1)</script>' } });
  const html = page.getContent();
  assert.match(html, /운영센터를 여는 중입니다/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /상품등록센터/);
  assert.equal(page.xframe, undefined, 'no ALLOWALL framing by default');
});

test('only the audited entry points are callable from google.script.run', () => {
  const dir = path.join(__dirname, '..', 'src');
  const publicFns = [];
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^function ([A-Za-z0-9_$]+)\s*\(/gm)) if (!m[1].endsWith('_')) publicFns.push(m[1]);
  });
  // Each of these checks admin/owner or an installed trigger before doing anything.
  assert.deepEqual(publicFns.sort(), ['api', 'doGet', 'inspectBrandIntakeRecovery', 'previewBrandIntakeRecovery', 'replayBrandIntakeRecovery', 'runHealthCheck', 'scheduledBrandFolders', 'scheduledBrandIntake', 'scheduledHealthCheck', 'setupBeautyora', 'setupBrandIntake'].sort());
  const { env } = setup();
  env.setUser('');
  assert.throws(() => env.call('runHealthCheck'), /계정/);
  assert.throws(() => env.call('scheduledHealthCheck', {}), /트리거/);
});

test('removed features leave no traces in the code', () => {
  const root = path.join(__dirname, '..');
  const files = fs.readdirSync(path.join(root, 'src')).map((f) => path.join(root, 'src', f));
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  ['doPost', 'partner', 'idToken', 'google.accounts', 'BO_GOOGLE_CLIENT_ID', 'BO_PARTNER_WEBAPP_URL', 'onBrandFormSubmit(']
    .forEach((needle) => assert.ok(!text.includes(needle), 'still mentions ' + needle));
  ['Partner.html', '13_Partner.gs', '14_Links.gs', '16_Intake.gs', '17_Crm.gs', '18_Inventory.gs', '23_Billing.gs']
    .forEach((name) => assert.ok(!fs.existsSync(path.join(root, 'src', name)), name + ' should be removed'));
});

test('ops.beautyora.kr page frames the staff web app and nothing else', () => {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-ops-'));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-web.cjs'), 'admin', out], { stdio: 'ignore' });
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<iframe src="https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec"/);
  assert.doesNotMatch(html, /<script/, 'no scripts of its own');
  assert.match(fs.readFileSync(path.join(out, '_headers'), 'utf8'), /X-Frame-Options: DENY/);
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-web.cjs'), 'admin', out], { stdio: 'ignore', env: Object.assign({}, process.env, { BO_OPS_APP_URL: 'https://evil.example/x' }) }));
  fs.rmSync(out, { recursive: true, force: true });
});

test('main product list: one tab with brand and vendor columns, thumbnails kept, links found in Notion and old workbooks', () => {
  const { env, data } = setup();
  const n = env.notion;
  // Old Notion product DB (read only) with reference links.
  const productDb = n.addSource('product', { properties: { '상품명': { type: 'title' }, '옵션명': { type: 'rich_text' }, '바코드(텍스트)': { type: 'rich_text' }, '브랜드': { type: 'relation', relation: data.ids.brandId }, '참고 링크': { type: 'url' } } });
  env.props.BO_NOTION_PRODUCT_DATA_SOURCE_ID = productDb;
  const product = (name, option, barcode, brandPage, url) => n.createPage(productDb, { '상품명': { title: [{ text: { content: name } }] }, '옵션명': { rich_text: [{ text: { content: option } }] }, '바코드(텍스트)': { rich_text: [{ text: { content: barcode } }] }, '브랜드': { relation: brandPage ? [{ id: brandPage.id }] : [] }, '참고 링크': { url } });
  product('비비 크림', '', '8809555252672', null, 'https://shop.example/bb-cream');
  product('시카 리페어 앰플', '30ml', '', data.b1, 'https://ruem.kr/');
  product('수분 크림', '', '', data.b1, 'https://ruem.kr/products/cream');

  // Old brand folder with a product-list workbook.
  const legacyRoot = env.drive.folder('01_브랜드자료', null);
  const brandFolder = env.drive.folder('[BO-0039] 에이트포인트원_벨라앤베카', legacyRoot);
  const xlsx = env.drive.file({ name: '뷰티오라_입점 상품 리스트_벨라앤베카.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: [brandFolder] });
  xlsx.sheetValues = [['리스트', '담당자 이름', '홍길동'], ['', '브랜드명', '옵션명', '소비자가', '참고링크'], ['1', '벨라앤베카', 'Velra&Becca Active Daily Serum 50ml', '27000', 'https://velra.example/serum']];

  // Integrated list ("벤더별 운영본") tab.
  const header = ['브랜드', '이미지', '상품명', '구성', '카테고리', '바코드', '공유 매입용 공급가', '공유 위탁용 공급가', '권장판매가', '매입MOQ\n단위 : EA', '핵심포인트', '제품설명', '거래유형', '실제 공급사', '계산모드', '원본행 ID', '위탁 가격상태', '운영 출처시트'];
  const row = (brand, name, barcode, supplier, sourceSheet, price, consignState) => [brand, '', name, '20mL', '스킨케어', barcode, price, '', 5000, 20, '포인트', '설명', '매입', supplier, '자동', '400000013:119', consignState || '', sourceSheet];
  const values = [header,
    row('[EYENLIP]', '아이앤립 비비 크림 20ml', 8809555252672, '시온', '시온', 2409),
    row('루엠', '루엠 시카 리페어 앰플 30ml', '', '주식회사 픽오라(뷰티오라)', '픽오라(매입) / 픽오라(위탁)', 9000, '위탁 기준가 + 10% (임의 5% 가산)'),
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    row('벨라앤베카', 'Velra&Becca Active Daily Serum 50ml', '', '주식회사 픽오라(뷰티오라)', '픽오라(매입) / 픽오라(위탁)', 14100, '원본 위탁가 + 10%'),
    row('하이패브릭', '하이패브릭 섬유향수', '', '(주)한국무진유통', '무진', 3000)];
  const srcId = 'src0000000000000000000000000';
  env.drive.items[srcId] = { id: srcId, name: '뷰티오라 통합 상품리스트 · 벤더별 운영본', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [], trashed: false };
  env.sheets.addBook(srcId, '뷰티오라 통합 상품리스트 · 벤더별 운영본', { '뷰티오라': { values, images: { '2,2': 'img:bb', '3,2': 'img:ample', '5,2': 'img:serum', '6,2': 'img:perfume' } }, '무진': [['x']] });
  env.sheets.books[srcId].sheets[0].filter = true;
  const before = JSON.stringify(env.sheets.books[srcId]);

  const r = ok(env.api('products.mainBuild', { sourceUrl: 'https://docs.google.com/spreadsheets/d/' + srcId + '/edit?gid=1', sheetName: '뷰티오라', legacyFolderUrl: 'https://drive.google.com/drive/folders/' + legacyRoot }));
  assert.deepEqual(r.stats, { products: 4, vendor: 2, linkNotion: 2, linkWorkbook: 1, storeMain: 1, noLink: 1 });
  assert.deepEqual(r.report, ['섬네일: 설정 → 메인 상품목록 → 섬네일 넣기로 채워 주세요.']);
  assert.equal(JSON.stringify(env.sheets.books[srcId]), before, 'the integrated list is not changed');

  const bookId = /\/d\/([^/]+)/.exec(r.url)[1];
  const book = env.sheets.books[bookId];
  assert.deepEqual(book.sheets.map((s) => s.name), ['상품'], 'no price-basis tab');
  assert.equal(env.sheets.books[srcId].sheets.length, 2, 'source still has its tabs');
  const main = book.sheets[0];
  const col = (name) => main.cells[0].indexOf(name);
  assert.deepEqual(main.cells[0], ['상품 ID', '브랜드', '벤더', '이미지', '상품명', '구성', '카테고리', '바코드', '거래유형', '매입 공급가', '위탁 공급가', '위탁가 비고', '권장판매가', '매입 MOQ', '핵심포인트', '제품설명', '제품 링크', '링크 출처']);
  assert.deepEqual(main.cells.slice(1).map((x) => x[col('위탁가 비고')]), ['', '임의 5% 가산', '', ''], 'only the arbitrary 5% markup is carried over');
  const rows = main.cells.slice(1);
  assert.deepEqual(rows.map((x) => x[col('상품 ID')]), ['BP-00001', 'BP-00002', 'BP-00003', 'BP-00004']);
  assert.deepEqual(rows.map((x) => x[col('벤더')]), ['시온', '', '', '(주)한국무진유통'], 'vendor only for vendor products');
  assert.deepEqual(rows.map((x) => x[col('브랜드')]), ['[EYENLIP]', '루엠', '벨라앤베카', '하이패브릭']);
  assert.equal(rows[0][col('제품 링크')], 'https://shop.example/bb-cream', 'matched by barcode');
  assert.equal(rows[0][col('링크 출처')], 'Notion');
  assert.equal(rows[1][col('제품 링크')], 'https://ruem.kr/', 'matched by brand + name');
  assert.equal(rows[1][col('링크 출처')], 'Notion · 상품 개별 링크 아님');
  assert.equal(rows[2][col('제품 링크')], 'https://velra.example/serum');
  assert.equal(rows[2][col('링크 출처')], '기존 엑셀');
  assert.equal(rows[3][col('제품 링크')], '');
  assert.equal(rows[0][col('매입 MOQ')], 20);
  // Text columns stay text (no time/number conversion).
  assert.equal(main.formats[col('바코드') + 1], '@');
  assert.equal(rows[0][col('바코드')], '8809555252672');

  assert.equal(env.drive.items[bookId].parents[0], env.drive.root, 'kept in the brand material root folder');
  assert.equal(env.props.BO_MAIN_PRODUCT_SHEET_ID, bookId);
  assert.equal(ok(env.api('products.main')).url, r.url);
  assert.ok(Object.values(env.drive.items).filter((f) => /^\[임시\]/.test(f.name)).every((f) => f.trashed), 'temporary converted workbooks are trashed');

  assert.match(env.api('products.mainBuild', { sourceUrl: 'not a sheet' }).message, /통합 상품리스트 주소/);
  assert.match(env.api('products.mainBuild', { sourceUrl: srcId, sheetName: '없는탭' }).message, /"없는탭" 탭이 없습니다/);
});

test('thumbnails: image files from the catalog sheet are copied into our folder and written as IMAGE formulas', () => {
  const { env } = setup();
  const header = ['브랜드', '이미지', '상품명', '구성', '카테고리', '바코드', '공유 매입용 공급가', '공유 위탁용 공급가', '권장판매가', '매입MOQ', '핵심포인트', '제품설명', '거래유형', '실제 공급사', '운영 출처시트'];
  const row = (brand, name, barcode) => [brand, '', name, '', '', barcode, 1000, '', 2000, 1, '', '', '매입', '시온', '시온'];
  const srcId = 'src1111111111111111111111111';
  env.drive.items[srcId] = { id: srcId, name: '통합', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [], trashed: false };
  env.sheets.addBook(srcId, '통합', { '뷰티오라': [header, row('광동제약', '활력 밀크씨슬 750mg × 30캡슐', ''), row('다온', '세라 크림 50ml', '8801111111111'), row('없는브랜드', '사진 없는 상품', ''), row('A', '같은 이름', ''), row('B', '같은 이름', '')] });
  ok(env.api('products.mainBuild', { sourceUrl: srcId }));

  // Image files and the catalog sheet with IMAGE formulas (two tabs with different layouts).
  const pub = env.drive.folder('뷰티오라_상품목록_공개사진', null);
  const img = (n) => env.drive.file({ name: n, mimeType: 'image/jpeg', parents: [pub] }).id;
  const i1 = img('image1.jpg'), i2 = img('image2.jpg'), i3 = img('image3.jpg'), i4 = img('image4.jpg');
  const catId = 'cat2222222222222222222222222';
  env.sheets.addBook(catId, '공유용', {
    '상품 목록': [['상품 목록'], [''], [''], ['브랜드', '이미지', '상품명', '카테고리'], ['광동제약', '', '활력 밀크씨슬 750mg x 30캡슐', ''], ['A', '', '같은 이름', ''], ['C', '', '같은 이름', '']],
    '다온': [['품목구분', '', '브랜드', '제품사진', '제품명', '바코드'], ['', '', '다온', '', '세라 크림', '8801111111111']]
  });
  const book = env.sheets.books[catId];
  const f = (id) => '=IMAGE("https://lh3.googleusercontent.com/d/' + id + '",1)';
  book.sheets[0].formulas = { '5,2': f(i1), '6,2': f(i3), '7,2': f(i4) };
  book.sheets[1].formulas = { '2,4': f(i2) };

  const r = ok(env.api('products.mainImages', { imageSheetUrl: 'https://docs.google.com/spreadsheets/d/' + catId + '/edit' }));
  assert.equal(r.catalog, 4);
  assert.equal(r.filled, 3, JSON.stringify(r));
  assert.equal(r.unmatched, 2);
  assert.equal(r.remaining, 0);
  const main = env.sheets.books[env.props.BO_MAIN_PRODUCT_SHEET_ID].sheets[0];
  const folder = Object.values(env.drive.items).find((x) => x.folder && x.name === '메인 상품목록 이미지');
  const copyFor = (src) => Object.values(env.drive.items).find((x) => x.name === 'src_' + src && x.parents[0] === folder.id);
  assert.equal(main.formulas['2,4'], f(copyFor(i1).id), 'name match treats × and x alike');
  assert.equal(main.formulas['3,4'], f(copyFor(i2).id), 'matched by barcode');
  assert.equal(main.formulas['5,4'], f(copyFor(i3).id), 'same name: brand decides');
  assert.equal(main.formulas['4,4'], undefined);
  assert.equal(copyFor(i1).sharing, 'ANYONE_WITH_LINK:VIEW', 'IMAGE needs a link-viewable copy');
  assert.equal(env.drive.items[i1].sharing, undefined, 'the original file is not changed');
  // Running again copies nothing new and keeps existing images.
  const copies = env.drive.copies;
  const again = ok(env.api('products.mainImages', { imageSheetUrl: catId }));
  assert.equal(again.filled, 0);
  assert.equal(again.already, 3);
  assert.equal(env.drive.copies, copies);
});

test('brand folders: automatic processing starts at migration, without a checkbox or public sharing', () => {
  const { env, data } = setup();
  assert.ok(ok(env.api('brands.foldersSync')).skipped);
  env.call('setupBeautyora');
  const since = env.props.BO_BRAND_FOLDERS_START_AT;
  env.call('setupBeautyora');
  assert.equal(env.props.BO_BRAND_FOLDERS_START_AT, since);
  const added = env.notion.createPage(data.ids.brandId, { '브랜드명': { title: [{ text: { content: '신규' } }] }, '브랜드 ID': { rich_text: [{ text: { content: 'BO-0004' } }] } });
  const page = env.notion.pages[added.id];
  page.created_time = new Date(Math.floor(Date.parse(since) / 60000) * 60000).toISOString();
  [data.b2, data.b3].forEach(b => { env.notion.pages[b.id].created_time = '2020-01-01T00:00:00.000Z'; });
  const r = ok(env.api('brands.foldersSync'));
  assert.deepEqual(r.created.map(c => c.code), ['BO-0004']);
  assert.deepEqual(r.failed, []);
  const folder = Object.values(env.drive.items).find(x => x.name === '회사 미확인 | 신규 [BO-0004]');
  assert.equal(folder.sharing, undefined);
  assert.deepEqual(Object.values(env.drive.items).filter(x => x.parents[0] === folder.id).map(x => x.name).sort(), ['01_섬네일', '02_상세페이지', '03_서류']);
  assert.equal(page.properties['구글 드라이브'].url, 'https://drive.google.com/drive/folders/' + folder.id);
  assert.deepEqual(ok(env.api('brands.foldersSync')).created, []);
  assert.ok(!(env.notion.pages[data.b2.id].properties['구글 드라이브'] || {}).url);
});

test('brand folders: ID assignment can lag registration and duplicate IDs fail closed', () => {
  const { env, data } = setup();
  env.props.BO_BRAND_FOLDERS_BASELINE = JSON.stringify({ since: '2000-01-01T00:00:00.000Z', chunks: 0, count: 0 });
  const page = env.notion.pages[data.b1.id], original = page.properties['브랜드 ID'];
  page.properties['브랜드 ID'] = { type: 'rich_text', rich_text: [] };
  assert.ok(!ok(env.api('brands.foldersSync')).created.some(c => c.code === 'BO-0001'));
  page.properties['브랜드 ID'] = original;
  assert.deepEqual(ok(env.api('brands.foldersSync')).created.map(c => c.code), ['BO-0001']);
  env.notion.pages[data.b2.id].properties['브랜드 ID'] = original;
  assert.equal(env.api('brands.folder', { code: 'BO-0001' }).ok, false);
});

test('brand folders: partial failure and renamed brand reuse pending folder, files, and legacy image directory', () => {
  const { env, data } = setup();
  env.props.BO_BRAND_FOLDERS_BASELINE = JSON.stringify({ since: '2000-01-01T00:00:00.000Z', chunks: 0, count: 0 });
  const old = env.drive.folder('[BO-0001] 루엠', env.drive.root);
  env.drive.items[old].sharing = 'PRIVATE:EDIT';
  const images = env.drive.folder('01_상품 이미지', old);
  const asset = env.drive.file({ name: 'existing.jpg', parents: [images] });
  env.props.BO_TEMPLATE_FILE_ID = 'missing-template';
  const r = ok(env.api('brands.foldersSync'));
  assert.equal(r.failed.length, 3);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + data.b1.id], old);
  const template = env.drive.file({ name: '양식.xlsx', parents: [env.drive.root] });
  env.props.BO_TEMPLATE_FILE_ID = template.id;
  env.notion.pages[data.b1.id].properties['브랜드명'] = { type: 'title', title: [{ plain_text: '새 이름', text: { content: '새 이름' } }] };
  assert.equal(ok(env.api('brands.foldersSync')).failed.length, 0);
  assert.equal(env.notion.pages[data.b1.id].properties['구글 드라이브'].url, 'https://drive.google.com/drive/folders/' + old);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + data.b1.id], undefined);
  assert.equal(env.drive.items[old].sharing, 'PRIVATE:EDIT');
  assert.ok(env.drive.items[asset.id]);
  assert.ok(!Object.values(env.drive.items).some(x => x.parents[0] === old && x.name === '01_섬네일'));
  const before = Object.keys(env.drive.items).length;
  ok(env.api('brands.folder', { code: 'BO-0001' }));
  assert.equal(Object.keys(env.drive.items).length, before);
});

test('brand folders: Notion write failure retries without duplicate folders or template copies', () => {
  const { env, data } = setup();
  env.props.BO_TEMPLATE_FILE_ID = env.drive.file({ name: '양식.xlsx', parents: [env.drive.root] }).id;
  const patch = env.context.notionPatch_;
  env.context.notionPatch_ = () => { throw new Error('Notion unavailable'); };
  assert.equal(env.api('brands.folder', { code: 'BO-0001' }).ok, false);
  const count = Object.keys(env.drive.items).length;
  env.context.notionPatch_ = patch;
  assert.equal(ok(env.api('brands.folder', { code: 'BO-0001' })).created, true);
  assert.equal(Object.keys(env.drive.items).length, count);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + data.b1.id], undefined);
});

test('brand folders: linked folders repair only missing children, invalid links and ambiguous roots fail safely', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('existing', env.drive.root);
  env.drive.folder('01_섬네일', folder);
  const p = env.notion.pages[data.b1.id];
  p.properties['구글 드라이브'] = { type: 'url', url: 'https://drive.google.com/drive/folders/' + folder };
  assert.equal(ok(env.api('brands.folder', { code: 'BO-0001' })).created, false);
  assert.equal(Object.values(env.drive.items).filter(x => x.parents[0] === folder).length, 3);
  p.properties['구글 드라이브'].url = 'https://example.com';
  assert.equal(env.api('brands.folder', { code: 'BO-0001' }).ok, false);
  env.drive.folder('A (BO-0002)', env.drive.root);
  env.drive.folder('B (BO-0002)', env.drive.root);
  assert.equal(env.api('brands.folder', { code: 'BO-0002' }).ok, false);
});

test('brand folders: interrupted child creation resumes under the same parent', () => {
  const { env, data } = setup();
  // This test isolates interruption recovery from shared-business grouping.
  env.notion.pages[data.b3.id].properties['사업자 번호'] = { type: 'rich_text', rich_text: [] };
  const folderApi = env.drive.folderApi.bind(env.drive);
  let fail = true;
  env.drive.folderApi = id => {
    const api = folderApi(id), create = api.createFolder;
    api.createFolder = name => {
      if (name === '02_상세페이지' && fail) { fail = false; throw new Error('interrupted'); }
      return create(name);
    };
    return api;
  };
  assert.equal(env.api('brands.folder', { code: 'BO-0001' }).ok, false);
  ok(env.api('brands.folder', { code: 'BO-0001' }));
  const parents = Object.values(env.drive.items).filter(x => x.name === '루엠 주식회사 | 루엠 [BO-0001]');
  assert.equal(parents.length, 1);
  assert.deepEqual(Object.values(env.drive.items).filter(x => x.parents[0] === parents[0].id).map(x => x.name).sort(), ['01_섬네일', '02_상세페이지', '03_서류']);
});

test('brand folders: installed trigger remains usable after migration and foreign trigger is rejected', () => {
  const { env } = setup();
  env.call('setupBeautyora');
  env.call('setupBeautyora');
  const uid = env.triggers.find(t => t.getHandlerFunction() === 'scheduledBrandFolders').getUniqueId();
  assert.equal(env.triggers.filter(t => t.getHandlerFunction() === 'scheduledBrandFolders').length, 1);
  assert.doesNotThrow(() => env.call('scheduledBrandFolders', { triggerUid: uid }));
  assert.throws(() => env.call('scheduledBrandFolders', { triggerUid: 'foreign' }));
});


test('setup retains existing triggers if a replacement cannot be created', () => {
  const { env } = setup();
  env.call('setupBeautyora');
  const original = env.triggers.slice();
  env.context.ScriptApp.newTrigger = () => { throw new Error('trigger quota exceeded'); };
  const result = ok(env.api('system.setup'));
  assert.equal(result.ok, false);
  assert.deepEqual(env.triggers, original);
});

function addFolderTestBrand(env, data, code, created) {
  const page = env.notion.createPage(data.ids.brandId, {
    '브랜드명': { title: [{ text: { content: code } }] },
    '브랜드 ID': { rich_text: [{ text: { content: code } }] }
  });
  if (created) env.notion.pages[page.id].created_time = created;
  return page;
}

test('baseline: same-minute old pages are excluded and registrations during/after activation are processed', () => {
  const { env, data } = setup();
  const minute = '2026-10-04T13:52:00.000Z';
  env.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-04T13:52:30.000Z'])); }
    static now() { return Date.parse('2026-10-04T13:52:30.000Z'); }
  };
  Object.values(env.notion.pages).forEach(p => { p.created_time = minute; });
  // New registration after the snapshot read but before manifest commit must not be lost.
  const query = env.context.notionQueryAll_;
  let concurrent;
  env.context.notionQueryAll_ = (...args) => {
    const result = query(...args);
    if (!concurrent && !args[1].filter) concurrent = addFolderTestBrand(env, data, 'BO-0100', minute);
    return result;
  };
  env.call('setupBeautyora');
  env.context.notionQueryAll_ = query;
  addFolderTestBrand(env, data, 'BO-0101', minute);
  addFolderTestBrand(env, data, 'BO-0102', '2026-10-04T13:53:00.000Z');
  const baseline = env.props.BO_BRAND_FOLDERS_BASELINE;
  env.call('setupBeautyora');
  assert.equal(env.props.BO_BRAND_FOLDERS_BASELINE, baseline, 'rerun never re-snapshots new registrations');
  assert.deepEqual(ok(env.api('brands.foldersSync')).created.map(x => x.code).sort(), ['BO-0100', 'BO-0101', 'BO-0102']);
  for (const old of [data.b1, data.b2, data.b3]) assert.ok(!(env.notion.pages[old.id].properties['구글 드라이브'] || {}).url);
});

test('baseline: paginated existing brands are chunked and never backfilled', () => {
  const { env, data } = setup();
  for (let i = 4; i <= 132; i++) addFolderTestBrand(env, data, 'BO-' + String(i).padStart(4, '0'));
  env.call('setupBeautyora');
  const baseline = JSON.parse(env.props.BO_BRAND_FOLDERS_BASELINE);
  assert.equal(baseline.count, 132);
  assert.equal(baseline.chunks, 2);
  for (let i = 0; i < baseline.chunks; i++) assert.ok(Buffer.byteLength(env.props['BO_BRAND_FOLDERS_EXCLUDED_' + i]) < 9000);
  assert.deepEqual(ok(env.api('brands.foldersSync')).created, []);
});

test('baseline: query failure or interrupted snapshot save leaves automatic processing disabled', () => {
  const { env } = setup();
  const query = env.context.notionQueryAll_;
  env.context.notionQueryAll_ = () => { throw new Error('snapshot unavailable'); };
  assert.equal(ok(env.api('system.setup')).ok, false);
  assert.equal(env.props.BO_BRAND_FOLDERS_BASELINE, undefined);
  assert.ok(ok(env.api('brands.foldersSync')).skipped);
  env.context.notionQueryAll_ = query;
  const properties = env.context.PropertiesService.getScriptProperties;
  env.context.PropertiesService.getScriptProperties = () => {
    const store = properties(), save = store.setProperty;
    store.setProperty = (key, value) => {
      if (key === 'BO_BRAND_FOLDERS_BASELINE') throw new Error('interrupted manifest save');
      save(key, value);
    };
    return store;
  };
  assert.equal(ok(env.api('system.setup')).ok, false);
  assert.ok(env.props.BO_BRAND_FOLDERS_EXCLUDED_0, 'partial snapshot exists');
  assert.ok(ok(env.api('brands.foldersSync')).skipped);
  env.context.PropertiesService.getScriptProperties = properties;
  assert.equal(ok(env.api('system.setup')).ok, true);
  assert.deepEqual(ok(env.api('brands.foldersSync')).created, []);
  delete env.props.BO_BRAND_FOLDERS_EXCLUDED_0;
  assert.equal(env.api('brands.foldersSync').ok, false, 'missing snapshot never permits backfill');
  assert.equal(ok(env.api('system.setup')).ok, false, 'corrupt committed baseline is never silently replaced');
});

test('baseline: property capacity exhaustion fails closed before activation', () => {
  const { env } = setup();
  for (let i = 0; i < 20; i++) env.props['UNRELATED_CONFIGURATION_' + i] = 'x'.repeat(7000);
  const result = ok(env.api('system.setup'));
  assert.equal(result.ok, false);
  assert.equal(env.props.BO_BRAND_FOLDERS_BASELINE, undefined);
  assert.ok(ok(env.api('brands.foldersSync')).skipped);
  assert.equal(env.props.UNRELATED_CONFIGURATION_0.length, 7000);
});

test('deployment: production target guard fails closed without exposing configured IDs', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'verify-deploy-target.cjs');
  const { EXPECTED_PRODUCTION_SCRIPT_ID } = require(script);
  const run = env => spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  const correct = run({ TARGET: 'production', PROD_SCRIPT_ID: EXPECTED_PRODUCTION_SCRIPT_ID });
  assert.equal(correct.status, 0);
  assert.match(correct.stdout, /운영 프로젝트 확인: 일치/);
  assert.ok(!correct.stdout.includes(EXPECTED_PRODUCTION_SCRIPT_ID));
  for (const value of ['', 'unused-project-sentinel', EXPECTED_PRODUCTION_SCRIPT_ID + ' ']) {
    const wrong = run({ TARGET: 'production', PROD_SCRIPT_ID: value });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /운영 프로젝트 불일치 또는 미설정/);
    if (value) assert.ok(!(wrong.stdout + wrong.stderr).includes(value));
  }
  assert.equal(run({ TARGET: 'test', PROD_SCRIPT_ID: 'unused-project-sentinel' }).status, 0);
  assert.equal(run({ TARGET: 'unknown' }).status, 1);
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'apps-script-deploy.yml'), 'utf8');
  const guard = workflow.indexOf('node scripts/verify-deploy-target.cjs');
  assert.ok(guard > 0 && guard < workflow.indexOf('> .clasp.json'));
  assert.ok(guard < workflow.indexOf('- name: Google 인증 준비'));
  assert.ok(guard < workflow.indexOf('clasp@3 push'));
});
