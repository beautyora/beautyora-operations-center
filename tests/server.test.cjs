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

test('setup installs the health-check trigger and removes leftover triggers such as the old form trigger', () => {
  const { env } = setup();
  // 예전 버전이 설치한 입점 신청 폼 트리거(지금은 별도 프로젝트가 담당).
  env.call('(function () { ScriptApp.newTrigger("onBrandFormSubmit").forForm("form-1").onFormSubmit().create(); })');
  const res = ok(env.api('system.setup'));
  assert.equal(res.ok, true, res.report.join('\n'));
  assert.ok(res.report.includes('삭제: 예전 트리거 onBrandFormSubmit'), res.report.join('\n'));
  assert.deepEqual(env.triggers.map((t) => t.getHandlerFunction()), ['scheduledHealthCheck', 'scheduledBrandFolders']);
  const again = ok(env.api('system.setup'));
  assert.deepEqual(again.report, ['변경할 설정이 없습니다. 이미 준비되어 있습니다.']);
  assert.equal(again.health.ok, true, JSON.stringify(again.health.results));
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
  assert.deepEqual(publicFns.sort(), ['api', 'doGet', 'runHealthCheck', 'scheduledBrandFolders', 'scheduledHealthCheck', 'setupBeautyora'].sort());
  const { env } = setup();
  env.setUser('');
  assert.throws(() => env.call('runHealthCheck'), /계정/);
  assert.throws(() => env.call('scheduledHealthCheck', {}), /트리거/);
});

test('removed features leave no traces in the code', () => {
  const root = path.join(__dirname, '..');
  const files = fs.readdirSync(path.join(root, 'src')).map((f) => path.join(root, 'src', f));
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  ['doPost', 'partner', 'idToken', 'google.accounts', 'BO_GOOGLE_CLIENT_ID', 'BO_PARTNER_WEBAPP_URL', 'BO_GOOGLE_FORM_ID', 'onBrandFormSubmit(']
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

test('brand folders: Notion checkbox (trigger) or the button creates the folder once and writes its URL to 구글 드라이브', () => {
  const { env, data } = setup();
  const templateId = env.drive.file({ name: '매입정보_취합파일.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: [env.drive.root] }).id;
  env.props.BO_TEMPLATE_FILE_ID = templateId;
  const page = (p) => env.notion.pages[p.id];
  const driveOf = (id) => (page(id).properties['구글 드라이브'] || {}).url || null;
  const children = (parent) => Object.values(env.drive.items).filter((x) => x.parents[0] === parent && !x.trashed).map((x) => x.name).sort();
  // 체크된 브랜드만 처리한다.
  page(data.b1).properties['드라이브 폴더 만들기'] = { checkbox: true };
  const r = ok(env.api('brands.foldersSync'));
  assert.deepEqual(r.created.map((c) => c.code), ['BO-0001']);
  assert.deepEqual(r.failed, []);
  const folder = Object.values(env.drive.items).find((x) => x.folder && x.name === '루엠 (BO-0001)');
  assert.ok(folder && folder.parents[0] === env.drive.root, 'folder under the root');
  assert.equal(driveOf(data.b1), 'https://drive.google.com/drive/folders/' + folder.id);
  assert.equal(folder.sharing, 'ANYONE_WITH_LINK:EDIT', 'brands upload through the link');
  assert.deepEqual(children(folder.id), ['01_상품 이미지', '02_상세페이지', '03_서류', '루엠_매입정보_취합파일.xlsx']);
  assert.equal(driveOf(data.b2), null, 'unchecked brand untouched');
  // 다시 돌려도 새로 만들지 않는다(구글 드라이브가 채워져 있음).
  assert.deepEqual(ok(env.api('brands.foldersSync')).created, []);
  // 버튼: 체크 없이 바로 만든다. 이미 주소가 있으면 그대로 돌려준다.
  const b = ok(env.api('brands.folder', { code: 'BO-0002' }));
  assert.equal(b.created, true);
  assert.equal(driveOf(data.b2), b.url);
  assert.equal(ok(env.api('brands.folder', { code: 'BO-0002' })).created, false);
  assert.equal(Object.values(env.drive.items).filter((x) => x.folder && x.name === '셀리본 (BO-0002)').length, 1);
});
