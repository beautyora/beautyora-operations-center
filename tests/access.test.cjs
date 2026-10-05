'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, seed } = require('./harness.cjs');

function setup() {
  const env = createEnv();
  const data = seed(env);
  return { env, data };
}

function ok(result) {
  assert.equal(result.ok, true, result.message);
  return JSON.parse(JSON.stringify(result.data));
}

/* ---------------------------------------------------------------- Google 로그인 */

test('login: public config needs no token, everything else needs a verified Google sign-in', () => {
  const { env } = setup();
  const config = env.post({ action: 'auth.config' });
  assert.equal(config.ok, true);
  assert.deepEqual(Object.keys(config.data).sort(), ['clientId', 'version'], 'only public values');
  assert.equal(config.data.clientId, '1234-test.apps.googleusercontent.com');

  assert.equal(env.post({ action: 'dashboard' }).code, 'NEED_LOGIN');
  assert.equal(env.post('not json').code, 'BAD_REQUEST');
  assert.equal(env.post([1, 2]).code, 'BAD_REQUEST');
  assert.match(env.post({ action: '__proto__', idToken: env.idToken('admin@beautyora.test') }).message, /지원하지 않는 요청/);
  const res = env.post({ action: 'dashboard', idToken: env.idToken('admin@beautyora.test') });
  assert.equal(res.ok, true, res.message);
});

test('login: tokens for another app, other issuers, expired, unverified or forged are refused', () => {
  const { env } = setup();
  const email = 'admin@beautyora.test';
  const bad = {
    'other client': env.idToken(email, { aud: '999-other.apps.googleusercontent.com' }),
    'other issuer': env.idToken(email, { iss: 'https://evil.example' }),
    expired: env.idToken(email, { exp: String(Math.floor(Date.now() / 1000) - 10) }),
    unverified: env.idToken(email, { email_verified: 'false' }),
    forged: env.idToken(email, { __sig: 'forged' }),
    malformed: 'not-a-jwt',
    'too long': 'a.' + 'b'.repeat(5000) + '.c',
    missing: ''
  };
  Object.keys(bad).forEach((name) => {
    const res = env.api('dashboard', {}, bad[name]);
    assert.equal(res.ok, false, name);
    assert.equal(res.code, 'NEED_LOGIN', name);
  });
  // 브라우저·Session의 계정은 웹 요청에서 믿지 않는다: Session이 관리자여도 토큰이 없으면 거절.
  env.setUser('admin@beautyora.test');
  assert.equal(env.api('dashboard', {}, '').code, 'NEED_LOGIN');
  // 등록되지 않은 계정은 로그인은 되어도 들어올 수 없다.
  const stranger = env.api('dashboard', {}, env.idToken('stranger@gmail.com'));
  assert.equal(stranger.code, 'NOT_ADMIN');
  assert.match(stranger.message, /stranger@gmail\.com.*운영진으로 등록되어 있지 않습니다/);
  // 대소문자가 달라도 같은 계정이다.
  assert.equal(env.api('dashboard', {}, env.idToken('Admin@Beautyora.test')).ok, true);
  delete env.props.BO_GOOGLE_CLIENT_ID;
  assert.equal(env.api('dashboard', {}, env.idToken(email)).code, 'NO_CLIENT_ID');
});

test('login: a verified token is checked with Google once and the signed-in email never leaks into the next request', () => {
  const { env } = setup();
  const token = env.idToken('second@beautyora.test');
  const first = ok(env.api('admin.bootstrap', {}, token));
  assert.equal(first.user.email, 'second@beautyora.test', 'bootstrap shows the signed-in account, not the deployer');
  ok(env.api('dashboard', {}, token));
  ok(env.api('brands.list', {}, token));
  assert.equal(env.tokenChecks.count, 1, 'cached until the token expires');
  env.setUser('');
  assert.equal(env.call('activeEmail_'), '', 'signed-in email is cleared after the request');
  assert.equal(env.api('dashboard', {}, '').code, 'NEED_LOGIN');
});

test('login: editor-only functions still check the account that runs them', () => {
  const { env } = setup();
  env.setUser('');
  assert.throws(() => env.call('setupBrandIntake'), /로그인|계정/);
  assert.throws(() => env.call('runHealthCheck'), /계정/);
  env.setUser('stranger@gmail.com');
  assert.throws(() => env.call('previewBrandIntakeRecovery'), /관리자/);
});

/* ---------------------------------------------------------------- 운영진 ↔ 최상위 폴더 */

function rootPerms(env) {
  return (env.drive.items[env.drive.root].permissions || []).map((p) => p.emailAddress + ':' + p.role).sort();
}

test('admins: list shows top folder access, sync adds missing editors without notification mail', () => {
  const { env } = setup();
  let list = ok(env.api('admins.list'));
  assert.deepEqual(list.admins.map((a) => [a.email, a.role, a.canEdit]), [['admin@beautyora.test', '', false], ['second@beautyora.test', '', false]]);
  assert.equal(list.me, 'admin@beautyora.test');
  const health = ok(env.api('system.health'));
  assert.equal(health.results.find((r) => r.target === '운영진 Drive 권한').status, '주의');
  assert.equal(health.results.find((r) => r.target === '운영센터 로그인').status, '정상');

  const preview = ok(env.api('admins.driveSync'));
  assert.deepEqual(preview.missing, ['admin@beautyora.test', 'second@beautyora.test']);
  assert.deepEqual(rootPerms(env), ['owner@beautyora.test:owner'], 'preview changes nothing');
  const applied = ok(env.api('admins.driveSync', { apply: true }));
  assert.deepEqual(applied.results.map((r) => r.result), ['added', 'added']);
  assert.deepEqual(rootPerms(env), ['admin@beautyora.test:writer', 'owner@beautyora.test:owner', 'second@beautyora.test:writer']);
  assert.ok(env.drive.notifications.every((n) => n.notify === false), 'staff get no Google share mail');
  list = ok(env.api('admins.list'));
  assert.ok(list.admins.every((a) => a.canEdit));
  assert.equal(ok(env.api('system.health')).results.find((r) => r.target === '운영진 Drive 권한').status, '정상');

  // 브랜드 폴더는 최상위 폴더 권한을 물려받는다.
  const folder = env.drive.folder('루엠 [BO-0001]', env.drive.root);
  const inherited = env.drive.api().Permissions.list(folder).permissions.map((p) => p.emailAddress + ':' + p.role).sort();
  assert.ok(inherited.includes('second@beautyora.test:writer'));
});

test('admins: add and remove keep the login list and the top folder editors together', () => {
  const { env } = setup();
  let r = ok(env.api('admins.update', { op: 'add', email: ' New.Staff@Gmail.com ' }));
  assert.equal(r.drive, 'added');
  assert.match(env.props.BO_ADMIN_EMAILS, /new\.staff@gmail\.com/);
  assert.ok(rootPerms(env).includes('new.staff@gmail.com:writer'));
  assert.equal(env.api('dashboard', {}, env.idToken('new.staff@gmail.com')).ok, true, 'new admin can sign in');

  r = ok(env.api('admins.update', { op: 'remove', email: 'new.staff@gmail.com' }));
  assert.equal(r.drive, 'removed');
  assert.ok(!rootPerms(env).some((p) => p.startsWith('new.staff@')));
  assert.equal(env.api('dashboard', {}, env.idToken('new.staff@gmail.com')).code, 'NOT_ADMIN', 'removed admin is locked out');

  // 소유자·실행 계정 권한은 빼지 않는다.
  env.props.BO_ADMIN_EMAILS += ', owner@beautyora.test';
  assert.equal(ok(env.api('admins.update', { op: 'remove', email: 'owner@beautyora.test' })).drive, 'kept');
  assert.ok(rootPerms(env).includes('owner@beautyora.test:owner'));

  assert.match(env.api('admins.update', { op: 'remove', email: 'admin@beautyora.test' }).message, /지금 로그인한 계정/);
  assert.match(env.api('admins.update', { op: 'add', email: 'second@beautyora.test' }).message, /이미 등록/);
  assert.match(env.api('admins.update', { op: 'add', email: 'not an email' }).message, /이메일/);
  assert.match(env.api('admins.update', { op: 'grant', email: 'x@y.z' }).message, /지원하지 않는/);
  env.props.BO_ADMIN_EMAILS = 'admin@beautyora.test, second@beautyora.test';
  ok(env.api('admins.update', { op: 'remove', email: 'second@beautyora.test' }, env.idToken('admin@beautyora.test')));
  assert.equal(env.api('admins.update', { op: 'remove', email: 'admin@beautyora.test' }, env.idToken('admin@beautyora.test')).ok, false, 'cannot remove yourself, so the list never empties');
  assert.equal(env.api('admins.update', { op: 'add', email: 'x@beautyora.test' }, env.idToken('stranger@gmail.com')).code, 'NOT_ADMIN');
});

test('admins: a Drive failure is reported but the login list change is kept', () => {
  const { env } = setup();
  env.drive.failPermissions = 'Insufficient permissions for this file';
  const r = ok(env.api('admins.update', { op: 'add', email: 'third@beautyora.test' }));
  assert.match(r.driveActionError, /Insufficient/);
  assert.match(r.driveError, /Insufficient/);
  assert.match(env.props.BO_ADMIN_EMAILS, /third@beautyora\.test/);
  assert.equal(ok(env.api('system.health')).results.find((r) => r.target === '운영진 Drive 권한').status, '주의');
});

/* ---------------------------------------------------------------- 브랜드 '자료 공유 이메일' */

function shareSetup() {
  const { env, data } = setup();
  const props = env.notion.sources[data.ids.brandId].properties;
  const folder = env.drive.folder('공동 | 루엠 · 셀리본 [BO-0001 · BO-0002]', env.drive.root);
  const patch = (page, values) => env.notion.handle('patch', 'https://api.notion.com/v1/pages/' + page.id, { properties: Object.fromEntries(Object.entries(values).map(([k, v]) => [props[k].id, k === '구글 드라이브' ? { url: v } : { rich_text: [{ text: { content: v } }] }])) });
  const url = 'https://drive.google.com/drive/folders/' + folder;
  patch(data.b1, { '구글 드라이브': url, '자료 공유 이메일': 'CEO@brand.example, admin@beautyora.test; 담당자, md@brand.example' });
  patch(data.b2, { '구글 드라이브': url, '자료 공유 이메일': 'cs@cellybon.example' });
  env.api('system.refresh');
  const perms = () => env.drive.permissionsOf(folder).filter((p) => !p.inherited).map((p) => p.emailAddress + ':' + p.role).sort();
  return { env, data, folder, patch, perms };
}

test('brand share: preview merges the shared folder, skips staff and typos, changes nothing', () => {
  const { env, folder, perms } = shareSetup();
  const plan = ok(env.api('brands.sharePreview', { code: 'BO-0001' }));
  assert.equal(plan.folderId, folder);
  assert.deepEqual(plan.brands.map((b) => b.code), ['BO-0001', 'BO-0002']);
  assert.deepEqual(plan.add.map((a) => a.email), ['ceo@brand.example', 'md@brand.example', 'cs@cellybon.example']);
  assert.deepEqual(plan.staff, ['admin@beautyora.test'], 'admins already reach every folder through the top folder');
  assert.deepEqual(plan.invalid, ['담당자']);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.missingProperty, false);
  assert.deepEqual(perms(), [], 'preview only');
  assert.match(env.api('brands.sharePreview', { code: 'BO-0003' }).message, /구글 드라이브 폴더 주소가 없습니다/);
  assert.equal(env.api('brands.sharePreview', { code: 'BO-0001' }, env.idToken('stranger@gmail.com')).code, 'NOT_ADMIN');
});

test('brand share: apply adds editors with the share mail, removes only what the ops center added', () => {
  const { env, data, folder, patch, perms } = shareSetup();
  // 직원이 Drive에서 직접 준 권한과, 이미 뷰어인 브랜드 이메일.
  env.drive.items[folder].permissions = [{ id: 'manual', type: 'user', role: 'writer', emailAddress: 'manual@partner.example' }, { id: 'viewer', type: 'user', role: 'reader', emailAddress: 'md@brand.example' }];
  const plan = ok(env.api('brands.sharePreview', { code: 'BO-0002' }));
  assert.deepEqual(plan.add.find((a) => a.email === 'md@brand.example'), { email: 'md@brand.example', current: 'reader' });
  const done = ok(env.api('brands.shareApply', { code: 'BO-0002', hash: plan.hash }));
  assert.deepEqual(done.results.map((r) => r.email + ':' + r.result), ['ceo@brand.example:added', 'md@brand.example:upgraded', 'cs@cellybon.example:added']);
  assert.deepEqual(perms(), ['ceo@brand.example:writer', 'cs@cellybon.example:writer', 'manual@partner.example:writer', 'md@brand.example:writer']);
  assert.ok(env.drive.notifications.every((n) => n.notify && /뷰티오라 입점 자료 폴더/.test(n.message)));
  assert.deepEqual(done.plan.add, [], 'nothing left to do');

  // Notion에서 이메일을 지우면 운영센터가 추가했던 권한만 뺀다(직접 준 권한은 그대로).
  patch(data.b1, { '자료 공유 이메일': 'md@brand.example' });
  env.api('system.refresh');
  const next = ok(env.api('brands.sharePreview', { code: 'BO-0001' }));
  assert.deepEqual(next.remove, ['ceo@brand.example']);
  ok(env.api('brands.shareApply', { code: 'BO-0001', hash: next.hash }));
  assert.deepEqual(perms(), ['cs@cellybon.example:writer', 'manual@partner.example:writer', 'md@brand.example:writer']);
  assert.equal(env.call('shareAddedList_', folder).join(','), 'md@brand.example,cs@cellybon.example');
});

test('brand share: a stale preview is refused, mail-less invites to non-Google addresses are reported', () => {
  const { env, data, patch, perms } = shareSetup();
  const plan = ok(env.api('brands.sharePreview', { code: 'BO-0001' }));
  patch(data.b2, { '자료 공유 이메일': 'cs@cellybon.example, new@cellybon.example' });
  env.api('system.refresh');
  const stale = env.api('brands.shareApply', { code: 'BO-0001', hash: plan.hash });
  assert.equal(stale.code, 'PLAN_CHANGED');
  assert.deepEqual(perms(), []);

  patch(data.b2, { '자료 공유 이메일': 'someone@nogoogle.test' });
  patch(data.b1, { '자료 공유 이메일': '' });
  env.api('system.refresh');
  const fresh = ok(env.api('brands.sharePreview', { code: 'BO-0001' }));
  const r = ok(env.api('brands.shareApply', { code: 'BO-0001', hash: fresh.hash, notify: false }));
  assert.equal(r.results[0].result, 'failed');
  assert.match(r.results[0].message, /Notify people/);
  assert.deepEqual(perms(), []);
  ok(env.api('brands.shareApply', { code: 'BO-0001', hash: fresh.hash, notify: true }));
  assert.deepEqual(perms(), ['someone@nogoogle.test:writer']);
});
