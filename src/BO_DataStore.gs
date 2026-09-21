function getDb_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(BOPS.PROPS.SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('관리 시트가 연결되지 않았습니다. 시트에서 초기 설정을 실행해 주세요.');
  props.setProperty(BOPS.PROPS.SPREADSHEET_ID, active.getId());
  return active;
}

function getSheet_(name) {
  const sheet = getDb_().getSheetByName(name);
  if (!sheet) throw new Error('필수 시트가 없습니다: ' + name);
  return sheet;
}

function sheetObjects_(name) {
  const sheet = getSheet_(name);
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).filter(row => row.some(Boolean)).map((row, index) => {
    const object = { _row: index + 2 };
    headers.forEach((header, i) => object[header] = normalizeSheetDisplayValue_(header, row[i]));
    return object;
  });
}

function normalizeSheetDisplayValue_(header, value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const dateHeader = /(일|일자|시각|날짜)$/.test(String(header || '')) || /(접수|제출|수정|등록|발생|처리|해결|만료)/.test(String(header || ''));
  if (!dateHeader || !/^\d{5}(?:\.\d+)?$/.test(text)) return value;
  const serial = Number(text);
  if (serial < 20000 || serial > 80000) return value;
  const date = new Date(Math.round((serial - 25569) * 86400000));
  return Utilities.formatDate(date, 'GMT', serial % 1 ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
}

function appendObject_(name, object) {
  const sheet = getSheet_(name);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  sheet.appendRow(headers.map(header => object[header] === undefined ? '' : object[header]));
  return sheet.getLastRow();
}

function updateObjectRow_(name, rowNumber, patch) {
  const sheet = getSheet_(name);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  Object.keys(patch).forEach(key => {
    const col = headers.indexOf(key) + 1;
    if (col > 0) sheet.getRange(rowNumber, col).setValue(patch[key]);
  });
}

function findOne_(name, header, value) {
  return sheetObjects_(name).find(row => String(row[header]) === String(value)) || null;
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function dateOnly_(date) {
  return Utilities.formatDate(date || new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
}

function uuid_(prefix) {
  return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16).toUpperCase();
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return callback(); } finally { lock.releaseLock(); }
}

function logAction_(action, targetType, targetId, detail) {
  try {
    appendObject_(BOPS.SHEETS.LOGS, {
      '이력ID': uuid_('LOG-'), '일시': now_(), '사용자': Session.getActiveUser().getEmail() || '외부 브랜드',
      '작업': action, '대상구분': targetType, '대상ID': targetId || '', '상세': detail || ''
    });
  } catch (ignored) {}
}

function createAlert_(level, category, title, detail, targetId) {
  const signature = [level, category, title, targetId || ''].join('|');
  const existing = sheetObjects_(BOPS.SHEETS.ALERTS).find(row =>
    row['상태'] !== '해결' && [row['등급'], row['구분'], row['제목'], row['대상ID']].join('|') === signature);
  if (existing) return existing['알림ID'];
  const id = uuid_('ALT-');
  appendObject_(BOPS.SHEETS.ALERTS, {
    '알림ID': id, '등급': level, '구분': category, '제목': title, '상세': detail || '',
    '대상ID': targetId || '', '상태': '미확인', '발생일': now_(), '해결일': ''
  });
  return id;
}

function logException_(error, context) {
  console.error(context, error && error.stack ? error.stack : error);
  try { createAlert_('오류', '시스템', context + ' 실행 오류', friendlyError_(error), context); } catch (ignored) {}
}

function resolveAlert_(alertId) {
  const row = findOne_(BOPS.SHEETS.ALERTS, '알림ID', alertId);
  if (!row) throw new Error('알림을 찾을 수 없습니다.');
  updateObjectRow_(BOPS.SHEETS.ALERTS, row._row, { '상태': '해결', '해결일': now_() });
  return { ok: true };
}
