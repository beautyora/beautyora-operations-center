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
  assert.deepEqual(env.triggers.map((t) => t.getHandlerFunction()), ['scheduledHealthCheck']);
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
  assert.deepEqual(publicFns.sort(), ['api', 'doGet', 'runHealthCheck', 'scheduledHealthCheck', 'setupBeautyora'].sort());
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
