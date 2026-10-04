/**
 * 브랜드 자료 폴더: Notion 브랜드의 '드라이브 폴더 만들기'를 체크하거나 운영센터에서 버튼을 누르면
 * 루트 폴더 아래에 브랜드 폴더(하위 폴더 + 취합 엑셀 양식)를 만들고 그 주소를 Notion '구글 드라이브'에 넣는다.
 * 폴더는 '링크가 있는 사용자 누구나 편집'으로 공유한다. 영업 담당자가 이 주소를 브랜드에 전달하면 브랜드가 바로 올릴 수 있다.
 * '구글 드라이브'가 이미 채워진 브랜드는 건드리지 않는다.
 */
const BO_BRAND_SUBFOLDERS = Object.freeze(['01_상품 이미지', '02_상세페이지', '03_서류']);
const BO_FOLDER_TRIGGER = 'scheduledBrandFolders';

function brandFolderName_(brand) {
  const name = String(brand.name || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '이름 없음';
  return brand.code ? name + ' (' + brand.code + ')' : name;
}

/** 폴더(이미 있으면 그대로), 하위 폴더, 엑셀 양식 사본을 준비하고 폴더 주소를 돌려준다. */
function ensureBrandFolder_(brand) {
  const folder = childFolder_(driveRoot_(), brandFolderName_(brand));
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
  BO_BRAND_SUBFOLDERS.forEach(function (name) { childFolder_(folder, name); });
  const templateId = prop_(BO.PROPS.TEMPLATE_FILE_ID);
  if (templateId) {
    const template = DriveApp.getFileById(templateId);
    const copyName = String(brand.name || '브랜드').trim() + '_' + template.getName();
    if (!folder.getFilesByName(copyName).hasNext()) template.makeCopy(copyName, folder);
  }
  return folder.getUrl();
}

/** 브랜드 하나의 폴더를 만들고 Notion '구글 드라이브'에 주소를 쓴다. */
function createBrandFolder_(brand, schema) {
  if (brand.drive) return { code: brand.code, name: brand.name, url: brand.drive, created: false };
  const url = ensureBrandFolder_(brand);
  notionPatch_(brand.pageId, notionProps_(schema, { drive: url }));
  return { code: brand.code, name: brand.name, url: url, created: true };
}

/** '드라이브 폴더 만들기'가 체크되어 있고 '구글 드라이브'가 빈 브랜드를 모두 처리한다. */
function syncBrandFolders_() {
  const schema = notionSchema_('brand');
  if (!schema.ids.makeFolder) return { created: [], failed: [], skipped: '노션 브랜드 목록에 \'드라이브 폴더 만들기\' 체크박스가 없습니다.' };
  return withLock_(function () {
    const pages = notionQueryAll_(schema.sourceId, { filter: { and: [
      { property: schema.ids.makeFolder, checkbox: { equals: true } },
      { property: schema.ids.drive, url: { is_empty: true } }
    ] } }, 50);
    const created = [], failed = [];
    pages.forEach(function (page) {
      const brand = brandSummary_(notionRow_(page, schema));
      try { created.push(createBrandFolder_(brand, schema)); } catch (error) {
        logError_('syncBrandFolders_:' + brand.code, error);
        failed.push({ code: brand.code, name: brand.name, message: errorMessage_(error) });
      }
    });
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

/** 1분마다(Apps Script 트리거의 최소 간격): Notion에서 체크된 브랜드의 폴더를 만든다. */
function scheduledBrandFolders(e) {
  if (!isProjectTrigger_(e)) throw new Error('트리거에서만 실행할 수 있습니다.');
  const result = syncBrandFolders_();
  if (result.failed && result.failed.length) {
    notifyAdmins_('브랜드 드라이브 폴더를 만들지 못했습니다', result.failed.map(function (f) { return '- ' + f.name + ' (' + f.code + '): ' + f.message; }).join('\n'));
  }
}
