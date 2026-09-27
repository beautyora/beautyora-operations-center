/** Notion owns catalog fields. Only form presentation rules live in Script Properties. */
const BO_NOTION_SOURCE_CACHE = {};
const BO_NOTION_FORM_CACHE = {};
const BO_NOTION_ORDER_CACHE = {};
const BO_PRODUCT_FIELD_ALIASES = Object.freeze({
  product_name:['상품명'], option_name:['옵션명'], barcode:['바코드(텍스트)'],
  category:['카테고리'], retail_price:['소비자가'], purchase_price:['매입가(매입 가능시)'],
  consignment_price:['공급가(위탁 가능시)'], offline_consignment_price:['오프라인 위탁 판매가'],
  online_lowest_price:['온라인 최저가'], moq:['MOQ'], description:['제품 설명'],
  reference_url:['참고 링크'], main_image_url:['대표 이미지 Drive URL'], detail_page_url:['상세페이지 Drive URL'],
  sales_channels:['노출 희망 채널'], oliveyoung_status:['올리브영 입점 상태'], oliveyoung_price:['올리브영 대비 낮은 가격 판매']
});

function notionSource_(id) {
  if (!BO_NOTION_SOURCE_CACHE[id]) BO_NOTION_SOURCE_CACHE[id] = notionRequest_('get', '/data_sources/' + encodeURIComponent(id));
  return BO_NOTION_SOURCE_CACHE[id];
}

function notionSameId_(a,b) { return String(a||'').replace(/-/g,'').toLowerCase() === String(b||'').replace(/-/g,'').toLowerCase(); }
function notionDefinitions_(source) {
  return Object.keys(source.properties || {}).map(function(name) { return Object.assign({}, source.properties[name], {name:name}); });
}

function notionOrderedDefinitions_(sourceId, kind) {
  if(BO_NOTION_ORDER_CACHE[sourceId])return BO_NOTION_ORDER_CACHE[sourceId];
  const source = notionSource_(sourceId), definitions = notionDefinitions_(source);
  const props = PropertiesService.getScriptProperties();
  const configured = props.getProperty('BO_NOTION_' + kind.toUpperCase() + '_VIEW_ID');
  // Existing production views. Other environments discover their own source's first view.
  const defaults = {'609882c5622d46d4b92e658946301ec9':'3de1223f-7bc1-8020-8cf8-000c065b0760',
    'ec80de8577c74e0fb0b07b7f607a424f':'3d61223f-7bc1-8088-a942-000c009752ca'};
  let viewId = configured || defaults[String(sourceId).replace(/-/g,'')], warning = '', view = null;
  try {
    if (!viewId) {
      const views = notionRequest_('get','/views?data_source_id='+encodeURIComponent(sourceId),null,'2026-03-11');
      viewId = (views.results||[])[0] && views.results[0].id;
    }
    if (viewId) {
      view = notionRequest_('get','/views/'+encodeURIComponent(viewId),null,'2026-03-11');
      if (!notionSameId_(view.data_source_id,sourceId)) throw Error('연결된 DB의 보기가 아닙니다.');
    }
  } catch (error) { warning = 'Notion 보기 순서를 읽지 못해 DB 속성 순서로 표시합니다.'; }
  const ordered = view && view.configuration && view.configuration.properties || [];
  const ranks = {}; ordered.forEach(function(item,index) { ranks[item.property_id] = index; });
  definitions.sort(function(a,b) { return (ranks[a.id] == null ? 10000 : ranks[a.id]) - (ranks[b.id] == null ? 10000 : ranks[b.id]); });
  return BO_NOTION_ORDER_CACHE[sourceId]={definitions:definitions,viewId:viewId||'',viewName:view&&view.name||'',orderWarning:warning};
}

function notionFormRules_(sourceId) {
  const store = PropertiesService.getScriptProperties();
  try { return JSON.parse(store.getProperty('BO_NOTION_FORM_'+sourceId) || '{}'); } catch (ignored) { return {}; }
}

function notionProductFieldConfig_() {
  const sourceId = notionReviewConfig_().product;
  if (BO_NOTION_FORM_CACHE[sourceId]) return BO_NOTION_FORM_CACHE[sourceId];
  const ordered = notionOrderedDefinitions_(sourceId,'product'), rules = notionFormRules_(sourceId);
  const bridge = notionReviewSchema_(sourceId,'product');
  const keys = {name:'product_name',option:'option_name',barcode:'barcode',retail:'retail_price',purchase:'purchase_price',
    description:'description',reference:'reference_url',thumbnail:'main_image_url',detail:'detail_page_url'};
  const reserved = [bridge.productId,bridge.review,bridge.brand];
  const store = PropertiesService.getScriptProperties();
  let saved = {}; try { saved=JSON.parse(store.getProperty('BO_NOTION_FIELD_IDS_'+sourceId)||'{}'); } catch (ignored) {}
  const mapping = Object.assign({},saved);
  const fields = ordered.definitions.filter(function(d) {
    return notionProductEditableTypes_()[d.type] && reserved.indexOf(d.id)<0;
  }).map(function(d,index) {
    let key = Object.keys(keys).find(function(k) { return bridge[k]===d.id; });
    let id = key ? keys[key] : Object.keys(mapping).find(function(k) { return mapping[k]===d.id; });
    if (!id) id = Object.keys(BO_PRODUCT_FIELD_ALIASES).find(function(k) { return BO_PRODUCT_FIELD_ALIASES[k].indexOf(d.name)>=0; });
    if (!id) id = 'notion_'+Utilities.base64EncodeWebSafe(d.id).replace(/=+$/,'');
    mapping[id] = d.id;
    const rule=rules[d.id]||{}, known=!!BO_PRODUCT_FIELD_ALIASES[id];
    const requiredDefault=['product_name','barcode','category','retail_price','main_image_url','detail_page_url'].indexOf(id)>=0;
    return {id:id,propertyId:d.id,label:d.name,notionType:d.type,
      type:d.type==='rich_text'?(['barcode','option_name'].indexOf(id)>=0?'text':'textarea'):d.type==='title'?'text':d.type,
      required:id==='product_name'||(rule.required==null?requiredDefault:rule.required===true),
      active:id==='product_name'||(rule.active==null?known:rule.active!==false),order:index+1,
      options:(d[d.type]&&d[d.type].options||[]).map(function(o){return o.name;}).join('|'),
      help:rule.help||d.description||'',examples:rule.examples||'',excel:true};
  });
  if (JSON.stringify(mapping)!==JSON.stringify(saved)) store.setProperty('BO_NOTION_FIELD_IDS_'+sourceId,JSON.stringify(mapping));
  const version=JSON.stringify(fields.map(function(f){return [f.propertyId,f.label,f.notionType,f.required,f.active,f.options,f.help,f.examples];}));
  return BO_NOTION_FORM_CACHE[sourceId]={fields:fields,version:version,viewId:ordered.viewId,viewName:ordered.viewName,orderWarning:ordered.orderWarning};
}

function getPartnerFieldSchema(request) {
  validatePartnerToken_(request && request.token);
  if (!notionReviewEnabled_()) return {ok:true,fields:getSettings_().fields,version:'legacy'};
  const config=notionProductFieldConfig_();
  return {ok:true,fields:config.fields.filter(function(f){return f.active;}),version:config.version};
}

function saveNotionFieldSettings_(request) {
  assertAdmin_();
  return withLock_(function() {
    const sourceId=notionReviewConfig_().product, config=notionProductFieldConfig_();
    if (request.version!==config.version) throw Error('Notion 속성이나 설정이 변경되었습니다. 다시 열어 확인해 주세요.');
    if (!Array.isArray(request.fields)||request.fields.length!==config.fields.length) throw Error('속성 설정 목록을 다시 불러와 주세요.');
    const rules={},seen={},patch={},definitions=notionDefinitions_(notionSource_(sourceId));
    request.fields.forEach(function(input) {
      const field=config.fields.find(function(f){return f.propertyId===input.propertyId;});
      if (!field||seen[field.propertyId]) throw Error('알 수 없거나 중복된 속성입니다.');
      seen[field.propertyId]=true;
      rules[field.propertyId]={active:field.id==='product_name'||input.active===true,
        required:field.id==='product_name'||input.required===true,help:String(input.help||'').slice(0,500),examples:String(input.examples||'').slice(0,500)};
      if (['select','multi_select'].indexOf(field.notionType)>=0) {
        const definition=definitions.find(function(d){return d.id===field.propertyId;}), old=definition[field.notionType].options||[];
        const choices=String(input.options||'').split('|').map(function(v){return v.trim();}).filter(Boolean);
        if (choices.length>100||choices.some(function(v){return v.length>100;})) throw Error(field.label+': 선택지를 확인해 주세요.');
        if (old.some(function(o){return choices.indexOf(o.name)<0;})) throw Error(field.label+': 사용 중인 선택지 삭제·이름 변경은 Notion에서 진행해 주세요.');
        if (choices.some(function(v){return !old.some(function(o){return o.name===v;});})) {
          const value={};value[field.notionType]={options:old.map(function(o){return {id:o.id,name:o.name,color:o.color};}).concat(choices.filter(function(v){return !old.some(function(o){return o.name===v;});}).map(function(v){return {name:v};}))};
          patch[field.propertyId]=value;
        }
      }
    });
    const json=JSON.stringify(rules);
    if (Utilities.newBlob(json).getBytes().length>8500) throw Error('예시·도움말이 너무 깁니다. 내용을 줄여 주세요.');
    if (Object.keys(patch).length) notionRequest_('patch','/data_sources/'+sourceId,{properties:patch});
    PropertiesService.getScriptProperties().setProperty('BO_NOTION_FORM_'+sourceId,json);
    delete BO_NOTION_FORM_CACHE[sourceId];delete BO_NOTION_SOURCE_CACHE[sourceId];delete BO_NOTION_ORDER_CACHE[sourceId];
    logAction_('Notion 상품 입력 설정','설정',sourceId,'필수·선택 및 선택지 저장');
    return {ok:true};
  });
}

function notionPartnerProperties_(data) {
  const config=notionProductFieldConfig_(), definitions=notionDefinitions_(notionSource_(notionReviewConfig_().product)), patch={};
  config.fields.filter(function(f){return f.active;}).forEach(function(f) {
    if (!Object.prototype.hasOwnProperty.call(data,f.id)) return;
    const d=definitions.find(function(d){return d.id===f.propertyId;});
    patch[f.propertyId]=notionProductPatchValue_(d,data[f.id],[]);
  });
  return patch;
}

/** Resolve a file link to its current parent without treating a folder as an image. */
function notionAssetFolderUrl_(url) {
  const text=String(url||'');
  if (!text) return '';
  if (/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/[\w-]+/.test(text)) return text;
  const id=(text.match(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/)||text.match(/^https:\/\/drive\.google\.com\/[^?]*\?[^#]*\bid=([\w-]+)/)||[])[1];
  if (!id) return '';
  try { const parents=DriveApp.getFileById(id).getParents();return parents.hasNext()?parents.next().getUrl():''; } catch (ignored) {return '';}
}

function notionImageUrl_(page) {
  const props=page.properties||{};
  const images=Object.keys(props).map(function(k){return Object.assign({name:k},props[k]);}).filter(function(p){return p.type==='files';});
  for (let i=0;i<images.length;i++) {
    const file=(images[i].files||[]).find(function(f){return /\.(png|jpe?g|webp|gif)(?:$|\?)/i.test(f.name||'') || /이미지/.test(images[i].name||'');});
    if(file)return file.external&&file.external.url||file.file&&file.file.url||'';
  }
  return page.cover&&(page.cover.external&&page.cover.external.url||page.cover.file&&page.cover.file.url)||'';
}

function latestSubmissionRows_(rows) {
  const latest={};
  rows.forEach(function(row){
    const key=String(row['브랜드코드']||'')+'|'+String(row['상품ID']||row['제출ID']||'');
    const old=latest[key], version=Number(row['제출버전'])||0, oldVersion=old?Number(old['제출버전'])||0:-1;
    if (!old||version>oldVersion||(version===oldVersion&&String(row['제출일']||'')>=String(old['제출일']||'')))latest[key]=row;
  });
  return Object.keys(latest).map(function(k){return latest[k];});
}
