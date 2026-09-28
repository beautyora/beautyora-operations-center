/**
 * 파일: Google Drive가 저장소이고, 파일 목록은 Drive appProperties로 찾는다(시트 없음).
 * appProperties: boKind(asset|doc), boBrand(브랜드 ID), boProduct(상품 ID), boCat(분류 코드), boUpload(업로드 ID), boStatus(상태 코드)
 */
const BO_ASSET_CODES = Object.freeze({ '대표 이미지': 'main', '추가 이미지': 'extra', '상세페이지': 'detail', '기타': 'etc' });
const BO_DOC_CODES = Object.freeze({ '사업자등록증': 'business', '통장사본': 'bank', '입점 상품 리스트': 'products', '브랜드 소개서': 'intro', '계약서': 'contract', '기타 브랜드 자료': 'other' });
const BO_FILE_STATUS_CODES = Object.freeze({ pending: '검수 대기', received: '수령 완료', revision: '보완 필요', rejected: '반려', approved: '승인 완료' });
const BO_FILE_FIELDS = 'id,name,mimeType,webViewLink,thumbnailLink,createdTime,size,appProperties,description,trashed,parents';
const BO_ALLOWED_MIME = Object.freeze({ 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'application/pdf': ['pdf'] });
const BO_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function codeToLabel_(map, code) {
  return Object.keys(map).find(function (label) { return map[label] === code; }) || '';
}

function driveRoot_() {
  const id = prop_(BO.PROPS.ROOT_FOLDER_ID);
  if (!id) throw userError_('브랜드 자료 루트 폴더가 설정되지 않았습니다. 스크립트 속성 BO_ROOT_FOLDER_ID를 확인해 주세요.');
  return DriveApp.getFolderById(id);
}

function childFolder_(parent, name) {
  const matches = parent.getFoldersByName(name);
  return matches.hasNext() ? matches.next() : parent.createFolder(name);
}

/** 브랜드 폴더: Notion '구글 드라이브' 링크 → 루트 폴더의 [브랜드ID] 폴더 → 새로 만들고 Notion에 기록. */
function brandFolder_(brand) {
  const linked = driveIdFromUrl_(brand.drive);
  if (linked && /\/folders\//.test(brand.drive || '')) {
    try { return DriveApp.getFolderById(linked); } catch (error) { logError_('brandFolder linked', error); }
  }
  const root = driveRoot_();
  const token = '[' + brand.code + ']';
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const folder = folders.next();
    if (folder.getName().indexOf(token) === 0) return folder;
  }
  const folder = root.createFolder(token + ' ' + [brand.company, brand.name].filter(Boolean).join('_'));
  try {
    const schema = notionSchema_('brand');
    if (schema.ids.drive) {
      const patch = {};
      patch[schema.ids.drive] = { url: folder.getUrl() };
      notionPatch_(brand.pageId, patch);
      bumpCache_('brand');
    }
  } catch (error) {
    logError_('brandFolder notion link', error);
  }
  return folder;
}

function productCategoryFolder_(brand, productId, category) {
  assertId_(productId, '상품 ID');
  if (!BO_ASSET_CODES[category]) throw userError_('파일 분류를 확인해 주세요.');
  return childFolder_(childFolder_(childFolder_(brandFolder_(brand), '상품 이미지'), productId), category);
}

function brandDocFolder_(brand) {
  return childFolder_(brandFolder_(brand), '브랜드 자료');
}

function driveQuery_(conditions, extra) {
  const parts = Object.keys(conditions).map(function (key) {
    return "appProperties has { key='" + key + "' and value='" + String(conditions[key]).replace(/'/g, "\\'") + "' }";
  });
  parts.push('trashed = false');
  if (extra) parts.push(extra);
  return parts.join(' and ');
}

function driveList_(conditions, max) {
  const files = [];
  let token = '';
  do {
    const options = { q: driveQuery_(conditions), pageSize: 200, fields: 'nextPageToken, files(' + BO_FILE_FIELDS + ')', supportsAllDrives: true, includeItemsFromAllDrives: true };
    if (token) options.pageToken = token;
    const response = Drive.Files.list(options);
    Array.prototype.push.apply(files, response.files || []);
    token = response.nextPageToken || '';
  } while (token && (!max || files.length < max));
  return files;
}

function fileView_(file) {
  const app = file.appProperties || {};
  const kind = app.boKind || '';
  return {
    id: file.id, name: file.name, url: file.webViewLink || ('https://drive.google.com/file/d/' + file.id + '/view'),
    mimeType: file.mimeType || '', createdAt: file.createdTime || '', size: Number(file.size || 0),
    kind: kind, brandCode: app.boBrand || '', productId: app.boProduct || '',
    categoryCode: app.boCat || '', category: codeToLabel_(kind === 'doc' ? BO_DOC_CODES : BO_ASSET_CODES, app.boCat),
    statusCode: app.boStatus || '', status: BO_FILE_STATUS_CODES[app.boStatus] || '',
    note: file.description || '',
    folderUrl: file.parents && file.parents[0] ? 'https://drive.google.com/drive/folders/' + file.parents[0] : ''
  };
}

function driveFile_(fileId) {
  return Drive.Files.get(String(fileId), { fields: BO_FILE_FIELDS, supportsAllDrives: true });
}

function listProductAssets_(brandCode, productId) {
  if (!productId) return [];
  const conditions = { boKind: 'asset', boProduct: productId };
  if (brandCode) conditions.boBrand = brandCode;
  return driveList_(conditions, 300).map(fileView_).sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
}

function listBrandDocs_(brandCode) {
  return driveList_({ boKind: 'doc', boBrand: brandCode }, 200).map(fileView_)
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
}

/** 상품ID → 가장 최근 대표 이미지 파일 ID (목록 미리보기용, 10분 캐시). */
function assetMainImages_() {
  return cached_('asset', 'main', 600, function () {
    const map = {}, times = {};
    try {
      driveList_({ boKind: 'asset', boCat: 'main' }, 5000).forEach(function (file) {
        const productId = file.appProperties && file.appProperties.boProduct;
        if (!productId) return;
        if (!times[productId] || String(file.createdTime) > times[productId]) {
          map[productId] = file.id;
          times[productId] = String(file.createdTime);
        }
      });
    } catch (error) {
      logError_('assetMainImages_', error);
    }
    return map;
  });
}

/** 파트너 업로드. 같은 uploadId로 다시 오면 기존 파일을 돌려준다. */
function uploadBrandFile_(brand, request) {
  const kind = request.kind === 'doc' ? 'doc' : 'asset';
  const uploadId = assertId_(request.uploadId, '업로드 ID');
  const category = String(request.category || '');
  const codes = kind === 'doc' ? BO_DOC_CODES : BO_ASSET_CODES;
  if (!codes[category]) throw userError_('파일 분류를 확인해 주세요.');
  const productId = kind === 'asset' ? assertId_(request.productId, '상품 ID') : '';
  const fileName = sanitizeFileName_(request.fileName);
  const extension = fileName.split('.').pop().toLowerCase();
  const mimeType = String(request.mimeType || '');
  const sheetDoc = kind === 'doc' && codes[category] === 'products' && mimeType === BO_XLSX_MIME && extension === 'xlsx';
  if (!sheetDoc && (!BO_ALLOWED_MIME[mimeType] || BO_ALLOWED_MIME[mimeType].indexOf(extension) < 0)) throw userError_(kind === 'doc' && codes[category] === 'products' ? '입점 상품 리스트는 XLSX, PDF 또는 이미지 파일로 올려 주세요.' : 'JPG, PNG, WEBP 또는 PDF 파일만 올릴 수 있습니다.');
  if (kind === 'asset' && /이미지/.test(category) && mimeType === 'application/pdf') throw userError_('대표·추가 이미지에는 이미지 파일을 올려 주세요.');
  const base64 = String(request.base64 || '');
  if (!base64 || base64.length > Math.ceil(BO.MAX_UPLOAD_BYTES / 3) * 4 + 8) throw userError_('파일은 8MB 이하로 올려 주세요.');

  const existing = driveList_({ boUpload: uploadId, boBrand: brand.code }, 2);
  if (existing.length) {
    const view = fileView_(existing[0]);
    if (view.kind !== kind || view.productId !== productId || view.category !== category) throw userError_('업로드 정보가 이전 요청과 다릅니다. 새로 고친 뒤 다시 올려 주세요.');
    return view;
  }
  const bytes = Utilities.base64Decode(base64);
  if (!bytes.length || bytes.length > BO.MAX_UPLOAD_BYTES) throw userError_('빈 파일이거나 8MB를 넘었습니다.');
  const folder = withLock_(function () {
    return kind === 'doc' ? brandDocFolder_(brand) : productCategoryFolder_(brand, productId, category);
  });
  const name = sanitizeFileName_((productId || brand.code) + '_' + category + '_' + uploadId.slice(0, 8) + '_' + fileName);
  const appProperties = { boKind: kind, boBrand: brand.code, boCat: codes[category], boUpload: uploadId, boStatus: kind === 'doc' ? 'pending' : 'received' };
  if (productId) appProperties.boProduct = productId;
  const created = Drive.Files.create({ name: name, parents: [folder.getId()], appProperties: appProperties },
    Utilities.newBlob(bytes, mimeType, name), { fields: BO_FILE_FIELDS, supportsAllDrives: true });
  if (kind === 'asset' && codes[category] === 'main') bumpCache_('asset');
  logInfo_('file.upload', { brand: brand.code, kind: kind, category: category, productId: productId });
  return fileView_(created);
}

function setFileReview_(fileId, statusCode, note) {
  const resource = { appProperties: { boStatus: statusCode } };
  if (note != null) resource.description = String(note).slice(0, 3000);
  return fileView_(Drive.Files.update(resource, String(fileId), null, { fields: BO_FILE_FIELDS, supportsAllDrives: true }));
}

/* ---------- 관리자 API ---------- */

function apiDocumentsPending_() {
  const brandsByCode = {};
  listBrands_().forEach(function (brand) { brandsByCode[brand.code] = brand; });
  return {
    documents: driveList_({ boKind: 'doc', boStatus: 'pending' }, 500).map(fileView_).map(function (file) {
      const brand = brandsByCode[file.brandCode] || {};
      return Object.assign(file, { brandName: brand.name || '', company: brand.company || '' });
    }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })
  };
}

function apiBrandDocuments_(payload) {
  const brand = requireBrand_(payload.code);
  return { documents: listBrandDocs_(brand.code), notion: brand.docs };
}

/** 서류 검수. 승인하면 Notion 브랜드의 해당 서류 URL 속성에 파일 링크를 넣는다. */
function apiDocumentReview_(payload) {
  const action = String(payload.action || '');
  if (['approve', 'revision', 'reject'].indexOf(action) < 0) throw userError_('검수 작업을 확인해 주세요.');
  const note = text_(payload.note, 1000);
  if (action !== 'approve' && !note) throw userError_('보완·반려 사유를 입력해 주세요.');
  return withLock_(function () {
    const file = fileView_(driveFile_(payload.fileId));
    if (file.kind !== 'doc') throw userError_('브랜드 서류가 아닙니다.');
    if (file.statusCode === 'approved' && action === 'approve') return { file: file };
    const brand = requireBrand_(file.brandCode);
    // 입점 상품 리스트처럼 Notion 속성이 없는 분류는 브랜드 폴더에만 두고 승인만 기록한다.
    const schemaKey = BO.DOC_CATEGORIES[file.category];
    if (action === 'approve' && schemaKey) {
      const schema = notionSchema_('brand');
      if (!schema.ids[schemaKey]) throw userError_('Notion 브랜드 DB에 "' + file.category + '" 서류 링크 속성이 없습니다. 설정 → 초기 설정을 실행해 주세요.');
      const patch = {};
      patch[schema.ids[schemaKey]] = { url: file.url };
      const updated = notionPatch_(brand.pageId, patch);
      const expected = {};
      expected[schema.ids[schemaKey]] = file.url;
      notionVerify_(updated, schema.byId, expected);
      bumpCache_('brand');
    }
    const statusCode = action === 'approve' ? 'approved' : action === 'revision' ? 'revision' : 'rejected';
    const result = setFileReview_(file.id, statusCode, action === 'approve' ? '' : note);
    notionComment_(brand.pageId, '서류 ' + BO_FILE_STATUS_CODES[statusCode] + ': ' + file.category + ' (' + file.name + ')' + (note ? ' — ' + note : '') + ' · ' + activeEmail_());
    return { file: result };
  });
}

function apiAssetFolder_(payload) {
  const brand = requireBrand_(payload.code);
  const folder = withLock_(function () {
    if (payload.productId) return childFolder_(childFolder_(brandFolder_(brand), '상품 이미지'), assertId_(payload.productId, '상품 ID'));
    if (payload.kind === 'doc') return brandDocFolder_(brand);
    return brandFolder_(brand);
  });
  return { url: folder.getUrl() };
}

/** 파트너 화면용 썸네일(Drive 권한 없이 보이도록 서버에서 가져와 data URL로 전달). */
function driveThumbnail_(file) {
  return cached_('thumb', file.id, 21600, function () {
    const meta = driveFile_(file.id);
    if (!meta.thumbnailLink) return '';
    const response = UrlFetchApp.fetch(meta.thumbnailLink.replace(/=s\d+$/, '=s320'), {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) return '';
    const blob = response.getBlob();
    const encoded = Utilities.base64Encode(blob.getBytes());
    return encoded.length > 80000 ? '' : 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + encoded;
  });
}
