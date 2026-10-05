'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, seed } = require('./harness.cjs');

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STAFF = { emailAddress: 'admin@beautyora.test', displayName: '운영진', me: false };
const BRAND = { emailAddress: 'ceo@brand.example', displayName: '루엠 대표', me: false };
const T0 = Date.UTC(2026, 9, 5, 0, 0);
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();

function ok(result) {
  assert.equal(result.ok, true, result.message);
  return JSON.parse(JSON.stringify(result.data));
}

/** 기준 시트(뷰티오라_브랜드사_상품정보목록) '상품리스트' 탭과 같은 머리글 구조. */
function productTab(lines) {
  return [
    ['뷰티오라(BEAUTYORA) 계약완료 브랜드사 상품정보 작성표'],
    ['사업자 상호', '', '(업체정보_서류 시트에 입력)'],
    ['번호', '브랜드 · 상품 정보', '', '', '', '온라인 최저가', '거래 유형', '공급가 (VAT 포함)', '', '오프라인 판매가 기준금액', '매입 MOQ', '핵심포인트', '제품설명', '제품링크', '이미지 자료', '', 'POP·와블러', '특이사항'],
    ['', '브랜드명', '제품이미지', '상품명 (옵션명)', '바코드번호', '', '', '매입 시', '위탁 시', '', '', '', '', '', '썸네일 1000×1000 Y/N', '상세페이지 준비 Y/N', '', ''],
    ['예시', '예시브랜드', '', 'A상품 50ml', '8801234567890', '10,000', '매입', '4,500', '', '자유', '100'],
    ...lines,
    ['3', '', '', '', '', '', '', '', '', '', '']
  ];
}

function setup() {
  const env = createEnv();
  const data = seed(env);
  const props = env.notion.sources[data.ids.brandId].properties;
  const setDrive = (page, folderId) => env.notion.handle('patch', 'https://api.notion.com/v1/pages/' + page.id, { properties: { [props['구글 드라이브'].id]: { url: 'https://drive.google.com/drive/folders/' + folderId } } });
  const d = env.drive;
  const addFile = (name, parent, extra) => Object.assign(d.file({ name, mimeType: (extra && extra.mimeType) || 'image/jpeg', parents: [parent] }), { createdTime: at(0), modifiedTime: at(0), owners: [STAFF], lastModifyingUser: STAFF }, extra || {});

  // BO-0001: 브랜드가 섬네일을 올리고 기준 시트를 작성 중(한 행은 바코드 없음).
  const f1 = d.folder('루엠 주식회사 | 루엠 [BO-0001]', d.root);
  const thumbs = d.folder('01_섬네일', f1);
  d.folder('02_상세페이지', f1);
  const sheet1 = addFile('루엠_뷰티오라_브랜드사_상품정보목록.xlsx', f1, { mimeType: XLSX, modifiedTime: at(30), lastModifyingUser: BRAND });
  sheet1.sheetTabs = { '안내': [['안내']], '상품리스트': productTab([
    ['1', '루엠', '', '시카 앰플 30ml', '8800000000011', '19,000', '매입', '7,000', '', '자유', '20'],
    ['2', '루엠', '', '수분 크림 50ml', '', '25,000', '위탁', '', '12,000', '22000', '']
  ]) };
  addFile('앰플_정면.jpg', thumbs, { createdTime: at(20), modifiedTime: at(20), owners: [BRAND], lastModifyingUser: BRAND });
  setDrive(data.b1, f1);

  // BO-0002: 기준 시트만 받았고 활동 없음. 직원이 넣은 파일은 브랜드 활동이 아니다.
  const f2 = d.folder('셀리본 주식회사 | 셀리본 [BO-0002]', d.root);
  addFile('셀리본_뷰티오라_브랜드사_상품정보목록.xlsx', f2, { mimeType: XLSX });
  addFile('계약서.pdf', f2, { mimeType: 'application/pdf', createdTime: at(40), modifiedTime: at(40) });
  setDrive(data.b2, f2);

  // BO-0003: 폴더는 있지만 기준 시트가 없다.
  const f3 = d.folder('새싹랩 주식회사 | 새싹랩 [BO-0003]', d.root);
  setDrive(data.b3, f3);
  env.api('system.refresh');
  return { env, data, d, f1, f2, f3, sheet1, addFile, setDrive };
}

test('brand activity: uploads, sheet progress and folders without a sheet', () => {
  const { env, d } = setup();
  const before = Object.keys(env.notion.pages || {}).length;
  const r = ok(env.api('brands.activity'));
  const by = (code) => r.rows.find((row) => row.brands.some((b) => b.code === code));

  const ruem = by('BO-0001');
  assert.equal(ruem.status, 'writing');
  assert.equal(ruem.uploads, 1, 'thumbnail uploaded by the brand (sub folder counts)');
  assert.deepEqual([ruem.sheet.rows, ruem.sheet.incomplete], [2, 1]);
  assert.deepEqual(ruem.sheet.missing, { '바코드': 1 });
  assert.equal(ruem.lastActor, '루엠 대표');
  assert.equal(ruem.lastAction, '시트 작성');
  assert.equal(ruem.firstActivityAt, at(20), 'first brand activity stands in for "opened the folder"');

  const celly = by('BO-0002');
  assert.equal(celly.status, 'waiting');
  assert.equal(celly.uploads, 0);
  assert.equal(celly.staffFiles, 1, 'files from staff are not brand activity');
  assert.equal(celly.sheet.byBrand, false);

  assert.equal(by('BO-0003').status, 'no_sheet');
  assert.deepEqual(r.rows.map((row) => row.status), ['writing', 'waiting', 'no_sheet'], 'most active first');
  assert.equal(r.counts.writing, 1);
  assert.equal(r.pending, 0);

  // 읽기만 한다: 브랜드 폴더에 새 파일이 생기지 않고 임시 사본은 내 드라이브에서 바로 휴지통으로 간다.
  const temps = Object.values(d.items).filter((f) => /운영센터 자료 확인/.test(f.name || ''));
  assert.equal(temps.length, 1);
  assert.ok(temps.every((f) => f.trashed && f.parents.indexOf('root') >= 0 && f.parents.length === 1), 'temp copy lives outside the brand folder and is trashed');
  assert.equal(Object.keys(env.notion.pages || {}).length, before, 'Notion untouched');
});

test('brand activity: finished sheet asks for review, anonymous edits count as the brand, cache refreshes', () => {
  const { env, d, sheet1, f3, addFile } = setup();
  assert.equal(ok(env.api('brands.activity')).rows[0].status, 'writing');

  // 브랜드가 빠진 바코드를 채운다 → 수정 시각이 바뀌어 다시 읽는다.
  sheet1.sheetTabs['상품리스트'][6][4] = '8800000000028';
  sheet1.modifiedTime = at(45);
  const cached = ok(env.api('brands.activity'));
  assert.equal(cached.rows[0].status, 'writing', 'served from the short cache');
  const fresh = ok(env.api('brands.activity', { fresh: true }));
  const ruem = fresh.rows.find((row) => row.brands[0].code === 'BO-0001');
  assert.equal(ruem.status, 'review');
  assert.deepEqual([ruem.sheet.rows, ruem.sheet.incomplete], [2, 0]);

  // 로그인하지 않은 브랜드의 편집(lastModifyingUser 없음)도 브랜드 활동이다.
  const anon = addFile('새싹랩_뷰티오라_브랜드사_상품정보목록.xlsx', f3, { mimeType: XLSX, modifiedTime: at(50) });
  delete anon.lastModifyingUser;
  anon.sheetTabs = { '상품리스트': productTab([]) };
  const sprout = ok(env.api('brands.activity', { fresh: true })).rows.find((row) => row.brands[0].code === 'BO-0003');
  assert.equal(sprout.status, 'writing');
  assert.equal(sprout.lastActor, '익명');
  assert.equal(sprout.sheet.rows, 0);
  assert.ok(Object.values(d.items).filter((f) => /운영센터 자료 확인/.test(f.name || '')).every((f) => f.trashed));
});

test('brand activity: shared company folder is one row, brands without a folder are listed apart, sheets are read a few at a time', () => {
  const { env, data, d, setDrive, addFile } = setup();
  // 같은 회사 폴더를 쓰는 브랜드 두 곳 + 폴더 없는 브랜드 + 작성 중 시트 5개(한 번에 4개까지 읽음).
  const props = env.notion.sources[data.ids.brandId].properties;
  const page = (name, code) => env.notion.handle('post', 'https://api.notion.com/v1/pages', { parent: { data_source_id: data.ids.brandId }, properties: { [props['브랜드명'].id]: { title: [{ text: { content: name } }] }, [props['브랜드 ID'].id]: { rich_text: [{ text: { content: code } }] }, [props['진행 단계'].id]: { select: { name: '확정' } } } });
  const shared = d.folder('보아스테크 | 원씨드 · 닥터라이트 [BO-0019 · BO-0044]', d.root);
  setDrive(page('원씨드', 'BO-0019'), shared);
  setDrive(page('닥터라이트', 'BO-0044'), shared);
  page('폴더없음', 'BO-0050');
  for (let i = 0; i < 4; i++) {
    const f = d.folder('브랜드' + i + ' [BO-006' + i + ']', d.root);
    setDrive(page('브랜드' + i, 'BO-006' + i), f);
    const s = addFile('브랜드' + i + '_뷰티오라_브랜드사_상품정보목록.xlsx', f, { mimeType: XLSX, modifiedTime: at(10 + i), lastModifyingUser: BRAND });
    s.sheetTabs = { '상품리스트': productTab([['1', '브랜드' + i, '', '상품', '880', '1,000', '공통', '500', '600', '자유', '']]) };
  }
  env.api('system.refresh');

  const first = ok(env.api('brands.activity'));
  const sharedRow = first.rows.filter((row) => row.folderId === shared);
  assert.equal(sharedRow.length, 1);
  assert.deepEqual(sharedRow[0].brands.map((b) => b.code), ['BO-0019', 'BO-0044']);
  assert.equal(first.rows.find((row) => row.brands[0].code === 'BO-0050').status, 'no_folder');
  assert.equal(first.counts.no_folder, 1);
  assert.equal(first.pending, 1, 'five edited sheets, four read now');
  assert.equal(first.rows.filter((row) => row.sheet && row.sheet.pending).length, 1);

  const next = ok(env.api('brands.activity', { fresh: true }));
  assert.equal(next.pending, 0, 'the rest is read on the next poll; earlier results come from cache');
  assert.equal(next.counts.review, 4, '공통 거래는 매입·위탁 공급가가 모두 있어야 완료');
  assert.equal(Object.values(d.items).filter((f) => /운영센터 자료 확인/.test(f.name || '')).length, 5, 'each sheet version is read once');
});

test('sheet progress parser follows the template headers and skips example rows', () => {
  const env = createEnv();
  const p = env.call('productSheetProgress_', productTab([
    ['1', 'A', '', '상품', '880', '1,000', '공통', '500', '', '자유', ''],
    ['2', '', '', '', '', '', '', '', '', '', '']
  ]));
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { rows: 1, incomplete: 1, missing: { '위탁 공급가': 1 } });
  assert.equal(env.call('productSheetProgress_', [['아무 표']]).unreadable, true);
});
