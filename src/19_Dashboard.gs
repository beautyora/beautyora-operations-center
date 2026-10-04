/** 홈: 브랜드 진행 현황과 최근 수정. 한 영역이 실패해도 나머지는 보여 준다. */

function safeSection_(label, producer, fallback) {
  try { return producer(); } catch (error) {
    logError_('dashboard:' + label, error);
    return { error: errorMessage_(error), value: fallback };
  }
}

function apiDashboard_() {
  const warnings = [];
  const unwrap = function (label, value, fallback) {
    if (value && value.error && hasOwn_(value, 'value')) { warnings.push(label + ': ' + value.error); return fallback; }
    return value;
  };
  const brands = unwrap('브랜드', safeSection_('brands', function () { return listBrands_(); }, []), []);
  const options = unwrap('브랜드 단계', safeSection_('stages', function () { return brandFilterOptions_().stage; }, []), []);

  const counts = {};
  brands.forEach(function (b) { const stage = b.stage || '단계 없음'; counts[stage] = (counts[stage] || 0) + 1; });
  const stages = options.filter(function (s) { return counts[s]; }).concat(Object.keys(counts).filter(function (s) { return options.indexOf(s) < 0; }))
    .map(function (stage) { return { stage: stage, count: counts[stage] }; });

  const recent = brands.slice().sort(function (a, b) { return String(b.edited).localeCompare(String(a.edited)); }).slice(0, 10)
    .map(function (b) { return { code: b.code, name: b.name, company: b.company, stage: b.stage, edited: b.edited, url: b.url }; });

  return { totals: { brands: brands.length }, stages: stages, recent: recent, warnings: warnings, generatedAt: now_() };
}
