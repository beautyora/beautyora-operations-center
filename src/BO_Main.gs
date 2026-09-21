function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Index');
  const params = e && e.parameter ? e.parameter : {};
  // 주소만 열면 관리자 화면, 발급된 token이 있을 때만 브랜드 상품등록 화면으로 이동한다.
  template.initialView = params.token || params.view === 'partner' ? 'partner' : 'admin';
  template.token = sanitize_(params.token);
  return template.evaluate()
    .setTitle('뷰티오라 운영센터')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('뷰티오라 운영센터')
    .addItem('초기 설정', 'setupBeautyoraSystem')
    .addItem('연결 상태 점검', 'runHealthCheck')
    .addItem('웹앱 주소 확인', 'showWebAppUrl')
    .addToUi();
}

function showWebAppUrl() {
  SpreadsheetApp.getUi().alert(ScriptApp.getService().getUrl() || '웹앱으로 먼저 배포해 주세요.');
}

function getAppBootstrap(request) {
  try {
    if (request && request.view === 'partner') return getPartnerBootstrap_(request.token);
    assertAdmin_();
    return { ok: true, view: 'admin', version: BOPS.VERSION, user: getCurrentUser_(), data: getAdminDashboard_() };
  } catch (error) {
    logException_(error, 'getAppBootstrap');
    return { ok: false, message: friendlyError_(error) };
  }
}

function getAdminSection(section, params) {
  assertAdmin_();
  switch (section) {
    case 'dashboard': return getAdminDashboard_();
    case 'intake': return listBrandIntake_(params || {});
    case 'brands': return listBrands_(params || {});
    case 'products': return { products: listProducts_(params || {}) };
    case 'productSubmissions': return { submissions: listSubmissions_(params || {}), fields: (getSettings_().fields || []) };
    case 'files': return listFiles_(params || {});
    case 'alerts': return listAlerts_(params || {});
    case 'settings': return getSettings_();
    default: throw new Error('지원하지 않는 화면입니다.');
  }
}

function saveAdminAction(action, payload) {
  assertAdmin_();
  switch (action) {
    case 'syncBrandIntake': return syncBrandIntake_();
    case 'reviewBrandIntake': return reviewBrandIntake_(payload);
    case 'issuePartnerLink': return issuePartnerLink_(payload.brandCode, payload.expiryDate);
    case 'disablePartnerLink': return setPartnerLinkStatus_(payload.token, '중지');
    case 'reviewSubmission': return reviewSubmission_(payload);
    case 'updateProduct': return updateProduct_(payload);
    case 'saveFields': return saveFieldSettings_(payload.fields || []);
    case 'saveAdminEmails': return saveAdminEmails_(payload.emails || []);
    case 'runHealthCheck': return runHealthCheck();
    case 'resolveAlert': return resolveAlert_(payload.alertId);
    default: throw new Error('지원하지 않는 작업입니다.');
  }
}

function getActiveUserEmail_() {
  return (Session.getActiveUser().getEmail() || '').trim().toLowerCase();
}

function getCurrentUser_() {
  const email = getActiveUserEmail_();
  return { email: email || 'Google 계정 확인 불가', name: '뷰티오라 관리자' };
}

function assertAdmin_() {
  const allowed = (PropertiesService.getScriptProperties().getProperty(BOPS.PROPS.ADMIN_EMAILS) || '')
    .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const email = getActiveUserEmail_();
  if (!allowed.length) throw new Error('관리자 이메일이 설정되지 않았습니다. BO_ADMIN_EMAILS를 먼저 설정해 주세요.');
  if (!email) throw new Error('Google 로그인 이메일을 확인할 수 없습니다. 웹 앱을 접속 사용자 권한으로 배포한 뒤 다시 로그인해 주세요.');
  if (!allowed.includes(email)) throw new Error('이 Google 계정은 관리자 목록에 등록되어 있지 않습니다: ' + email);
}

function sanitize_(value) {
  return String(value || '').replace(/[<>]/g, '').slice(0, 500);
}

function friendlyError_(error) {
  const message = error && error.message ? error.message : String(error || '알 수 없는 오류');
  return message.replace(/^Exception:\s*/, '');
}
