/** Notion API 클라이언트와 스키마·값 변환. */

function notionToken_() {
  const token = prop_(BO.PROPS.NOTION_TOKEN) || prop_(BO.PROPS.LEGACY_NOTION_TOKEN);
  if (!token) throw userError_('Notion 연결 토큰이 설정되지 않았습니다. 스크립트 속성 BO_NOTION_TOKEN을 확인해 주세요.');
  return token;
}

/**
 * Notion API 호출. 429·409·5xx는 잠시 후 다시 시도한다.
 * 오류는 사람이 이해할 수 있는 문장으로 바꿔 던진다.
 */
function notionRequest_(method, path, body, version) {
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken_(),
      'Notion-Version': version || BO.NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  };
  if (body != null) options.payload = JSON.stringify(body);
  const url = 'https://api.notion.com/v1' + path;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const text = response.getContentText();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch (ignored) { json = { message: text }; }
    if (code >= 200 && code < 300) return json;
    lastError = notionError_(code, json, method, path);
    const retryable = code === 429 || code === 409 || code >= 500;
    if (!retryable || attempt === 3) break;
    let wait = Math.pow(2, attempt) * 700;
    const headers = response.getHeaders ? response.getHeaders() : {};
    const retryAfter = Number(headers && (headers['Retry-After'] || headers['retry-after']));
    if (retryAfter > 0) wait = Math.min(retryAfter * 1000, 10000);
    Utilities.sleep(wait);
  }
  throw lastError;
}

function notionError_(code, json, method, path) {
  const detail = json && json.message ? String(json.message) : '알 수 없는 오류';
  let message;
  if (code === 401) message = 'Notion 연결 토큰이 올바르지 않거나 만료되었습니다.';
  else if (code === 403) message = 'Notion 통합(Integration)에 이 작업 권한이 없습니다. ' + detail;
  else if (code === 404) message = 'Notion에서 대상을 찾을 수 없습니다. 통합이 해당 페이지·DB에 연결되어 있는지 확인해 주세요.';
  else if (code === 429) message = 'Notion 요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.';
  else if (code === 409) message = 'Notion에서 동시에 수정되고 있습니다. 다시 시도해 주세요.';
  else if (code >= 500) message = 'Notion 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
  else message = 'Notion 요청 오류(' + code + '): ' + detail;
  const error = userError_(message, 'NOTION_' + code);
  error.status = code;
  error.detail = method.toUpperCase() + ' ' + path + ' → ' + detail;
  return error;
}

/**
 * propertyIds를 주면 그 속성만 받는다(filter_properties). 관계·롤업·수식처럼 Notion이 계산해야 하는
 * 속성을 빼서 응답이 훨씬 빠르고 작아진다. 속성 ID는 Notion이 준 그대로(이미 URL 인코딩됨) 붙인다.
 */
function notionQuery_(sourceId, body, propertyIds) {
  const query = (propertyIds || []).filter(Boolean).map(function (id) { return 'filter_properties=' + String(id).replace(/[^A-Za-z0-9%_.~-]/g, encodeURIComponent); }).join('&');
  return notionRequest_('post', '/data_sources/' + encodeURIComponent(sourceId) + '/query' + (query ? '?' + query : ''), body || {});
}

/** 조건에 맞는 모든 페이지(휴지통 제외). max로 상한을 둘 수 있다. propertyIds는 notionQuery_ 참고. */
function notionQueryAll_(sourceId, body, max, propertyIds) {
  const pages = [];
  let cursor = '';
  do {
    const request = Object.assign({ page_size: 100 }, body || {});
    if (cursor) request.start_cursor = cursor;
    const response = notionQuery_(sourceId, request, propertyIds);
    (response.results || []).forEach(function (page) { if (!page.archived && !page.in_trash) pages.push(page); });
    cursor = response.has_more ? response.next_cursor : '';
  } while (cursor && (!max || pages.length < max));
  return max ? pages.slice(0, max) : pages;
}

function notionPage_(pageId) {
  return notionRequest_('get', '/pages/' + encodeURIComponent(pageId));
}

function notionPatch_(pageId, properties) {
  return notionRequest_('patch', '/pages/' + encodeURIComponent(pageId), { properties: properties });
}

/** 페이지 댓글. 통합에 댓글 권한이 없으면 조용히 넘어간다(기록 보조용). */
function notionComment_(pageId, text) {
  try {
    notionRequest_('post', '/comments', { parent: { page_id: pageId }, rich_text: notionRichText_(text).rich_text });
    return true;
  } catch (error) {
    logError_('notionComment_', error);
    return false;
  }
}

function notionRichPlain_(items) {
  return (items || []).map(function (item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
}

function notionRichText_(value) {
  const text = String(value == null ? '' : value).trim();
  const items = [];
  for (let offset = 0; offset < text.length && items.length < 100; offset += 2000) {
    items.push({ type: 'text', text: { content: text.slice(offset, offset + 2000) } });
  }
  return { rich_text: items };
}

/* ---------- 데이터 소스와 스키마 ---------- */

function notionSourceId_(kind, optional) {
  const spec = BO_SCHEMAS[kind];
  if (!spec) throw new Error('알 수 없는 Notion DB 종류: ' + kind);
  const id = prop_(spec.prop) || (spec.legacyProp ? prop_(spec.legacyProp) : '');
  if (!id && !optional) throw userError_('Notion ' + spec.label + ' DB가 연결되지 않았습니다. 스크립트 속성 ' + spec.prop + '을 설정해 주세요.');
  return id;
}

function notionSource_(sourceId, fresh) {
  if (fresh) bumpCache_('source');
  return cached_('source', sourceId, 600, function () {
    return notionRequest_('get', '/data_sources/' + encodeURIComponent(sourceId));
  });
}

function notionDefinitions_(source) {
  return Object.keys(source.properties || {}).map(function (name) {
    return Object.assign({}, source.properties[name], { name: name });
  });
}

/**
 * kind의 속성 ID를 찾는다. 처음 찾은 ID를 저장해 두어 Notion에서 이름을 바꿔도 계속 연결된다.
 * optional=true면 DB 미연결 시 null을 돌려준다.
 */
function notionSchema_(kind, optional) {
  const memoKey = 'schema:' + kind;
  if (hasOwn_(BO_MEMO_, memoKey)) return BO_MEMO_[memoKey];
  const spec = BO_SCHEMAS[kind];
  const sourceId = notionSourceId_(kind, optional);
  if (!sourceId) return null;
  const source = notionSource_(sourceId);
  const definitions = notionDefinitions_(source);
  const byName = {};
  definitions.forEach(function (d) { byName[d.name] = d; });
  let saved = {};
  try { saved = JSON.parse(prop_(BO.PROPS.SCHEMA_IDS) || '{}'); } catch (ignored) {}
  const savedMap = saved[sourceId] || {};
  const ids = {}, defs = {}, missing = [];
  Object.keys(spec.fields).forEach(function (key) {
    const field = spec.fields[key];
    const type = field[0], names = field[1], required = field[2];
    let found = savedMap[key] ? definitions.find(function (d) { return d.id === savedMap[key] && d.type === type; }) : null;
    if (!found) found = names.map(function (n) { return byName[n]; }).find(function (d) { return d && d.type === type; });
    if (!found) {
      if (required) {
        const wrongType = names.map(function (n) { return byName[n]; }).find(Boolean);
        missing.push(names[0] + (wrongType ? '(현재 형식: ' + wrongType.type + ')' : ''));
      }
      return;
    }
    ids[key] = found.id;
    defs[key] = found;
  });
  if (missing.length) {
    throw userError_('Notion ' + spec.label + ' DB에 필요한 속성이 없거나 형식이 다릅니다: ' + missing.join(', ') + '. 설정 화면에서 초기 설정을 실행해 주세요.');
  }
  const changed = Object.keys(ids).some(function (key) { return savedMap[key] !== ids[key]; });
  if (changed) {
    saved[sourceId] = Object.assign({}, savedMap, ids);
    try { props_().setProperty(BO.PROPS.SCHEMA_IDS, JSON.stringify(saved)); } catch (error) { logError_('schema save', error); }
  }
  const byId = {};
  definitions.forEach(function (d) { byId[d.id] = d; });
  const schema = { kind: kind, label: spec.label, sourceId: sourceId, source: source, ids: ids, defs: defs, byId: byId, definitions: definitions };
  BO_MEMO_[memoKey] = schema;
  return schema;
}

function notionPropertyById_(page, id) {
  const properties = page && page.properties || {};
  const names = Object.keys(properties);
  for (let i = 0; i < names.length; i++) if (properties[names[i]].id === id) return properties[names[i]];
  return null;
}

/** Notion 속성 값을 JS 기본 값으로 바꾼다. */
function notionValue_(property) {
  if (!property) return null;
  const type = property.type;
  const value = property[type];
  switch (type) {
    case 'title':
    case 'rich_text': return notionRichPlain_(value);
    case 'number': return value == null ? null : value;
    case 'select':
    case 'status': return value ? value.name : '';
    case 'multi_select': return (value || []).map(function (item) { return item.name; });
    case 'relation': return (value || []).map(function (item) { return item.id; });
    case 'people': return (value || []).map(function (item) { return { id: item.id, name: item.name || (item.person && item.person.email) || '' }; });
    case 'date': return value ? value.start : '';
    case 'checkbox': return !!value;
    case 'url':
    case 'email':
    case 'phone_number': return value || '';
    case 'created_time':
    case 'last_edited_time': return value || '';
    case 'files': return (value || []).map(function (file) { return { name: file.name || '', url: (file.external && file.external.url) || (file.file && file.file.url) || '' }; });
    case 'formula': return value ? value[value.type] : null;
    case 'rollup':
      if (!value) return null;
      if (value.type === 'array') return (value.array || []).map(notionValue_);
      return value[value.type];
    case 'unique_id': return value ? (value.prefix ? value.prefix + '-' : '') + value.number : '';
    case 'created_by':
    case 'last_edited_by': return value ? value.name || '' : '';
    default: return null;
  }
}

/** 화면 표시용 문자열. */
function notionPlain_(property) {
  const value = notionValue_(property);
  if (value == null) return '';
  if (property && property.type === 'checkbox') return value ? '예' : '아니오';
  if (Array.isArray(value)) {
    return value.map(function (item) {
      if (item && typeof item === 'object') return item.name || item.url || '';
      return item == null ? '' : String(item);
    }).filter(Boolean).join(', ');
  }
  return String(value);
}

/** 페이지를 스키마 키 기준 객체로 바꾼다. */
function notionRow_(page, schema) {
  const row = { pageId: page.id, url: page.url || '', edited: page.last_edited_time || '', createdAt: page.created_time || '' };
  Object.keys(schema.ids).forEach(function (key) {
    row[key] = notionValue_(notionPropertyById_(page, schema.ids[key]));
  });
  return row;
}

/** JS 값 → Notion 속성 쓰기 값. 선택지는 기존 선택지만 허용한다. */
function notionWrite_(definition, value, options) {
  options = options || {};
  const type = definition.type;
  const label = definition.name;
  const text = Array.isArray(value) ? '' : String(value == null ? '' : value).trim();
  switch (type) {
    case 'title':
      if (!text) throw userError_(label + '을(를) 입력해 주세요.');
      return { title: notionRichText_(text.slice(0, 2000)).rich_text };
    case 'rich_text':
      if (text.length > 100000) throw userError_(label + ': 100,000자 이내로 입력해 주세요.');
      return notionRichText_(text);
    case 'number':
      return { number: typeof value === 'number' ? value : parseNumber_(text, label) };
    case 'url':
      if (text && !/^https?:\/\/\S+$/i.test(text)) throw userError_(label + ': http:// 또는 https://로 시작하는 주소를 입력해 주세요.');
      return { url: text || null };
    case 'select': {
      const names = (definition.select && definition.select.options || []).map(function (o) { return o.name; });
      if (text && names.indexOf(text) < 0 && !options.allowNewOption) throw userError_(label + ': 등록된 선택지에서 골라 주세요. (' + text + ')');
      return { select: text ? { name: text } : null };
    }
    case 'status':
      return { status: text ? { name: text } : null };
    case 'multi_select': {
      const list = (Array.isArray(value) ? value : String(value == null ? '' : value).split(','))
        .map(function (item) { return String(item).trim(); }).filter(Boolean)
        .filter(function (item, index, array) { return array.indexOf(item) === index; });
      const names = (definition.multi_select && definition.multi_select.options || []).map(function (o) { return o.name; });
      const unknown = list.filter(function (item) { return names.indexOf(item) < 0; });
      if (unknown.length && !options.allowNewOption) throw userError_(label + ': 등록된 선택지만 고를 수 있습니다. (' + unknown.join(', ') + ')');
      if (list.length > 100) throw userError_(label + ': 선택은 100개까지 가능합니다.');
      return { multi_select: list.map(function (name) { return { name: name }; }) };
    }
    case 'checkbox':
      return { checkbox: value === true || String(value).toLowerCase() === 'true' || value === '예' };
    case 'date': {
      if (!text) return { date: null };
      if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(text)) throw userError_(label + ': 날짜 형식을 확인해 주세요. (예: 2026-09-28)');
      return { date: { start: text } };
    }
    case 'email':
      if (text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw userError_(label + ': 이메일 형식을 확인해 주세요.');
      return { email: text || null };
    case 'phone_number':
      return { phone_number: text || null };
    case 'relation':
      return { relation: (Array.isArray(value) ? value : [value]).filter(Boolean).map(function (id) { return { id: String(id) }; }) };
    case 'people':
      return { people: (Array.isArray(value) ? value : [value]).filter(Boolean).map(function (id) { return { id: String(id) }; }) };
    case 'files':
      return { files: (Array.isArray(value) ? value : []).filter(function (f) { return f && f.url; }).map(function (f) { return { name: String(f.name || '파일').slice(0, 100), type: 'external', external: { url: f.url } }; }) };
    default:
      throw userError_(label + ': 운영센터에서 수정할 수 없는 Notion 속성 형식입니다. (' + type + ')');
  }
}

/** { 스키마키: 값 } → Notion properties. 연결되지 않은 선택 속성은 건너뛴다. */
function notionProps_(schema, values, options) {
  const out = {};
  Object.keys(values).forEach(function (key) {
    if (!schema.defs[key]) return;
    out[schema.ids[key]] = notionWrite_(schema.defs[key], values[key], options);
  });
  return out;
}

/* ---------- 목록 캐시 + 변경분 따라잡기 ---------- */

/**
 * 목록 전체를 다시 읽는 간격(초)과, 그 사이 Notion에 '바뀐 페이지'를 물어보는 최소 간격(밀리초).
 * 수정·추가는 바뀐 페이지 질의로 바로 반영되므로 전체 다시 읽기는 삭제(휴지통) 정리용이다. 새로 고침 버튼은 바로 다시 읽는다.
 */
var BO_LIST_FULL_TTL_ = 1800;
var BO_LIST_SYNC_GAP_MS_ = 10000;

function notionMaxEdited_(pages, start) {
  return pages.reduce(function (max, page) { return String(page.last_edited_time || '') > max ? String(page.last_edited_time) : max; }, start || '');
}

/**
 * Notion DB 목록을 캐시하되, Notion에서 직접 고친 내용도 곧바로 보이게 한다.
 * - 전체 목록은 BO_LIST_FULL_TTL_마다 새로 읽는다(삭제된 페이지 정리 포함).
 * - 그 사이에는 요청 때마다(최소 BO_LIST_SYNC_GAP_MS_ 간격) '마지막으로 본 수정 시각 이후 수정된 페이지'만 물어 바꿔 끼운다.
 * - 기준 시각은 Notion이 준 last_edited_time을 쓰므로 서버 시계와 어긋나도 빠뜨리지 않는다(Notion은 분 단위라 1분 겹쳐 묻는다).
 * view(row, page)는 한 페이지를 목록 항목으로 바꾼다. 항목에는 pageId·createdAt이 있어야 한다.
 */
/** 목록에 쓰는 속성만 받는다. Notion이 filter_properties를 거절하면(400) 한 번 전체 속성으로 다시 묻고 6시간 동안 그렇게 한다. */
function syncedQuery_(schema, body, max) {
  const ids = Object.keys(schema.ids).map(function (key) { return schema.ids[key]; }).filter(Boolean);
  if (!ids.length || cache_().get(cacheKey_('noFilterProps'))) return notionQueryAll_(schema.sourceId, body, max);
  try {
    return notionQueryAll_(schema.sourceId, body, max, ids);
  } catch (error) {
    if (error.status !== 400) throw error;
    logError_('syncedQuery_ filter_properties', error);
    cache_().put(cacheKey_('noFilterProps'), '1', 21600);
    return notionQueryAll_(schema.sourceId, body, max);
  }
}

function syncedList_(namespace, kind, view) {
  const schema = notionSchema_(kind, true);
  if (!schema) return [];
  const now = Date.now();
  const sortItems = function (items) { return items.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }); };
  let entry = cacheGetJson_(namespace, 'synced');
  if (!entry || !Array.isArray(entry.items) || now - entry.fullAt > BO_LIST_FULL_TTL_ * 1000) {
    const pages = syncedQuery_(schema, { sorts: [{ timestamp: 'created_time', direction: 'descending' }] });
    entry = { fullAt: now, checkedAt: now, mark: notionMaxEdited_(pages), items: pages.map(function (page) { return view(notionRow_(page, schema), page); }) };
    return cachePutJson_(namespace, 'synced', entry, BO_LIST_FULL_TTL_).items;
  }
  if (!entry.mark || now - entry.checkedAt < BO_LIST_SYNC_GAP_MS_) return entry.items;
  const since = new Date(Date.parse(entry.mark) - 60000).toISOString();
  let pages = [];
  try {
    pages = syncedQuery_(schema, { filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } }, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] }, 200);
  } catch (error) {
    logError_('syncedList_ ' + kind, error);
    return entry.items;
  }
  if (pages.length >= 200) { bumpCache_(namespace); return syncedList_(namespace, kind, view); }
  if (pages.length) {
    const byId = {};
    pages.forEach(function (page) { byId[String(page.id).replace(/-/g, '')] = view(notionRow_(page, schema), page); });
    const kept = entry.items.filter(function (item) { return !byId[String(item.pageId).replace(/-/g, '')]; });
    entry.items = sortItems(kept.concat(Object.keys(byId).map(function (key) { return byId[key]; })));
    entry.mark = notionMaxEdited_(pages, entry.mark);
  }
  entry.checkedAt = now;
  const remaining = Math.max(30, BO_LIST_FULL_TTL_ - Math.floor((now - entry.fullAt) / 1000));
  return cachePutJson_(namespace, 'synced', entry, remaining).items;
}
