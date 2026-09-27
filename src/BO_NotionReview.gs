/** Notion review bridge. Script properties select the environment-specific data sources. */
const BO_REVIEW_SCHEMA = Object.freeze({
  product: {
    productId: ['운영센터 상품 ID', 'rich_text'],
    name: ['상품명', 'title'],
    brand: ['브랜드', 'relation'],
    review: ['등록 검수 상태', 'select'],
    thumbnail: ['대표 이미지 Drive URL', 'url'],
    detail: ['상세페이지 Drive URL', 'url'],
    barcode: ['바코드(텍스트)', 'rich_text'],
    option: ['옵션명', 'rich_text'],
    description: ['제품 설명', 'rich_text'],
    retail: ['소비자가', 'number'],
    purchase: ['매입가(매입 가능시)', 'number'],
    reference: ['참고 링크', 'url']
  },
  brand: {
    business: ['사업자등록증 Drive URL', 'url'],
    introduction: ['브랜드 소개서 Drive URL', 'url'],
    contract: ['계약서 Drive URL', 'url'],
    other: ['기타 브랜드 자료 Drive URL', 'url']
  }
});
const BO_REVIEW_SCHEMA_CACHE = {};
const BO_BRAND_DISPLAY_FIELDS = Object.freeze({
  '브랜드ID':['브랜드 ID'], '브랜드명':['브랜드명'], '회사명':['협력사/회사명','회사명'],
  '영업단계':['진행 단계','영업 단계'], '재영업단계':['재영업 단계'], '재영업분류':['재영업 분류'],
  '우선순위':['우선순위'], '브랜드담당자':['브랜드 담당자'], '연락처':['연락처'],
  '이메일':['이메일'], '카테고리':['카테고리'], '거래방식':['희망 거래 방식'],
  '희망채널':['희망 영역','순위 무관 희망 채널'], '핵심메모':['핵심 메모'],
  '다음행동':['다음 행동'], '참고자료':['참고 링크/자료'], 'Drive주소':['구글 드라이브'],
  '상품특장점':['상품 특장점'], '대표상품군':['대표 상품군']
});
const BO_BRAND_DISPLAY_SCHEMA_CACHE = {};

function notionBrandDisplayIds_() {
  const sourceId = notionReviewConfig_().brand;
  if (BO_BRAND_DISPLAY_SCHEMA_CACHE[sourceId]) return BO_BRAND_DISPLAY_SCHEMA_CACHE[sourceId];
  const source = notionRequest_('get', '/data_sources/' + encodeURIComponent(sourceId));
  const definitions = Object.keys(source.properties || {}).map(function(name) {
    return Object.assign({name:name}, source.properties[name]);
  });
  const store = PropertiesService.getScriptProperties();
  let saved = {};
  try { saved = JSON.parse(store.getProperty('BO_NOTION_BRAND_DISPLAY_PROPERTY_IDS') || '{}'); } catch (ignored) {}
  const previous = saved[sourceId] || {}, ids = {};
  Object.keys(BO_BRAND_DISPLAY_FIELDS).forEach(function(key) {
    const aliases = BO_BRAND_DISPLAY_FIELDS[key];
    const definition = definitions.find(function(item) { return previous[key] && item.id === previous[key]; }) ||
      definitions.find(function(item) { return aliases.indexOf(item.name) >= 0; });
    if (definition) ids[key] = definition.id;
  });
  if (!ids['브랜드ID'] || !ids['브랜드명']) throw new Error('Notion 브랜드 ID 또는 브랜드명 속성을 찾지 못했습니다.');
  if (Object.keys(ids).some(function(key) { return previous[key] !== ids[key]; })) {
    saved[sourceId] = Object.assign({}, previous, ids);
    store.setProperty('BO_NOTION_BRAND_DISPLAY_PROPERTY_IDS', JSON.stringify(saved));
  }
  BO_BRAND_DISPLAY_SCHEMA_CACHE[sourceId] = ids;
  return ids;
}

function notionBrandDisplayRow_(page, ids) {
  const row = {'원본URL':page.url || '', '노션페이지ID':page.id, '_notionSource':'notion',
    '수정일':page.last_edited_time || ''};
  Object.keys(ids).forEach(function(key) { row[key] = notionReviewText_(notionPageProperty_(page, ids[key])); });
  return row;
}

function notionReviewEnabled_() {
  if (typeof PropertiesService === 'undefined') return false;
  const props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('NOTION_TOKEN') && props.getProperty('BO_NOTION_PRODUCT_DATA_SOURCE_ID') &&
    (props.getProperty('BO_NOTION_BRAND_DATA_SOURCE_ID') || props.getProperty('NOTION_DATA_SOURCE_ID')));
}

function notionReviewConfig_() {
  const props = PropertiesService.getScriptProperties();
  const product = String(props.getProperty('BO_NOTION_PRODUCT_DATA_SOURCE_ID') || '').trim();
  const brand = String(props.getProperty('BO_NOTION_BRAND_DATA_SOURCE_ID') || props.getProperty('NOTION_DATA_SOURCE_ID') || '').trim();
  if (!product || !brand) throw new Error('Notion 검수 연결이 설정되지 않았습니다. 상품·브랜드 데이터 소스 ID를 설정해 주세요.');
  if (!props.getProperty('NOTION_TOKEN')) throw new Error('Notion 연결 토큰이 설정되지 않았습니다.');
  return {product: product, brand: brand};
}

function notionReviewSchema_(sourceId, kind) {
  if (BO_REVIEW_SCHEMA_CACHE[sourceId]) return BO_REVIEW_SCHEMA_CACHE[sourceId];
  const response = notionRequest_('get', '/data_sources/' + encodeURIComponent(sourceId));
  const properties = response.properties || {};
  const store = PropertiesService.getScriptProperties();
  let saved = {};
  try { saved = JSON.parse(store.getProperty('BO_NOTION_REVIEW_PROPERTY_IDS') || '{}'); } catch (ignored) {}
  const sourceMap = saved[sourceId] || {}, output = {};
  let changed = false;
  Object.keys(BO_REVIEW_SCHEMA[kind]).forEach(function(key) {
    const spec = BO_REVIEW_SCHEMA[kind][key];
    let found = Object.keys(properties).map(function(name) { return properties[name]; })
      .find(function(property) { return sourceMap[key] && property.id === sourceMap[key]; });
    if (!found) found = properties[spec[0]];
    if (!found || found.type !== spec[1]) throw new Error('Notion 필수 속성을 찾을 수 없거나 형식이 바뀌었습니다: ' + spec[0]);
    output[key] = found.id;
    if (sourceMap[key] !== found.id) changed = true;
  });
  if (changed) {
    saved[sourceId] = Object.assign({}, sourceMap, output);
    store.setProperty('BO_NOTION_REVIEW_PROPERTY_IDS', JSON.stringify(saved));
  }
  BO_REVIEW_SCHEMA_CACHE[sourceId] = output;
  return output;
}

function notionRichText_(value) {
  const text = String(value == null ? '' : value).trim();
  const items = [];
  for (let offset = 0; offset < text.length && items.length < 50; offset += 2000) {
    items.push({type:'text',text:{content:text.slice(offset, offset + 2000)}});
  }
  return {rich_text:items};
}

function notionPageProperty_(page, id) {
  return Object.keys(page.properties || {}).map(function(name) { return page.properties[name]; })
    .find(function(property) { return property.id === id; }) || null;
}

function notionProductById_(sourceId, schema, productId) {
  const response = notionRequest_('post', '/data_sources/' + encodeURIComponent(sourceId) + '/query', {
    filter:{property:schema.productId, rich_text:{equals:productId}}, page_size:3
  });
  const found = response.results || [];
  if (found.length > 1) throw new Error('Notion에 같은 운영센터 상품 ID가 여러 개 있습니다: ' + productId);
  return found[0] || null;
}

function notionLegacyPage_(productId, brandCode) {
  const item = listProducts_({brandCode:brandCode}).find(function(row) { return row.productId === productId; });
  const match = item && String(item.sourceUrl || '').match(/[0-9a-f]{32}/i);
  return match ? match[0] : '';
}

function notionProductProps_(schema, productId, data, brandPageId, status, full) {
  const out = {};
  out[schema.productId] = notionRichText_(productId);
  out[schema.name] = {title:[{type:'text',text:{content:String(data.product_name || '상품명 확인 필요').slice(0, 2000)}}]};
  out[schema.review] = {select:{name:status}};
  if (brandPageId) out[schema.brand] = {relation:[{id:brandPageId}]};
  if (!full) return out;
  out[schema.thumbnail] = {url: String(data.main_image_url || '') || null};
  out[schema.detail] = {url: String(data.detail_page_url || '') || null};
  out[schema.barcode] = notionRichText_(data.barcode);
  out[schema.option] = notionRichText_(data.option_name);
  out[schema.description] = notionRichText_(data.description);
  const retail = Number(data.retail_price);
  const purchase = Number(data.purchase_price);
  out[schema.retail] = {number: isFinite(retail) && String(data.retail_price || '').trim() ? retail : null};
  out[schema.purchase] = {number: isFinite(purchase) && String(data.purchase_price || '').trim() ? purchase : null};
  if (data.reference_url) out[schema.reference] = {url:String(data.reference_url)};
  return out;
}

function stageNewProductInNotion_(submission) {
  const config = notionReviewConfig_();
  const schema = notionReviewSchema_(config.product, 'product');
  const productId = String(submission['상품ID']);
  const existing = notionProductById_(config.product, schema, productId);
  if (existing) {
    const properties = {};
    properties[schema.review] = {select:{name:'검수 대기'}};
    notionRequest_('patch', '/pages/' + existing.id, {properties:properties});
    return existing.id;
  }
  const brand = findBrandByCode_(submission['브랜드코드']);
  const brandPageId = brandValue_(brand, '노션페이지ID');
  if (!brandPageId) throw new Error('브랜드의 Notion 페이지 연결이 없어 상품을 접수할 수 없습니다.');
  const data = JSON.parse(submission['상품데이터JSON'] || '{}');
  const created = notionRequest_('post', '/pages', {
    parent:{type:'data_source_id',data_source_id:config.product},
    properties:notionProductProps_(schema, productId, data, brandPageId, '검수 대기', false)
  });
  return created.id;
}

function approveProductInNotion_(submission) {
  const config = notionReviewConfig_();
  const schema = notionReviewSchema_(config.product, 'product');
  const productId = String(submission['상품ID']);
  const data = JSON.parse(submission['상품데이터JSON'] || '{}');
  const brand = findBrandByCode_(submission['브랜드코드']);
  const brandPageId = brandValue_(brand, '노션페이지ID');
  if (!brandPageId) throw new Error('브랜드의 Notion 페이지 연결이 없습니다.');
  let page = notionProductById_(config.product, schema, productId);
  if (!page) {
    const legacyId = notionLegacyPage_(productId, submission['브랜드코드']);
    if (legacyId) page = notionRequest_('get', '/pages/' + legacyId);
  }
  const properties = notionProductProps_(schema, productId, data, brandPageId, '승인 완료', true);
  if (!page) {
    if (data._change_request) throw new Error('기존 상품의 Notion 연결을 찾을 수 없어 변경 승인을 중단했습니다.');
    page = notionRequest_('post', '/pages', {parent:{type:'data_source_id',data_source_id:config.product},properties:properties});
  } else {
    const existingRelation = notionPageProperty_(page, schema.brand);
    const relationIds = existingRelation && existingRelation.relation ? existingRelation.relation.map(function(x) { return x.id; }) : [];
    if (relationIds.length && relationIds.indexOf(brandPageId) < 0) throw new Error('Notion 상품의 브랜드가 제출 브랜드와 다릅니다.');
    page = notionRequest_('patch', '/pages/' + page.id, {properties:properties});
  }
  const verified = notionRequest_('get', '/pages/' + page.id);
  const state = notionPageProperty_(verified, schema.review);
  if (!state || !state.select || state.select.name !== '승인 완료') throw new Error('Notion 승인 반영을 확인하지 못했습니다.');
  return {pageId:page.id,url:verified.url};
}

function markNewProductReviewInNotion_(submission, status) {
  const data = JSON.parse(submission['상품데이터JSON'] || '{}');
  if (data._change_request) return;
  const config = notionReviewConfig_();
  const schema = notionReviewSchema_(config.product, 'product');
  const page = notionProductById_(config.product, schema, String(submission['상품ID']));
  if (!page) throw new Error('검수 중인 Notion 상품을 찾을 수 없습니다.');
  const properties = {};
  properties[schema.review] = {select:{name:status === BOPS.STATUS.REVISION ? '보완 필요' : '반려'}};
  notionRequest_('patch', '/pages/' + page.id, {properties:properties});
}

function reviewBrandDocument_(payload) {
  payload = payload || {};
  return withLock_(function() {
    const row = findOne_(BOPS.SHEETS.FILES, '파일ID', payload.fileId);
    if (!row || row['상품ID']) throw new Error('브랜드 자료를 찾을 수 없습니다.');
    const status = row['상태'];
    if (status === '승인 완료' && payload.action === 'approve') return {ok:true,status:status};
    if (!['검수 대기','수령 완료','보완 필요'].includes(status)) throw new Error('이미 처리된 자료입니다.');
    const action = String(payload.action || '');
    if (!['approve','revision','reject'].includes(action)) throw new Error('검수 작업을 확인해 주세요.');
    const note = String(payload.note || '').trim();
    if (action !== 'approve' && !note) throw new Error('보완·반려 사유를 입력해 주세요.');
    const nextStatus = action === 'approve' ? '승인 완료' : action === 'revision' ? '보완 필요' : '반려';
    if (action === 'approve') {
      const config = notionReviewConfig_();
      const schema = notionReviewSchema_(config.brand, 'brand');
      const key = {'사업자등록증':'business','브랜드 소개서':'introduction','계약서':'contract','기타 브랜드 자료':'other'}[row['분류']];
      if (!key) throw new Error('Notion 속성에 연결되지 않은 자료 분류입니다.');
      const brand = findBrandByCode_(row['브랜드코드']);
      const brandPageId = brandValue_(brand, '노션페이지ID');
      if (!brandPageId) throw new Error('브랜드의 Notion 페이지 연결이 없습니다.');
      const url = String(row['DriveURL'] || '');
      if (!/^https:\/\/drive\.google\.com\//.test(url)) throw new Error('Google Drive 자료 링크를 확인해 주세요.');
      const properties = {};
      properties[schema[key]] = {url:url};
      notionRequest_('patch', '/pages/' + brandPageId, {properties:properties});
      const verified = notionRequest_('get', '/pages/' + brandPageId);
      const value = notionPageProperty_(verified, schema[key]);
      if (!value || value.url !== url) throw new Error('Notion 자료 링크 반영을 확인하지 못했습니다.');
    }
    ensureFileReviewColumns_();
    updateObjectRow_(BOPS.SHEETS.FILES, row._row, {'상태':nextStatus,'검수메모':note,'검수일':now_()});
    logAction_('브랜드 자료 ' + nextStatus, '파일', payload.fileId, note);
    return {ok:true,status:nextStatus};
  });
}

function ensureFileReviewColumns_() {
  const sheet = getSheet_(BOPS.SHEETS.FILES);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  ['검수메모','검수일'].forEach(function(name) {
    if (headers.indexOf(name) >= 0) return;
    sheet.getRange(1, headers.length + 1).setValue(name);
    headers.push(name);
  });
  BO_READ_VALUES_CACHE_ = null;
}

function notionReviewText_(property) {
  if (!property) return '';
  if (property.type === 'title' || property.type === 'rich_text') return (property[property.type] || []).map(function(item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
  if (property.type === 'number') return property.number == null ? '' : String(property.number);
  if (property.type === 'url') return property.url || '';
  if (property.type === 'select') return property.select ? property.select.name : '';
  if (property.type === 'multi_select') return (property.multi_select || []).map(function(item) { return item.name; }).join(', ');
  if (property.type === 'relation') return (property.relation || []).map(function(item) { return item.id; }).join(', ');
  if (property.type === 'date') return property.date ? property.date.start : '';
  if (property.type === 'checkbox') return property.checkbox ? '예' : '아니오';
  if (property.type === 'email') return property.email || '';
  if (property.type === 'phone_number') return property.phone_number || '';
  if (property.type === 'files') return (property.files || []).map(function(item) { return item.name || (item.file && item.file.url) || ''; }).join(', ');
  return '';
}

function listNotionProducts_() {
  const config = notionReviewConfig_();
  const schema = notionReviewSchema_(config.product, 'product');
  const pages = queryAllDataSourcePages_(config.product);
  return pages.map(function(page) {
    const props = page.properties || {};
    const byId = function(id) { return notionPageProperty_(page, id); };
    return {
      pageId:page.id, url:page.url, productId:notionReviewText_(byId(schema.productId)) || page.id,
      name:notionReviewText_(byId(schema.name)), barcode:notionReviewText_(byId(schema.barcode)),
      reviewStatus:notionReviewText_(byId(schema.review)), thumbnail:notionReviewText_(byId(schema.thumbnail)),
      detail:notionReviewText_(byId(schema.detail)), brandPageId:notionReviewText_(byId(schema.brand)),
      propertyCount:Object.keys(props).length
    };
  });
}

function getNotionProductDetail(request) {
  assertAdmin_();
  const config = notionReviewConfig_();
  const pageId = String(request && request.pageId || '');
  if (!/^[0-9a-f-]{32,36}$/i.test(pageId)) throw new Error('Notion 상품 페이지 ID가 올바르지 않습니다.');
  const page = notionRequest_('get', '/pages/' + pageId);
  const parentId = page.parent && (page.parent.data_source_id || page.parent.database_id);
  if (parentId !== config.product) throw new Error('연결된 상품 데이터베이스의 페이지가 아닙니다.');
  const source = notionRequest_('get', '/data_sources/' + encodeURIComponent(config.product));
  const reviewSchema = notionReviewSchema_(config.product, 'product');
  const protectedIds = [reviewSchema.productId, reviewSchema.review, reviewSchema.brand];
  const properties = Object.keys(page.properties || {}).map(function(name) {
    const item = page.properties[name];
    const definition = Object.keys(source.properties || {}).map(function(key) { return source.properties[key]; })
      .find(function(property) { return property.id === item.id; });
    return {id:item.id,name:name,type:item.type,value:notionReviewText_(item),
      editable:!!(definition && notionProductEditableTypes_()[item.type] && protectedIds.indexOf(item.id) < 0),
      options:definition && definition[item.type] && definition[item.type].options ?
        definition[item.type].options.map(function(option) { return option.name; }) : []};
  });
  const blocks = notionReviewBlocks_(pageId, 0);
  return {ok:true,pageId:page.id,url:page.url,lastEditedAt:page.last_edited_time || '',properties:properties,blocks:blocks};
}

function notionBrandPage_(brandCode) {
  const brand = findBrandByCode_(String(brandCode || ''));
  const legacy = crmAllBrands_().find(function(row) { return row['브랜드ID'] === brandCode; });
  const pageId = String(brandValue_(brand, '노션페이지ID') || crmId_(legacy && legacy['원본URL']) || '');
  if (!/^[0-9a-f-]{32,36}$/i.test(pageId)) throw new Error('브랜드의 Notion 원본 페이지 연결을 확인해 주세요.');
  const page = notionRequest_('get', '/pages/' + pageId);
  if ((page.parent && (page.parent.data_source_id || page.parent.database_id)) !== notionReviewConfig_().brand)
    throw new Error('연결된 브랜드 데이터베이스의 페이지가 아닙니다.');
  return page;
}

function getNotionBrandDetail(request) {
  assertAdmin_();
  const page = notionBrandPage_(request && request.brandCode);
  const config = notionReviewConfig_();
  const source = notionRequest_('get', '/data_sources/' + encodeURIComponent(config.brand));
  const reviewSchema = notionReviewSchema_(config.brand, 'brand');
  const protectedIds = Object.keys(reviewSchema).map(function(key) { return reviewSchema[key]; });
  protectedIds.push(notionBrandDisplayIds_()['브랜드ID']);
  const definitions = Object.keys(source.properties || {}).map(function(name) { return source.properties[name]; });
  const properties = Object.keys(page.properties || {}).map(function(name) {
    const item = page.properties[name];
    const definition = definitions.find(function(property) { return property.id === item.id; });
    return {id:item.id,name:name,type:item.type,value:notionReviewText_(item),
      editable:!!(definition && notionProductEditableTypes_()[item.type] && protectedIds.indexOf(item.id) < 0),
      options:definition && definition[item.type] && definition[item.type].options ?
        definition[item.type].options.map(function(option) { return option.name; }) : []};
  });
  return {ok:true,pageId:page.id,url:page.url,lastEditedAt:page.last_edited_time || '',properties:properties,
    blocks:notionReviewBlocks_(page.id, 0)};
}

function updateNotionBrand_(request) {
  assertAdmin_();
  request = request || {};
  const page = notionBrandPage_(request.brandCode);
  if (page.id !== request.pageId) throw new Error('브랜드 원본 페이지가 바뀌었습니다. 다시 열어 확인해 주세요.');
  if (!request.lastEditedAt || page.last_edited_time !== request.lastEditedAt)
    throw new Error('Notion 원본이 수정되었습니다. 화면을 다시 열고 변경 내용을 확인해 주세요.');
  const changes = request.changes || [];
  if (!Array.isArray(changes) || changes.length > 40) throw new Error('수정할 속성 목록을 확인해 주세요.');
  if (!changes.length) return {ok:true,changed:false};
  const config = notionReviewConfig_();
  const source = notionRequest_('get', '/data_sources/' + encodeURIComponent(config.brand));
  const reviewSchema = notionReviewSchema_(config.brand, 'brand');
  const protectedIds = Object.keys(reviewSchema).map(function(key) { return reviewSchema[key]; });
  protectedIds.push(notionBrandDisplayIds_()['브랜드ID']);
  const definitions = Object.keys(source.properties || {}).map(function(name) { return source.properties[name]; });
  const patch = {}, expected = {}, seen = {};
  changes.forEach(function(change) {
    const id = String(change && change.id || '');
    const definition = definitions.find(function(item) { return item.id === id; });
    if (!definition || seen[id] || protectedIds.indexOf(id) >= 0 || !notionProductEditableTypes_()[definition.type])
      throw new Error('수정할 수 없는 Notion 브랜드 속성이 포함되어 있습니다.');
    seen[id] = true;
    patch[id] = notionProductPatchValue_(definition, change.value, []);
    expected[id] = change.value;
  });
  notionRequest_('patch', '/pages/' + page.id, {properties:patch});
  const verified = notionRequest_('get', '/pages/' + page.id);
  Object.keys(expected).forEach(function(id) {
    const value = expected[id];
    const normalized = Array.isArray(value) ? value.map(function(item) { return String(item).trim(); })
      .filter(Boolean).filter(function(item,index,array) { return array.indexOf(item) === index; }).join(', ') :
      typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value == null ? '' : value).trim();
    if (notionReviewText_(notionPageProperty_(verified, id)) !== normalized)
      throw new Error('Notion 브랜드 속성 반영을 확인하지 못했습니다. 화면을 다시 열어 확인해 주세요.');
  });
  logAction_('Notion 브랜드 정보 수정', '브랜드', request.brandCode, Object.keys(expected).join(', '));
  return {ok:true,changed:true,lastEditedAt:verified.last_edited_time || ''};
}

function notionProductEditableTypes_() {
  return {title:true,rich_text:true,number:true,url:true,select:true,multi_select:true,
    checkbox:true,date:true,email:true,phone_number:true};
}

function notionProductPatchValue_(definition, value, protectedDriveIds) {
  const type = definition.type;
  const text = String(value == null ? '' : value).trim();
  if (type === 'title') {
    if (!text || text.length > 2000) throw new Error(definition.name + ': 제목은 1~2000자로 입력해 주세요.');
    return {title:[{type:'text',text:{content:text}}]};
  }
  if (type === 'rich_text') {
    if (text.length > 100000) throw new Error(definition.name + ': 내용은 100000자 이내로 입력해 주세요.');
    return notionRichText_(text);
  }
  if (type === 'number') {
    const number = Number(text);
    if (text && !isFinite(number)) throw new Error(definition.name + ': 숫자를 입력해 주세요.');
    return {number:text ? number : null};
  }
  if (type === 'url') {
    if (text && !/^https?:\/\//i.test(text)) throw new Error(definition.name + ': 올바른 URL을 입력해 주세요.');
    if (text && protectedDriveIds.indexOf(definition.id) >= 0 && !/^https:\/\/drive\.google\.com\//i.test(text))
      throw new Error(definition.name + ': Google Drive 공유 링크를 입력해 주세요.');
    return {url:text || null};
  }
  if (type === 'select') {
    const options = (definition.select && definition.select.options || []).map(function(option) { return option.name; });
    if (text && options.indexOf(text) < 0) throw new Error(definition.name + ': 등록된 선택지에서 골라 주세요.');
    return {select:text ? {name:text} : null};
  }
  if (type === 'multi_select') {
    const values = Array.isArray(value) ? value.map(function(item) { return String(item).trim(); }).filter(Boolean) :
      text.split(',').map(function(item) { return item.trim(); }).filter(Boolean);
    const options = (definition.multi_select && definition.multi_select.options || []).map(function(option) { return option.name; });
    if (values.length > 100 || values.some(function(item) { return options.indexOf(item) < 0; }))
      throw new Error(definition.name + ': 등록된 선택지만 입력해 주세요.');
    return {multi_select:values.filter(function(item,index) { return values.indexOf(item) === index; })
      .map(function(item) { return {name:item}; })};
  }
  if (type === 'checkbox') return {checkbox:value === true || String(value).toLowerCase() === 'true'};
  if (type === 'date') {
    if (text && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text)) throw new Error(definition.name + ': 날짜 형식을 확인해 주세요.');
    return {date:text ? {start:text} : null};
  }
  if (type === 'email') {
    if (text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new Error(definition.name + ': 이메일 형식을 확인해 주세요.');
    return {email:text || null};
  }
  if (type === 'phone_number') return {phone_number:text || null};
  throw new Error(definition.name + ': 운영센터에서 수정할 수 없는 Notion 속성입니다.');
}

function updateNotionProduct_(request) {
  assertAdmin_();
  request = request || {};
  const config = notionReviewConfig_();
  const pageId = String(request.pageId || '');
  if (!/^[0-9a-f-]{32,36}$/i.test(pageId)) throw new Error('Notion 상품 페이지 ID가 올바르지 않습니다.');
  const changes = request.changes || [];
  if (!Array.isArray(changes) || changes.length > 40) throw new Error('수정할 속성 목록을 확인해 주세요.');
  if (!changes.length) return {ok:true,changed:false};
  const page = notionRequest_('get', '/pages/' + pageId);
  const parentId = page.parent && (page.parent.data_source_id || page.parent.database_id);
  if (parentId !== config.product) throw new Error('연결된 상품 데이터베이스의 페이지가 아닙니다.');
  if (!request.lastEditedAt || page.last_edited_time !== request.lastEditedAt)
    throw new Error('Notion 원본이 수정되었습니다. 화면을 다시 열고 변경 내용을 확인해 주세요.');
  const source = notionRequest_('get', '/data_sources/' + encodeURIComponent(config.product));
  const schema = notionReviewSchema_(config.product, 'product');
  const protectedIds = [schema.productId, schema.review, schema.brand];
  const driveIds = [schema.thumbnail, schema.detail];
  const definitions = Object.keys(source.properties || {}).map(function(name) { return source.properties[name]; });
  const patch = {}, expected = {}, seen = {};
  changes.forEach(function(change) {
    const id = String(change && change.id || '');
    const definition = definitions.find(function(item) { return item.id === id; });
    if (!definition || seen[id] || protectedIds.indexOf(id) >= 0 || !notionProductEditableTypes_()[definition.type])
      throw new Error('수정할 수 없는 Notion 속성이 포함되어 있습니다.');
    seen[id] = true;
    patch[id] = notionProductPatchValue_(definition, change.value, driveIds);
    expected[id] = change.value;
  });
  notionRequest_('patch', '/pages/' + pageId, {properties:patch});
  const verified = notionRequest_('get', '/pages/' + pageId);
  Object.keys(expected).forEach(function(id) {
    const actual = notionPageProperty_(verified, id);
    const value = expected[id];
    const normalized = Array.isArray(value) ? value.map(function(item) { return String(item).trim(); })
      .filter(Boolean).filter(function(item,index,array) { return array.indexOf(item) === index; }).join(', ') :
      typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value == null ? '' : value).trim();
    if (!actual || notionReviewText_(actual) !== normalized)
      throw new Error('Notion 속성 반영을 확인하지 못했습니다. 화면을 다시 열어 확인해 주세요.');
  });
  logAction_('Notion 상품 정보 수정', '상품', pageId, Object.keys(expected).join(', '));
  return {ok:true,changed:true,lastEditedAt:verified.last_edited_time || ''};
}

function notionReviewBlocks_(parentId, depth) {
  if (depth > 3) return [];
  const out = [];
  let cursor = '';
  do {
    const path = '/blocks/' + parentId + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    const response = notionRequest_('get', path);
    (response.results || []).forEach(function(block) {
      const data = block[block.type] || {};
      const text = (data.rich_text || []).map(function(item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
      const url = data.external && data.external.url || data.file && data.file.url || data.url || '';
      out.push({type:block.type,text:text,url:url,children:block.has_children ? notionReviewBlocks_(block.id, depth + 1) : []});
    });
    cursor = response.has_more ? response.next_cursor : '';
  } while (cursor && out.length < 500);
  return out;
}
