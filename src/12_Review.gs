/**
 * 상품 검수.
 * - 신규·보완 제출: 파트너 입력이 상품 페이지 속성에 바로 저장되고 '등록 검수 상태'가 검수 대기가 된다.
 * - 승인된 상품의 변경 요청: 페이지 속성은 그대로 두고, 본문에 '🔁 변경 요청' 토글(JSON 포함)을 남긴 뒤
 *   '변경 요청' 속성을 검수 대기로 둔다. 승인하면 그때 속성에 반영한다.
 */

function assetFolderProps_(schema, assets) {
  const out = {};
  const main = assets.filter(function (a) { return a.categoryCode === 'main'; }).pop();
  const detail = assets.filter(function (a) { return a.categoryCode === 'detail'; }).pop();
  if (schema.ids.thumbnail && main && main.folderUrl) out[schema.ids.thumbnail] = { url: main.folderUrl };
  if (schema.ids.detail && detail && detail.folderUrl) out[schema.ids.detail] = { url: detail.folderUrl };
  return out;
}

function changeBlock_(request, lines) {
  const json = JSON.stringify(request);
  const chunks = [];
  for (let i = 0; i < json.length && chunks.length < 100; i += 2000) chunks.push({ type: 'text', text: { content: json.slice(i, i + 2000) } });
  const children = lines.slice(0, 40).map(function (line) {
    return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: notionRichText_(line) };
  });
  children.push({ object: 'block', type: 'code', code: { language: 'json', rich_text: chunks } });
  return {
    object: 'block', type: 'toggle',
    toggle: { rich_text: notionRichText_(BO.CHANGE_MARKER + ' · ' + request.submittedAt.slice(0, 16).replace('T', ' ') + ' · ' + (request.submitter || '브랜드')).rich_text, children: children }
  };
}

/** 본문에서 처리되지 않은 가장 최근 변경 요청을 찾는다. */
function pendingChange_(pageId) {
  const blocks = notionBlocks_(pageId, 0);
  let found = null;
  blocks.forEach(function (block) {
    if (block.type !== 'toggle' || block.text.indexOf(BO.CHANGE_MARKER) !== 0) return;
    const code = (block.children || []).find(function (child) { return child.type === 'code'; });
    if (!code) return;
    try { found = { blockId: block.id, title: block.text, request: JSON.parse(code.text) }; } catch (error) { logError_('pendingChange parse', error); }
  });
  return found;
}

function markChangeBlock_(block, label) {
  notionPatchBlock_(block.blockId, { toggle: notionRichText_(label + ' · ' + block.title.replace(BO.CHANGE_MARKER, '변경 요청')) });
}

function describeValue_(value) {
  if (value == null || value === '') return '(비어 있음)';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(비어 있음)';
  if (value === true) return '예';
  if (value === false) return '아니오';
  return String(value);
}

function sameValue_(a, b) {
  return describeValue_(a) === describeValue_(b);
}

/* ---------- 관리자 API ---------- */

function apiReviewQueue_() {
  const schema = notionSchema_('product');
  const filters = [fSelect_(schema, 'review', BO.REVIEW.PENDING)];
  if (schema.ids.change) filters.push(fSelect_(schema, 'change', BO.CHANGE.PENDING));
  const pages = notionQueryAll_(schema.sourceId, { filter: filters.length > 1 ? { or: filters } : filters[0], sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }] }, 300);
  const brandMap = brandMapByPageId_();
  const items = pages.map(function (page) {
    const summary = productSummary_(notionRow_(page, schema), brandMap, {});
    return Object.assign(summary, { kind: summary.change === BO.CHANGE.PENDING && summary.review !== BO.REVIEW.PENDING ? 'change' : 'new' });
  });
  const waiting = listProducts_().filter(function (p) { return p.review === BO.REVIEW.REVISION || p.change === BO.CHANGE.REVISION; }).length;
  return { items: items, waitingOnBrand: waiting };
}

function apiReviewDetail_(payload) {
  const schema = notionSchema_('product');
  const page = productPage_(payload.pageId);
  const row = notionRow_(page, schema);
  const summary = productSummary_(row, brandMapByPageId_(), {});
  const config = productFieldConfig_();
  const current = productFieldValues_(page, config.fields);
  const assets = listProductAssets_(summary.brandCode, row.productId);
  let change = null;
  if (row.change === BO.CHANGE.PENDING) {
    const pending = pendingChange_(page.id);
    if (pending) {
      const values = pending.request.values || {};
      change = {
        blockId: pending.blockId, requestId: pending.request.requestId, submittedAt: pending.request.submittedAt, submitter: pending.request.submitter,
        diff: config.fields.filter(function (f) { return !f.asset && hasOwn_(values, f.id) && !sameValue_(values[f.id], current[f.id]); })
          .map(function (f) { return { id: f.id, label: f.label, before: describeValue_(current[f.id]), after: describeValue_(values[f.id]) }; }),
        newAssets: (pending.request.assets || [])
      };
    }
  }
  return {
    product: summary, lastEditedAt: page.last_edited_time,
    fields: config.fields.filter(function (f) { return f.active || current[f.id] !== ''; }).map(function (f) {
      return { id: f.id, label: f.label, type: f.type, required: f.required, value: describeValue_(current[f.id]), empty: current[f.id] === '' || (Array.isArray(current[f.id]) && !current[f.id].length) };
    }),
    assets: assets, change: change
  };
}

function apiReviewDecide_(payload) {
  const action = String(payload.action || '');
  const kind = payload.kind === 'change' ? 'change' : 'new';
  if (['approve', 'revision', 'reject'].indexOf(action) < 0) throw userError_('검수 작업을 확인해 주세요.');
  const note = text_(payload.note, 2000);
  if (action !== 'approve' && !note) throw userError_('보완·반려 사유를 입력해 주세요. 브랜드 화면에 그대로 표시됩니다.');
  const schema = notionSchema_('product');
  return withLock_(function () {
    const page = productPage_(payload.pageId);
    const row = notionRow_(page, schema);
    if (payload.expectedSubmittedAt != null && String(row.submittedAt || '') !== String(payload.expectedSubmittedAt || '')) {
      throw userError_('브랜드가 그 사이에 다시 제출했습니다. 새로 고친 뒤 최신 내용을 검수해 주세요.', 'CONFLICT');
    }
    const properties = {};
    let label;
    if (kind === 'new') {
      if (row.review !== BO.REVIEW.PENDING) throw userError_('이미 처리된 상품입니다. (현재 상태: ' + (row.review || '없음') + ')');
      label = action === 'approve' ? BO.REVIEW.APPROVED : action === 'revision' ? BO.REVIEW.REVISION : BO.REVIEW.REJECTED;
      Object.assign(properties, notionProps_(schema, { review: label }, { allowNewOption: true }));
    } else {
      if (row.change !== BO.CHANGE.PENDING) throw userError_('처리할 변경 요청이 없습니다.');
      const pending = pendingChange_(page.id);
      if (!pending) throw userError_('변경 요청 내용을 Notion 본문에서 찾지 못했습니다. 상품 페이지 본문을 확인해 주세요.');
      label = action === 'approve' ? BO.CHANGE.APPLIED : action === 'revision' ? BO.CHANGE.REVISION : BO.CHANGE.REJECTED;
      if (action === 'approve') {
        const fields = productFieldConfig_().fields.filter(function (f) { return f.active; });
        const values = pending.request.values || {};
        if (values.barcode) assertBarcodeFree_(values.barcode, page.id, null);
        Object.assign(properties, productPropsFromInput_(values, fields, { partial: true }));
        const owner = brandByPageId_((row.brand || [])[0]);
        Object.assign(properties, assetFolderProps_(schema, listProductAssets_(owner ? owner.code : '', row.productId)));
      }
      Object.assign(properties, notionProps_(schema, { change: label }, { allowNewOption: true }));
      markChangeBlock_(pending, action === 'approve' ? '✅ 반영됨' : action === 'revision' ? '↩️ 보완 요청' : '⛔ 반려');
    }
    if (schema.ids.reviewNote) properties[schema.ids.reviewNote] = notionRichText_(action === 'approve' ? '' : note);
    const updated = notionPatch_(page.id, properties);
    notionComment_(page.id, '검수 결과: ' + label + (note ? ' — ' + note : '') + ' · ' + activeEmail_());
    bumpCache_('product');
    logInfo_('review.decide', { pageId: page.id, kind: kind, action: action, by: activeEmail_() });
    return { status: label, lastEditedAt: updated.last_edited_time };
  });
}
