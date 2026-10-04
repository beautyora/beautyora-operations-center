/** 초기 설정, 트리거, 연결 점검, 관리자 알림. */

/** 이 프로젝트가 설치하는 트리거. 목록에 없는 트리거(예전 입점 신청 폼 트리거 등)는 초기 설정이 지운다. */
const BO_TRIGGER_HANDLERS = Object.freeze(['scheduledHealthCheck', 'scheduledBrandFolders']);

function clearSchemaMemo_() {
  Object.keys(BO_MEMO_).forEach(function (key) { if (key.indexOf('schema:') === 0) delete BO_MEMO_[key]; });
  bumpCache_('source');
}

function installTriggers_(report) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (BO_TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) < 0) {
      ScriptApp.deleteTrigger(trigger);
      report.push('삭제: 예전 트리거 ' + trigger.getHandlerFunction());
    }
  });
  const has = function (handler) { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === handler; }); };
  if (!has('scheduledHealthCheck')) {
    ScriptApp.newTrigger('scheduledHealthCheck').timeBased().everyHours(6).create();
    report.push('설치: 6시간마다 연결 점검 트리거');
  }
  if (!has(BO_FOLDER_TRIGGER)) {
    ScriptApp.newTrigger(BO_FOLDER_TRIGGER).timeBased().everyMinutes(1).create();
    report.push('설치: 1분마다 브랜드 드라이브 폴더 만들기 트리거');
  }
}

const BO_CONNECT_HINT = 'Notion에서 "뷰티오라 대시보드" 페이지 오른쪽 위 ··· → 연결 → 운영센터 통합을 추가한 뒤 초기 설정을 다시 실행해 주세요.';

/**
 * 초기 설정. 단계마다 따로 실행해서 한 단계가 실패해도 나머지는 진행하고,
 * 실패한 단계와 해결 방법을 결과에 남긴다.
 */
function setupSystem_() {
  const report = [];
  notionRequest_('get', '/users/me');
  notionSourceId_('brand');
  const step = function (label, fn) {
    try { fn(report); } catch (error) {
      const notFound = error && error.status === 404;
      report.push('실패: ' + label + ' — ' + errorMessage_(error) + (notFound ? ' ' + BO_CONNECT_HINT : ''));
    }
  };
  clearSchemaMemo_();
  step('Notion 브랜드 목록 확인', function () { notionSchema_('brand'); });
  step('트리거 설치', installTriggers_);
  const health = healthCheck_();
  if (!report.length) report.push('변경할 설정이 없습니다. 이미 준비되어 있습니다.');
  return { report: report, health: health, ok: !report.some(function (line) { return line.indexOf('실패:') === 0; }) };
}

/* ---------- 연결 점검 ---------- */

function healthCheck_() {
  const results = [];
  const add = function (target, status, message) { results.push({ target: target, status: status, message: message }); };
  add('관리자', adminEmails_().length ? '정상' : '오류', adminEmails_().length ? adminEmails_().length + '명 등록' : 'BO_ADMIN_EMAILS가 비어 있습니다.');
  let notionOk = false;
  try {
    const me = notionRequest_('get', '/users/me');
    notionOk = true;
    add('Notion 연결', '정상', (me.name || '통합') + ' 연결됨');
  } catch (error) {
    add('Notion 연결', '오류', errorMessage_(error));
  }
  if (notionOk) {
    Object.keys(BO_SCHEMAS).forEach(function (kind) {
      const spec = BO_SCHEMAS[kind];
      const required = kind === 'brand';
      try {
        const schema = notionSchema_(kind, true);
        if (!schema) { add(spec.label, required ? '오류' : '주의', spec.prop + ' 미설정' + (required ? '' : ' (변경 이력에서 이 DB를 볼 수 없습니다)')); return; }
        const missingOptional = Object.keys(spec.fields).filter(function (key) { return !schema.ids[key]; }).map(function (key) { return spec.fields[key][1][0]; });
        add(spec.label, missingOptional.length ? '주의' : '정상', missingOptional.length ? '없는 선택 속성: ' + missingOptional.slice(0, 6).join(', ') : '연결됨');
      } catch (error) {
        add(spec.label, '오류', errorMessage_(error) + (error && error.status === 404 ? ' (Notion에서 이 DB나 상위 페이지의 ··· → 연결에 운영센터 통합을 추가해 주세요)' : ''));
      }
    });
  }
  try {
    add('Google Drive', '정상', driveRoot_().getName());
  } catch (error) {
    add('Google Drive', '오류', errorMessage_(error));
  }
  const handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  const legacy = handlers.filter(function (h) { return BO_TRIGGER_HANDLERS.indexOf(h) < 0; });
  if (legacy.length) add('트리거', '주의', '예전 트리거가 남아 있습니다: ' + legacy.join(', ') + ' (초기 설정을 실행하면 정리됩니다)');
  else if (BO_TRIGGER_HANDLERS.some(function (h) { return handlers.indexOf(h) < 0; })) add('트리거', '주의', '빠진 트리거가 있습니다. 초기 설정을 실행해 주세요.');
  else add('트리거', '정상', handlers.length + '개 설치됨');
  return { checkedAt: now_(), results: results, ok: !results.some(function (r) { return r.status === '오류'; }) };
}

function notifyAdmins_(subject, body) {
  try {
    const key = cacheKey_('notify:' + sha256_(subject));
    if (cache_().get(key)) return;
    const recipients = adminEmails_();
    if (!recipients.length || MailApp.getRemainingDailyQuota() < 1) return;
    MailApp.sendEmail(recipients.join(','), '[뷰티오라 운영센터] ' + subject, body);
    cache_().put(key, '1', 43200);
  } catch (error) {
    logError_('notifyAdmins_', error);
  }
}

/* ---------- 편집기·트리거에서 실행하는 공개 함수 ---------- */

/** Apps Script 편집기에서 한 번 실행: 연결을 확인하고 트리거를 준비한다. */
function setupBeautyora() {
  assertOwnerOrAdmin_();
  const result = setupSystem_();
  console.log(result.report.join('\n'));
  console.log(JSON.stringify(result.health.results, null, 2));
  return result;
}

function runHealthCheck() {
  assertOwnerOrAdmin_();
  const result = healthCheck_();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function scheduledHealthCheck(e) {
  if (!isProjectTrigger_(e)) throw new Error('트리거에서만 실행할 수 있습니다.');
  const result = healthCheck_();
  if (!result.ok) {
    notifyAdmins_('연결 점검에서 오류가 발견되었습니다', result.results.filter(function (r) { return r.status === '오류'; })
      .map(function (r) { return '- ' + r.target + ': ' + r.message; }).join('\n') + '\n\n운영센터 → 설정 → 연결 상태에서 확인해 주세요.');
  }
}
