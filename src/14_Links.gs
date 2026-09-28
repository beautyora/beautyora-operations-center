/** 상품등록 링크: Notion '상품등록 링크' DB가 원본. 토큰 확인은 5분 캐시를 둔다. */

function linkSummary_(row) {
  const expired = !!row.expiry && row.expiry < today_();
  return {
    pageId: row.pageId, url: row.url, name: row.name || '', brandIds: row.brand || [],
    status: row.status || '', expiry: row.expiry || '', lastAccess: row.lastAccess || '',
    issuer: row.issuer || '', memo: row.memo || '', createdAt: row.createdAt || '',
    expired: expired, active: row.status === BO.LINK.ACTIVE && !expired
  };
}

function partnerBaseUrl_() {
  return prop_(BO.PROPS.PARTNER_WEBAPP_URL) || ScriptApp.getService().getUrl();
}

function partnerUrl_(token) {
  return partnerBaseUrl_() + '?token=' + encodeURIComponent(token);
}

/** 모든 링크(토큰 제외, 5분 캐시). 링크 DB가 없으면 빈 목록. */
function listLinks_() {
  return cached_('link', 'all', BO.LIST_TTL, function () {
    const schema = notionSchema_('link', true);
    if (!schema) return [];
    return notionQueryAll_(schema.sourceId, { sorts: [{ timestamp: 'created_time', direction: 'descending' }] })
      .map(function (page) { return linkSummary_(notionRow_(page, schema)); });
  });
}

function apiLinksOfBrand_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('link');
  const pages = notionQueryAll_(schema.sourceId, { filter: fRelation_(schema, 'brand', brand.pageId), sorts: [{ timestamp: 'created_time', direction: 'descending' }] }, 50);
  return {
    links: pages.map(function (page) {
      const row = notionRow_(page, schema);
      return Object.assign(linkSummary_(row), { link: row.status === BO.LINK.ACTIVE ? partnerUrl_(row.token) : '' });
    })
  };
}

/** 새 링크 발급. 기존 사용 중 링크는 중지한다(브랜드당 링크 1개). */
function apiLinkIssue_(payload) {
  const brand = requireBrand_(payload.code);
  const days = Math.max(1, Math.min(365, Math.floor(Number(payload.days) || 30)));
  const schema = notionSchema_('link');
  return withLock_(function () {
    const active = notionQueryAll_(schema.sourceId, { filter: { and: [fRelation_(schema, 'brand', brand.pageId), fSelect_(schema, 'status', BO.LINK.ACTIVE)] } }, 20);
    active.forEach(function (page) { stopLinkPage_(schema, page, '새 링크 발급으로 중지'); });
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    const expiry = addDays_(today_(), days);
    const properties = notionProps_(schema, {
      name: brand.name + ' 상품등록 링크 (' + today_() + ')', brand: [brand.pageId], token: token,
      status: BO.LINK.ACTIVE, expiry: expiry, issuer: activeEmail_(), memo: text_(payload.memo, 500)
    }, { allowNewOption: true });
    const page = notionCreate_(schema.sourceId, properties);
    bumpCache_('link');
    logInfo_('link.issue', { brand: brand.code, by: activeEmail_(), expiry: expiry });
    return { pageId: page.id, url: partnerUrl_(token), expiry: expiry, stopped: active.length };
  });
}

function stopLinkPage_(schema, page, memo) {
  const values = { status: BO.LINK.STOPPED };
  if (memo && schema.ids.memo) values.memo = memo;
  notionPatch_(page.id, notionProps_(schema, values, { allowNewOption: true }));
  const token = notionValue_(notionPropertyById_(page, schema.ids.token));
  if (token) cache_().remove(cacheKey_('tok:' + sha256_(token)));
}

function apiLinkStop_(payload) {
  const schema = notionSchema_('link');
  return withLock_(function () {
    const page = notionPage_(assertNotionId_(payload.pageId, '링크'));
    const parent = page.parent && (page.parent.data_source_id || page.parent.database_id);
    if (!sameId_(parent, schema.sourceId)) throw userError_('상품등록 링크 DB의 페이지가 아닙니다.');
    stopLinkPage_(schema, page, '관리자 중지 · ' + activeEmail_());
    bumpCache_('link');
    return { stopped: true };
  });
}

/** 토큰 → {브랜드, 링크}. 잘못된 토큰은 모두 같은 문장으로 거절한다. */
function partnerContext_(token) {
  token = String(token || '');
  const invalid = userError_('사용할 수 없는 상품등록 링크입니다. 담당자에게 새 링크를 요청해 주세요.', 'BAD_TOKEN');
  if (!/^[a-f0-9]{32,64}$/i.test(token)) throw invalid;
  const cacheKey = cacheKey_('tok:' + sha256_(token));
  const store = cache_();
  let entry = null;
  const hit = store.get(cacheKey);
  if (hit) { try { entry = JSON.parse(hit); } catch (ignored) {} }
  if (!entry) {
    const schema = notionSchema_('link');
    const pages = notionQueryAll_(schema.sourceId, { filter: fText_(schema, 'token', token) }, 2);
    if (pages.length !== 1) throw invalid;
    const row = notionRow_(pages[0], schema);
    entry = { pageId: row.pageId, status: row.status, expiry: row.expiry, brandId: (row.brand || [])[0] || '', lastAccess: row.lastAccess || '' };
    store.put(cacheKey, JSON.stringify(entry), 300);
  }
  if (entry.status !== BO.LINK.ACTIVE || !entry.brandId) throw invalid;
  if (entry.expiry && entry.expiry < today_()) throw userError_('상품등록 링크의 사용 기간이 끝났습니다. 담당자에게 새 링크를 요청해 주세요.', 'EXPIRED');
  const brand = brandByPageId_(entry.brandId) || (function () {
    const schema = notionSchema_('brand');
    const page = notionPage_(entry.brandId);
    return brandSummary_(notionRow_(page, schema));
  })();
  if (!brand || !brand.code) throw invalid;
  touchLink_(entry, cacheKey);
  return { token: token, linkPageId: entry.pageId, brand: brand };
}

/** 마지막 접속일은 하루 한 번만 기록한다. */
function touchLink_(entry, cacheKey) {
  if (entry.lastAccess === today_()) return;
  try {
    const schema = notionSchema_('link');
    if (!schema.ids.lastAccess) return;
    const patch = {};
    patch[schema.ids.lastAccess] = { date: { start: today_() } };
    notionPatch_(entry.pageId, patch);
    entry.lastAccess = today_();
    cache_().put(cacheKey, JSON.stringify(entry), 300);
  } catch (error) {
    logError_('touchLink_', error);
  }
}
