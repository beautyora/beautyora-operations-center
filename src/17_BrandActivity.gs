/**
 * 홈: 브랜드 자료 현황.
 * 브랜드 Drive 폴더(하위 폴더 한 단계까지)의 파일과 기준 시트(상품정보목록)를 읽어
 * 브랜드가 파일을 올렸는지, 기준 시트를 작성 중인지 보여 준다. Drive·Notion에는 아무것도 쓰지 않는다.
 * - 직원 판단: 운영진(BO_ADMIN_EMAILS)과 BO_STAFF_EMAILS, 지금 보고 있는 계정. 그 밖의 계정·익명은 브랜드 활동이다.
 * - '폴더를 열어 보기만 한 것'은 Google이 알려 주지 않아 알 수 없다. 처음 활동한 시각으로 대신한다.
 * - 화면을 열어 둔 동안 1분마다 다시 묻는다(시간 트리거를 쓰지 않아 하루 실행 한도를 쓰지 않는다).
 */
const BO_ACTIVITY = Object.freeze({
  TTL: 45,
  SHEET_HINT: '상품정보목록',
  SHEET_TAB: '상품리스트',
  BATCH: 40,
  PARSE_LIMIT: 4,
  PARSE_BUDGET_MS: 20000,
  FOLDER: 'application/vnd.google-apps.folder',
  GSHEET: 'application/vnd.google-apps.spreadsheet',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ORDER: ['review', 'writing', 'uploaded', 'waiting', 'no_sheet', 'no_folder']
});

function activityStaffEmails_() {
  const extra = prop_(BO.PROPS.STAFF_EMAILS).split(/[,\s;]+/).map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
  return adminEmails_().concat(extra, [effectiveEmail_(), activeEmail_()].filter(Boolean));
}

/** Drive 사용자 정보가 직원인지. 정보가 없으면(익명 편집 등) 직원이 아니다. */
function activityIsStaff_(user, staff) {
  if (!user) return false;
  if (user.me) return true;
  const email = String(user.emailAddress || '').toLowerCase();
  return !!email && staff.indexOf(email) >= 0;
}

function activityActorName_(user) {
  if (!user) return '익명';
  return clean_(user.displayName) || '익명';
}

function activityListAll_(q) {
  const out = [];
  let pageToken = '';
  do {
    const res = Drive.Files.list({
      q: q, pageSize: 1000, pageToken: pageToken || undefined, supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: 'nextPageToken, files(id,name,mimeType,parents,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me))'
    });
    (res.files || []).forEach(function (f) { out.push(f); });
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return out;
}

function activityParentsClause_(ids) {
  return '(' + ids.map(function (id) { return "'" + id + "' in parents"; }).join(' or ') + ')';
}

/** 브랜드 폴더 ID 목록 → { 폴더 ID: 파일[] } (하위 폴더 한 단계 포함). Drive 요청은 묶어서 보낸다. */
function activityFolderFiles_(folderIds) {
  const owner = {};
  folderIds.forEach(function (id) { owner[id] = id; });
  for (let i = 0; i < folderIds.length; i += BO_ACTIVITY.BATCH) {
    const batch = folderIds.slice(i, i + BO_ACTIVITY.BATCH);
    activityListAll_("mimeType = '" + BO_ACTIVITY.FOLDER + "' and trashed = false and " + activityParentsClause_(batch)).forEach(function (sub) {
      const parent = (sub.parents || []).find(function (p) { return folderIds.indexOf(p) >= 0; });
      if (parent && !owner[sub.id]) owner[sub.id] = parent;
    });
  }
  const all = Object.keys(owner);
  const files = {};
  folderIds.forEach(function (id) { files[id] = []; });
  for (let i = 0; i < all.length; i += BO_ACTIVITY.BATCH) {
    activityListAll_("mimeType != '" + BO_ACTIVITY.FOLDER + "' and trashed = false and " + activityParentsClause_(all.slice(i, i + BO_ACTIVITY.BATCH))).forEach(function (file) {
      const parent = (file.parents || []).find(function (p) { return owner[p]; });
      if (!parent) return;
      const list = files[owner[parent]];
      if (!list.some(function (f) { return f.id === file.id; })) list.push(file);
    });
  }
  return files;
}

/**
 * 기준 시트 '상품리스트' 탭의 값(표시값 2차원 배열)에서 작성된 상품 행과 필수 칸 누락을 센다.
 * 머리글은 '번호' 행과 그 아래 행(브랜드명·상품명·바코드번호·매입 시·위탁 시)을 합쳐 읽고, '예시' 행은 건너뛴다.
 */
function productSheetProgress_(rows) {
  const norm = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ''); };
  const at = rows.findIndex(function (row) { return row.some(function (v) { return norm(v) === '번호'; }); });
  if (at < 0) return { rows: 0, incomplete: 0, missing: {}, unreadable: true };
  const top = rows[at], sub = rows[at + 1] || [];
  const width = Math.max(top.length, sub.length);
  const labels = [];
  for (let c = 0; c < width; c++) labels.push(norm(sub[c]) || norm(top[c]));
  const col = function (pattern) { return labels.findIndex(function (v) { return pattern.test(v); }); };
  const c = {
    no: top.findIndex(function (v) { return norm(v) === '번호'; }),
    brand: col(/^브랜드명/), name: col(/상품명/), barcode: col(/바코드/), online: col(/온라인최저가/),
    type: col(/거래유형/), buy: col(/^매입시/), consign: col(/^위탁시/)
  };
  const value = function (row, key) { return c[key] >= 0 ? norm(row[c[key]]) : ''; };
  const missing = {};
  let filled = 0, incomplete = 0;
  rows.slice(at + 2).forEach(function (row) {
    if (!/^\d+$/.test(norm(row[c.no]))) return;
    if (!value(row, 'brand') && !value(row, 'name') && !value(row, 'barcode')) return;
    filled++;
    const need = { '상품명': value(row, 'name'), '바코드': value(row, 'barcode'), '거래 유형': value(row, 'type'), '온라인 최저가': value(row, 'online') };
    const type = value(row, 'type');
    if (/매입|공통/.test(type)) need['매입 공급가'] = value(row, 'buy');
    if (/위탁|공통/.test(type)) need['위탁 공급가'] = value(row, 'consign');
    const gaps = Object.keys(need).filter(function (k) { return !need[k]; });
    if (gaps.length) incomplete++;
    gaps.forEach(function (k) { missing[k] = (missing[k] || 0) + 1; });
  });
  return { rows: filled, incomplete: incomplete, missing: missing };
}

/** 기준 시트를 읽는다. 엑셀이면 내 드라이브에 임시 Google 시트로 바꿔 읽고 바로 휴지통으로 보낸다(원본·브랜드 폴더는 그대로). */
function activityReadSheet_(file) {
  let copyId = '';
  try {
    let book;
    if (file.mimeType === BO_ACTIVITY.GSHEET) book = SpreadsheetApp.openById(file.id);
    else {
      copyId = Drive.Files.copy({ name: '[임시] 운영센터 자료 확인', mimeType: BO_ACTIVITY.GSHEET, parents: ['root'] }, file.id, { supportsAllDrives: true }).id;
      book = SpreadsheetApp.openById(copyId);
    }
    const tab = book.getSheetByName(BO_ACTIVITY.SHEET_TAB) || book.getSheets().find(function (sheet) {
      return !productSheetProgress_(sheet.getDataRange().getDisplayValues()).unreadable;
    });
    if (!tab) return { rows: 0, incomplete: 0, missing: {}, unreadable: true };
    return productSheetProgress_(tab.getDataRange().getDisplayValues());
  } finally {
    if (copyId) { try { DriveApp.getFileById(copyId).setTrashed(true); } catch (ignored) {} }
  }
}

function activityTime_(value) {
  const t = Date.parse(value || '');
  return isFinite(t) ? t : 0;
}

/** 폴더 하나의 파일 목록 → 상태. parse(file)는 기준 시트 진행 상황(없으면 null = 아직 확인 전)을 돌려준다. */
function activityFolderState_(files, staff, parse) {
  const isSheet = function (f) { return String(f.name || '').indexOf(BO_ACTIVITY.SHEET_HINT) >= 0 && (f.mimeType === BO_ACTIVITY.XLSX || f.mimeType === BO_ACTIVITY.GSHEET); };
  const sheets = files.filter(isSheet).sort(function (a, b) { return activityTime_(b.modifiedTime) - activityTime_(a.modifiedTime); });
  const events = [];
  let uploads = 0, staffFiles = 0;
  files.filter(function (f) { return !isSheet(f); }).forEach(function (f) {
    const actor = (f.owners && f.owners[0]) || f.lastModifyingUser;
    if (activityIsStaff_(actor, staff)) { staffFiles++; return; }
    uploads++;
    events.push({ at: activityTime_(f.createdTime) || activityTime_(f.modifiedTime), last: Math.max(activityTime_(f.createdTime), activityTime_(f.modifiedTime)), who: activityActorName_(actor), what: '파일 올림' });
  });
  let sheet = null;
  if (sheets.length) {
    const f = sheets[0];
    const editedLater = activityTime_(f.modifiedTime) - activityTime_(f.createdTime) > 60000;
    const byBrand = editedLater && !activityIsStaff_(f.lastModifyingUser, staff);
    sheet = { id: f.id, name: f.name, url: f.webViewLink || '', modifiedAt: f.modifiedTime || '', byBrand: byBrand, editedByStaff: editedLater && !byBrand, count: sheets.length };
    if (byBrand) {
      events.push({ at: activityTime_(f.modifiedTime), last: activityTime_(f.modifiedTime), who: activityActorName_(f.lastModifyingUser), what: '시트 작성' });
      const progress = parse(f);
      if (progress) Object.assign(sheet, { rows: progress.rows, incomplete: progress.incomplete, missing: progress.missing, unreadable: !!progress.unreadable });
      else sheet.pending = true;
    }
  }
  events.sort(function (a, b) { return b.last - a.last; });
  const firstAt = events.reduce(function (min, e) { return e.at && (!min || e.at < min) ? e.at : min; }, 0);
  let status = sheet ? 'waiting' : 'no_sheet';
  if (uploads) status = 'uploaded';
  if (sheet && sheet.byBrand) status = sheet.rows > 0 && sheet.incomplete === 0 && !sheet.unreadable ? 'review' : 'writing';
  return {
    status: status, sheet: sheet, uploads: uploads, staffFiles: staffFiles,
    lastActivityAt: events.length ? new Date(events[0].last).toISOString() : '',
    lastActor: events.length ? events[0].who : '', lastAction: events.length ? events[0].what : '',
    firstActivityAt: firstAt ? new Date(firstAt).toISOString() : ''
  };
}

function brandActivitySnapshot_() {
  const brands = listBrands_();
  const staff = activityStaffEmails_();
  const groups = {}, order = [], noFolder = [];
  brands.forEach(function (b) {
    const id = brandFolderUrlId_(b.drive);
    if (!id) { noFolder.push(b); return; }
    if (!groups[id]) { groups[id] = { folderId: id, url: b.drive, brands: [] }; order.push(id); }
    groups[id].brands.push(b);
  });
  const files = order.length ? activityFolderFiles_(order) : {};
  const started = Date.now();
  let parsed = 0, pending = 0;
  const parse = function (file) {
    const key = file.id + ':' + (file.modifiedTime || '');
    const hit = cacheGetJson_('activitySheet', key);
    if (hit) return hit;
    if (parsed >= BO_ACTIVITY.PARSE_LIMIT || Date.now() - started > BO_ACTIVITY.PARSE_BUDGET_MS) { pending++; return null; }
    parsed++;
    let progress;
    try { progress = activityReadSheet_(file); } catch (error) {
      logError_('activity:sheet', error);
      progress = { rows: 0, incomplete: 0, missing: {}, unreadable: true };
    }
    return cachePutJson_('activitySheet', key, progress, 21600);
  };
  const rank = function (s) { return BO_ACTIVITY.ORDER.indexOf(s); };
  const rows = order.map(function (id) {
    const g = groups[id];
    const members = g.brands.slice().sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); });
    return Object.assign({
      folderId: id, url: g.url,
      brands: members.map(function (b) { return { code: b.code, name: b.name, url: b.url }; }),
      company: Array.from(new Set(members.map(function (b) { return b.company; }).filter(Boolean))).join(' · ')
    }, activityFolderState_(files[id] || [], staff, parse));
  }).concat(noFolder.map(function (b) {
    return { folderId: '', url: '', brands: [{ code: b.code, name: b.name, url: b.url }], company: b.company || '', status: 'no_folder', sheet: null, uploads: 0, staffFiles: 0, lastActivityAt: '', lastActor: '', lastAction: '', firstActivityAt: '' };
  })).sort(function (a, b) {
    return rank(a.status) - rank(b.status) || String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)) || String((a.brands[0] || {}).code).localeCompare(String((b.brands[0] || {}).code));
  });
  const counts = {};
  BO_ACTIVITY.ORDER.forEach(function (s) { counts[s] = 0; });
  rows.forEach(function (r) { counts[r.status]++; });
  return { rows: rows, counts: counts, pending: pending, generatedAt: new Date().toISOString() };
}

/** 관리자 API. 같은 내용을 45초 동안 나눠 쓰고, 아직 읽지 못한 시트가 있으면 짧게만 저장해 다음 요청에서 이어서 읽는다. */
function apiBrandActivity_(payload) {
  if (payload && payload.fresh) bumpCache_('driveActivity');
  const hit = cacheGetJson_('driveActivity', 'snapshot');
  if (hit) return hit;
  const snapshot = brandActivitySnapshot_();
  return cachePutJson_('driveActivity', 'snapshot', snapshot, snapshot.pending ? 10 : BO_ACTIVITY.TTL);
}
