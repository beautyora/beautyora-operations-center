/**
 * Drive 공유 권한. Google Drive 자체 공유 권한(편집자)만 쓰며, 운영센터는 공유 창에서 하는 일을 대신 누른다.
 * - 운영진: 브랜드 자료 최상위 폴더(BO_ROOT_FOLDER_ID)의 편집자. 하위 브랜드 폴더 전체에 그대로 적용된다.
 * - 브랜드: Notion '자료 공유 이메일'에 있으면 그 브랜드 폴더의 편집자, 없으면 권한 없음(공유 창에서 저장할 때 맞춘다).
 * 권한은 관리자가 화면에서 저장할 때만 바뀐다(자동 실행 없음). 소유자·운영진·직원·배포 계정 권한은 건드리지 않는다.
 */
const BO_SHARE = Object.freeze({
  RANK: { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5, owner: 6 }
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
/*
 * 규칙은 하나: Notion '자료 공유 이메일'에 있는 Google 계정은 그 브랜드 폴더의 편집자, 없으면 권한 없음.
 * 공유 창에서 이메일을 고치고 저장하면 Notion에 쓰고 Drive를 그 목록에 맞춘다. 알림 메일은 보내지 않는다(영업 직원이 직접 안내).
 * 같은 폴더를 쓰는 브랜드(공동 회사 폴더)의 이메일도 그 폴더에 접근한다.
 * 건드리지 않는 권한: 소유자, 운영진, BO_STAFF_EMAILS 직원, 배포 계정, 상위 폴더에서 물려받은 권한, 링크 공유.
 */

function shareParseEmails_(text) {
  const valid = [], invalid = [];
  String(text || '').split(/[,\s;]+/).map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean).forEach(function (email) {
    const list = isEmail_(email) ? valid : invalid;
    if (list.indexOf(email) < 0) list.push(email);
  });
  return { valid: valid, invalid: invalid };
}

/**
 * 공유 창이 건드리지 않는 계정: 운영진, BO_STAFF_EMAILS 직원, 배포 계정, 최상위 폴더에 공유된 계정.
 * 최상위 폴더 권한은 모든 브랜드 폴더가 물려받는데, 내 드라이브에서는 물려받은 권한인지 Drive가 알려 주지 않으므로 이렇게 거른다.
 */
function shareProtectedEmails_() {
  let inherited = [];
  try { inherited = Object.keys(driveUserPermissions_(driveRootId_())); } catch (error) { logError_('share:root', error); }
  return adminEmails_().concat(parseEmails_(prop_(BO.PROPS.STAFF_EMAILS)), [effectiveEmail_()], inherited).filter(Boolean)
    .filter(function (v, i, all) { return all.indexOf(v) === i; });
}

/** 브랜드 폴더 공유 상태. 이 폴더에 직접 공유된 계정과 inherited 표시를 함께 본다. */
function brandShareState_(code) {
  const schema = notionSchema_('brand');
  const brand = requireBrand_(code);
  const folderId = brandFolderUrlId_(brand.drive);
  if (!folderId) throw userError_('Notion에 구글 드라이브 폴더 주소가 없습니다: ' + brand.code);
  const others = listBrands_().filter(function (b) { return b.code !== brand.code && brandFolderUrlId_(b.drive) === folderId; })
    .sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); });
  const perms = driveUserPermissions_(folderId);
  const direct = driveDirectUserPermissions_(folderId);
  const protectedEmails = shareProtectedEmails_();
  const mine = shareParseEmails_(brand.shareEmails);
  const otherEmails = [];
  others.forEach(function (b) { shareParseEmails_(b.shareEmails).valid.forEach(function (e) { if (otherEmails.indexOf(e) < 0) otherEmails.push(e); }); });
  // Notion에는 없지만 이 폴더에 직접 공유돼 있는 계정. 저장하면 목록에 없는 계정은 권한이 빠지므로 처음부터 목록에 보여 준다.
  const driveOnly = Object.keys(direct).filter(function (e) {
    return direct[e].role !== 'owner' && protectedEmails.indexOf(e) < 0 && mine.valid.indexOf(e) < 0 && otherEmails.indexOf(e) < 0;
  }).sort();
  const access = {};
  Object.keys(perms).forEach(function (e) { access[e] = driveCanEdit_(perms[e]) ? 'editor' : 'viewer'; });
  return {
    brand: { code: brand.code, name: brand.name }, folderId: folderId, url: brand.drive,
    notionText: brand.shareEmails || '', emails: mine.valid, invalid: mine.invalid, driveOnly: driveOnly,
    others: others.map(function (b) { return { code: b.code, name: b.name, emails: shareParseEmails_(b.shareEmails).valid }; }),
    access: access, staff: protectedEmails.filter(function (e) { return !!perms[e]; }),
    missingProperty: !schema.ids.shareEmails
  };
}

/** 이 폴더에 직접 준 사용자 권한만(상위 폴더에서 물려받은 권한 제외). Drive가 알려 주지 않으면 전체를 직접 권한으로 본다. */
function driveDirectUserPermissions_(fileId) {
  const map = {};
  let pageToken = '';
  do {
    const res = Drive.Permissions.list(fileId, { fields: 'nextPageToken, permissions(id,type,role,emailAddress,permissionDetails(inherited))', supportsAllDrives: true, pageToken: pageToken || undefined });
    (res.permissions || []).forEach(function (p) {
      const email = String(p.emailAddress || '').toLowerCase();
      const inherited = (p.permissionDetails || []).length > 0 && (p.permissionDetails || []).every(function (d) { return d.inherited; });
      if (p.type === 'user' && email && !inherited) map[email] = { id: p.id, role: p.role };
    });
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return map;
}

function apiBrandShareGet_(payload) {
  // Notion에서 방금 고친 값도 보이도록 이 브랜드만 다시 읽는다(목록 전체를 지우지 않는다).
  refreshBrand_(requireBrand_(payload && payload.code).pageId);
  return brandShareState_(payload && payload.code);
}

/**
 * 공유 창 저장: Notion '자료 공유 이메일'을 고치고 Drive 편집자를 그 목록에 맞춘다.
 * before는 창을 열 때의 Notion 값이다. 그 사이 Notion에서 바뀌었으면 덮어쓰지 않고 다시 열게 한다.
 */
function apiBrandShareSave_(payload) {
  payload = payload || {};
  const parsed = shareParseEmails_(payload.emails);
  if (parsed.invalid.length) throw userError_('이메일 형식을 확인해 주세요: ' + parsed.invalid.join(', '), 'BAD_EMAIL');
  return withLock_(function () {
    const schema = notionSchema_('brand');
    refreshBrand_(requireBrand_(payload.code).pageId);
    if (!schema.ids.shareEmails) throw userError_('Notion 브랜드 목록에 "자료 공유 이메일"(텍스트) 속성이 없습니다.');
    const state = brandShareState_(payload.code);
    if (String(payload.before == null ? '' : payload.before) !== String(state.notionText)) {
      throw userError_('창을 연 뒤 Notion의 자료 공유 이메일이 바뀌었습니다. 창을 다시 열어 주세요.', 'CHANGED');
    }
    const text = parsed.valid.join(', ');
    const brand = requireBrand_(payload.code);
    if (text !== String(state.notionText).trim()) refreshBrand_(brand.pageId, notionPatch_(brand.pageId, notionProps_(schema, { shareEmails: text })));

    const protectedEmails = shareProtectedEmails_();
    const desired = parsed.valid.slice();
    state.others.forEach(function (b) { b.emails.forEach(function (e) { if (desired.indexOf(e) < 0) desired.push(e); }); });
    const perms = driveUserPermissions_(state.folderId), direct = driveDirectUserPermissions_(state.folderId);
    const results = [];
    desired.filter(function (e) { return protectedEmails.indexOf(e) < 0; }).forEach(function (email) {
      try {
        const result = driveGrantEditor_(state.folderId, email, direct[email] || (driveCanEdit_(perms[email]) ? perms[email] : null), false);
        if (result !== 'already') results.push({ email: email, result: result });
      } catch (error) {
        const noAccount = /no google account|notify people/i.test(errorMessage_(error));
        results.push({ email: email, result: 'failed', message: noAccount ? 'Google 계정이 아닌 이메일입니다. 이 주소로 Google 계정을 만든 뒤 다시 저장해 주세요.' : errorMessage_(error) });
      }
    });
    Object.keys(direct).forEach(function (email) {
      if (desired.indexOf(email) >= 0 || protectedEmails.indexOf(email) >= 0 || direct[email].role === 'owner') return;
      try {
        Drive.Permissions.remove(state.folderId, direct[email].id, { supportsAllDrives: true });
        results.push({ email: email, result: 'removed' });
      } catch (error) {
        results.push({ email: email, result: 'failed', message: errorMessage_(error) });
      }
    });
    logInfo_('brands.share', { folder: state.folderId, added: results.filter(function (r) { return r.result === 'added' || r.result === 'upgraded'; }).length, removed: results.filter(function (r) { return r.result === 'removed'; }).length, failed: results.filter(function (r) { return r.result === 'failed'; }).length });
    return { results: results, state: brandShareState_(payload.code) };
  }, 20000);
}
