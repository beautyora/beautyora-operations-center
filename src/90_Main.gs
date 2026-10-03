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
  let result;
  if (hasOwn_(partnerActions_(), action)) result = api(request);
  else if (hasOwn_(adminActions_(), action)) result = signedInApi_(request);
  else result = { ok: false, message: '지원하지 않는 요청입니다.', code: 'BAD_REQUEST' };
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
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
