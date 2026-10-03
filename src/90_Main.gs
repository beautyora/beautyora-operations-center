/**
 * 웹앱 진입점과 API 라우터.
 * 화면에서 부를 수 있는 서버 함수는 api() 하나뿐이다. 요청마다 관리자 또는 링크 토큰을 확인한다.
 */

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const token = String(params.token || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  const template = HtmlService.createTemplateFromFile('Index');
  template.view = token ? 'partner' : 'admin';
  template.token = token;
  template.version = BO.VERSION;
  const output = template.evaluate()
    .setTitle(token ? '뷰티오라 상품등록센터' : '뷰티오라 운영센터')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  if (prop_(BO.PROPS.ALLOW_EMBED) === 'true') output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return output;
}

/**
 * 뷰티오라 주소(partner·ops.beautyora.kr, Cloudflare Pages)에서 오는 요청. 소유자 권한으로 실행된다.
 * - 브랜드 작업: 링크 토큰을 확인한다(api()와 같음).
 * - 관리자 작업: 반드시 Google 로그인(ID 토큰)을 확인한다. 브라우저 쿠키의 Google 계정은 절대 믿지 않는다.
 * 본문은 text/plain으로 보낸 JSON이다(브라우저의 사전 확인 요청 없이 보내기 위해).
 */
function doPost(e) {
  let request = null;
  try { request = JSON.parse(String(e && e.postData && e.postData.contents || '')); } catch (ignored) { request = null; }
  const action = request && typeof request === 'object' ? String(request.action || '') : '';
  let result, owner = '';
  if (action === 'response.part') result = responsePart_(request);
  else if (hasOwn_(partnerActions_(), action)) { result = api(request); owner = 'p'; }
  else if (hasOwn_(adminActions_(), action)) { result = signedInApi_(request); owner = 'a'; }
  else result = { ok: false, message: '지원하지 않는 요청입니다.', code: 'BAD_REQUEST' };
  let text = JSON.stringify(result);
  if (owner && result.ok && text.length > BO_POST_PART_CHARS_) {
    try { text = JSON.stringify(packResponse_(text, responseOwner_(owner, request))); } catch (error) { logError_('doPost:pack', error); }
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

/**
 * doPost 응답은 Google이 script.googleusercontent.com 주소로 넘겨 주는데, 응답이 크면(브랜드·상품·재고 전체 목록)
 * 그 주소가 404 "현재 파일을 열 수 없습니다"를 돌려준다. 실행 기록에는 '완료됨'으로 남아 서버 오류로 보이지 않는다.
 * 그래서 큰 응답은 gzip으로 줄여 조각으로 나누고, 첫 조각만 바로 보낸다. 나머지 조각은 'response.part'로 받아 간다.
 * (51KB 응답은 정상으로 확인되어 조각은 그보다 작게 둔다.)
 */
var BO_POST_PART_CHARS_ = 40000;

function packResponse_(text, owner) {
  if (!owner) throw new Error('응답을 받을 사용자를 확인하지 못했습니다.');
  const encoded = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(text, 'application/json')).getBytes());
  const size = BO_POST_PART_CHARS_;
  const count = Math.ceil(encoded.length / size);
  const id = uuid_('P');
  if (count > 1) {
    const parts = {};
    for (let i = 1; i < count; i++) parts[cacheKey_('part:' + id + ':' + i)] = encoded.slice(i * size, (i + 1) * size);
    cache_().putAll(parts, 600);
    cache_().put(cacheKey_('part:' + id), JSON.stringify({ owner: owner, count: count }), 600);
  }
  return { ok: true, packed: { id: id, count: count }, part: encoded.slice(0, size) };
}

/** 나머지 조각. 처음 요청과 같은 브랜드 링크 또는 같은 Google 계정만 받을 수 있다. */
function responsePart_(request) {
  const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
  const id = String(payload.id || '');
  const index = Number(payload.index);
  const expired = { ok: false, message: '목록을 받는 중에 연결이 끊겼습니다. 새로 고친 뒤 다시 시도해 주세요.', code: 'PART_EXPIRED' };
  if (!/^P[0-9A-F]{20}$/.test(id) || !(index >= 1) || index !== Math.floor(index)) return expired;
  let meta = null;
  try { meta = JSON.parse(cache_().get(cacheKey_('part:' + id)) || 'null'); } catch (ignored) { meta = null; }
  if (!meta || !meta.owner || index >= meta.count) return expired;
  if (responseOwner_(meta.owner.charAt(0), request) !== meta.owner) return expired;
  const part = cache_().get(cacheKey_('part:' + id + ':' + index));
  return part == null ? expired : { ok: true, part: part };
}

function responseOwner_(kind, request) {
  if (kind === 'p') return request.token ? 'p:' + sha256_(String(request.token)) : '';
  try { return 'a:' + verifyGoogleIdToken_(request.idToken); } catch (ignored) { return ''; }
}

/** Google 로그인을 확인한 뒤 그 이메일로 관리자 작업을 처리한다. */
function signedInApi_(request) {
  try {
    BO_SIGNED_IN_EMAIL_ = verifyGoogleIdToken_(request.idToken);
  } catch (error) {
    if (!error.userFacing) logError_('auth:idToken', error);
    return { ok: false, message: error.userFacing ? errorMessage_(error) : 'Google 로그인을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: error.code || 'NEED_LOGIN' };
  }
  try { return api(request); } finally { BO_SIGNED_IN_EMAIL_ = ''; }
}

/** HTML 템플릿에서만 쓰는 포함 함수(_로 끝나 화면에서 직접 부를 수 없음). */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function adminActions_() {
  return {
    'admin.bootstrap': function () { return { user: { email: activeEmail_() }, version: BO.VERSION, dashboard: apiDashboard_() }; },
    'dashboard': apiDashboard_,
    'brands.list': apiBrandsList_,
    'brands.detail': apiBrandDetail_,
    'brands.body': apiBrandBody_,
    'brands.update': apiBrandUpdate_,
    'brands.documents': apiBrandDocuments_,
    'brands.links': apiLinksOfBrand_,
    'brands.activities': apiActivities_,
    'brands.terms': apiTerms_,
    'brands.inventory': apiInventory_,
    'brands.folder': apiAssetFolder_,
    'brands.billing': apiBilling_,
    'billing.add': apiBillingAdd_,
    'billing.update': apiBillingUpdate_,
    'links.issue': apiLinkIssue_,
    'links.stop': apiLinkStop_,
    'activities.add': apiActivityAdd_,
    'activities.done': apiActivityDone_,
    'intake.list': apiIntakeList_,
    'intake.decide': apiIntakeDecide_,
    'intake.import': apiIntakeImport_,
    'products.list': apiProductsList_,
    'products.detail': apiProductDetail_,
    'products.update': apiProductUpdate_,
    'products.fields': apiProductFields_,
    'products.fieldsSave': apiProductFieldsSave_,
    'review.queue': apiReviewQueue_,
    'review.detail': apiReviewDetail_,
    'review.decide': apiReviewDecide_,
    'documents.pending': apiDocumentsPending_,
    'documents.review': apiDocumentReview_,
    'inventory.list': apiInventory_,
    'inventory.movements': apiMovements_,
    'inventory.record': apiMovementRecord_,
    'inventory.update': apiInventoryUpdate_,
    'system.health': function () { return healthCheck_(); },
    'system.setup': function () { return setupSystem_(); },
    'system.refresh': function () { bumpCache_('brand', 'product', 'link', 'inventory', 'activity', 'asset', 'store', 'source', 'billing'); return { refreshed: true }; },
    'migration.preview': function (payload) { return migrationPreview_(payload.spreadsheetId); },
    'migration.run': function (payload) { return migrationRun_(payload.spreadsheetId); },
    'legacy.preview': function (payload) { return legacyPreview_(payload.folderUrl); },
    'legacy.run': function (payload) { return legacyRun_(payload.folderUrl); }
  };
}

function partnerActions_() {
  return {
    'partner.bootstrap': partnerBootstrap_,
    'partner.fields': partnerFields_,
    'partner.upload': partnerUpload_,
    'partner.documents': partnerDocuments_,
    'partner.assets': partnerProductAssets_,
    'partner.thumbnails': partnerThumbnails_,
    'partner.submit': partnerSubmit_,
    'partner.importWorkbook': partnerImportWorkbook_
  };
}

/**
 * 화면 → 서버 단일 진입점.
 * request: { action, payload, token }
 * 응답: { ok: true, data } | { ok: false, message, code }
 */
function api(request) {
  request = request && typeof request === 'object' ? request : {};
  const action = String(request.action || '');
  const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
  const partner = partnerActions_();
  const admin = adminActions_();
  const isPartner = hasOwn_(partner, action);
  try {
    let data;
    if (isPartner) {
      const ctx = partnerContext_(request.token);
      data = partner[action](ctx, payload);
    } else if (hasOwn_(admin, action)) {
      assertAdmin_();
      data = admin[action](payload);
    } else {
      throw userError_('지원하지 않는 요청입니다.');
    }
    return { ok: true, data: data };
  } catch (error) {
    const reference = uuid_('E').slice(0, 9);
    logError_('api:' + action + ':' + reference, error);
    let message = errorMessage_(error);
    // 브랜드에게는 내부 오류 내용을 보여 주지 않는다.
    if (isPartner && !error.userFacing) message = '처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요. (문의 코드 ' + reference + ')';
    return { ok: false, message: message, code: error.code || '', reference: reference };
  }
}
