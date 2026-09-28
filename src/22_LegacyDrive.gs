/**
 * 기존 제출 자료 가져오기(1회성).
 * 운영센터 이전에 브랜드가 직접 올린 Drive 폴더([BO-0001 · BO-0002] 회사_브랜드 형식)를 읽어
 * 브랜드 자료 루트 폴더로 한꺼번에 복사하고, Notion 브랜드의 '구글 드라이브'에 그 폴더 링크를 건다.
 * 중요 서류(사업자등록증·통장사본·계약서)만 따로 서류 URL 속성에 연결하고, 나머지는 폴더에만 둔다.
 * 원본은 지우지 않는다. 여러 번 실행해도 이미 복사한 파일(appProperties.boLegacy)은 건너뛰고,
 * 예전 실행에서 원본 폴더 안에 잘못 들어간 사본은 브랜드 자료 폴더로 옮긴다.
 */

/** Notion 속성으로 따로 연결하는 중요 서류. 나머지 파일은 '구글 드라이브' 폴더 링크로만 찾는다. */
const BO_LEGACY_KEY_DOCS = Object.freeze({ business: 'docBusiness', bank: 'docBank', contract: 'docContract' });

const BO_LEGACY_RULES = Object.freeze([
  { code: 'business', test: /사업자\s*등록|사업자등록|business\s*license/i },
  { code: 'bank', test: /통장|계좌|bank/i },
  { code: 'contract', test: /계약서|contract/i },
  { code: 'products', test: /(상품|제품|입점|공급).*(리스트|목록|list)|product\s*list/i },
  { code: 'intro', test: /소개서|브로슈어|브로셔|카탈로그|catalog|brochure|회사\s*소개|제안서/i }
]);

function legacyCategory_(name, mimeType) {
  const rule = BO_LEGACY_RULES.find(function (r) { return r.test.test(name); });
  if (rule) return rule.code;
  if (/spreadsheet|excel|sheet/.test(String(mimeType))) return 'products';
  return 'other';
}

function legacyCodes_(name) {
  const found = String(name || '').match(/BO-\d{4}/g) || [];
  return found.filter(function (code, i) { return found.indexOf(code) === i; });
}

/** 코드가 없는 폴더는 이름이 브랜드명·회사명과 정확히 한 곳만 일치할 때 연결한다. */
function legacyMatchByName_(name, brands) {
  const key = normalizeName_(String(name).replace(/\(주\)|주식회사|㈜/g, ''));
  if (!key) return [];
  const hits = brands.filter(function (b) {
    return [b.name, b.company].some(function (v) {
      const n = normalizeName_(String(v || '').replace(/\(주\)|주식회사|㈜/g, ''));
      return n && (n === key || key.split(/[_,]/).indexOf(n) >= 0);
    });
  });
  return hits.length === 1 ? [hits[0].code] : [];
}

const BO_FOLDER_MIME = 'application/vnd.google-apps.folder';
/** 이 시각 이후에 만들어진 파일만 예전 가져오기의 사본 후보로 본다(기능 배포일). */
const BO_LEGACY_SINCE = '2026-09-28T00:00:00';

/** 폴더의 하위 항목. 운영센터가 만든 사본(boLegacy)과 바로가기는 원본으로 보지 않는다. */
function legacyChildren_(folderId) {
  const out = { folders: [], files: [] };
  let token = '';
  do {
    const options = {
      q: "'" + folderId + "' in parents and trashed = false", pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,md5Checksum,appProperties)'
    };
    if (token) options.pageToken = token;
    const response = Drive.Files.list(options);
    (response.files || []).forEach(function (f) {
      if (f.mimeType === BO_FOLDER_MIME) out.folders.push({ id: f.id, name: f.name });
      else if (f.mimeType !== 'application/vnd.google-apps.shortcut' && !(f.appProperties && f.appProperties.boLegacy)) {
        out.files.push({ id: f.id, name: f.name, mimeType: f.mimeType || '', updated: f.modifiedTime || '', md5: f.md5Checksum || '' });
      }
    });
    token = response.nextPageToken || '';
  } while (token);
  return out;
}

function legacyFilesIn_(folderId, path, out, seen) {
  seen[folderId] = true;
  const children = legacyChildren_(folderId);
  children.files.forEach(function (f) { out.push(Object.assign(f, { path: path })); });
  children.folders.forEach(function (sub) { legacyFilesIn_(sub.id, path.concat(sub.name), out, seen); });
  return out;
}

/** 원본 폴더를 훑어 [브랜드 묶음 폴더] 목록을 만든다. 코드 없는 상위 폴더(예: '2차 확인 완료')는 안으로 들어간다. */
function legacyScan_(sourceId, brands) {
  const groups = [], unmatched = [], loose = [], seen = {};
  (function walk(folderId, folderName, depth) {
    seen[folderId] = true;
    const children = legacyChildren_(folderId);
    if (depth > 0) children.files.forEach(function (f) { loose.push(folderName + ' / ' + f.name); });
    children.folders.forEach(function (sub) {
      const codes = legacyCodes_(sub.name);
      const matched = codes.length ? codes : legacyMatchByName_(sub.name, brands);
      if (matched.length) {
        groups.push({ id: sub.id, name: sub.name, codes: matched, byName: !codes.length, files: legacyFilesIn_(sub.id, [], [], seen) });
      } else if (depth < 2) {
        const before = groups.length;
        walk(sub.id, sub.name, depth + 1);
        if (groups.length === before) unmatched.push(sub.name);
      } else {
        unmatched.push(sub.name);
      }
    });
  })(sourceId, '', 0);
  return { groups: groups, unmatched: unmatched, loose: loose, sourceFolders: seen };
}

/** 여러 브랜드가 묶인 폴더에서 파일명에 특정 브랜드명이 들어 있으면 그 브랜드에만 연결한다. */
function legacyTargets_(file, brands) {
  if (brands.length < 2) return brands;
  const name = normalizeName_(file.name);
  const specific = brands.filter(function (b) { const n = normalizeName_(b.name); return n && name.indexOf(n) >= 0; });
  return specific.length ? specific : brands;
}

function legacyPlan_(folderUrl) {
  const sourceId = driveIdFromUrl_(folderUrl);
  if (!sourceId) throw userError_('기존 자료 폴더 주소를 확인해 주세요.');
  const brands = listBrands_(true);
  const byCode = {};
  brands.forEach(function (b) { byCode[b.code] = b; });
  const scan = legacyScan_(sourceId, brands);
  const groups = scan.groups.map(function (g) {
    const found = g.codes.map(function (code) { return byCode[code]; }).filter(Boolean);
    return Object.assign(g, {
      brands: found,
      missing: g.codes.filter(function (code) { return !byCode[code]; }),
      files: g.files.map(function (f) {
        const category = legacyCategory_(f.name, f.mimeType);
        return Object.assign(f, { category: category, label: codeToLabel_(BO_DOC_CODES, category), targets: legacyTargets_(f, found).map(function (b) { return b.code; }) });
      })
    });
  });
  return { sourceId: sourceId, groups: groups, unmatched: scan.unmatched, loose: scan.loose, sourceFolders: scan.sourceFolders };
}

function legacyPreview_(folderUrl) {
  const plan = legacyPlan_(folderUrl);
  return {
    groups: plan.groups.map(function (g) {
      return {
        folder: g.name, byName: g.byName, missing: g.missing,
        brands: g.brands.map(function (b) { return { code: b.code, name: b.name, hasDrive: !!b.drive }; }),
        files: g.files.map(function (f) { return { name: f.name, category: f.label, key: !!BO_LEGACY_KEY_DOCS[f.category], targets: f.targets }; })
      };
    }),
    unmatched: plan.unmatched,
    loose: plan.loose,
    totals: {
      folders: plan.groups.length,
      files: plan.groups.reduce(function (n, g) { return n + g.files.length; }, 0),
      brands: plan.groups.reduce(function (n, g) { return n + g.brands.length; }, 0)
    }
  };
}

/** Drive 링크가 원본 폴더(또는 그 안)를 가리키는지. 그런 링크는 복사 대상으로 쓰지 않고 새 폴더로 바꾼다. */
function legacyPointsToSource_(url, sourceFolders) {
  const id = driveIdFromUrl_(url);
  return !!(id && sourceFolders[id]);
}

/** 서류 URL을 새 사본으로 바꿔도 되는지: 비었거나, 지워진 파일이거나, 예전 가져오기가 만든 사본이면 바꾼다. 직접 넣은 링크는 둔다. */
function legacyReplaceable_(url, newUrl) {
  if (!url) return true;
  if (url === newUrl) return false;
  const id = driveIdFromUrl_(url);
  if (!id) return false;
  try {
    const file = Drive.Files.get(id, { fields: 'id,trashed,appProperties', supportsAllDrives: true });
    return !!(file.trashed || (file.appProperties && file.appProperties.boLegacy));
  } catch (error) {
    // 완전히 지워진 파일만 교체하고, 권한 문제 등으로 못 읽는 링크는 그대로 둔다.
    return /not\s*found|404/i.test(errorMessage_(error));
  }
}

/** 복사 대상 폴더: 이미 연결된 브랜드 폴더(원본 폴더 제외) → 루트의 [코드] 폴더 → 원본과 같은 이름으로 새로 만든다. */
function legacyDestination_(group, sourceFolders) {
  for (let i = 0; i < group.brands.length; i++) {
    const brand = group.brands[i];
    const linked = driveIdFromUrl_(brand.drive);
    if (linked && /\/folders\//.test(brand.drive || '') && !sourceFolders[linked]) {
      try { return DriveApp.getFolderById(linked); } catch (error) { logError_('legacy linked folder', error); }
    }
  }
  const root = driveRoot_();
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const folder = folders.next();
    if (sourceFolders[folder.getId()]) continue;
    const codes = legacyCodes_(folder.getName());
    if (codes.length && group.codes.some(function (code) { return codes.indexOf(code) >= 0; })) return folder;
  }
  const name = group.byName ? '[' + group.codes.join(' · ') + '] ' + group.name : group.name;
  return root.createFolder(name);
}

function legacyAppProperties_(file) {
  return { boKind: 'doc', boBrand: file.targets[0], boCat: file.category, boStatus: 'approved', boLegacy: file.id };
}

/**
 * 예전 실행에서 표시(boLegacy) 없이 내 드라이브 첫 화면에 떨어진 사본: 이름·내용(md5)이 같고
 * 가져오기 기능을 배포한 뒤 내가 만든 파일만 사본으로 본다.
 */
function legacyRootStrays_(file) {
  if (!file.md5) return [];
  const q = "name = '" + String(file.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and 'root' in parents and 'me' in owners and trashed = false and createdTime > '" + BO_LEGACY_SINCE + "'";
  const response = Drive.Files.list({ q: q, pageSize: 50, fields: 'files(' + BO_FILE_FIELDS + ',md5Checksum)', supportsAllDrives: true });
  return (response.files || []).filter(function (f) { return f.id !== file.id && f.md5Checksum === file.md5; });
}

/** 사본을 목표 폴더로 옮기고 운영센터 표시를 붙인다. 이미 맞으면 그대로 돌려준다. */
function legacyEnsurePlaced_(copy, parentId, appProperties, log) {
  const parents = copy.parents || [];
  const app = copy.appProperties || {};
  const needsMove = parents.length !== 1 || parents[0] !== parentId;
  const needsTag = Object.keys(appProperties).some(function (k) { return k !== 'boStatus' && app[k] !== appProperties[k]; }) || !app.boStatus;
  if (!needsMove && !needsTag) return copy;
  const options = { fields: BO_FILE_FIELDS, supportsAllDrives: true };
  if (needsMove) {
    options.addParents = parentId;
    const remove = parents.filter(function (id) { return id !== parentId; });
    if (remove.length) options.removeParents = remove.join(',');
    log.moved++;
  }
  const updated = Drive.Files.update(needsTag ? { appProperties: Object.assign({}, appProperties, app.boStatus ? { boStatus: app.boStatus } : {}) } : {}, copy.id, null, options);
  if (needsMove && (updated.parents || []).indexOf(parentId) < 0) throw new Error('사본을 브랜드 폴더로 옮기지 못했습니다(' + copy.id + ').');
  return updated;
}

function legacyRun_(folderUrl) {
  const started = Date.now();
  const budget = function () { return Date.now() - started < 270000; };
  ensureSchemaAdditions_([]);
  const plan = legacyPlan_(folderUrl);
  const schema = notionSchema_('brand');
  const log = { copied: 0, skipped: 0, moved: 0, trashed: 0, brands: 0, errors: [], unfinished: false };
  const best = {}; // code -> { category -> {url, updated} }
  const folderOf = {};

  plan.groups.forEach(function (group) {
    if (!group.brands.length) return;
    if (!budget()) { log.unfinished = true; return; }
    let dest;
    try { dest = legacyDestination_(group, plan.sourceFolders); } catch (error) { log.errors.push(group.name + ': ' + errorMessage_(error)); return; }
    group.brands.forEach(function (b) { folderOf[b.code] = dest.getUrl(); });
    const subfolder = {};
    group.files.forEach(function (file) {
      if (!budget()) { log.unfinished = true; return; }
      try {
        let parent = dest;
        if (file.path.length) {
          const key = file.path.join('/');
          if (!subfolder[key]) subfolder[key] = file.path.reduce(function (f, name) { return childFolder_(f, name); }, dest);
          parent = subfolder[key];
        }
        const tagged = driveList_({ boLegacy: file.id }, 50);
        const strays = tagged.length ? [] : legacyRootStrays_(file);
        const found = tagged.concat(strays);
        let copy = found.find(function (f) { return (f.parents || []).indexOf(parent.getId()) >= 0; }) || found[0];
        // 같은 원본의 사본이 여러 개면 하나만 남기고 휴지통으로 보낸다(예전 실행이 중복으로 만든 것).
        found.forEach(function (f) {
          if (f.id === copy.id) return;
          Drive.Files.update({ trashed: true }, f.id, null, { supportsAllDrives: true });
          log.trashed++;
        });
        if (!copy) {
          copy = Drive.Files.copy({
            name: file.name, parents: [parent.getId()],
            appProperties: legacyAppProperties_(file)
          }, file.id, { fields: BO_FILE_FIELDS, supportsAllDrives: true });
          log.copied++;
        } else {
          log.skipped++;
        }
        // 사본이 브랜드 폴더 밖(원본 폴더·내 드라이브 첫 화면 등)에 있거나 표시가 빠졌으면 바로잡는다.
        copy = legacyEnsurePlaced_(copy, parent.getId(), legacyAppProperties_(file), log);
        const url = copy.webViewLink || ('https://drive.google.com/file/d/' + copy.id + '/view');
        if (!BO_LEGACY_KEY_DOCS[file.category]) return;
        file.targets.forEach(function (code) {
          best[code] = best[code] || {};
          const current = best[code][file.category];
          if (!current || String(file.updated) > String(current.updated)) best[code][file.category] = { url: url, updated: file.updated };
        });
      } catch (error) {
        log.errors.push(group.name + ' / ' + file.name + ': ' + errorMessage_(error));
      }
    });
  });

  // Notion: '구글 드라이브'는 비었거나 원본 폴더를 가리킬 때 새 폴더로, 중요 서류 URL은 비어 있을 때만 채운다.
  plan.groups.forEach(function (group) {
    group.brands.forEach(function (brand) {
      const patch = {};
      if (folderOf[brand.code] && schema.ids.drive && (!brand.drive || legacyPointsToSource_(brand.drive, plan.sourceFolders)) && brand.drive !== folderOf[brand.code]) {
        patch[schema.ids.drive] = { url: folderOf[brand.code] };
      }
      const docs = best[brand.code] || {};
      Object.keys(docs).forEach(function (category) {
        const key = BO_LEGACY_KEY_DOCS[category];
        const current = (brand.docs || {})[category];
        if (key && schema.ids[key] && legacyReplaceable_(current, docs[category].url)) patch[schema.ids[key]] = { url: docs[category].url };
      });
      if (!Object.keys(patch).length) return;
      try { notionPatch_(brand.pageId, patch); log.brands++; } catch (error) { log.errors.push(brand.code + ' Notion: ' + errorMessage_(error)); }
    });
  });
  bumpCache_('brand');
  logInfo_('legacy.drive', { copied: log.copied, skipped: log.skipped, moved: log.moved, trashed: log.trashed, brands: log.brands, errors: log.errors.length });
  return log;
}
