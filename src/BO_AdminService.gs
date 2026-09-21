function getAdminDashboard_() {
  const brands = safeObjects_(BOPS.SHEETS.BRANDS);
  const intake = safeObjects_(BOPS.SHEETS.INTAKE);
  const submissions = safeObjects_(BOPS.SHEETS.SUBMISSIONS);
  const files = safeObjects_(BOPS.SHEETS.FILES);
  const alerts = safeObjects_(BOPS.SHEETS.ALERTS).filter(row => row['상태'] !== '해결');
  const counts = {
    newBrands: intake.filter(row => /검토 대기|중복 의심|신규|미검토|접수/.test(row['등록 상태'] || row['상태'] || row['검토상태'] || '')).length,
    submissions: submissions.filter(row => row['상태'] === BOPS.STATUS.SUBMITTED).length,
    revisions: submissions.filter(row => row['상태'] === BOPS.STATUS.REVISION).length,
    missingFiles: files.filter(row => row['상태'] === '누락').length,
    errors: alerts.filter(row => /오류|긴급/.test(row['등급'])).length
  };
  return {
    counts: counts,
    recentActivity: safeObjects_(BOPS.SHEETS.LOGS).slice(-8).reverse().map(row => ({
      time: row['일시'], title: row['작업'], detail: row['상세'], targetId: row['대상ID']
    })),
    alerts: alerts.slice(-5).reverse().map(normalizeAlert_),
    totals: { brands: brands.length, submissions: submissions.length }
  };
}

function safeObjects_(name) {
  try { return sheetObjects_(name); } catch (error) { return []; }
}

function listBrands_(params) {
  const query = String(params.query || '').toLowerCase();
  const links = safeObjects_(BOPS.SHEETS.LINKS);
  return safeObjects_(BOPS.SHEETS.BRANDS).filter(row => {
    return !query || [brandValue_(row, '브랜드코드'), brandValue_(row, '회사명'), brandValue_(row, '브랜드명'), brandValue_(row, '담당자')].join(' ').toLowerCase().includes(query);
  }).map(row => {
    const link = links.slice().reverse().find(item => item['브랜드코드'] === brandValue_(row, '브랜드코드') && item['상태'] === '사용 중');
    return {
      brandCode: brandValue_(row, '브랜드코드'), companyName: brandValue_(row, '회사명'), brandName: brandValue_(row, '브랜드명'),
      salesStage: brandValue_(row, '영업단계'), manager: brandValue_(row, '담당자'), lastContact: brandValue_(row, '최근연락일'), nextContact: brandValue_(row, '다음연락일'),
      contractStatus: row['계약상태'] || '', productStatus: row['상품상태'] || '', driveFolderId: extractDriveId_(brandValue_(row, 'Drive폴더')),
      notionPageId: brandValue_(row, '노션페이지ID'), status: row['상태'] || '', link: link ? normalizeLink_(link) : null
    };
  });
}

function listProducts_(params) {
  params = params || {};
  const query = String(params.query || '').trim().toLowerCase();
  const brands = safeObjects_(BOPS.SHEETS.BRANDS);
  const brandMap = {};
  brands.forEach(function(row) {
    const code = String(brandValue_(row, '브랜드코드') || '').trim();
    if (code) brandMap[code] = row;
  });
  const sourceByUrl = {}, sourceByName = {};
  safeObjects_('_원본_노션_상품').forEach(function(row) {
    const url = String(row['노션URL'] || '').trim();
    const name = String(row['상품명'] || '').trim();
    if (url) sourceByUrl[url] = row;
    if (name && !sourceByName[name]) sourceByName[name] = row;
  });
  function sourceFor_(row) {
    return sourceByUrl[String(row['원본URL'] || '').trim()] || sourceByName[String(row['상품명'] || '').trim()] || {};
  }
  function imageFrom_(value) {
    if (!value) return '';
    if (Array.isArray(value)) return imageFrom_(value[0]);
    if (typeof value === 'object') return value.url || value.driveUrl || value.href || '';
    const text = String(value).trim();
    if (!text) return '';
    if (text.charAt(0) === '[' || text.charAt(0) === '{') {
      try { return imageFrom_(JSON.parse(text)); } catch (ignored) {}
    }
    const match = text.match(/https?:\/\/[^\s,"]+/);
    return match ? match[0] : text;
  }
  function sourceValue_(row, source, header) {
    const current = row[header], original = source[header];
    if ((current === '' || current == null || String(current) === '0') && original !== '' && original != null) return original;
    return current !== '' && current != null ? current : (original || '');
  }
  function tradeType_(row, source) {
    if (row['기본거래방식']) return row['기본거래방식'];
    const purchase = Number(String(sourceValue_(row, source, '매입가')).replace(/[^0-9.-]/g, '')) || 0;
    const consignment = Number(String(sourceValue_(row, source, '위탁공급가')).replace(/[^0-9.-]/g, '')) || 0;
    return purchase && consignment ? '혼합' : consignment ? '위탁' : purchase ? '매입' : '';
  }
  const byId = {};
  safeObjects_('상품').forEach(function(row) {
    const id = String(row['상품ID'] || '').trim();
    if (!id) return;
    const code = String(row['브랜드ID'] || row['브랜드코드'] || '').trim();
    const brand = brandMap[code] || {}, source = sourceFor_(row);
    byId[id] = {
      productId: id, brandCode: code, brandName: brandValue_(brand, '브랜드명') || '',
      companyName: brandValue_(brand, '회사명') || '', productName: row['상품명'] || '', optionName: row['옵션'] || row['옵션명'] || '',
      barcode: row['바코드'] || '', category: normalizeProductCategory_(row['카테고리'] || source['카테고리']), retailPrice: sourceValue_(row, source, '소비자가'),
      purchasePrice: sourceValue_(row, source, '매입가'), consignmentPrice: sourceValue_(row, source, '위탁공급가'),
      offlineConsignmentPrice: sourceValue_(row, source, '오프라인위탁소비자가'), moq: sourceValue_(row, source, 'MOQ'),
      onlineLowestPrice: sourceValue_(row, source, '온라인최저가'), tradeType: tradeType_(row, source),
      vendorAffiliation: source['벤더소속'] || '', salesChannels: source['노출채널'] || '',
      reviewStatus: row['검토상태'] || source['검토상태'] || '', status: String(row['활성']).toUpperCase() === 'FALSE' ? '중지' : '사용',
      productUrl: row['상품링크'] || source['상품링크'] || '', sourceUrl: row['원본URL'] || source['노션URL'] || '',
      mainImageUrl: imageFrom_(row['대표이미지URL'] || row['이미지'] || source['이미지']), detailPageUrl: '', approvedAt: ''
    };
  });
  safeObjects_(BOPS.SHEETS.PRODUCTS).forEach(function(row) {
    const id = String(row['상품ID'] || '').trim();
    if (!id) return;
    let data = {};
    try { data = JSON.parse(row['상품데이터JSON'] || '{}'); } catch (ignored) {}
    const code = String(row['브랜드코드'] || '').trim();
    const brand = brandMap[code] || {}, current = byId[id] || {};
    byId[id] = Object.assign({}, current, {
      productId: id, brandCode: code || current.brandCode || '', brandName: row['브랜드명'] || brandValue_(brand, '브랜드명') || current.brandName || '',
      companyName: brandValue_(brand, '회사명') || current.companyName || '', productName: row['상품명'] || data.product_name || current.productName || '',
      optionName: row['옵션명'] || data.option_name || current.optionName || '', barcode: row['바코드'] || data.barcode || current.barcode || '',
      category: normalizeProductCategory_(row['카테고리'] || data.category || current.category), retailPrice: row['소비자가'] || data.retail_price || current.retailPrice || '',
      purchasePrice: row['매입가'] || data.purchase_price || current.purchasePrice || '', consignmentPrice: row['위탁공급가'] || data.consignment_price || current.consignmentPrice || '',
      offlineConsignmentPrice: row['오프라인위탁소비자가'] || data.offline_consignment_price || current.offlineConsignmentPrice || '', moq: row['MOQ'] || data.moq || current.moq || '',
      onlineLowestPrice: data.online_lowest_price || current.onlineLowestPrice || '', tradeType: data.trade_type || current.tradeType || '',
      reviewStatus: current.reviewStatus || '승인 완료', status: row['상태'] || current.status || '사용',
      mainImageUrl: row['대표이미지URL'] || data.main_image_url || current.mainImageUrl || '', detailPageUrl: row['상세페이지URL'] || data.detail_page_url || current.detailPageUrl || '',
      approvedAt: row['승인일'] || current.approvedAt || ''
    });
  });
  return Object.keys(byId).map(function(id) { return byId[id]; }).filter(function(item) {
    if (params.status && item.status !== params.status) return false;
    if (params.category && item.category !== params.category) return false;
    if (params.tradeType && item.tradeType !== params.tradeType) return false;
    if (!query) return true;
    return [item.productId,item.brandCode,item.brandName,item.companyName,item.productName,item.optionName,item.barcode,item.category,item.vendorAffiliation].join(' ').toLowerCase().indexOf(query) >= 0;
  }).sort(function(a,b) { return String(a.brandName + a.productName).localeCompare(String(b.brandName + b.productName), 'ko'); });
}

function normalizeProductCategory_(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (text.charAt(0) === '[') {
    try { const list = JSON.parse(text); if (Array.isArray(list)) return list.join(', '); } catch (ignored) {}
  }
  return text;
}

function updateProduct_(payload) {
  return withLock_(function() {
    payload = payload || {};
    const productId = String(payload.productId || '').trim();
    if (!productId) throw new Error('상품ID가 없습니다.');
    const product = findOne_('상품', '상품ID', productId);
    if (!product) throw new Error('표준 상품 시트에서 상품을 찾을 수 없습니다. 신규 승인 상품은 상품 시트 반영 후 수정해 주세요.');
    const productName = String(payload.productName || '').trim();
    if (!productName) throw new Error('상품명은 필수입니다.');
    const barcode = String(payload.barcode || '').trim();
    if (barcode) {
      const duplicate = safeObjects_('상품').find(function(row) {
        return String(row['상품ID']) !== productId && String(row['바코드'] || '').trim() === barcode;
      });
      if (duplicate) throw new Error('같은 바코드가 이미 등록되어 있습니다: ' + duplicate['상품명']);
    }
    function price(value, label) {
      const text = String(value == null ? '' : value).replace(/[^0-9.-]/g, '');
      if (!text) return '';
      const number = Number(text);
      if (!isFinite(number) || number < 0) throw new Error(label + '은 0 이상의 숫자로 입력해 주세요.');
      return number;
    }
    const patch = {
      '상품명': productName,
      '옵션': String(payload.optionName || '').trim(),
      '바코드': barcode,
      '카테고리': String(payload.category || '').trim(),
      '소비자가': price(payload.retailPrice, '소비자가'),
      '온라인최저가': price(payload.onlineLowestPrice, '온라인 최저가'),
      '매입가': price(payload.purchasePrice, '매입가'),
      '위탁공급가': price(payload.consignmentPrice, '위탁공급가'),
      '오프라인위탁소비자가': price(payload.offlineConsignmentPrice, '오프라인 위탁 소비자가'),
      'MOQ': price(payload.moq, 'MOQ'),
      '기본거래방식': String(payload.tradeType || '').trim(),
      '검토상태': String(payload.reviewStatus || '').trim(),
      '상품링크': String(payload.productUrl || '').trim(),
      '대표이미지URL': String(payload.mainImageUrl || '').trim(),
      '벤더소속': String(payload.vendorAffiliation || '').trim(),
      '활성': payload.active === false || String(payload.active).toUpperCase() === 'FALSE' ? false : true,
      '수정일': now_(),
      '수정자': getActiveUserEmail_()
    };
    const sheet = getSheet_('상품');
    let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    ['매입가','위탁공급가','오프라인위탁소비자가','MOQ','대표이미지URL','벤더소속','수정일','수정자'].forEach(function(header) {
      if (headers.indexOf(header) < 0) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
        headers.push(header);
      }
    });
    const changes = [];
    Object.keys(patch).forEach(function(key) {
      if (key === '수정일' || key === '수정자') return;
      let before = String(product[key] == null ? '' : product[key]);
      let after = String(patch[key] == null ? '' : patch[key]);
      if (key === '활성') { before = before.toUpperCase(); after = after.toUpperCase(); }
      if (before !== after) changes.push(key + ': ' + (before || '(없음)') + ' → ' + (after || '(없음)'));
    });
    if (!changes.length) return { ok: true, changed: false, product: listProducts_({}).find(function(item) { return item.productId === productId; }) };
    updateObjectRow_('상품', product._row, patch);
    SpreadsheetApp.flush();
    logAction_('상품 정보 수정', '상품', productId, changes.join(' | '));
    return { ok: true, changed: true, changes: changes, product: listProducts_({}).find(function(item) { return item.productId === productId; }) };
  });
}

function listSubmissions_(params) {
  params = params || {};
  const status = params.status || '';
  const brands = safeObjects_(BOPS.SHEETS.BRANDS);
  const rows = safeObjects_(BOPS.SHEETS.SUBMISSIONS);
  const latestByProduct = {};
  rows.forEach(function(row) {
    const key = String(row['상품ID'] || row['제출ID'] || '').trim();
    if (key) latestByProduct[key] = row;
  });
  return Object.keys(latestByProduct).map(function(key) { return latestByProduct[key]; }).filter(function(row) {
    return !status || row['상태'] === status;
  }).map(function(row) {
    const brand = brands.find(function(item) { return item['브랜드코드'] === row['브랜드코드']; }) || {};
    let data = {};
    try { data = JSON.parse(row['상품데이터JSON'] || '{}'); } catch (ignored) {}
    const sourceId = String(data._source_submission_id || '');
    const source = sourceId ? rows.find(function(item) { return item['제출ID'] === sourceId; }) : null;
    let baseData = {};
    if (source) try { baseData = JSON.parse(source['상품데이터JSON'] || '{}'); } catch (ignored) {}
    const isChangeRequest = data._change_request === true || !!sourceId;
    return {
      submissionId: row['제출ID'], productId: row['상품ID'], brandCode: row['브랜드코드'], brandName: brand['브랜드명'] || '',
      status: row['상태'], submittedAt: row['제출일'], updatedAt: row['수정일'], reviewNote: row['검수메모'], data: data,
      isChangeRequest: isChangeRequest, sourceSubmissionId: sourceId, baseData: baseData
    };
  }).reverse();
}

function listFiles_(params) {
  return safeObjects_(BOPS.SHEETS.FILES).filter(row => !params.brandCode || row['브랜드코드'] === params.brandCode).map(row => ({
    fileId: row['파일ID'], brandCode: row['브랜드코드'], productId: row['상품ID'], category: row['분류'],
    fileName: row['파일명'], driveUrl: row['DriveURL'], uploadedAt: row['업로드일'], status: row['상태']
  })).reverse();
}

function listAlerts_() {
  return safeObjects_(BOPS.SHEETS.ALERTS).map(normalizeAlert_).reverse();
}

function normalizeAlert_(row) {
  return { alertId: row['알림ID'], level: row['등급'], category: row['구분'], title: row['제목'], detail: row['상세'],
    targetId: row['대상ID'], status: row['상태'], createdAt: row['발생일'], resolvedAt: row['해결일'] };
}

function issuePartnerLink_(brandCode, expiryDate) {
  const brand = findBrandByCode_(brandCode);
  if (!brand) throw new Error('브랜드를 찾을 수 없습니다.');
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  appendObject_(BOPS.SHEETS.LINKS, {
    '토큰': token, '브랜드코드': brandCode, '상태': '사용 중', '만료일': expiryDate || dateOnly_(new Date(Date.now() + 30*86400000)),
    '마지막접속': '', '발급일': now_(), '발급자': Session.getActiveUser().getEmail() || '관리자'
  });
  logAction_('상품등록 링크 발급', '브랜드', brandCode, expiryDate || '30일');
  const baseUrl = PropertiesService.getScriptProperties().getProperty(BOPS.PROPS.PARTNER_WEBAPP_URL) || ScriptApp.getService().getUrl();
  return { ok: true, token: token, url: baseUrl + '?view=partner&token=' + encodeURIComponent(token) };
}

function setPartnerLinkStatus_(token, status) {
  const row = findOne_(BOPS.SHEETS.LINKS, '토큰', token);
  if (!row) throw new Error('링크를 찾을 수 없습니다.');
  updateObjectRow_(BOPS.SHEETS.LINKS, row._row, { '상태': status });
  logAction_('상품등록 링크 ' + status, '파트너 링크', token.slice(0, 8), row['브랜드코드']);
  return { ok: true };
}

function normalizeLink_(row) {
  const baseUrl = PropertiesService.getScriptProperties().getProperty(BOPS.PROPS.PARTNER_WEBAPP_URL) || ScriptApp.getService().getUrl();
  return { token: row['토큰'], status: row['상태'], expiryDate: row['만료일'], lastAccess: row['마지막접속'],
    url: baseUrl + '?view=partner&token=' + encodeURIComponent(row['토큰']) };
}

function reviewSubmission_(payload) {
  return withLock_(function() {
    const submission = findOne_(BOPS.SHEETS.SUBMISSIONS, '제출ID', payload.submissionId);
    if (!submission) throw new Error('제출 건을 찾을 수 없습니다.');
    const action = payload.action;
    const nextStatus = action === 'approve' ? BOPS.STATUS.APPROVED : action === 'revision' ? BOPS.STATUS.REVISION : BOPS.STATUS.REJECTED;
    const reviewNote = action === 'approve' ? '' : (payload.note || '');
    updateObjectRow_(BOPS.SHEETS.SUBMISSIONS, submission._row, { '상태': nextStatus, '검수메모': reviewNote, '수정일': now_() });
    if (action === 'approve') upsertMasterProduct_(submission);
    logAction_('상품 ' + nextStatus, '상품 접수', payload.submissionId, reviewNote);
    return { ok: true, status: nextStatus };
  });
}

function upsertMasterProduct_(submission) {
  let data = {};
  try { data = JSON.parse(submission['상품데이터JSON'] || '{}'); } catch (ignored) {}
  const brand = findBrandByCode_(submission['브랜드코드']) || {};
  const existing = findOne_(BOPS.SHEETS.PRODUCTS, '상품ID', submission['상품ID']);
  const object = {
    '상품ID': submission['상품ID'], '브랜드코드': submission['브랜드코드'], '브랜드명': brandValue_(brand, '브랜드명'),
    '상품명': data.product_name || '', '옵션명': data.option_name || '', '바코드': data.barcode || '',
    '소비자가': data.retail_price || '', '매입가': data.purchase_price || '', '카테고리': data.category || '',
    '상태': '사용', '대표이미지URL': data.main_image_url || '', '상세페이지URL': data.detail_page_url || '',
    '승인일': now_(), '상품데이터JSON': JSON.stringify(data)
  };
  if (existing) updateObjectRow_(BOPS.SHEETS.PRODUCTS, existing._row, object); else appendObject_(BOPS.SHEETS.PRODUCTS, object);
}

function brandValue_(row, key) {
  const aliases = {
    '브랜드코드': ['브랜드코드','브랜드 ID'], '회사명': ['회사명','협력사/회사명'], '브랜드명': ['브랜드명'],
    '영업단계': ['영업단계','진행 단계'], '담당자': ['담당자','브랜드 담당자'], '최근연락일': ['최근연락일','최근 수정'],
    '다음연락일': ['다음연락일'], 'Drive폴더': ['Drive폴더ID','구글 드라이브'], '노션페이지ID': ['노션페이지ID','Notion 페이지 ID']
  };
  const names = aliases[key] || [key];
  for (let i = 0; i < names.length; i++) if (row && row[names[i]]) return row[names[i]];
  return '';
}

function findBrandByCode_(brandCode) {
  return safeObjects_(BOPS.SHEETS.BRANDS).find(row => brandValue_(row, '브랜드코드') === brandCode) || null;
}

function extractDriveId_(value) {
  const match = String(value || '').match(/[-\w]{20,}/);
  return match ? match[0] : '';
}


function listBrandIntake_(params) {
  const query = String((params && params.query) || '').toLowerCase();
  const status = String((params && params.status) || '');
  return safeObjects_(BOPS.SHEETS.INTAKE).filter(function(row) {
    const rowStatus = String(row['등록 상태'] || '');
    const haystack = [row['접수 ID'], row['회사명'], row['브랜드명'], row['사업자번호'], row['담당자명'], row['이메일']].join(' ').toLowerCase();
    return (!status || rowStatus === status) && (!query || haystack.indexOf(query) >= 0);
  }).map(function(row) {
    return {
      intakeId: row['접수 ID'] || '', receivedAt: row['접수 시각'] || '', companyName: row['회사명'] || '',
      brandName: row['브랜드명'] || '', businessNo: row['사업자번호'] || '', contactName: row['담당자명'] || '',
      phone: row['연락처'] || '', email: row['이메일'] || '', tradeType: row['희망 거래 방식'] || '',
      channels: row['희망 영역'] || row['순위 무관 희망 채널'] || '', feature: row['상품 특장점'] || '',
      referenceUrl: row['참고 URL'] || '', duplicateCheck: row['중복 검사'] || '', duplicateCandidate: row['기존 브랜드 후보'] || '',
      status: row['등록 상태'] || '', brandId: row['브랜드 ID'] || '', notionUrl: row['Notion URL'] || '', error: row['오류 메시지'] || ''
    };
  }).reverse();
}

function syncBrandIntake_() {
  const imported = importNewFormResponses_(false);
  logAction_('브랜드 신청 최신화', '입점 신청', 'FORM', imported + '개 행 추가');
  return { ok: true, imported: imported, rows: listBrandIntake_({}) };
}

function reviewBrandIntake_(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cfg = getConfig_();
    const book = SpreadsheetApp.openById(cfg.TARGET_SPREADSHEET_ID);
    const sheet = book.getSheetByName(cfg.INTAKE_SHEET_NAME);
    if (!sheet) throw new Error('신규 브랜드 접수·검토 시트를 찾을 수 없습니다.');
    const values = sheet.getDataRange().getDisplayValues();
    if (values.length < 2) throw new Error('검토할 신청이 없습니다.');
    const headers = values[0];
    const idCol = headers.indexOf('접수 ID');
    const statusCol = headers.indexOf('등록 상태');
    if (idCol < 0 || statusCol < 0) throw new Error('접수 ID 또는 등록 상태 열이 없습니다.');
    const rowIndex = values.findIndex(function(row, index) { return index > 0 && row[idCol] === payload.intakeId; });
    if (rowIndex < 1) throw new Error('입점 신청을 찾을 수 없습니다.');
    const nextStatus = payload.action === 'approve' ? BO.STATUS.APPROVED : BO.STATUS.HOLD;
    sheet.getRange(rowIndex + 1, statusCol + 1).setValue(nextStatus);
    SpreadsheetApp.flush();
    if (payload.action === 'approve') {
      createApprovedBrands_(false);
      refreshNotionMirror_(false);
    }
    logAction_('브랜드 ' + nextStatus, '입점 신청', payload.intakeId, payload.note || '');
    const rows = listBrandIntake_({});
    return { ok: true, row: rows.find(function(item) { return item.intakeId === payload.intakeId; }) || null };
  } finally {
    lock.releaseLock();
  }
}

function testProductCatalog() {
  const rows = listProducts_({});
  console.log('상품 마스터 조회: ' + rows.length + '개');
  return { ok: true, count: rows.length, sample: rows.slice(0, 2) };
}


function testProductUpdateNoChange() {
  const item = listProducts_({})[0];
  if (!item) throw new Error('테스트할 상품이 없습니다.');
  const result = updateProduct_({
    productId: item.productId, productName: item.productName, optionName: item.optionName, barcode: item.barcode,
    category: item.category, retailPrice: item.retailPrice, onlineLowestPrice: item.onlineLowestPrice,
    tradeType: item.tradeType, reviewStatus: item.reviewStatus, active: item.status !== '중지', productUrl: item.productUrl
  });
  console.log('상품 수정 무변경 점검: ' + JSON.stringify({ok: result.ok, changed: result.changed}));
  return result;
}
