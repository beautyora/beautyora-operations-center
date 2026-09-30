'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, seed } = require('./harness.cjs');

function setup(opts) {
  const env = createEnv(opts);
  const data = seed(env, opts);
  return { env, data };
}

function ok(result) {
  assert.equal(result.ok, true, result.message);
  return JSON.parse(JSON.stringify(result.data));
}

function textOf(page, name) {
  const p = page.properties[name];
  if (!p) return undefined;
  const v = p[p.type];
  if (p.type === 'title' || p.type === 'rich_text') return v.map((t) => t.plain_text).join('');
  if (p.type === 'select') return v ? v.name : '';
  if (p.type === 'relation') return v.map((r) => r.id);
  return v;
}

function issueToken(env, code) {
  const res = ok(env.api('links.issue', { code: code || 'BO-0001', days: 30 }));
  return new URL(res.url).searchParams.get('token');
}

test('setup adds missing Notion properties, link DB, and triggers', () => {
  const { env } = setup({ skipDiscovery: true });
  const res = ok(env.api('system.setup'));
  assert.ok(res.report.some((l) => l.includes('검수 메모')));
  assert.ok(res.report.some((l) => l.includes('상품등록 링크')));
  assert.ok(env.props.BO_NOTION_LINK_DATA_SOURCE_ID);
  assert.ok(res.report.some((l) => l.includes('계산서 · 입금 내역')));
  assert.ok(env.props.BO_NOTION_BILLING_DATA_SOURCE_ID, 'billing DB created');
  ['계약서 발송', '입점 입금', '입점 계산서'].forEach((name) => assert.ok(res.report.some((l) => l.includes('"' + name + '"')), name));
  const brandSource = env.notion.sources[env.props.BO_NOTION_BRAND_DATA_SOURCE_ID];
  assert.deepEqual(brandSource.properties['계약서 발송'].select.options.map((o) => o.name), ['미발송', '발송 완료', '서명 완료', '해당 없음']);
  assert.ok(env.props.BO_NOTION_TERMS_DATA_SOURCE_ID, 'terms discovered via relation');
  assert.ok(env.props.BO_NOTION_MOVEMENT_DATA_SOURCE_ID, 'movement discovered');
  assert.ok(env.props.BO_NOTION_STORE_DATA_SOURCE_ID, 'store discovered');
  assert.ok(env.props.BO_NOTION_INVENTORY_DATA_SOURCE_ID, 'inventory discovered');
  assert.ok(env.triggers.some((t) => t.getHandlerFunction() === 'scheduledHealthCheck'));
  const again = ok(env.api('system.setup'));
  assert.deepEqual(again.report, ['변경할 설정이 없습니다. 이미 준비되어 있습니다.']);
});

test('non-admin users are rejected for every admin action', () => {
  const { env } = setup();
  env.setUser('stranger@gmail.com');
  const actions = Object.keys(env.call('adminActions_'));
  actions.forEach((action) => {
    const res = env.api(action, {});
    assert.equal(res.ok, false, action);
    assert.equal(res.code, 'NOT_ADMIN', action);
  });
  env.setUser('');
  assert.equal(env.api('dashboard').code, 'NO_EMAIL');
});

test('dashboard counts intake, review, and stock checks', () => {
  const { env } = setup();
  ok(env.api('system.setup'));
  const d = ok(env.api('dashboard'));
  assert.equal(d.counts.intake, 1);
  assert.equal(d.counts.review, 1);
  assert.equal(d.counts.stockCheck, 1);
  assert.equal(d.totals.brands, 3);
  assert.equal(d.totals.products, 3);
});

test('partner flow: link → bootstrap → upload → submit new product → review approve', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const token = await_(issueToken(env));
  const boot = ok(env.api('partner.bootstrap', {}, token));
  assert.equal(boot.brand.code, 'BO-0001');
  assert.equal(boot.products.length, 2);
  assert.ok(boot.fields.some((f) => f.id === 'product_name' && f.required));
  assert.ok(boot.fields.some((f) => f.id === 'main_image_url' && f.type === 'asset'));
  const productId = 'PRD-NEW-00000001';
  const base64 = Buffer.from('fake image').toString('base64');
  const up1 = ok(env.api('partner.upload', { kind: 'asset', productId, category: '대표 이미지', uploadId: 'UP-000000001', fileName: 'main.jpg', mimeType: 'image/jpeg', base64 }, token));
  const again = ok(env.api('partner.upload', { kind: 'asset', productId, category: '대표 이미지', uploadId: 'UP-000000001', fileName: 'main.jpg', mimeType: 'image/jpeg', base64 }, token));
  assert.equal(up1.file.id, again.file.id, 'upload is idempotent');
  ok(env.api('partner.upload', { kind: 'asset', productId, category: '상세페이지', uploadId: 'UP-000000002', fileName: 'detail.pdf', mimeType: 'application/pdf', base64 }, token));

  const missing = ok(env.api('partner.submit', { requestId: 'REQ-00000001', contactName: '김담당', products: [{ productId, data: { product_name: '새 토너' } }] }, token));
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0].messages.join(' '), /바코드|카테고리|소비자가/);

  const submit = ok(env.api('partner.submit', { requestId: 'REQ-00000002', contactName: '김담당', contactPhone: '010-1111-2222', products: [{ productId, data: { product_name: '새 토너', barcode: '8800000000099', category: ['스킨케어(베이직)'], retail_price: '18,000' } }] }, token));
  assert.equal(submit.ok, true, JSON.stringify(submit));
  assert.equal(submit.results[0].mode, 'create');
  const page = Object.values(env.notion.pages).find((p) => textOf(p, '운영센터 상품 ID') === productId);
  assert.equal(textOf(page, '등록 검수 상태'), '검수 대기');
  assert.equal(textOf(page, '소비자가'), 18000);
  assert.deepEqual(textOf(page, '브랜드'), [data.b1.id]);
  assert.match(textOf(page, '대표 이미지 Drive URL'), /drive\.google\.com\/drive\/folders\//);
  assert.equal(textOf(page, '제출자'), '김담당 / 010-1111-2222');

  const dup = ok(env.api('partner.submit', { requestId: 'REQ-00000002', contactName: '김담당', products: [] }, token));
  assert.equal(dup.duplicate, true, 'same request id returns stored result');

  const queue = ok(env.api('review.queue'));
  const item = queue.items.find((i) => i.productId === productId);
  assert.equal(item.kind, 'new');
  const detail = ok(env.api('review.detail', { pageId: item.pageId }));
  assert.ok(detail.assets.length === 2);
  const decide = env.api('review.decide', { pageId: item.pageId, kind: 'new', action: 'revision', note: '', expectedSubmittedAt: item.submittedAt });
  assert.equal(decide.ok, false, 'revision needs a note');
  ok(env.api('review.decide', { pageId: item.pageId, kind: 'new', action: 'approve', expectedSubmittedAt: item.submittedAt }));
  assert.equal(textOf(env.notion.pages[item.pageId], '등록 검수 상태'), '승인 완료');
  assert.ok(env.notion.comments.some((c) => c.text.includes('승인 완료')));
});

test('approved product edits become change requests and apply only on approval', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const token = await_(issueToken(env));
  const base64 = Buffer.from('x').toString('base64');
  ['대표 이미지', '상세페이지'].forEach((category, i) => ok(env.api('partner.upload', { kind: 'asset', productId: 'PRD-0001-AAAA', category, uploadId: 'UP-CHG-0000' + i, fileName: i ? 'd.pdf' : 'm.png', mimeType: i ? 'application/pdf' : 'image/png', base64 }, token)));
  const res = ok(env.api('partner.submit', { requestId: 'REQ-CHG-000001', contactName: '박담당', products: [{ productId: 'PRD-0001-AAAA', data: { product_name: '시카 리페어 앰플 50ml', barcode: '8800000000011', category: ['스킨케어(베이직)'], retail_price: 27000 } }] }, token));
  assert.equal(res.results[0].mode, 'change');
  const page = env.notion.pages[data.p1.id];
  assert.equal(textOf(page, '상품명'), '시카 리페어 앰플', 'not applied before review');
  assert.equal(textOf(page, '변경 요청'), '검수 대기');
  const detail = ok(env.api('review.detail', { pageId: data.p1.id }));
  assert.ok(detail.change.diff.some((d) => d.label === '상품명' && d.after === '시카 리페어 앰플 50ml'));
  assert.ok(detail.change.diff.some((d) => d.label === '소비자가' && d.before === '25000' && d.after === '27000'));
  ok(env.api('review.decide', { pageId: data.p1.id, kind: 'change', action: 'approve' }));
  assert.equal(textOf(page, '상품명'), '시카 리페어 앰플 50ml');
  assert.equal(textOf(page, '소비자가'), 27000);
  assert.equal(textOf(page, '변경 요청'), '반영 완료');
  const toggle = env.notion.blocks[data.p1.id].find((b) => b.type === 'toggle');
  assert.match(toggle.toggle.rich_text[0].plain_text, /^✅ 반영됨/);
});

test('partner cannot touch another brand product or reuse its barcode', () => {
  const { env } = setup();
  ok(env.api('system.setup'));
  const token = await_(issueToken(env, 'BO-0001'));
  const base64 = Buffer.from('x').toString('base64');
  const r1 = ok(env.api('partner.submit', { requestId: 'REQ-X-0000001', contactName: 'a', products: [{ productId: 'PRD-0003-CCCC', data: { product_name: '탈취' } }] }, token));
  assert.equal(r1.ok, false);
  assert.match(r1.problems[0].messages[0], /다른 브랜드/);
  ['대표 이미지', '상세페이지'].forEach((category, i) => ok(env.api('partner.upload', { kind: 'asset', productId: 'PRD-NEW-BARCODE1', category, uploadId: 'UP-BC-00000' + i, fileName: 'a.png', mimeType: 'image/png', base64 }, token)));
  const r2 = ok(env.api('partner.submit', { requestId: 'REQ-X-0000002', contactName: 'a', products: [{ productId: 'PRD-NEW-BARCODE1', data: { product_name: '신상', barcode: '8800000000035', category: ['메이크업'], retail_price: 1000 } }] }, token));
  assert.equal(r2.ok, false);
  assert.match(r2.problems[0].messages.join(' '), /바코드/);
  const assets = env.api('partner.assets', { productId: 'PRD-0003-CCCC' }, token);
  assert.deepEqual(ok(assets).assets, [], 'other brand assets are not listed');
});

test('invalid, stopped, and expired tokens are rejected', () => {
  const { env } = setup();
  ok(env.api('system.setup'));
  assert.equal(env.api('partner.bootstrap', {}, 'nope').code, 'BAD_TOKEN');
  assert.equal(env.api('partner.bootstrap', {}, 'a'.repeat(48)).code, 'BAD_TOKEN');
  const token = await_(issueToken(env));
  ok(env.api('partner.bootstrap', {}, token));
  const second = await_(issueToken(env));
  assert.equal(env.api('partner.bootstrap', {}, token).code, 'BAD_TOKEN', 'old link stopped when a new one is issued');
  ok(env.api('partner.bootstrap', {}, second));
  const links = ok(env.api('brands.links', { code: 'BO-0001' })).links;
  const active = links.find((l) => l.active);
  ok(env.api('links.stop', { pageId: active.pageId }));
  assert.equal(env.api('partner.bootstrap', {}, second).code, 'BAD_TOKEN');
  // Partner token must not unlock admin actions.
  const third = await_(issueToken(env));
  env.setUser('');
  assert.equal(env.api('brands.list', {}, third).ok, false);
});

test('intake: form response creates Notion brand once, duplicates become comments', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  env.props.BO_GOOGLE_FORM_ID = 'form-1';
  const response = (id, answers) => ({
    getId: () => id, getTimestamp: () => new Date('2026-09-28T03:00:00Z'),
    getItemResponses: () => Object.keys(answers).map((title) => ({ getItem: () => ({ getTitle: () => title }), getResponse: () => answers[title] }))
  });
  const r1 = response('resp-1', { '회사명': '그린랩', '브랜드명': '그린랩, 블루랩(서브, 라인)', '사업자번호': '1234567890', '담당자명': '이담당', '담당자 연락처': '01012345678', '희망 거래 방식': '위탁, 알수없음', '(현재) 판매 채널': '자사몰' });
  const out = JSON.parse(JSON.stringify(env.call('processFormResponse_', response('resp-1', { '회사명': '그린랩', '브랜드명': '그린랩, 블루랩(서브, 라인)', '사업자번호': '1234567890', '담당자명': '이담당', '담당자 연락처': '01012345678', '희망 거래 방식': '위탁, 알수없음', '(현재) 판매 채널': '자사몰' }))));
  assert.deepEqual(out.map((o) => o.action), ['created', 'created']);
  assert.deepEqual(out.map((o) => o.code), ['BO-0004', 'BO-0005']);
  const page = Object.values(env.notion.pages).find((p) => textOf(p, '브랜드명') === '블루랩(서브, 라인)');
  assert.equal(textOf(page, '진행 단계'), '접수·검토');
  assert.equal(textOf(page, '재영업 분류'), '신규 · 상품 미등록', 'new brands start as 신규 · 상품 미등록');
  assert.equal(textOf(page, '연락처'), '010-1234-5678');
  assert.equal(textOf(page, '사업자 번호'), '123-45-67890');
  assert.equal(textOf(page, '현재 판매 채널'), '자사몰', '"(현재) 판매 채널" is not confused with "판매 채널"');
  assert.match(textOf(page, '핵심 메모'), /알수없음/);
  assert.ok(env.notion.comments.some((c) => c.text.includes('같은 사업자번호') && c.text.includes('루엠')));
  const again = JSON.parse(JSON.stringify(env.call('processFormResponse_', r1)));
  assert.deepEqual(again.map((o) => o.action), ['skipped', 'skipped']);
  const dup = env.call('processFormResponse_', response('resp-2', { '브랜드명': '루엠', '담당자명': '최' }));
  assert.equal(dup[0].action, 'duplicate');
  assert.ok(env.notion.comments.some((c) => c.page === data.b1.id && c.text.includes('다시 접수')));

  const list = ok(env.api('intake.list'));
  assert.equal(list.items.length, 3);
  assert.ok(!list.stages.includes('접수·검토'));
  ok(env.api('intake.decide', { code: 'BO-0003', stage: '통화 예정', note: '다음 주 통화', startOnboard: true }));
  assert.equal(textOf(env.notion.pages[data.b3.id], '진행 단계'), '통화 예정');
  assert.equal(textOf(env.notion.pages[data.b3.id], '계약서 발송'), '미발송', 'onboarding checklist started');
  assert.equal(textOf(env.notion.pages[data.b3.id], '입점 입금'), '입금 대기');
  assert.equal(textOf(env.notion.pages[data.b3.id], '입점 계산서'), '발행 대기');
  assert.equal(env.api('intake.decide', { code: 'BO-0003', stage: '확정' }).ok, false, 'already processed');
});

test('form trigger entry point refuses calls that are not from an installed trigger', () => {
  const { env } = setup();
  assert.throws(() => env.call('onBrandFormSubmit', { triggerUid: 'forged' }), /트리거/);
  assert.throws(() => env.call('scheduledHealthCheck', {}), /트리거/);
  env.setUser('stranger@gmail.com');
  assert.throws(() => env.call('setupBeautyora'), /소유자 또는 관리자/);
  assert.throws(() => env.call('migrateLegacySheets'), /소유자 또는 관리자/);
});

test('brand edit uses optimistic concurrency and protects system fields', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const detail = ok(env.api('brands.detail', { code: 'BO-0002' }));
  const memo = detail.properties.find((p) => p.name === '핵심 메모');
  const codeProp = detail.properties.find((p) => p.name === '브랜드 ID');
  assert.equal(codeProp.editable, false);
  const blocked = env.api('brands.update', { code: 'BO-0002', lastEditedAt: detail.lastEditedAt, changes: [{ id: codeProp.id, value: 'BO-9999' }] });
  assert.equal(blocked.ok, false);
  const saved = ok(env.api('brands.update', { code: 'BO-0002', lastEditedAt: detail.lastEditedAt, changes: [{ id: memo.id, value: '9월 샘플 발송' }] }));
  assert.equal(textOf(env.notion.pages[data.b2.id], '핵심 메모'), '9월 샘플 발송');
  const stale = env.api('brands.update', { code: 'BO-0002', lastEditedAt: detail.lastEditedAt, changes: [{ id: memo.id, value: 'x' }] });
  assert.equal(stale.code, 'CONFLICT');
  ok(env.api('brands.update', { code: 'BO-0002', lastEditedAt: saved.lastEditedAt, changes: [{ id: memo.id, value: 'y' }] }));
  const priority = detail.properties.find((p) => p.name === '우선순위');
  const bad = env.api('brands.update', { code: 'BO-0002', changes: [{ id: priority.id, value: '0순위' }] });
  assert.match(bad.message, /선택지/);
});

test('inventory movement updates stock and records history; refuses negative stock and stale input', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const inv = ok(env.api('inventory.list', {}));
  assert.equal(inv.rows.length, 1);
  const row = inv.rows[0];
  assert.equal(row.productName, '시카 리페어 앰플');
  assert.equal(row.brandCode, 'BO-0001');
  const res = ok(env.api('inventory.record', { requestId: 'MOV-0000001', inventoryPageId: row.pageId, direction: '-', qty: 3, kind: '재고 조정', expectedStock: 10 }));
  assert.equal(res.after, 7);
  assert.equal(textOf(env.notion.pages[data.inv.id], '실재고'), 7);
  const movement = Object.values(env.notion.pages).find((p) => p.parent.data_source_id === data.ids.movementId);
  assert.equal(textOf(movement, '수량 (+/-)'), -3);
  assert.equal(textOf(movement, '입출고 방향'), '-');
  const dup = ok(env.api('inventory.record', { requestId: 'MOV-0000001', inventoryPageId: row.pageId, direction: '-', qty: 3, expectedStock: 10 }));
  assert.equal(dup.duplicate, true);
  assert.equal(textOf(env.notion.pages[data.inv.id], '실재고'), 7, 'retry does not double count');
  assert.equal(env.api('inventory.record', { requestId: 'MOV-0000002', inventoryPageId: row.pageId, direction: '-', qty: 1, expectedStock: 10 }).code, 'CONFLICT');
  assert.match(env.api('inventory.record', { requestId: 'MOV-0000003', inventoryPageId: row.pageId, direction: '-', qty: 99 }).message, /현재 재고/);
  env.notion.failNext = Object.assign(/^POST \/pages$/, { status: 400 });
  const failed = env.api('inventory.record', { requestId: 'MOV-0000004', inventoryPageId: row.pageId, direction: '+', qty: 5 });
  assert.equal(failed.ok, false);
  assert.equal(textOf(env.notion.pages[data.inv.id], '실재고'), 7, 'stock reverted when history write fails');
  const created = ok(env.api('inventory.record', { requestId: 'MOV-0000005', productPageId: data.p3.id, storePageId: data.s1.id, direction: '+', qty: 4, kind: '최초 입고' }));
  assert.equal(created.after, 4);
});

test('activities: add, list, follow-up on dashboard, complete', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const today = env.call('today_');
  ok(env.api('activities.add', { requestId: 'ACT-00000001', code: 'BO-0002', date: today, method: '전화', result: '회신 대기', content: '샘플 발송 요청', next: '샘플 발송', due: today, updateBrandNext: true }));
  const list = ok(env.api('brands.activities', { code: 'BO-0002' }));
  assert.equal(list.activities.length, 1);
  assert.match(list.activities[0].content, /작성: admin@beautyora.test/);
  assert.equal(textOf(env.notion.pages[data.b2.id], '다음 행동'), '샘플 발송');
  const act = Object.values(env.notion.pages).find((p) => p.parent.data_source_id === data.ids.activityId);
  assert.deepEqual(textOf(act, '상담 담당자'), [{ id: 'user-1', name: 'user' }]);
  env.clearCache();
  assert.equal(ok(env.api('dashboard')).counts.followups, 1);
  ok(env.api('activities.done', { pageId: list.activities[0].pageId }));
  env.clearCache();
  assert.equal(ok(env.api('dashboard')).counts.followups, 0);
});

test('onboarding checklist and billing: brand list, dashboard, 입점비 sync, recurring invoices', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const before = ok(env.api('brands.list')).brands.find((b) => b.code === 'BO-0001');
  assert.deepEqual(before.onboardTodo, [], 'blank checklist is 미확인, not todo');
  ok(env.api('brands.update', { code: 'BO-0001', changes: [{ id: env.notion.sources[data.ids.brandId].properties['계약서 발송'].id, value: '미발송' }] }));
  env.clearCache();
  let dash = ok(env.api('dashboard'));
  assert.equal(dash.counts.onboardTodo, 1);
  assert.deepEqual(dash.onboardTodo[0].todo, ['계약서']);

  // 입점비: 브랜드의 입점 입금·입점 계산서에도 반영된다.
  const fee = ok(env.api('billing.add', { requestId: 'BIL-00000001', code: 'BO-0001', kind: '입점비', direction: '받을 돈', amount: '330,000', date: '2026-09-20' }));
  assert.equal(textOf(env.notion.pages[data.b1.id], '입점 입금'), '입금 대기');
  assert.equal(textOf(env.notion.pages[data.b1.id], '입점 계산서'), '발행 대기');
  // 반복 거래: 매입 계산서.
  ok(env.api('billing.add', { requestId: 'BIL-00000002', code: 'BO-0001', kind: '상품 매입', direction: '줄 돈', amount: 1200000, date: '2026-09-25', payStatus: '입금 완료' }));
  const dup = ok(env.api('billing.add', { requestId: 'BIL-00000002', code: 'BO-0001', kind: '상품 매입', amount: 1 }));
  assert.equal(dup.duplicate, true, 'same request id does not create twice');
  assert.equal(env.api('billing.add', { requestId: 'BIL-00000003', code: 'BO-0001', kind: '모름' }).ok, false, 'unknown kind rejected');

  let list = ok(env.api('brands.billing', { code: 'BO-0001' }));
  assert.equal(list.items.length, 2);
  assert.equal(list.summary.payWait, 1);
  assert.equal(list.summary.payWaitAmount, 330000);
  assert.equal(list.summary.invoiceWait, 2);
  const purchase = list.items.find((i) => i.kind === '상품 매입');
  assert.equal(purchase.paidAt, '2026-09-25');
  assert.equal(purchase.registrar, 'admin@beautyora.test');
  env.clearCache();
  dash = ok(env.api('dashboard'));
  assert.equal(dash.counts.billingOpen, 2);
  assert.equal(dash.counts.onboardTodo, 1, 'still 계약서·입금·계산서 pending on BO-0001');
  assert.deepEqual(dash.onboardTodo[0].todo, ['계약서', '입금', '계산서']);
  assert.equal(ok(env.api('brands.list')).brands.find((b) => b.code === 'BO-0001').openBilling, 2);

  const updated = ok(env.api('billing.update', { pageId: fee.pageId, pay: '입금 완료', invoice: '발행 완료', date: '2026-09-29' }));
  assert.equal(updated.item.paidAt, '2026-09-29');
  assert.equal(updated.item.invoicedAt, '2026-09-29');
  assert.equal(textOf(env.notion.pages[data.b1.id], '입점 입금'), '입금 완료');
  assert.equal(textOf(env.notion.pages[data.b1.id], '입점 계산서'), '발행 완료');
  const back = ok(env.api('billing.update', { pageId: purchase.pageId, pay: '입금 대기' }));
  assert.equal(back.item.paidAt, '', 'reverting clears the date');
  assert.equal(env.api('billing.update', { pageId: purchase.pageId, pay: '아무거나' }).ok, false);
  assert.equal(env.api('billing.update', { pageId: data.b2.id, pay: '입금 완료' }).ok, false, 'brand page is not a billing row');
  env.clearCache();
  dash = ok(env.api('dashboard'));
  assert.equal(dash.counts.billingOpen, 1);
  assert.deepEqual(dash.onboardTodo[0].todo, ['계약서']);
});

test('lists pick up edits made directly in Notion without waiting for the cache', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  env.call('(function () { BO_LIST_SYNC_GAP_MS_ = 0; })');
  const before = ok(env.api('products.list')).products.find((p) => p.pageId === data.p2.id);
  assert.equal(before.review, '검수 대기');
  const reviewProp = env.notion.sources[data.ids.productId].properties['등록 검수 상태'].id;
  // 직원이 Notion에서 직접 승인 완료로 바꾼다(운영센터를 거치지 않음).
  env.notion.handle('patch', 'https://api.notion.com/v1/pages/' + data.p2.id, { properties: { [reviewProp]: { select: { name: '승인 완료' } } } });
  const after = ok(env.api('products.list')).products.find((p) => p.pageId === data.p2.id);
  assert.equal(after.review, '승인 완료', 'direct Notion edit shows up on the next list call');
  assert.equal(ok(env.api('products.list')).products.length, 3, 'no duplicates after merging');
  // 새로 만든 페이지도 들어온다.
  env.notion.handle('post', 'https://api.notion.com/v1/pages', { parent: { data_source_id: data.ids.brandId }, properties: { '브랜드명': { title: [{ text: { content: '새브랜드' } }] }, '브랜드 ID': { rich_text: [{ text: { content: 'BO-0050' } }] }, '진행 단계': { select: { name: '확정' } } } });
  const brands = ok(env.api('brands.list')).brands;
  assert.ok(brands.some((b) => b.code === 'BO-0050'));
  assert.equal(ok(env.api('dashboard')).counts.review, 0, 'dashboard follows too');
});

test('products made outside the center get an ID so the brand sees and can request changes to all of them', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const legacy = env.notion.createPage(data.ids.productId, { '상품명': { title: [{ text: { content: '예전 상품' } }] }, '브랜드': { relation: [{ id: data.b1.id }] }, '바코드(텍스트)': { rich_text: [{ text: { content: '8800000000099' } }] }, '대표 이미지 Drive URL': { url: 'https://drive.google.com/file/d/old-main/view' }, '상세페이지 Drive URL': { url: 'https://drive.google.com/file/d/old-detail/view' } });
  const token = issueToken(env, 'BO-0001');
  const boot = ok(env.api('partner.bootstrap', {}, token));
  const seen = boot.products.find((p) => p.name === '예전 상품');
  assert.ok(seen, 'legacy product is listed for the brand');
  assert.match(seen.productId, /^PRD-[A-Z0-9]{8}-[A-Z0-9]{8}$/);
  assert.equal(textOf(env.notion.pages[legacy.id], '운영센터 상품 ID'), seen.productId, 'ID saved to Notion');
  const again = ok(env.api('partner.bootstrap', {}, token)).products.find((p) => p.name === '예전 상품');
  assert.equal(again.productId, seen.productId, 'ID is stable');
  // 상태가 없는 기존 상품은 수정 요청(검수 후 반영)으로 들어간다.
  const res = ok(env.api('partner.submit', { requestId: 'REQ-LEGACY-0001', contactName: '담당', products: [{ productId: seen.productId, data: { product_name: '예전 상품 리뉴얼', barcode: '8800000000099', category: ['스킨케어(베이직)'], retail_price: 12000 } }] }, token));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].mode, 'change');
  assert.equal(textOf(env.notion.pages[legacy.id], '상품명'), '예전 상품', 'not applied until approved');
  // 초기 설정도 남은 상품에 ID를 붙인다.
  const other = env.notion.createPage(data.ids.productId, { '상품명': { title: [{ text: { content: '또 다른 예전 상품' } }] }, '브랜드': { relation: [{ id: data.b2.id }] } });
  const report = ok(env.api('system.setup')).report;
  assert.ok(report.some((l) => l.includes('운영센터 상품 ID')), report.join('\n'));
  assert.match(textOf(env.notion.pages[other.id], '운영센터 상품 ID'), /^PRD-/);
});

test('link can be issued for up to a year', () => {
  const { env } = setup();
  ok(env.api('system.setup'));
  const res = ok(env.api('links.issue', { code: 'BO-0001', days: 365 }));
  assert.equal(res.expiry, env.call('addDays_', env.call('today_'), 365));
});

test('document upload → admin approval writes Drive link to Notion brand', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const token = await_(issueToken(env));
  const file = ok(env.api('partner.upload', { kind: 'doc', category: '사업자등록증', uploadId: 'DOC-00000001', fileName: 'biz.pdf', mimeType: 'application/pdf', base64: Buffer.from('pdf').toString('base64') }, token)).file;
  assert.equal(file.status, '검수 대기');
  assert.equal(ok(env.api('documents.pending')).documents.length, 1);
  assert.equal(env.api('documents.review', { fileId: file.id, action: 'reject' }).ok, false, 'reject needs reason');
  ok(env.api('documents.review', { fileId: file.id, action: 'approve' }));
  assert.equal(textOf(env.notion.pages[data.b1.id], '사업자등록증 Drive URL'), file.url);
  const docs = ok(env.api('partner.documents', {}, token)).documents;
  assert.equal(docs[0].status, '승인 완료');
  const bad = env.api('partner.upload', { kind: 'doc', category: '사업자등록증', uploadId: 'DOC-00000002', fileName: 'x.exe', mimeType: 'application/octet-stream', base64: 'AA==' }, token);
  assert.equal(bad.ok, false);
});

test('partner errors hide internal details; admin errors keep them', () => {
  const { env } = setup();
  ok(env.api('system.setup'));
  const token = await_(issueToken(env));
  env.context.Drive.Files.list = () => { throw new Error('internal drive stack detail'); };
  const res = env.api('partner.documents', {}, token);
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.message, /internal drive/);
  assert.match(res.message, /문의 코드/);
});

test('migration moves active links, file metadata, and pending submissions', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const fileA = env.drive.file({ name: 'old.jpg', parents: [env.drive.root] }, null);
  const sheet = (rows) => ({ getDataRange: () => ({ getDisplayValues: () => rows }) });
  env.addLegacyBook('legacy-1', {
    getName: () => '뷰티오라DB',
    getSheetByName: (name) => ({
      '파트너 링크': sheet([['토큰', '브랜드코드', '상태', '만료일', '마지막접속', '발급일', '발급자'], ['f'.repeat(48), 'BO-0002', '사용 중', '2099-01-01', '', '2026-09-01', 'a@b'], ['e'.repeat(48), 'BO-0001', '중지', '2099-01-01', '', '', '']]),
      '파일 목록': sheet([['파일ID', '브랜드코드', '상품ID', '분류', '파일명', 'Drive파일ID', 'DriveURL', '업로드일', '상태', '검수메모'], ['FILE-abc', 'BO-0001', 'PRD-0001-AAAA', '대표 이미지', 'old.jpg', fileA.id, '', '', '수령 완료', '']]),
      '상품 접수': sheet([['제출ID', '브랜드코드', '상품ID', '제출버전', '상태', '제출일', '수정일', '상품데이터JSON', '검수메모', '제출자명', '제출자연락처'],
        ['S1', 'BO-0002', 'PRD-LEGACY-0001', '1', '신규 제출', '2026-09-20', '', JSON.stringify({ product_name: '레거시 상품', barcode: '8800000000777', retail_price: '9000' }), '', '홍', ''],
        ['S2', 'BO-0001', 'PRD-0001-AAAA', '2', '신규 제출', '2026-09-21', '', JSON.stringify({ product_name: '앰플 변경', _change_request: true }), '', '김', ''],
        ['S0', 'BO-0001', 'PRD-0001-AAAA', '1', '승인 완료', '2026-09-01', '', '{}', '', '', '']])
    }[name] || null)
  });
  const preview = ok(env.api('migration.preview', { spreadsheetId: 'legacy-1' }));
  assert.deepEqual([preview.links, preview.files, preview.submissions], [1, 1, 2]);
  const run = ok(env.api('migration.run', { spreadsheetId: 'legacy-1' }));
  assert.deepEqual([run.links, run.files, run.submissions, run.errors.length], [1, 1, 2, 0], JSON.stringify(run.errors));
  ok(env.api('partner.bootstrap', {}, 'f'.repeat(48)));
  assert.equal(env.drive.items[fileA.id].appProperties.boProduct, 'PRD-0001-AAAA');
  const legacyPage = Object.values(env.notion.pages).find((p) => textOf(p, '운영센터 상품 ID') === 'PRD-LEGACY-0001');
  assert.equal(textOf(legacyPage, '등록 검수 상태'), '검수 대기');
  assert.equal(textOf(legacyPage, '소비자가'), 9000);
  assert.equal(textOf(env.notion.pages[data.p1.id], '변경 요청'), '검수 대기');
  const rerun = ok(env.api('migration.run', { spreadsheetId: 'legacy-1' }));
  assert.deepEqual([rerun.links, rerun.files, rerun.submissions], [0, 0, 0], 'second run is a no-op');
});

test('health check reports missing configuration clearly', () => {
  const { env } = setup();
  delete env.props.BO_ROOT_FOLDER_ID;
  env.props.BO_NOTION_TOKEN = 'wrong';
  const h = ok(env.api('system.health'));
  assert.equal(h.ok, false);
  assert.ok(h.results.some((r) => r.target === 'Notion 연결' && r.status === '오류'));
  assert.ok(h.results.some((r) => r.target === 'Google Drive' && r.status === '오류'));
});

test('xlsx/CSV import maps headers by label', () => {
  const { env } = setup();
  const fields = env.call('productFieldConfig_').fields.filter((f) => f.active && !f.asset);
  const res = JSON.parse(JSON.stringify(env.call('mapImportRows_', [['안내'], ['상품명 *', '바코드', '카테고리', '소비자가'], ['토너', '0012', '스킨케어(베이직), 메이크업', '10,000'], ['', '', '', '']], fields)));
  assert.deepEqual(res.rows, [{ product_name: '토너', barcode: '0012', category: ['스킨케어(베이직)', '메이크업'], retail_price: '10,000' }]);
  assert.deepEqual(res.rowNumbers, [3], 'sheet row numbers let photos be named 3_대표.jpg');
});

test('doGet renders admin and partner shells without leaking the token into script code', () => {
  const { env } = setup();
  const admin = env.call('doGet', { parameter: {} });
  assert.match(admin.getContent(), /data-view="admin"/);
  const partner = env.call('doGet', { parameter: { token: 'abc"><script>alert(1)</script>' } });
  assert.doesNotMatch(partner.getContent(), /<script>alert/);
  assert.match(partner.getContent(), /data-view="partner"/);
  assert.equal(partner.xframe, undefined, 'no ALLOWALL framing by default');
});

function await_(v) { return v; }

test('only the audited entry points are callable from google.script.run', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src');
  const publicFns = [];
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^function ([A-Za-z0-9_$]+)\s*\(/gm)) if (!m[1].endsWith('_')) publicFns.push(m[1]);
  });
  // Each of these checks admin/owner, a partner token, or an installed trigger before doing anything.
  assert.deepEqual(publicFns.sort(), ['api', 'doGet', 'migrateLegacySheets', 'onBrandFormSubmit', 'runHealthCheck', 'scheduledHealthCheck', 'setupBeautyora'].sort());
  const { env } = setup();
  env.setUser('');
  assert.throws(() => env.call('runHealthCheck'), /계정/);
});

test('no Google Sheets dependency remains outside the one-time migration', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src');
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs') && f !== '21_Migration.gs').forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const uses = (src.match(/SpreadsheetApp\.[a-zA-Z]+/g) || []);
    // The xlsx import converts an uploaded workbook in Drive and reads it once; that is not a data store.
    if (f === '13_Partner.gs') assert.deepEqual(uses, ['SpreadsheetApp.openById'], f);
    else assert.deepEqual(uses, [], f);
  });
});

test('legacy drive import copies brand folders, links key documents only, and repairs stray copies', () => {
  const { env, data } = setup();
  ok(env.api('system.setup'));
  const d = env.drive;
  const src = d.folder('기존 제출', null);
  const f1 = d.folder('[BO-0001 · BO-0002] 루엠 주식회사_루엠 · 셀리본', src);
  const biz = d.file({ name: '사업자등록증.pdf', mimeType: 'application/pdf', parents: [f1] }, null);
  d.file({ name: '농협_통장사본.png', mimeType: 'image/png', parents: [f1] }, null);
  d.file({ name: '뷰티오라_입점 상품 리스트_셀리본.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: [f1] }, null);
  const done = d.folder('2차 확인 완료', src);
  const f2 = d.folder('(주)새싹랩', done);
  d.file({ name: '새싹랩 제품소개서.pdf', mimeType: 'application/pdf', parents: [f2] }, null);
  d.folder('[BO-0999] 없는 브랜드', src);
  d.file({ name: '_TEMPLATE_상품 제출 시트', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [src] }, null);
  // 직접 넣은 서류 값은 덮어쓰지 않는다.
  env.notion.pages[data.b1.id].properties['사업자등록증 Drive URL'] = { id: 'x', type: 'url', url: 'https://drive.google.com/file/d/manual/view' };
  // 셀리본의 '구글 드라이브'가 원본 폴더를 가리키고, 예전 실행이 그 안에 사본을 만들어 둔 상태.
  env.notion.pages[data.b2.id].properties['구글 드라이브'] = { id: 'y', type: 'url', url: 'https://drive.google.com/drive/folders/' + f1 };
  const stray = d.file({ name: '사업자등록증.pdf', mimeType: 'application/pdf', parents: [f1], appProperties: { boKind: 'doc', boBrand: 'BO-0001', boCat: 'business', boStatus: 'approved', boLegacy: biz.id } }, null);
  // 예전 실행이 같은 사본을 내 드라이브 첫 화면에 또 만들었고(표시 있음), 통장사본은 표시 없이 떨어졌다.
  const dupe = d.file({ name: '사업자등록증.pdf', mimeType: 'application/pdf', parents: ['root'], appProperties: { boKind: 'doc', boLegacy: biz.id } }, null);
  const bankSrc = Object.values(d.items).find((f) => f.name === '농협_통장사본.png');
  const rootBank = d.file({ name: '농협_통장사본.png', mimeType: 'image/png', parents: ['root'], md5Checksum: bankSrc.md5Checksum }, null);
  const rootBank2 = d.file({ name: '농협_통장사본.png', mimeType: 'image/png', parents: ['root'], md5Checksum: bankSrc.md5Checksum }, null);
  const unrelated = d.file({ name: '농협_통장사본.png', mimeType: 'image/png', parents: ['root'], md5Checksum: 'other-content' }, null);
  env.api('system.refresh');

  const url = 'https://drive.google.com/drive/folders/' + src + '?usp=sharing';
  const preview = ok(env.api('legacy.preview', { folderUrl: url }));
  assert.deepEqual([preview.totals.folders, preview.totals.files], [3, 4], 'the stray copy is not treated as a source file');
  const g1 = preview.groups.find((g) => g.folder.startsWith('[BO-0001'));
  assert.deepEqual(g1.files.map((f) => [f.category, f.key]), [['사업자등록증', true], ['통장사본', true], ['입점 상품 리스트', false]]);
  assert.deepEqual(g1.files[2].targets, ['BO-0002'], 'file named after one brand goes to that brand only');
  assert.ok(preview.groups.some((g) => g.byName && g.brands[0].code === 'BO-0003'), 'code-less folder matched by name');
  assert.deepEqual(preview.groups.find((g) => g.folder.startsWith('[BO-0999')).missing, ['BO-0999']);

  const run = ok(env.api('legacy.run', { folderUrl: url }));
  assert.deepEqual([run.copied, run.skipped, run.trashed, run.errors.length], [2, 2, 2, 0], JSON.stringify(run));
  assert.ok(run.moved >= 2, 'stray copies moved into the brand folder');
  assert.equal(d.items[dupe.id].trashed || d.items[stray.id].trashed, true, 'duplicate copy trashed');
  assert.ok(!d.items[rootBank.id].trashed !== !d.items[rootBank2.id].trashed, 'one untagged root copy kept, the other trashed');
  const keptBank = [rootBank, rootBank2].find((f) => !d.items[f.id].trashed);
  assert.equal(d.items[keptBank.id].appProperties.boLegacy, bankSrc.id, 'kept root copy gets tagged');
  assert.notEqual(d.items[keptBank.id].parents[0], 'root', 'kept root copy moved out of My Drive root');
  assert.ok(!d.items[unrelated.id].trashed && d.items[unrelated.id].parents[0] === 'root', 'different content is left alone');
  const page = (p) => env.notion.pages[p.id].properties;
  const newFolder = page(data.b1)['구글 드라이브'].url;
  assert.match(newFolder, /\/folders\//);
  assert.ok(!newFolder.includes(f1), 'never links the original folder');
  assert.equal(page(data.b2)['구글 드라이브'].url, newFolder, 'link that pointed at the original folder is replaced');
  assert.equal(Object.values(d.items).filter((f) => !f.folder && f.parents[0] === f1).length, 3, 'original folder holds only the originals');
  assert.equal(page(data.b1)['사업자등록증 Drive URL'].url, 'https://drive.google.com/file/d/manual/view', 'manual value kept');
  assert.match(page(data.b2)['사업자등록증 Drive URL'].url, /\/file\/d\//);
  assert.match(page(data.b2)['통장사본 Drive URL'].url, /\/file\/d\//);
  assert.ok(!page(data.b2)['입점 상품 리스트 Drive URL'], 'no separate property for product lists');
  assert.ok(!page(data.b3)['브랜드 소개서 Drive URL'] || !page(data.b3)['브랜드 소개서 Drive URL'].url, 'non-key files stay in the folder only');
  assert.match(page(data.b3)['구글 드라이브'].url, /\/folders\//);
  const copies = Object.values(d.items).filter((f) => !f.trashed && f.appProperties && f.appProperties.boLegacy);
  assert.equal(copies.length, 4);
  const destId = newFolder.split('/folders/')[1];
  assert.ok(copies.filter((f) => f.appProperties.boBrand !== 'BO-0003').every((f) => f.parents[0] === destId), 'every copy sits in the brand folder');
  assert.ok(copies.every((f) => f.appProperties.boStatus === 'approved' && f.appProperties.boKind === 'doc'));
  assert.ok(ok(env.api('brands.documents', { code: 'BO-0002' })).documents.some((f) => f.category === '입점 상품 리스트'));

  const rerun = ok(env.api('legacy.run', { folderUrl: url }));
  assert.deepEqual([rerun.copied, rerun.moved, rerun.trashed, rerun.skipped, rerun.brands], [0, 0, 0, 4, 0], 'second run changes nothing');

  // 사본을 지웠다면 다시 복사하고 Notion 링크도 새 사본으로 바꾼다.
  const bankCopy = copies.find((f) => f.name === '농협_통장사본.png');
  bankCopy.trashed = true;
  const again = ok(env.api('legacy.run', { folderUrl: url }));
  assert.equal(again.copied, 1);
  assert.ok(!page(data.b2)['통장사본 Drive URL'].url.includes(bankCopy.id), 'link to the deleted copy replaced');
});

test('setup keeps going when one step fails and says how to fix it', () => {
  const { env } = setup({ skipDiscovery: true });
  env.notion.failNext = Object.assign(/^GET \/databases\//, { status: 404 });
  const res = ok(env.api('system.setup'));
  assert.equal(res.ok, false);
  assert.ok(res.report.some((l) => /^실패: 상품등록 링크 DB/.test(l) && /연결/.test(l)), res.report.join('\n'));
  assert.ok(env.triggers.some((t) => t.getHandlerFunction() === 'scheduledHealthCheck'), 'triggers still installed');
  assert.ok(res.report.some((l) => l.includes('검수 메모')), 'schema additions still ran');
  const again = ok(env.api('system.setup'));
  assert.equal(again.ok, true, again.report.join('\n'));
  assert.ok(env.props.BO_NOTION_LINK_DATA_SOURCE_ID);
});
