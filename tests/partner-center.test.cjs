const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
function ui(server) {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, {innerHTML:'',textContent:'',querySelectorAll:()=>[],classList:{toggle(){}},setAttribute(){},remove(){}}); return elements.get(id); };
  const context = vm.createContext({console,crypto:{randomUUID:require('node:crypto').randomUUID},Map,Set,URL:{revokeObjectURL(){},createObjectURL:()=> 'blob:test'},window:{addEventListener(){},scrollTo(){}},document:{getElementById:element},localStorage:{setItem(){},getItem:()=>null},State:{token:'test-token',bootstrap:{brand:{brandName:'Test'},fields:[{id:'product_name',label:'상품명',required:true,type:'text',active:true},{id:'retail_price',label:'소비자가',required:true,type:'number',active:true}],submissions:[]}},$:element,$$:()=>[],esc:v=>String(v??''),UI:{toast(){},status:s=>s},renderPartner:()=>{},server,fileBase64:async()=> 'aGVsbG8='});
  const script = source('PartnerExperience.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script.replace('})();','globalThis.test={P,makeProduct,productIssues,submit,onAction,addFiles,uploadAll,catalogCards,catalogPanel,submissionsPanel,productList};})();'),context);
  context.test.P.draft={requestId:'request-original',products:[]};
  return context;
}
const plain = x => JSON.parse(JSON.stringify(x));
async function main(){
  let sent;
  const c=ui(async(name,r)=>{if(name==='submitPartnerDraft'){sent=plain(r);return {ok:true,count:r.products.length};}return {ok:true,...c.State.bootstrap};});
  const {P,makeProduct,productIssues}=c.test;
  const ready=makeProduct({product_name:'Ready',retail_price:20000});const incomplete=makeProduct({});P.draft.products=[ready,incomplete];P.selected.add(ready.id);P.screen='editor';P.step=2;
  await c.test.submit();
  assert.deepEqual(sent.products.map(p=>p.id),[ready.id]);assert.equal(P.draft.products.length,1);assert.equal(P.draft.products[0].id,incomplete.id);assert.notEqual(P.draft.requestId,'request-original');assert.equal(P.screen,'submissions');
  console.log('PASS selected submission preserves unfinished drafts');
  let attempts=[];const failure=ui(async(name,r)=>{if(name==='submitPartnerDraft'){attempts.push(r.requestId);throw Error('Network lost after server write');}return {ok:true};});
  const fp=failure.test.P,one=failure.test.makeProduct({product_name:'Retry',retail_price:1});fp.draft.products=[one];fp.selected.add(one.id);await failure.test.submit();await failure.test.submit();assert.deepEqual(attempts,['request-original','request-original']);assert.equal(fp.draft.products.length,1);assert.equal(fp.busy,false);
  console.log('PASS uncertain submission retries retain idempotency key and draft');
  P.draft.products=[incomplete];P.active=0;P.step=0;await c.test.onAction({target:{closest:()=>({dataset:{action:'next'}})}});assert.equal(P.step,0);assert.equal(P.validate,true);assert.equal(productIssues(incomplete).length,2);
  c.State.bootstrap.fields.push({id:'main_image_url',label:'대표 이미지',required:true,type:'url',active:true});assert.equal(productIssues(ready).find(e=>e.field==='main_image_url').step,1);
  const legacy={...ready,sourceSubmissionId:'MASTER-123',data:{...ready.data,main_image_url:'https://example.com/image'}};assert.equal(productIssues(legacy).length,0);
  console.log('PASS step validation and existing master image preservation');
  c.State.bootstrap.products=[{productId:'A',status:'승인 완료',data:{product_name:'로즈 세럼',option_name:'30ml',barcode:'ROSE-30'}},{productId:'B',status:'신규 제출',data:{product_name:'민트 크림',option_name:'50ml',barcode:'MINT-50'}}];
  c.State.bootstrap.submissions=[{submissionId:'SUB-B',productId:'B',status:'신규 제출',data:{product_name:'민트 크림'}}];
  assert.match(c.test.catalogPanel(),/내 상품 검색/);assert.match(c.test.submissionsPanel(),/제출 현황/);
  P.productQuery='ROSE-30';assert.match(c.test.productList(),/로즈 세럼/);assert.doesNotMatch(c.test.productList(),/민트 크림/);
  P.productQuery='';P.productStatus='review';assert.match(c.test.productList(),/민트 크림/);assert.doesNotMatch(c.test.productList(),/로즈 세럼/);
  assert.doesNotMatch(c.test.catalogCards(),/로즈 세럼/);
  console.log('PASS product search and submission status are separate');
  const status={SUBMITTED:'신규 제출',REVIEWING:'검수 중',REVISION:'보완 필요',APPROVED:'승인 완료'};
  const submissionRows=[
    {'브랜드코드':'BRAND-A','제출ID':'SUB-A','상품ID':'PRD-A','상태':'승인 완료','상품데이터JSON':'{"product_name":"제출 상품"}'},
    {'브랜드코드':'BRAND-A','제출ID':'SUB-B','상품ID':'PRD-B','상태':'신규 제출','상품데이터JSON':'{"product_name":"검수 상품"}'},
    {'브랜드코드':'BRAND-B','제출ID':'SUB-SECRET','상품ID':'PRD-SECRET','상태':'승인 완료','상품데이터JSON':'{"product_name":"다른 브랜드 상품"}'}
  ];
  const scoped=vm.createContext({BOPS:{SHEETS:{SUBMISSIONS:'submissions',LINKS:'links'},STATUS:status},updateObjectRow_:()=>{},now_:()=>'',getSettings_:()=>({fields:[]}),brandValue_:(brand,key)=>brand[key],safeObjects_:sheet=>sheet==='submissions'?submissionRows:[],listProducts_:({brandCode})=>{assert.equal(brandCode,'BRAND-A');return [{productId:'PRD-A',productName:'마스터 상품'},{productId:'PRD-C',productName:'기존 상품'}];}});
  vm.runInContext(source('BO_PartnerService.gs'),scoped);
  scoped.validatePartnerToken_=()=>({link:{_row:2},brand:{'브랜드코드':'BRAND-A','브랜드명':'A'}});
  const scopedData=scoped.getPartnerBootstrap_('valid');
  assert.equal(scopedData.submissions.length,2);assert.equal(scopedData.products.length,3);
  assert.equal(scopedData.products.find(p=>p.productId==='PRD-A').data.product_name,'마스터 상품');
  assert.equal(scopedData.products.find(p=>p.productId==='PRD-B').status,'신규 제출');
  assert.equal(scopedData.products.some(p=>p.productId==='PRD-SECRET'),false);
  console.log('PASS partner bootstrap scopes and separates products from submission history');
  let uploaded=[];const upload=ui(async(name,r)=>{uploaded.push(r);return {ok:true,id:'FILE-'+r.uploadId,url:'https://example.com/file'};});const up=upload.test.P,a=upload.test.makeProduct({}),b=upload.test.makeProduct({});a.assets=[{id:'asset-a',status:'queued',category:'상세페이지',name:'a.pdf'}];b.assets=[{id:'asset-b',status:'queued',category:'상세페이지',name:'b.pdf'}];up.draft.products=[a,b];up.files.set('asset-a',{name:'a.pdf',type:'application/pdf',size:10});up.files.set('asset-b',{name:'b.pdf',type:'application/pdf',size:10});await upload.test.uploadAll(false,[a]);assert.equal(uploaded.length,1);assert.equal(uploaded[0].productId,a.id);assert.equal(b.assets[0].status,'queued');assert.equal(up.busy,false);
  console.log('PASS per-product upload excludes other drafts');
  // Server document endpoints must never mix product files or other brands.
  const db=[],folderCalls=[];let creates=0;
  const folder={getFilesByName:()=>({hasNext:()=>false}),createFile:blob=>{creates++;return {getName:()=>blob.name,getId:()=> 'drive-id',getUrl:()=> 'https://drive.google.com/file/d/test/view'};}};
  const backend=vm.createContext({console,Map,validatePartnerToken_:token=>{if(token!=='valid')throw Error('bad token');return {brand:{code:'BRAND-A'}};},brandValue_:b=>b.code,withLock_:fn=>fn(),findOne_:(n,k,v)=>db.find(r=>r[k]===v),safeObjects_:()=>db,getBrandDocumentFolder_:()=>{folderCalls.push('documents');return folder;},getProductAssetFolder_:()=>{throw Error('wrong folder');},sanitizeFileName_:s=>s,Utilities:{base64Decode:s=>[1],newBlob:(bytes,mime,name)=>({name})},BOPS:{SHEETS:{FILES:'files'},MAX_UPLOAD_BYTES:8*1024*1024},appendObject_:(n,r)=>db.push(r),now_:()=> 'today',logAction_:()=>{}});
  vm.runInContext(source('BO_PartnerExperience.gs'),backend);
  const request={token:'valid',uploadId:'upload-document-123',category:'사업자등록증',fileName:'business.pdf',mimeType:'application/pdf',base64:'eA==',productId:'SHOULD-BE-IGNORED'};
  backend.uploadPartnerDocument(request);backend.uploadPartnerDocument(request);assert.equal(creates,1);assert.equal(db[0]['상품ID'],'');assert.deepEqual(folderCalls,['documents']);
  db.push({'브랜드코드':'BRAND-A','상품ID':'PRD-test','파일명':'product.jpg'},{'브랜드코드':'BRAND-B','상품ID':'','파일명':'private.pdf'});
  assert.equal(backend.getPartnerDocuments({token:'valid'}).files.length,1);assert.throws(()=>backend.getPartnerDocuments({token:'invalid'}));assert.throws(()=>backend.uploadPartnerDocument({...request,uploadId:'upload-document-456',category:'대표 이미지'}));
  console.log('PASS brand documents: correct folder, token scope, category and retry isolation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

