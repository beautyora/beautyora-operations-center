/** 브랜드(파트너) 상품등록센터 API. 모든 함수는 partnerContext_로 확인된 브랜드 범위 안에서만 동작한다. */

/**
 * 운영센터 상품 ID가 없는 상품(Notion에 직접 넣었거나 예전부터 있던 상품)에 ID를 붙인다.
 * 브랜드 화면은 이 ID로 상품·파일을 찾으므로, ID가 있어야 브랜드가 자기 상품을 모두 보고 수정 요청할 수 있다.
 * 반환: 새로 붙인 페이지 수. pages는 같은 DB의 페이지 목록이며, 붙인 ID는 pages의 속성에도 반영된다.
 */
function assignProductIds_(pages, schema, limit) {
  const missing = pages.filter(function (page) { return !notionValue_(notionPropertyById_(page, schema.ids.productId)); }).slice(0, limit || 1000);
  if (!missing.length) return 0;
  let assigned = 0;
  withLock_(function () {
    missing.forEach(function (page) {
      const fresh = notionPage_(page.id);
      let id = notionValue_(notionPropertyById_(fresh, schema.ids.productId));
      if (!id) {
        id = 'PRD-' + uuid_('').slice(0, 8) + '-' + uuid_('').slice(0, 8);
        const patch = {};
        patch[schema.ids.productId] = notionRichText_(id);
        notionPatch_(page.id, patch);
        assigned++;
      }
      const property = notionPropertyById_(page, schema.ids.productId);
      if (property) property.rich_text = [{ type: 'text', text: { content: id }, plain_text: id }];
    });
  }, 60000);
  if (assigned) logInfo_('product.assignIds', { count: assigned });
  return assigned;
}

function partnerProducts_(brand) {
  return cached_('product', 'brand:' + brand.code, 30, function () {
    const schema = notionSchema_('product');
    const fields = productFieldConfig_().fields;
    const mainImages = assetMainImages_();
    const pages = notionQueryAll_(schema.sourceId, { filter: fRelation_(schema, 'brand', brand.pageId), sorts: [{ timestamp: 'created_time', direction: 'descending' }] }, 1000);
    // 운영센터 밖에서 만든 상품도 브랜드가 볼 수 있게 ID를 붙인다.
    if (assignProductIds_(pages, schema)) bumpCache_('product');
    return pages.map(function (page) {
      const row = notionRow_(page, schema);
      return {
        productId: row.productId || '', name: row.name || '', option: row.option || '', barcode: row.barcode || '',
        review: row.review || '', change: row.change || '', reviewNote: row.reviewNote || '', submittedAt: row.submittedAt || '',
        edited: row.edited, mainFileId: mainImages[row.productId] || '',
        linked: { main: !!row.thumbnail, detail: !!row.detail },
        values: productFieldValues_(page, fields)
      };
    }).filter(function (p) { return p.productId; });
  });
}

function partnerBootstrap_(ctx) {
  const config = productFieldConfig_();
  return {
    brand: { code: ctx.brand.code, name: ctx.brand.name, company: ctx.brand.company },
    fields: config.fields.filter(function (f) { return f.active; }),
    fieldVersion: config.version,
    products: partnerProducts_(ctx.brand),
    documents: listBrandDocs_(ctx.brand.code),
    assetCategories: Object.keys(BO_ASSET_CODES),
    docCategories: Object.keys(BO_DOC_CODES),
    limits: { maxProducts: BO.MAX_SUBMIT_PRODUCTS, maxUploadBytes: BO.MAX_UPLOAD_BYTES }
  };
}

function partnerFields_() {
  const config = productFieldConfig_();
  return { fields: config.fields.filter(function (f) { return f.active; }), fieldVersion: config.version };
}

function partnerUpload_(ctx, payload) {
  return { file: uploadBrandFile_(ctx.brand, payload || {}) };
}

function partnerDocuments_(ctx) {
  return { documents: listBrandDocs_(ctx.brand.code) };
}

function partnerProductAssets_(ctx, payload) {
  const productId = assertId_(payload.productId, '상품 ID');
  return { assets: listProductAssets_(ctx.brand.code, productId) };
}

function partnerThumbnails_(ctx, payload) {
  const ids = (Array.isArray(payload.fileIds) ? payload.fileIds : []).slice(0, 24);
  const out = {};
  ids.forEach(function (id) {
    if (!/^[\w-]{10,}$/.test(String(id))) return;
    try {
      const file = driveFile_(id);
      if (!file.appProperties || file.appProperties.boBrand !== ctx.brand.code) return;
      out[id] = driveThumbnail_(file);
    } catch (error) {
      logError_('partnerThumbnails_', error);
    }
  });
  return { thumbnails: out };
}

/**
 * 상품 제출. 새 상품·보완 재제출은 속성에 바로 저장하고, 승인된 상품은 변경 요청으로 남긴다.
 * 먼저 모든 상품을 검증하고, 하나라도 문제가 있으면 아무것도 저장하지 않는다.
 */
function partnerSubmit_(ctx, payload) {
  payload = payload || {};
  const requestId = assertId_(payload.requestId, '제출 ID');
  // 같은 제출 ID의 재시도는 검증 전에 이전 결과를 돌려준다(네트워크 재시도로 두 번 저장되지 않게).
  return idempotent_('submit-' + ctx.brand.code + '-' + requestId, function () {
    const list = Array.isArray(payload.products) ? payload.products : [];
    if (!list.length) throw userError_('제출할 상품을 선택해 주세요.');
    if (list.length > BO.MAX_SUBMIT_PRODUCTS) throw userError_('한 번에 ' + BO.MAX_SUBMIT_PRODUCTS + '개까지 제출할 수 있습니다.');
    if (!text_(payload.contactName)) throw userError_('제출하시는 분의 이름을 입력해 주세요.');
    const submitter = [text_(payload.contactName, 50), text_(payload.contactPhone, 30)].filter(Boolean).join(' / ');
    return withLock_(function () { return partnerSubmitLocked_(ctx, list, requestId, submitter); }, 30000);
  });
}

function partnerSubmitLocked_(ctx, list, requestId, submitter) {
  const schema = notionSchema_('product');
  const fields = productFieldConfig_().fields.filter(function (f) { return f.active; });
  const submittedAt = now_();
  const seenIds = {}, seenBarcodes = {};
  const plans = [], problems = [];

  list.forEach(function (item, index) {
    const messages = [];
    const data = item && item.data && typeof item.data === 'object' ? item.data : {};
    const name = text_(data.product_name, 100) || (index + 1) + '번째 상품';
    let productId = '';
    try { productId = assertId_(item.productId, '상품 ID'); } catch (error) { messages.push(errorMessage_(error)); }
    if (productId && seenIds[productId]) messages.push('같은 상품이 두 번 포함되어 있습니다.');
    seenIds[productId] = true;
    const barcode = text_(data.barcode, 60);
    if (barcode) {
      if (seenBarcodes[barcode]) messages.push('같은 바코드가 이 제출에 두 번 있습니다.');
      seenBarcodes[barcode] = true;
    }
    let page = null, mode = 'create', properties = {}, assets = [];
    if (!messages.length) {
      try {
        page = productPageById_(productId);
        if (page) {
          if (!pageBelongsToBrand_(page, schema, ctx.brand)) throw userError_('다른 브랜드의 상품은 수정할 수 없습니다.');
          const review = notionValue_(notionPropertyById_(page, schema.ids.review)) || '';
          mode = [BO.REVIEW.PENDING, BO.REVIEW.REVISION, BO.REVIEW.REJECTED].indexOf(review) >= 0 ? 'resubmit' : 'change';
        }
        properties = productPropsFromInput_(data, fields, { partial: mode === 'change' });
        assets = listProductAssets_(ctx.brand.code, productId);
        const need = function (fieldId, code, label, schemaKey) {
          const field = fields.find(function (f) { return f.id === fieldId; });
          // 등록된 상품의 수정 요청은 Notion에 이미 연결된 파일이 있으면 새로 올리지 않아도 된다.
          const linked = mode === 'change' && schema.ids[schemaKey] && notionValue_(notionPropertyById_(page, schema.ids[schemaKey]));
          if (field && field.required && !linked && !assets.some(function (a) { return a.categoryCode === code; })) messages.push(label + ' 파일을 올려 주세요.');
        };
        need('main_image_url', 'main', '대표 이미지', 'thumbnail');
        need('detail_page_url', 'detail', '상세페이지', 'detail');
        if (barcode) assertBarcodeFree_(barcode, page && page.id, ctx.brand);
      } catch (error) {
        messages.push(errorMessage_(error));
      }
    }
    if (messages.length) problems.push({ index: index, productId: productId, name: name, messages: messages });
    else {
      // 이번 초안에서 새로 올린 파일과, 새 파일로 바꿀 분류(대표는 항상 교체).
      const ownIds = {};
      assets.forEach(function (a) { ownIds[a.id] = true; });
      const newFiles = (Array.isArray(item.newFiles) ? item.newFiles : []).map(String).filter(function (id) { return ownIds[id]; }).slice(0, 200);
      const replace = ['main'].concat((Array.isArray(item.replace) ? item.replace : []).map(String).filter(function (c) { return ['detail', 'extra', 'etc'].indexOf(c) >= 0; }));
      plans.push({ productId: productId, name: name, page: page, mode: mode, data: data, properties: properties, assets: assets, newFiles: newFiles, replace: replace });
    }
  });
  if (problems.length) return { ok: false, problems: problems };

  const results = plans.map(function (plan) {
    const meta = notionProps_(schema, { submittedAt: submittedAt, submitter: submitter }, {});
    if (plan.mode === 'change') {
      const previous = pendingChange_(plan.page.id);
      if (previous) markChangeBlock_(previous, '⏭️ 새 요청으로 대체됨');
      const current = productFieldValues_(plan.page, fields);
      const lines = fields.filter(function (f) { return !f.asset && hasOwn_(plan.data, f.id) && !sameValue_(plan.data[f.id], current[f.id]); })
        .map(function (f) { return f.label + ': ' + describeValue_(current[f.id]) + ' → ' + describeValue_(plan.data[f.id]); });
      const values = {};
      fields.forEach(function (f) { if (!f.asset && hasOwn_(plan.data, f.id)) values[f.id] = plan.data[f.id]; });
      const fileLines = plan.newFiles.length ? ['새 파일 ' + plan.newFiles.length + '개' + (plan.replace.length > 1 ? ' (상세·추가 이미지는 기존 파일을 교체)' : ' (대표 이미지는 교체, 나머지는 추가)')] : [];
      notionAppend_(plan.page.id, [changeBlock_({ v: 1, requestId: requestId, submittedAt: submittedAt, submitter: submitter, brandCode: ctx.brand.code, values: values, assets: plan.assets.map(function (a) { return a.id; }), newFiles: plan.newFiles, replace: plan.replace }, lines.concat(fileLines).length ? lines.concat(fileLines) : ['변경된 입력값 없음'])]);
      const properties = Object.assign({}, meta, notionProps_(schema, { change: BO.CHANGE.PENDING }, { allowNewOption: true }));
      if (schema.ids.reviewNote) properties[schema.ids.reviewNote] = notionRichText_('');
      notionPatch_(plan.page.id, properties);
      return { productId: plan.productId, name: plan.name, mode: 'change' };
    }
    const properties = Object.assign({}, plan.properties, assetFolderProps_(schema, plan.assets), meta,
      notionProps_(schema, { productId: plan.productId, brand: [ctx.brand.pageId], review: BO.REVIEW.PENDING }, { allowNewOption: true }));
    if (schema.ids.reviewNote) properties[schema.ids.reviewNote] = notionRichText_('');
    if (plan.page) notionPatch_(plan.page.id, properties);
    else notionCreate_(schema.sourceId, properties);
    // 아직 승인 전인 상품은 교체한 옛 파일을 바로 정리한다.
    retireReplacedAssets_(ctx.brand, plan.productId, plan.newFiles, plan.replace);
    return { productId: plan.productId, name: plan.name, mode: plan.mode };
  });
  bumpCache_('product');
  logInfo_('partner.submit', { brand: ctx.brand.code, count: results.length });
  return { ok: true, results: results, submittedAt: submittedAt };
}

/** 엑셀(xlsx) → 상품 행. Drive에서 임시 변환 후 즉시 삭제한다. */
function partnerImportWorkbook_(ctx, payload) {
  const name = sanitizeFileName_(payload.fileName);
  if (!/\.xlsx$/i.test(name)) throw userError_('xlsx 파일만 가져올 수 있습니다. CSV는 화면에서 바로 불러옵니다.');
  const bytes = Utilities.base64Decode(String(payload.base64 || ''));
  if (!bytes.length || bytes.length > BO.MAX_UPLOAD_BYTES) throw userError_('엑셀 파일은 8MB 이하만 가져올 수 있습니다.');
  const fields = productFieldConfig_().fields.filter(function (f) { return f.active && !f.asset; });
  let converted = null;
  try {
    const folder = withLock_(function () { return brandFolder_(ctx.brand); });
    converted = Drive.Files.create({ name: '_임시변환_' + name, parents: [folder.getId()], mimeType: 'application/vnd.google-apps.spreadsheet' },
      Utilities.newBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name), { fields: 'id', supportsAllDrives: true });
    const values = SpreadsheetApp.openById(converted.id).getSheets()[0].getDataRange().getDisplayValues();
    return mapImportRows_(values, fields);
  } finally {
    if (converted && converted.id) { try { Drive.Files.remove(converted.id, { supportsAllDrives: true }); } catch (ignored) {} }
  }
}

/** 표 형태 값 → 상품 입력값. 머리글은 항목 이름이나 내부 ID와 일치해야 한다. */
function mapImportRows_(values, fields) {
  let headerRow = -1;
  for (let i = 0; i < Math.min(values.length, 15); i++) {
    if (values[i].some(function (cell) {
      const header = String(cell).replace(/\s*\*$/, '').trim();
      return fields.some(function (f) { return f.id === 'product_name' && (header === f.label || header === f.id); });
    })) { headerRow = i; break; }
  }
  if (headerRow < 0) throw userError_('"상품명" 머리글을 찾지 못했습니다. 양식을 내려받아 사용해 주세요.');
  const headers = values[headerRow].map(function (h) { return String(h).replace(/\s*\*$/, '').trim(); });
  const columns = {};
  fields.forEach(function (f) {
    const short = f.label.replace(/\s*\([^)]*\)\s*$/, '');
    const index = headers.findIndex(function (h) { return h === f.label || h === f.id || h === short; });
    if (index >= 0) columns[f.id] = index;
  });
  const numbered = values.map(function (row, index) { return { row: row, number: index + 1 }; }).slice(headerRow + 1)
    .filter(function (item) { return item.row.some(function (cell) { return String(cell).trim(); }); }).slice(0, 300);
  const rows = numbered.map(function (item) { return item.row; });
  const idCol = headers.findIndex(function (h) { return h === '상품 ID' || h === '운영센터 상품 ID'; });
  return {
    columns: Object.keys(columns),
    rowNumbers: numbered.map(function (item) { return item.number; }),
    productIds: rows.map(function (row) { return idCol >= 0 ? String(row[idCol] || '').trim() : ''; }),
    rows: rows.map(function (row) {
      const data = {};
      Object.keys(columns).forEach(function (id) {
        const field = fields.find(function (f) { return f.id === id; });
        const cell = String(row[columns[id]] == null ? '' : row[columns[id]]).trim();
        data[id] = field.notionType === 'multi_select' ? cell.split(',').map(function (v) { return v.trim(); }).filter(Boolean) : field.notionType === 'checkbox' ? /^(y|yes|true|예|o|1)$/i.test(cell) : cell;
      });
      return data;
    })
  };
}
