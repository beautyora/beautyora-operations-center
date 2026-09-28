/**
 * 브랜드 입점 신청: Google Form 제출 → Notion 브랜드 목록에 '접수·검토' 단계로 바로 생성.
 * 같은 이름의 브랜드가 이미 있으면 새로 만들지 않고 기존 페이지에 댓글로 재접수를 남긴다.
 */
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
  const out = {};
  response.getItemResponses().forEach(function (itemResponse) {
    const key = formKey_(itemResponse.getItem().getTitle());
    if (!key || out[key]) return;
    const value = itemResponse.getResponse();
    out[key] = Array.isArray(value) ? value.map(function (v) { return Array.isArray(v) ? v.join(' ') : v; }).join(', ') : clean_(value);
  });
  return out;
}

/** '브랜드A, 브랜드B(서브, 라인)' → ['브랜드A', '브랜드B(서브, 라인)'] */
function splitBrandNames_(value) {
  const text = clean_(value).replace(/，/g, ',');
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
  return parts.filter(function (name, index) { return parts.indexOf(name) === index; });
}

function splitOptions_(value) {
  return clean_(value).split(/[,/]/).map(function (v) { return v.trim(); }).filter(Boolean);
}

/** 다음 브랜드 ID(BO-0001 형식). 반드시 잠금 안에서 호출한다. */
function nextBrandCode_() {
  let max = 0;
  listBrands_(true).forEach(function (brand) {
    const match = String(brand.code || '').match(/^BO-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return 'BO-' + String(max + 1).padStart(4, '0');
}

function parseLaunchDate_(value) {
  const text = clean_(value);
  const match = text.match(/^(\d{4})\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])\s*(\d{1,2})\s*일?$/);
  if (!match) return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
  const iso = match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2);
  try { return assertDate_(iso, '런칭일'); } catch (ignored) { return ''; }
}

/** 응답 1건 처리. 결과: [{ brand, action: created|duplicate|skipped, code }] */
function processFormResponse_(response, options) {
  options = options || {};
  const responseId = String(response.getId());
  const submittedAt = Utilities.formatDate(response.getTimestamp(), BO.TIMEZONE, 'yyyy-MM-dd');
  const answers = formAnswers_(response);
  const names = splitBrandNames_(answers.brand);
  if (!names.length) return [{ brand: '', action: 'skipped', reason: '브랜드명 없음' }];
  const schema = notionSchema_('brand');
  return withLock_(function () {
    const brands = listBrands_(true);
    if (schema.ids.formResponseId && brands.some(function (b) { return String(b.formResponseId).split(',').map(clean_).indexOf(responseId) >= 0; })) {
      return names.map(function (name) { return { brand: name, action: 'skipped', reason: '이미 가져온 응답' }; });
    }
    return names.map(function (name, index) {
      const existing = brands.find(function (b) { return normalizeName_(b.name) === normalizeName_(name); });
      if (existing) {
        if (!options.silentDuplicate) {
          notionComment_(existing.pageId, '입점 신청서가 다시 접수되었습니다 (' + submittedAt + ', 담당자 ' + (answers.contactName || '-') + ' ' + (answers.phone || '') + ').');
          const patch = notionProps_(schema, { formSubmitted: true });
          if (Object.keys(patch).length) notionPatch_(existing.pageId, patch);
        }
        return { brand: name, action: 'duplicate', code: existing.code };
      }
      const code = nextBrandCode_();
      const values = {
        name: name, code: code, stage: BO.INTAKE_STAGE,
        company: answers.company || '', bizNo: formatBizNo_(answers.bizNo), contactName: answers.contactName || '',
        phone: formatPhone_(answers.phone), email: answers.email || '', received: submittedAt,
        launch: parseLaunchDate_(answers.launchDate), channel1: answers.channel1 || '', channel2: answers.channel2 || '',
        channelAny: answers.channelAny || '', currentSales: answers.currentSales || '', feature: answers.feature || '',
        reference: answers.url || '', formSubmitted: true, formResponseId: responseId + (names.length > 1 ? ',' + index : '')
      };
      const multi = { trade: splitOptions_(answers.tradeType), area: splitOptions_(answers.area), salesChannel: splitOptions_(answers.salesChannel) };
      const properties = notionProps_(schema, values, { allowNewOption: true });
      // 선택지에 없는 값은 버리지 않고 메모에 남긴다(선택지를 임의로 늘리지 않기 위해).
      const leftovers = [];
      Object.keys(multi).forEach(function (key) {
        if (!schema.defs[key] || !multi[key].length) return;
        const known = (schema.defs[key].multi_select.options || []).map(function (o) { return o.name; });
        const ok = multi[key].filter(function (v) { return known.indexOf(v) >= 0; });
        const rest = multi[key].filter(function (v) { return known.indexOf(v) < 0; });
        if (ok.length) properties[schema.ids[key]] = notionWrite_(schema.defs[key], ok);
        if (rest.length) leftovers.push(schema.defs[key].name + ': ' + rest.join(', '));
      });
      if (leftovers.length && schema.ids.memo) properties[schema.ids.memo] = notionRichText_('[입점 신청서] ' + leftovers.join(' / '));
      const extra = {};
      const template = prop_(BO.PROPS.BRAND_TEMPLATE);
      if (template === 'default') extra.template = { type: 'default' };
      else if (template) extra.template = { type: 'template_id', template_id: template };
      const page = notionCreate_(schema.sourceId, properties, extra);
      bumpCache_('brand');
      const sameBiz = values.bizNo ? brands.filter(function (b) { return b.bizNo && b.bizNo.replace(/\D/g, '') === values.bizNo.replace(/\D/g, ''); }) : [];
      if (sameBiz.length) notionComment_(page.id, '같은 사업자번호로 등록된 브랜드가 있습니다: ' + sameBiz.map(function (b) { return b.name + '(' + b.code + ')'; }).join(', '));
      logInfo_('intake.created', { code: code, name: name });
      return { brand: name, action: 'created', code: code };
    });
  }, 60000);
}

/** 설치형 폼 제출 트리거. */
function onBrandFormSubmit(e) {
  if (!isProjectTrigger_(e)) throw new Error('트리거에서만 실행할 수 있습니다.');
  try {
    processFormResponse_(e.response);
  } catch (error) {
    logError_('onBrandFormSubmit', error);
    notifyAdmins_('입점 신청서를 Notion에 등록하지 못했습니다', errorMessage_(error) + '\n\n운영센터 → 입점 신청 → "폼 응답 다시 가져오기"로 다시 처리할 수 있습니다.');
    throw error;
  }
}

/* ---------- 관리자 API ---------- */

function apiIntakeList_() {
  const brands = listBrands_();
  const schema = notionSchema_('brand');
  const stageOptions = (schema.defs.stage.select.options || []).map(function (o) { return o.name; });
  const items = brands.filter(function (b) { return b.stage === BO.INTAKE_STAGE; }).map(function (brand) {
    const digits = String(brand.bizNo || '').replace(/\D/g, '');
    const sameBiz = digits ? brands.filter(function (other) { return other.pageId !== brand.pageId && String(other.bizNo || '').replace(/\D/g, '') === digits; }) : [];
    return Object.assign({}, brand, { sameBiz: sameBiz.map(function (b) { return { code: b.code, name: b.name }; }) });
  }).sort(function (a, b) { return String(b.received || b.createdAt).localeCompare(String(a.received || a.createdAt)); });
  return { items: items, stages: stageOptions.filter(function (s) { return s !== BO.INTAKE_STAGE; }), formConnected: !!prop_(BO.PROPS.GOOGLE_FORM_ID) };
}

/** 입점 신청 처리: 다음 단계로 옮기거나 보류. 메모는 Notion 댓글로 남긴다. */
function apiIntakeDecide_(payload) {
  const brand = requireBrand_(payload.code);
  const schema = notionSchema_('brand');
  const stage = text_(payload.stage, 100);
  const options = (schema.defs.stage.select.options || []).map(function (o) { return o.name; });
  if (!stage || options.indexOf(stage) < 0 || stage === BO.INTAKE_STAGE) throw userError_('옮길 진행 단계를 선택해 주세요.');
  return withLock_(function () {
    const page = brandPage_(brand);
    const current = notionValue_(notionPropertyById_(page, schema.ids.stage));
    if (current !== BO.INTAKE_STAGE) throw userError_('이미 다른 단계로 처리된 신청입니다. (현재: ' + (current || '없음') + ')');
    const values = { stage: stage };
    if (payload.next && schema.ids.next) values.next = text_(payload.next, 2000);
    notionPatch_(page.id, notionProps_(schema, values));
    notionComment_(page.id, '입점 신청 검토 완료 → ' + stage + (payload.note ? ' — ' + text_(payload.note, 1000) : '') + ' · ' + activeEmail_());
    bumpCache_('brand');
    return { stage: stage };
  });
}

/** 폼 응답 다시 가져오기(트리거 누락 대비). days: 최근 며칠 치. 이미 가져온 응답은 건너뛴다. */
function apiIntakeImport_(payload) {
  const formId = prop_(BO.PROPS.GOOGLE_FORM_ID);
  if (!formId) throw userError_('입점 신청 Google Form이 연결되지 않았습니다. 스크립트 속성 BO_GOOGLE_FORM_ID를 설정해 주세요.');
  const days = Math.max(1, Math.min(365, Math.floor(Number(payload.days) || 14)));
  const since = new Date(Date.now() - days * 86400000);
  const started = Date.now();
  const summary = { created: 0, duplicate: 0, skipped: 0, unfinished: 0, items: [] };
  const responses = FormApp.openById(formId).getResponses(since);
  responses.forEach(function (response) {
    if (Date.now() - started > 240000) { summary.unfinished++; return; }
    processFormResponse_(response, { silentDuplicate: true }).forEach(function (result) {
      summary[result.action] = (summary[result.action] || 0) + 1;
      if (result.action === 'created') summary.items.push(result);
    });
  });
  return summary;
}
