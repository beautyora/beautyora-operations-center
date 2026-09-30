/** 초기 설정, 트리거, 연결 점검, 관리자 알림. */

const BO_TRIGGER_HANDLERS = Object.freeze(['onBrandFormSubmit', 'scheduledHealthCheck']);

function clearSchemaMemo_() {
  Object.keys(BO_MEMO_).forEach(function (key) { if (key.indexOf('schema:') === 0 || key.indexOf('fields:') === 0) delete BO_MEMO_[key]; });
  bumpCache_('source');
}

/** 관계형 속성을 따라가 아직 설정되지 않은 데이터 소스 ID를 찾아 저장한다. */
function discoverSources_(report) {
  const store = props_();
  const relationTarget = function (kind, propertyName) {
    const sourceId = notionSourceId_(kind, true);
    if (!sourceId) return '';
    const definition = notionDefinitions_(notionSource_(sourceId)).find(function (d) { return d.name === propertyName && d.type === 'relation'; });
    return definition && definition.relation ? definition.relation.data_source_id || '' : '';
  };
  const steps = [
    ['terms', 'brand', '공급조건'],
    ['movement', 'product', '입출고 이력'],
    ['store', 'movement', '입점 매장'],
    ['inventory', 'store', '입점 상품 운영']
  ];
  steps.forEach(function (step) {
    const spec = BO_SCHEMAS[step[0]];
    if (prop_(spec.prop)) return;
    let found = '';
    try { found = relationTarget(step[1], step[2]); } catch (error) { logError_('discover ' + step[0], error); }
    if (found) {
      store.setProperty(spec.prop, found);
      report.push('연결: Notion "' + spec.label + '"을(를) 자동으로 찾았습니다.');
    } else {
      report.push('확인 필요: Notion "' + spec.label + '"을(를) 자동으로 찾지 못했습니다. 통합이 이 DB에 연결되어 있는지 확인하거나 스크립트 속성 ' + spec.prop + '을 직접 넣어 주세요.');
    }
  });
}

function ensureSchemaAdditions_(report) {
  Object.keys(BO_SCHEMA_ADDITIONS).forEach(function (kind) {
    const sourceId = notionSourceId_(kind, true);
    if (!sourceId) return;
    const definitions = notionDefinitions_(notionSource_(sourceId, true));
    const properties = {};
    BO_SCHEMA_ADDITIONS[kind].forEach(function (addition) {
      if (definitions.some(function (d) { return d.name === addition.name; })) return;
      properties[addition.name] = addition.definition;
      report.push('추가: ' + BO_SCHEMAS[kind].label + ' DB에 "' + addition.name + '" 속성');
    });
    if (Object.keys(properties).length) notionRequest_('patch', '/data_sources/' + encodeURIComponent(sourceId), { properties: properties });
  });
  Object.keys(BO_REQUIRED_OPTIONS).forEach(function (kind) {
    const sourceId = notionSourceId_(kind, true);
    if (!sourceId) return;
    const definitions = notionDefinitions_(notionSource_(sourceId, true));
    Object.keys(BO_REQUIRED_OPTIONS[kind]).forEach(function (key) {
      const names = BO_SCHEMAS[kind].fields[key][1];
      const definition = definitions.find(function (d) { return names.indexOf(d.name) >= 0 && d.type === 'select'; });
      if (!definition) return;
      const existing = definition.select.options || [];
      const missing = BO_REQUIRED_OPTIONS[kind][key].filter(function (pair) { return !existing.some(function (o) { return o.name === pair[0]; }); });
      if (!missing.length) return;
      const property = {};
      property[definition.id] = { select: { options: existing.map(function (o) { return { id: o.id, name: o.name, color: o.color }; }).concat(missing.map(function (pair) { return { name: pair[0], color: pair[1] }; })) } };
      notionRequest_('patch', '/data_sources/' + encodeURIComponent(sourceId), { properties: property });
      report.push('추가: "' + definition.name + '" 선택지 ' + missing.map(function (p) { return p[0]; }).join(', '));
    });
  });
}

/** 운영센터가 만드는 DB를 둘 Notion 페이지: 설정값이 없으면 브랜드 DB가 있는 페이지. */
function notionParentPageId_(label) {
  let parentPageId = prop_(BO.PROPS.PARENT_PAGE_ID);
  if (!parentPageId) {
    const source = notionSource_(notionSourceId_('brand'));
    const databaseId = source.parent && source.parent.database_id;
    if (databaseId) {
      const database = notionRequest_('get', '/databases/' + encodeURIComponent(databaseId));
      if (database.parent && database.parent.type === 'page_id') parentPageId = database.parent.page_id;
    }
  }
  if (!parentPageId) throw userError_(label + ' DB를 만들 Notion 페이지를 찾지 못했습니다. 스크립트 속성 BO_NOTION_PARENT_PAGE_ID를 설정해 주세요.');
  return parentPageId;
}

/** 상품등록 링크 DB가 없으면 브랜드 DB와 같은 페이지 아래에 만든다. */
function ensureLinkDatabase_(report) {
  if (prop_(BO_SCHEMAS.link.prop)) return;
  const brandSourceId = notionSourceId_('brand');
  const parentPageId = notionParentPageId_('상품등록 링크');
  const database = notionRequest_('post', '/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: '상품등록 링크' } }],
    initial_data_source: {
      properties: {
        '링크명': { title: {} },
        '브랜드': { relation: { data_source_id: brandSourceId, type: 'single_property', single_property: {} } },
        '토큰': { rich_text: {} },
        '상태': { select: { options: [{ name: BO.LINK.ACTIVE, color: 'green' }, { name: BO.LINK.STOPPED, color: 'gray' }] } },
        '만료일': { date: {} },
        '마지막 접속': { date: {} },
        '발급자': { rich_text: {} },
        '메모': { rich_text: {} },
        '발급일': { created_time: {} }
      }
    }
  });
  const sourceId = database.data_sources && database.data_sources[0] && database.data_sources[0].id;
  if (!sourceId) throw userError_('상품등록 링크 DB를 만들었지만 데이터 소스 ID를 확인하지 못했습니다. Notion에서 확인해 주세요.');
  props_().setProperty(BO_SCHEMAS.link.prop, sourceId);
  report.push('생성: Notion "상품등록 링크" DB');
}

/** 계산서 · 입금 내역 DB가 없으면 브랜드 DB와 같은 페이지 아래에 만든다. */
function ensureBillingDatabase_(report) {
  if (prop_(BO_SCHEMAS.billing.prop)) return;
  const brandSourceId = notionSourceId_('brand');
  const parentPageId = notionParentPageId_('계산서 · 입금 내역');
  const options = function (list, colors) { return { options: list.map(function (name, i) { return { name: name, color: colors[i] || 'default' }; }) }; };
  const B = BO.BILLING;
  const database = notionRequest_('post', '/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: BO_SCHEMAS.billing.label } }],
    initial_data_source: {
      properties: {
        '내역명': { title: {} },
        '브랜드': { relation: { data_source_id: brandSourceId, type: 'single_property', single_property: {} } },
        '구분': { select: options(B.KINDS, ['purple', 'blue', 'green', 'gray']) },
        '방향': { select: options(B.DIRECTIONS, ['green', 'orange']) },
        '금액': { number: { format: 'won' } },
        '기준일': { date: {} },
        '입금 상태': { select: options([B.PAY.WAIT, B.PAY.DONE, B.PAY.NONE], ['yellow', 'green', 'default']) },
        '입금일': { date: {} },
        '계산서 상태': { select: options([B.INVOICE.WAIT, B.INVOICE.DONE, B.INVOICE.NONE], ['yellow', 'green', 'default']) },
        '계산서 발행일': { date: {} },
        '메모': { rich_text: {} },
        '등록자': { rich_text: {} },
        '등록일': { created_time: {} }
      }
    }
  });
  const sourceId = database.data_sources && database.data_sources[0] && database.data_sources[0].id;
  if (!sourceId) throw userError_('계산서 · 입금 내역 DB를 만들었지만 데이터 소스 ID를 확인하지 못했습니다. Notion에서 확인해 주세요.');
  props_().setProperty(BO_SCHEMAS.billing.prop, sourceId);
  report.push('생성: Notion "계산서 · 입금 내역" DB');
}

/** 브랜드가 연결됐지만 운영센터 상품 ID가 없는 상품에 ID를 붙인다(한 번에 300개, 남으면 다시 실행). */
function ensureProductIds_(report) {
  const schema = notionSchema_('product');
  const pages = notionQueryAll_(schema.sourceId, { filter: { and: [
    { property: schema.ids.productId, rich_text: { is_empty: true } },
    { property: schema.ids.brand, relation: { is_not_empty: true } }
  ] } });
  if (!pages.length) return;
  const count = assignProductIds_(pages, schema, 300);
  bumpCache_('product');
  report.push('추가: 기존 상품 ' + count + '개에 운영센터 상품 ID' + (pages.length > 300 ? ' (남은 ' + (pages.length - 300) + '개는 초기 설정을 한 번 더 실행해 주세요)' : ''));
}

function installTriggers_(report) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (trigger) {
    if (BO_TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) < 0) {
      ScriptApp.deleteTrigger(trigger);
      report.push('삭제: 예전 트리거 ' + trigger.getHandlerFunction());
    }
  });
  const has = function (handler) { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === handler; }); };
  const formId = prop_(BO.PROPS.GOOGLE_FORM_ID);
  if (formId && !has('onBrandFormSubmit')) {
    ScriptApp.newTrigger('onBrandFormSubmit').forForm(formId).onFormSubmit().create();
    report.push('설치: 입점 신청 폼 제출 트리거');
  }
  if (!has('scheduledHealthCheck')) {
    ScriptApp.newTrigger('scheduledHealthCheck').timeBased().everyHours(6).create();
    report.push('설치: 6시간마다 연결 점검 트리거');
  }
}

const BO_CONNECT_HINT = 'Notion에서 "뷰티오라 대시보드" 페이지 오른쪽 위 ··· → 연결 → 운영센터 통합을 추가한 뒤 초기 설정을 다시 실행해 주세요.';

/**
 * 초기 설정. 단계마다 따로 실행해서 한 단계가 실패해도 나머지(특히 트리거 설치)는 진행하고,
 * 실패한 단계와 해결 방법을 결과에 남긴다.
 */
function setupSystem_() {
  const report = [];
  notionRequest_('get', '/users/me');
  notionSourceId_('brand');
  notionSourceId_('product');
  const step = function (label, fn) {
    try { fn(report); } catch (error) {
      const notFound = error && error.status === 404;
      report.push('실패: ' + label + ' — ' + errorMessage_(error) + (notFound ? ' ' + BO_CONNECT_HINT : ''));
    }
  };
  step('관련 DB 자동 연결', discoverSources_);
  step('Notion 속성 추가', ensureSchemaAdditions_);
  step('상품등록 링크 DB 만들기', ensureLinkDatabase_);
  step('계산서 · 입금 내역 DB 만들기', ensureBillingDatabase_);
  step('기존 상품에 운영센터 상품 ID 붙이기', ensureProductIds_);
  clearSchemaMemo_();
  step('트리거 설치', installTriggers_);
  const health = healthCheck_();
  if (!report.length) report.push('변경할 설정이 없습니다. 이미 준비되어 있습니다.');
  return { report: report, health: health, ok: !report.some(function (line) { return line.indexOf('실패:') === 0; }) };
}

/* ---------- 연결 점검 ---------- */

function healthCheck_() {
  const results = [];
  const add = function (target, status, message) { results.push({ target: target, status: status, message: message }); };
  add('관리자', adminEmails_().length ? '정상' : '오류', adminEmails_().length ? adminEmails_().length + '명 등록' : 'BO_ADMIN_EMAILS가 비어 있습니다.');
  let notionOk = false;
  try {
    const me = notionRequest_('get', '/users/me');
    notionOk = true;
    add('Notion 연결', '정상', (me.name || '통합') + ' 연결됨');
  } catch (error) {
    add('Notion 연결', '오류', errorMessage_(error));
  }
  if (notionOk) {
    Object.keys(BO_SCHEMAS).forEach(function (kind) {
      const spec = BO_SCHEMAS[kind];
      const required = kind === 'brand' || kind === 'product' || kind === 'link';
      try {
        const schema = notionSchema_(kind, true);
        if (!schema) { add(spec.label, required ? '오류' : '주의', spec.prop + ' 미설정' + (kind === 'link' || kind === 'billing' ? ' — 초기 설정이 만듭니다. ' + BO_CONNECT_HINT : required ? '' : ' (관련 화면이 비활성화됩니다)')); return; }
        const missingOptional = Object.keys(spec.fields).filter(function (key) { return !schema.ids[key]; }).map(function (key) { return spec.fields[key][1][0]; });
        add(spec.label, missingOptional.length && (kind === 'product' || kind === 'brand') ? '주의' : '정상',
          missingOptional.length ? '없는 선택 속성: ' + missingOptional.slice(0, 6).join(', ') : '연결됨');
      } catch (error) {
        add(spec.label, '오류', errorMessage_(error) + (error && error.status === 404 ? ' (Notion에서 이 DB나 상위 페이지의 ··· → 연결에 운영센터 통합을 추가해 주세요)' : ''));
      }
    });
  }
  try {
    add('Google Drive', '정상', driveRoot_().getName());
  } catch (error) {
    add('Google Drive', '오류', errorMessage_(error));
  }
  const formId = prop_(BO.PROPS.GOOGLE_FORM_ID);
  if (!formId) add('입점 신청 폼', '주의', 'BO_GOOGLE_FORM_ID 미설정 (폼 → Notion 자동 등록이 꺼져 있습니다)');
  else {
    try { add('입점 신청 폼', '정상', FormApp.openById(formId).getTitle()); } catch (error) { add('입점 신청 폼', '오류', errorMessage_(error)); }
  }
  const handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  const legacy = handlers.filter(function (h) { return BO_TRIGGER_HANDLERS.indexOf(h) < 0; });
  if (legacy.length) add('트리거', '주의', '예전 트리거가 남아 있습니다: ' + legacy.join(', ') + ' (초기 설정을 실행하면 정리됩니다)');
  else if (formId && handlers.indexOf('onBrandFormSubmit') < 0) add('트리거', '주의', '폼 제출 트리거가 없습니다. 초기 설정을 실행해 주세요.');
  else if (handlers.indexOf('scheduledHealthCheck') < 0) add('트리거', '주의', '정기 연결 점검 트리거가 없습니다. 초기 설정을 실행해 주세요.');
  else add('트리거', '정상', handlers.length + '개 설치됨');
  add('브랜드용 주소', prop_(BO.PROPS.PARTNER_WEBAPP_URL) ? '정상' : '주의', prop_(BO.PROPS.PARTNER_WEBAPP_URL) || 'BO_PARTNER_WEBAPP_URL 미설정 (현재 웹앱 주소로 링크를 만듭니다)');
  return { checkedAt: now_(), results: results, ok: !results.some(function (r) { return r.status === '오류'; }) };
}

function notifyAdmins_(subject, body) {
  try {
    const key = cacheKey_('notify:' + sha256_(subject));
    if (cache_().get(key)) return;
    const recipients = adminEmails_();
    if (!recipients.length || MailApp.getRemainingDailyQuota() < 1) return;
    MailApp.sendEmail(recipients.join(','), '[뷰티오라 운영센터] ' + subject, body);
    cache_().put(key, '1', 43200);
  } catch (error) {
    logError_('notifyAdmins_', error);
  }
}

/* ---------- 편집기·트리거에서 실행하는 공개 함수 ---------- */

/** Apps Script 편집기에서 한 번 실행: Notion 속성·링크 DB·트리거를 준비한다. */
function setupBeautyora() {
  assertOwnerOrAdmin_();
  const result = setupSystem_();
  console.log(result.report.join('\n'));
  console.log(JSON.stringify(result.health.results, null, 2));
  return result;
}

function runHealthCheck() {
  assertOwnerOrAdmin_();
  const result = healthCheck_();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function scheduledHealthCheck(e) {
  if (!isProjectTrigger_(e)) throw new Error('트리거에서만 실행할 수 있습니다.');
  const result = healthCheck_();
  if (!result.ok) {
    notifyAdmins_('연결 점검에서 오류가 발견되었습니다', result.results.filter(function (r) { return r.status === '오류'; })
      .map(function (r) { return '- ' + r.target + ': ' + r.message; }).join('\n') + '\n\n운영센터 → 설정 → 연결 상태에서 확인해 주세요.');
  }
}
