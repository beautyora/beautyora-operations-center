function importProductWorkbook(request) {
  const context = validatePartnerToken_(request.token);
  if (!request.base64 || !request.fileName) throw new Error('엑셀 파일을 선택해 주세요.');
  const bytes = Utilities.base64Decode(request.base64);
  if (bytes.length > BOPS.MAX_UPLOAD_BYTES) throw new Error('엑셀 파일은 8MB 이하만 업로드할 수 있습니다.');
  const folder = getBrandFolder_(context.brand);
  const blob = Utilities.newBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sanitizeFileName_(request.fileName));
  let converted;
  try {
    converted = Drive.Files.create({ name: '_TEMP_' + request.fileName, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] }, blob, { fields: 'id' });
    const spreadsheet = SpreadsheetApp.openById(converted.id);
    const values = spreadsheet.getSheets()[0].getDataRange().getDisplayValues();
    if (values.length < 2) throw new Error('엑셀에 상품 데이터가 없습니다.');
    const fields = getSettings_().fields.filter(field => field.active && field.excel);
    const headerRowIndex = findHeaderRow_(values, fields);
    if (headerRowIndex < 0) throw new Error('상품명 열을 찾을 수 없습니다. 최신 양식을 사용해 주세요.');
    const headers = values[headerRowIndex];
    const headerMap = {};
    fields.forEach(field => {
      const index = headers.findIndex(header => String(header).trim() === field.label || String(header).trim() === field.id);
      if (index >= 0) headerMap[field.id] = index;
    });
    const products = values.slice(headerRowIndex + 1).filter(row => row.some(Boolean)).map(row => {
      const product = {};
      Object.keys(headerMap).forEach(id => product[id] = row[headerMap[id]]);
      return product;
    });
    const errors = validateProducts_(products, fields, context.brand['브랜드코드']);
    return { ok: errors.length === 0, products: products, validationErrors: errors, detectedColumns: Object.keys(headerMap) };
  } finally {
    if (converted && converted.id) try { Drive.Files.remove(converted.id); } catch (ignored) {}
  }
}

function findHeaderRow_(values, fields) {
  const productField = fields.find(field => field.id === 'product_name');
  const names = ['product_name', productField ? productField.label : '상품명'];
  for (let i = 0; i < Math.min(values.length, 15); i++) {
    if (values[i].some(cell => names.includes(String(cell).trim()))) return i;
  }
  return -1;
}

function getTemplateDefinition(token) {
  validatePartnerToken_(token);
  const fields = getSettings_().fields.filter(field => field.active && field.excel);
  return { ok: true, fileName: '뷰티오라_상품등록_양식.csv', headers: fields.map(field => field.label), ids: fields.map(field => field.id) };
}
