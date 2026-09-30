/** 홈: 오늘 처리할 일. 캐시된 목록을 우선 사용해 Notion 호출을 줄인다. */

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
  const products = unwrap('상품', safeSection_('products', function () { return listProducts_(); }, []), []);
  const docs = unwrap('서류', safeSection_('docs', function () { return driveList_({ boKind: 'doc', boStatus: 'pending' }, 500).length; }, 0), 0);
  const followups = unwrap('영업 기록', safeSection_('followups', dueFollowups_, []), []);
  const inventory = unwrap('재고', safeSection_('inventory', function () { return listInventory_().filter(function (r) { return r.check; }); }, []), []);
  const links = unwrap('링크', safeSection_('links', listLinks_, []), []);
  const billing = unwrap('계산서·입금', safeSection_('billing', openBillingItems_, []), []);
  const soon = addDays_(today_(), 7);
  const recentFrom = addDays_(today_(), -14);
  const expiring = links.filter(function (l) { return l.active && l.expiry && l.expiry <= soon; });
  const brandByKey = {};
  brands.forEach(function (b) { brandByKey[String(b.pageId).replace(/-/g, '')] = b; });

  const onboardTodo = brands.filter(function (b) { return b.stage !== BO.INTAKE_STAGE && onboardTodo_(b).length; });

  const recent = products.slice().sort(function (a, b) { return String(b.edited).localeCompare(String(a.edited)); }).slice(0, 8)
    .map(function (p) { return { kind: 'product', title: p.name, subtitle: p.brandName, status: p.change === BO.CHANGE.PENDING ? '변경 요청' : p.review, at: p.edited, pageId: p.pageId }; })
    .concat(brands.slice().sort(function (a, b) { return String(b.edited).localeCompare(String(a.edited)); }).slice(0, 8)
      .map(function (b) { return { kind: 'brand', title: b.name, subtitle: b.company, status: b.stage, at: b.edited, code: b.code }; }))
    .sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, 10);

  return {
    counts: {
      intake: brands.filter(function (b) { return b.stage === BO.INTAKE_STAGE; }).length,
      intakeRecent: brands.filter(function (b) { return b.stage === BO.INTAKE_STAGE && String(b.received || b.createdAt || '').slice(0, 10) >= recentFrom; }).length,
      review: products.filter(function (p) { return p.review === BO.REVIEW.PENDING; }).length,
      change: products.filter(function (p) { return p.change === BO.CHANGE.PENDING; }).length,
      waitingOnBrand: products.filter(function (p) { return p.review === BO.REVIEW.REVISION || p.change === BO.CHANGE.REVISION; }).length,
      documents: docs,
      followups: followups.length,
      stockCheck: inventory.length,
      expiringLinks: expiring.length,
      onboardTodo: onboardTodo.length,
      billingOpen: billing.length
    },
    totals: { brands: brands.length, products: products.length, approved: products.filter(function (p) { return p.review === BO.REVIEW.APPROVED; }).length },
    followups: followups.slice(0, 6),
    expiringLinks: expiring.slice(0, 6).map(function (l) {
      const brand = (l.brandIds || []).map(function (id) { return brandByKey[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
      return { expiry: l.expiry, brandCode: brand.code || '', brandName: brand.name || '' };
    }),
    stockCheck: inventory.slice(0, 6),
    onboardTodo: onboardTodo.slice(0, 6).map(function (b) { return { code: b.code, name: b.name, todo: onboardTodo_(b) }; }),
    billingOpen: billing.slice(0, 6).map(function (item) {
      const brand = (item.brandIds || []).map(function (id) { return brandByKey[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
      return {
        brandCode: brand.code || '', brandName: brand.name || '', kind: item.kind, direction: item.direction, amount: item.amount, date: item.date,
        payWait: item.payStatus === BO.BILLING.PAY.WAIT, invoiceWait: item.invoiceStatus === BO.BILLING.INVOICE.WAIT
      };
    }),
    recent: recent,
    warnings: warnings,
    generatedAt: now_()
  };
}
