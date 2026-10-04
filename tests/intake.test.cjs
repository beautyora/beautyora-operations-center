'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createEnv, seed } = require('./harness.cjs');

function setup() {
  const env = createEnv(), data = seed(env), responses = [], sheetRows = [];
  let sequence = 0;
  const items = [
    ['company', '회사명', true], ['brand', '브랜드명', true], ['biz', '사업자번호', true],
    ['contact', '담당자명', true], ['phone', '담당자 연락처', true], ['email', '담당자 이메일', true],
    ['channel1', '희망하는 채널 1순위', false], ['channel2', '희망하는 채널 2순위', false]
  ].map(([id, title, required]) => {
    const item = { getId: () => id, getTitle: () => title, getType: () => 'TEXT', isRequired: () => required };
    item.asTextItem = () => item;
    item.createResponse = value => ({ getItem: () => item, getResponse: () => value });
    return item;
  });
  const form = {
    getDestinationId: () => 'response-sheet', isAcceptingResponses: () => true,
    getItems: () => items,
    getResponses: since => responses.filter(r => !since || r.getTimestamp() > since),
    createResponse: () => {
      const answers = [];
      const response = { id: '', timestamp: new Date(), getId() { return this.id; }, getTimestamp() { return this.timestamp; },
        getItemResponses: () => answers, withItemResponse(r) { answers.push(r); return this; },
        submit() { this.id = 'response-' + ++sequence; responses.push(this); sheetRows.push(answers.map(a => a.getResponse())); return this; }
      };
      return response;
    }
  };
  env.context.FormApp = { openById: id => { assert.equal(id, 'original-form'); return form; }, getActiveForm: () => form, ItemType: { TEXT: 'TEXT' } };
  env.props.BO_GOOGLE_FORM_ID = 'original-form';
  env.props.BO_INTAKE_RESPONSE_SHEET_ID = 'response-sheet';
  env.call('setupBeautyora');
  function submit(name, extra = {}) {
    const answer = { company: '테스트회사', brand: name, biz: '000-00-00000', contact: '자동검증', phone: '000-0000-0000', email: 'test@example.com', ...extra };
    const response = form.createResponse();
    items.forEach(item => { if (answer[item.getId()] !== undefined) response.withItemResponse(item.createResponse(answer[item.getId()])); });
    return response.submit();
  }
  const rows = () => JSON.parse(JSON.stringify(env.call('notionQueryAll_', data.ids.brandId, {}).map(p => env.call('notionRow_', p, env.call('notionSchema_', 'brand')))));
  const sync = () => JSON.parse(JSON.stringify(env.call('syncBrandIntake_')));
  return { env, data, form, responses, sheetRows, submit, rows, sync };
}

function bridgeFor(env) {
  const context = vm.createContext({ FormApp: env.context.FormApp, ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ setMimeType: () => JSON.parse(body) }) } });
  // Exact source fixture from beautyora-brand main a0c5c82; no production submission.
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'fixtures', 'form-bridge.gs'), 'utf8'), context);
  return answers => context.doPost({ postData: { contents: JSON.stringify({ answers }) } });
}

test('intake: real bridge source programmatic submit reaches mock response sheet, Notion and Drive via polling', () => {
  const { env, submit, sheetRows, rows, sync } = setup();
  submit('은휘플로우'); submit('노아카');
  assert.ok(sync().skipped);
  const before = rows().length;
  const baseline = env.call('setupBrandIntake');
  assert.equal(baseline.excludedResponses, 2);
  const bridge = bridgeFor(env);
  assert.equal(bridge({ brand: 'missing fields' }).ok, false);
  assert.equal(sheetRows.length, 2);
  assert.equal(bridge({ company: '테스트', brand: 'TEST_뷰티오라_연동확인', biz: '000-00-00000', contact: '자동검증', phone: '000-0000-0000', email: 'beautyora-e2e-test@example.com' }).ok, true);
  assert.equal(sheetRows.length, 3);
  assert.equal(rows().length, before, 'programmatic submit did not fire a form trigger');
  assert.equal(sync().processed, 1);
  assert.equal(rows().length, before + 1);
  const brand = rows().find(b => b.name === 'TEST_뷰티오라_연동확인');
  assert.equal(brand.stage, '접수·검토');
  assert.equal(brand.reClass, '신규 · 상품 미등록');
  assert.equal(brand.formResponseId, 'response-3');
  assert.ok(brand.drive);
  assert.equal(sync().processed, 0);
  assert.equal(rows().length, before + 1);
  assert.equal(env.mail.length, 0, 'no success email or external contact');
  assert.ok(!rows().some(b => ['은휘플로우', '노아카'].includes(b.name)));
});

test('intake: direct form responses work and existing sales fields/legacy response IDs are byte-for-byte preserved', () => {
  const { env, data, submit, rows, sync } = setup();
  env.notion.pages[data.b1.id].properties['폼 응답 ID'] = { rich_text: [{ text: { content: 'legacy-id,0' }, plain_text: 'legacy-id,0' }], type: 'rich_text' };
  const original = JSON.stringify(env.notion.pages[data.b1.id]);
  env.call('setupBrandIntake');
  submit(' 루 엠 ', { company: '변경 요청', contact: '새 담당자' });
  assert.equal(sync().processed, 1);
  assert.equal(JSON.stringify(env.notion.pages[data.b1.id]), original);
  assert.equal(rows().length, 3);
  assert.equal(Object.values(env.drive.items).filter(x => x.folder).length, 1);
  assert.equal(env.notion.comments.length, 0);
});

test('intake: multi-brand response recovers only its incomplete brand and allocates unique BO IDs', () => {
  const { env, submit, rows, sync } = setup();
  env.call('setupBrandIntake');
  submit('Alpha, Beta(서브, 라인), alpha\nGamma');
  const create = env.context.intakeCreateOnce_;
  let calls = 0;
  env.context.intakeCreateOnce_ = (...args) => {
    if (++calls === 2) { const e = new Error('validation'); e.definitelyRejected = true; throw e; }
    return create(...args);
  };
  assert.equal(sync().failed.length, 1);
  assert.equal(rows().filter(b => b.name === 'Alpha').length, 1);
  env.context.intakeCreateOnce_ = create;
  assert.equal(sync().failed.length, 0);
  assert.equal(rows().length, 6);
  assert.deepEqual(rows().filter(b => /^response-/.test(b.formResponseId || '')).map(b => b.name), ['Alpha', 'Beta(서브, 라인)', 'Gamma']);
  assert.equal(new Set(rows().map(b => b.code)).size, 6);
  assert.deepEqual(rows().filter(b => /^response-/.test(b.formResponseId || '')).map(b => b.formResponseId).sort(), ['response-1,0', 'response-1,1', 'response-1,2']);
});

test('intake: lost Notion create response is recovered by response ID after brand rename, without a second POST', () => {
  const { env, submit, rows, sync } = setup();
  env.call('setupBrandIntake'); submit('처음이름');
  const create = env.context.intakeCreateOnce_;
  let calls = 0;
  env.context.intakeCreateOnce_ = (...args) => { calls++; create(...args); throw new Error('connection lost after commit'); };
  assert.equal(sync().failed.length, 1);
  const created = rows().find(b => b.name === '처음이름');
  env.notion.pages[created.pageId].properties['브랜드명'] = { type: 'title', title: [{ text: { content: '변경이름' }, plain_text: '변경이름' }] };
  assert.equal(sync().failed.length, 0);
  assert.equal(calls, 1);
  assert.equal(rows().length, 4);
  assert.ok(rows().find(b => b.name === '변경이름').drive);
});

test('intake: ambiguous POST with no visible result blocks resend, same-name responses and code reuse', () => {
  const { env, submit, rows, sync } = setup();
  env.call('setupBrandIntake'); submit('불확실');
  const create = env.context.intakeCreateOnce_;
  let attempts = 0;
  env.context.intakeCreateOnce_ = () => { attempts++; throw new Error('ambiguous timeout'); };
  assert.equal(sync().failed.length, 1);
  submit('불확실'); submit('다른브랜드');
  env.context.intakeCreateOnce_ = create;
  const result = sync();
  assert.equal(result.failed.length, 2);
  assert.equal(attempts, 1);
  assert.equal(rows().find(b => b.name === '다른브랜드').code, 'BO-0005', 'BO-0004 remains reserved');
  assert.ok(!rows().some(b => b.name === '불확실'));
});

test('intake: Drive failure and two repeated trigger calls do not duplicate Notion pages or folders', () => {
  const { env, submit, rows, sync } = setup();
  env.call('setupBrandIntake'); submit('폴더복구');
  env.props.BO_TEMPLATE_FILE_ID = 'unavailable';
  assert.equal(sync().failed.length, 1);
  assert.equal(rows().length, 4);
  delete env.props.BO_TEMPLATE_FILE_ID;
  const uid = env.triggers.find(t => t.getHandlerFunction() === 'scheduledBrandIntake').getUniqueId();
  env.call('scheduledBrandIntake', { triggerUid: uid });
  env.call('scheduledBrandIntake', { triggerUid: uid });
  assert.equal(rows().length, 4);
  assert.equal(Object.values(env.drive.items).filter(x => x.name === '폴더복구 (BO-0004)').length, 1);
  assert.throws(() => env.call('scheduledBrandIntake', { triggerUid: 'fake' }));
});

test('intake: initial snapshot failure, interrupted persistence, and form/destination changes fail closed', () => {
  const { env, form, submit, rows, sync } = setup();
  const getResponses = form.getResponses;
  form.getResponses = () => { throw new Error('permission denied'); };
  assert.throws(() => env.call('setupBrandIntake'));
  assert.ok(sync().skipped);
  form.getResponses = getResponses;
  submit('기존');
  const getProps = env.context.PropertiesService.getScriptProperties;
  env.context.PropertiesService.getScriptProperties = () => {
    const store = getProps(), save = store.setProperty;
    store.setProperty = (key, value) => { if (key === 'BO_INTAKE_BASELINE_V1') throw new Error('quota'); save(key, value); };
    return store;
  };
  assert.throws(() => env.call('setupBrandIntake'));
  assert.ok(sync().skipped);
  env.context.PropertiesService.getScriptProperties = getProps;
  env.call('setupBrandIntake');
  assert.equal(sync().processed, 0);
  const saved = env.props.BO_INTAKE_BASELINE_V1;
  env.call('setupBrandIntake');
  assert.equal(env.props.BO_INTAKE_BASELINE_V1, saved);
  assert.equal(rows().length, 3);
  form.getDestinationId = () => 'wrong-sheet';
  assert.throws(sync, /응답 시트/);
  form.getDestinationId = () => 'response-sheet';
  env.props.BO_GOOGLE_FORM_ID = 'wrong-form';
  assert.throws(sync, /연결이 바뀌었습니다/);
});

test('intake: activation preserves unrelated/current legacy triggers and baseline survives general setup', () => {
  const { env } = setup();
  env.call('(function () { ScriptApp.newTrigger("handleBrandFormSubmit").timeBased().everyHours(1).create(); ScriptApp.newTrigger("scheduledBeautyoraSync").timeBased().everyHours(1).create(); })');
  const legacy = env.triggers.filter(t => ['handleBrandFormSubmit', 'scheduledBeautyoraSync'].includes(t.getHandlerFunction()));
  env.call('setupBrandIntake');
  const baseline = env.props.BO_INTAKE_BASELINE_V1;
  env.call('setupBrandIntake'); env.call('setupBeautyora');
  assert.equal(env.props.BO_INTAKE_BASELINE_V1, baseline);
  assert.equal(env.triggers.filter(t => t.getHandlerFunction() === 'scheduledBrandIntake').length, 1);
  legacy.forEach(t => assert.ok(env.triggers.includes(t)));
});

test('intake: equal response timestamps across midnight and registration during snapshot save are not lost', () => {
  const { env, submit, rows, sync } = setup();
  env.context.Date = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-04T14:59:59.000Z'])); } static now() { return Date.parse('2026-10-04T14:59:59.000Z'); } };
  submit('과거').timestamp = new Date('2026-10-04T14:59:59.000Z');
  const getProps = env.context.PropertiesService.getScriptProperties;
  let added = false;
  env.context.PropertiesService.getScriptProperties = () => {
    const store = getProps(), save = store.setProperty;
    store.setProperty = (key, value) => {
      if (key === 'BO_INTAKE_BASELINE_V1' && !added) { added = true; submit('동시등록').timestamp = new Date('2026-10-04T14:59:59.000Z'); }
      save(key, value);
    }; return store;
  };
  env.call('setupBrandIntake');
  submit('다음날').timestamp = new Date('2026-10-04T15:00:00.000Z');
  assert.equal(sync().processed, 2);
  assert.equal(rows().find(b => b.name === '동시등록').received, '2026-10-04');
  assert.equal(rows().find(b => b.name === '다음날').received, '2026-10-05');
  assert.ok(!rows().some(b => b.name === '과거'));
});

test('intake: raw HTTP 500 is not automatically resent, while definitive rejection can be retried', () => {
  const { env, submit, rows, sync } = setup();
  env.call('setupBrandIntake'); submit('서버오류');
  const fetch = env.context.UrlFetchApp.fetch;
  let posts = 0, status = 500;
  env.context.UrlFetchApp.fetch = (url, options) => {
    if (url.endsWith('/pages') && options.method === 'post') {
      posts++;
      return { getResponseCode: () => status, getContentText: () => '{}' };
    }
    return fetch(url, options);
  };
  assert.equal(sync().failed.length, 1);
  assert.equal(posts, 1);
  assert.equal(sync().failed.length, 1);
  assert.equal(posts, 1);
  submit('명확한거부'); status = 429;
  sync();
  assert.equal(posts, 2);
  env.context.UrlFetchApp.fetch = fetch;
  sync();
  assert.ok(rows().some(b => b.name === '명확한거부'));
  assert.ok(!rows().some(b => b.name === '서버오류'));
});

test('intake: durable-record failure before POST and lock contention create nothing', () => {
  const { env, submit, rows, sync } = setup();
  env.call('setupBrandIntake'); submit('기록실패');
  const save = env.context.intakeSave_;
  env.context.intakeSave_ = (key, value) => {
    if (Object.values(value.entries || {}).some(e => e.phase === 'creating')) throw new Error('storage full');
    return save(key, value);
  };
  assert.equal(sync().failed.length, 1);
  assert.equal(rows().length, 3);
  env.context.intakeSave_ = save;
  const lock = env.context.LockService;
  env.context.LockService = { getScriptLock: () => ({ tryLock: () => false }) };
  assert.throws(sync, /다른 작업/);
  assert.equal(rows().length, 3);
  env.context.LockService = lock;
  assert.equal(sync().failed.length, 0);
  assert.equal(rows().length, 4);
});

test('intake: missing required response-ID property prevents activation without altering Notion schema', () => {
  const { env } = setup();
  const schema = env.call('notionSchema_', 'brand');
  delete schema.ids.formResponseId;
  assert.throws(() => env.call('setupBrandIntake'), /폼 응답 ID/);
  assert.equal(env.props.BO_INTAKE_BASELINE_V1, undefined);
  assert.ok(!env.triggers.some(t => t.getHandlerFunction() === 'scheduledBrandIntake'));
});

test('intake: corrupted committed snapshot and unapproved response edits fail closed', () => {
  const { env, submit, sync } = setup();
  submit('과거'); env.call('setupBrandIntake');
  delete env.props.BO_INTAKE_EXCLUDED_V1_0;
  assert.throws(sync, /기준점 조각/);
  assert.throws(() => env.call('setupBrandIntake'), /기준점 조각/);
  const second = setup();
  second.env.call('setupBrandIntake');
  const response = second.submit('수정전');
  second.env.context.intakeCreateOnce_ = () => { throw new Error('timeout'); };
  assert.equal(second.sync().failed.length, 1);
  response.withItemResponse({ getItem: () => ({ getTitle: () => '추가 질문' }), getResponse: () => 'edited' });
  assert.match(second.sync().failed[0].message, /응답이 수정/);
});

test('intake: setup and manual sync enforce caller authorization', () => {
  const { env } = setup();
  env.setUser('stranger@example.com');
  assert.throws(() => env.call('setupBrandIntake'), error => error.code === 'NOT_ADMIN');
  assert.equal(env.api('intake.sync').ok, false);
});


test('intake: USER_ACCESSING non-admin cannot activate even when active and effective users match', () => {
  const { env } = setup();
  env.user.active = env.user.effective = 'stranger@example.com';
  const beforeProperties = JSON.stringify(env.props), beforeTriggers = env.triggers.slice();
  let formReads = 0;
  env.context.FormApp.openById = () => { formReads++; throw new Error('must not access Form'); };
  assert.throws(() => env.call('setupBrandIntake'), error => error.code === 'NOT_ADMIN');
  assert.equal(formReads, 0);
  assert.equal(JSON.stringify(env.props), beforeProperties);
  assert.deepEqual(env.triggers, beforeTriggers);
  assert.equal(env.api('intake.sync').ok, false);
});

test('intake: allowlisted admin can activate in editor or USER_ACCESSING context without role expansion', () => {
  const { env } = setup();
  env.user.active = env.user.effective = 'admin@beautyora.test';
  const admins = env.props.BO_ADMIN_EMAILS;
  assert.doesNotThrow(() => env.call('setupBrandIntake'));
  assert.equal(env.props.BO_ADMIN_EMAILS, admins);
  assert.equal(env.triggers.filter(t => t.getHandlerFunction() === 'scheduledBrandIntake').length, 1);
  env.user.active = env.user.effective = '';
  assert.throws(() => env.call('setupBrandIntake'), error => error.code === 'NO_EMAIL');
});

function recoverySetup() {
  const s = setup();
  const r1 = s.submit('복구 브랜드 하나', { channel1: '사입, 위탁(우선순위)' });
  const r2 = s.submit('복구 브랜드 둘');
  s.env.call('setupBrandIntake');
  const config = { targets: [r1, r2].map(r => ({ brand: s.env.call('formAnswers_', r).brand, company: '테스트회사', timestamp: r.getTimestamp().toISOString() })) };
  const preview = s.env.call('previewBrandIntakeRecovery', config);
  config.targets.forEach((t, i) => Object.assign(t, { responseId: preview.responses[i].source.responseId, sourceHash: preview.responses[i].sourceHash, fields: { brand: 'brand', company: 'company', contactName: 'contact' } }));
  s.env.props.BO_INTAKE_RECOVERY_TWO_V1 = JSON.stringify(config);
  return { ...s, config, r1, r2 };
}

test('recovery: preview is read only; two approved old responses register once without changing baseline/existing brands', () => {
  const s = recoverySetup(), { env, config } = s;
  const props = JSON.stringify(env.props), pages = JSON.stringify(env.notion.pages);
  const result = env.call('previewBrandIntakeRecovery', config);
  assert.equal(result.responses.length, 2);
  assert.equal(JSON.stringify(env.props), props);
  assert.equal(JSON.stringify(env.notion.pages), pages);
  const baseline = Object.fromEntries(Object.entries(env.props).filter(([k]) => /BO_INTAKE_(BASELINE|EXCLUDED)/.test(k)));
  const existing = JSON.parse(pages), before = s.rows().length;
  env.call('replayBrandIntakeRecovery');
  assert.equal(s.rows().length, before + 2);
  const added = s.rows().find(b => b.name === config.targets[0].brand);
  assert.ok(added.drive);
  assert.equal(added.channel1 || '', '', 'legacy value must not be guessed from current title');
  assert.equal(added.contactName, '자동검증');
  for (const id of Object.keys(existing)) assert.deepEqual(env.notion.pages[id], existing[id]);
  for (const [key, value] of Object.entries(baseline)) assert.equal(env.props[key], value);
  env.call('replayBrandIntakeRecovery');
  assert.equal(s.rows().length, before + 2);
  assert.equal(s.sync().processed, 0, 'old responses remain excluded from polling');
});

test('recovery: rejects non-admin, wrong count, duplicate target and timestamp mismatch without writing', () => {
  const s = recoverySetup(), { env, config } = s, before = JSON.stringify(env.props);
  env.setUser('outsider@example.com');
  assert.throws(() => env.call('previewBrandIntakeRecovery', config));
  assert.throws(() => env.call('replayBrandIntakeRecovery'));
  env.setUser('admin@beautyora.test');
  for (const targets of [[], [config.targets[0]], [...config.targets, config.targets[0]], [config.targets[0], config.targets[0]]]) {
    assert.throws(() => env.call('previewBrandIntakeRecovery', { targets }));
  }
  const invalid = JSON.parse(JSON.stringify(config)); invalid.targets[1].timestamp = '2020-01-01T00:00:00Z';
  assert.throws(() => env.call('previewBrandIntakeRecovery', invalid));
  assert.equal(JSON.stringify(env.props), before);
});

test('recovery: validates both IDs, source hashes and explicit mappings before any writes', () => {
  for (const mutate of [t => t.responseId = 'ACYDB-ui-id', t => t.sourceHash = 'changed', t => t.fields = {}, t => t.fields.company = 'deleted-item', t => t.fields.unknown = 'brand']) {
    const s = recoverySetup(); mutate(s.config.targets[1]);
    s.env.props.BO_INTAKE_RECOVERY_TWO_V1 = JSON.stringify(s.config);
    const props = JSON.stringify(s.env.props), pages = JSON.stringify(s.env.notion.pages);
    assert.throws(() => s.env.call('replayBrandIntakeRecovery'));
    assert.equal(JSON.stringify(s.env.props), props);
    assert.equal(JSON.stringify(s.env.notion.pages), pages);
  }
});

test('recovery: changed source is rejected and first replay freezes the exact two-target configuration', () => {
  const s = recoverySetup();
  s.r2.timestamp = new Date('2020-01-01T00:00:00Z');
  assert.throws(() => s.env.call('replayBrandIntakeRecovery'));
  s.r2.timestamp = new Date(s.config.targets[1].timestamp);
  s.env.call('replayBrandIntakeRecovery');
  delete s.config.targets[0].fields.contactName;
  s.env.props.BO_INTAKE_RECOVERY_TWO_V1 = JSON.stringify(s.config);
  assert.throws(() => s.env.call('replayBrandIntakeRecovery'), /확정/);
});

test('recovery: shared lock blocks writes and partial Drive failure resumes without duplicates', () => {
  const s = recoverySetup(), { env } = s, before = s.rows().length;
  const getLock = env.context.LockService.getScriptLock;
  env.context.LockService.getScriptLock = () => ({ tryLock: () => false });
  const props = JSON.stringify(env.props);
  assert.throws(() => env.call('replayBrandIntakeRecovery'), /다른 작업/);
  assert.equal(JSON.stringify(env.props), props);
  env.context.LockService.getScriptLock = getLock;
  env.props.BO_TEMPLATE_FILE_ID = 'unavailable';
  assert.throws(() => env.call('replayBrandIntakeRecovery'));
  assert.equal(s.rows().length, before + 1);
  delete env.props.BO_TEMPLATE_FILE_ID;
  env.call('replayBrandIntakeRecovery');
  env.call('replayBrandIntakeRecovery');
  assert.equal(s.rows().length, before + 2);
  for (const t of s.config.targets) {
    const b = s.rows().find(b => b.name === t.brand);
    assert.equal(Object.values(env.drive.items).filter(x => x.name === t.brand + ' (' + b.code + ')').length, 1);
  }
});

test('recovery: editor inspector logs only approved metadata and never raw answers', () => {
  const s = recoverySetup(), logs = [];
  s.env.context.console = { log: value => logs.push(value) };
  const props = JSON.stringify(s.env.props), pages = JSON.stringify(s.env.notion.pages);
  const result = s.env.call('inspectBrandIntakeRecovery');
  assert.equal(result.responses.length, 2);
  assert.equal(logs.length, 1);
  for (const value of ['테스트회사', '복구 브랜드 하나', '자동검증', '000-0000-0000', 'test@example.com', '사입, 위탁(우선순위)']) assert.ok(!logs[0].includes(value), value);
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.responses[0].responseId, s.r1.getId());
  assert.equal(logged.responses[0].expectedMatch, true);
  assert.ok(logged.responses[0].questions.every(q => Object.keys(q).sort().join(',') === 'answerHash,id,title,type'));
  assert.equal(JSON.stringify(s.env.props), props);
  assert.equal(JSON.stringify(s.env.notion.pages), pages);
  s.env.setUser('outsider@example.com');
  assert.throws(() => s.env.call('inspectBrandIntakeRecovery'));
  assert.equal(logs.length, 1);
});
