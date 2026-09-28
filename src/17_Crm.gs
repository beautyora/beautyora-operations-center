/** 브랜드 영업 기록(Notion '연락 · 진행 이력')과 공급조건(Notion '벤더 동일 상품 조건'). */

function activityView_(row) {
  return {
    pageId: row.pageId, url: row.url, edited: row.edited, title: row.name || '', brandIds: row.brand || [],
    date: row.date || '', method: row.method || '', result: row.result || '', counterpart: row.counterpart || '',
    content: row.content || '', next: row.next || '', due: row.due || '', done: !!row.done,
    staff: (row.staff || []).map(function (p) { return p.name; }).filter(Boolean)
  };
}

function apiActivities_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('activity', true);
  if (!schema) return { connected: false, activities: [], options: {} };
  const pages = notionQueryAll_(schema.sourceId, {
    filter: fRelation_(schema, 'brand', brand.pageId),
    sorts: [{ property: schema.ids.date, direction: 'descending' }]
  }, 100);
  return { connected: true, activities: pages.map(function (page) { return activityView_(notionRow_(page, schema)); }), options: activityOptions_(schema) };
}

function activityOptions_(schema) {
  const pick = function (key) {
    const d = schema.defs[key];
    return d && d.select && d.select.options ? d.select.options.map(function (o) { return o.name; }) : [];
  };
  return { method: pick('method'), result: pick('result') };
}

function apiActivityAdd_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('activity');
  const date = assertDate_(payload.date || today_(), '활동일');
  const due = assertDate_(payload.due, '후속 확인일', true);
  const content = text_(payload.content, 12000);
  if (!content) throw userError_('상담 내용을 입력해 주세요.');
  return idempotent_('activity-' + assertId_(payload.requestId, '요청 ID'), function () {
    const author = activeEmail_();
    const values = {
      name: [date, payload.method || '기록', payload.result || ''].filter(Boolean).join(' · ') + ' · ' + brand.name,
      brand: [brand.pageId], date: date, method: text_(payload.method, 50), result: text_(payload.result, 50),
      counterpart: text_(payload.counterpart, 200), content: content + '\n— 작성: ' + author,
      next: text_(payload.next, 2000), due: due, done: false
    };
    const userId = schema.ids.staff ? notionUserIdByEmail_(author) : '';
    if (userId) values.staff = [userId];
    const page = notionCreate_(schema.sourceId, notionProps_(schema, values));
    if (payload.updateBrandNext && text_(payload.next)) {
      const brandSchema = notionSchema_('brand');
      if (brandSchema.ids.next) notionPatch_(brand.pageId, notionProps_(brandSchema, { next: text_(payload.next, 2000) }));
      bumpCache_('brand');
    }
    bumpCache_('activity');
    return { pageId: page.id };
  });
}

function apiActivityDone_(payload) {
  const schema = notionSchema_('activity');
  const page = notionPage_(assertNotionId_(payload.pageId, '영업 기록'));
  const parent = page.parent && (page.parent.data_source_id || page.parent.database_id);
  if (!sameId_(parent, schema.sourceId)) throw userError_('영업 기록 DB의 페이지가 아닙니다.');
  notionPatch_(page.id, notionProps_(schema, { done: payload.done !== false }));
  bumpCache_('activity');
  return { done: payload.done !== false };
}

/** 오늘까지 후속 확인이 필요한 영업 기록(대시보드). */
function dueFollowups_() {
  const schema = notionSchema_('activity', true);
  if (!schema || !schema.ids.due || !schema.ids.done) return [];
  return cached_('activity', 'due:' + today_(), 300, function () {
    const brandMap = brandMapByPageId_();
    return notionQueryAll_(schema.sourceId, {
      filter: { and: [fCheckbox_(schema, 'done', false), { property: schema.ids.due, date: { on_or_before: today_() } }] },
      sorts: [{ property: schema.ids.due, direction: 'ascending' }]
    }, 100).map(function (page) {
      const view = activityView_(notionRow_(page, schema));
      const brand = view.brandIds.map(function (id) { return brandMap[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
      return Object.assign(view, { brandCode: brand.code || '', brandName: brand.name || '' });
    });
  });
}

function apiTerms_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('terms', true);
  if (!schema) return { connected: false, terms: [] };
  const productNames = {};
  listProducts_().forEach(function (p) { productNames[String(p.pageId).replace(/-/g, '')] = p.name; });
  const pages = notionQueryAll_(schema.sourceId, { filter: fRelation_(schema, 'vendor', brand.pageId) }, 200);
  return {
    connected: true,
    terms: pages.map(function (page) {
      const row = notionRow_(page, schema);
      return {
        pageId: row.pageId, url: row.url, name: row.name || '', trade: row.trade || [], state: row.state || '',
        purchase: row.purchase, consign: row.consign, retail: row.retail, online: row.online, moq: row.moq, shipping: row.shipping,
        basis: row.basis || '', adopted: !!row.adopted, onlineCondition: row.onlineCondition || '', note: row.note || '',
        products: (row.product || []).map(function (id) { return productNames[String(id).replace(/-/g, '')] || ''; }).filter(Boolean)
      };
    }).sort(function (a, b) { return (b.adopted ? 1 : 0) - (a.adopted ? 1 : 0) || String(b.basis).localeCompare(String(a.basis)); })
  };
}
