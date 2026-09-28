/** 공용 유틸리티: 오류, 시간, 잠금, 캐시, 입력 검증. */

/** 사용자에게 그대로 보여 줘도 되는 오류. */
function userError_(message, code) {
  const error = new Error(message);
  error.userFacing = true;
  if (code) error.code = code;
  return error;
}

function errorMessage_(error) {
  const message = error && error.message ? error.message : String(error || '알 수 없는 오류');
  return message.replace(/^Exception:\s*/, '');
}

function logError_(context, error) {
  try {
    console.error(JSON.stringify({ context: context, message: errorMessage_(error), stack: error && error.stack ? String(error.stack).slice(0, 2000) : '' }));
  } catch (ignored) {}
}

function logInfo_(context, detail) {
  try { console.log(JSON.stringify({ context: context, detail: detail })); } catch (ignored) {}
}

function hasOwn_(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function prop_(key) {
  return String(props_().getProperty(key) || '').trim();
}

function now_() {
  return Utilities.formatDate(new Date(), BO.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function today_() {
  return Utilities.formatDate(new Date(), BO.TIMEZONE, 'yyyy-MM-dd');
}

function addDays_(dateText, days) {
  const base = dateText ? new Date(dateText + 'T00:00:00+09:00') : new Date();
  return Utilities.formatDate(new Date(base.getTime() + days * 86400000), BO.TIMEZONE, 'yyyy-MM-dd');
}

function uuid_(prefix) {
  return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 20).toUpperCase();
}

function sha256_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function clean_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeName_(value) {
  return clean_(value).toLowerCase().replace(/[\s._\-·()\[\]{}]/g, '');
}

function text_(value, max) {
  const text = String(value == null ? '' : value).trim();
  return max ? text.slice(0, max) : text;
}

function assertId_(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(text)) throw userError_((label || '식별자') + '가 올바르지 않습니다.');
  return text;
}

function assertNotionId_(value, label) {
  const text = String(value || '');
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(text)) throw userError_((label || 'Notion 페이지') + ' ID가 올바르지 않습니다.');
  return text;
}

function assertDate_(value, label, optional) {
  const text = String(value || '').trim();
  if (!text && optional) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw userError_((label || '날짜') + ' 형식을 확인해 주세요. (예: 2026-09-28)');
  const date = new Date(text + 'T00:00:00Z');
  if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw userError_((label || '날짜') + '가 올바르지 않습니다.');
  return text;
}

function sameId_(a, b) {
  return String(a || '').replace(/-/g, '').toLowerCase() === String(b || '').replace(/-/g, '').toLowerCase() && !!a;
}

/** 스크립트 전역 잠금. 짧은 쓰기 구간만 감싼다. */
function withLock_(callback, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 20000)) throw userError_('다른 작업을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
  try { return callback(); } finally { lock.releaseLock(); }
}

/* ---------- 캐시 ---------- */
// CacheService 값은 100KB 제한이 있어 큰 목록은 조각으로 나눠 저장한다.
const BO_MEMO_ = {};
const BO_CACHE_CHUNK_ = 90000;

function cache_() {
  return CacheService.getScriptCache();
}

function cacheKey_(key) {
  const text = 'bo2:' + key;
  return text.length > 200 ? 'bo2h:' + sha256_(text) : text;
}

function cacheVersion_(namespace) {
  const store = cache_();
  const key = cacheKey_('ver:' + namespace);
  let version = store.get(key);
  if (!version) {
    version = String(Date.now());
    store.put(key, version, 21600);
  }
  return version;
}

/** 쓰기 후 호출하면 해당 영역의 캐시가 모두 무효화된다. */
function bumpCache_() {
  const store = cache_();
  Array.prototype.slice.call(arguments).forEach(function (namespace) {
    store.put(cacheKey_('ver:' + namespace), String(Date.now()) + Math.random().toString(36).slice(2, 6), 21600);
    Object.keys(BO_MEMO_).forEach(function (key) { if (key.indexOf(namespace + ':') === 0) delete BO_MEMO_[key]; });
  });
}

function cacheGetJson_(namespace, key) {
  const memoKey = namespace + ':' + key;
  if (hasOwn_(BO_MEMO_, memoKey)) return BO_MEMO_[memoKey];
  const store = cache_();
  const full = cacheKey_(namespace + ':' + cacheVersion_(namespace) + ':' + key);
  const head = store.get(full);
  if (!head) return null;
  try {
    const meta = JSON.parse(head);
    if (!meta || typeof meta.n !== 'number') return null;
    const keys = [];
    for (let i = 0; i < meta.n; i++) keys.push(full + ':' + i);
    const parts = store.getAll(keys);
    let text = '';
    for (let i = 0; i < meta.n; i++) {
      if (parts[keys[i]] == null) return null;
      text += parts[keys[i]];
    }
    const value = JSON.parse(text);
    BO_MEMO_[memoKey] = value;
    return value;
  } catch (error) {
    return null;
  }
}

function cachePutJson_(namespace, key, value, ttl) {
  BO_MEMO_[namespace + ':' + key] = value;
  try {
    const store = cache_();
    const full = cacheKey_(namespace + ':' + cacheVersion_(namespace) + ':' + key);
    const text = JSON.stringify(value);
    const chunks = {};
    let n = 0;
    for (let offset = 0; offset < text.length; offset += BO_CACHE_CHUNK_) chunks[full + ':' + (n++)] = text.slice(offset, offset + BO_CACHE_CHUNK_);
    if (n > 40) return value; // 너무 큰 값은 실행 중 메모에만 둔다.
    store.putAll(chunks, ttl || BO.LIST_TTL);
    store.put(full, JSON.stringify({ n: n }), ttl || BO.LIST_TTL);
  } catch (error) {
    logError_('cachePutJson_', error);
  }
  return value;
}

function cached_(namespace, key, ttl, producer) {
  const hit = cacheGetJson_(namespace, key);
  if (hit != null) return hit;
  return cachePutJson_(namespace, key, producer(), ttl);
}

/** 같은 요청ID로 다시 들어온 쓰기 요청의 결과를 돌려준다(네트워크 재시도 대비). */
function idempotent_(requestKey, producer) {
  const key = cacheKey_('req:' + sha256_(String(requestKey)));
  const store = cache_();
  const previous = store.get(key);
  if (previous) {
    try { return Object.assign(JSON.parse(previous), { duplicate: true }); } catch (ignored) {}
  }
  const result = producer();
  // 실패(검증 오류) 결과는 저장하지 않는다. 고친 뒤 같은 요청으로 다시 보낼 수 있게.
  if (result && result.ok !== false) {
    try { store.put(key, JSON.stringify(result), 21600); } catch (ignored) {}
  }
  return result;
}

function parseNumber_(value, label, options) {
  options = options || {};
  const text = String(value == null ? '' : value).replace(/[,\s원]/g, '');
  if (!text) {
    if (options.required) throw userError_(label + '을(를) 입력해 주세요.');
    return null;
  }
  const number = Number(text);
  if (!isFinite(number)) throw userError_(label + '은(는) 숫자로 입력해 주세요.');
  if (options.min != null && number < options.min) throw userError_(label + '은(는) ' + options.min + ' 이상이어야 합니다.');
  if (options.integer && Math.floor(number) !== number) throw userError_(label + '은(는) 정수로 입력해 주세요.');
  return number;
}

function formatBizNo_(value) {
  const original = clean_(value);
  const digits = original.replace(/\D/g, '');
  if (digits.length !== 10) return original;
  return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
}

function formatPhone_(value) {
  const original = clean_(value);
  if (!original || /\+|[A-Za-z가-힣]/.test(original)) return original;
  const digits = original.replace(/\D/g, '');
  if (digits.length === 8) return digits.slice(0, 4) + '-' + digits.slice(4);
  if (digits.indexOf('02') === 0) {
    if (digits.length === 9) return '02-' + digits.slice(2, 5) + '-' + digits.slice(5);
    if (digits.length === 10) return '02-' + digits.slice(2, 6) + '-' + digits.slice(6);
    return original;
  }
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  if (digits.length === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  return original;
}

function sanitizeFileName_(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150);
}

function driveIdFromUrl_(value) {
  const text = String(value || '');
  const match = text.match(/\/folders\/([\w-]{10,})/) || text.match(/\/d\/([\w-]{10,})/) || text.match(/[?&]id=([\w-]{10,})/);
  if (match) return match[1];
  return /^[\w-]{20,}$/.test(text) ? text : '';
}
