const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'BO_NotionReview.gs'), 'utf8');
const props = {
  NOTION_TOKEN: 'mock',
  BO_NOTION_PRODUCT_DATA_SOURCE_ID: 'product-source',
  BO_NOTION_BRAND_DATA_SOURCE_ID: 'brand-source'
};
const schemas = {};
const pages = {};
const calls = [];
const fileRows = [];
let brandPageId = 'brand-page';
const ctx = vm.createContext({
  console,
  Utilities:{base64EncodeWebSafe:s=>Buffer.from(s).toString('base64url'),newBlob:s=>({getBytes:()=>Buffer.from(s)})},
  DriveApp:{getFileById:id=>({getParents:()=>({hasNext:()=>true,next:()=>({getUrl:()=> 'https://drive.google.com/drive/folders/'+id+'-folder'})})})},
  PropertiesService: {getScriptProperties: () => ({getProperty:key=>props[key]||'',setProperty:(key,value)=>{props[key]=value}})},
  BOPS: {SHEETS:{FILES:'files'},STATUS:{REVISION:'보완 필요'}},
  withLock_: fn=>fn(),
  findOne_: (name,key,value)=>fileRows.find(row=>row[key]===value),
  findBrandByCode_: ()=>({'노션페이지ID':brandPageId}),
  brandValue_: (row,key)=>key==='노션페이지ID'?row['노션페이지ID']:'',
  crmAllBrands_: ()=>[{'브랜드ID':'BRAND-1','브랜드명':'시트의 오래된 이름','원본URL':''}],
  queryAllDataSourcePages_: ()=>Object.values(pages).filter(page=>page.parent?.data_source_id==='brand-source'),
  listProducts_: ()=>[],
  listLegacyProducts_: ()=>[],
  getSheet_: ()=>({getLastColumn:()=>11,getRange:()=>({getDisplayValues:()=>[['파일ID','브랜드코드','상품ID','분류','파일명','Drive파일ID','DriveURL','업로드일','상태','검수메모','검수일']]})}),
  updateObjectRow_: (name,index,patch)=>Object.assign(fileRows[index-2],patch),
  now_: ()=>'today',
  logAction_: ()=>{},
  BO_READ_VALUES_CACHE_: null,
  assertAdmin_: ()=>{},
  notionRequest_: (method, endpoint, body)=>{
    calls.push({method,endpoint,body});
    if(method==='get'&&endpoint.startsWith('/data_sources/'))return {properties:schemas[endpoint.split('/').pop()]};
    if(method==='post'&&endpoint.includes('/query'))return {results:Object.values(pages).filter(p=>{
      const first=p.properties[body.filter.property]?.rich_text?.[0];
      return (first?.plain_text||first?.text?.content)===body.filter.rich_text.equals;
    })};
    if(method==='post'&&endpoint==='/pages'){
      const id='product-page';pages[id]={id,url:'https://notion.so/product-page',properties:Object.fromEntries(Object.entries(body.properties).map(([key,value])=>[key,{id:key,type:Object.keys(value)[0],...value}]))};return pages[id];
    }
    if(method==='patch'&&endpoint.startsWith('/pages/')){
      const id=endpoint.split('/').pop();pages[id] ||= {id,properties:{}};
      Object.entries(body.properties).forEach(([key,value])=>{
        Object.keys(pages[id].properties).forEach(name=>{if(pages[id].properties[name].id===key)delete pages[id].properties[name]});
        pages[id].properties[key]={id:key,type:Object.keys(value)[0],...value};
      });
      pages[id].last_edited_time='rev-2';
      return pages[id];
    }
    if(method==='get'&&endpoint.startsWith('/pages/'))return pages[endpoint.split('/').pop()];
    if(method==='get'&&endpoint.startsWith('/blocks/'))return {results:[],has_more:false};
    throw Error(method+' '+endpoint);
  }
});
for(const name of ['BO_NotionFields.gs','BO_NotionCatalog.gs'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..','src',name),'utf8'),ctx);
vm.runInContext(source, ctx);
for(const kind of ['product','brand']){
  const spec=vm.runInContext(`BO_REVIEW_SCHEMA.${kind}`,ctx);
  const entries=Object.entries(spec).map(([key,[name,type]])=>[name,{id:key,name,type}]);
  schemas[kind+'-source']=Object.fromEntries(entries);
}
const schema=ctx.notionReviewSchema_('product-source','product');
assert.equal(schema.thumbnail,'thumbnail');
schemas['product-source']['이름 변경된 대표 이미지 URL']=schemas['product-source']['대표 이미지 Drive URL'];
delete schemas['product-source']['대표 이미지 Drive URL'];
vm.runInContext('delete BO_REVIEW_SCHEMA_CACHE["product-source"]',ctx);
assert.equal(ctx.notionReviewSchema_('product-source','product').thumbnail,'thumbnail');
console.log('PASS property ID survives Notion property rename');

const row={'상품ID':'PRD-1','브랜드코드':'BRAND-1','상품데이터JSON':JSON.stringify({product_name:'테스트 세럼',barcode:'001234',main_image_url:'https://drive.google.com/file/d/thumb/view',detail_page_url:'https://drive.google.com/file/d/detail/view'})};
ctx.stageNewProductInNotion_(row);
assert.equal(pages['product-page'].properties.review.select.name,'검수 대기');
assert.equal(pages['product-page'].properties.thumbnail,undefined);
ctx.approveProductInNotion_(row);
assert.equal(pages['product-page'].properties.review.select.name,'승인 완료');
assert.equal(pages['product-page'].properties.barcode.rich_text[0].text.content,'001234');
assert.equal(pages['product-page'].properties.thumbnail.url,'https://drive.google.com/drive/folders/thumb-folder');
console.log('PASS new product stages before approval and Drive links publish after approval');

pages['brand-page']={id:'brand-page',properties:{}};
fileRows.push({_row:2,'파일ID':'FILE-1','브랜드코드':'BRAND-1','상품ID':'','분류':'사업자등록증','DriveURL':'https://drive.google.com/file/d/cert/view','상태':'검수 대기'});
ctx.reviewBrandDocument_({fileId:'FILE-1',action:'approve'});
assert.equal(pages['brand-page'].properties.business.url,'https://drive.google.com/file/d/cert/view');
assert.equal(fileRows[0]['상태'],'승인 완료');
console.log('PASS document approval verifies the Notion URL before marking approved');

const liveId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
pages[liveId]={id:liveId,url:'https://notion.so/'+liveId,parent:{data_source_id:'product-source'},last_edited_time:'rev-1',properties:{
  name:{id:'name',type:'title',title:[{plain_text:'기존 상품'}]},
  barcode:{id:'barcode',type:'rich_text',rich_text:[]},
  productId:{id:'productId',type:'rich_text',rich_text:[]},
  thumbnail:{id:'thumbnail',type:'url',url:null}
}};
const detail=ctx.getNotionProductDetail({pageId:liveId});
assert.equal(detail.lastEditedAt,'rev-1');
assert.equal(detail.properties.find(p=>p.id==='name').editable,true);
assert.equal(detail.properties.find(p=>p.id==='productId').editable,false);
ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-1',changes:[
  {id:'name',value:'수정된 상품'}, {id:'barcode',value:'001234'},
  {id:'thumbnail',value:'https://drive.google.com/drive/folders/image'}
]});
assert.equal(pages[liveId].properties.name.title[0].text.content,'수정된 상품');
assert.equal(pages[liveId].properties.barcode.rich_text[0].text.content,'001234');
assert.equal(pages[liveId].properties.thumbnail.url,'https://drive.google.com/drive/folders/image');
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-1',changes:[{id:'name',value:'덮어쓰기'}]}),/수정되었습니다/);
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-2',changes:[{id:'productId',value:'PRD-HIJACK'}]}),/수정할 수 없는/);
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-2',changes:[{id:'thumbnail',value:'https://example.com/image.jpg'}]}),/Google Drive/);
console.log('PASS internal product edits write Notion, verify results, and reject stale or protected changes');

brandPageId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
schemas['brand-source']['브랜드명']={id:'brandName',name:'브랜드명',type:'title'};
schemas['brand-source']['브랜드 ID']={id:'brandCode',name:'브랜드 ID',type:'rich_text'};
pages[brandPageId]={id:brandPageId,url:'https://notion.so/'+brandPageId,
  parent:{data_source_id:'brand-source'},last_edited_time:'rev-1',properties:{
    '브랜드명':{id:'brandName',type:'title',title:[{plain_text:'기존 브랜드'}]},
    '브랜드 ID':{id:'brandCode',type:'rich_text',rich_text:[{plain_text:'BRAND-1'}]},
    '사업자등록증 Drive URL':{id:'business',type:'url',url:null}
  }};
const brandDetail=ctx.getNotionBrandDetail({brandCode:'BRAND-1'});
assert.equal(brandDetail.properties.find(p=>p.id==='brandName').editable,true);
assert.equal(brandDetail.properties.find(p=>p.id==='business').editable,false);
assert.equal(brandDetail.properties.find(p=>p.id==='brandCode').editable,false);
schemas['brand-source']['바뀐 브랜드 제목']=schemas['brand-source']['브랜드명'];
delete schemas['brand-source']['브랜드명'];
vm.runInContext('delete BO_BRAND_DISPLAY_SCHEMA_CACHE["brand-source"]',ctx);
assert.equal(ctx.notionBrandDisplayIds_()['브랜드명'],'brandName');
ctx.updateNotionBrand_({brandCode:'BRAND-1',pageId:brandPageId,lastEditedAt:'rev-1',changes:[
  {id:'brandName',value:'수정된 브랜드'}
]});
assert.equal(pages[brandPageId].properties.brandName.title[0].text.content,'수정된 브랜드');
assert.throws(()=>ctx.updateNotionBrand_({brandCode:'BRAND-1',pageId:brandPageId,lastEditedAt:'rev-2',changes:[
  {id:'business',value:'https://drive.google.com/file/d/cert/view'}
]}),/수정할 수 없는/);
assert.throws(()=>ctx.updateNotionBrand_({brandCode:'BRAND-1',pageId:brandPageId,lastEditedAt:'rev-2',changes:[
  {id:'brandCode',value:'BRAND-2'}
]}),/수정할 수 없는/);
console.log('PASS internal brand edits write Notion and protected document links stay review-only');

const workspaceSource=fs.readFileSync(path.join(__dirname,'..','src','BO_BrandWorkspace.gs'),'utf8');
vm.runInContext(workspaceSource,ctx);
const sheetBrand={'브랜드ID':'BRAND-1','브랜드명':'시트의 오래된 이름','원본URL':'',
  '사내담당자':'내부 담당자','매입전환상태':'전환 확인 전'};
ctx.crmAllBrands_=()=>[sheetBrand];
const listed=ctx.crmLiveBrands_();
assert.equal(listed[0]['브랜드명'],'수정된 브랜드');
assert.equal(listed[0]['사내담당자'],'내부 담당자');
assert.equal(listed[0]._notionSource,'notion');
assert.equal(ctx.crmLiveBrand_('BRAND-1')['브랜드명'],'수정된 브랜드');
assert.equal(sheetBrand['브랜드명'],'시트의 오래된 이름');
console.log('PASS brand list and detail read Notion while internal workflow fields stay in Sheets');

// Live schema, ordering, folder and body regression coverage.
const baselineRequest=ctx.notionRequest_;
let viewOrder=['name','barcode','thumbnail'],bodyText='원래 본문',blockWrites=0;
ctx.notionRequest_=(method,endpoint,body)=>{
  if(method==='get'&&endpoint.startsWith('/views?'))return {results:[{id:'selected-view'}]};
  if(method==='get'&&endpoint==='/views/selected-view')return {data_source_id:'product-source',name:'상품 보기',configuration:{properties:viewOrder.map(property_id=>({property_id,visible:true}))}};
  if(method==='patch'&&endpoint==='/data_sources/product-source'){
    for(const [id,patch]of Object.entries(body.properties)){const d=Object.values(schemas['product-source']).find(d=>d.id===id);Object.assign(d,patch);}return {};
  }
  if(method==='get'&&endpoint.startsWith('/blocks/'+liveId+'/children'))return {results:[{id:'paragraph-1',type:'paragraph',paragraph:{rich_text:[{plain_text:bodyText}]}}],has_more:false};
  if(method==='patch'&&endpoint==='/blocks/paragraph-1'){blockWrites++;bodyText=body.paragraph.rich_text.map(t=>t.text.content).join('');return {paragraph:body.paragraph};}
  if(method==='patch'&&endpoint==='/blocks/'+liveId+'/children'){blockWrites++;return {results:body.children};}
  return baselineRequest(method,endpoint,body);
};
function clearForm(){vm.runInContext('delete BO_NOTION_FORM_CACHE["product-source"];delete BO_NOTION_ORDER_CACHE["product-source"];delete BO_NOTION_SOURCE_CACHE["product-source"]',ctx);}
schemas['product-source']['카테고리']={id:'category',type:'multi_select',multi_select:{options:[{id:'skin',name:'스킨케어',color:'green'}]}};
clearForm();
let form=ctx.notionProductFieldConfig_();
assert.deepEqual(Array.from(form.fields.slice(0,3),f=>f.propertyId),viewOrder);
const request={version:form.version,fields:form.fields.map(f=>({...f,required:f.id==='barcode'?false:f.required,options:f.id==='category'?'스킨케어|헤어':f.options,examples:f.id==='barcode'?'8801234567890':f.examples}))};
ctx.saveNotionFieldSettings_(request);
form=ctx.notionProductFieldConfig_();
assert.equal(form.fields.find(f=>f.id==='barcode').required,false);
assert.equal(form.fields.find(f=>f.id==='barcode').examples,'8801234567890');
assert.equal(form.fields.find(f=>f.id==='category').options,'스킨케어|헤어');
assert.throws(()=>ctx.saveNotionFieldSettings_(request),/변경되었습니다/);
assert.throws(()=>ctx.saveNotionFieldSettings_({version:form.version,fields:form.fields.map(f=>({...f,options:f.id==='category'?'헤어':f.options}))}),/삭제/);
viewOrder=['thumbnail','name','barcode'];clearForm();
assert.deepEqual(Array.from(ctx.getNotionProductDetail({pageId:liveId}).properties.slice(0,3),f=>f.id),viewOrder);
console.log('PASS live Notion order and choices, required rules, examples and stale settings guard');
assert.equal(ctx.notionAssetFolderUrl_('https://drive.google.com/drive/folders/existing'),'https://drive.google.com/drive/folders/existing');
assert.equal(ctx.notionAssetFolderUrl_('https://drive.google.com/file/d/thumb/view'),'https://drive.google.com/drive/folders/thumb-folder');
assert.equal(ctx.notionAssetFolderUrl_('https://example.com/file/d/thumb/view'),'');
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-2',changes:[{id:'thumbnail',value:'https://drive.google.com/file/d/image/view'}]}),/폴더/);
ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-2',changes:[],blockChanges:[{id:'paragraph-1',original:'원래 본문',text:'변경된 본문'}],appendText:'새 문단'});
assert.equal(bodyText,'변경된 본문');assert.equal(blockWrites,2);
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-2',changes:[{id:'name',value:'변경되면 안 됨'}],blockChanges:[{id:'paragraph-1',original:'원래 본문',text:'충돌'}]}),/본문이 수정/);
assert.equal(pages[liveId].properties.name.title[0].text.content,'수정된 상품');
assert.throws(()=>ctx.notionBodyPlan_(liveId,[{id:'other-page-block',original:'',text:'범위 초과'}]),/이 상품/);
console.log('PASS folder-only asset URLs, body editing and conflict/scope protection');
const latest=ctx.latestSubmissionRows_([
  {'브랜드코드':'B1','상품ID':'P1','제출ID':'v2','제출버전':2,'상태':'신규 제출'},
  {'브랜드코드':'B1','상품ID':'P1','제출ID':'v1','제출버전':1,'상태':'보완 필요'},
  {'브랜드코드':'B2','상품ID':'P1','제출ID':'other','제출버전':1,'상태':'보완 필요'}
]);
assert.equal(latest.length,2);assert.equal(latest.find(r=>r['브랜드코드']==='B1')['제출ID'],'v2');
console.log('PASS resubmissions replace stale revision counts and brands remain isolated');

pages[liveId].properties.thumbnail.url='https://drive.google.com/file/d/thumb/view';
let migration=ctx.normalizeNotionAssetFolders_({items:[{pageId:liveId,changes:[{id:'thumbnail',original:'https://drive.google.com/file/d/thumb/view',value:'https://drive.google.com/drive/folders/thumb-folder'}]}]});
assert.equal(migration.results[0].ok,true);assert.equal(pages[liveId].properties.thumbnail.url,'https://drive.google.com/drive/folders/thumb-folder');
migration=ctx.normalizeNotionAssetFolders_({items:[{pageId:liveId,changes:[{id:'thumbnail',original:'stale',value:'https://drive.google.com/drive/folders/other'}]}]});assert.equal(migration.results[0].ok,false);
assert.equal(pages[liveId].properties.thumbnail.url,'https://drive.google.com/drive/folders/thumb-folder');
assert.equal(ctx.notionProductPatchValue_({type:'number',name:'가격'},'19,000',[]).number,19000);
console.log('PASS folder migration checks original values and comma prices retain numeric meaning');
