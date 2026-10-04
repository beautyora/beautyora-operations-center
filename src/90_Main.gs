/**
 * 웹앱 진입점과 API 라우터.
 * 운영센터는 내부 직원 전용이다. 화면에서 부를 수 있는 서버 함수는 api() 하나뿐이고, 요청마다 관리자를 확인한다.
 */

function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.version = BO.VERSION;
  const output = template.evaluate()
    .setTitle('뷰티오라 운영센터')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  if (prop_(BO.PROPS.ALLOW_EMBED) === 'true') output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return output;
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
    'products.main': apiMainProductsStatus_,
    'products.mainBuild': apiMainProductsBuild_,
    'system.health': function () { return healthCheck_(); },
    'system.setup': function () { return setupSystem_(); },
    'system.refresh': function () { bumpCache_('brand', 'activity', 'source'); return { refreshed: true }; }
  };
}

/**
 * 화면 → 서버 단일 진입점.
 * request: { action, payload }
 * 응답: { ok: true, data } | { ok: false, message, code }
 */
function api(request) {
  request = request && typeof request === 'object' ? request : {};
  const action = String(request.action || '');
  const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
  const admin = adminActions_();
  try {
    if (!hasOwn_(admin, action)) throw userError_('지원하지 않는 요청입니다.');
    assertAdmin_();
    return { ok: true, data: admin[action](payload) };
  } catch (error) {
    const reference = uuid_('E').slice(0, 9);
    logError_('api:' + action + ':' + reference, error);
    return { ok: false, message: errorMessage_(error), code: error.code || '', reference: reference };
  }
}
