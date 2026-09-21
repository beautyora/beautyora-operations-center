 /** Brand partner experience v2. Existing endpoints remain compatible. */
function uploadPartnerAsset(request) {
  const context = validatePartnerToken_(request.token);
  const brandCode = brandValue_(context.brand, '브랜드코드');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(request.uploadId || '') || !/^[a-zA-Z0-9-]{8,80}$/.test(request.productId || '')) throw new Error('파일 연결 정보가 올바르지 않습니다.');
  const category = request.category;
  if (!['대표 이미지','추가 이미지','상세페이지','기타'].includes(category)) throw new Error('파일 분류를 확인해 주세요.');
  const id = 'FILE-' + request.uploadId;
  const previous = findOne_(BOPS.SHEETS.FILES, '파일ID', id);
  if (previous) {
    if (previous['브랜드코드'] !== brandCode || previous['상품ID'] !== request.productId || previous['분류'] !== category) throw new Error('파일 연결 정보를 확인해 주세요.');
    return {ok:true,id:id,url:previous['DriveURL'],name:previous['파일명'],category:category};
  }
  const allowed = {'image/jpeg':['jpg','jpeg'],'image/png':['png'],'image/webp':['webp'],'application/pdf':['pdf']};
  const extension = String(request.fileName || '').split('.').pop().toLowerCase();
  if (!allowed[request.mimeType] || !allowed[request.mimeType].includes(extension)) throw new Error('JPG, PNG, WEBP 또는 PDF 파일을 선택해 주세요.');
  if (category.indexOf('이미지') >= 0 && request.mimeType === 'application/pdf') throw new Error('대표·추가 이미지에는 이미지 파일을 선택해 주세요.');
  if (!request.base64 || request.base64.length > Math.ceil(BOPS.MAX_UPLOAD_BYTES / 3) * 4 + 4) throw new Error('파일은 8MB 이하로 선택해 주세요.');
  const bytes = Utilities.base64Decode(request.base64);
  if (!bytes.length || bytes.length > BOPS.MAX_UPLOAD_BYTES) throw new Error('빈 파일이거나 8MB를 초과했습니다.');

  // Drive 전송은 잠금 밖에서 처리해 서로 다른 파일을 동시에 저장할 수 있게 한다.
  const folder = getBrandFolder_(context.brand);
  const fileName = sanitizeFileName_(request.productId + '_' + category + '_' + request.uploadId + '_' + request.fileName);
  const matches = folder.getFilesByName(fileName);
  const file = matches.hasNext() ? matches.next() : folder.createFile(Utilities.newBlob(bytes, request.mimeType, fileName));

  // 중복 방지와 시트 쓰기에 필요한 짧은 구간만 직렬화한다.
  return withLock_(function () {
    const current = findOne_(BOPS.SHEETS.FILES, '파일ID', id);
    if (current) {
      if (current['브랜드코드'] !== brandCode || current['상품ID'] !== request.productId || current['분류'] !== category) throw new Error('파일 연결 정보를 확인해 주세요.');
      return {ok:true,id:id,url:current['DriveURL'],name:current['파일명'],category:category};
    }
    appendObject_(BOPS.SHEETS.FILES, {'파일ID':id,'브랜드코드':brandCode,'상품ID':request.productId,'분류':category,'파일명':file.getName(),'Drive파일ID':file.getId(),'DriveURL':file.getUrl(),'업로드일':now_(),'상태':'수령 완료'});
    logAction_('상품 첨부 업로드','브랜드',brandCode,file.getName());
    return {ok:true,id:id,url:file.getUrl(),name:file.getName(),category:category};
  });
}

function submitPartnerDraft(request) {
  return withLock_(function () {
    const context = validatePartnerToken_(request.token);
    const brandCode = brandValue_(context.brand, '브랜드코드');
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(request.requestId || '')) throw new Error('제출 식별자가 올바르지 않습니다.');
    if (!Array.isArray(request.products) || !request.products.length || request.products.length > 300) throw new Error('상품은 1~300개까지 제출할 수 있습니다.');
    const fields = getSettings_().fields.filter(f => f.active);
    const submissions = sheetObjects_(BOPS.SHEETS.SUBMISSIONS);
    const files = sheetObjects_(BOPS.SHEETS.FILES).filter(f => f['브랜드코드'] === brandCode);
    const masterProducts = listProducts_({}).filter(item => item.brandCode === brandCode);
    const used = {};
    const products = request.products.map(p => {
      const data = Object.assign({}, p.data || {});
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(p.id || '') || used[p.id]) throw new Error('중복되거나 잘못된 상품 식별자입니다.');
      used[p.id] = true;
      const other = submissions.find(s => s['상품ID'] === p.id && s['브랜드코드'] !== brandCode);
      if (other) throw new Error('다른 브랜드의 상품을 변경할 수 없습니다.');
      let source = null;
      if (p.sourceSubmissionId) {
        if (String(p.sourceSubmissionId).indexOf('MASTER-') === 0) {
          const master = masterProducts.find(item => item.productId === p.id);
          if (!master) throw new Error('수정할 기존 상품을 찾을 수 없습니다.');
          source = {'제출ID':p.sourceSubmissionId,'상품ID':p.id,'브랜드코드':brandCode,'상태':BOPS.STATUS.APPROVED};
        } else {
          source = submissions.find(s => s['제출ID'] === p.sourceSubmissionId && s['상품ID'] === p.id && s['브랜드코드'] === brandCode);
        }
        if (!source || ![BOPS.STATUS.REVISION, BOPS.STATUS.APPROVED].includes(source['상태'])) throw new Error('승인 완료 또는 보완 요청된 상품만 수정할 수 있습니다.');
      } else {
        const conflict = submissions.find(s => s['상품ID'] === p.id && s['브랜드코드'] === brandCode && s['제출ID'] !== 'UX-' + request.requestId + '-' + p.id);
        if (conflict) throw new Error('이미 제출한 상품입니다. 제출 현황을 확인해 주세요.');
      }
      if (!Array.isArray(p.assets || []) || (p.assets || []).length > 50) throw new Error('상품당 첨부파일은 최대 50개입니다.');
      data.product_id = p.id;
      data.attachments = (p.assets || []).map((a, index) => {
        const file = files.find(f => f['파일ID'] === a.id && f['상품ID'] === p.id);
        if (!file) throw new Error((data.product_name || '상품') + ': 첨부파일 업로드를 완료해 주세요.');
        return {id:file['파일ID'],name:file['파일명'],url:file['DriveURL'],category:file['분류'],order:index + 1};
      });
      const main = data.attachments.find(a => a.category === '대표 이미지');
      const details = data.attachments.filter(a => a.category === '상세페이지');
      const detailUrl = String(p.detailUrl || '').trim();
      if (detailUrl && !/^https?:\/\/[^\s]+$/i.test(detailUrl)) throw new Error('상세페이지 주소는 https:// 또는 http://로 시작해야 합니다.');
      if (data.attachments.filter(a => a.category === '대표 이미지').length > 1) throw new Error('대표 이미지는 한 장만 선택해 주세요.');
      data.main_image_url = main ? main.url : (p.sourceSubmissionId ? data.main_image_url || '' : '');
      data.detail_page_url = detailUrl || (details[0] ? details[0].url : '');
      data.detail_page_urls = details.map(a => a.url);
      data.additional_image_urls = data.attachments.filter(a => a.category === '추가 이미지').map(a => a.url);
      data._partner_request_id = request.requestId;
      if (source) {
        data._change_request = data._change_request === true || source['상태'] === BOPS.STATUS.APPROVED;
        data._source_submission_id = data._source_submission_id || p.sourceSubmissionId;
      }
      return {id:p.id,sourceSubmissionId:p.sourceSubmissionId || '',data:data};
    });
    const errors = validateProducts_(products.map(p => p.data), fields, brandCode);
    if (errors.length) return {ok:false,validationErrors:errors};
    const result = [];
    products.forEach(p => {
      const id = 'UX-' + request.requestId + '-' + p.id;
      const previous = submissions.find(s => s['제출ID'] === id);
      if (previous) { if (previous['브랜드코드'] !== brandCode) throw new Error('제출 정보를 확인해 주세요.'); if (previous['상품데이터JSON'] !== JSON.stringify(p.data)) throw new Error('이 상품은 이미 제출되었습니다. 제출 현황을 새로고침해 확인해 주세요.'); result.push({id:p.id,submissionId:id}); return; }
      const version = Math.max(0,...submissions.filter(s => s['상품ID'] === p.id && s['브랜드코드'] === brandCode).map(s => Number(s['제출버전']) || 1)) + 1;
      appendObject_(BOPS.SHEETS.SUBMISSIONS,{'제출ID':id,'브랜드코드':brandCode,'상품ID':p.id,'제출버전':version,'상태':BOPS.STATUS.SUBMITTED,'제출일':now_(),'수정일':now_(),'상품데이터JSON':JSON.stringify(p.data),'검수메모':'','제출자명':sanitize_(request.contactName),'제출자연락처':sanitize_(request.contactPhone)});
      result.push({id:p.id,submissionId:id});
    });
    logAction_('상품 통합 제출','브랜드',brandCode,result.length + '개 상품');
    return {ok:true,count:result.length,products:result};
  });
}

function runBeautyoraPartnerUXChecks(){
 assertAdmin_();
 const originals={withLock_,validatePartnerToken_,sheetObjects_,safeObjects_,findOne_,appendObject_,logAction_,getSettings_,getBrandFolder_};
 const db={},checks=[];let created=0;
 const ensure=n=>db[n]||(db[n]=[]);
 const assert=(v,m)=>{if(!v)throw new Error('FAIL: '+m);checks.push(m);};
 const fail=(fn,m)=>{let threw=false;try{fn();}catch(e){threw=true;}assert(threw,m);};
 try{
 withLock_=fn=>fn();
 validatePartnerToken_=t=>{if(t!=='test-token')throw new Error('invalid token');return {brand:{'브랜드코드':'BO-TEST'}};};
 sheetObjects_=n=>ensure(n);safeObjects_=n=>ensure(n);
 findOne_=(n,k,v)=>ensure(n).find(r=>r[k]===v)||null;
 appendObject_=(n,o)=>{ensure(n).push({...o});return ensure(n).length+1;};
 logAction_=()=>{};
 getSettings_=()=>({fields:[{id:'product_name',label:'상품명',required:true,type:'text',active:true},{id:'retail_price',label:'소비자가',required:true,type:'number',active:true}]});
 getBrandFolder_=()=>({getFilesByName:()=>({hasNext:()=>false}),createFile:blob=>{created++;return {getName:()=>blob.getName(),getId:()=> 'test-drive-'+created,getUrl:()=> 'https://drive.google.com/file/d/test-'+created+'/view'};}});
 const a={token:'test-token',uploadId:'upload-12345678',productId:'PRD-12345678',category:'대표 이미지',fileName:'test.png',mimeType:'image/png',base64:'iVBORw0KGgo='};
 const asset=uploadPartnerAsset(a);
 assert(asset.ok&&created===1,'파일 등록 성공');uploadPartnerAsset(a);assert(created===1&&ensure(BOPS.SHEETS.FILES).length===1,'동일 파일 재시도 중복 방지');
 fail(()=>uploadPartnerAsset({...a,token:'bad'}),'잘못된 토큰 차단');
 fail(()=>uploadPartnerAsset({...a,productId:'PRD-OTHER000'}),'다른 상품에 기존 파일 재사용 차단');
 fail(()=>uploadPartnerAsset({...a,uploadId:'upload-bad000',mimeType:'text/html',fileName:'x.html'}),'지원하지 않는 파일 차단');
 fail(()=>uploadPartnerAsset({...a,uploadId:'upload-bad001',mimeType:'application/pdf',fileName:'x.pdf'}),'대표 이미지 PDF 차단');
 const req={token:'test-token',requestId:'request-12345678',products:[{id:'PRD-12345678',data:{product_name:'테스트',retail_price:'19,000'},detailUrl:'https://example.com/product',assets:[{id:asset.id}]}]};
 const result=submitPartnerDraft(req);assert(result.ok&&result.count===1,'상품과 첨부 통합 제출');
 const stored=JSON.parse(ensure(BOPS.SHEETS.SUBMISSIONS)[0]['상품데이터JSON']);assert(stored.main_image_url===asset.url&&stored.detail_page_url==='https://example.com/product','마스터용 이미지·상세페이지 URL 연결');
 submitPartnerDraft(req);assert(ensure(BOPS.SHEETS.SUBMISSIONS).length===1,'제출 재시도 중복 방지');
 const missing=submitPartnerDraft({token:'test-token',requestId:'request-missing00',products:[{id:'PRD-MISSING00',data:{},assets:[]}]});assert(!missing.ok&&missing.validationErrors.length===2,'필수값 서버 검증');
 fail(()=>submitPartnerDraft({...req,requestId:'request-other000'}),'다른 요청으로 동일 상품 중복 등록 차단');
 fail(()=>submitPartnerDraft({token:'test-token',requestId:'request-badfile0',products:[{id:'PRD-OTHER000',data:{product_name:'상품',retail_price:1},assets:[{id:asset.id}]}]}),'다른 상품 첨부 연결 차단');
 fail(()=>submitPartnerDraft({token:'test-token',requestId:'request-badurl00',products:[{id:'PRD-OTHER000',data:{product_name:'상품',retail_price:1},assets:[],detailUrl:'javascript:alert(1)'}]}),'위험한 상세 URL 차단');
 let injected=false;appendObject_=(n,o)=>{if(n===BOPS.SHEETS.SUBMISSIONS&&o['상품ID']==='PRD-PARTIAL2'&&!injected){injected=true;throw new Error('simulated failure');}ensure(n).push({...o});return ensure(n).length+1;};
 const partial={token:'test-token',requestId:'request-partial0',products:['PRD-PARTIAL1','PRD-PARTIAL2'].map(id=>({id,data:{product_name:id,retail_price:1},assets:[]}))};
 fail(()=>submitPartnerDraft(partial),'부분 실패 시뮬레이션');submitPartnerDraft(partial);assert(ensure(BOPS.SHEETS.SUBMISSIONS).filter(r=>r['상품ID'].startsWith('PRD-PARTIAL')).length===2,'부분 실패 재시도 누락·중복 없음');
 console.log(JSON.stringify({ok:true,passed:checks.length,checks:checks,productionWrites:0}));return {ok:true,passed:checks.length};
 }finally{withLock_=originals.withLock_;validatePartnerToken_=originals.validatePartnerToken_;sheetObjects_=originals.sheetObjects_;safeObjects_=originals.safeObjects_;findOne_=originals.findOne_;appendObject_=originals.appendObject_;logAction_=originals.logAction_;getSettings_=originals.getSettings_;getBrandFolder_=originals.getBrandFolder_;}
}