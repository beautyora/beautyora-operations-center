/** Live projections for existing catalog consumers; never read cached sheet product values. */
const BO_LIVE_CATALOG_CACHE = {};
function notionCatalog_(params) {
  params=params||{};
  const config=notionReviewConfig_(), schema=notionReviewSchema_(config.product,'product');
  const fields=notionProductFieldConfig_().fields;
  const definitions=notionOrderedDefinitions_(config.product,'product').definitions;
  const brandIds=notionBrandDisplayIds_();
  if (!BO_LIVE_CATALOG_CACHE.brands) BO_LIVE_CATALOG_CACHE.brands=queryAllDataSourcePages_(config.brand).map(function(page){return notionBrandDisplayRow_(page,brandIds);});
  const brands=BO_LIVE_CATALOG_CACHE.brands, scope=String(params.brandCode||'');
  const brand=scope?brands.find(function(b){return b['브랜드ID']===scope;}):null;
  if(scope&&!brand)return [];
  const cacheKey='products:'+scope;
  if (!BO_LIVE_CATALOG_CACHE[cacheKey]) {
    let pages=[],cursor='';
    do {
      const body={page_size:100,sorts:[{timestamp:'created_time',direction:'descending'}]};
      if(cursor)body.start_cursor=cursor;
      if(brand)body.filter={property:schema.brand,relation:{contains:brand['노션페이지ID']}};
      const response=notionRequest_('post','/data_sources/'+config.product+'/query',body);
      pages=pages.concat(response.results||[]);cursor=response.has_more?response.next_cursor:'';
    }while(cursor);
    // Existing IDs are retained as storage keys so files, review history and inventory keep their links.
    const legacyByPage={};safeObjects_('상품').forEach(function(r){const key=String(r['원본URL']||'').replace(/-/g,'').match(/[a-f0-9]{32}/i);if(key)legacyByPage[key[0].toLowerCase()]=r['상품ID'];});
    const files=safeObjects_(BOPS.SHEETS.FILES);
    BO_LIVE_CATALOG_CACHE[cacheKey]=pages.filter(function(p){return !p.archived&&!p.in_trash;}).map(function(page) {
      const get=function(id){return notionReviewText_(notionPageProperty_(page,id));};
      const relation=notionPageProperty_(page,schema.brand), linked=(relation&&relation.relation||[]).map(function(r){return r.id;});
      const owner=brands.find(function(b){return linked.some(function(id){return notionSameId_(id,b['노션페이지ID']);});})||{};
      const productId=get(schema.productId)||legacyByPage[String(page.id).replace(/-/g,'').toLowerCase()]||page.id;
      const data={};fields.filter(function(f){return f.active;}).forEach(function(f){const p=notionPageProperty_(page,f.propertyId);data[f.id]=p&&p.type==='checkbox'?p.checkbox:get(f.propertyId);});
      const ownFiles=files.filter(function(f){return f['브랜드코드']===owner['브랜드ID']&&f['상품ID']===productId;});
      const latestImage=ownFiles.filter(function(f){return f['분류']==='대표 이미지';}).slice(-1)[0];
      const rawImage=get(schema.thumbnail), rawDetail=get(schema.detail);
      const image=rawImage&&!/\/folders\//.test(rawImage)?rawImage:notionImageUrl_(page)||(latestImage&&latestImage['DriveURL'])||'';
      // Partner response contains only explicitly enabled form fields.
      data.main_image_url=rawImage;data.detail_page_url=rawDetail;data.main_image_preview_url=image;
      data.product_id=productId;
      return {productId:productId,displayId:(get(schema.productId)||page.id).replace(/^PRD-/,''),pageId:page.id,sourceUrl:page.url,url:page.url,
        brandCode:owner['브랜드ID']||'',brandName:owner['브랜드명']||'',companyName:owner['회사명']||'',brandPageId:linked.join(', '),
        productName:get(schema.name),name:get(schema.name),optionName:get(schema.option),barcode:get(schema.barcode)||notionReviewText_(page.properties&&page.properties['바코드']),
        retailPrice:get(schema.retail),purchasePrice:get(schema.purchase),category:data.category||'',
        consignmentPrice:data.consignment_price||'',offlineConsignmentPrice:data.offline_consignment_price||'',moq:data.moq||'',
        onlineLowestPrice:data.online_lowest_price||'',productUrl:get(schema.reference),tradeType:'',status:'사용',
        reviewStatus:get(schema.review),mainImageUrl:image,thumbnail:rawImage,detail:rawDetail,
        mainImageFolderUrl:/\/folders\//.test(rawImage)?rawImage:'',detailPageUrl:rawDetail,
        properties:definitions.map(function(d){return {id:d.id,name:d.name,type:d.type,value:get(d.id)};}),
        approvedAt:page.last_edited_time||'',propertyCount:Object.keys(page.properties||{}).length,data:data};
    });
  }
  const q=String(params.query||'').toLowerCase();
  return BO_LIVE_CATALOG_CACHE[cacheKey].filter(function(p){return (!q||[p.productName,p.brandName,p.productId,p.barcode].join(' ').toLowerCase().includes(q))&&(!params.category||p.category===params.category);});
}

function notionBodyEditable_(type) {
  return ['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','to_do','toggle','quote','callout','code'].indexOf(type)>=0;
}

function notionBodyPlan_(pageId,changes) {
  if (!Array.isArray(changes)||changes.length>50)throw Error('본문 수정은 한 번에 50개 문단까지 가능합니다.');
  if(!changes.length)return [];
  const blocks=notionReviewBlocks_(pageId,0), byId={},seen={};
  function visit(items){items.forEach(function(b){byId[b.id]=b;visit(b.children||[]);});}visit(blocks);
  return changes.map(function(change){
    const block=byId[change.id],text=String(change.text==null?'':change.text);
    if(!block||!notionBodyEditable_(block.type)||seen[change.id])throw Error('이 상품의 수정 가능한 본문 블록인지 확인해 주세요.');
    if(block.text!==change.original)throw Error('Notion 본문이 수정되었습니다. 다시 열어 확인해 주세요.');
    if(text.length>100000)throw Error('문단은 100000자 이내로 입력해 주세요.');
    seen[change.id]=true;return {id:block.id,type:block.type,text:text};
  });
}

function notionSaveBody_(plan,pageId,appendText) {
  let saved=0;
  try {
    plan.forEach(function(change){
      const payload={};payload[change.type]=notionRichText_(change.text);
      const result=notionRequest_('patch','/blocks/'+change.id,payload);
      const actual=(result[change.type]&&result[change.type].rich_text||[]).map(function(t){return t.plain_text||(t.text&&t.text.content)||'';}).join('');
      if(actual!==change.text.trim())throw Error('본문 저장 결과를 확인하지 못했습니다.');
      saved++;
    });
    if(appendText)notionRequest_('patch','/blocks/'+pageId+'/children',{children:[{object:'block',type:'paragraph',paragraph:notionRichText_(appendText)}]});
  }catch(error){throw Error('본문 '+saved+'개 문단 저장 후 중단되었습니다. 다시 열어 저장된 내용을 확인해 주세요. '+error.message);}
}

function getNotionAssetMigration() {
  assertAdmin_();
  const schema=notionReviewSchema_(notionReviewConfig_().product,'product'),items=[],unresolved=[];
  notionCatalog_({}).forEach(function(p){
    const changes=[];
    [['thumbnail',p.thumbnail],['detail',p.detail]].forEach(function(pair){
      const value=pair[1];if(!value||/\/folders\//.test(value)||!schema[pair[0]])return;
      const folder=notionAssetFolderUrl_(value);
      if(folder)changes.push({id:schema[pair[0]],original:value,value:folder});else unresolved.push({name:p.name,field:pair[0]});
    });
    if(changes.length)items.push({pageId:p.pageId,name:p.name,changes:changes});
  });
  return {ok:true,items:items,unresolved:unresolved};
}
function normalizeNotionAssetFolders_(request) {
  assertAdmin_();
  return withLock_(function(){
    if(!Array.isArray(request.items)||request.items.length>5)throw Error('한 번에 상품 5개까지 전환할 수 있습니다.');
    const config=notionReviewConfig_(),schema=notionReviewSchema_(config.product,'product'),results=[];
    request.items.forEach(function(item){
      try{
        if(!/^[0-9a-f-]{32,36}$/i.test(item.pageId))throw Error('상품 ID 확인 필요');
        const page=notionRequest_('get','/pages/'+item.pageId);
        if(!notionSameId_(page.parent&&page.parent.data_source_id,config.product))throw Error('연결된 상품 DB가 아닙니다.');
        const patch={};
        (item.changes||[]).forEach(function(change){
          if([schema.thumbnail,schema.detail].indexOf(change.id)<0)throw Error('이미지·상세페이지 링크만 전환할 수 있습니다.');
          const raw=notionReviewText_(notionPageProperty_(page,change.id));
          if(raw===change.value)return;
          if(raw!==change.original)throw Error('원본 링크가 수정되었습니다. 다시 조회해 주세요.');
          const folder=notionAssetFolderUrl_(raw);
          if(!folder||folder!==change.value)throw Error('폴더 접근 권한을 확인해 주세요.');
          patch[change.id]={url:folder};
        });
        if(Object.keys(patch).length){const result=notionRequest_('patch','/pages/'+item.pageId,{properties:patch});Object.keys(patch).forEach(function(id){if(notionReviewText_(notionPageProperty_(result,id))!==patch[id].url)throw Error('저장 결과 확인 필요');});}
        results.push({pageId:item.pageId,ok:true});
      }catch(error){results.push({pageId:item.pageId,ok:false,message:error.message});}
    });
    logAction_('상품 자료 폴더 링크 전환','상품','',results.filter(function(r){return r.ok;}).length+'개 상품');
    return {ok:true,results:results};
  });
}
