function runHealthCheck() {
  const results = [];
  Object.values(BOPS.SHEETS).forEach(name => {
    const exists = !!getDb_().getSheetByName(name);
    results.push({ target: name, status: exists ? '정상' : '오류', message: exists ? '연결됨' : '시트가 없습니다.' });
    if (!exists) createAlert_('긴급', '구글 시트', '필수 시트 누락', name + ' 시트를 찾을 수 없습니다.', name);
  });
  results.push(checkDriveConnection_());
  results.push(checkNotionConnection_());
  const formResults = checkGoogleForm_();
  Array.prototype.push.apply(results, formResults);
  logAction_('시스템 연결 점검', '시스템', 'HEALTH', results.filter(item => item.status !== '정상').length + '개 확인 필요');
  return { ok: true, checkedAt: now_(), results: results };
}

function checkDriveConnection_() {
  const rootId = PropertiesService.getScriptProperties().getProperty(BOPS.PROPS.ROOT_FOLDER_ID);
  if (!rootId) {
    createAlert_('주의', 'Google Drive', '자료 폴더 미설정', '브랜드 제출자료 루트 폴더를 설정해 주세요.', 'ROOT_FOLDER');
    return { target: 'Google Drive', status: '주의', message: '루트 폴더 미설정' };
  }
  try {
    const folder = DriveApp.getFolderById(rootId);
    return { target: 'Google Drive', status: '정상', message: folder.getName() };
  } catch (error) {
    createAlert_('긴급', 'Google Drive', '자료 폴더 접근 실패', friendlyError_(error), 'ROOT_FOLDER');
    return { target: 'Google Drive', status: '오류', message: friendlyError_(error) };
  }
}

function checkNotionConnection_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(BOPS.PROPS.NOTION_TOKEN);
  const databaseId = props.getProperty(BOPS.PROPS.NOTION_DATABASE_ID);
  if (!token || !databaseId) {
    const mirror = getDb_().getSheetByName(BOPS.SHEETS.BRANDS);
    if (mirror && mirror.getLastColumn() > 0) {
      return { target: 'Notion', status: '정상', message: '기존 자동연동 시트 연결됨' };
    }
    createAlert_('오류', 'Notion', '브랜드 자동연동 시트 누락', BOPS.SHEETS.BRANDS + ' 시트를 찾을 수 없습니다.', 'NOTION_MIRROR');
    return { target: 'Notion', status: '오류', message: '자동연동 시트 누락' };
  }
  try {
    const response = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + databaseId, {
      method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token, 'Notion-Version': '2022-06-28' }
    });
    if (response.getResponseCode() !== 200) throw new Error('HTTP ' + response.getResponseCode());
    return { target: 'Notion', status: '정상', message: '브랜드 DB 연결됨' };
  } catch (error) {
    createAlert_('오류', 'Notion', '브랜드 DB 연결 실패', friendlyError_(error), 'NOTION_DB');
    return { target: 'Notion', status: '오류', message: friendlyError_(error) };
  }
}

function checkGoogleForm_() {
  const formId = PropertiesService.getScriptProperties().getProperty(BOPS.PROPS.GOOGLE_FORM_ID);
  if (!formId) {
    const intake = getDb_().getSheetByName(BOPS.SHEETS.INTAKE);
    if (intake && intake.getLastColumn() > 0) {
      return [{ target: '구글폼', status: '정상', message: '기존 응답·검토 시트 연결됨' }];
    }
    createAlert_('오류', '구글폼', '브랜드 접수 시트 누락', BOPS.SHEETS.INTAKE + ' 시트를 찾을 수 없습니다.', 'FORM_INTAKE');
    return [{ target: '구글폼', status: '오류', message: '접수 시트 누락' }];
  }
  try {
    const form = FormApp.openById(formId);
    const items = form.getItems().map(item => ({ id: String(item.getId()), title: item.getTitle(), type: String(item.getType()), options: getFormOptions_(item), required: getFormRequired_(item) }));
    const mappings = safeObjects_(BOPS.SHEETS.FORM_MAP);
    const results = [{ target: '구글폼', status: form.isAcceptingResponses() ? '정상' : '오류', message: form.isAcceptingResponses() ? '응답 수집 중' : '응답 수집 중지' }];
    mappings.forEach(mapping => {
      const item = items.find(candidate => candidate.id === String(mapping['구글폼질문ID']));
      if (!item) {
        createAlert_('오류', '구글폼', '폼 질문 누락: ' + mapping['현재질문명'], '질문이 삭제되었거나 새 질문으로 교체되었습니다.', mapping['내부ID']);
        results.push({ target: mapping['현재질문명'], status: '오류', message: '질문 ID를 찾을 수 없음' });
      } else {
        const renamed = item.title !== mapping['현재질문명'];
        let mappedOptions = [];
        try { mappedOptions = JSON.parse(mapping['선택지JSON'] || '[]'); } catch (ignored) {}
        const optionsChanged = mappedOptions.length && JSON.stringify(mappedOptions) !== JSON.stringify(item.options);
        if (renamed) {
          createAlert_('주의', '구글폼', '폼 질문 이름 변경', mapping['현재질문명'] + ' → ' + item.title, mapping['내부ID']);
          results.push({ target: item.title, status: '주의', message: '표시 이름 변경됨' });
        } else if (optionsChanged) {
          createAlert_('주의', '구글폼', '폼 선택지 변경: ' + item.title, '기존 선택지와 현재 선택지가 다릅니다.', mapping['내부ID']);
          results.push({ target: item.title, status: '주의', message: '선택지 변경됨' });
        } else results.push({ target: item.title, status: '정상', message: '질문 연결됨' });
      }
    });
    return results;
  } catch (error) {
    createAlert_('긴급', '구글폼', '브랜드 신청폼 접근 실패', friendlyError_(error), 'GOOGLE_FORM');
    return [{ target: '구글폼', status: '오류', message: friendlyError_(error) }];
  }
}

function discoverGoogleFormItems() {
  assertAdmin_();
  const formId = PropertiesService.getScriptProperties().getProperty(BOPS.PROPS.GOOGLE_FORM_ID);
  if (!formId) throw new Error('구글폼 ID를 먼저 설정해 주세요.');
  return FormApp.openById(formId).getItems().map(item => ({ id: String(item.getId()), title: item.getTitle(), type: String(item.getType()), options: getFormOptions_(item), required: getFormRequired_(item) }));
}

function getFormOptions_(item) {
  try {
    const type = item.getType();
    if (type === FormApp.ItemType.MULTIPLE_CHOICE) return item.asMultipleChoiceItem().getChoices().map(choice => choice.getValue());
    if (type === FormApp.ItemType.CHECKBOX) return item.asCheckboxItem().getChoices().map(choice => choice.getValue());
    if (type === FormApp.ItemType.LIST) return item.asListItem().getChoices().map(choice => choice.getValue());
  } catch (ignored) {}
  return [];
}

function getFormRequired_(item) {
  try {
    const type = item.getType();
    if (type === FormApp.ItemType.MULTIPLE_CHOICE) return item.asMultipleChoiceItem().isRequired();
    if (type === FormApp.ItemType.CHECKBOX) return item.asCheckboxItem().isRequired();
    if (type === FormApp.ItemType.LIST) return item.asListItem().isRequired();
    if (type === FormApp.ItemType.TEXT) return item.asTextItem().isRequired();
    if (type === FormApp.ItemType.PARAGRAPH_TEXT) return item.asParagraphTextItem().isRequired();
  } catch (ignored) {}
  return false;
}

function saveFormMappings(mappings) {
  assertAdmin_();
  const sheet = getSheet_(BOPS.SHEETS.FORM_MAP);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  if (mappings.length) {
    const rows = mappings.map(item => [item.internalId, item.formItemId, item.title, !!item.required, '정상', now_(), JSON.stringify(item.options || [])]);
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  return runHealthCheck();
}
