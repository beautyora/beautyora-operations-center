/** 신규 Notion 브랜드를 감지해 자료 폴더를 준비한다. 공유 권한은 변경하지 않는다. */
const BO_BRAND_SUBFOLDERS = Object.freeze(['01_섬네일', '02_상세페이지', '03_서류']);
const BO_FOLDER_TRIGGER = 'scheduledBrandFolders';
const BO_FOLDER_START = 'BO_BRAND_FOLDERS_START_AT';

const BO_FOLDER_BASELINE = 'BO_BRAND_FOLDERS_BASELINE';
const BO_FOLDER_EXCLUDED = 'BO_BRAND_FOLDERS_EXCLUDED_';

/** 완료 manifest를 마지막에 저장한다. 미완료 스냅샷은 자동 처리에 사용하지 않는다. */
function initializeBrandFolderBaseline_(report) {
  if (prop_(BO_FOLDER_BASELINE)) { brandFolderBaseline_(); return; }
  const started = new Date();
  const since = new Date(Math.floor(started.getTime() / 60000) * 60000).toISOString();
  const schema = notionSchema_('brand');
  const pages = notionQueryAll_(schema.sourceId, {});
  const ids = Array.from(new Set(pages.map(function (page) { return page.id; })));
  // ID는 ASCII UUID. 한 값당 100개(<4KB), 전체 5,000개 상한으로 저장 제한을 방어한다.
  if (ids.length > 5000 || ids.some(function (id) { return !/^[a-f0-9-]{32,36}$/i.test(id); })) throw userError_('브랜드 기준 스냅샷 크기/ID를 확인해 주세요. 자동 처리를 시작하지 않았습니다.');
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(JSON.stringify(ids.slice(i, i + 100)));
  const store = props_(), existing = store.getProperties();
  // 실패한 초기화의 조각은 기준으로 사용된 적이 없으므로 다시 작성할 수 있다.
  Object.keys(existing).forEach(function (key) { if (key.indexOf(BO_FOLDER_EXCLUDED) === 0) { store.deleteProperty(key); delete existing[key]; } });
  const estimatedBytes = JSON.stringify(existing).length * 3 + chunks.join('').length + 10000;
  if (estimatedBytes > 400000) throw userError_('스크립트 속성 저장 공간이 부족합니다. 자동 처리를 시작하지 않았습니다.');
  chunks.forEach(function (chunk, i) { store.setProperty(BO_FOLDER_EXCLUDED + i, chunk); });
  const activatedAt = new Date().toISOString();
  store.setProperty(BO_FOLDER_START, activatedAt);
  store.setProperty(BO_FOLDER_BASELINE, JSON.stringify({ since: since, activatedAt: activatedAt, chunks: chunks.length, count: ids.length }));
  report.push('신규 브랜드 자동 처리 시작: ' + activatedAt + ' (기존 페이지 ' + ids.length + '개 제외)');
}

function brandFolderBaseline_() {
  const raw = prop_(BO_FOLDER_BASELINE);
  if (!raw) return null;
  const baseline = JSON.parse(raw);
  if (!Number.isInteger(baseline.count) || baseline.count < 0 || baseline.count > 5000 || !Number.isFinite(Date.parse(baseline.since)) || !Number.isInteger(baseline.chunks) || baseline.chunks < 0 || baseline.chunks > 50) throw userError_('브랜드 기준 스냅샷을 확인해 주세요.');
  const excluded = new Set();
  for (let i = 0; i < baseline.chunks; i++) {
    const chunk = JSON.parse(prop_(BO_FOLDER_EXCLUDED + i) || 'null');
    if (!Array.isArray(chunk) || chunk.some(function (id) { return typeof id !== 'string'; })) throw userError_('브랜드 기준 스냅샷이 누락되었습니다.');
    chunk.forEach(function (id) { excluded.add(id); });
  }
  if (excluded.size !== baseline.count) throw userError_('브랜드 기준 스냅샷 개수가 맞지 않습니다.');
  return { since: baseline.since, excluded: excluded };
}

function brandFolderName_(brand) {
  const name = String(brand.name || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '이름 없음';
  return brand.code ? name + ' (' + brand.code + ')' : name;
}

/** URL/재시도 기록/브랜드 ID 순으로 재사용. 이름 변경 후에도 같은 폴더를 찾는다. */
function resolveBrandFolder_(brand) {
  const key = 'BO_BRAND_FOLDER_PENDING_' + brand.pageId;
  const saved = prop_(key);
  if (brand.drive) {
    const match = String(brand.drive).match(/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)(?:[/?#]|$)/);
    if (!match) throw userError_('기존 구글 드라이브 URL을 확인해 주세요: ' + brand.code);
    return DriveApp.getFolderById(match[1]);
  }
  if (saved) return DriveApp.getFolderById(saved);
  const root = driveRoot_(), folders = root.getFolders(), matches = [];
  while (folders.hasNext()) {
    const folder = folders.next(), name = folder.getName();
    if (name === brandFolderName_(brand) || name.endsWith('(' + brand.code + ')') || name.indexOf('[' + brand.code + ']') === 0) matches.push(folder);
  }
  if (matches.length > 1) throw userError_('같은 브랜드 ID의 Drive 폴더가 여러 개입니다: ' + brand.code);
  const folder = matches[0] || root.createFolder(brandFolderName_(brand));
  // 하위 폴더/양식/Notion 기록 전에 저장. 중단 후 이름이 바뀌어도 재사용한다.
  props_().setProperty(key, folder.getId());
  return folder;
}

function ensureBrandFolder_(brand) {
  const folder = resolveBrandFolder_(brand);
  BO_BRAND_SUBFOLDERS.forEach(function (name) {
    // 기존 이미지 폴더와 그 내용/링크를 유지한다. 새 섬네일 폴더를 중복 생성하지 않는다.
    if (name === '01_섬네일' && folder.getFoldersByName('01_상품 이미지').hasNext()) return;
    childFolder_(folder, name);
  });
  const templateId = prop_(BO.PROPS.TEMPLATE_FILE_ID);
  if (templateId) {
    const template = DriveApp.getFileById(templateId);
    const suffix = '_' + template.getName();
    const files = folder.getFiles();
    let exists = false;
    while (files.hasNext()) { if (files.next().getName().endsWith(suffix)) exists = true; }
    if (!exists) template.makeCopy(String(brand.name || '브랜드').trim() + suffix, folder);
  }
  return folder.getUrl();
}

/** 잠금 안에서 호출한다. URL은 준비 완료 후 마지막에 쓴다. */
function createBrandFolder_(brand, schema) {
  if (!schema.ids.drive) throw userError_('Notion 브랜드 목록에 구글 드라이브 URL 속성이 필요합니다.');
  if (!/^BO-\d{4,}$/.test(brand.code) || !String(brand.name || '').trim()) throw userError_('브랜드명과 확정된 BO ID가 필요합니다.');
  const pages = notionQueryAll_(schema.sourceId, { filter: { property: schema.ids.code, rich_text: { equals: brand.code } } }, 2);
  if (pages.length !== 1 || pages[0].id !== brand.pageId) throw userError_('브랜드 ID가 중복되었거나 변경되었습니다: ' + brand.code);
  brand = brandSummary_(notionRow_(pages[0], schema)); // 캐시된 URL로 덮어쓰지 않는다.
  const url = ensureBrandFolder_(brand);
  if (!brand.drive) notionPatch_(brand.pageId, notionProps_(schema, { drive: url }));
  props_().deleteProperty('BO_BRAND_FOLDER_PENDING_' + brand.pageId);
  return { code: brand.code, name: brand.name, url: brand.drive || url, created: !brand.drive };
}

/** 전환 이후 생성된 브랜드만 처리. ID 발급 지연/실패는 다음 실행에서 재시도한다. */
function syncBrandFolders_() {
  return withLock_(function () {
    const baseline = brandFolderBaseline_();
    if (!baseline) return { created: [], failed: [], skipped: '초기 설정을 실행하여 신규 브랜드 자동 처리를 시작해 주세요.' };
    const schema = notionSchema_('brand');
    if (!schema.ids.drive) throw userError_('Notion 브랜드 목록에 구글 드라이브 URL 속성이 필요합니다.');
    const pages = notionQueryAll_(schema.sourceId, { filter: { and: [
      { timestamp: 'created_time', created_time: { on_or_after: baseline.since } },
      { property: schema.ids.drive, url: { is_empty: true } }
    ] } });
    const created = [], failed = [], started = Date.now();
    for (const page of pages) {
      if (Date.now() - started > 240000) break;
      if (baseline.excluded.has(page.id)) continue;
      const brand = brandSummary_(notionRow_(page, schema));
      if (!/^BO-\d{4,}$/.test(brand.code) || !String(brand.name || '').trim()) continue;
      try { created.push(createBrandFolder_(brand, schema)); } catch (error) {
        logError_('syncBrandFolders_:' + brand.code, error);
        failed.push({ code: brand.code, name: brand.name, message: errorMessage_(error) });
      }
    }
    if (created.length) bumpCache_('brand');
    return { created: created, failed: failed };
  }, 20000);
}

/* ---------- 관리자 API ---------- */

function apiBrandFolder_(payload) {
  const brand = brandByCode_(payload.code);
  if (!brand) throw userError_('브랜드를 찾을 수 없습니다: ' + (payload.code || '(빈 값)'));
  const result = withLock_(function () { return createBrandFolder_(brand, notionSchema_('brand')); }, 20000);
  bumpCache_('brand');
  return result;
}

function apiBrandFoldersSync_() {
  return syncBrandFolders_();
}

/** 1분마다(Apps Script 트리거의 최소 간격): 전환 이후 신규 브랜드의 폴더를 만든다. */
function scheduledBrandFolders(e) {
  if (!isProjectTrigger_(e)) throw new Error('트리거에서만 실행할 수 있습니다.');
  const result = syncBrandFolders_();
  if (result.failed && result.failed.length) {
    notifyAdmins_('브랜드 드라이브 폴더를 만들지 못했습니다', result.failed.map(function (f) { return '- ' + f.name + ' (' + f.code + '): ' + f.message; }).join('\n'));
  }
}
