/**
 * 계산서 · 입금 내역: Notion '계산서 · 입금 내역' DB가 원본.
 * 입점비처럼 한 번 주고받는 돈도, 상품 매입·위탁 정산처럼 반복되는 돈도 한 줄씩 남긴다.
 * 구분이 '입점비'인 내역은 브랜드의 '입점 입금'·'입점 계산서' 속성에도 같은 상태를 적는다.
 */

function billingView_(row) {
  return {
    pageId: row.pageId, url: row.url, edited: row.edited, createdAt: row.createdAt, title: row.name || '', brandIds: row.brand || [],
    kind: row.kind || '', direction: row.direction || '', amount: row.amount, date: row.date || '',
    payStatus: row.payStatus || '', paidAt: row.paidAt || '', invoiceStatus: row.invoiceStatus || '', invoicedAt: row.invoicedAt || '',
    memo: row.memo || '', registrar: row.registrar || ''
  };
}

function billingOpen_(item) {
  return item.payStatus === BO.BILLING.PAY.WAIT || item.invoiceStatus === BO.BILLING.INVOICE.WAIT;
}

/** 전체 내역(5분 캐시). DB가 없으면 빈 목록. */
function listBilling_() {
  return syncedList_('billing', 'billing', billingView_);
}

/** 입금 대기 또는 계산서 발행 대기가 남은 내역(오래된 기준일 먼저). */
function openBillingItems_() {
  return listBilling_().filter(billingOpen_).sort(function (a, b) { return String(a.date || a.createdAt).localeCompare(String(b.date || b.createdAt)); });
}

function billingOptions_(schema) {
  const pick = function (key, fallback) {
    const d = schema.defs[key];
    const names = d && d.select && d.select.options ? d.select.options.map(function (o) { return o.name; }) : [];
    return names.length ? names : fallback;
  };
  const B = BO.BILLING;
  return {
    kind: pick('kind', B.KINDS.slice()), direction: pick('direction', B.DIRECTIONS.slice()),
    pay: pick('payStatus', [B.PAY.WAIT, B.PAY.DONE, B.PAY.NONE]), invoice: pick('invoiceStatus', [B.INVOICE.WAIT, B.INVOICE.DONE, B.INVOICE.NONE])
  };
}

function billingPage_(schema, pageId) {
  const page = notionPage_(assertNotionId_(pageId, '계산서 · 입금 내역'));
  const parent = page.parent && (page.parent.data_source_id || page.parent.database_id);
  if (!sameId_(parent, schema.sourceId)) throw userError_('계산서 · 입금 내역 DB의 페이지가 아닙니다.');
  return page;
}

function assertBillingStatus_(value, allowed, label) {
  const text = text_(value, 50);
  if (allowed.indexOf(text) < 0) throw userError_(label + ': ' + allowed.join(' · ') + ' 중에서 골라 주세요.');
  return text;
}

/** 입점비 내역의 상태를 브랜드의 입점 체크리스트에 옮겨 적는다. */
function syncOnboardFromBilling_(item) {
  if (item.kind !== BO.BILLING.ONBOARD_KIND) return;
  const brandId = (item.brandIds || [])[0];
  if (!brandId) return;
  try {
    const schema = notionSchema_('brand');
    const values = {};
    if (item.payStatus) values[BO.ONBOARD.pay.key] = item.payStatus;
    if (item.invoiceStatus) values[BO.ONBOARD.invoice.key] = item.invoiceStatus;
    const patch = notionProps_(schema, values, { allowNewOption: true });
    if (Object.keys(patch).length) notionPatch_(brandId, patch);
    bumpCache_('brand');
  } catch (error) {
    logError_('syncOnboardFromBilling_', error);
  }
}

/* ---------- 관리자 API ---------- */

function apiBilling_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('billing', true);
  if (!schema) return { connected: false, items: [], options: {} };
  const items = notionQueryAll_(schema.sourceId, { filter: fRelation_(schema, 'brand', brand.pageId), sorts: [{ timestamp: 'created_time', direction: 'descending' }] }, 300)
    .map(function (page) { return billingView_(notionRow_(page, schema)); })
    .sort(function (a, b) { return String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)); });
  const sum = function (list) { return list.reduce(function (total, item) { return total + (Number(item.amount) || 0); }, 0); };
  const payWait = items.filter(function (i) { return i.payStatus === BO.BILLING.PAY.WAIT; });
  const invoiceWait = items.filter(function (i) { return i.invoiceStatus === BO.BILLING.INVOICE.WAIT; });
  return {
    connected: true, items: items, options: billingOptions_(schema),
    summary: { payWait: payWait.length, payWaitAmount: sum(payWait), invoiceWait: invoiceWait.length, invoiceWaitAmount: sum(invoiceWait) }
  };
}

function apiBillingAdd_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('billing');
  const B = BO.BILLING;
  const options = billingOptions_(schema);
  const kind = assertBillingStatus_(payload.kind, options.kind, '구분');
  const direction = payload.direction ? assertBillingStatus_(payload.direction, options.direction, '방향') : '';
  const amount = parseNumber_(payload.amount, '금액', { min: 0 });
  const date = assertDate_(payload.date || today_(), '기준일');
  const payStatus = assertBillingStatus_(payload.payStatus || B.PAY.WAIT, [B.PAY.WAIT, B.PAY.DONE, B.PAY.NONE], '입금 상태');
  const invoiceStatus = assertBillingStatus_(payload.invoiceStatus || B.INVOICE.WAIT, [B.INVOICE.WAIT, B.INVOICE.DONE, B.INVOICE.NONE], '계산서 상태');
  return idempotent_('billing-' + assertId_(payload.requestId, '요청 ID'), function () {
    const values = {
      name: [date, kind, brand.name].join(' · '), brand: [brand.pageId], kind: kind, direction: direction, amount: amount, date: date,
      payStatus: payStatus, paidAt: payStatus === B.PAY.DONE ? date : '',
      invoiceStatus: invoiceStatus, invoicedAt: invoiceStatus === B.INVOICE.DONE ? date : '',
      memo: text_(payload.memo, 2000), registrar: activeEmail_()
    };
    const page = notionCreate_(schema.sourceId, notionProps_(schema, values));
    bumpCache_('billing');
    syncOnboardFromBilling_({ kind: kind, brandIds: [brand.pageId], payStatus: payStatus, invoiceStatus: invoiceStatus });
    logInfo_('billing.add', { code: brand.code, kind: kind, by: activeEmail_() });
    return { pageId: page.id };
  });
}

/** 입금·계산서 상태 바꾸기. 완료로 바꾸면 처리일(기본 오늘)을, 되돌리면 처리일을 지운다. */
function apiBillingUpdate_(payload) {
  const schema = notionSchema_('billing');
  const B = BO.BILLING;
  const at = assertDate_(payload.date || today_(), '처리일');
  return withLock_(function () {
    const page = billingPage_(schema, payload.pageId);
    const values = {};
    if (payload.pay != null) {
      values.payStatus = assertBillingStatus_(payload.pay, [B.PAY.WAIT, B.PAY.DONE, B.PAY.NONE], '입금 상태');
      values.paidAt = values.payStatus === B.PAY.DONE ? at : '';
    }
    if (payload.invoice != null) {
      values.invoiceStatus = assertBillingStatus_(payload.invoice, [B.INVOICE.WAIT, B.INVOICE.DONE, B.INVOICE.NONE], '계산서 상태');
      values.invoicedAt = values.invoiceStatus === B.INVOICE.DONE ? at : '';
    }
    if (!Object.keys(values).length) return { changed: false };
    const updated = notionPatch_(page.id, notionProps_(schema, values));
    const item = billingView_(notionRow_(updated, schema));
    bumpCache_('billing');
    syncOnboardFromBilling_(item);
    logInfo_('billing.update', { pageId: page.id, by: activeEmail_() });
    return { changed: true, item: item };
  });
}
