/**
 * 메인 상품목록(Google 시트): 상품의 원본.
 * 처음 한 번, 통합 상품리스트(벤더별 운영본)의 정리 탭에서 만든다. 이후에는 이 시트가 원본이고 통합리스트는 외부 제공용 작업 공간이다.
 * - '상품' 탭: 브랜드 열 하나로 정리하고, 벤더를 통해 들어온 상품만 '벤더' 열에 벤더사 이름을 적는다(직거래는 비움).
 * - '가격 근거' 탭: 통합리스트의 가격 계산·출처 열을 상품 ID로 이어 보관한다.
 * - 제품 링크: 통합리스트에는 없어서 Notion 상품 DB의 '참고 링크', 기존 브랜드 폴더의 입점 상품 리스트 '참고링크'에서 찾아 채운다.
 */

const BO_MAIN = Object.freeze({
  TITLE: '뷰티오라 메인 상품목록',
  PRODUCT_TAB: '상품',
  BASIS_TAB: '가격 근거',
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
    ['권장판매가', '권장판매가'],
    ['매입 MOQ', '매입MOQ'],
    ['핵심포인트', '핵심포인트'],
    ['제품설명', '제품설명'],
    ['제품 링크'],
    ['링크 출처'],
    ['원본행 ID', '원본행 ID']
  ],
  PRICE_COLUMNS: ['매입 공급가', '위탁 공급가', '권장판매가'],
  /** 기존 Notion 상품 DB(읽기만). v2에서 쓰던 스크립트 속성을 그대로 읽는다. */
  LEGACY_PRODUCT_PROP: 'BO_NOTION_PRODUCT_DATA_SOURCE_ID',
  SHEET_PROP: 'BO_MAIN_PRODUCT_SHEET_ID'
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
  const need = ['브랜드', '상품명', '이미지', '운영출처시트', '실제공급사'];
  const missing = need.filter(function (key) { return !hasOwn_(index, key); });
  if (missing.length) throw userError_('통합 상품리스트 머리글을 찾지 못했습니다: ' + missing.join(', '));

  const at = function (row, name) { const key = headerKey_(name); return hasOwn_(index, key) ? row[index[key]] : ''; };
  const rows = values.slice(1);
  const used = {};
  BO_MAIN.COLUMNS.forEach(function (c) { if (c[1]) used[index[headerKey_(c[1])]] = true; });

  // 제품 링크 후보
  let candidates = [];
  try { candidates = candidates.concat(notionProductLinks_()); } catch (error) { report.push('Notion 상품 DB를 읽지 못했습니다: ' + errorMessage_(error)); }
  if (payload.legacyFolderUrl) candidates = candidates.concat(legacyWorkbookLinks_(payload.legacyFolderUrl, report));

  const stats = { products: 0, vendor: 0, linkNotion: 0, linkWorkbook: 0, storeMain: 0, noLink: 0 };
  const mainRows = [], basisRows = [], keep = [];
  rows.forEach(function (row, i) {
    const brand = clean_(at(row, '브랜드')), name = clean_(at(row, '상품명'));
    if (!brand && !name) return;
    keep.push(i);
    stats.products++;
    const id = BO_MAIN.ID_PREFIX + ('00000' + stats.products).slice(-5);
    const sourceSheet = String(at(row, '운영 출처시트'));
    const vendor = sourceSheet.indexOf(BO_MAIN.DIRECT_SOURCE_KEYWORD) >= 0 ? '' : clean_(at(row, '실제 공급사'));
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
        default: return at(row, c[1]);
      }
    }));
    basisRows.push([id, name].concat(header.map(function (h, c) { return used[c] ? null : row[c]; }).filter(function (v, c) { return !used[c]; })));
  });
  if (!mainRows.length) throw userError_('옮길 상품이 없습니다.');

  const book = SpreadsheetApp.create(BO_MAIN.TITLE);
  try { DriveApp.getFileById(book.getId()).moveTo(driveRoot_()); } catch (error) { report.push('브랜드 자료 루트 폴더로 옮기지 못했습니다: ' + errorMessage_(error)); }

  // 셀 이미지는 같은 파일 안에서만 그대로 복사되므로, 원본 탭을 새 파일로 복사한 뒤 이미지 열만 옮긴다.
  const copy = sheet.copyTo(book);
  const main = book.getSheets()[0];
  main.setName(BO_MAIN.PRODUCT_TAB);
  const width = BO_MAIN.COLUMNS.length;
  main.getRange(1, 1, 1, width).setValues([BO_MAIN.COLUMNS.map(function (c) { return c[0]; })]).setFontWeight('bold').setBackground('#f1eb9c');
  main.getRange(2, 1, mainRows.length, width).setValues(mainRows);
  const imageCol = BO_MAIN.COLUMNS.findIndex(function (c) { return c[0] === '이미지'; }) + 1;
  const sourceImageCol = index[headerKey_('이미지')] + 1;
  // 빈 행을 건너뛴 경우에도 맞도록, 이어진 구간마다 한 번에 복사한다.
  let start = 0;
  for (let k = 1; k <= keep.length; k++) {
    if (k === keep.length || keep[k] !== keep[k - 1] + 1) {
      copy.getRange(keep[start] + 2, sourceImageCol, k - start, 1).copyTo(main.getRange(start + 2, imageCol, k - start, 1));
      start = k;
    }
  }
  book.deleteSheet(copy);
  BO_MAIN.PRICE_COLUMNS.forEach(function (name) {
    const col = BO_MAIN.COLUMNS.findIndex(function (c) { return c[0] === name; }) + 1;
    main.getRange(2, col, mainRows.length, 1).setNumberFormat('#,##0"원"');
  });
  main.setFrozenRows(1);
  main.setFrozenColumns(2);
  main.setRowHeights(2, mainRows.length, 64);
  main.setColumnWidth(imageCol, 72);

  const basis = book.insertSheet(BO_MAIN.BASIS_TAB);
  const basisHeader = ['상품 ID', '상품명'].concat(header.filter(function (h, c) { return !used[c]; }).map(function (h) { return String(h).split('\n')[0]; }));
  basis.getRange(1, 1, 1, basisHeader.length).setValues([basisHeader]).setFontWeight('bold');
  basis.getRange(2, 1, basisRows.length, basisHeader.length).setValues(basisRows);
  basis.setFrozenRows(1);

  props_().setProperty(BO_MAIN.SHEET_PROP, book.getId());
  logInfo_('mainProducts.build', { by: activeEmail_(), products: stats.products, sheet: book.getId() });
  return { url: book.getUrl(), stats: stats, candidates: candidates.length, report: report };
}

/* ---------- 관리자 API ---------- */

function apiMainProductsStatus_() {
  return { url: mainProductSheetUrl_() };
}

function apiMainProductsBuild_(payload) {
  return withLock_(function () { return buildMainProductList_(payload); }, 5000);
}
