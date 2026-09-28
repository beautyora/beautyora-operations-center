/**
 * 기존 Google Sheets 운영 데이터 → Notion·Drive 1회 이관.
 * - 파트너 링크(사용 중) → Notion '상품등록 링크' (같은 토큰 유지: 이미 보낸 링크가 계속 동작)
 * - 파일 목록 → 각 Drive 파일의 appProperties
 * - 처리 중인 상품 접수(신규 제출·검수 중·보완 필요) → Notion 상품 페이지의 검수 상태·변경 요청
 * 여러 번 실행해도 안전하다(이미 옮긴 항목은 건너뜀). 4분 넘게 걸리면 멈추고 다음 실행에서 이어 간다.
 */
const BO_LEGACY_STATUS = Object.freeze({ '신규 제출': 'pending', '검수 중': 'pending', '보완 필요': 'revision', '승인 완료': 'approved', '반려': 'rejected' });
const BO_LEGACY_FILE_STATUS = Object.freeze({ '검수 대기': 'pending', '수령 완료': 'received', '보완 필요': 'revision', '반려': 'rejected', '승인 완료': 'approved' });

function legacyBook_(spreadsheetId) {
  const id = String(spreadsheetId || prop_(BO.PROPS.LEGACY_SPREADSHEET_ID) || '').trim();
  if (!id) throw userError_('이관할 기존 스프레드시트 ID가 없습니다. 스크립트 속성 BO_SPREADSHEET_ID를 확인해 주세요.');
  return SpreadsheetApp.openById(id);
}

function legacyRows_(book, name) {
  const sheet = book.getSheetByName(name);
  if (!sheet) return [];
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const headers = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1).filter(function (row) { return row.some(Boolean); }).map(function (row, index) {
    const out = { _row: index + 2 };
    headers.forEach(function (h, i) { out[h] = row[i]; });
    return out;
  });
}

function legacyLatestSubmissions_(rows) {
  const latest = {};
  rows.forEach(function (row) {
    const key = row['브랜드코드'] + '|' + (row['상품ID'] || row['제출ID']);
    const old = latest[key];
    const version = Number(row['제출버전']) || 0, oldVersion = old ? Number(old['제출버전']) || 0 : -1;
    if (!old || version > oldVersion || (version === oldVersion && String(row['제출일']) >= String(old['제출일']))) latest[key] = row;
  });
  return Object.keys(latest).map(function (k) { return latest[k]; }).filter(function (row) {
    return ['pending', 'revision'].indexOf(BO_LEGACY_STATUS[row['상태']]) >= 0;
  });
}

function legacyLinks_(rows) {
  return rows.filter(function (row) {
    const expiry = String(row['만료일'] || '').slice(0, 10);
    return row['상태'] === BO.LINK.ACTIVE && /^[a-f0-9]{32,64}$/i.test(row['토큰'] || '') && (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry >= today_());
  });
}

function migrationPreview_(spreadsheetId) {
  const book = legacyBook_(spreadsheetId);
  return {
    spreadsheet: book.getName(),
    links: legacyLinks_(legacyRows_(book, '파트너 링크')).length,
    files: legacyRows_(book, '파일 목록').filter(function (r) { return r['Drive파일ID']; }).length,
    submissions: legacyLatestSubmissions_(legacyRows_(book, '상품 접수')).length,
    state: JSON.parse(prop_(BO.PROPS.MIGRATION_STATE) || '{}')
  };
}

function migrationRun_(spreadsheetId) {
  const book = legacyBook_(spreadsheetId);
  const started = Date.now();
  const budget = function () { return Date.now() - started < 240000; };
  const state = JSON.parse(prop_(BO.PROPS.MIGRATION_STATE) || '{}');
  const saveState = function () { props_().setProperty(BO.PROPS.MIGRATION_STATE, JSON.stringify(state)); };
  const log = { links: 0, files: 0, submissions: 0, skipped: 0, errors: [] };

  // 1) 링크
  const linkSchema = notionSchema_('link');
  legacyLinks_(legacyRows_(book, '파트너 링크')).slice(state.links || 0).forEach(function (row) {
    if (!budget()) return;
    try {
      const brand = brandByCode_(row['브랜드코드']);
      if (!brand) { log.skipped++; }
      else if (notionQueryAll_(linkSchema.sourceId, { filter: fText_(linkSchema, 'token', row['토큰']) }, 1).length) { log.skipped++; }
      else {
        const expiry = /^\d{4}-\d{2}-\d{2}/.test(row['만료일'] || '') ? String(row['만료일']).slice(0, 10) : addDays_(today_(), 30);
        notionCreate_(linkSchema.sourceId, notionProps_(linkSchema, {
          name: brand.name + ' 상품등록 링크 (이관)', brand: [brand.pageId], token: row['토큰'], status: BO.LINK.ACTIVE,
          expiry: expiry, issuer: row['발급자'] || '', memo: '시트에서 이관 (' + (row['발급일'] || '') + ')'
        }, { allowNewOption: true }));
        log.links++;
      }
      state.links = (state.links || 0) + 1;
    } catch (error) { log.errors.push('링크 ' + row._row + '행: ' + errorMessage_(error)); state.links = (state.links || 0) + 1; }
  });
  saveState();
  bumpCache_('link');

  // 2) 파일 → Drive appProperties
  legacyRows_(book, '파일 목록').filter(function (r) { return r['Drive파일ID']; }).slice(state.files || 0).forEach(function (row) {
    if (!budget()) return;
    try {
      const file = driveFile_(row['Drive파일ID']);
      if (file.appProperties && file.appProperties.boBrand) { log.skipped++; }
      else {
        const isAsset = !!row['상품ID'];
        const category = String(row['분류'] || '').trim();
        const appProperties = {
          boKind: isAsset ? 'asset' : 'doc', boBrand: row['브랜드코드'],
          boCat: (isAsset ? BO_ASSET_CODES : BO_DOC_CODES)[category] || (isAsset ? 'etc' : 'other'),
          boStatus: BO_LEGACY_FILE_STATUS[row['상태']] || (isAsset ? 'received' : 'pending'),
          boUpload: String(row['파일ID'] || '').replace(/^FILE-/, '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || uuid_('M')
        };
        if (isAsset) appProperties.boProduct = row['상품ID'];
        const resource = { appProperties: appProperties };
        if (row['검수메모']) resource.description = row['검수메모'];
        Drive.Files.update(resource, file.id, null, { supportsAllDrives: true });
        log.files++;
      }
    } catch (error) { log.errors.push('파일 ' + row._row + '행: ' + errorMessage_(error)); }
    state.files = (state.files || 0) + 1;
  });
  saveState();
  bumpCache_('asset');

  // 3) 처리 중인 상품 접수 → Notion 상품
  const schema = notionSchema_('product');
  const fields = productFieldConfig_().fields;
  legacyLatestSubmissions_(legacyRows_(book, '상품 접수')).slice(state.submissions || 0).forEach(function (row) {
    if (!budget()) return;
    try {
      migrateSubmission_(schema, fields, row);
      log.submissions++;
    } catch (error) { log.errors.push('상품 접수 ' + row._row + '행: ' + errorMessage_(error)); }
    state.submissions = (state.submissions || 0) + 1;
  });
  state.finished = budget();
  state.lastRun = now_();
  saveState();
  bumpCache_('product');
  return Object.assign(log, { finished: state.finished, state: state });
}

function migrateSubmission_(schema, fields, row) {
  const brand = brandByCode_(row['브랜드코드']);
  if (!brand) throw new Error('브랜드 없음: ' + row['브랜드코드']);
  let data = {};
  try { data = JSON.parse(row['상품데이터JSON'] || '{}'); } catch (ignored) {}
  const productId = String(row['상품ID'] || data.product_id || '').trim();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(productId)) throw new Error('상품 ID 형식 확인 필요: ' + productId);
  const status = BO_LEGACY_STATUS[row['상태']];
  const submitter = [row['제출자명'], row['제출자연락처']].filter(Boolean).join(' / ');
  const submittedAt = /^\d{4}-\d{2}-\d{2}/.test(row['제출일']) ? String(row['제출일']).slice(0, 10) : today_();
  const page = productPageById_(productId);
  const values = {};
  fields.forEach(function (f) { if (!f.asset && hasOwn_(data, f.id)) values[f.id] = data[f.id]; });
  const lenientProps = function () {
    const out = {};
    fields.forEach(function (f) {
      if (f.asset || !hasOwn_(values, f.id)) return;
      try { out[f.propertyId] = notionWrite_(schema.byId[f.propertyId], values[f.id], { allowNewOption: false }); } catch (ignored) {}
    });
    return out;
  };
  const meta = notionProps_(schema, { submittedAt: submittedAt, submitter: submitter });
  if (schema.ids.reviewNote) meta[schema.ids.reviewNote] = notionRichText_(status === 'revision' ? row['검수메모'] || '' : '');
  if (data._change_request) {
    if (!page) throw new Error('변경 요청 대상 상품을 Notion에서 찾지 못했습니다: ' + productId);
    if (pendingChange_(page.id)) return;
    notionAppend_(page.id, [changeBlock_({ v: 1, requestId: String(row['제출ID'] || uuid_('M')).replace(/[^A-Za-z0-9-]/g, ''), submittedAt: submittedAt + 'T00:00:00+09:00', submitter: submitter, brandCode: brand.code, values: values, assets: [] }, ['시트에서 이관된 변경 요청'])]);
    notionPatch_(page.id, Object.assign(meta, notionProps_(schema, { change: status === 'revision' ? BO.CHANGE.REVISION : BO.CHANGE.PENDING }, { allowNewOption: true })));
    return;
  }
  const review = status === 'revision' ? BO.REVIEW.REVISION : BO.REVIEW.PENDING;
  const properties = Object.assign(lenientProps(), meta, notionProps_(schema, { productId: productId, brand: [brand.pageId], review: review }, { allowNewOption: true }));
  if (!properties[schema.ids.name]) properties[schema.ids.name] = notionWrite_(schema.defs.name, data.product_name || '상품명 확인 필요');
  if (page) notionPatch_(page.id, properties);
  else notionCreate_(schema.sourceId, properties);
}

/** 편집기에서 실행: 기존 시트 데이터를 옮긴다. 끝날 때까지 여러 번 실행해도 된다. */
function migrateLegacySheets() {
  assertOwnerOrAdmin_();
  const result = migrationRun_();
  console.log(JSON.stringify(result, null, 2));
  return result;
}
