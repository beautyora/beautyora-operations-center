// Reserve one source import, but do not hold the shared write lock during Drive I/O.
const BO_IMPORT_CLAIM_KEY_ = 'BO_SOURCE_IMPORT_CLAIM';
const BO_SOURCE_HEADERS_ = ['자료ID','브랜드코드','파일ID','파일명','시트명','원본행','자료JSON','확인상태','상품명','원본URL'];
const BO_IMPORT_HEADERS_ = ['파일ID','파일명','시트수','자료행수','상태','처리일','비고'];

function opsImportClaim_() {
  return withLock_(function() {
    const props = PropertiesService.getScriptProperties();
    const active = crmJson_(props.getProperty(BO_IMPORT_CLAIM_KEY_));
    if (active.token && active.expires > Date.now()) throw Error('다른 사용자가 제출자료를 수집 중입니다. 완료 후 다시 실행해 주세요.');
    const group = new Map();
    crmRows_(BOPS.SHEETS.FILES).filter(r => /^DRIVE-/.test(r['파일ID']) && /\.xlsx$/i.test(r['파일명'])).forEach(r => {
      const id = r['Drive파일ID'];
      if (!group.has(id)) group.set(id, {id, name:r['파일명'], codes:[]});
      const file = group.get(id);
      if (!file.codes.includes(r['브랜드코드'])) file.codes.push(r['브랜드코드']);
    });
    opsSheet_('제출자료 처리', BO_IMPORT_HEADERS_);
    const done = new Set(opsRows_('제출자료 처리').filter(r => r['상태'] === '완료').map(r => r['파일ID']));
    const all = Array.from(group.values()), file = all.find(f => !done.has(f.id));
    const completed = all.filter(f => done.has(f.id)).length;
    if (!file) return {done:true, total:all.length, completed};
    const claim = {token:uuid_('IMPORT-'), expires:Date.now() + 30 * 60 * 1000};
    props.setProperty(BO_IMPORT_CLAIM_KEY_, JSON.stringify(claim));
    return {file, token:claim.token, total:all.length, completed};
  });
}

function opsImportParse_(book, file) {
  const out = [], sheets = book.getSheets();
  sheets.forEach(sh => {
    const values = sh.getDataRange().getDisplayValues();
    let header = [], nameCol = -1;
    values.forEach((row, i) => {
      if (!row.some(x => String(x).trim())) return;
      const normalized = row.map(x => String(x).replace(/\s/g, ''));
      const col = normalized.findIndex(x => ['상품명','제품명','제품명(원문)','옵션명'].includes(x));
      if (col >= 0) { header = row; nameCol = col; }
      const name = nameCol >= 0 && header !== row ? String(row[nameCol] || '').trim() : '';
      out.push([file.id+'-'+sh.getSheetId()+'-'+(i+1), file.codes.join(','), file.id, file.name, sh.getName(), String(i+1),
        JSON.stringify({headers:header, values:row}).slice(0,49000), name ? '제출 자료' : '원본 정보', name,
        'https://drive.google.com/file/d/'+file.id+'/view']);
    });
  });
  return {rows:out, sheetCount:sheets.length};
}

function opsImportCommit_(job, parsed) {
  return withLock_(function() {
    const active = crmJson_(PropertiesService.getScriptProperties().getProperty(BO_IMPORT_CLAIM_KEY_));
    if (active.token !== job.token) throw Error('자료 수집 예약이 변경되었습니다. 다시 실행해 주세요.');
    const target = opsSheet_('제출 상품자료', BO_SOURCE_HEADERS_);
    const existing = opsRows_('제출 상품자료').filter(r => r['파일ID'] === job.file.id);
    // Sheet IDs can change when Drive converts the same XLSX again.
    const rowKey = (sheet, row) => JSON.stringify([String(sheet), String(row)]);
    const expected = new Map(parsed.rows.map(row => [rowKey(row[4], row[5]), row]));
    const seen = new Set();
    existing.forEach(row => {
      const key = rowKey(row['시트명'], row['원본행']), source = expected.get(key);
      if (!source || seen.has(key) || row['자료JSON'] !== source[6]) throw Error('부분 처리 자료와 원본이 다릅니다. 원본 및 기존 자료를 확인해 주세요.');
      seen.add(key);
    });
    const pending = parsed.rows.filter(row => !seen.has(rowKey(row[4], row[5])));
    if (pending.length) {
      const start = target.getLastRow() + 1, required = start + pending.length - 1;
      if (required > target.getMaxRows()) target.insertRowsAfter(target.getMaxRows(), required - target.getMaxRows());
      target.getRange(start, 1, pending.length, BO_SOURCE_HEADERS_.length).setNumberFormat('@').setValues(pending.map(row => row.map(crmSafeCell_)));
    }
    opsSheet_('제출자료 처리', BO_IMPORT_HEADERS_).appendRow([job.file.id,job.file.name,parsed.sheetCount,parsed.rows.length,'완료',now_(),'원본 파일 보존 · 발송재고는 입고 미처리']);
    SpreadsheetApp.flush();
    return {done:job.completed + 1 === job.total, total:job.total, completed:job.completed + 1, file:job.file.name, rows:parsed.rows.length};
  });
}

function opsImportNext() {
  assertAdmin_();
  const job = opsImportClaim_();
  if (job.done) return job;
  let converted;
  try {
    converted = Drive.Files.create({name:'_운영센터_자료확인_'+job.file.name,mimeType:MimeType.GOOGLE_SHEETS},DriveApp.getFileById(job.file.id).getBlob(),{fields:'id'});
    const parsed = opsImportParse_(SpreadsheetApp.openById(converted.id), job.file);
    return opsImportCommit_(job, parsed);
  } finally {
    try {
      if (converted && converted.id) DriveApp.getFileById(converted.id).setTrashed(true);
    } catch (error) { console.warn('임시 변환 파일 정리 실패', error.message); }
    withLock_(function() {
      const props = PropertiesService.getScriptProperties();
      if (crmJson_(props.getProperty(BO_IMPORT_CLAIM_KEY_)).token === job.token) props.deleteProperty(BO_IMPORT_CLAIM_KEY_);
    });
  }
}
