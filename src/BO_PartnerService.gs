function getPartnerBootstrap_(token) {
  const context = validatePartnerToken_(token);
  updateObjectRow_(BOPS.SHEETS.LINKS, context.link._row, { '마지막접속': now_() });
  const fields = getSettings_().fields.filter(field => field.active);
  const brandCode = brandValue_(context.brand, '브랜드코드');
  const submissions = safeObjects_(BOPS.SHEETS.SUBMISSIONS).filter(row => row['브랜드코드'] === brandCode).map(row => {
    let data = {}; try { data = JSON.parse(row['상품데이터JSON'] || '{}'); } catch (ignored) {}
    return { submissionId: row['제출ID'], productId: row['상품ID'], status: row['상태'], updatedAt: row['수정일'], reviewNote: row['검수메모'], data: data };
  }).reverse();
  const submittedProductIds = {};
  submissions.forEach(item => { if (item.productId) submittedProductIds[item.productId] = true; });
  const masterProducts = listProducts_({}).filter(item => item.brandCode === brandCode && !submittedProductIds[item.productId]).map(item => {
    const data = Object.assign({}, item.data || {}, {
      product_id: item.productId,
      product_name: item.productName || '',
      option_name: item.optionName || '',
      barcode: item.barcode || '',
      category: item.category || '',
      retail_price: item.retailPrice || '',
      purchase_price: item.purchasePrice || '',
      online_lowest_price: item.onlineLowestPrice || '',
      trade_type: item.tradeType || '',
      product_url: item.productUrl || '',
      main_image_url: item.mainImageUrl || '',
      detail_page_url: item.detailPageUrl || ''
    });
    return { submissionId: 'MASTER-' + item.productId, productId: item.productId, status: BOPS.STATUS.APPROVED, updatedAt: item.approvedAt || '', reviewNote: '', data: data };
  });
  const products = submissions.concat(masterProducts);
  return { ok: true, view: 'partner', brand: { brandCode: brandCode, brandName: brandValue_(context.brand, '브랜드명'), companyName: brandValue_(context.brand, '회사명') },
    fields: fields, submissions: products, counts: countStatuses_(products) };
}

function validatePartnerToken_(token) {
  if (!token || String(token).length < 20) throw new Error('유효하지 않은 상품등록 링크입니다.');
  const link = findOne_(BOPS.SHEETS.LINKS, '토큰', token);
  if (!link || link['상태'] !== '사용 중') throw new Error('사용할 수 없는 상품등록 링크입니다.');
  if (link['만료일'] && new Date(link['만료일'] + 'T23:59:59+09:00').getTime() < Date.now()) throw new Error('상품등록 링크의 사용기간이 만료되었습니다.');
  const brand = findBrandByCode_(link['브랜드코드']);
  if (!brand) throw new Error('연결된 브랜드 정보를 찾을 수 없습니다.');
  return { link: link, brand: brand };
}

function countStatuses_(submissions) {
  const counts = { total: submissions.length, reviewing: 0, revision: 0, approved: 0 };
  submissions.forEach(item => {
    if ([BOPS.STATUS.SUBMITTED, BOPS.STATUS.REVIEWING].includes(item.status)) counts.reviewing++;
    if (item.status === BOPS.STATUS.REVISION) counts.revision++;
    if (item.status === BOPS.STATUS.APPROVED) counts.approved++;
  });
  return counts;
}

function submitProducts(request) {
  return withLock_(function() {
    const context = validatePartnerToken_(request.token);
    if (!Array.isArray(request.products) || !request.products.length) throw new Error('등록할 상품이 없습니다.');
    if (request.products.length > 300) throw new Error('한 번에 최대 300개 상품까지 제출할 수 있습니다.');
    const fields = getSettings_().fields.filter(field => field.active);
    const brandCode = brandValue_(context.brand, '브랜드코드');
    const errors = validateProducts_(request.products, fields, brandCode);
    if (errors.length) return { ok: false, validationErrors: errors };
    const batchId = uuid_('SUB-');
    request.products.forEach((product, index) => {
      const productId = sanitize_(product.product_id) || uuid_('PRD-');
      appendObject_(BOPS.SHEETS.SUBMISSIONS, {
        '제출ID': batchId + '-' + String(index + 1).padStart(3, '0'), '브랜드코드': brandCode,
        '상품ID': productId, '제출버전': 1, '상태': BOPS.STATUS.SUBMITTED, '제출일': now_(), '수정일': now_(),
        '상품데이터JSON': JSON.stringify(product), '검수메모': '', '제출자명': sanitize_(request.contactName), '제출자연락처': sanitize_(request.contactPhone)
      });
    });
    logAction_('상품 신규 제출', '브랜드', brandCode, request.products.length + '개 상품');
    return { ok: true, batchId: batchId, count: request.products.length };
  });
}

function validateProducts_(products, fields, brandCode) {
  const errors = [];
  const masterBarcodes = safeObjects_(BOPS.SHEETS.PRODUCTS).filter(row => row['브랜드코드'] !== brandCode).map(row => row['바코드']).filter(Boolean);
  const seen = {};
  products.forEach((product, index) => {
    fields.forEach(field => {
      const value = product[field.id];
      if (field.required && (value === undefined || value === null || String(value).trim() === '')) errors.push({ row: index + 1, field: field.id, message: field.label + '을(를) 입력해 주세요.' });
      if (value && field.type === 'number' && isNaN(Number(String(value).replace(/,/g,'')))) errors.push({ row: index + 1, field: field.id, message: field.label + '은(는) 숫자로 입력해 주세요.' });
      if (value && field.type === 'url' && !/^https?:\/\//i.test(String(value))) errors.push({ row: index + 1, field: field.id, message: field.label + ' 주소를 확인해 주세요.' });
    });
    const barcode = String(product.barcode || '').trim();
    if (barcode) {
      if (seen[barcode]) errors.push({ row: index + 1, field: 'barcode', message: '같은 파일 안에 중복된 바코드가 있습니다.' });
      if (masterBarcodes.includes(barcode)) errors.push({ row: index + 1, field: 'barcode', message: '다른 브랜드에 이미 등록된 바코드입니다.' });
      seen[barcode] = true;
    }
  });
  return errors.slice(0, 100);
}

function uploadPartnerFile(request) {
  const context = validatePartnerToken_(request.token);
  if (!request.base64 || !request.fileName) throw new Error('파일을 선택해 주세요.');
  const bytes = Utilities.base64Decode(request.base64);
  if (bytes.length > BOPS.MAX_UPLOAD_BYTES) throw new Error('파일은 8MB 이하만 업로드할 수 있습니다.');
  const allowed = ['image/jpeg','image/png','image/webp','application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  if (!allowed.includes(request.mimeType)) throw new Error('지원하지 않는 파일 형식입니다.');
  const folder = getBrandFolder_(context.brand);
  const brandCode = brandValue_(context.brand, '브랜드코드');
  const blob = Utilities.newBlob(bytes, request.mimeType, sanitizeFileName_(request.fileName));
  const file = folder.createFile(blob);
  appendObject_(BOPS.SHEETS.FILES, {
    '파일ID': uuid_('FILE-'), '브랜드코드': brandCode, '상품ID': sanitize_(request.productId),
    '분류': sanitize_(request.category) || '기타', '파일명': file.getName(), 'Drive파일ID': file.getId(),
    'DriveURL': file.getUrl(), '업로드일': now_(), '상태': '수령 완료'
  });
  logAction_('파일 업로드', '브랜드', brandCode, file.getName());
  return { ok: true, fileName: file.getName(), url: file.getUrl() };
}

function getBrandFolder_(brand) {
  const linkedId = extractDriveId_(brandValue_(brand, 'Drive폴더'));
  if (linkedId) return DriveApp.getFolderById(linkedId);
  const rootId = PropertiesService.getScriptProperties().getProperty(BOPS.PROPS.ROOT_FOLDER_ID);
  if (!rootId) throw new Error('브랜드 자료 루트 폴더가 설정되지 않았습니다.');
  const root = DriveApp.getFolderById(rootId);
  const code = brandValue_(brand, '브랜드코드');
  const existing = root.getFolders();
  while (existing.hasNext()) { const candidate = existing.next(); if (candidate.getName().indexOf(code) >= 0) return candidate; }
  const folder = root.createFolder('[' + code + '] ' + brandValue_(brand, '회사명') + '_' + brandValue_(brand, '브랜드명'));
  return folder;
}

function sanitizeFileName_(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
}
