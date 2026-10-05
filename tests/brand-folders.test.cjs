'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, seed } = require('./harness.cjs');

function setup() {
  const env = createEnv(), data = seed(env);
  // Existing server fixtures share a business number. Keep each focused scenario independent.
  for (const page of [data.b1, data.b2, data.b3]) {
    env.notion.applyProps(page, env.notion.sources[data.ids.brandId], { '사업자 번호': { rich_text: [] } });
  }
  return { env, data };
}
const rich = value => ({ rich_text: value ? [{ text: { content: value } }] : [] });
const title = value => ({ title: [{ text: { content: value } }] });
const url = id => 'https://drive.google.com/drive/folders/' + id;
const folderId = value => /\/folders\/([^/?#]+)/.exec(value)[1];
const roots = env => Object.values(env.drive.items).filter(x => x.folder && !x.trashed && x.parents[0] === env.drive.root);
const children = (env, id) => Object.values(env.drive.items).filter(x => x.parents[0] === id);
function add(env, data, code, name, company, bizNo = '', drive = '') {
  return env.notion.createPage(data.ids.brandId, {
    '브랜드명': title(name), '브랜드 ID': rich(code), '협력사/회사명': rich(company),
    '사업자 번호': rich(bizNo), '구글 드라이브': { url: drive || null }
  });
}
function edit(env, data, page, properties) {
  env.notion.applyProps(page, env.notion.sources[data.ids.brandId], properties);
}
function ok(result) {
  assert.equal(result.ok, true, result.message);
  return JSON.parse(JSON.stringify(result.data));
}
function create(env, code) { return ok(env.api('brands.folder', { code })); }

test('folder naming: raw company punctuation and hyphens are preserved, layout delimiters are cleaned, blank company falls back', () => {
  const { env, data } = setup();
  add(env, data, 'BO-0011', '알파/베타', '  주식회사 A-B:코스메틱  ');
  assert.equal(env.call('brandFolderLabel_', 'A[BO-0099]|B', ''), 'A BO-0099 B');
  const first = create(env, 'BO-0011');
  assert.equal(env.drive.items[folderId(first.url)].name, '주식회사 A-B:코스메틱 | 알파/베타 [BO-0011]');
  add(env, data, 'BO-0012', '회사없는브랜드', ' \t ');
  env.clearCache();
  const second = create(env, 'BO-0012');
  assert.equal(env.drive.items[folderId(second.url)].name, '회사 미확인 | 회사없는브랜드 [BO-0012]');
});

test('folder naming: BO-0065 has the confirmed display-company override without modifying Notion', () => {
  const { env, data } = setup();
  const page = add(env, data, 'BO-0065', '에코브랜드', '기존 회사명', '123-45-67890');
  edit(env, data, page, { '핵심 메모': rich('영업팀 원문'), '이메일': rich('owner@example.com') });
  const before = JSON.parse(JSON.stringify(page.properties));
  const result = create(env, 'BO-0065');
  assert.equal(env.drive.items[folderId(result.url)].name, '에코프리베(주) | 에코브랜드 [BO-0065]');
  const after = JSON.parse(JSON.stringify(page.properties));
  delete before['구글 드라이브']; delete after['구글 드라이브'];
  assert.deepEqual(after, before);
});

test('folder naming: existing shared URLs include all active members in numeric BO order and deduplicate company labels', () => {
  const { env, data } = setup();
  const parent = env.drive.folder('outside configured root', null);
  const folder = env.drive.folder('manually named shared folder', parent);
  env.drive.items[folder].sharing = 'PRIVATE:EDIT';
  const asset = env.drive.file({ name: 'keep.pdf', parents: [folder] });
  add(env, data, 'BO-10100', '마지막', '회사A', '', url(folder));
  add(env, data, 'BO-0100', '중간', '회사B', '', url(folder));
  add(env, data, 'BO-0009', '첫째', '회사A', '', 'https://drive.google.com/drive/u/0/folders/' + folder + '?usp=sharing');
  const archived = add(env, data, 'BO-0010', '보관된브랜드', '보관회사', '', url(folder));
  archived.archived = true;
  const trashed = add(env, data, 'BO-0012', '삭제된브랜드', '삭제회사', '', url(folder));
  trashed.in_trash = true;
  const result = create(env, 'BO-0100');
  assert.equal(result.url, url(folder));
  assert.equal(result.created, false);
  assert.equal(env.drive.items[folder].name, '회사A · 회사B | 첫째 · 중간 · 마지막 [BO-0009 · BO-0100 · BO-10100]');
  assert.deepEqual(env.drive.items[folder].parents, [parent]);
  assert.equal(env.drive.items[folder].sharing, 'PRIVATE:EDIT');
  assert.deepEqual(env.drive.items[asset.id].parents, [folder]);
  assert.equal(roots(env).length, 0, 'linked folders outside the configured root are reused in place');
});

test('folder naming: complete fresh Notion reads retain linked brands beyond pagination and cached rows', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('shared legacy name', env.drive.root);
  const first = add(env, data, 'BO-0200', '이전이름', '회사', '', url(folder));
  ok(env.api('brands.list'));
  edit(env, data, first, { '브랜드명': title('최신이름') });
  for (let i = 0; i < 105; i++) add(env, data, 'BO-' + (1000 + i), '무관' + i, '다른회사');
  add(env, data, 'BO-0300', '뒤쪽브랜드', '회사', '', url(folder));
  create(env, 'BO-0200');
  assert.equal(env.drive.items[folder].name, '회사 | 최신이름 · 뒤쪽브랜드 [BO-0200 · BO-0300]');
});

test('folder reuse: name/company collisions never identify a folder without a BO token or business match', () => {
  const { env, data } = setup();
  add(env, data, 'BO-0011', '같은브랜드', '같은회사');
  const names = ['같은브랜드', '같은회사', '같은회사 | 같은브랜드 [BO-00110]', '같은회사 | 같은브랜드 [XBO-0011]'];
  const existing = names.map(name => env.drive.folder(name, env.drive.root));
  const result = create(env, 'BO-0011');
  assert.ok(!existing.includes(folderId(result.url)));
  assert.equal(roots(env).length, 5);
  assert.deepEqual(existing.map(id => env.drive.items[id].name), names);
});

test('folder reuse: exact BO tokens in joint names preserve all known members without an existing URL', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('old company | old labels [BO-0012 · BO-0011]', env.drive.root);
  add(env, data, 'BO-0012', '둘째', '회사');
  add(env, data, 'BO-0011', '첫째', '회사');
  const result = create(env, 'BO-0011');
  assert.equal(result.url, url(folder));
  assert.equal(env.drive.items[folder].name, '회사 | 첫째 · 둘째 [BO-0011 · BO-0012]');
  assert.equal(roots(env).length, 1);
});

test('folder reuse: unique normalized 10-digit business number reuses an established folder despite different company text', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('[BO-0012] 이전브랜드', env.drive.root);
  const old = add(env, data, 'BO-0012', '둘째', '회사 원문B', '123-45-67890', url(folder));
  const added = add(env, data, 'BO-0011', '첫째', '회사 원문A', '1234567890');
  const unrelated = add(env, data, 'BO-0013', '아직미연결', '회사 원문A', '1234567890');
  const oldBefore = JSON.stringify(old.properties);
  const result = create(env, 'BO-0011');
  assert.equal(result.url, url(folder));
  assert.equal(roots(env).length, 1);
  assert.equal(env.drive.items[folder].name, '회사 원문A · 회사 원문B | 첫째 · 둘째 [BO-0011 · BO-0012]');
  assert.equal(added.properties['구글 드라이브'].url, url(folder));
  assert.equal(unrelated.properties['구글 드라이브'].url, null, 'unlinked business peers are not silently patched or claimed');
  assert.equal(JSON.stringify(old.properties), oldBefore, 'existing Notion properties remain untouched');
});

test('folder reuse: business matching accepts a peer exact-code folder, and rejects malformed or partial numbers', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('이전브랜드 (BO-0012)', env.drive.root);
  add(env, data, 'BO-0012', '둘째', '회사', '987-65-43210');
  add(env, data, 'BO-0011', '첫째', '다른회사', '9876543210');
  assert.equal(create(env, 'BO-0011').url, url(folder));
  for (const [i, bizNo] of ['12345', '사업자 9876543210', '9876543210 / 1111111111', '98765432101'].entries()) {
    const code = 'BO-00' + (20 + i);
    add(env, data, code, '분리' + i, '회사', bizNo);
    env.clearCache();
    assert.notEqual(create(env, code).url, url(folder), bizNo);
  }
  assert.equal(roots(env).length, 5);
});

test('folder reuse: repeated-digit placeholder business numbers cannot merge unrelated folders', () => {
  for (const bizNo of ['0000000000', '000-00-00000', '1111111111']) {
    const { env, data } = setup();
    const folder = env.drive.folder('기존 폴더', env.drive.root);
    add(env, data, 'BO-0012', '기존', '회사', bizNo, url(folder));
    add(env, data, 'BO-0011', '신규', '회사', bizNo);
    const result = create(env, 'BO-0011');
    assert.notEqual(result.url, url(folder), bizNo);
    assert.equal(roots(env).length, 2, bizNo);
    assert.equal(env.drive.items[folder].name, '기존 폴더');
  }
});

test('folder reuse: unknown, archived, trashed or conflicting existing BO tokens stop rename instead of dropping members', () => {
  for (const kind of ['unknown', 'archived', 'trashed', 'conflicting', 'comma-unknown', 'comma-archived']) {
    const { env, data } = setup();
    const separator = kind.startsWith('comma-') ? ', ' : ' · ';
    const folder = env.drive.folder('이전회사 | 첫째 · 둘째 [BO-0011' + separator + 'BO-0012]', env.drive.root);
    const page = add(env, data, 'BO-0011', '첫째', '회사', '', url(folder));
    if (!kind.endsWith('unknown')) {
      const peer = add(env, data, 'BO-0012', '둘째', '회사', '', url(folder));
      if (kind.endsWith('archived')) peer.archived = true;
      if (kind === 'trashed') peer.in_trash = true;
      if (kind === 'conflicting') {
        const other = env.drive.folder('별도 폴더', env.drive.root);
        edit(env, data, peer, { '구글 드라이브': { url: url(other) } });
      }
    }
    const before = JSON.stringify(env.drive.items), props = JSON.stringify(page.properties);
    const result = env.api('brands.folder', { code: 'BO-0011' });
    assert.equal(result.ok, false, kind);
    assert.match(result.message, /확인|일치|누락|공동/, kind);
    assert.equal(JSON.stringify(env.drive.items), before, kind);
    assert.equal(JSON.stringify(page.properties), props, kind);
  }
});

test('folder reuse: one business number pointing to several folders stops before any Drive mutation or Notion patch', () => {
  const { env, data } = setup();
  const a = env.drive.folder('first', env.drive.root), b = env.drive.folder('second', env.drive.root);
  add(env, data, 'BO-0012', '둘째', '회사', '1234567890', url(a));
  add(env, data, 'BO-0013', '셋째', '회사', '123-45-67890', url(b));
  const page = add(env, data, 'BO-0011', '첫째', '회사', '1234567890');
  const before = JSON.stringify(env.drive.items), props = JSON.stringify(page.properties);
  const result = env.api('brands.folder', { code: 'BO-0011' });
  assert.equal(result.ok, false);
  assert.match(result.message, /여러|확인/);
  assert.equal(JSON.stringify(env.drive.items), before);
  assert.equal(JSON.stringify(page.properties), props);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + page.id], undefined);
});

test('folder reuse: unavailable, invalid or trashed existing URLs never fall back to a matching root folder', () => {
  for (const kind of ['missing', 'invalid', 'trashed']) {
    const { env, data } = setup();
    const matching = env.drive.folder('[BO-0011] 후보', env.drive.root);
    const selected = env.drive.folder('selected', env.drive.root);
    if (kind === 'trashed') env.drive.items[selected].trashed = true;
    const drive = kind === 'missing' ? url('missing-folder') : kind === 'invalid' ? 'https://example.com/not-drive' : url(selected);
    const page = add(env, data, 'BO-0011', '브랜드', '회사', '', drive);
    env.props['BO_BRAND_FOLDER_PENDING_' + page.id] = matching;
    env.props['BO_BRAND_FOLDER_ID_' + page.id] = matching;
    const before = JSON.stringify(env.drive.items);
    assert.equal(env.api('brands.folder', { code: 'BO-0011' }).ok, false, kind);
    assert.equal(JSON.stringify(env.drive.items), before, kind);
    assert.equal(page.properties['구글 드라이브'].url, drive, kind);
  }
});

test('folder reuse: persistent page mapping survives manual rename and removed Notion URL', () => {
  const { env, data } = setup();
  const page = add(env, data, 'BO-0011', '원래브랜드', '원래회사');
  const folder = folderId(create(env, 'BO-0011').url);
  assert.equal(env.props['BO_BRAND_FOLDER_ID_' + page.id], folder);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + page.id], undefined);
  env.drive.items[folder].name = '사람이 직접 지정한 폴더명';
  edit(env, data, page, { '구글 드라이브': { url: null }, '브랜드명': title('새브랜드'), '협력사/회사명': rich('새회사') });
  const result = create(env, 'BO-0011');
  assert.equal(result.url, url(folder));
  assert.equal(roots(env).length, 1);
  assert.equal(env.drive.items[folder].name, '새회사 | 새브랜드 [BO-0011]');
  assert.equal(page.properties['구글 드라이브'].url, url(folder));
});

test('folder reuse: unavailable pending or persistent folders never fall through to duplicate creation', () => {
  for (const prefix of ['BO_BRAND_FOLDER_PENDING_', 'BO_BRAND_FOLDER_ID_']) {
    const { env, data } = setup();
    const page = add(env, data, 'BO-0011', '브랜드', '회사');
    env.drive.folder('[BO-0011] fallback candidate', env.drive.root);
    env.props[prefix + page.id] = 'missing-folder';
    const before = JSON.stringify(env.drive.items);
    assert.equal(env.api('brands.folder', { code: 'BO-0011' }).ok, false, prefix);
    assert.equal(JSON.stringify(env.drive.items), before, prefix);
    assert.equal(page.properties['구글 드라이브'].url, null);
  }
});

test('folder reuse: a failed complete Notion membership read prevents rename or partial folder preparation', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('[BO-0011] original', env.drive.root);
  add(env, data, 'BO-0011', '브랜드', '회사', '', url(folder));
  ok(env.api('brands.list'));
  const query = env.context.notionQueryAll_;
  env.context.notionQueryAll_ = (source, body, ...args) => {
    if (source === data.ids.brandId && !body.filter) throw new Error('membership query failed');
    return query(source, body, ...args);
  };
  const before = JSON.stringify(env.drive.items);
  assert.equal(env.api('brands.folder', { code: 'BO-0011' }).ok, false);
  assert.equal(JSON.stringify(env.drive.items), before);
});

test('folder reuse: BO-0032 and BO-0033 without URLs are excluded from automatic and manual folder creation', () => {
  const { env, data } = setup();
  env.call('setupBeautyora');
  const baseline = JSON.parse(env.props.BO_BRAND_FOLDERS_BASELINE);
  const own = ['BO-0032', 'BO-0033'].map((code, i) => add(env, data, code, '자사' + i, '뷰티오라'));
  own.forEach(page => { page.created_time = baseline.since; });
  for (const code of ['BO-0032', 'BO-0033']) assert.equal(create(env, code).created, false);
  const result = ok(env.api('brands.foldersSync'));
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.failed, []);
  assert.equal(roots(env).length, 0);
  own.forEach(page => assert.equal(page.properties['구글 드라이브'].url, null));
});

test('folder reuse: own brands with an explicit existing URL are maintained without creating another parent', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('explicit own folder', env.drive.root);
  add(env, data, 'BO-0032', '자사브랜드', '뷰티오라', '', url(folder));
  const result = create(env, 'BO-0032');
  assert.equal(result.url, url(folder));
  assert.equal(result.created, false);
  assert.equal(roots(env).length, 1);
  assert.equal(env.drive.items[folder].name, '뷰티오라 | 자사브랜드 [BO-0032]');
});

test('folder recovery: failed rename is retried in place before children, template or Notion URL changes', () => {
  const { env, data } = setup();
  const folder = env.drive.folder('[BO-0011] old', env.drive.root);
  const page = add(env, data, 'BO-0011', '새브랜드', '새회사');
  env.props.BO_TEMPLATE_FILE_ID = env.drive.file({ name: '양식.xlsx', parents: [env.drive.root] }).id;
  const folderApi = env.drive.folderApi.bind(env.drive);
  let fail = true;
  env.drive.folderApi = id => {
    const api = folderApi(id), rename = api.setName;
    api.setName = name => { if (id === folder && fail) { fail = false; throw new Error('rename interrupted'); } return rename(name); };
    return api;
  };
  assert.equal(env.api('brands.folder', { code: 'BO-0011' }).ok, false);
  assert.equal(env.drive.items[folder].name, '[BO-0011] old');
  assert.equal(children(env, folder).length, 0);
  assert.equal(env.drive.copies || 0, 0);
  assert.equal(page.properties['구글 드라이브'].url, null);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + page.id], folder);
  assert.equal(create(env, 'BO-0011').url, url(folder));
  assert.equal(roots(env).length, 1);
  assert.equal(env.drive.items[folder].name, '새회사 | 새브랜드 [BO-0011]');
  assert.equal(children(env, folder).length, 4);
  assert.equal(env.drive.copies, 1);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + page.id], undefined);
});

test('folder recovery: lost successful Notion patch response preserves the URL and retries without copies', () => {
  const { env, data } = setup();
  const page = add(env, data, 'BO-0011', '브랜드', '회사');
  env.props.BO_TEMPLATE_FILE_ID = env.drive.file({ name: '양식.xlsx', parents: [env.drive.root] }).id;
  const patch = env.context.notionPatch_;
  env.context.notionPatch_ = (...args) => { patch(...args); throw new Error('response lost after commit'); };
  assert.equal(env.api('brands.folder', { code: 'BO-0011' }).ok, false);
  const committed = page.properties['구글 드라이브'].url;
  assert.ok(committed);
  const before = JSON.stringify(env.drive.items);
  env.context.notionPatch_ = patch;
  const result = create(env, 'BO-0011');
  assert.equal(result.url, committed);
  assert.equal(result.created, false);
  assert.equal(JSON.stringify(env.drive.items), before);
  assert.equal(env.drive.copies, 1);
  assert.equal(env.props['BO_BRAND_FOLDER_PENDING_' + page.id], undefined);
  assert.equal(env.props['BO_BRAND_FOLDER_ID_' + page.id], folderId(committed));
});
