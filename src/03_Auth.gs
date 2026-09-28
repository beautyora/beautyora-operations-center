/**
 * 권한 확인.
 * - 관리자 API: 접속한 Google 계정이 BO_ADMIN_EMAILS에 있어야 한다.
 * - 파트너 API: 유효한 상품등록 링크 토큰이 있어야 한다.
 * - 편집기·트리거 전용 함수: 소유자 실행 또는 설치된 트리거에서만 동작한다.
 * google.script.run으로는 이름이 _로 끝나지 않는 모든 함수를 부를 수 있으므로,
 * 공개 함수는 반드시 이 파일의 확인 함수 중 하나를 먼저 호출한다.
 */

function activeEmail_() {
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
