/** 브랜드: Notion '브랜드 목록'이 원본. 운영센터는 읽기만 한다(수정은 Notion에서). */

function brandSummary_(row) {
  return {
    pageId: row.pageId, url: row.url, edited: row.edited, createdAt: row.createdAt,
    code: row.code || '', name: row.name || '', company: row.company || '',
    stage: row.stage || '', reStage: row.reStage || '', reClass: row.reClass || '', priority: row.priority || '',
    contactName: row.contactName || '', phone: row.phone || '', email: row.email || '',
    category: row.category || [], trade: row.trade || [],
    memo: row.memo || '', next: row.next || '', drive: row.drive || '', bizNo: row.bizNo || '',
    received: row.received || '', issue: row.issue || '',
    owners: (row.owner || []).map(function (p) { return p.name; }).filter(Boolean),
    shareEmails: row.shareEmails || ''
  };
}

/** 전체 브랜드(5분 캐시). fresh=true면 Notion에서 다시 읽는다. */
function listBrands_(fresh) {
  if (fresh) bumpCache_('brand');
  notionSchema_('brand');
  return syncedList_('brand', 'brand', brandSummary_);
}

/** 브랜드 한 곳만 Notion에서 다시 읽어 목록 캐시에 반영한다(page를 주면 그 값을 쓴다). */
function refreshBrand_(pageId, page) {
  return syncedRefreshPage_('brand', 'brand', brandSummary_, pageId, page);
}

function brandMapByPageId_() {
  const map = {};
  listBrands_().forEach(function (brand) { map[String(brand.pageId).replace(/-/g, '')] = brand; });
  return map;
}

/** 브랜드 ID(BO-0001)로 찾는다. 캐시에 없으면 Notion에서 직접 확인한다. */
function brandByCode_(code) {
  code = String(code || '').trim();
  if (!code) return null;
  const hit = listBrands_().find(function (brand) { return brand.code === code; });
  if (hit) return hit;
  const schema = notionSchema_('brand');
  const pages = notionQueryAll_(schema.sourceId, { filter: { property: schema.ids.code, rich_text: { equals: code } } }, 2);
  if (pages.length > 1) throw userError_('Notion에 같은 브랜드 ID가 두 개 있습니다: ' + code);
  if (!pages.length) return null;
  return refreshBrand_(pages[0].id, pages[0]);
}

function requireBrand_(code) {
  const brand = brandByCode_(code);
  if (!brand) throw userError_('브랜드를 찾을 수 없습니다: ' + (code || '(빈 값)'));
  return brand;
}

/* ---------- 관리자 API ---------- */

function apiBrandsList_() {
  return { brands: listBrands_(), options: brandFilterOptions_() };
}

function brandFilterOptions_() {
  const schema = notionSchema_('brand');
  const pick = function (key) {
    const definition = schema.defs[key];
    return definition && definition[definition.type] && definition[definition.type].options ? definition[definition.type].options.map(function (o) { return o.name; }) : [];
  };
  return { stage: pick('stage'), priority: pick('priority') };
}
