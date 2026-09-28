/** 브랜드: Notion '브랜드 목록'이 원본. */

function brandSummary_(row) {
  return {
    pageId: row.pageId, url: row.url, edited: row.edited, createdAt: row.createdAt,
    code: row.code || '', name: row.name || '', company: row.company || '',
    stage: row.stage || '', reStage: row.reStage || '', reClass: row.reClass || '', priority: row.priority || '',
    contactName: row.contactName || '', phone: row.phone || '', email: row.email || '',
    category: row.category || [], trade: row.trade || [], area: row.area || [],
    channelAny: row.channelAny || '', channel1: row.channel1 || '', channel2: row.channel2 || '',
    currentSales: row.currentSales || '', feature: row.feature || '', reference: row.reference || '',
    memo: row.memo || '', next: row.next || '', received: row.received || '', launch: row.launch || '',
    owners: (row.owner || []).map(function (p) { return p.name; }).filter(Boolean),
    formSubmitted: !!row.formSubmitted, issue: row.issue || '', drive: row.drive || '', bizNo: row.bizNo || '',
    formResponseId: row.formResponseId || '',
    docs: { business: row.docBusiness || '', bank: row.docBank || '', intro: row.docIntro || '', contract: row.docContract || '', other: row.docOther || '' }
  };
}

/** 전체 브랜드(5분 캐시). fresh=true면 Notion에서 다시 읽는다. */
function listBrands_(fresh) {
  if (fresh) bumpCache_('brand');
  return cached_('brand', 'all', BO.LIST_TTL, function () {
    const schema = notionSchema_('brand');
    return notionQueryAll_(schema.sourceId, { sorts: [{ timestamp: 'created_time', direction: 'descending' }] })
      .map(function (page) { return brandSummary_(notionRow_(page, schema)); });
  });
}

function brandMapByPageId_() {
  const map = {};
  listBrands_().forEach(function (brand) { map[String(brand.pageId).replace(/-/g, '')] = brand; });
  return map;
}

function brandByPageId_(pageId) {
  return brandMapByPageId_()[String(pageId || '').replace(/-/g, '')] || null;
}

/** 브랜드 ID(BO-0001)로 찾는다. 캐시에 없으면 Notion에서 직접 확인한다. */
function brandByCode_(code) {
  code = String(code || '').trim();
  if (!code) return null;
  const hit = listBrands_().find(function (brand) { return brand.code === code; });
  if (hit) return hit;
  const schema = notionSchema_('brand');
  const pages = notionQueryAll_(schema.sourceId, { filter: fText_(schema, 'code', code) }, 2);
  if (pages.length > 1) throw userError_('Notion에 같은 브랜드 ID가 두 개 있습니다: ' + code);
  if (!pages.length) return null;
  bumpCache_('brand');
  return brandSummary_(notionRow_(pages[0], schema));
}

function requireBrand_(code) {
  const brand = brandByCode_(code);
  if (!brand) throw userError_('브랜드를 찾을 수 없습니다: ' + (code || '(빈 값)'));
  return brand;
}

function brandPage_(brand) {
  const schema = notionSchema_('brand');
  const page = notionPage_(brand.pageId);
  const parent = page.parent && (page.parent.data_source_id || page.parent.database_id);
  if (!sameId_(parent, schema.sourceId)) throw userError_('연결된 브랜드 DB의 페이지가 아닙니다.');
  return page;
}

function brandProtectedIds_(schema) {
  return ['code', 'formResponseId', 'docBusiness', 'docBank', 'docIntro', 'docContract', 'docOther']
    .map(function (key) { return schema.ids[key]; }).filter(Boolean);
}

/* ---------- 관리자 API ---------- */

function apiBrandsList_() {
  const brands = listBrands_();
  const products = listProducts_();
  const links = listLinks_();
  const stats = {};
  products.forEach(function (product) {
    (product.brandIds || []).forEach(function (id) {
      const key = String(id).replace(/-/g, '');
      const item = stats[key] || (stats[key] = { products: 0, pending: 0 });
      item.products++;
      if (product.review === BO.REVIEW.PENDING || product.change === BO.CHANGE.PENDING) item.pending++;
    });
  });
  const activeLink = {};
  links.forEach(function (link) {
    if (link.active) (link.brandIds || []).forEach(function (id) { activeLink[String(id).replace(/-/g, '')] = link; });
  });
  return {
    brands: brands.map(function (brand) {
      const key = String(brand.pageId).replace(/-/g, '');
      const link = activeLink[key];
      return Object.assign({}, brand, {
        productCount: stats[key] ? stats[key].products : 0,
        pendingCount: stats[key] ? stats[key].pending : 0,
        link: link ? { expiry: link.expiry, lastAccess: link.lastAccess } : null
      });
    }),
    options: brandFilterOptions_()
  };
}

function brandFilterOptions_() {
  const schema = notionSchema_('brand');
  const pick = function (key) {
    const definition = schema.defs[key];
    return definition && definition[definition.type] && definition[definition.type].options ? definition[definition.type].options.map(function (o) { return o.name; }) : [];
  };
  return { stage: pick('stage'), priority: pick('priority'), reClass: pick('reClass'), category: pick('category') };
}

function apiBrandDetail_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('brand');
  const page = brandPage_(brand);
  return {
    brand: brandSummary_(notionRow_(page, schema)),
    lastEditedAt: page.last_edited_time,
    properties: notionPropertyList_(page, schema.definitions, brandProtectedIds_(schema))
  };
}

function apiBrandBody_(payload) {
  const brand = requireBrand_(payload.code);
  return { blocks: notionBlocks_(brand.pageId, 0) };
}

function apiBrandUpdate_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('brand');
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (!changes.length) return { changed: false };
  if (changes.length > 40) throw userError_('한 번에 40개 속성까지 수정할 수 있습니다.');
  return withLock_(function () {
    const page = brandPage_(brand);
    if (payload.lastEditedAt && page.last_edited_time !== payload.lastEditedAt) {
      throw userError_('다른 사람이 Notion에서 먼저 수정했습니다. 새로 고친 뒤 다시 저장해 주세요.', 'CONFLICT');
    }
    const protectedIds = brandProtectedIds_(schema);
    const editable = notionEditableTypes_();
    const patch = {}, expected = {};
    changes.forEach(function (change) {
      const definition = schema.byId[String(change.id || '')];
      if (!definition || !editable[definition.type] || protectedIds.indexOf(definition.id) >= 0 || hasOwn_(patch, definition.id)) {
        throw userError_('수정할 수 없는 브랜드 속성이 포함되어 있습니다.');
      }
      patch[definition.id] = notionWrite_(definition, change.value);
      expected[definition.id] = notionInputComparable_(definition, change.value);
    });
    const updated = notionPatch_(page.id, patch);
    notionVerify_(updated, schema.byId, expected);
    bumpCache_('brand');
    logInfo_('brand.update', { code: brand.code, by: activeEmail_(), fields: Object.keys(patch).length });
    return { changed: true, lastEditedAt: updated.last_edited_time };
  });
}
