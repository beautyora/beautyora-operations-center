const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS', name); }
function load(files, globals = {}) {
  const context = vm.createContext({console, ...globals});
  files.forEach(file => vm.runInContext(source(file), context, {filename:file}));
  return context;
}

class Sheet {
  constructor(rows) { this.rows = rows; this.reads = []; this.writes = 0; this.max = Math.max(rows.length, 10); }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows[0]?.length || 0; }
  getMaxRows() { return this.max; }
  insertRowsAfter(after, count) { this.max += count; }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  getRange(row, col, height = 1, width = 1) {
    const sheet = this;
    const range = {
      getDisplayValues() { sheet.reads.push([row,col,height,width]); return Array.from({length:height}, (_,i) => Array.from({length:width}, (_,j) => String(sheet.rows[row+i-1]?.[col+j-1] ?? ''))); },
      setValues(values) { sheet.writes++; values.forEach((r,i) => { sheet.rows[row+i-1] ||= []; r.forEach((v,j) => sheet.rows[row+i-1][col+j-1] = v); }); return range; },
      setNumberFormat() { return range; }, setFontWeight() { return range; }, setBackground() { return range; }
    };
    return range;
  }
  appendRow(row) { this.rows.push(row); this.writes++; }
  setFrozenRows() {}
}

check('all Apps Script and browser scripts parse', () => {
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'src'))) {
    if (file.endsWith('.gs')) new vm.Script(source(file), {filename:file});
    if (file.endsWith('.html')) {
      for (const match of source(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1], {filename:file});
    }
  }
});

check('300 rows use one header read and one batch write', () => {
  const sheet = new Sheet([['상품ID','가격','설명']]);
  const c = load(['BO_DataStore.gs']); c.getSheet_ = () => sheet;
  c.appendObjects_('test', Array.from({length:300}, (_,i) => ({'상품ID':'P'+i, '가격':i})));
  assert.equal(sheet.writes,1); assert.equal(sheet.reads.length,1);
  assert.equal(sheet.rows.length,301); assert.deepEqual(sheet.rows[300], ['P299',299,'']);
  c.appendObjects_('test', []); assert.equal(sheet.writes,1);
});

check('recent logs preserve nonblank ordering without reading 10,000 rows', () => {
  const rows = [['작업','상세'], ...Array.from({length:10000}, (_,i) => ['action '+i, ''])];
  rows[9998] = ['', ''];
  const sheet = new Sheet(rows), c = load(['BO_DataStore.gs']); c.getSheet_ = () => sheet;
  assert.deepEqual(plain(c.recentSheetObjects_('logs',8)).map(r=>r['작업']), rows.slice(1).filter(r=>r.some(Boolean)).slice(-8).reverse().map(r=>r[0]));
  assert.equal(sheet.reads.reduce((n,r)=>n+r[2],0),101);
});

check('brand-scoped product results equal the full-catalog filter', () => {
  const c = load(['BO_Config.gs','BO_AdminService.gs']);
  const names = vm.runInContext('BOPS.SHEETS', c);
  const rows = {
    [names.BRANDS]: [{'브랜드 ID':'B1','브랜드명':'첫째'}, {'브랜드 ID':'B2','브랜드명':'둘째'}],
    '_원본_노션_상품': [{'상품명':'상품1','매입가':'20','이미지':'https://example.com/a.png'}],
    '상품': [{'상품ID':'P1','브랜드ID':'B1','상품명':'상품1'}, {'상품ID':'P2','브랜드ID':'B2','상품명':'상품2'}, {'상품ID':'P3','브랜드ID':'B1','상품명':'중지','활성':'FALSE'}],
    [names.PRODUCTS]: [{'상품ID':'P1','브랜드코드':'B1','상품데이터JSON':'{"product_name":"승인상품"}'}, {'상품ID':'P4','브랜드코드':'B2','상품데이터JSON':'{"product_name":"신규"}'}]
  };
  c.safeObjects_ = n => rows[n] || [];
  // A master override can move a product to a brand or omit its brand code.
  rows[names.PRODUCTS].push({'상품ID':'P2','브랜드코드':'B1','상품데이터JSON':'{}'});
  rows[names.PRODUCTS].push({'상품ID':'P3','브랜드코드':'','상품데이터JSON':'{}'});
  for (const code of ['B1','B2','missing']) assert.deepEqual(plain(c.listProducts_({brandCode:code})),plain(c.listProducts_({})).filter(p=>p.brandCode===code));
});

check('movement reads the catalog once and rejects insufficient stock and duplicate retries', () => {
  const c = load(['BO_BrandWorkspace.gs']); let reads=0, writes=0, locked=false;
  const journal=[];
  Object.assign(c, {assertAdmin_:()=>{}, withLock_:fn=>{assert.equal(locked,false);locked=true;try{return fn()}finally{locked=false}},
    listProducts_:()=>{assert.ok(locked);reads++;return [{productId:'P1',brandCode:'B1'}]},
    crmRows_:name=>name==='장소'?[{'장소ID':'L1','장소명':'매장'}]:name==='현재고'?[{'상품ID':'P1','장소ID':'L1','매입재고':'5'}]:name==='간편 입출고'?journal:[],
    opsSheet_:()=>({getLastRow:()=>1,getRange:()=>({setValues:()=>{assert.ok(locked);writes++}})}), uuid_:()=> 'ID',now_:()=>'',getActiveUserEmail_:()=>''});
  const p={requestId:'request-1234',productId:'P1',placeId:'L1',type:'출고',trade:'매입',quantity:3,date:'2026-09-27'};
  assert.equal(c.saveSimpleMovement(p).ok,true); assert.equal(reads,1); assert.equal(writes,1);
  assert.throws(()=>c.saveSimpleMovement({...p,quantity:6}),/재고보다/); assert.equal(writes,1);
  journal.push({'요청ID':p.requestId}); reads=0;
  assert.equal(c.saveSimpleMovement(p).duplicate,true);assert.equal(reads,0);assert.equal(writes,1);
});

check('partner workflow preserves validation and retries after partial failure', () => {
  const c=load(['BO_Config.gs','BO_Main.gs','BO_DataStore.gs','BO_AdminService.gs','BO_Setup.gs','BO_PartnerService.gs','BO_PartnerExperience.gs'], {
    Utilities:{base64Decode:s=>Array.from(Buffer.from(s,'base64')),newBlob:(bytes,type,name)=>({getName:()=>name})}
  });
  c.assertAdmin_=()=>{};c.now_=()=> '2026-09-27';
  const result=c.runBeautyoraPartnerUXChecks(); assert.equal(result.ok,true); assert.ok(result.passed>=15);
});

check('300 partner products batch once; retry writes zero rows; conflicts write nothing', () => {
  const c=load(['BO_Config.gs','BO_Main.gs','BO_PartnerExperience.gs']);
  const rows=[],calls=[];
  Object.assign(c,{withLock_:fn=>fn(),validatePartnerToken_:()=>({brand:{}}),brandValue_:()=> 'B1',getSettings_:()=>({fields:[]}),
    sheetObjects_:n=>n===vm.runInContext('BOPS.SHEETS.SUBMISSIONS',c)?rows:[],listProducts_:()=>[],validateProducts_:()=>[],now_:()=>'',logAction_:()=>{},
    appendObjects_:(name,pending)=>{if(pending.length)calls.push(pending.length);rows.push(...pending)}});
  const request={requestId:'request-12345',products:Array.from({length:300},(_,i)=>({id:'PRODUCT-'+i,data:{product_name:'P'+i},assets:[]}))};
  assert.equal(c.submitPartnerDraft(request).count,300);assert.deepEqual(calls,[300]);
  c.submitPartnerDraft(request);assert.deepEqual(calls,[300]);assert.equal(rows.length,300);
  const changed=plain(request);changed.products[299].data.product_name='changed';
  assert.throws(()=>c.submitPartnerDraft(changed),/이미 제출/);assert.deepEqual(calls,[300]);
});

function importContext() {
  let locked=false, counter=0, converted=false, removed=false, conversionCount=0;
  const props=new Map(), sheets=new Map();
  const files=[{'파일ID':'DRIVE-X','Drive파일ID':'F1','파일명':'test.xlsx','브랜드코드':'B1'}];
  const c=load(['BO_ImportService.gs'],{
    BOPS:{SHEETS:{FILES:'files'}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k)})},
    MimeType:{GOOGLE_SHEETS:'sheet'},
    Drive:{Files:{create:()=>{assert.equal(locked,false);converted=true;conversionCount++;return {id:'converted'}}}},
    DriveApp:{getFileById:id=>({getBlob:()=>{assert.equal(locked,false);return {}},setTrashed:()=>{assert.equal(locked,false);removed=true}})},
    SpreadsheetApp:{flush:()=>assert.ok(locked),openById:()=>{assert.equal(locked,false);return {getSheets:()=>[{getSheetId:()=>conversionCount,getName:()=> '상품',getDataRange:()=>({getDisplayValues:()=>{assert.equal(locked,false);return [['상품명','가격'],['샴푸','1000']]}})}]}}}
  });
  Object.assign(c,{assertAdmin_:()=>{},withLock_:fn=>{assert.equal(locked,false);locked=true;try{return fn()}finally{locked=false}},
    crmJson_:s=>JSON.parse(s||'{}'),uuid_:()=> 'claim-'+(++counter),now_:()=>'',crmSafeCell_:v=>v,
    opsSheet_:(name,headers)=>{assert.ok(locked);if(!sheets.has(name))sheets.set(name,new Sheet([headers]));return sheets.get(name)},
    crmRows_:name=>name==='files'?files:[],opsRows_:name=>{const sheet=sheets.get(name);if(!sheet)return [];return sheet.rows.slice(1).map(row=>Object.fromEntries(sheet.rows[0].map((h,i)=>[h,row[i]])))}});
  return {c,props,sheets,state:()=>({converted,removed,locked})};
}

check('Drive conversion and parsing run outside shared lock; imports commit once', () => {
  const {c,props,sheets,state}=importContext();const result=c.opsImportNext();
  assert.equal(result.done,true);assert.equal(result.rows,2);assert.equal(sheets.get('제출 상품자료').writes,1);
  assert.equal(props.size,0);assert.equal(state().removed,true);
  c.opsImportNext();assert.equal(sheets.get('제출 상품자료').writes,1);
});

check('import reservation rejects concurrent and stale workers', () => {
  const {c,props}=importContext();const job=c.opsImportClaim_();
  assert.throws(()=>c.opsImportClaim_(),/수집 중/);
  props.set('BO_SOURCE_IMPORT_CLAIM',JSON.stringify({token:'replacement',expires:Date.now()+1000}));
  assert.throws(()=>c.opsImportCommit_(job,{rows:[],sheetCount:0}),/예약이 변경/);
});

check('conversion failure releases reservation for a safe retry', () => {
  const {c,props}=importContext();
  c.Drive.Files.create=()=>{throw Error('conversion failure')};
  assert.throws(()=>c.opsImportNext(),/conversion failure/);
  assert.equal(props.size,0);
  assert.ok(c.opsImportClaim_().token);
});

check('import retry recovers rows committed before completion-log failure', () => {
  const {c,sheets}=importContext();const original=c.opsSheet_;
  let fail=true;
  c.opsSheet_=(name,headers)=>{const sheet=original(name,headers);if(name==='제출자료 처리'){sheet.appendRow=row=>{if(fail){fail=false;throw Error('log failure')}sheet.rows.push(row)}}return sheet};
  assert.throws(()=>c.opsImportNext(),/log failure/);
  assert.equal(sheets.get('제출 상품자료').rows.length,3);
  assert.equal(c.opsImportNext().done,true);assert.equal(sheets.get('제출 상품자료').rows.length,3);
});

async function browserChecks() {
  const lines=source('Scripts.html').split(/\r?\n/);
  let version=1,tabCalls=0,failed=false,invalid=false;
  const c=vm.createContext({console,State:{sectionCache:{},route:'other'},CRM:{tab:'terms',data:{rows:[]}},OPS:{},
    Busy:{start:()=>{},finish:()=>{},label:()=>''},crmDrawerRender:()=>{}});
  c.google={script:{run:{withSuccessHandler:resolve=>({withFailureHandler:reject=>new Proxy({}, {get:(target,name)=>(...args)=>{
    if(failed){reject({message:'failure'});return}
    if(name==='getBrandOverview')resolve({brand:{brandCode:'B1'},activities:[]});
    else if(name==='getBrandTab'){tabCalls++;resolve({terms:[{version}],products:[]})}
    else resolve({ok:!invalid});
  }})})}}};
  vm.runInContext(lines.filter(l=>l.startsWith('const INLINE_READS=')||l.startsWith('const CACHE_WRITES=')||l.startsWith('const server=')).join('\n'),c);
  const selected=source('BrandWorkspace.html').split(/\r?\n/).filter(l=>l.startsWith('const PERF=')||l.startsWith('function perfInvalidate(')||l.startsWith('function perfFetch(')||l.startsWith('async function perfDetail(')||l.startsWith('async function perfLoadTab(')||l.startsWith('crmReloadDetail=async'));
  vm.runInContext(selected.join('\n'),c);
  await vm.runInContext("(async()=>{CRM.detail=await perfDetail('B1');await perfLoadTab(CRM.detail,'terms')})()",c);
  version=2;
  await vm.runInContext("server('saveBrandTerms',{})",c);
  await c.crmReloadDetail();
  assert.equal(c.CRM.detail.terms[0].version,2);assert.equal(tabCalls,2);
  passed++;console.log('PASS saved terms refresh through actual server wrapper');
  const generation=vm.runInContext('PERF.generation',c);
  invalid=true;await vm.runInContext("server('saveAdminAction',{})",c);invalid=false;
  failed=true;await assert.rejects(()=>vm.runInContext("server('saveBrandTerms',{})",c),/failure/);failed=false;
  assert.equal(vm.runInContext('PERF.generation',c),generation);
  passed++;console.log('PASS rejected and failed writes do not invalidate caches');
  let resolve; c.slow = new Promise(r=>resolve=r);
  vm.runInContext('PERF.pending.clear();const originalServer=server;',c);
  // Exercise a real asynchronous RPC response arriving after cache invalidation.
  c.google.script.run.withSuccessHandler=success=>({withFailureHandler:()=>({getBrandOverview:()=>c.slow.then(success)})});
  const first=c.perfFetch('slow','getBrandOverview',[]),second=c.perfFetch('slow','getBrandOverview',[]);
  assert.equal(first,second);c.perfInvalidate();resolve({brand:{}});await first;
  assert.equal(vm.runInContext("PERF.cache.has('slow')",c),false);
  passed++;console.log('PASS concurrent reads deduplicate and pre-write responses cannot repopulate cache');
  console.log(`Performance regression groups passed: ${passed}`);
}
browserChecks().catch(error=>{console.error(error);process.exitCode=1});
