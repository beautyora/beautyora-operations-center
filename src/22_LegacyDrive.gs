/**
 * 기존 제출 자료 가져오기(1회성).
 * 운영센터 이전에 브랜드가 직접 올린 Drive 폴더([BO-0001 · BO-0002] 회사_브랜드 형식)를 읽어
 * 브랜드 자료 루트 폴더로 복사하고, Notion 브랜드의 '구글 드라이브'와 서류 URL 속성을 채운다.
 * 원본은 지우지 않는다. 여러 번 실행해도 이미 복사한 파일(appProperties.boLegacy)은 건너뛴다.
 */

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

function legacyFilesIn_(folder, path, out) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    out.push({ id: file.getId(), name: file.getName(), mimeType: file.getMimeType(), updated: String(file.getLastUpdated() && file.getLastUpdated().toISOString ? file.getLastUpdated().toISOString() : ''), path: path });
  }
  const folders = folder.getFolders();
  while (folders.hasNext()) {
    const sub = folders.next();
    legacyFilesIn_(sub, path.concat(sub.getName()), out);
  }
  return out;
}

/** 원본 폴더를 훑어 [브랜드 묶음 폴더] 목록을 만든다. 코드 없는 상위 폴더(예: '2차 확인 완료')는 안으로 들어간다. */
function legacyScan_(sourceId, brands) {
  const groups = [], unmatched = [], loose = [];
  (function walk(folder, depth) {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (depth > 0) loose.push(folder.getName() + ' / ' + file.getName());
    }
    const folders = folder.getFolders();
    while (folders.hasNext()) {
      const sub = folders.next();
      const name = sub.getName();
      const codes = legacyCodes_(name);
      const matched = codes.length ? codes : legacyMatchByName_(name, brands);
      if (matched.length) {
        groups.push({ folder: sub, id: sub.getId(), name: name, codes: matched, byName: !codes.length, files: legacyFilesIn_(sub, [], []) });
      } else if (depth < 2) {
        const before = groups.length;
        walk(sub, depth + 1);
        if (groups.length === before) unmatched.push(name);
      } else {
        unmatched.push(name);
      }
    }
  })(DriveApp.getFolderById(sourceId), 0);
  return { groups: groups, unmatched: unmatched, loose: loose };
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
  return { sourceId: sourceId, groups: groups, unmatched: scan.unmatched, loose: scan.loose };
}

function legacyPreview_(folderUrl) {
  const plan = legacyPlan_(folderUrl);
  return {
    groups: plan.groups.map(function (g) {
      return {
        folder: g.name, byName: g.byName, missing: g.missing,
        brands: g.brands.map(function (b) { return { code: b.code, name: b.name, hasDrive: !!b.drive }; }),
        files: g.files.map(function (f) { return { name: f.name, category: f.label, targets: f.targets }; })
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

/** 복사 대상 폴더: 이미 연결된 브랜드 폴더 → 루트의 [코드] 폴더 → 원본과 같은 이름으로 새로 만든다. */
function legacyDestination_(group) {
  for (let i = 0; i < group.brands.length; i++) {
    const brand = group.brands[i];
    const linked = driveIdFromUrl_(brand.drive);
    if (linked && /\/folders\//.test(brand.drive || '')) {
      try { return DriveApp.getFolderById(linked); } catch (error) { logError_('legacy linked folder', error); }
    }
  }
  const root = driveRoot_();
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const folder = folders.next();
    const codes = legacyCodes_(folder.getName());
    if (codes.length && group.codes.some(function (code) { return codes.indexOf(code) >= 0; })) return folder;
  }
  const name = group.byName ? '[' + group.codes.join(' · ') + '] ' + group.name : group.name;
  return root.createFolder(name);
}

function legacyRun_(folderUrl) {
  const started = Date.now();
  const budget = function () { return Date.now() - started < 270000; };
  ensureSchemaAdditions_([]);
  const plan = legacyPlan_(folderUrl);
  const schema = notionSchema_('brand');
  const log = { copied: 0, skipped: 0, brands: 0, errors: [], unfinished: false };
  const best = {}; // code -> { category -> {url, updated} }
  const folderOf = {};

  plan.groups.forEach(function (group) {
    if (!group.brands.length) return;
    if (!budget()) { log.unfinished = true; return; }
    let dest;
    try { dest = legacyDestination_(group); } catch (error) { log.errors.push(group.name + ': ' + errorMessage_(error)); return; }
    group.brands.forEach(function (b) { folderOf[b.code] = dest.getUrl(); });
    const subfolder = {};
    group.files.forEach(function (file) {
      if (!budget()) { log.unfinished = true; return; }
      try {
        const existing = driveList_({ boLegacy: file.id }, 1);
        let copy = existing[0];
        if (copy) {
          log.skipped++;
        } else {
          let parent = dest;
          if (file.path.length) {
            const key = file.path.join('/');
            if (!subfolder[key]) subfolder[key] = file.path.reduce(function (f, name) { return childFolder_(f, name); }, dest);
            parent = subfolder[key];
          }
          copy = Drive.Files.copy({
            name: file.name, parents: [parent.getId()],
            appProperties: { boKind: 'doc', boBrand: file.targets[0], boCat: file.category, boStatus: 'approved', boLegacy: file.id }
          }, file.id, { fields: BO_FILE_FIELDS, supportsAllDrives: true });
          log.copied++;
        }
        const url = copy.webViewLink || ('https://drive.google.com/file/d/' + copy.id + '/view');
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

  // Notion: 비어 있는 속성만 채운다(직접 입력한 값은 그대로 둔다).
  const docKeys = { business: 'docBusiness', intro: 'docIntro', contract: 'docContract', other: 'docOther', bank: 'docBank', products: 'docProducts' };
  plan.groups.forEach(function (group) {
    group.brands.forEach(function (brand) {
      const patch = {};
      if (folderOf[brand.code] && schema.ids.drive && !brand.drive) patch[schema.ids.drive] = { url: folderOf[brand.code] };
      const docs = best[brand.code] || {};
      Object.keys(docs).forEach(function (category) {
        const key = docKeys[category];
        const current = (brand.docs || {})[category];
        if (key && schema.ids[key] && !current) patch[schema.ids[key]] = { url: docs[category].url };
      });
      if (!Object.keys(patch).length) return;
      try { notionPatch_(brand.pageId, patch); log.brands++; } catch (error) { log.errors.push(brand.code + ' Notion: ' + errorMessage_(error)); }
    });
  });
  bumpCache_('brand');
  logInfo_('legacy.drive', { copied: log.copied, skipped: log.skipped, brands: log.brands, errors: log.errors.length });
  return log;
}
