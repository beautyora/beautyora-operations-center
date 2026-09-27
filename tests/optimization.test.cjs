const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(files, globals = {}) {
  const context = vm.createContext({ ...globals });
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context, { filename: file });
  }
  return context;
}

{
  let id = '';
  const opened = [];
  const props = { getProperty: () => id };
  const context = load(['BO_Config.gs', 'BO_DataStore.gs', 'BO_Setup.gs', 'BeautyoraBrandSync.gs'], {
    PropertiesService: { getScriptProperties: () => props },
    SpreadsheetApp: { openById: value => { opened.push(value); return { getId: () => value }; } }
  });
  assert.throws(() => context.getDb_(), /BO_SPREADSHEET_ID/);
  assert.throws(() => context.setupBeautyoraSystem(), /BO_SPREADSHEET_ID/);
  assert.equal(opened.length, 0, 'DB ID가 없을 때 다른 시트를 열지 않는다');

  id = 'test-db';
  const sheet = { getDataRange: () => ({ getDisplayValues: () => [
    ['설정', '값'], ['TARGET_SPREADSHEET_ID', 'production-db']
  ] }) };
  context.SpreadsheetApp.openById = value => { opened.push(value); return { getId: () => value, getSheetByName: () => sheet }; };
  assert.throws(() => context.getConfig_(), /BO_SPREADSHEET_ID와 다릅니다/);
  sheet.getDataRange = () => ({ getDisplayValues: () => [['설정', '값']] });
  assert.throws(() => context.getConfig_(), /TARGET_SPREADSHEET_ID가 설정되지 않았습니다/);
  sheet.getDataRange = () => ({ getDisplayValues: () => [
    ['설정', '값'], ['TARGET_SPREADSHEET_ID', 'test-db']
  ] });
  assert.equal(context.getConfig_().TARGET_SPREADSHEET_ID, 'test-db');
  assert.equal(opened.length, 1, '같은 실행에서 동일 DB를 반복해서 열지 않는다');
  id = 'another-test-db';
  context.getDb_();
  assert.deepEqual(opened, ['test-db', 'another-test-db'], 'DB ID가 바뀌면 새 대상을 연다');
}

{
  const context = load(['BO_AdminService.gs'], {
    BOPS: { SHEETS: { LINKS: 'links', BRANDS: 'brands' } }
  });
  const rows = {
    links: [
      { '브랜드코드': 'BO-1', '상태': '사용 중', '토큰': 'old' },
      { '브랜드코드': 'BO-1', '상태': '중지', '토큰': 'stopped' },
      { '브랜드코드': 'BO-1', '상태': '사용 중', '토큰': 'latest' },
      { '브랜드코드': 'BO-2', '상태': '사용 중', '토큰': 'second' }
    ],
    brands: [
      { '브랜드 ID': 'BO-1', '브랜드명': '첫 브랜드' },
      { '브랜드 ID': 'BO-2', '브랜드명': '두 번째' }
    ]
  };
  context.safeObjects_ = name => rows[name];
  context.normalizeLink_ = row => ({ token: row['토큰'] });
  const all = context.listBrands_({});
  assert.deepEqual(Array.from(all, row => row.link && row.link.token), ['latest', 'second']);
  assert.deepEqual(Array.from(context.listBrands_({ query: '첫' }), row => row.brandCode), ['BO-1']);
}

console.log('환경 격리 및 브랜드 링크 조회 검증 통과');

