/** 상품: Notion '상품 · SKU'가 원본. */

const BO_PRODUCT_FIELD_ALIASES = Object.freeze({
  product_name: ['상품명'], option_name: ['옵션명'], barcode: ['바코드(텍스트)'],
  category: ['카테고리'], retail_price: ['소비자가'], purchase_price: ['매입가(매입 가능시)'],
  consignment_price: ['공급가(위탁 가능시)'], offline_consignment_price: ['오프라인 위탁 판매가'],
  online_lowest_price: ['온라인 최저가'], moq: ['MOQ'], description: ['제품 설명'],
  reference_url: ['참고 링크'], main_image_url: ['대표 이미지 Drive URL'], detail_page_url: ['상세페이지 Drive URL'],
  sales_channels: ['노출 희망 채널'], oliveyoung_status: ['올리브영 입점 상태'], oliveyoung_price: ['올리브영 대비 낮은 가격 판매']
});
const BO_ASSET_FIELDS = Object.freeze({ main_image_url: 'main', detail_page_url: 'detail' });

function productSummary_(row, brandMap, mainImages) {
  const brand = (row.brand || []).map(function (id) { return brandMap[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
  const files = row.image || [];
  const mainFile = mainImages[row.productId] || '';
  const thumbnailId = /\/file\/d\//.test(row.thumbnail || '') ? driveIdFromUrl_(row.thumbnail) : '';
  return {
    pageId: row.pageId, url: row.url, edited: row.edited, createdAt: row.createdAt,
    productId: row.productId || '', name: row.name || '', option: row.option || '', barcode: row.barcode || '',
    category: row.category || [], channels: row.channels || [], description: row.description || '',
    retail: row.retail, purchase: row.purchase, consign: row.consign, offline: row.offline, online: row.online, moq: row.moq,
    review: row.review || '', change: row.change || '', reviewNote: row.reviewNote || '',
    submittedAt: row.submittedAt || '', submitter: row.submitter || '',
    brandIds: row.brand || [], brandCode: brand.code || '', brandName: brand.name || '', company: brand.company || '',
    thumbnail: row.thumbnail || '', detail: row.detail || '', reference: row.reference || '',
    mainFileId: mainFile || thumbnailId,
    preview: files.length && files[0].url ? files[0].url : ''
  };
}

/** 전체 상품(5분 캐시). */
function listProducts_(fresh) {
  if (fresh) bumpCache_('product');
  notionSchema_('product');
  let brandMap = null, mainImages = null;
  return syncedList_('product', 'product', function (row) {
    if (!brandMap) { brandMap = brandMapByPageId_(); mainImages = assetMainImages_(); }
    return productSummary_(row, brandMap, mainImages);
  });
}

function productsOfBrand_(brand) {
  const key = String(brand.pageId).replace(/-/g, '');
  return listProducts_().filter(function (product) {
    return (product.brandIds || []).some(function (id) { return String(id).replace(/-/g, '') === key; });
  });
}

function productPageById_(productId) {
  const schema = notionSchema_('product');
  const pages = notionQueryAll_(schema.sourceId, { filter: fText_(schema, 'productId', productId) }, 3);
  if (pages.length > 1) throw userError_('Notion에 같은 운영센터 상품 ID가 여러 개 있습니다: ' + productId);
  return pages[0] || null;
}

function productPage_(pageId) {
  const schema = notionSchema_('product');
  const page = notionPage_(assertNotionId_(pageId, '상품 페이지'));
  const parent = page.parent && (page.parent.data_source_id || page.parent.database_id);
  if (!sameId_(parent, schema.sourceId)) throw userError_('연결된 상품 DB의 페이지가 아닙니다.');
  if (page.archived || page.in_trash) throw userError_('삭제된 상품입니다.');
  return page;
}

function pageBelongsToBrand_(page, schema, brand) {
  const ids = notionValue_(notionPropertyById_(page, schema.ids.brand)) || [];
  return ids.some(function (id) { return sameId_(id, brand.pageId); });
}

function productProtectedIds_(schema) {
  return ['productId', 'brand', 'review', 'reviewNote', 'submittedAt', 'submitter', 'change']
    .map(function (key) { return schema.ids[key]; }).filter(Boolean);
}

/* ---------- 파트너 입력 항목(Notion 속성에서 자동 생성) ---------- */

function productViewDefinitions_(schema) {
  return cached_('source', 'order:' + schema.sourceId, 600, function () {
    const definitions = schema.definitions.map(function (d) { return { id: d.id, name: d.name }; });
    let viewId = prop_(BO.PROPS.PRODUCT_VIEW_ID), warning = '', view = null;
    try {
      if (!viewId) {
        const views = notionRequest_('get', '/views?data_source_id=' + encodeURIComponent(schema.sourceId), null, BO.NOTION_VIEWS_VERSION);
        viewId = (views.results || [])[0] && views.results[0].id;
      }
      if (viewId) {
        view = notionRequest_('get', '/views/' + encodeURIComponent(viewId), null, BO.NOTION_VIEWS_VERSION);
        if (!sameId_(view.data_source_id, schema.sourceId)) throw new Error('다른 DB의 보기');
      }
    } catch (error) {
      warning = 'Notion 보기 순서를 읽지 못해 DB 속성 순서로 표시합니다.';
    }
    const ordered = view && view.configuration && view.configuration.properties || [];
    const ranks = {};
    ordered.forEach(function (item, index) { ranks[item.property_id] = index; });
    definitions.sort(function (a, b) { return (ranks[a.id] == null ? 10000 : ranks[a.id]) - (ranks[b.id] == null ? 10000 : ranks[b.id]); });
    return { order: definitions.map(function (d) { return d.id; }), viewName: view && view.name || '', warning: warning };
  });
}

function productFormRules_(sourceId) {
  try { return JSON.parse(prop_(BO.PROPS.FORM_RULES_PREFIX + sourceId) || '{}'); } catch (ignored) { return {}; }
}

/** 파트너 상품 입력 항목. Notion 상품 DB 속성과 운영센터 규칙(필수·사용·도움말)을 합친다. */
function productFieldConfig_() {
  if (hasOwn_(BO_MEMO_, 'fields:config')) return BO_MEMO_['fields:config'];
  const schema = notionSchema_('product');
  const ordered = productViewDefinitions_(schema);
  const rules = productFormRules_(schema.sourceId);
  const reserved = productProtectedIds_(schema);
  const partnerTypes = { title: true, rich_text: true, number: true, select: true, multi_select: true, url: true, checkbox: true, date: true, email: true, phone_number: true };
  const builtin = { name: 'product_name', option: 'option_name', barcode: 'barcode', retail: 'retail_price', purchase: 'purchase_price', description: 'description', reference: 'reference_url', thumbnail: 'main_image_url', detail: 'detail_page_url', category: 'category', consign: 'consignment_price', offline: 'offline_consignment_price', online: 'online_lowest_price', moq: 'moq', channels: 'sales_channels' };
  let saved = {};
  try { saved = JSON.parse(prop_(BO.PROPS.FIELD_IDS_PREFIX + schema.sourceId) || '{}'); } catch (ignored) {}
  const mapping = Object.assign({}, saved);
  const fields = [];
  ordered.order.forEach(function (propertyId) {
    const d = schema.byId[propertyId];
    if (!d || !partnerTypes[d.type] || reserved.indexOf(d.id) >= 0) return;
    const schemaKey = Object.keys(builtin).find(function (k) { return schema.ids[k] === d.id; });
    let id = schemaKey ? builtin[schemaKey] : Object.keys(mapping).find(function (k) { return mapping[k] === d.id; });
    if (!id) id = Object.keys(BO_PRODUCT_FIELD_ALIASES).find(function (k) { return BO_PRODUCT_FIELD_ALIASES[k].indexOf(d.name) >= 0 && !fields.some(function (f) { return f.id === k; }); });
    if (!id) id = 'notion_' + Utilities.base64EncodeWebSafe(d.id).replace(/=+$/, '');
    mapping[id] = d.id;
    const rule = rules[d.id] || {};
    const known = !!BO_PRODUCT_FIELD_ALIASES[id];
    const requiredDefault = ['product_name', 'barcode', 'category', 'retail_price', 'main_image_url', 'detail_page_url'].indexOf(id) >= 0;
    const asset = BO_ASSET_FIELDS[id] || '';
    fields.push({
      id: id, propertyId: d.id, label: d.name, notionType: d.type,
      type: asset ? 'asset' : d.type === 'rich_text' ? (['barcode', 'option_name'].indexOf(id) >= 0 ? 'text' : 'textarea') : d.type === 'title' ? 'text' : d.type,
      asset: asset,
      required: id === 'product_name' || (rule.required == null ? requiredDefault : rule.required === true),
      active: id === 'product_name' || (rule.active == null ? known : rule.active !== false),
      order: fields.length + 1,
      options: (d[d.type] && d[d.type].options || []).map(function (o) { return o.name; }),
      help: rule.help || d.description || '', examples: rule.examples || ''
    });
  });
  if (JSON.stringify(mapping) !== JSON.stringify(saved)) {
    try { props_().setProperty(BO.PROPS.FIELD_IDS_PREFIX + schema.sourceId, JSON.stringify(mapping)); } catch (error) { logError_('field ids', error); }
  }
  const version = sha256_(JSON.stringify(fields.map(function (f) { return [f.propertyId, f.label, f.notionType, f.required, f.active, f.options, f.help, f.examples]; }))).slice(0, 16);
  const config = { fields: fields, version: version, viewName: ordered.viewName, orderWarning: ordered.warning };
  BO_MEMO_['fields:config'] = config;
  return config;
}

/** 페이지 속성 → 파트너 입력값(field id 기준). */
function productFieldValues_(page, fields) {
  const values = {};
  fields.forEach(function (field) {
    const value = notionValue_(notionPropertyById_(page, field.propertyId));
    values[field.id] = value == null ? '' : value;
  });
  return values;
}

/** 파트너 입력값 검증 후 Notion properties로 변환. 이미지·상세페이지(asset) 항목은 제외. */
function productPropsFromInput_(data, fields, options) {
  options = options || {};
  const schema = notionSchema_('product');
  const properties = {}, errors = [];
  fields.forEach(function (field) {
    if (field.asset) return;
    if (!hasOwn_(data, field.id) && options.partial) return;
    const raw = data[field.id];
    const empty = raw == null || raw === '' || raw === false || (Array.isArray(raw) && !raw.length);
    if (empty && field.required && field.active && field.notionType !== 'checkbox') {
      errors.push(field.label + '을(를) 입력해 주세요.');
      return;
    }
    try {
      properties[field.propertyId] = notionWrite_(schema.byId[field.propertyId], empty ? (field.notionType === 'multi_select' ? [] : field.notionType === 'checkbox' ? false : '') : raw);
    } catch (error) {
      errors.push(errorMessage_(error));
    }
  });
  if (errors.length) throw userError_(errors.slice(0, 5).join(' / '));
  return properties;
}

function apiProductFields_() {
  const config = productFieldConfig_();
  return { fields: config.fields, version: config.version, viewName: config.viewName, orderWarning: config.orderWarning };
}

function apiProductFieldsSave_(payload) {
  return withLock_(function () {
    const schema = notionSchema_('product');
    const config = productFieldConfig_();
    if (payload.version !== config.version) throw userError_('Notion 속성이나 설정이 바뀌었습니다. 새로 고친 뒤 다시 저장해 주세요.', 'CONFLICT');
    const inputs = Array.isArray(payload.fields) ? payload.fields : [];
    const rules = {};
    inputs.forEach(function (input) {
      const field = config.fields.find(function (f) { return f.propertyId === input.propertyId; });
      if (!field) throw userError_('알 수 없는 입력 항목이 있습니다. 새로 고쳐 주세요.');
      rules[field.propertyId] = {
        active: field.id === 'product_name' || input.active === true,
        required: field.id === 'product_name' || input.required === true,
        help: text_(input.help, 300), examples: text_(input.examples, 300)
      };
    });
    const json = JSON.stringify(rules);
    if (Utilities.newBlob(json).getBytes().length > 8500) throw userError_('도움말·예시가 너무 깁니다. 조금 줄여 주세요.');
    props_().setProperty(BO.PROPS.FORM_RULES_PREFIX + schema.sourceId, json);
    delete BO_MEMO_['fields:config'];
    return { saved: true, version: productFieldConfig_().version };
  });
}

/* ---------- 관리자 API ---------- */

function apiProductsList_() {
  const schema = notionSchema_('product');
  const pick = function (key) {
    const d = schema.defs[key];
    return d && d[d.type] && d[d.type].options ? d[d.type].options.map(function (o) { return o.name; }) : [];
  };
  return { products: listProducts_(), options: { category: pick('category'), review: pick('review') } };
}

function apiProductDetail_(payload) {
  const schema = notionSchema_('product');
  const page = productPage_(payload.pageId);
  const row = notionRow_(page, schema);
  const summary = productSummary_(row, brandMapByPageId_(), {});
  return {
    product: summary,
    lastEditedAt: page.last_edited_time,
    properties: notionPropertyList_(page, schema.definitions, productProtectedIds_(schema)),
    assets: row.productId ? listProductAssets_(summary.brandCode, row.productId) : [],
    blocks: notionBlocks_(page.id, 0)
  };
}

function apiProductUpdate_(payload) {
  const schema = notionSchema_('product');
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const blockChanges = Array.isArray(payload.blockChanges) ? payload.blockChanges : [];
  const appendText = text_(payload.appendText, 20000);
  if (!changes.length && !blockChanges.length && !appendText) return { changed: false };
  if (changes.length > 40 || blockChanges.length > 50) throw userError_('한 번에 수정할 수 있는 양을 넘었습니다.');
  return withLock_(function () {
    const page = productPage_(payload.pageId);
    if (payload.lastEditedAt && page.last_edited_time !== payload.lastEditedAt) {
      throw userError_('다른 사람이 Notion에서 먼저 수정했습니다. 새로 고친 뒤 다시 저장해 주세요.', 'CONFLICT');
    }
    const protectedIds = productProtectedIds_(schema);
    const editable = notionEditableTypes_();
    const patch = {}, expected = {};
    changes.forEach(function (change) {
      const definition = schema.byId[String(change.id || '')];
      if (!definition || !editable[definition.type] || protectedIds.indexOf(definition.id) >= 0 || hasOwn_(patch, definition.id)) {
        throw userError_('수정할 수 없는 상품 속성이 포함되어 있습니다.');
      }
      patch[definition.id] = notionWrite_(definition, change.value);
      expected[definition.id] = notionInputComparable_(definition, change.value);
    });
    if (schema.ids.barcode && hasOwn_(patch, schema.ids.barcode)) {
      assertBarcodeFree_(notionInputComparable_(schema.defs.barcode, changes.find(function (c) { return c.id === schema.ids.barcode; }).value), page.id, null);
    }
    const plan = productBodyPlan_(page.id, blockChanges);
    let updated = page;
    if (Object.keys(patch).length) {
      updated = notionPatch_(page.id, patch);
      notionVerify_(updated, schema.byId, expected);
    }
    plan.forEach(function (change) {
      const body = {};
      body[change.type] = notionRichText_(change.text);
      notionPatchBlock_(change.id, body);
    });
    if (appendText) notionAppend_(page.id, [{ object: 'block', type: 'paragraph', paragraph: notionRichText_(appendText + ' — ' + activeEmail_() + ', ' + today_()) }]);
    bumpCache_('product');
    return { changed: true, lastEditedAt: updated.last_edited_time };
  });
}

function productBodyPlan_(pageId, changes) {
  if (!changes.length) return [];
  const byId = {};
  (function visit(blocks) { blocks.forEach(function (b) { byId[b.id] = b; visit(b.children || []); }); })(notionBlocks_(pageId, 0));
  const seen = {};
  return changes.map(function (change) {
    const block = byId[change.id];
    if (!block || !block.editable || seen[change.id]) throw userError_('수정할 수 없는 본문 블록이 포함되어 있습니다.');
    if (block.text !== change.original) throw userError_('Notion 본문이 먼저 수정되었습니다. 새로 고친 뒤 다시 저장해 주세요.', 'CONFLICT');
    seen[change.id] = true;
    return { id: block.id, type: block.type, text: text_(change.text, 100000) };
  });
}

/** 다른 브랜드 상품이 같은 바코드를 쓰고 있으면 막는다. */
function assertBarcodeFree_(barcode, ownPageId, brand) {
  barcode = String(barcode || '').trim();
  if (!barcode) return;
  const schema = notionSchema_('product');
  if (!schema.ids.barcode) return;
  const pages = notionQueryAll_(schema.sourceId, { filter: fText_(schema, 'barcode', barcode) }, 10);
  const conflict = pages.find(function (page) {
    if (ownPageId && sameId_(page.id, ownPageId)) return false;
    if (brand && pageBelongsToBrand_(page, schema, brand)) return false;
    return true;
  });
  if (conflict) {
    const name = notionPlain_(notionPropertyById_(conflict, schema.ids.name));
    throw userError_('바코드 ' + barcode + '는 이미 다른 상품에 등록되어 있습니다' + (brand ? '.' : ': ' + name));
  }
}
