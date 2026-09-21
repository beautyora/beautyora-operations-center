/**
 * 뷰티오라 브랜드 자동화 (Google Form/Sheet -> Notion -> Google Sheet mirror)
 *
 * 원칙
 * 1) Notion 기존 페이지는 절대 수정/삭제하지 않는다. (POST create only)
 * 2) 폼 응답은 검토 시트에 먼저 적재한다.
 * 3) 사용자가 "등록 승인"으로 바꾼 행만 Notion에 생성한다.
 * 4) 브랜드 전체 목록은 Notion의 읽기 전용 미러로만 갱신한다.
 */

const BO = Object.freeze({
  TARGET_SPREADSHEET_ID: '1bC_HNAQcroDgveEsISik7hui9RvUTgQb6bMrTUiILjY',
  CONFIG_SHEET: '_SYNC_CONFIG',
  LOG_SHEET: '_SYNC_LOG',
  ERROR_SHEET: '_SYNC_ERRORS',
  NOTION_VERSION: '2025-09-03',
  INTAKE_HEADERS: [
    '접수 ID', '폼 원본 행', '접수 시각', '회사명', '브랜드명', '사업자번호',
    '담당자명', '연락처', '이메일', '희망 거래 방식', '희망 영역', '상품 특장점',
    '참고 URL', '3만원 미만 상품', '판매 채널', '개인정보 동의', '중복 검사',
    '기존 브랜드 후보', '등록 상태', '브랜드 ID', 'Notion 페이지 ID', 'Notion URL',
    '오류 메시지', '처리 시각', '폼 원본 링크', '브랜드 런칭일자',
    '희망 채널 1순위', '희망 채널 2순위', '순위 무관 희망 채널', '현재 판매 채널'
  ],
  STATUS: Object.freeze({
    REVIEW: '검토 대기',
    SUSPECT: '중복 의심',
    APPROVED: '등록 승인',
    EXISTING: '기존 등록',
    HOLD: '보류',
    DONE: '등록 완료',


    ERROR: '오류'
  })
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('뷰티오라 자동화')
    .addItem('1. 신규 폼 응답 가져오기', 'importNewFormResponses')
    .addItem('2. 승인 브랜드 Notion 등록', 'createApprovedBrands')
    .addItem('3. Notion 전체 목록 새로고침', 'refreshNotionMirror')
    .addSeparator()
    .addItem('전체 동기화 실행', 'runBeautyoraSync')
    .addItem('자동 트리거 설치', 'installBeautyoraTriggers')
    .addItem('설정/연결 점검', 'checkBeautyoraSetup')
    .addToUi();
}

function runBeautyoraSync() {
  return withBrandSyncLock_('전체 동기화', function () {
    const imported = importNewFormResponses_(false);
    const created = createApprovedBrands_(false);
    const mirrored = refreshNotionMirror_(false);
    toast_('가져오기 ' + imported + '건 · 생성 ' + created + '건 · 미러 ' + mirrored + '건');
    return { imported: imported, created: created, mirrored: mirrored };
  });
}

function importNewFormResponses() {
  return withBrandSyncLock_('신규 폼 응답 가져오기', function () {
    const count = importNewFormResponses_(true);
    toast_('신규 응답 ' + count + '건을 반영했습니다.');
    return count;
  });
}

function createApprovedBrands() {
  return withBrandSyncLock_('승인 브랜드 Notion 등록', function () {
    const count = createApprovedBrands_(true);
    toast_('Notion 신규 브랜드 ' + count + '건을 생성했습니다.');
    return count;
  });
}

function refreshNotionMirror() {
  return withBrandSyncLock_('Notion 전체 목록 새로고침', function () {
    const count = refreshNotionMirror_(true);
    toast_('Notion 브랜드 ' + count + '건으로 미러를 갱신했습니다.');
    return count;
  });
}

function handleBrandFormSubmit() {
  return importNewFormResponses();
}

function checkBeautyoraSetup() {
  const cfg = getConfig_();
  const required = [
    'SOURCE_SPREADSHEET_ID', 'SOURCE_SHEET_NAME', 'TARGET_SPREADSHEET_ID',
    'INTAKE_SHEET_NAME', 'MIRROR_SHEET_NAME', 'NOTION_DATA_SOURCE_ID'
  ];
  const missing = required.filter(function (key) { return !cfg[key]; });
  if (missing.length) throw new Error('설정값 누락: ' + missing.join(', '));

  const target = SpreadsheetApp.openById(cfg.TARGET_SPREADSHEET_ID);
  if (!target.getSheetByName(cfg.INTAKE_SHEET_NAME)) throw new Error('접수·검토 시트를 찾지 못했습니다.');
  if (!target.getSheetByName(cfg.MIRROR_SHEET_NAME)) throw new Error('브랜드 미러 시트를 찾지 못했습니다.');
  SpreadsheetApp.openById(cfg.SOURCE_SPREADSHEET_ID).getSheetByName(cfg.SOURCE_SHEET_NAME);

  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) {
    SpreadsheetApp.getUi().alert(
      '시트 구조는 정상입니다.\n\n아직 NOTION_TOKEN이 없습니다. Apps Script의 프로젝트 설정 → 스크립트 속성에 NOTION_TOKEN을 추가하세요.'
    );
    return false;
  }
  notionRequest_('get', '/data_sources/' + encodeURIComponent(cfg.NOTION_DATA_SOURCE_ID));
  SpreadsheetApp.getUi().alert('Google Sheet와 Notion 연결이 모두 정상입니다.');
  return true;
}

function installBeautyoraTriggers() {
  const cfg = getConfig_();
  const handlers = { handleBrandFormSubmit: true, scheduledBeautyoraSync: true };
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers[trigger.getHandlerFunction()]) ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('handleBrandFormSubmit')
    .forSpreadsheet(cfg.SOURCE_SPREADSHEET_ID)
    .onFormSubmit()
    .create();

  [9, 13, 17].forEach(function (hour) {
    ScriptApp.newTrigger('scheduledBeautyoraSync')
      .timeBased()
      .atHour(hour)
      .nearMinute(10)
      .everyDays(1)
      .inTimezone(cfg.TIMEZONE || 'Asia/Seoul')
      .create();
  });
  toast_('폼 제출 트리거 1개와 일일 보정 트리거 3개를 설치했습니다.');
}

function scheduledBeautyoraSync() {
  return runBeautyoraSync();
}

function importNewFormResponses_(showUi) {
  const cfg = getConfig_();
  const source = SpreadsheetApp.openById(cfg.SOURCE_SPREADSHEET_ID).getSheetByName(cfg.SOURCE_SHEET_NAME);
  const targetBook = SpreadsheetApp.openById(cfg.TARGET_SPREADSHEET_ID);
  const intake = targetBook.getSheetByName(cfg.INTAKE_SHEET_NAME);
  if (!source || !intake) throw new Error('원본 또는 접수·검토 시트를 찾지 못했습니다.');

  const lastSourceRow = source.getLastRow();
  const lastSourceColumn = source.getLastColumn();
  if (lastSourceRow < 2 || lastSourceColumn < 1) return 0;

  // 행 번호는 정렬·삽입·삭제에 따라 바뀌므로 체크포인트로 사용하지 않는다.
  // 원본 응답 전체를 읽고, 접수 시트에 없는 응답 고유키만 추가한다.
  const sourceValues = source.getRange(1, 1, lastSourceRow, lastSourceColumn).getValues();
  const sourceHeaders = sourceValues[0].map(clean_);
  const sourceMap = buildFormSourceMap_(sourceHeaders);
  const processedIndex = buildProcessedFormKeyIndex_(intake);
  const existing = buildDuplicateIndex_(targetBook, intake, cfg.MIRROR_SHEET_NAME);
  let nextIntakeNumber = findMaxIntakeNumber_(intake) + 1;
  const now = new Date();
  const output = [];
  const isCurrentForm = sourceMap.channel2 != null || sourceMap.channelAny != null || sourceMap.launchDate != null;
  let newResponseCount = 0;

  sourceValues.slice(1).forEach(function (r, index) {
    const sourceRow = index + 2;
    const rawTimestamp = r[sourceMap.receivedAt];
    const receivedAt = parseDate_(rawTimestamp);
    const rawBrand = clean_(r[sourceMap.brand]);
    const brands = splitBrandNames_(rawBrand);
    const brandList = brands.length ? brands : [rawBrand];
    const rawBizNo = clean_(r[sourceMap.bizNo]);
    const bizNo = normalizeBizNo_(rawBizNo);

    // 타임스탬프가 없는 빈 행은 폼 응답이 아니므로 무시한다.
    if (!receivedAt) return;

    let addedFromResponse = false;
    let responseIntakeNumber = null;
    brandList.forEach(function (brand, brandIndex) {
      const responseKey = makeFormResponseKey_(receivedAt, bizNo || rawBizNo, brand);
      const contentKey = makeFormContentKey_({
        company: sourceCell_(r, sourceMap.company),
        brand: brand,
        bizNo: bizNo || rawBizNo,
        contactName: sourceCell_(r, sourceMap.contactName),
        phone: sourceCell_(r, sourceMap.phone),
        email: sourceCell_(r, sourceMap.email),
        tradeType: sourceCell_(r, sourceMap.tradeType),
        area: sourceCell_(r, sourceMap.area),
        feature: sourceCell_(r, sourceMap.feature),
        url: sourceCell_(r, sourceMap.url),
        underThirty: sourceCell_(r, sourceMap.underThirty),
        salesChannel: sourceCell_(r, sourceMap.salesChannel),
        privacy: sourceCell_(r, sourceMap.privacy)
      });
      if (processedIndex.primary[responseKey] || processedIndex.content[contentKey]) return;

      const match = findDuplicate_(existing, brand, bizNo);
      const status = match.exact ? BO.STATUS.EXISTING : (match.possible ? BO.STATUS.SUSPECT : BO.STATUS.REVIEW);
      const check = match.exact ? '기존 브랜드 확인' : (match.possible ? '유사/사업자번호 일치' : '신규 후보');
      if (responseIntakeNumber == null) responseIntakeNumber = nextIntakeNumber++;
      const baseId = 'FORM-' + Utilities.formatDate(receivedAt, cfg.TIMEZONE || 'Asia/Seoul', 'yyyyMMdd') + '-' + String(responseIntakeNumber).padStart(4, '0');
      const intakeId = brandList.length > 1 ? baseId + '-' + String(brandIndex + 1).padStart(2, '0') : baseId;

      output.push([
        intakeId,
        sourceRow,
        receivedAt,
        clean_(r[sourceMap.company]),
        brand,
        formatBizNo_(bizNo || rawBizNo),
        clean_(r[sourceMap.contactName]),
        formatPhone_(r[sourceMap.phone]),
        clean_(r[sourceMap.email]),
        isCurrentForm ? '' : clean_(r[sourceMap.tradeType]),
        isCurrentForm ? '' : clean_(r[sourceMap.area]),
        clean_(r[sourceMap.feature]),
        clean_(r[sourceMap.url]),
        isCurrentForm ? '' : clean_(r[sourceMap.underThirty]),
        isCurrentForm ? '' : clean_(r[sourceMap.salesChannel]),
        clean_(r[sourceMap.privacy]),
        check,
        match.label || '',
        status,
        match.brandId || '',
        match.pageId || '',
        match.url || '',
        '',
        status === BO.STATUS.EXISTING ? now : '',
        'https://docs.google.com/spreadsheets/d/' + cfg.SOURCE_SPREADSHEET_ID + '/edit#gid=' + source.getSheetId() + '&range=A' + sourceRow + ':' + columnLetter_(lastSourceColumn) + sourceRow,
        clean_(r[sourceMap.launchDate]),
        clean_(r[sourceMap.channel1]),
        clean_(r[sourceMap.channel2]),
        clean_(r[sourceMap.channelAny]),
        clean_(r[sourceMap.currentSales])
      ]);
      processedIndex.primary[responseKey] = true;
      processedIndex.content[contentKey] = true;
      addedFromResponse = true;
    });

    if (addedFromResponse) newResponseCount++;
  });

  if (output.length) {
    // 접수 시트의 실제 열 순서를 기준으로 값을 재배치한다.
    // 사용자가 열을 이동하거나 '등록 상태'를 A열에 두어도 정상 동작한다.
    const intakeHeaders = intake.getRange(1, 1, 1, intake.getLastColumn()).getDisplayValues()[0].map(clean_);
    const intakeHeaderMap = headerMap_(intakeHeaders);
    const missingHeaders = BO.INTAKE_HEADERS.filter(function (name) { return intakeHeaderMap[name] == null; });
    if (missingHeaders.length) throw new Error('접수 시트 필수 열 누락: ' + missingHeaders.join(', '));
    const alignedOutput = alignIntakeRowsToHeaders_(output, intakeHeaders);
    const destRow = intake.getLastRow() + 1;
    intake.getRange(destRow, 1, alignedOutput.length, intakeHeaders.length).setValues(alignedOutput);
    intake.getRange(destRow, intakeHeaderMap['접수 시각'] + 1, alignedOutput.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    intake.getRange(destRow, intakeHeaderMap['처리 시각'] + 1, alignedOutput.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  // 기존 설정값은 운영 현황 참고용으로만 유지하며, 가져오기 판정에는 사용하지 않는다.
  setConfigValue_('LAST_IMPORTED_FORM_ROW', String(lastSourceRow));
  writeLog_(
    'IMPORT',
    'SUCCESS',
    output.length,
    '고유키 검사 · 원본 응답 ' + (sourceValues.length - 1) + '건 · 신규 응답 ' + newResponseCount + '건'
  );
  return output.length;
}

function alignIntakeRowsToHeaders_(rows, actualHeaders) {
  const canonicalMap = headerMap_(BO.INTAKE_HEADERS);
  return rows.map(function (row) {
    return actualHeaders.map(function (header) {
      const index = canonicalMap[header];
      return index == null ? '' : row[index];
    });
  });
}

function buildFormSourceMap_(headers) {
  const map = {
    receivedAt: findFormHeader_(headers, ['타임스탬프']),
    company: findFormHeader_(headers, ['회사명']),
    brand: findFormHeader_(headers, ['브랜드명']),
    launchDate: findFormHeader_(headers, ['브랜드 런칭일자']),
    bizNo: findFormHeader_(headers, ['사업자번호', '사업자 번호']),
    contactName: findFormHeader_(headers, ['담당자명']),
    phone: findFormHeader_(headers, ['담당자 연락처', '연락처']),
    email: findFormHeader_(headers, ['담당자 이메일', '이메일']),
        tradeType: findFormHeader_(headers, ['희망하는 채널 1순위', '희망 거래 방식']),
        area: findFormHeader_(headers, ['희망하는 채널 2순위', '희망 영역']),
    feature: findFormHeader_(headers, ['참여 희망 브랜드 상품 특장점', '상품 특장점']),
    url: findFormHeader_(headers, ['참고 URL', '자사몰 링크']),
        underThirty: findFormHeader_(headers, ['(순위 무관) 희망 채널', '오프라인 판매가로 3만원 미만', '3만원 미만']),
    privacy: findFormHeader_(headers, ['개인정보를 수집·이용', '개인정보 수집']),
    salesChannel: findFormHeader_(headers, ['판매 채널']),
    channel1: findFormHeader_(headers, ['희망하는 채널 1순위']),
    channel2: findFormHeader_(headers, ['희망하는 채널 2순위']),
    channelAny: findFormHeader_(headers, ['(순위 무관) 희망 채널']),
    currentSales: findFormHeader_(headers, ['(현재) 판매 채널'])
  };

  ['receivedAt', 'company', 'brand', 'bizNo'].forEach(function (key) {
    if (map[key] == null) throw new Error('원본 폼 필수 문항을 찾지 못했습니다: ' + key);
  });
  return map;
}
function findFormHeader_(headers, candidates) {
    for (let i = 0; i < candidates.length; i++) {
            const needle = normalizeText_(candidates[i]);
            for (let j = headers.length - 1; j >= 0; j--) {
                if (normalizeText_(headers[j]).indexOf(needle) >= 0) return j;
              }
        }
    return null;
  }


function buildProcessedFormKeyIndex_(intake) {
  const index = { primary: {}, content: {} };
  if (!intake || intake.getLastRow() < 2) return index;
  const values = intake.getDataRange().getValues();
  const h = headerMap_(values[0]);
  const receivedCol = firstHeader_(h, ['접수 시각']);
  const bizCol = firstHeader_(h, ['사업자번호', '사업자 번호']);
  const brandCol = firstHeader_(h, ['브랜드명', '브랜드']);
  if (receivedCol == null || bizCol == null || brandCol == null) {
    throw new Error('접수 시트에서 고유키 생성에 필요한 열을 찾지 못했습니다.');
  }

  values.slice(1).forEach(function (r) {
    const receivedAt = parseDate_(r[receivedCol]);
    const rawBrand = clean_(r[brandCol]);
    const splitBrands = splitBrandNames_(rawBrand);
    const brands = splitBrands.length ? splitBrands : [rawBrand];
    if (!rawBrand) return;

    brands.forEach(function (brand) {
      if (receivedAt) index.primary[makeFormResponseKey_(receivedAt, r[bizCol], brand)] = true;
      index.content[makeFormContentKey_({
        company: intakeCell_(r, h, ['회사명']),
        brand: brand,
        bizNo: r[bizCol],
        contactName: intakeCell_(r, h, ['담당자명']),
        phone: intakeCell_(r, h, ['연락처']),
        email: intakeCell_(r, h, ['이메일']),
        tradeType: intakeCell_(r, h, ['희망 거래 방식']),
        area: intakeCell_(r, h, ['희망 영역']),
        feature: intakeCell_(r, h, ['상품 특장점']),
        url: intakeCell_(r, h, ['참고 URL']),
        underThirty: intakeCell_(r, h, ['3만원 미만 상품']),
        salesChannel: intakeCell_(r, h, ['판매 채널']),
        privacy: intakeCell_(r, h, ['개인정보 동의'])
      })] = true;
    });
  });
  return index;
}

function makeFormResponseKey_(receivedAt, bizNo, brand) {
  const date = parseDate_(receivedAt);
  if (!date) return '';
  return [
    // 폼 원본의 밀리초와 기존 접수 시트의 반올림된 초를 동일하게 취급한다.
    String(Math.round(date.getTime() / 1000)),
    normalizeBizNo_(bizNo),
    normalizeText_(brand)
  ].join('|');
}

function makeFormContentKey_(data) {
  return [
    normalizeBizNo_(data.bizNo),
    normalizeText_(data.brand),
    normalizeText_(data.company),
    normalizeText_(data.contactName),
    String(data.phone == null ? '' : data.phone).replace(/\D/g, ''),
    clean_(data.email).toLowerCase(),
    clean_(data.tradeType).toLowerCase(),
    clean_(data.area).toLowerCase(),
    clean_(data.feature).toLowerCase(),
    clean_(data.url).toLowerCase(),
    clean_(data.underThirty).toLowerCase(),
    clean_(data.salesChannel).toLowerCase(),
    clean_(data.privacy).toLowerCase()
  ].join('|');
}

function sourceCell_(row, index) {
  return index == null ? '' : row[index];
}

function intakeCell_(row, headerMap, names) {
  const index = firstHeader_(headerMap, names);
  return index == null ? '' : row[index];
}

function shortHash_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return bytes.slice(0, 5).map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('').toUpperCase();
}

function columnLetter_(column) {
  let value = Number(column);
  let result = '';
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result || 'A';
}

function findMaxIntakeNumber_(intake) {
  if (!intake || intake.getLastRow() < 2) return 0;
  const values = intake.getDataRange().getDisplayValues();
  const h = headerMap_(values[0]);
  const idCol = firstHeader_(h, ['접수 ID']);
  if (idCol == null) throw new Error('접수 시트에서 접수 ID 열을 찾지 못했습니다.');

  let max = 0;
  values.slice(1).forEach(function (row) {
    const id = clean_(row[idCol]);
    const match = id.match(/^FORM-(?:\d{8}-)?(\d{4})(?:-\d{2})?$/i);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return max;
}

function splitBrandIntakeRows_(rows, existing) {
  const result = [];
  rows.forEach(function (row) {
    const brands = splitBrandNames_(row[4]);
    if (brands.length <= 1) {
      result.push(row);
      return;
    }

    brands.forEach(function (brand, index) {
      const child = row.slice();
      const match = findDuplicate_(existing, brand, normalizeBizNo_(child[5]));
      child[0] = row[0] + '-' + String(index + 1).padStart(2, '0');
      child[4] = brand;
      child[16] = match.exact ? '기존 브랜드 확인' : (match.possible ? '유사/사업자번호 일치' : '신규 후보');
      child[17] = match.label || '';
      child[18] = match.exact ? BO.STATUS.EXISTING : (match.possible ? BO.STATUS.SUSPECT : BO.STATUS.REVIEW);
      child[19] = match.brandId || '';
      child[20] = match.pageId || '';
      child[21] = match.url || '';
      child[22] = '';
      child[23] = match.exact ? new Date() : '';
      result.push(child);
    });
  });
  return result;
}

function splitBrandNames_(value) {
  const text = clean_(value).replace(/，/g, ',');
  if (text.indexOf(',') < 0) return text ? [text] : [];

  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  const open = '([{（［｛';
  const close = ')]}）］｝';

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      quote = ch === '“' ? '”' : (ch === '‘' ? '’' : ch);
      current += ch;
      continue;
    }
    if (open.indexOf(ch) >= 0) {
      depth++;
      current += ch;
      continue;
    }
    if (close.indexOf(ch) >= 0) {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      if (clean_(current)) parts.push(clean_(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (clean_(current)) parts.push(clean_(current));

  return parts.filter(function (name, index) {
    return parts.indexOf(name) === index;
  });
}

function createApprovedBrands_(showUi) {
  const cfg = getConfig_();
  const book = SpreadsheetApp.openById(cfg.TARGET_SPREADSHEET_ID);
  const sheet = book.getSheetByName(cfg.INTAKE_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;
  const h = headerMap_(values[0]);
  const requiredHeaders = ['브랜드명', '등록 상태', '브랜드 ID', 'Notion 페이지 ID'];
  requiredHeaders.forEach(function (name) { if (h[name] == null) throw new Error('접수 시트 열 누락: ' + name); });

  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('스크립트 속성 NOTION_TOKEN이 없습니다.');

  assertNotionCoverage_(cfg.NOTION_DATA_SOURCE_ID, book.getSheetByName(cfg.MIRROR_SHEET_NAME));

  let nextNo = findMaxBrandNumber_(book, sheet, cfg.MIRROR_SHEET_NAME) + 1;
  let created = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean_(row[h['등록 상태']]) !== BO.STATUS.APPROVED) continue;
    if (clean_(row[h['Notion 페이지 ID']])) continue;

    const rowNumber = i + 1;
    try {
      const brand = clean_(row[h['브랜드명']]);
      if (!brand) throw new Error('브랜드명이 비어 있습니다.');
      const bizNo = normalizeBizNo_(row[h['사업자번호']]);

      // 기존 행을 수동으로 수정했거나 예전 형식이 남아 있어도
      // Notion 등록 직전에 시트 표시값과 전송값을 다시 표준화한다.
      if (h['사업자번호'] != null) {
        const formattedBizNo = formatBizNo_(row[h['사업자번호']]);
        if (formattedBizNo !== clean_(row[h['사업자번호']])) {
          row[h['사업자번호']] = formattedBizNo;
          sheet.getRange(rowNumber, h['사업자번호'] + 1).setValue(formattedBizNo);
        }
      }
      if (h['연락처'] != null) {
        const formattedPhone = formatPhone_(row[h['연락처']]);
        if (formattedPhone !== clean_(row[h['연락처']])) {
          row[h['연락처']] = formattedPhone;
          sheet.getRange(rowNumber, h['연락처'] + 1).setValue(formattedPhone);
        }
      }

      const duplicate = queryNotionDuplicate_(cfg.NOTION_DATA_SOURCE_ID, brand, bizNo);
      if (duplicate) {
        updateIntakeResult_(sheet, h, rowNumber, BO.STATUS.EXISTING, duplicate, 'Notion 기존 항목 확인');
        writeLog_('CREATE', 'SKIP_EXISTING', 1, brand + ' / ' + duplicate.id);
        continue;
      }

      const brandId = clean_(row[h['브랜드 ID']]) || ('BO-' + String(nextNo++).padStart(4, '0'));
      const payload = buildNotionCreatePayload_(cfg, h, row, brandId);
      const page = notionRequest_('post', '/pages', payload);
      updateIntakeResult_(sheet, h, rowNumber, BO.STATUS.DONE, {
        id: page.id,
        url: page.url,
        brandId: brandId
      }, '');
      writeLog_('CREATE', 'SUCCESS', 1, brand + ' / ' + brandId);
      created++;
      Utilities.sleep(350);
    } catch (err) {
      updateIntakeError_(sheet, h, rowNumber, err);
      writeError_('CREATE', rowNumber, clean_(row[h['브랜드명']]), err);
    }
  }
  return created;
}

function refreshNotionMirror_(showUi) {
  const cfg = getConfig_();
  const book = SpreadsheetApp.openById(cfg.TARGET_SPREADSHEET_ID);
  const sheet = book.getSheetByName(cfg.MIRROR_SHEET_NAME);
  if (!sheet) throw new Error('브랜드 미러 시트를 찾지 못했습니다.');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const pages = queryAllDataSourcePages_(cfg.NOTION_DATA_SOURCE_ID);
  assertNotionCoverage_(cfg.NOTION_DATA_SOURCE_ID, sheet, pages);
  const rows = pages.map(function (page) {
    return header.map(function (name) {
      const normalized = clean_(name).toLowerCase();
      if (normalized === 'notion 페이지 id' || normalized === 'notion page id' || normalized === '페이지 id') return page.id;
      if (normalized === 'notion url' || normalized === '페이지 url') return page.url || '';
      if (normalized === '최종 동기화' || normalized === '동기화 시각') return new Date();
      return notionPropertyToCell_(page.properties ? page.properties[name] : null);
    });
  });

  // Always keep the read-only mirror in ascending Brand ID order.
  const brandIdIndex = header.findIndex(function (name) {
    return clean_(name).toLowerCase() === '브랜드 id';
  });
  if (brandIdIndex >= 0) {
    rows.sort(function (a, b) {
      const aText = clean_(a[brandIdIndex]);
      const bText = clean_(b[brandIdIndex]);
      const aMatch = aText.match(/\d+/);
      const bMatch = bText.match(/\d+/);
      const aNo = aMatch ? Number(aMatch[0]) : Number.MAX_SAFE_INTEGER;
      const bNo = bMatch ? Number(bMatch[0]) : Number.MAX_SAFE_INTEGER;
      return (aNo - bNo) || aText.localeCompare(bText);
    });
  }

  const oldRows = Math.max(0, sheet.getLastRow() - 1);
  if (oldRows) sheet.getRange(2, 1, oldRows, sheet.getLastColumn()).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  writeLog_('MIRROR', 'SUCCESS', rows.length, 'Notion → 브랜드 전체 목록');
  return rows.length;
}

function assertNotionCoverage_(dataSourceId, mirrorSheet, pages) {
  const accessible = pages || queryAllDataSourcePages_(dataSourceId);
  const existingRows = mirrorSheet ? Math.max(0, mirrorSheet.getLastRow() - 1) : 0;
  // 현재 운영 DB는 80건 이상이므로, 미러가 이미 축소된 상태에서도
  // 안전장치가 무력화되지 않도록 절대 하한 50건을 둔다.
  const minimum = Math.max(50, Math.floor(existingRows * 0.8));
  if (accessible.length < minimum) {
    throw new Error(
      '안전 중단: Notion API가 ' + accessible.length + '건만 반환했습니다. ' +
      '원본 브랜드 DB 전체에 연동 권한을 연결한 뒤 다시 실행하세요. 기존 미러는 유지됩니다.'
    );
  }
  return accessible;
}

function buildNotionCreatePayload_(cfg, h, row, brandId) {
  const get = function (name) { return h[name] == null ? '' : clean_(row[h[name]]); };
  const props = {};
  putTitle_(props, '브랜드명', get('브랜드명'));
  putDate_(props, '브랜드 런칭일자', parseBrandLaunchDate_(get('브랜드 런칭일자')));
  putRichText_(props, '희망 채널 1순위', get('희망 채널 1순위'));
  putRichText_(props, '희망 채널 2순위', get('희망 채널 2순위'));
  putRichText_(props, '순위 무관 희망 채널', get('순위 무관 희망 채널'));
  putRichText_(props, '현재 판매 채널', get('현재 판매 채널'));
  putRichText_(props, '브랜드 ID', brandId);
  putSelect_(props, '진행 단계', '접수·검토');
  putRichText_(props, '협력사/회사명', get('회사명'));
  putRichText_(props, '사업자 번호', formatBizNo_(get('사업자번호')));
  putRichText_(props, '브랜드 담당자', get('담당자명'));
  putRichText_(props, '연락처', formatPhone_(get('연락처')));
  putRichText_(props, '이메일', get('이메일'));
  putDate_(props, '접수일', row[h['접수 시각']]);
  putMultiSelect_(props, '희망 거래 방식', splitOptions_(get('희망 거래 방식')));
  putMultiSelect_(props, '희망 영역', splitOptions_(get('희망 영역')));
  putRichText_(props, '상품 특장점', get('상품 특장점'));
  putRichText_(props, '참고 링크/자료', get('참고 URL'));
  putMultiSelect_(props, '판매 채널', splitOptions_(get('판매 채널')));
  props['폼 제출'] = { checkbox: true };

  const payload = {
    parent: { type: 'data_source_id', data_source_id: cfg.NOTION_DATA_SOURCE_ID },
    properties: props
  };
  if (cfg.NOTION_TEMPLATE_PAGE_ID) {
    payload.template = { type: 'template_id', template_id: cfg.NOTION_TEMPLATE_PAGE_ID };
  }
  return payload;
}

function queryNotionDuplicate_(dataSourceId, brand, bizNo) {
  const candidates = queryAllDataSourcePages_(dataSourceId, {
    property: '브랜드명',
    title: { equals: brand }
  });
  if (candidates.length) return pageSummary_(candidates[0]);
  // 동일 사업자번호로 여러 브랜드를 운영할 수 있으므로 사업자번호만으로 생성을 차단하지 않는다.
  // 사업자번호 일치는 접수 단계의 '중복 의심' 안내에만 사용한다.
  return null;
}

function queryAllDataSourcePages_(dataSourceId, filter) {
  let cursor = null;
  const pages = [];
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;
    const response = notionRequest_('post', '/data_sources/' + encodeURIComponent(dataSourceId) + '/query', body);
    Array.prototype.push.apply(pages, response.results || []);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return pages;
}

function notionRequest_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('스크립트 속성 NOTION_TOKEN이 없습니다.');
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': BO.NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  };
  if (body != null) options.payload = JSON.stringify(body);
  const response = UrlFetchApp.fetch('https://api.notion.com/v1' + path, options);
  const code = response.getResponseCode();
  const text = response.getContentText();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { message: text }; }
  if (code < 200 || code >= 300) {
    throw new Error('Notion API ' + code + ': ' + (json.message || text || '알 수 없는 오류'));
  }
  return json;
}

function buildDuplicateIndex_(book, intake, mirrorName) {
  const out = { brand: {}, biz: {} };
  const mirror = book.getSheetByName(mirrorName);
  if (mirror && mirror.getLastRow() > 1) addSheetToDuplicateIndex_(mirror, out);
  if (intake && intake.getLastRow() > 1) addSheetToDuplicateIndex_(intake, out);
  return out;
}

function addSheetToDuplicateIndex_(sheet, out) {
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return;
  const h = headerMap_(data[0]);
  const brandCol = firstHeader_(h, ['브랜드명', '브랜드']);
  const bizCol = firstHeader_(h, ['사업자번호', '사업자 번호']);
  const brandIdCol = firstHeader_(h, ['브랜드 ID', '브랜드ID']);
  const pageIdCol = firstHeader_(h, ['Notion 페이지 ID', '페이지 ID']);
  const urlCol = firstHeader_(h, ['Notion URL', '페이지 URL']);
  if (brandCol == null) return;
  data.slice(1).forEach(function (r) {
    const brand = clean_(r[brandCol]);
    if (!brand) return;
    const item = {
      label: brand,
      brandId: brandIdCol == null ? '' : clean_(r[brandIdCol]),
      pageId: pageIdCol == null ? '' : clean_(r[pageIdCol]),
      url: urlCol == null ? '' : clean_(r[urlCol])
    };
    out.brand[normalizeText_(brand)] = out.brand[normalizeText_(brand)] || item;
    if (bizCol != null) {
      const biz = normalizeBizNo_(r[bizCol]);
      if (biz) out.biz[biz] = out.biz[biz] || item;
    }
  });
}

function findDuplicate_(index, brand, bizNo) {
  const exact = index.brand[normalizeText_(brand)];
  if (exact) return Object.assign({ exact: true, possible: true }, exact);
  const biz = bizNo && index.biz[bizNo];
  if (biz) return Object.assign({ exact: false, possible: true }, biz);
  return { exact: false, possible: false, label: '', brandId: '', pageId: '', url: '' };
}

function findMaxBrandNumber_(book, intake, mirrorName) {
  let max = 0;
  [book.getSheetByName(mirrorName), intake].forEach(function (sheet) {
    if (!sheet || sheet.getLastRow() < 2) return;
    const data = sheet.getDataRange().getDisplayValues();
    const h = headerMap_(data[0]);
    const col = firstHeader_(h, ['브랜드 ID', '브랜드ID']);
    if (col == null) return;
    data.slice(1).forEach(function (r) {
      const m = clean_(r[col]).match(/^(?:BO-?)?(\d+)$/i);
      if (m) max = Math.max(max, Number(m[1]));
    });
  });
  return max;
}

function updateIntakeResult_(sheet, h, rowNumber, status, info, message) {
  const set = function (name, value) {
    if (h[name] != null) sheet.getRange(rowNumber, h[name] + 1).setValue(value);
  };
  set('등록 상태', status);
  set('브랜드 ID', info.brandId || '');
  set('Notion 페이지 ID', info.id || '');
  set('Notion URL', info.url || '');
  set('오류 메시지', message || '');
  set('처리 시각', new Date());
}

function updateIntakeError_(sheet, h, rowNumber, err) {
  const message = String(err && err.message ? err.message : err).slice(0, 1000);
  if (h['등록 상태'] != null) sheet.getRange(rowNumber, h['등록 상태'] + 1).setValue(BO.STATUS.ERROR);
  if (h['오류 메시지'] != null) sheet.getRange(rowNumber, h['오류 메시지'] + 1).setValue(message);
  if (h['처리 시각'] != null) sheet.getRange(rowNumber, h['처리 시각'] + 1).setValue(new Date());
}

function pageSummary_(page) {
  return {
    id: page.id,
    url: page.url || '',
    brandId: notionPropertyToCell_(page.properties && page.properties['브랜드 ID'])
  };
}

function notionPropertyToCell_(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title': return richTextPlain_(p.title);
    case 'rich_text': return richTextPlain_(p.rich_text);
    case 'select': return p.select ? p.select.name : '';
    case 'multi_select': return (p.multi_select || []).map(function (x) { return x.name; }).join(', ');
    case 'status': return p.status ? p.status.name : '';
    case 'checkbox': return p.checkbox ? '예' : '아니오';
    case 'date': return p.date ? (p.date.end ? p.date.start + ' ~ ' + p.date.end : p.date.start) : '';
    case 'number': return p.number == null ? '' : p.number;
    case 'url': return p.url || '';
    case 'email': return p.email || '';
    case 'phone_number': return p.phone_number || '';
    case 'people': return (p.people || []).map(function (x) { return x.name || x.id; }).join(', ');
    case 'relation': return (p.relation || []).map(function (x) { return x.id; }).join(', ');
    case 'formula': return formulaToCell_(p.formula);
    case 'created_time': return p.created_time || '';
    case 'last_edited_time': return p.last_edited_time || '';
    default: return '';
  }
}

function formulaToCell_(f) {
  if (!f) return '';
  return f[f.type] == null ? '' : f[f.type];
}

function richTextPlain_(arr) {
  return (arr || []).map(function (x) { return x.plain_text || ''; }).join('');
}

function putTitle_(props, name, value) {
  props[name] = { title: value ? [{ type: 'text', text: { content: String(value).slice(0, 2000) } }] : [] };
}

function putRichText_(props, name, value) {
  props[name] = { rich_text: value ? [{ type: 'text', text: { content: String(value).slice(0, 2000) } }] : [] };
}

function putSelect_(props, name, value) {
  if (value) props[name] = { select: { name: value } };
}

function putMultiSelect_(props, name, values) {
  if (values.length) props[name] = { multi_select: values.slice(0, 100).map(function (v) { return { name: v.slice(0, 100) }; }) };
}

function putDate_(props, name, value) {
  const d = value instanceof Date ? value : parseDate_(value);
  if (d && !isNaN(d.getTime())) props[name] = { date: { start: d.toISOString() } };
}

function splitOptions_(value) {
  return String(value || '')
    .split(/[,;\n]|\s*\/\s*/)
    .map(function (x) { return clean_(x).replace(/\s*\([^)]*\)\s*/g, ''); })
    .filter(function (x, i, a) { return x && a.indexOf(x) === i; });
}

function getConfig_() {
  const sheet = SpreadsheetApp.openById(BO.TARGET_SPREADSHEET_ID).getSheetByName(BO.CONFIG_SHEET);
  if (!sheet) throw new Error(BO.CONFIG_SHEET + ' 시트를 찾지 못했습니다.');
  const rows = sheet.getDataRange().getDisplayValues();
  const cfg = {};
  rows.slice(1).forEach(function (r) {
    const key = clean_(r[0]);
    if (key) cfg[key] = clean_(r[1]);
  });
  return cfg;
}

function setConfigValue_(key, value) {
  const sheet = SpreadsheetApp.openById(BO.TARGET_SPREADSHEET_ID).getSheetByName(BO.CONFIG_SHEET);
  const rows = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).getDisplayValues();
  for (let i = 1; i < rows.length; i++) {
    if (clean_(rows[i][0]) === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value, '자동 생성']);
}

function writeLog_(action, result, count, detail) {
  appendSystemRow_(BO.LOG_SHEET, [new Date(), action, result, count, detail || '']);
}

function writeError_(action, rowNumber, brand, err) {
  appendSystemRow_(BO.ERROR_SHEET, [new Date(), action, rowNumber, brand || '', String(err && err.message ? err.message : err)]);
}

function appendSystemRow_(sheetName, values) {
  try {
    const sheet = SpreadsheetApp.openById(BO.TARGET_SPREADSHEET_ID).getSheetByName(sheetName);
    if (!sheet) return;
    // 로그 시트의 템플릿/검증 구조가 잘못되어 있어도 핵심 동기화는 중단하지 않는다.
    const row = Math.max(2, sheet.getLastRow() + 1);
    const cleanup = sheet.getRange(row, 1, 1, Math.max(sheet.getMaxColumns(), values.length));
    cleanup.breakApart();
    cleanup.clearDataValidations();
    sheet.getRange(row, 1, 1, values.length).setValues([values]);
  } catch (logError) {
    console.warn('시스템 로그 기록 생략: ' + logError.message);
  }
}

function withBrandSyncLock_(label, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error(label + ': 다른 동기화가 실행 중입니다. 잠시 후 다시 시도하세요.');
  try { return fn(); }
  catch (err) {
    writeError_(label, '', '', err);
    throw err;
  } finally { lock.releaseLock(); }
}

function headerMap_(headers) {
  const map = {};
  headers.forEach(function (v, i) { if (clean_(v)) map[clean_(v)] = i; });
  return map;
}

function firstHeader_(map, names) {
  for (let i = 0; i < names.length; i++) if (map[names[i]] != null) return map[names[i]];
  return null;
}

function normalizeText_(value) {
  return clean_(value).toLowerCase().replace(/[\s._\-·()\[\]{}]/g, '');
}

function normalizeBizNo_(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function formatBizNo_(value) {
  const original = clean_(value);
  const digits = original.replace(/\D/g, '');
  if (digits.length !== 10) return original;
  return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
}

function formatPhone_(value) {
  const original = clean_(value);
  if (!original) return '';
  // 국가번호, 내선번호, 문자 표기가 섞인 값은 임의 변경하지 않는다.
  if (/\+|[A-Za-z가-힣]/.test(original)) return original;
  const digits = original.replace(/\D/g, '');
  if (digits.length === 8) return digits.slice(0, 4) + '-' + digits.slice(4);
  if (digits.indexOf('02') === 0) {
    if (digits.length === 9) return '02-' + digits.slice(2, 5) + '-' + digits.slice(5);
    if (digits.length === 10) return '02-' + digits.slice(2, 6) + '-' + digits.slice(6);
    return original;
  }
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  if (digits.length === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  return original;
}

function clean_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function parseBrandLaunchDate_(value) {
  if (value instanceof Date) return value;
  const text = clean_(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])\s*(\d{1,2})\s*일?$/);
  if (!match) return parseDate_(text);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return match[1] + '-' + String(Number(match[2])).padStart(2, '0') + '-' + String(Number(match[3])).padStart(2, '0');
}

function parseDate_(value) {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function toast_(message) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(message, '뷰티오라 자동화', 5); } catch (e) {}
}
