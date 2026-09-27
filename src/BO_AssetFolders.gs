/** Drive organization. Reading a brand never creates or scans Drive folders. */
function assetChildFolder_(parent, name) {
  const matches = parent.getFoldersByName(name);
  return matches.hasNext() ? matches.next() : parent.createFolder(name);
}

function getProductAssetFolder_(brand, productId) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(productId || '')) throw Error('상품 식별자를 확인해 주세요.');
  return assetChildFolder_(assetChildFolder_(getBrandFolder_(brand), '상품 이미지'), productId);
}

function getBrandDocumentFolder_(brand) {
  return assetChildFolder_(getBrandFolder_(brand), '브랜드 자료');
}

function getAdminAssetFolder(request) {
  assertAdmin_();
  request = request || {};
  const brand = findBrandByCode_(String(request.brandCode || ''));
  if (!brand) throw Error('브랜드를 찾을 수 없습니다.');
  const code = brandValue_(brand, '브랜드코드');
  const productId = String(request.productId || '');
  if (request.kind !== 'product' && request.kind !== 'documents') throw Error('폴더 구분을 확인해 주세요.');
  if (request.kind === 'product' && !listProducts_({brandCode:code}).some(p => p.productId === productId)) {
    throw Error('이 브랜드의 등록 상품을 찾을 수 없습니다.');
  }
  // Serializes creation with partner uploads, preventing duplicate sibling folders.
  const folder = withLock_(function () {
    return request.kind === 'product' ? getProductAssetFolder_(brand, productId) : getBrandDocumentFolder_(brand);
  });
  const files = safeObjects_(BOPS.SHEETS.FILES).filter(row => row['브랜드코드'] === code &&
    (request.kind === 'product' ? row['상품ID'] === productId : !row['상품ID']));
  let moved = 0;
  const failed = [];
  files.forEach(row => {
    if (!row['Drive파일ID']) return;
    try {
      const file = DriveApp.getFileById(row['Drive파일ID']);
      const parents = file.getParents();
      let alreadyThere = false;
      while (parents.hasNext()) if (parents.next().getId() === folder.getId()) alreadyThere = true;
      if (!alreadyThere) { file.moveTo(folder); moved++; }
    } catch (error) { failed.push(row['파일명'] || row['파일ID']); }
  });
  return {ok:true,url:folder.getUrl(),moved:moved,failed:failed};
}

function getProductAssetCategoryFolder_(brand,productId,category) {
  if(['대표 이미지','추가 이미지','상세페이지','기타'].indexOf(category)<0)throw Error('파일 분류를 확인해 주세요.');
  return assetChildFolder_(getProductAssetFolder_(brand,productId),category);
}
