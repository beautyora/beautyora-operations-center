/** 신규 Notion 브랜드를 감지해 자료 폴더를 준비한다. 공유 권한은 변경하지 않는다. */
const BO_BRAND_SUBFOLDERS = Object.freeze(['01_섬네일', '02_상세페이지', '03_서류']);
const BO_FOLDER_TRIGGER = 'scheduledBrandFolders';
const BO_FOLDER_START = 'BO_BRAND_FOLDERS_START_AT';

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
    const since = prop_(BO_FOLDER_START);
    if (!since) return { created: [], failed: [], skipped: '초기 설정을 실행하여 신규 브랜드 자동 처리를 시작해 주세요.' };
    if (!Number.isFinite(Date.parse(since))) throw userError_('브랜드 폴더 전환 시각이 올바르지 않습니다.');
    const schema = notionSchema_('brand');
    if (!schema.ids.drive) throw userError_('Notion 브랜드 목록에 구글 드라이브 URL 속성이 필요합니다.');
    const pages = notionQueryAll_(schema.sourceId, { filter: { and: [
      { timestamp: 'created_time', created_time: { on_or_after: since } },
      { property: schema.ids.drive, url: { is_empty: true } }
    ] } });
    const created = [], failed = [], started = Date.now();
    for (const page of pages) {
      if (Date.now() - started > 240000) break;
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
