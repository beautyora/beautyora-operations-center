/** 원본 Form 응답을 읽어 신규 브랜드만 등록한다. 응답 시트와 기존 브랜드는 수정하지 않는다. */
const BO_INTAKE_TRIGGER = 'scheduledBrandIntake';
const BO_INTAKE_BASELINE = 'BO_INTAKE_BASELINE_V1';
const BO_INTAKE_EXCLUDED = 'BO_INTAKE_EXCLUDED_V1_';
const BO_INTAKE_JOB = 'BO_INTAKE_JOB_V1_';

const BO_FORM_QUESTIONS = Object.freeze({
  company: ['회사명'],
  brand: ['브랜드명'],
  launchDate: ['브랜드 런칭일자'],
  bizNo: ['사업자번호', '사업자 번호'],
  contactName: ['담당자명'],
  phone: ['담당자 연락처', '연락처'],
  email: ['담당자 이메일', '이메일'],
  channel1: ['희망하는 채널 1순위'],
  channel2: ['희망하는 채널 2순위'],
  channelAny: ['(순위 무관) 희망 채널'],
  tradeType: ['희망 거래 방식'],
  area: ['희망 영역'],
  feature: ['참여 희망 브랜드 상품 특장점', '상품 특장점'],
  url: ['참고 URL', '자사몰 링크'],
  salesChannel: ['판매 채널'],
  currentSales: ['(현재) 판매 채널']
});

function formKey_(title) {
  const normalized = normalizeName_(title);
  let best = '', bestLength = 0;
  Object.keys(BO_FORM_QUESTIONS).forEach(function (key) {
    BO_FORM_QUESTIONS[key].forEach(function (candidate) {
      const needle = normalizeName_(candidate);
      // 더 긴(구체적인) 후보가 우선: '(현재) 판매 채널'이 '판매 채널'보다 먼저 맞도록.
      if (normalized.indexOf(needle) >= 0 && needle.length > bestLength) { best = key; bestLength = needle.length; }
    });
  });
  return best;
}

/** FormResponse → { key: 문자열 }. */
function formAnswers_(response) {
  const out = {}, original = [];
  response.getItemResponses().forEach(function (itemResponse) {
    original.push(itemResponse.getItem().getTitle() + ': ' + String(itemResponse.getResponse()));
    const key = formKey_(itemResponse.getItem().getTitle());
    if (!key || out[key]) return;
    const value = itemResponse.getResponse();
    out[key] = Array.isArray(value) ? value.map(function (v) { return Array.isArray(v) ? v.join(' ') : v; }).join(', ') : String(value == null ? '' : value).trim();
  });
  out._original = original.join('\n');
  return out;
}

/** '브랜드A, 브랜드B(서브, 라인)' → ['브랜드A', '브랜드B(서브, 라인)'] */
function splitBrandNames_(value) {
  const text = String(value || '').trim().replace(/[，;\n\r]+/g, ',');
  if (text.indexOf(',') < 0) return text ? [text] : [];
  const parts = [];
  let current = '', depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if ('([{（［｛'.indexOf(ch) >= 0) depth++;
    if (')]}）］｝'.indexOf(ch) >= 0) depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { if (clean_(current)) parts.push(clean_(current)); current = ''; continue; }
    current += ch;
  }
  if (clean_(current)) parts.push(clean_(current));
  return parts.filter(function (name, index) { return parts.findIndex(function (other) { return normalizeName_(other) === normalizeName_(name); }) === index; });
}

function splitOptions_(value) {
  return clean_(value).split(/[,/]/).map(function (v) { return v.trim(); }).filter(Boolean);
}

function intakeForm_() {
  const id = prop_(BO.PROPS.GOOGLE_FORM_ID), sheetId = prop_(BO.PROPS.INTAKE_SHEET_ID);
  if (!id || !sheetId) throw userError_('BO_GOOGLE_FORM_ID와 BO_INTAKE_RESPONSE_SHEET_ID를 확인해 주세요.');
  const form = FormApp.openById(id);
  if (form.getDestinationId() !== sheetId) throw userError_('원본 Form의 연결 응답 시트가 설정과 다릅니다.');
  return form;
}

function intakeSchema_() {
  const schema = notionSchema_('brand');
  if (!schema.ids.formResponseId) throw userError_('Notion 폼 응답 ID(rich_text) 속성이 필요합니다. 기존 값을 보존하여 연결해 주세요.');
  notionProps_(schema, { stage: '접수·검토', reClass: '신규 · 상품 미등록' });
  return schema;
}

/** 전체 Script Properties 중 이 기능이 소유한 키만 변경하며, 용량 초과는 쓰기 전에 중단한다. */
function intakeSave_(key, value) {
  const text = JSON.stringify(value), all = props_().getProperties();
  if (Utilities.newBlob(text).getBytes().length > 8000) throw userError_('입점 처리 기록이 너무 큽니다.');
  all[key] = text;
  if (Utilities.newBlob(JSON.stringify(all)).getBytes().length > 400000) throw userError_('입점 처리 기록 저장 공간이 부족합니다. 관리자 확인이 필요합니다.');
  props_().setProperty(key, text);
}

function intakeBaseline_() {
  const raw = prop_(BO_INTAKE_BASELINE);
  if (!raw) return null;
  const state = JSON.parse(raw);
  if (state.formId !== prop_(BO.PROPS.GOOGLE_FORM_ID) || state.sheetId !== prop_(BO.PROPS.INTAKE_SHEET_ID) || state.sourceId !== notionSourceId_('brand')) throw userError_('입점 기준점의 Form/Sheet/Notion 연결이 바뀌었습니다. 자동 처리를 중단합니다.');
  if (!Number.isInteger(state.count) || state.count < 0 || state.count > 8000 || !Number.isFinite(Date.parse(state.since)) || !Number.isInteger(state.chunks) || state.chunks < 0 || state.chunks > 100) throw userError_('입점 기준점이 올바르지 않습니다.');
  const excluded = new Set();
  for (let i = 0; i < state.chunks; i++) {
    const chunk = JSON.parse(prop_(BO_INTAKE_EXCLUDED + i) || 'null');
    if (!Array.isArray(chunk) || chunk.some(function (id) { return typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id); })) throw userError_('입점 기준점 조각이 누락/손상되었습니다.');
    chunk.forEach(function (id) { excluded.add(id); });
  }
  if (excluded.size !== state.count) throw userError_('입점 기준점 개수가 맞지 않습니다.');
  return { state: state, excluded: excluded };
}

/** 별도 명시적 활성화. 배포/기존 setupBeautyora만으로 과거 응답을 가져오지 않는다. */
function setupBrandIntake() {
  // USER_ACCESSING 웹앱에서는 active === effective가 소유자 증명이 아니다.
  // 편집기 실행도 기존 BO_ADMIN_EMAILS 허용 목록에 있는 계정만 활성화한다.
  assertAdmin_();
  const result = withLock_(function () {
    const form = intakeForm_(), schema = intakeSchema_();
    if (!brandFolderBaseline_()) throw userError_('신규 브랜드 Drive 폴더 초기 설정을 먼저 확인해 주세요.');
    let baseline = intakeBaseline_();
    if (!baseline) {
      const started = new Date();
      const ids = form.getResponses().map(function (response) {
        if (!response.getId()) throw userError_('ID 없는 Form 응답이 있습니다. 초기화를 중단합니다.');
        return sha256_(String(response.getId()));
      });
      const unique = Array.from(new Set(ids));
      if (unique.length > 8000) throw userError_('응답 기준점이 너무 큽니다. 관리자 확인이 필요합니다.');
      let chunks = 0;
      for (let i = 0; i < unique.length; i += 80) intakeSave_(BO_INTAKE_EXCLUDED + chunks++, unique.slice(i, i + 80));
      intakeSave_(BO_INTAKE_BASELINE, {
        formId: prop_(BO.PROPS.GOOGLE_FORM_ID), sheetId: prop_(BO.PROPS.INTAKE_SHEET_ID), sourceId: schema.sourceId,
        since: new Date(Math.floor(started.getTime() / 60000) * 60000 - 60000).toISOString(),
        activatedAt: new Date().toISOString(), count: unique.length, chunks: chunks
      });
      baseline = intakeBaseline_();
    }
    const previous = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === BO_INTAKE_TRIGGER; });
    ScriptApp.newTrigger(BO_INTAKE_TRIGGER).timeBased().everyMinutes(1).create();
    previous.forEach(function (t) { ScriptApp.deleteTrigger(t); });
    return { activatedAt: baseline.state.activatedAt, excludedResponses: baseline.state.count, handler: BO_INTAKE_TRIGGER };
  }, 20000);
  console.log(JSON.stringify(result));
  return result;
}

function intakeLaunchDate_(value) {
  const match = clean_(value).match(/^(\d{4})\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])\s*(\d{1,2})\s*일?$/);
  if (!match) return '';
  const iso = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  const date = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : '';
}

function intakeProperties_(schema, answers, name, code, token, submittedAt) {
  const digits = String(answers.bizNo || '').replace(/\D/g, '');
  const values = {
    name: name, code: code, stage: '접수·검토', reClass: '신규 · 상품 미등록',
    company: answers.company || '', bizNo: digits.length === 10 ? digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5) : answers.bizNo || '',
    contactName: answers.contactName || '', phone: answers.phone || '', email: answers.email || '',
    received: submittedAt, launch: intakeLaunchDate_(answers.launchDate), channel1: answers.channel1 || '', channel2: answers.channel2 || '',
    channelAny: answers.channelAny || '', currentSales: answers.currentSales || '', feature: answers.feature || '',
    reference: answers.url || '', formSubmitted: true, formResponseId: token
  };
  const properties = notionProps_(schema, values);
  const multi = { trade: splitOptions_(answers.tradeType), area: splitOptions_(answers.area), salesChannel: splitOptions_(answers.salesChannel) };
  Object.keys(multi).forEach(function (key) {
    if (!schema.defs[key]) return;
    const allowed = schema.defs[key].multi_select.options.map(function (o) { return o.name; });
    properties[schema.ids[key]] = notionWrite_(schema.defs[key], multi[key].filter(function (v) { return allowed.indexOf(v) >= 0; }));
  });
  return properties;
}

/** POST에는 자동 재전송을 하지 않는다. 결과 불명확 시 token으로 찾을 때까지 재생성 금지. */
function intakeCreateOnce_(schema, properties, answers) {
  const notes = answers._original || Object.keys(answers).map(function (key) { return key + ': ' + answers[key]; }).join('\n');
  const rich = notionRichText_('입점 신청 원문\n' + notes).rich_text;
  const result = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + notionToken_(), 'Notion-Version': BO.NOTION_VERSION, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: schema.sourceId }, properties: properties,
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rich } }] })
  });
  const status = result.getResponseCode();
  let body = {};
  try { body = JSON.parse(result.getContentText()); } catch (ignored) {}
  if (status >= 200 && status < 300 && body.id) return body;
  const error = userError_('입점 Notion 생성 응답 확인 필요 (HTTP ' + status + ').');
  // 이 응답은 생성이 명확히 거부된 경우만 안전하게 다시 시도한다.
  error.definitelyRejected = [400, 401, 403, 404, 429].indexOf(status) >= 0;
  throw error;
}

/** 확인된 별칭은 BO ID에만 연결한다. 사업자번호/이메일은 동일 브랜드의 증거가 아니다. */
const BO_INTAKE_MATCH_RULES = 'BO_INTAKE_MATCH_RULES_V1';
const BO_INTAKE_CONFIRMED_ALIASES = Object.freeze([
  { code: 'BO-0108', names: ['DI/RE', '디르', '디르(DI/RE)'] }
]);

function intakeBiz_(value) {
  const digits = String(value || '').replace(/[\s-]/g, '');
  return /^\d{10}$/.test(digits) && !/^(\d)\1{9}$/.test(digits) ? digits : '';
}

function intakeMatchRules_() {
  let rules;
  try { rules = JSON.parse(prop_(BO_INTAKE_MATCH_RULES) || '{}'); }
  catch (ignored) { throw userError_('입점 별칭 검토 설정이 올바르지 않습니다.'); }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) ||
      Object.keys(rules).some(function (k) { return ['aliases', 'newBrands'].indexOf(k) < 0; }) ||
      (rules.aliases !== undefined && !Array.isArray(rules.aliases)) ||
      (rules.newBrands !== undefined && !Array.isArray(rules.newBrands))) throw userError_('입점 별칭 검토 설정이 올바르지 않습니다.');
  const aliases = BO_INTAKE_CONFIRMED_ALIASES.concat(rules.aliases || []), newBrands = rules.newBrands || [];
  aliases.forEach(function (a) {
    if (!a || !/^BO-\d{4,}$/.test(a.code) || !Array.isArray(a.names) || !a.names.length ||
        a.names.some(function (n) { return typeof n !== 'string' || !normalizeName_(n); })) throw userError_('입점 별칭 검토 설정이 올바르지 않습니다.');
  });
  newBrands.forEach(function (a) {
    if (!a || ['responseHash', 'fingerprint', 'nameHash'].some(function (k) { return !/^[a-f0-9]{64}$/.test(a[k]); })) throw userError_('입점 신규 브랜드 검토 설정이 올바르지 않습니다.');
  });
  return { aliases: aliases, newBrands: newBrands };
}

/** 순수 판정. 원문/연락처를 오류에 넣지 않고 모호하면 반드시 검토한다. */
function intakeMatch_(rows, name, answers, responseId, fingerprint) {
  const rules = intakeMatchRules_(), normalized = normalizeName_(name), biz = intakeBiz_(answers.bizNo);
  const exact = rows.filter(function (b) { return normalizeName_(b.name) === normalized; });
  const aliases = rules.aliases.filter(function (a) { return a.names.some(function (n) { return normalizeName_(n) === normalized; }); });
  const codes = Array.from(new Set(aliases.map(function (a) { return a.code; })));
  if (codes.length > 1 || exact.length > 1) return { review: 'ambiguous-name' };
  if (codes.length) {
    const targets = rows.filter(function (b) { return b.code === codes[0]; });
    if (targets.length !== 1) return { review: 'alias-target-missing' };
    const target = targets[0];
    const targetAliases = rules.aliases.filter(function (a) { return a.code === codes[0]; });
    if (rows.some(function (b) {
      return b.pageId !== target.pageId && targetAliases.some(function (a) {
        return a.names.some(function (n) { return normalizeName_(n) === normalizeName_(b.name); });
      });
    })) return { review: 'alias-conflict' };
    if (!aliases.some(function (a) { return a.names.some(function (n) { return normalizeName_(n) === normalizeName_(target.name); }); }) ||
        exact.some(function (b) { return b.pageId !== target.pageId; })) return { review: 'alias-conflict' };
    if (!biz || !intakeBiz_(target.bizNo) || biz !== intakeBiz_(target.bizNo)) return { review: 'alias-business-unverified' };
    return { existing: target };
  }
  if (exact.length) {
    if (!/^BO-\d{4,}$/.test(exact[0].code) || rows.filter(function (b) { return b.code === exact[0].code; }).length !== 1) return { review: 'ambiguous-code' };
    if (!biz || !intakeBiz_(exact[0].bizNo)) return { review: 'name-business-unverified' };
    if (biz !== intakeBiz_(exact[0].bizNo)) return { review: 'name-business-conflict' };
    return { existing: exact[0] };
  }
  // 괄호 속 이름은 자동 별칭 등록하지 않는다. 알려진 이름이면 검토 신호로만 사용한다.
  const parts = String(name).split(/[()（）]/).map(normalizeName_).filter(Boolean);
  if (parts.length > 1 && (rows.some(function (b) { return parts.indexOf(normalizeName_(b.name)) >= 0; }) ||
      rules.aliases.some(function (a) { return a.names.some(function (n) { return parts.indexOf(normalizeName_(n)) >= 0; }); }))) return { review: 'unconfirmed-alias' };
  const approved = rules.newBrands.some(function (a) {
    return a.responseHash === sha256_(responseId) && a.fingerprint === fingerprint && a.nameHash === sha256_(normalized);
  });
  if (approved) return {};
  if (!biz) return { review: 'missing-business' };
  const email = clean_(answers.email).toLowerCase();
  const related = rows.some(function (b) {
    return intakeBiz_(b.bizNo) === biz || (email && clean_(b.email).toLowerCase() === email);
  });
  return related ? { review: 'shared-business-or-email' } : {};
}

/** 호출자는 프로젝트 잠금을 보유한다. 기존 브랜드에는 PATCH/댓글도 쓰지 않는다. */
function intakeProcessResponse_(response, schema, reviewedAnswers) {
  const responseId = String(response.getId() || '');
  if (!responseId) throw userError_('Form 응답 ID가 없습니다.');
  const key = BO_INTAKE_JOB + sha256_(responseId), raw = prop_(key);
  let job = raw ? JSON.parse(raw) : null;
  if (job && job.done) return { skipped: true };
  const answers = reviewedAnswers || formAnswers_(response), fingerprint = sha256_(JSON.stringify(answers));
  const names = splitBrandNames_(answers.brand);
  if (!names.length || names.length > 25) throw userError_('입점 브랜드명은 1~25개여야 합니다.');
  if (job && job.fingerprint !== fingerprint) throw userError_('처리 중 응답이 수정되었습니다. 관리자 확인이 필요합니다.');
  if (!job) { job = { fingerprint: fingerprint, entries: {} }; intakeSave_(key, job); }
  const results = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index], token = responseId + (names.length > 1 ? ',' + index : '');
    let entry = job.entries[index];
    // 중간 실패 뒤에도 기존 브랜드 연결을 생성 복구로 오인하지 않는다.
    if (entry && entry.phase === 'matched') { results.push({ code: entry.code, action: 'duplicate' }); continue; }
    const rows = notionQueryAll_(schema.sourceId, {}).map(function (p) { return notionRow_(p, schema); });
    const linked = rows.filter(function (b) { return b.formResponseId === token; });
    if (linked.length > 1) throw userError_('같은 응답 식별자의 브랜드가 여러 개입니다.');
    let own = linked[0];
    if (!own && entry && entry.pageId) own = rows.find(function (b) { return b.pageId === entry.pageId; });
    if (own) {
      // 생성 직후 이름/영업 단계가 변경돼도 ID로 복구하며 기존 속성은 수정하지 않는다.
      createBrandFolder_(brandSummary_(own), schema);
      results.push({ code: own.code, action: 'recovered' });
      job.entries[index] = { phase: 'done', pageId: own.pageId };
      intakeSave_(key, job);
      continue;
    }
    if (entry && entry.pageId) throw userError_('이전에 생성한 브랜드를 찾을 수 없습니다. 삭제/이동 여부 확인 전 재생성하지 않습니다.');
    if (entry && entry.phase === 'creating') throw userError_('이전 생성 결과가 불명확합니다. Notion 응답 ID 대조 전 재생성하지 않습니다.');
    if (entry && entry.phase === 'done') continue;
    const match = intakeMatch_(rows, name, answers, responseId, fingerprint);
    if (match.review) {
      job.entries[index] = { phase: 'review', reason: match.review, nameHash: sha256_(normalizeName_(name)) };
      intakeSave_(key, job);
      throw userError_('입점 브랜드 식별 검토 필요 (' + match.review + '). 원본 응답과 기존 BO ID를 확인해 주세요.');
    }
    if (match.existing) {
      // 원본 Form/Sheet를 보존하고 응답 journal에 연결만 기록한다. 기존 페이지/폴더는 쓰지 않는다.
      job.entries[index] = { phase: 'matched', pageId: match.existing.pageId, code: match.existing.code };
      intakeSave_(key, job);
      results.push({ code: match.existing.code, action: 'duplicate' });
      continue;
    }
    let max = 0;
    rows.forEach(function (b) { const match = String(b.code || '').match(/^BO-(\d+)$/); if (match) max = Math.max(max, Number(match[1])); });
    const journals = props_().getProperties(), nameHash = sha256_(normalizeName_(name));
    const bizHash = intakeBiz_(answers.bizNo) ? sha256_(intakeBiz_(answers.bizNo)) : '';
    const emailHash = clean_(answers.email) ? sha256_(clean_(answers.email).toLowerCase()) : '';
    Object.keys(journals).filter(function (k) { return k.indexOf(BO_INTAKE_JOB) === 0; }).forEach(function (k) {
      const other = JSON.parse(journals[k]);
      Object.keys(other.entries || {}).forEach(function (i) {
        const pending = other.entries[i];
        if (pending.phase !== 'creating' && pending.phase !== 'created') return;
        if (k !== key && pending.nameHash === nameHash) throw userError_('같은 이름의 다른 응답이 처리 중입니다. 먼저 생성 결과를 확인합니다.');
        if (k !== key && ((bizHash && pending.bizHash === bizHash) || (emailHash && pending.emailHash === emailHash))) throw userError_('같은 사업자/연락처의 다른 응답이 처리 중입니다. 생성 결과 확인 전 신규 생성하지 않습니다.');
        const match = String(pending.code || '').match(/^BO-(\d+)$/);
        if (match) max = Math.max(max, Number(match[1]));
      });
    });
    const code = 'BO-' + String(max + 1).padStart(4, '0');
    const properties = intakeProperties_(schema, answers, name, code, token, Utilities.formatDate(response.getTimestamp(), BO.TIMEZONE, 'yyyy-MM-dd'));
    job.entries[index] = { phase: 'creating', code: code, nameHash: nameHash, bizHash: bizHash, emailHash: emailHash };
    intakeSave_(key, job); // POST 전에 기록. 저장 실패 시 생성하지 않는다.
    let page;
    try { page = intakeCreateOnce_(schema, properties, answers); } catch (error) {
      if (error.definitelyRejected) { job.entries[index] = { phase: 'rejected' }; intakeSave_(key, job); }
      throw error;
    }
    job.entries[index] = { phase: 'created', code: code, pageId: page.id, nameHash: nameHash, bizHash: bizHash, emailHash: emailHash };
    intakeSave_(key, job);
    bumpCache_('brand');
    createBrandFolder_({ pageId: page.id, code: code, name: name, drive: '' }, schema);
    job.entries[index].phase = 'done';
    intakeSave_(key, job);
    results.push({ code: code, action: 'created' });
    logInfo_('intake.created', { code: code });
  }
  const matches = {};
  Object.keys(job.entries).forEach(function (i) {
    const e = job.entries[i];
    if (e.phase === 'matched') matches[i] = { pageId: e.pageId, code: e.code };
  });
  intakeSave_(key, Object.keys(matches).length ? { done: true, matches: matches } : { done: true });
  return { items: results };
}

function syncBrandIntake_() {
  return withLock_(function () {
    const baseline = intakeBaseline_();
    if (!baseline) return { skipped: 'setupBrandIntake로 신규 응답 처리를 먼저 활성화해 주세요.', processed: 0, failed: [] };
    const schema = intakeSchema_(), form = intakeForm_(), started = Date.now();
    const responses = form.getResponses(new Date(baseline.state.since)).sort(function (a, b) { return a.getTimestamp() - b.getTimestamp() || String(a.getId()).localeCompare(String(b.getId())); });
    const result = { processed: 0, failed: [], deferred: 0 };
    for (let i = 0; i < responses.length; i++) {
      if (Date.now() - started > 210000) { result.deferred = responses.length - i; break; }
      const response = responses[i], hash = sha256_(String(response.getId() || ''));
      if (baseline.excluded.has(hash)) continue;
      try { if (!intakeProcessResponse_(response, schema).skipped) result.processed++; }
      catch (error) {
        // Form 응답 원문/연락처는 로그나 알림에 남기지 않는다.
        logError_('intake:' + hash.slice(0, 12), error);
        result.failed.push({ reference: hash.slice(0, 12), message: errorMessage_(error) });
      }
    }
    return result;
  }, 20000);
}

function scheduledBrandIntake(e) {
  if (!isProjectTrigger_(e)) throw new Error('트리거에서만 실행할 수 있습니다.');
  const result = syncBrandIntake_();
  if (result.failed.length) notifyAdmins_('입점 신규 응답 등록 오류', result.failed.map(function (f) { return f.reference + ': ' + f.message; }).join('\n'));
  return result;
}


/** 관리자 두 건 복구. 원문/개인정보는 로그하지 않는다. 설정은 Script Properties에만 둔다. */
const BO_INTAKE_RECOVERY_CONFIG = 'BO_INTAKE_RECOVERY_TWO_V1';
const BO_INTAKE_RECOVERY_FROZEN = 'BO_INTAKE_RECOVERY_FROZEN_V1';

function intakeRecoveryConfig_(config) {
  config = config || JSON.parse(prop_(BO_INTAKE_RECOVERY_CONFIG) || 'null');
  if (!config || !Array.isArray(config.targets) || config.targets.length !== 2) throw userError_('복구 대상은 정확히 두 건이어야 합니다.');
  config.targets.forEach(function (t) {
    if (!t || typeof t.brand !== 'string' || !t.brand.trim() || typeof t.company !== 'string' || !t.company.trim() ||
        typeof t.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(t.timestamp) || !isFinite(Date.parse(t.timestamp))) {
      throw userError_('브랜드/회사/시간대 포함 접수 timestamp가 필요합니다.');
    }
  });
  return config;
}

function intakeRecoverySource_(response) {
  const source = {
    responseId: String(response.getId() || ''), timestamp: response.getTimestamp().toISOString(),
    questions: response.getItemResponses().map(function (r) {
      const item = r.getItem();
      return { id: String(item.getId()), title: item.getTitle(), type: String(item.getType()), answer: r.getResponse() };
    })
  };
  if (!source.responseId) throw userError_('원본 Form 응답 ID가 없습니다.');
  return { source: source, sourceHash: sha256_(JSON.stringify(source)), currentMapping: formAnswers_(response) };
}

function intakeRecoveryFind_(config, previewOnly) {
  const responses = intakeForm_().getResponses();
  const selected = config.targets.map(function (target) {
    const matches = responses.filter(function (r) {
      if (Math.abs(r.getTimestamp().getTime() - Date.parse(target.timestamp)) > (previewOnly ? 1000 : 0)) return false;
      const answers = formAnswers_(r);
      return answers.brand === target.brand && answers.company === target.company;
    });
    if (matches.length !== 1) throw userError_('브랜드/회사/접수시각으로 원본 응답을 하나로 확정할 수 없습니다.');
    return matches[0];
  });
  if (String(selected[0].getId()) === String(selected[1].getId())) throw userError_('서로 다른 두 응답이 필요합니다.');
  return selected;
}

/** 읽기 전용. 반환 원문은 관리자 화면에서만 확인하고 로그/공개 저장소에 복사하지 않는다. */
function previewBrandIntakeRecovery(config) {
  assertAdmin_();
  return withLock_(function () {
    config = intakeRecoveryConfig_(config);
    return { responses: intakeRecoveryFind_(config, true).map(intakeRecoverySource_),
      warning: '현재 Form에서 삭제된 질문은 누락될 수 있습니다. Sheet 원본 대조 후 fields를 명시하세요. currentMapping은 승인된 매핑이 아닙니다.' };
  }, 20000);
}

function intakeRecoveryAnswers_(target, preview) {
  if (target.responseId !== preview.source.responseId || target.sourceHash !== preview.sourceHash) throw userError_('승인한 원본 ID/hash와 다릅니다. preview를 다시 확인하세요.');
  if (!target.fields || typeof target.fields !== 'object' || Array.isArray(target.fields)) throw userError_('승인한 질문 ID별 fields 매핑이 필요합니다.');
  const answers = {};
  Object.keys(target.fields).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(BO_FORM_QUESTIONS, key)) throw userError_('허용되지 않은 복구 필드입니다.');
    const items = preview.source.questions.filter(function (q) { return q.id === target.fields[key]; });
    if (items.length !== 1) throw userError_('승인 필드의 원본 질문 ID를 찾을 수 없습니다.');
    const value = items[0].answer;
    answers[key] = Array.isArray(value) ? value.map(function (v) { return Array.isArray(v) ? v.join(' ') : v; }).join(', ') : String(value == null ? '' : value).trim();
  });
  if (answers.brand !== target.brand || answers.company !== target.company || splitBrandNames_(answers.brand).length !== 1) throw userError_('복구는 응답당 승인된 브랜드 하나만 허용합니다.');
  answers._original = preview.source.questions.map(function (q) { return q.title + ': ' + String(q.answer); }).join('\n');
  return answers;
}

/** 편집기 실행용. 승인된 설정만 사용하며 첫 실행 이후 대상/매핑 변경을 거부한다. */
function replayBrandIntakeRecovery() {
  assertAdmin_();
  return withLock_(function () {
    const config = intakeRecoveryConfig_();
    const hash = sha256_(JSON.stringify(config)), frozen = JSON.parse(prop_(BO_INTAKE_RECOVERY_FROZEN) || 'null');
    if (frozen && frozen !== hash) throw userError_('이미 확정된 두 건 복구 설정과 다릅니다.');
    const responses = intakeRecoveryFind_(config);
    const baseline = intakeBaseline_();
    if (!baseline || responses.some(function (r) { return !baseline.excluded.has(sha256_(String(r.getId()))); })) throw userError_('초기 기준점에 포함된 과거 응답 두 건만 복구할 수 있습니다.');
    // 두 건 모두 원본과 승인 매핑이 일치해야 첫 쓰기를 시작한다.
    const answers = responses.map(function (r, i) { return intakeRecoveryAnswers_(config.targets[i], intakeRecoverySource_(r)); });
    const schema = intakeSchema_();
    if (!frozen) intakeSave_(BO_INTAKE_RECOVERY_FROZEN, hash);
    return { results: responses.map(function (r, i) { return intakeProcessResponse_(r, schema, answers[i]); }) };
  }, 20000);
}

/** 편집기 Run 전용: 승인된 두 응답의 검증 메타데이터만 기록한다. 답변 원문은 출력하지 않는다. */
function inspectBrandIntakeRecovery() {
  assertAdmin_();
  const preview = previewBrandIntakeRecovery();
  const result = {
    warning: preview.warning,
    responses: preview.responses.map(function (p) {
      return {
        expectedMatch: true, responseId: p.source.responseId, timestamp: p.source.timestamp, sourceHash: p.sourceHash,
        questions: p.source.questions.map(function (q) {
          return { id: q.id, title: q.title, type: q.type, answerHash: sha256_(JSON.stringify(q.answer)) };
        })
      };
    })
  };
  console.log(JSON.stringify(result));
  return result;
}
