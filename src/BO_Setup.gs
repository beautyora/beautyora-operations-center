function setupBeautyoraSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('구글 시트에 연결된 Apps Script에서 실행해 주세요.');
  const props = PropertiesService.getScriptProperties();
  props.setProperty(BOPS.PROPS.SPREADSHEET_ID, '1bC_HNAQcroDgveEsISik7hui9RvUTgQb6bMrTUiILjY');
  if (!props.getProperty(BOPS.PROPS.ROOT_FOLDER_ID)) {
    props.setProperty(BOPS.PROPS.ROOT_FOLDER_ID, '1UFLlB0plUMuphVhgvF6kUMLhCV3nDNVN');
  }
  props.setProperty(BOPS.PROPS.PARTNER_WEBAPP_URL, 'https://script.google.com/macros/s/AKfycbwWlj4WX95rewTS0gGKL2ne_qQErbrNB-9tR-pTPoy4oyZEIE4EW3BuZSQa3gMfbNOc/exec');
  if (!props.getProperty(BOPS.PROPS.ADMIN_EMAILS)) {
    props.setProperty(BOPS.PROPS.ADMIN_EMAILS, 'beautyora.contact@gmail.com');
  }

  Object.keys(HEADERS).forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    const headers = HEADERS[name];
    const current = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getDisplayValues()[0] : [];
    headers.forEach((header, index) => {
      if (!current.includes(header)) sheet.getRange(1, index + 1).setValue(header);
    });
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f2f2f7');
    sheet.autoResizeColumns(1, headers.length);
  });

  const fields = getSheet_(BOPS.SHEETS.FIELDS);
  if (fields.getLastRow() === 1) fields.getRange(2, 1, DEFAULT_FIELDS.length, DEFAULT_FIELDS[0].length).setValues(DEFAULT_FIELDS);

  installTriggers_();
  runHealthCheck();
  return { ok: true, spreadsheetId: ss.getId() };
}

function installTriggers_() {
  const existing = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  if (!existing.includes('scheduledHealthCheck')) {
    ScriptApp.newTrigger('scheduledHealthCheck').timeBased().everyHours(1).create();
  }
}

function scheduledHealthCheck() {
  try { runHealthCheck(); } catch (error) { logException_(error, 'scheduledHealthCheck'); }
}

function configureSystem(settings) {
  assertAdmin_();
  const allowed = [BOPS.PROPS.ROOT_FOLDER_ID, BOPS.PROPS.GOOGLE_FORM_ID, BOPS.PROPS.NOTION_TOKEN,
    BOPS.PROPS.NOTION_DATABASE_ID, BOPS.PROPS.ADMIN_EMAILS, BOPS.PROPS.PARTNER_WEBAPP_URL];
  const props = PropertiesService.getScriptProperties();
  allowed.forEach(key => {
    if (settings[key] !== undefined) props.setProperty(key, String(settings[key] || '').trim());
  });
  runHealthCheck();
  return getSettings_();
}

function getSettings_() {
  const props = PropertiesService.getScriptProperties();
  const fields = sheetObjects_(BOPS.SHEETS.FIELDS).map(row => ({
    id: row['내부ID'], label: row['표시이름'], type: row['입력형식'], required: isTrue_(row['필수']),
    active: isTrue_(row['사용']), order: Number(row['순서']) || 999, options: row['선택지'], help: row['도움말'], excel: isTrue_(row['엑셀포함'])
  })).sort((a,b) => a.order - b.order);
  const hasGoogleFormPipeline = !!getDb_().getSheetByName(BOPS.SHEETS.INTAKE);
  const hasNotionPipeline = !!getDb_().getSheetByName(BOPS.SHEETS.BRANDS);
  return {
    fields: fields,
    adminEmails: (props.getProperty(BOPS.PROPS.ADMIN_EMAILS) || '').split(',').map(v => v.trim()).filter(Boolean),
    connections: {
      rootFolderConfigured: !!props.getProperty(BOPS.PROPS.ROOT_FOLDER_ID),
      googleFormConfigured: !!props.getProperty(BOPS.PROPS.GOOGLE_FORM_ID) || hasGoogleFormPipeline,
      notionConfigured: !!(props.getProperty(BOPS.PROPS.NOTION_TOKEN) && props.getProperty(BOPS.PROPS.NOTION_DATABASE_ID)) || hasNotionPipeline,
      spreadsheetId: props.getProperty(BOPS.PROPS.SPREADSHEET_ID) || ''
    }
  };
}

function saveAdminEmails_(emails) {
  const normalized = (Array.isArray(emails) ? emails : String(emails || '').split(','))
    .map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
  if (!normalized.length) throw new Error('관리자 이메일을 한 개 이상 입력해 주세요.');
  if (normalized.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('관리자 이메일 형식을 확인해 주세요.');
  }
  const unique = [...new Set(normalized)];
  const current = (Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!current || !unique.includes(current)) {
    throw new Error('현재 로그인한 관리자 계정은 목록에서 제거할 수 없습니다.');
  }
  PropertiesService.getScriptProperties().setProperty(BOPS.PROPS.ADMIN_EMAILS, unique.join(','));
  logAction_('관리자 계정 설정 변경', '설정', 'ADMIN_EMAILS', unique.join(', '));
  return getSettings_();
}

function saveFieldSettings_(fields) {
  if (!Array.isArray(fields) || !fields.length) throw new Error('상품 항목이 비어 있습니다.');
  const ids = {};
  fields.forEach(field => {
    if (!/^[a-z][a-z0-9_]*$/.test(field.id)) throw new Error('내부 ID 형식이 올바르지 않습니다: ' + field.id);
    if (ids[field.id]) throw new Error('중복된 내부 ID입니다: ' + field.id);
    ids[field.id] = true;
  });
  ['product_name','barcode'].forEach(id => { if (!ids[id]) throw new Error('필수 내부 항목을 삭제할 수 없습니다: ' + id); });
  const sheet = getSheet_(BOPS.SHEETS.FIELDS);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  const rows = fields.map((field, index) => [field.id, field.label, field.type, !!field.required, field.active !== false,
    Number(field.order) || index + 1, field.options || '', field.help || '', field.excel !== false]);
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  logAction_('상품 항목 설정 변경', '설정', 'FIELDS', rows.length + '개 항목');
  return getSettings_();
}

function isTrue_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '사용' || String(value) === '필수';
}
