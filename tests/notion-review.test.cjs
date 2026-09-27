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
  PropertiesService: {getScriptProperties: () => ({getProperty:key=>props[key]||'',setProperty:(key,value)=>{props[key]=value}})},
  BOPS: {SHEETS:{FILES:'files'},STATUS:{REVISION:'보완 필요'}},
  withLock_: fn=>fn(),
  findOne_: (name,key,value)=>fileRows.find(row=>row[key]===value),
  findBrandByCode_: ()=>({'노션페이지ID':brandPageId}),
  brandValue_: (row,key)=>key==='노션페이지ID'?row['노션페이지ID']:'',
  listProducts_: ()=>[],
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
      const first=p.properties.pid?.rich_text?.[0];
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
assert.equal(pages['product-page'].properties.thumbnail.url,'https://drive.google.com/file/d/thumb/view');
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
  {id:'thumbnail',value:'https://drive.google.com/file/d/image/view'}
]});
assert.equal(pages[liveId].properties.name.title[0].text.content,'수정된 상품');
assert.equal(pages[liveId].properties.barcode.rich_text[0].text.content,'001234');
assert.equal(pages[liveId].properties.thumbnail.url,'https://drive.google.com/file/d/image/view');
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-1',changes:[{id:'name',value:'덮어쓰기'}]}),/수정되었습니다/);
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-2',changes:[{id:'productId',value:'PRD-HIJACK'}]}),/수정할 수 없는/);
assert.throws(()=>ctx.updateNotionProduct_({pageId:liveId,lastEditedAt:'rev-2',changes:[{id:'thumbnail',value:'https://example.com/image.jpg'}]}),/Google Drive/);
console.log('PASS internal product edits write Notion, verify results, and reject stale or protected changes');

brandPageId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
schemas['brand-source']['브랜드명']={id:'brandName',name:'브랜드명',type:'title'};
pages[brandPageId]={id:brandPageId,url:'https://notion.so/'+brandPageId,
  parent:{data_source_id:'brand-source'},last_edited_time:'rev-1',properties:{
    '브랜드명':{id:'brandName',type:'title',title:[{plain_text:'기존 브랜드'}]},
    '사업자등록증 Drive URL':{id:'business',type:'url',url:null}
  }};
const brandDetail=ctx.getNotionBrandDetail({brandCode:'BRAND-1'});
assert.equal(brandDetail.properties.find(p=>p.id==='brandName').editable,true);
assert.equal(brandDetail.properties.find(p=>p.id==='business').editable,false);
ctx.updateNotionBrand_({brandCode:'BRAND-1',pageId:brandPageId,lastEditedAt:'rev-1',changes:[
  {id:'brandName',value:'수정된 브랜드'}
]});
assert.equal(pages[brandPageId].properties.brandName.title[0].text.content,'수정된 브랜드');
assert.throws(()=>ctx.updateNotionBrand_({brandCode:'BRAND-1',pageId:brandPageId,lastEditedAt:'rev-2',changes:[
  {id:'business',value:'https://drive.google.com/file/d/cert/view'}
]}),/수정할 수 없는/);
console.log('PASS internal brand edits write Notion and protected document links stay review-only');
