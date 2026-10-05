/**
 * 웹앱 진입점과 API 라우터.
 * 운영센터 화면은 ops.beautyora.kr(정적 페이지)에 있고, 서버 호출은 이 웹앱의 doPost로 온다.
 * 웹앱은 소유자 권한·익명 접근으로 배포되므로, 관리자 작업은 요청마다 Google 로그인(ID 토큰)을 확인한다.
 */

const BO_DEFAULT_OPS_URL = 'https://ops.beautyora.kr';

function opsUrl_() {
  const url = prop_(BO.PROPS.OPS_URL) || BO_DEFAULT_OPS_URL;
  return /^https:\/\/[A-Za-z0-9.-]+(\/[^\s"'<>]*)?$/.test(url) ? url : BO_DEFAULT_OPS_URL;
}

/** Apps Script 주소로 직접 열면 운영센터 주소로 안내만 한다(화면과 서버 함수 호출 코드가 없다). */
function doGet() {
  const url = opsUrl_();
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8"><title>뷰티오라 운영센터</title>' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif;max-width:420px;margin:15vh auto;padding:24px;text-align:center;color:#1d1d1f">' +
    '<h1 style="font-size:20px">뷰티오라 운영센터</h1><p style="color:#6e6e73">운영센터는 아래 주소에서 Google 계정으로 로그인해 사용합니다.</p>' +
    '<p><a href="' + safe + '" target="_top" style="display:inline-block;padding:10px 20px;border-radius:999px;background:#1d1d1f;color:#fff;text-decoration:none;font-weight:600">' + safe + ' 열기</a></p></div>'
  ).setTitle('뷰티오라 운영센터');
}

/**
 * ops.beautyora.kr에서 오는 요청. 본문은 text/plain으로 보낸 JSON이다(브라우저의 사전 확인 요청 없이 보내기 위해).
 * 응답: { ok: true, data } | { ok: false, message, code }
 */
function doPost(e) {
  let request = null;
  try { request = JSON.parse(String(e && e.postData && e.postData.contents || '')); } catch (ignored) { request = null; }
  const result = request && typeof request === 'object' && !Array.isArray(request)
    ? api(request)
    : { ok: false, message: '지원하지 않는 요청입니다.', code: 'BAD_REQUEST' };
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
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
    'brands.folder': apiBrandFolder_,
    'brands.foldersSync': apiBrandFoldersSync_,
    'brands.activity': apiBrandActivity_,
    'brands.share': apiBrandShareGet_,
    'brands.shareSave': apiBrandShareSave_,
    'admins.list': apiAdminsList_,
    'admins.update': apiAdminsUpdate_,
    'admins.driveSync': apiAdminsDriveSync_,
    'intake.sync': syncBrandIntake_,
    'products.main': apiMainProductsStatus_,
    'products.mainBuild': apiMainProductsBuild_,
    'products.mainImages': apiMainProductsImages_,
    'system.health': function () { return healthCheck_(); },
    'system.setup': function () { return setupSystem_(); },
    'system.refresh': function () { bumpCache_('brand', 'activity', 'source', 'driveActivity'); return { refreshed: true }; }
  };
}

/** 로그인 전에도 부를 수 있는 요청. 공개값(로그인 클라이언트 ID)만 돌려준다. */
function publicActions_() {
  return {
    'auth.config': function () { return { clientId: prop_(BO.PROPS.GOOGLE_CLIENT_ID), version: BO.VERSION }; }
  };
}

/**
 * 서버 단일 진입점(doPost에서 부른다).
 * request: { action, payload, idToken }
 * 관리자 작업은 Google 로그인(ID 토큰)을 확인한 이메일이 운영진 목록에 있어야 한다.
 */
function api(request) {
  request = request && typeof request === 'object' ? request : {};
  const action = String(request.action || '');
  const payload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) ? request.payload : {};
  const pub = publicActions_(), admin = adminActions_();
  const started = Date.now();
  try {
    if (hasOwn_(pub, action)) return { ok: true, data: pub[action](payload) };
    if (!hasOwn_(admin, action)) throw userError_('지원하지 않는 요청입니다.');
    BO_SIGNED_IN_EMAIL_ = verifyGoogleIdToken_(request.idToken);
    assertSignedInAdmin_();
    const data = admin[action](payload);
    const ms = Date.now() - started;
    // 느린 요청은 실행 기록(Apps Script → 실행)에 남겨 원인을 찾을 수 있게 한다.
    if (ms > 5000) logInfo_('api.slow', { action: action, ms: ms });
    return { ok: true, data: data, ms: ms };
  } catch (error) {
    const reference = uuid_('E').slice(0, 9);
    if (error.code !== 'NEED_LOGIN' && error.code !== 'NOT_ADMIN') logError_('api:' + action + ':' + reference + ':' + (Date.now() - started) + 'ms', error);
    return { ok: false, message: errorMessage_(error), code: error.code || '', reference: reference };
  } finally {
    BO_SIGNED_IN_EMAIL_ = '';
  }
}
