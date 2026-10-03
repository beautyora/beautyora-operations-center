/**
 * 권한 확인.
 * - 관리자 API: 접속한 Google 계정이 BO_ADMIN_EMAILS에 있어야 한다.
 *   운영센터 전용 주소(doPost)에서는 Google 로그인(ID 토큰)으로 확인한 이메일을 쓴다.
 * - 파트너 API: 유효한 상품등록 링크 토큰이 있어야 한다.
 * - 편집기·트리거 전용 함수: 소유자 실행 또는 설치된 트리거에서만 동작한다.
 * google.script.run으로는 이름이 _로 끝나지 않는 모든 함수를 부를 수 있으므로,
 * 공개 함수는 반드시 이 파일의 확인 함수 중 하나를 먼저 호출한다.
 */

/** doPost에서 Google 로그인으로 확인한 관리자 이메일. 요청 하나를 처리하는 동안만 채워진다. */
let BO_SIGNED_IN_EMAIL_ = '';

function activeEmail_() {
  if (BO_SIGNED_IN_EMAIL_) return BO_SIGNED_IN_EMAIL_;
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (ignored) { return ''; }
}

function effectiveEmail_() {
  try { return String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (ignored) { return ''; }
}

function adminEmails_() {
  return prop_(BO.PROPS.ADMIN_EMAILS).split(',').map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
}

function isAdmin_() {
  const email = activeEmail_();
  return !!email && adminEmails_().indexOf(email) >= 0;
}

function assertAdmin_() {
  const email = activeEmail_();
  if (!adminEmails_().length) throw userError_('관리자 이메일이 설정되지 않았습니다. 스크립트 속성 BO_ADMIN_EMAILS를 먼저 설정해 주세요.', 'NO_ADMINS');
  if (!email) throw userError_('Google 로그인 정보를 확인할 수 없습니다. 운영센터 주소로 다시 로그인해 주세요.', 'NO_EMAIL');
  if (adminEmails_().indexOf(email) < 0) throw userError_('이 Google 계정(' + email + ')은 운영센터 관리자로 등록되어 있지 않습니다.', 'NOT_ADMIN');
  return email;
}

/** Apps Script 편집기에서 소유자가 직접 실행했거나 관리자가 실행한 경우만 허용. */
function assertOwnerOrAdmin_() {
  const active = activeEmail_();
  if (!active) throw userError_('실행한 Google 계정을 확인할 수 없습니다.', 'NO_EMAIL');
  if (active === effectiveEmail_() || adminEmails_().indexOf(active) >= 0) return active;
  throw userError_('소유자 또는 관리자만 실행할 수 있습니다.', 'NOT_ADMIN');
}

/** 설치형 트리거에서 호출된 경우에만 true. 웹에서 임의로 부른 호출을 거른다. */
function isProjectTrigger_(event) {
  const uid = event && event.triggerUid ? String(event.triggerUid) : '';
  if (!uid) return false;
  return ScriptApp.getProjectTriggers().some(function (trigger) { return String(trigger.getUniqueId()) === uid; });
}

/**
 * 운영센터 전용 주소에서 보낸 Google 로그인(ID 토큰)을 확인하고 이메일을 돌려준다.
 * 서명·만료는 Google tokeninfo가 확인하고, 이 운영센터의 클라이언트 ID로 발급된 토큰인지 여기서 본다.
 * 확인한 결과는 토큰 만료 전까지 캐시해 요청마다 Google을 부르지 않는다.
 */
function verifyGoogleIdToken_(idToken) {
  const needLogin = userError_('Google 로그인이 필요합니다. 다시 로그인해 주세요.', 'NEED_LOGIN');
  const clientId = prop_(BO.PROPS.GOOGLE_CLIENT_ID);
  if (!clientId) throw userError_('운영센터 로그인이 설정되지 않았습니다. 스크립트 속성 BO_GOOGLE_CLIENT_ID를 설정해 주세요.', 'NO_CLIENT_ID');
  idToken = String(idToken || '');
  if (idToken.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) throw needLogin;
  const key = cacheKey_('idt:' + sha256_(clientId + ':' + idToken));
  const cached = cache_().get(key);
  if (cached) return cached;
  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw needLogin;
  let info;
  try { info = JSON.parse(response.getContentText()); } catch (ignored) { throw needLogin; }
  const email = String(info.email || '').trim().toLowerCase();
  const expiresAt = Number(info.exp) * 1000;
  if (info.aud !== clientId) throw needLogin;
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') throw needLogin;
  if (String(info.email_verified) !== 'true' || !email || !(expiresAt > Date.now())) throw needLogin;
  const ttl = Math.min(21600, Math.floor((expiresAt - Date.now()) / 1000) - 30);
  if (ttl > 0) cache_().put(key, email, ttl);
  return email;
}
