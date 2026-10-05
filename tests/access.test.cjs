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

test('brand share: the dialog shows the Notion emails, folder access, the shared folder, and changes nothing', () => {
  const { env, folder, perms } = shareSetup();
  env.drive.items[folder].permissions = [{ id: 'manual', type: 'user', role: 'writer', emailAddress: 'manual@partner.example' }, { id: 'v', type: 'user', role: 'reader', emailAddress: 'md@brand.example' }];
  const st = ok(env.api('brands.share', { code: 'BO-0001' }));
  assert.equal(st.folderId, folder);
  assert.equal(st.notionText, 'CEO@brand.example, admin@beautyora.test; 담당자, md@brand.example');
  assert.deepEqual(st.emails, ['ceo@brand.example', 'admin@beautyora.test', 'md@brand.example']);
  assert.deepEqual(st.invalid, ['담당자']);
  assert.deepEqual(st.driveOnly, ['manual@partner.example'], 'shared in Drive but not in Notion: shown so saving does not surprise');
  assert.deepEqual(st.others, [{ code: 'BO-0002', name: '셀리본', emails: ['cs@cellybon.example'] }]);
  assert.equal(st.access['md@brand.example'], 'viewer');
  assert.equal(st.access['manual@partner.example'], 'editor');
  assert.equal(st.missingProperty, false);
  assert.deepEqual(perms(), ['manual@partner.example:writer', 'md@brand.example:reader'], 'opening changes nothing');
  assert.match(env.api('brands.share', { code: 'BO-0003' }).message, /구글 드라이브 폴더 주소가 없습니다/);
  assert.equal(env.api('brands.share', { code: 'BO-0001' }, env.idToken('stranger@gmail.com')).code, 'NOT_ADMIN');
});

test('brand share: saving writes Notion and makes Drive match the list, with no notification mail', () => {
  const { env, data, folder, perms } = shareSetup();
  env.drive.items[folder].permissions = [{ id: 'manual', type: 'user', role: 'writer', emailAddress: 'manual@partner.example' }, { id: 'v', type: 'user', role: 'reader', emailAddress: 'md@brand.example' }];
  const st = ok(env.api('brands.share', { code: 'BO-0001' }));
  // 직원이 창에서 manual 계정을 지우고 새 이메일을 더한다(운영진 이메일은 남아 있어도 건드리지 않음).
  const r = ok(env.api('brands.shareSave', { code: 'BO-0001', before: st.notionText, emails: 'ceo@brand.example\nmd@brand.example\nadmin@beautyora.test\nNew@Brand.example' }));
  assert.deepEqual(r.results.map((x) => x.email + ':' + x.result).sort(), ['ceo@brand.example:added', 'cs@cellybon.example:added', 'manual@partner.example:removed', 'md@brand.example:upgraded', 'new@brand.example:added']);
  assert.deepEqual(perms(), ['ceo@brand.example:writer', 'cs@cellybon.example:writer', 'md@brand.example:writer', 'new@brand.example:writer'], 'the other brand in the same folder keeps access');
  assert.ok(env.drive.notifications.every((n) => n.notify === false), 'no Google share mail');
  const notion = ok(env.api('brands.list')).brands.find((b) => b.code === 'BO-0001').shareEmails;
  assert.equal(notion, 'ceo@brand.example, md@brand.example, admin@beautyora.test, new@brand.example', 'Notion now holds the list as saved');
  assert.deepEqual(r.state.driveOnly, []);

  // 목록에서 지우면 권한이 빠진다. 빈 목록이면 이 브랜드 이메일은 모두 빠지고 같은 폴더의 다른 브랜드 이메일은 남는다.
  const again = ok(env.api('brands.shareSave', { code: 'BO-0001', before: notion, emails: '' }));
  assert.deepEqual(again.results.map((x) => x.result), ['removed', 'removed', 'removed']);
  assert.deepEqual(perms(), ['cs@cellybon.example:writer']);
  assert.equal(ok(env.api('brands.list')).brands.find((b) => b.code === 'BO-0001').shareEmails, '');
  assert.ok(env.drive.items[env.drive.root].permissions.some((p) => p.role === 'owner'), 'owner untouched');
});

test('brand share: opening and saving re-read only that brand, never the whole Notion list (keeps home and brands fast)', () => {
  const { env, data, patch } = shareSetup();
  ok(env.api('brands.list'));
  const query = 'POST /data_sources/' + data.ids.brandId + '/query';
  const before = env.notion.calls.filter((c) => c === query).length;
  patch(data.b1, { '자료 공유 이메일': 'fresh@brand.example' });
  const st = ok(env.api('brands.share', { code: 'BO-0001' }));
  assert.equal(st.notionText, 'fresh@brand.example', 'a value just typed in Notion shows up');
  ok(env.api('brands.shareSave', { code: 'BO-0001', before: st.notionText, emails: 'fresh@brand.example, md@brand.example' }));
  assert.equal(ok(env.api('brands.list')).brands.find((b) => b.code === 'BO-0001').shareEmails, 'fresh@brand.example, md@brand.example');
  assert.equal(env.notion.calls.filter((c) => c === query).length, before, 'no Notion list query');
});

test('brand share: a stale dialog, a typo or a non-Google address never half-saves silently', () => {
  const { env, data, patch, perms } = shareSetup();
  const st = ok(env.api('brands.share', { code: 'BO-0001' }));
  patch(data.b1, { '자료 공유 이메일': 'someone.else@brand.example' });
  const stale = env.api('brands.shareSave', { code: 'BO-0001', before: st.notionText, emails: 'ceo@brand.example' });
  assert.equal(stale.code, 'CHANGED');
  assert.deepEqual(perms(), [], 'nothing changed in Drive');

  const typo = env.api('brands.shareSave', { code: 'BO-0001', before: 'someone.else@brand.example', emails: 'ceo@brand, ok@brand.example' });
  assert.equal(typo.code, 'BAD_EMAIL');
  assert.match(typo.message, /ceo@brand/);
  assert.equal(ok(env.api('brands.list')).brands.find((b) => b.code === 'BO-0001').shareEmails, 'someone.else@brand.example', 'Notion untouched on a typo');

  const r = ok(env.api('brands.shareSave', { code: 'BO-0001', before: 'someone.else@brand.example', emails: 'friend@nogoogle.test, ok@brand.example' }));
  const failed = r.results.find((x) => x.email === 'friend@nogoogle.test');
  assert.equal(failed.result, 'failed');
  assert.match(failed.message, /Google 계정이 아닌 이메일/);
  assert.deepEqual(perms(), ['cs@cellybon.example:writer', 'ok@brand.example:writer']);
});
