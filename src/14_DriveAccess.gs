/**
 * Drive 공유 권한. Google Drive 자체 공유 권한(편집자)만 쓰며, 운영센터는 공유 창에서 하는 일을 대신 누른다.
 * - 운영진: 브랜드 자료 최상위 폴더(BO_ROOT_FOLDER_ID)의 편집자. 하위 브랜드 폴더 전체에 그대로 적용된다.
 * - 브랜드: Notion '자료 공유 이메일'에 적힌 Google 계정을 그 브랜드 폴더의 편집자로. 공동 폴더는 소속 브랜드 이메일을 합친다.
 * 권한을 넓히거나 줄이는 일은 미리보기를 보고 관리자가 확인했을 때만 한다(자동 실행 없음).
 * 브랜드 권한을 뺄 때는 운영센터가 추가했던 권한만 뺀다. 소유자·운영진·실행 계정 권한은 건드리지 않는다.
 */
const BO_SHARE = Object.freeze({
  ADDED_PREFIX: 'BO_SHARE_ADDED_',
  RANK: { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5, owner: 6 },
  BRAND_MESSAGE: '뷰티오라 입점 자료 폴더를 공유드립니다. 기준 시트 작성과 자료 업로드를 이 폴더에서 해 주세요.'
});

function driveRootId_() {
  const id = prop_(BO.PROPS.ROOT_FOLDER_ID);
  if (!id) throw userError_('브랜드 자료 루트 폴더가 설정되지 않았습니다. 스크립트 속성 BO_ROOT_FOLDER_ID를 확인해 주세요.');
  return id;
}

/** { 이메일: { id, role } } — 사용자 권한만(링크 공유·그룹·도메인은 제외). */
function driveUserPermissions_(fileId) {
  const map = {};
  let pageToken = '';
  do {
    const res = Drive.Permissions.list(fileId, { fields: 'nextPageToken, permissions(id,type,role,emailAddress)', supportsAllDrives: true, pageToken: pageToken || undefined });
    (res.permissions || []).forEach(function (p) {
      const email = String(p.emailAddress || '').toLowerCase();
      if (p.type === 'user' && email) map[email] = { id: p.id, role: p.role };
    });
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return map;
}

function driveCanEdit_(permission) {
  return !!permission && (BO_SHARE.RANK[permission.role] || 0) >= BO_SHARE.RANK.writer;
}

/** 편집자로 만든다. 이미 낮은 권한이 있으면 올린다. */
function driveGrantEditor_(fileId, email, current, notify, message) {
  if (driveCanEdit_(current)) return 'already';
  if (current) {
    Drive.Permissions.update({ role: 'writer' }, fileId, current.id, { supportsAllDrives: true });
    return 'upgraded';
  }
  const options = { sendNotificationEmail: !!notify, supportsAllDrives: true };
  if (notify && message) options.emailMessage = message;
  Drive.Permissions.create({ type: 'user', role: 'writer', emailAddress: email }, fileId, options);
  return 'added';
}

/* ---------- 운영진 ↔ 최상위 폴더 ---------- */

function adminAccessRows_() {
  const perms = driveUserPermissions_(driveRootId_());
  return adminEmails_().map(function (email) {
    const p = perms[email];
    return { email: email, role: p ? p.role : '', canEdit: driveCanEdit_(p) };
  });
}

function apiAdminsList_() {
  let rows, driveError = '';
  try { rows = adminAccessRows_(); } catch (error) {
    driveError = errorMessage_(error);
    rows = adminEmails_().map(function (email) { return { email: email, role: '', canEdit: false, unknown: true }; });
  }
  return { admins: rows, me: activeEmail_(), executor: effectiveEmail_(), driveError: driveError };
}

/**
 * 운영진 추가/삭제. 자기 자신은 지울 수 없고 운영진이 비지 않게 한다.
 * drive=true면 최상위 폴더 편집자 권한도 함께 추가/삭제한다(알림 메일 없음, 소유자·실행 계정 권한은 그대로).
 */
function apiAdminsUpdate_(payload) {
  const email = String(payload && payload.email || '').trim().toLowerCase();
  const op = String(payload && payload.op || '');
  const withDrive = !payload || payload.drive !== false;
  if (op !== 'add' && op !== 'remove') throw userError_('지원하지 않는 요청입니다.');
  if (!isEmail_(email)) throw userError_('Google 계정 이메일을 정확히 입력해 주세요.');
  return withLock_(function () {
    const list = adminEmails_();
    if (op === 'add') {
      if (list.indexOf(email) >= 0) throw userError_('이미 등록된 운영진입니다: ' + email);
      list.push(email);
    } else {
      if (email === activeEmail_()) throw userError_('지금 로그인한 계정은 지울 수 없습니다. 다른 운영진에게 요청해 주세요.');
      const at = list.indexOf(email);
      if (at < 0) throw userError_('등록되지 않은 계정입니다: ' + email);
      list.splice(at, 1);
      if (!list.length) throw userError_('운영진이 한 명 이상 있어야 합니다.');
    }
    props_().setProperty(BO.PROPS.ADMIN_EMAILS, list.join(', '));
    let drive = 'skipped', driveError = '';
    if (withDrive) {
      try {
        const rootId = driveRootId_();
        const current = driveUserPermissions_(rootId)[email];
        if (op === 'add') drive = driveGrantEditor_(rootId, email, current, false);
        else if (!current) drive = 'none';
        else if (current.role === 'owner' || email === effectiveEmail_()) drive = 'kept';
        else { Drive.Permissions.remove(rootId, current.id, { supportsAllDrives: true }); drive = 'removed'; }
      } catch (error) {
        logError_('admins.drive', error);
        driveError = errorMessage_(error);
      }
    }
    // 개인 이메일은 로그에 남기지 않는다.
    logInfo_('admins.' + op, { count: list.length, drive: drive });
    return Object.assign(apiAdminsList_(), { drive: drive, driveActionError: driveError });
  }, 15000);
}

/** 운영진인데 최상위 폴더 편집 권한이 없는 계정. apply=true면 편집자로 추가한다(알림 메일 없음). */
function apiAdminsDriveSync_(payload) {
  const apply = !!(payload && payload.apply);
  return withLock_(function () {
    const rootId = driveRootId_();
    const perms = driveUserPermissions_(rootId);
    const missing = adminEmails_().filter(function (email) { return !driveCanEdit_(perms[email]); });
    const results = [];
    if (apply) missing.forEach(function (email) {
      try { results.push({ email: email, result: driveGrantEditor_(rootId, email, perms[email], false) }); }
      catch (error) { results.push({ email: email, result: 'failed', message: errorMessage_(error) }); }
    });
    return { missing: missing, results: results, admins: apply ? adminAccessRows_() : null };
  }, 15000);
}

/* ---------- 브랜드 '자료 공유 이메일' ↔ 브랜드 폴더 ---------- */

function shareAddedList_(folderId) {
  try {
    const list = JSON.parse(prop_(BO_SHARE.ADDED_PREFIX + folderId) || '[]');
    return Array.isArray(list) ? list.filter(isEmail_) : [];
  } catch (ignored) { return []; }
}

function brandSharePlan_(code) {
  const schema = notionSchema_('brand');
  const brand = requireBrand_(code);
  const folderId = brandFolderUrlId_(brand.drive);
  if (!folderId) throw userError_('Notion에 구글 드라이브 폴더 주소가 없습니다: ' + brand.code);
  const members = listBrands_().filter(function (b) { return brandFolderUrlId_(b.drive) === folderId; });
  if (!members.some(function (b) { return b.code === brand.code; })) members.push(brand);
  // 브랜드 ID 순으로 읽어 결과(그리고 미리보기 확인값)가 항상 같게 한다.
  members.sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); });
  const admins = adminEmails_(), executor = effectiveEmail_();
  const invalid = [], staff = [], desired = [];
  members.forEach(function (b) {
    String(b.shareEmails || '').split(/[,\s;]+/).map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean).forEach(function (email) {
      if (!isEmail_(email)) { if (invalid.indexOf(email) < 0) invalid.push(email); return; }
      if (admins.indexOf(email) >= 0 || email === executor) { if (staff.indexOf(email) < 0) staff.push(email); return; }
      if (desired.indexOf(email) < 0) desired.push(email);
    });
  });
  const perms = driveUserPermissions_(folderId);
  const added = shareAddedList_(folderId);
  const add = desired.filter(function (e) { return !driveCanEdit_(perms[e]); }).map(function (e) { return { email: e, current: perms[e] ? perms[e].role : '' }; });
  const keep = desired.filter(function (e) { return driveCanEdit_(perms[e]); });
  const remove = added.filter(function (e) {
    return desired.indexOf(e) < 0 && perms[e] && perms[e].role !== 'owner' && admins.indexOf(e) < 0 && e !== executor;
  });
  const plan = {
    folderId: folderId, url: brand.drive,
    brands: members.map(function (b) { return { code: b.code, name: b.name }; }),
    add: add, remove: remove, keep: keep, invalid: invalid, staff: staff,
    missingProperty: !schema.ids.shareEmails
  };
  plan.hash = sha256_(JSON.stringify({ folderId: folderId, add: add, remove: remove }));
  return plan;
}

function apiBrandSharePreview_(payload) {
  // 반영할 때와 같은 기준이 되도록 Notion에서 새로 읽는다.
  bumpCache_('brand');
  return brandSharePlan_(payload && payload.code);
}

/** 미리보기와 같은 계획일 때만 실행한다. 그 사이 Notion·Drive가 바뀌었으면 다시 확인하게 한다. */
function apiBrandShareApply_(payload) {
  const notify = !payload || payload.notify !== false;
  return withLock_(function () {
    bumpCache_('brand');
    const plan = brandSharePlan_(payload && payload.code);
    if (!payload || payload.hash !== plan.hash) throw userError_('미리보기 이후 공유 대상이 바뀌었습니다. 다시 확인해 주세요.', 'PLAN_CHANGED');
    const perms = driveUserPermissions_(plan.folderId);
    const tracked = shareAddedList_(plan.folderId);
    const results = [];
    plan.add.forEach(function (item) {
      try {
        const result = driveGrantEditor_(plan.folderId, item.email, perms[item.email], notify, BO_SHARE.BRAND_MESSAGE);
        if (result === 'added' || result === 'upgraded') { if (tracked.indexOf(item.email) < 0) tracked.push(item.email); }
        results.push({ email: item.email, result: result });
      } catch (error) {
        results.push({ email: item.email, result: 'failed', message: errorMessage_(error) });
      }
    });
    plan.remove.forEach(function (email) {
      try {
        Drive.Permissions.remove(plan.folderId, perms[email].id, { supportsAllDrives: true });
        if (tracked.indexOf(email) >= 0) tracked.splice(tracked.indexOf(email), 1);
        results.push({ email: email, result: 'removed' });
      } catch (error) {
        results.push({ email: email, result: 'failed', message: errorMessage_(error) });
      }
    });
    // 이미 Drive에서 직접 지운 기록은 정리한다.
    const live = driveUserPermissions_(plan.folderId);
    const kept = tracked.filter(function (e) { return !!live[e]; });
    if (kept.length) props_().setProperty(BO_SHARE.ADDED_PREFIX + plan.folderId, JSON.stringify(kept));
    else props_().deleteProperty(BO_SHARE.ADDED_PREFIX + plan.folderId);
    logInfo_('brands.share', { folder: plan.folderId, added: results.filter(function (r) { return r.result === 'added' || r.result === 'upgraded'; }).length, removed: results.filter(function (r) { return r.result === 'removed'; }).length, failed: results.filter(function (r) { return r.result === 'failed'; }).length });
    bumpCache_('driveActivity');
    return { results: results, plan: brandSharePlan_(plan.brands[0].code) };
  }, 20000);
}
