/**
 * 메인 상품목록(Google 시트): 상품의 원본.
 * 처음 한 번, 통합 상품리스트(벤더별 운영본)의 정리 탭에서 만든다. 이후에는 이 시트가 원본이고 통합리스트는 외부 제공용 작업 공간이다.
 * - '상품' 탭: 브랜드 열 하나로 정리하고, 벤더를 통해 들어온 상품만 '벤더' 열에 벤더사 이름을 적는다(직거래는 비움).
 * - 위탁가 비고: 통합리스트 '위탁 가격상태'에 '임의 5% 가산'이 있는 상품만 표시한다(그 밖의 가격 계산 열은 가져오지 않음).
 * - 제품 링크: 통합리스트에는 없어서 Notion 상품 DB의 '참고 링크', 기존 브랜드 폴더의 입점 상품 리스트 '참고링크'에서 찾아 채운다.
 */

const BO_MAIN = Object.freeze({
  TITLE: '뷰티오라 메인 상품목록',
  PRODUCT_TAB: '상품',
  CONSIGN_NOTE: '임의 5% 가산',
  ID_PREFIX: 'BP-',
  /** 통합리스트 '운영 출처시트'에 이 글자가 있으면 자사(직거래) 상품이라 벤더를 비운다. */
  DIRECT_SOURCE_KEYWORD: '픽오라',
  /** [메인 열 이름, 통합리스트 머리글 후보...] */
  COLUMNS: [
    ['상품 ID'],
    ['브랜드', '브랜드'],
    ['벤더'],
    ['이미지', '이미지'],
    ['상품명', '상품명'],
    ['구성', '구성'],
    ['카테고리', '카테고리'],
    ['바코드', '바코드'],
    ['거래유형', '거래유형'],
    ['매입 공급가', '공유 매입용 공급가'],
    ['위탁 공급가', '공유 위탁용 공급가'],
    ['위탁가 비고'],
    ['권장판매가', '권장판매가'],
    ['매입 MOQ', '매입MOQ'],
    ['핵심포인트', '핵심포인트'],
    ['제품설명', '제품설명'],
    ['제품 링크'],
    ['링크 출처']
  ],
  PRICE_COLUMNS: ['매입 공급가', '위탁 공급가', '권장판매가'],
  /** 숫자·시간으로 바뀌면 안 되는 열(예: 원본행 ID '400000013:119'가 시간으로 읽힘). 쓰기 전에 텍스트 서식으로 둔다. */
  TEXT_COLUMNS: ['상품 ID', '바코드'],
  /** 기존 Notion 상품 DB(읽기만). v2에서 쓰던 스크립트 속성을 그대로 읽는다. */
  LEGACY_PRODUCT_PROP: 'BO_NOTION_PRODUCT_DATA_SOURCE_ID',
  SHEET_PROP: 'BO_MAIN_PRODUCT_SHEET_ID',
  IMAGE_FOLDER: '메인 상품목록 이미지',
  /** 한 번 실행에서 섬네일 넣기에 쓰는 시간(밀리초). Apps Script 6분 제한 안에서 끊고, 다시 누르면 이어서 한다. */
  IMAGE_BUDGET_MS: 270000
});

function spreadsheetIdFromUrl_(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/spreadsheets\/d\/([\w-]{20,})/);
  if (match) return match[1];
  if (/^[\w-]{20,}$/.test(text)) return text;
  throw userError_('통합 상품리스트 주소를 확인해 주세요. (Google 시트 주소)');
}

function headerKey_(value) {
  return String(value == null ? '' : value).split('\n')[0].replace(/\s+/g, '').trim();
}

/** 머리글 행 → { 머리글 키: 열 번호(0부터) }. 줄바꿈 뒤 설명('단위 : EA')은 무시한다. */
function headerIndex_(header) {
  const index = {};
  header.forEach(function (name, i) { const key = headerKey_(name); if (key && !hasOwn_(index, key)) index[key] = i; });
  return index;
}

function mainProductSheetUrl_() {
  const id = prop_(BO_MAIN.SHEET_PROP);
  return id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : '';
}

/* ---------- 제품 링크 찾기 ---------- */

function productKey_(brand, name) {
  return normalizeName_(brand) + '|' + normalizeName_(name);
}

/** 상품 개별 링크가 아니라 스토어·홈페이지 첫 화면 주소인지. */
function isStoreMainUrl_(url) {
  const match = String(url || '').match(/^https?:\/\/[^\/?#]+(\/[^?#]*)?(\?[^#]*)?/i);
  if (!match) return false;
  const path = (match[1] || '/').replace(/\/+$/, '');
  return !path && !match[2];
}

/** 기존 Notion 상품 DB의 { 브랜드, 상품명, 옵션명, 바코드, 참고 링크 }. DB가 연결돼 있지 않으면 빈 목록. */
function notionProductLinks_() {
  const sourceId = prop_(BO_MAIN.LEGACY_PRODUCT_PROP);
  if (!sourceId) return [];
  const brands = brandMapByPageId_();
  const read = function (page, name) { return notionValue_((page.properties || {})[name]); };
  return notionQueryAll_(sourceId, {}).map(function (page) {
    const brand = (read(page, '브랜드') || []).map(function (id) { return brands[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
    return {
      source: 'Notion', brand: brand.name || '', name: clean_(read(page, '상품명')), option: clean_(read(page, '옵션명')),
      barcode: clean_(read(page, '바코드(텍스트)')), url: clean_(read(page, '참고 링크'))
    };
  }).filter(function (item) { return /^https?:\/\//i.test(item.url); });
}

/**
 * 기존 브랜드 자료 폴더(하위 폴더 한 단계까지)의 '입점 상품 리스트' 엑셀에서 { 브랜드명, 옵션명, 참고링크 }를 읽는다.
 * 엑셀은 임시 Google 시트로 바꿔 읽고 바로 휴지통으로 보낸다(원본은 그대로).
 */
function legacyWorkbookLinks_(folderUrl, report) {
  const rootId = driveIdFromUrl_(folderUrl);
  if (!rootId) return [];
  const list = function (q) { return (Drive.Files.list({ q: q, pageSize: 200, fields: 'files(id,name,mimeType)', supportsAllDrives: true, includeItemsFromAllDrives: true }).files || []); };
  const folders = [rootId].concat(list("'" + rootId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false").map(function (f) { return f.id; }));
  const out = [];
  folders.forEach(function (folderId) {
    list("'" + folderId + "' in parents and trashed = false").filter(function (f) {
      return f.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && /입점\s*상품\s*리스트/.test(f.name);
    }).forEach(function (file) {
      let copyId = '';
      try {
        copyId = Drive.Files.copy({ name: '[임시] ' + file.name, mimeType: 'application/vnd.google-apps.spreadsheet' }, file.id, { supportsAllDrives: true }).id;
        const rows = SpreadsheetApp.openById(copyId).getSheets()[0].getDataRange().getDisplayValues();
        const headerAt = rows.findIndex(function (row) { return row.some(function (v) { return /참고\s*링크/.test(v); }); });
        if (headerAt < 0) return;
        const header = rows[headerAt].map(headerKey_);
        const col = function (pattern) { return header.findIndex(function (v) { return pattern.test(v); }); };
        const cBrand = col(/^브랜드명?$/), cName = col(/옵션명|상품명/), cUrl = col(/참고링크/), cBarcode = col(/바코드/);
        rows.slice(headerAt + 1).forEach(function (row) {
          const url = clean_(row[cUrl]);
          if (!/^https?:\/\//i.test(url) || cName < 0) return;
          out.push({ source: '기존 엑셀', brand: cBrand >= 0 ? clean_(row[cBrand]) : '', name: clean_(row[cName]), option: '', barcode: cBarcode >= 0 ? clean_(row[cBarcode]) : '', url: url });
        });
      } catch (error) {
        report.push('읽지 못한 엑셀: ' + file.name + ' (' + errorMessage_(error) + ')');
      } finally {
        if (copyId) { try { DriveApp.getFileById(copyId).setTrashed(true); } catch (ignored) {} }
      }
    });
  });
  return out;
}

/**
 * 상품 하나에 맞는 링크를 고른다. 바코드가 같으면 바로, 아니면 같은 브랜드에서 상품명이 같거나 한쪽이 다른 쪽을 포함할 때.
 * 후보가 여러 개로 갈리면(서로 다른 주소) 고르지 않는다.
 */
function matchLink_(product, candidates) {
  const barcode = clean_(product.barcode);
  if (barcode) {
    const byBarcode = candidates.filter(function (c) { return c.barcode && c.barcode === barcode; });
    if (byBarcode.length) return byBarcode[0];
  }
  const brand = normalizeName_(product.brand);
  const name = normalizeName_(product.name);
  if (!brand || name.length < 4) return null;
  const sameBrand = function (b) { const x = normalizeName_(b); return x && (x === brand || x.indexOf(brand) >= 0 || brand.indexOf(x) >= 0); };
  const hits = candidates.filter(function (c) {
    if (!sameBrand(c.brand)) return false;
    return [c.name + ' ' + c.option, c.name, c.option].map(normalizeName_).some(function (key) {
      return key.length >= 4 && (key === name || (key.length >= 6 && (name.indexOf(key) >= 0 || key.indexOf(name) >= 0)));
    });
  });
  const urls = hits.map(function (c) { return c.url; }).filter(function (u, i, a) { return a.indexOf(u) === i; });
  return urls.length === 1 ? hits[0] : null;
}

/* ---------- 만들기 ---------- */

/**
 * 통합 상품리스트 → 새 메인 상품목록. 원본은 바꾸지 않는다. 다시 실행하면 새 파일을 만든다(이전 파일은 그대로).
 * payload: { sourceUrl, sheetName = '뷰티오라', legacyFolderUrl? }
 */
function buildMainProductList_(payload) {
  payload = payload || {};
  const report = [];
  const source = SpreadsheetApp.openById(spreadsheetIdFromUrl_(payload.sourceUrl));
  const sheetName = clean_(payload.sheetName) || '뷰티오라';
  const sheet = source.getSheetByName(sheetName);
  if (!sheet) throw userError_('통합 상품리스트에 "' + sheetName + '" 탭이 없습니다.');
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2) throw userError_('"' + sheetName + '" 탭에 상품이 없습니다.');
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0];
  const index = headerIndex_(header);
  const need = ['운영 출처시트', '실제 공급사'].concat(BO_MAIN.COLUMNS.filter(function (c) { return c[1]; }).map(function (c) { return c[1]; }));
  const missing = need.filter(function (name) { return !hasOwn_(index, headerKey_(name)); });
  if (missing.length) throw userError_('통합 상품리스트 머리글을 찾지 못했습니다: ' + missing.join(', '));

  const at = function (row, name) { const key = headerKey_(name); return hasOwn_(index, key) ? row[index[key]] : ''; };

  // 제품 링크 후보
  let candidates = [];
  try { candidates = candidates.concat(notionProductLinks_()); } catch (error) { report.push('Notion 상품 DB를 읽지 못했습니다: ' + errorMessage_(error)); }
  if (payload.legacyFolderUrl) candidates = candidates.concat(legacyWorkbookLinks_(payload.legacyFolderUrl, report));

  const stats = { products: 0, vendor: 0, linkNotion: 0, linkWorkbook: 0, storeMain: 0, noLink: 0 };
  const mainRows = [];
  values.slice(1).forEach(function (row) {
    const brand = clean_(at(row, '브랜드')), name = clean_(at(row, '상품명'));
    if (!brand && !name) return;
    stats.products++;
    const id = BO_MAIN.ID_PREFIX + ('00000' + stats.products).slice(-5);
    const vendor = String(at(row, '운영 출처시트')).indexOf(BO_MAIN.DIRECT_SOURCE_KEYWORD) >= 0 ? '' : clean_(at(row, '실제 공급사'));
    if (vendor) stats.vendor++;
    const link = matchLink_({ brand: brand, name: name, barcode: at(row, '바코드') }, candidates);
    let linkNote = '';
    if (!link) stats.noLink++;
    else {
      if (link.source === 'Notion') stats.linkNotion++; else stats.linkWorkbook++;
      linkNote = link.source + (isStoreMainUrl_(link.url) ? ' · 상품 개별 링크 아님' : '');
      if (isStoreMainUrl_(link.url)) stats.storeMain++;
    }
    mainRows.push(BO_MAIN.COLUMNS.map(function (c) {
      switch (c[0]) {
        case '상품 ID': return id;
        case '벤더': return vendor;
        case '이미지': return '';
        case '제품 링크': return link ? link.url : '';
        case '링크 출처': return linkNote;
        case '위탁가 비고': return String(at(row, '위탁 가격상태') || '').indexOf(BO_MAIN.CONSIGN_NOTE) >= 0 ? BO_MAIN.CONSIGN_NOTE : '';
        default: {
          const v = at(row, c[1]);
          return v && typeof v === 'object' && !(v instanceof Date) ? '' : v;
        }
      }
    }));
  });
  if (!stats.products) throw userError_('옮길 상품이 없습니다.');

  const book = SpreadsheetApp.create(BO_MAIN.TITLE);
  try { DriveApp.getFileById(book.getId()).moveTo(driveRoot_()); } catch (error) { report.push('브랜드 자료 루트 폴더로 옮기지 못했습니다: ' + errorMessage_(error)); }
  const main = book.getSheets()[0];
  main.setName(BO_MAIN.PRODUCT_TAB);
  const width = BO_MAIN.COLUMNS.length;
  main.getRange(1, 1, 1, width).setValues([BO_MAIN.COLUMNS.map(function (c) { return c[0]; })]).setFontWeight('bold').setBackground('#f1eb9c');
  BO_MAIN.TEXT_COLUMNS.forEach(function (name) {
    const col = BO_MAIN.COLUMNS.findIndex(function (c) { return c[0] === name; }) + 1;
    main.getRange(2, col, mainRows.length, 1).setNumberFormat('@');
  });
  main.getRange(2, 1, mainRows.length, width).setValues(mainRows.map(function (r) {
    return r.map(function (v, c) { return BO_MAIN.TEXT_COLUMNS.indexOf(BO_MAIN.COLUMNS[c][0]) >= 0 && v !== '' && v != null ? String(v) : v; });
  }));
  BO_MAIN.PRICE_COLUMNS.forEach(function (name) {
    const col = BO_MAIN.COLUMNS.findIndex(function (c) { return c[0] === name; }) + 1;
    main.getRange(2, col, mainRows.length, 1).setNumberFormat('#,##0"원"');
  });
  const imageCol = BO_MAIN.COLUMNS.findIndex(function (c) { return c[0] === '이미지'; }) + 1;
  main.setFrozenRows(1);
  main.setFrozenColumns(2);
  main.setRowHeights(2, mainRows.length, 64);
  main.setColumnWidth(imageCol, 72);


  // 통합리스트의 셀 이미지는 Apps Script로 읽거나 옮길 수 없다(파일 복사 시 #REF!). 섬네일은 '섬네일 넣기'가 IMAGE 함수로 채운다.
  report.push('섬네일: 설정 → 메인 상품목록 → 섬네일 넣기로 채워 주세요.');
  props_().setProperty(BO_MAIN.SHEET_PROP, book.getId());
  logInfo_('mainProducts.build', { by: activeEmail_(), products: stats.products, sheet: book.getId() });
  return { url: book.getUrl(), stats: stats, candidates: candidates.length, report: report };
}

/* ---------- 섬네일 (IMAGE 함수) ---------- */

function imageFormula_(fileId) {
  return '=IMAGE("https://lh3.googleusercontent.com/d/' + fileId + '",1)';
}

function driveIdFromImageFormula_(formula) {
  const match = String(formula || '').match(/googleusercontent\.com\/d\/([\w-]{20,})|drive\.google\.com\/(?:uc\?[^"]*id=|file\/d\/|thumbnail\?[^"]*id=)([\w-]{20,})/);
  return match ? (match[1] || match[2]) : '';
}

/**
 * 이미지 목록 시트(예: '뷰티오라 상품 목록 · 공유용')의 모든 탭에서 { 바코드, 브랜드, 상품명, 이미지 파일 ID }를 읽는다.
 * 탭마다 위쪽 몇 줄 안에서 '상품명/제품명'과 '이미지/제품사진' 머리글을 찾는다.
 */
function imageCatalog_(sheetUrl) {
  const book = SpreadsheetApp.openById(spreadsheetIdFromUrl_(sheetUrl));
  const out = [];
  book.getSheets().forEach(function (sheet) {
    const rows = sheet.getLastRow(), cols = sheet.getLastColumn();
    if (rows < 2 || cols < 2) return;
    const values = sheet.getRange(1, 1, rows, cols).getDisplayValues();
    const formulas = sheet.getRange(1, 1, rows, cols).getFormulas();
    const headerAt = values.slice(0, 8).findIndex(function (row) { return row.some(function (v) { return /^(상품명|제품명)$/.test(headerKey_(v)); }); });
    if (headerAt < 0) return;
    const header = values[headerAt].map(headerKey_);
    const col = function (re) { return header.findIndex(function (v) { return re.test(v); }); };
    const cName = col(/^(상품명|제품명)$/), cImage = col(/^(이미지|제품사진)$/), cBrand = col(/^브랜드$/), cBarcode = col(/^바코드/);
    if (cImage < 0) return;
    for (let r = headerAt + 1; r < rows; r++) {
      const fileId = driveIdFromImageFormula_(formulas[r][cImage]);
      const name = clean_(values[r][cName]);
      if (!fileId || !name) continue;
      out.push({ name: name, brand: cBrand >= 0 ? clean_(values[r][cBrand]) : '', barcode: cBarcode >= 0 ? clean_(values[r][cBarcode]) : '', fileId: fileId });
    }
  });
  return out;
}

/** 바코드가 같으면 바로, 아니면 상품명이 같은 것(브랜드가 적혀 있으면 브랜드도 같아야). 후보가 갈리면 고르지 않는다. */
function matchImage_(product, catalog) {
  const barcode = clean_(product.barcode);
  if (barcode) {
    const ids = catalog.filter(function (c) { return c.barcode === barcode; }).map(function (c) { return c.fileId; });
    if (ids.length && ids.every(function (id) { return id === ids[0]; })) return ids[0];
  }
  const key = function (v) { return normalizeName_(v).replace(/×/g, 'x'); };
  const name = key(product.name), brand = normalizeName_(product.brand);
  const hits = catalog.filter(function (c) {
    if (key(c.name) !== name) return false;
    const b = normalizeName_(c.brand);
    return !b || !brand || b === brand || b.indexOf(brand) >= 0 || brand.indexOf(b) >= 0;
  }).map(function (c) { return c.fileId; }).filter(function (id, i, a) { return a.indexOf(id) === i; });
  return hits.length === 1 ? hits[0] : '';
}

/**
 * 메인 상품목록의 비어 있는 이미지 칸에 섬네일을 넣는다.
 * 원본 이미지 파일을 '메인 상품목록 이미지' 폴더로 복사하고(링크가 있는 사람 보기), =IMAGE("https://lh3.googleusercontent.com/d/<복사본 ID>",1)을 쓴다.
 * 시간이 모자라면 멈추고 남은 개수를 알려 준다. 다시 실행하면 이어서 한다(이미 복사한 파일은 다시 복사하지 않음).
 */
function fillMainProductImages_(payload) {
  const started = Date.now();
  const sheetId = prop_(BO_MAIN.SHEET_PROP);
  if (!sheetId) throw userError_('메인 상품목록을 먼저 만들어 주세요.');
  const catalog = imageCatalog_(payload.imageSheetUrl);
  if (!catalog.length) throw userError_('이미지 목록 시트에서 IMAGE 함수로 된 상품 이미지를 찾지 못했습니다.');
  const main = SpreadsheetApp.openById(sheetId).getSheetByName(BO_MAIN.PRODUCT_TAB);
  if (!main) throw userError_('메인 상품목록에 "' + BO_MAIN.PRODUCT_TAB + '" 탭이 없습니다.');
  const rows = main.getLastRow() - 1;
  const names = BO_MAIN.COLUMNS.map(function (c) { return c[0]; });
  const at = function (name) { return names.indexOf(name); };
  const data = main.getRange(2, 1, rows, names.length).getValues();
  const imageCol = at('이미지') + 1;
  const imageRange = main.getRange(2, imageCol, rows, 1);
  const formulas = imageRange.getFormulas();
  const folder = childFolder_(driveRoot_(), BO_MAIN.IMAGE_FOLDER);
  const copies = {};
  const copyOf = function (sourceId) {
    if (copies[sourceId]) return copies[sourceId];
    const name = 'src_' + sourceId;
    const existing = folder.getFilesByName(name);
    let file;
    if (existing.hasNext()) file = existing.next();
    else {
      file = DriveApp.getFileById(sourceId).makeCopy(name, folder);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    return (copies[sourceId] = file.getId());
  };
  const result = { filled: 0, already: 0, unmatched: 0, failed: 0, remaining: 0, unmatchedSamples: [] };
  for (let i = 0; i < rows; i++) {
    if (formulas[i][0]) { result.already++; continue; }
    if (Date.now() - started > BO_MAIN.IMAGE_BUDGET_MS) { result.remaining++; continue; }
    const product = { name: data[i][at('상품명')], brand: data[i][at('브랜드')], barcode: data[i][at('바코드')] };
    const sourceId = matchImage_(product, catalog);
    if (!sourceId) {
      result.unmatched++;
      if (result.unmatchedSamples.length < 10) result.unmatchedSamples.push(data[i][at('상품 ID')] + ' ' + product.name);
      continue;
    }
    try {
      formulas[i][0] = imageFormula_(copyOf(sourceId));
      result.filled++;
    } catch (error) {
      logError_('fillMainProductImages_', error);
      result.failed++;
    }
  }
  // 비어 있던 칸에만 새 수식이 들어가고, 원래 있던 수식은 그대로 다시 쓴다.
  if (result.filled) imageRange.setFormulas(formulas);
  logInfo_('mainProducts.images', { by: activeEmail_(), result: result });
  return Object.assign(result, { catalog: catalog.length, url: mainProductSheetUrl_() });
}

/* ---------- 관리자 API ---------- */

function apiMainProductsStatus_() {
  return { url: mainProductSheetUrl_() };
}

function apiMainProductsBuild_(payload) {
  return withLock_(function () { return buildMainProductList_(payload); }, 5000);
}

function apiMainProductsImages_(payload) {
  return withLock_(function () { return fillMainProductImages_(payload || {}); }, 5000);
}
