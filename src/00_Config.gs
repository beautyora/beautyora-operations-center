/**
 * 뷰티오라 운영센터 v2 — Notion 전용 구성.
 *
 * 원칙
 * - 운영 데이터의 원본은 Notion이다. Google Sheets는 사용하지 않는다(1회 이관 제외).
 * - 파일은 Google Drive에 두고, 파일 메타데이터(브랜드·상품·분류·검수 상태)는 Drive appProperties에 둔다.
 * - 환경별 값(데이터 소스 ID, 폴더 ID, 토큰)은 모두 스크립트 속성에서 읽는다. 코드에 운영 ID를 넣지 않는다.
 */
const BO = Object.freeze({
  VERSION: '2.0.0',
  NOTION_VERSION: '2025-09-03',
  NOTION_VIEWS_VERSION: '2026-03-11',
  TIMEZONE: 'Asia/Seoul',
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  MAX_SUBMIT_PRODUCTS: 50,
  LIST_TTL: 300,
  PROPS: Object.freeze({
    NOTION_TOKEN: 'BO_NOTION_TOKEN',
    LEGACY_NOTION_TOKEN: 'NOTION_TOKEN',
    ADMIN_EMAILS: 'BO_ADMIN_EMAILS',
    ROOT_FOLDER_ID: 'BO_ROOT_FOLDER_ID',
    GOOGLE_FORM_ID: 'BO_GOOGLE_FORM_ID',
    PARTNER_WEBAPP_URL: 'BO_PARTNER_WEBAPP_URL',
    GOOGLE_CLIENT_ID: 'BO_GOOGLE_CLIENT_ID',
    PARENT_PAGE_ID: 'BO_NOTION_PARENT_PAGE_ID',
    BRAND_TEMPLATE: 'BO_NOTION_BRAND_TEMPLATE',
    PRODUCT_VIEW_ID: 'BO_NOTION_PRODUCT_VIEW_ID',
    ALLOW_EMBED: 'BO_ALLOW_EMBED',
    LEGACY_SPREADSHEET_ID: 'BO_SPREADSHEET_ID',
    SCHEMA_IDS: 'BO_SCHEMA_IDS',
    FORM_RULES_PREFIX: 'BO_NOTION_FORM_',
    FIELD_IDS_PREFIX: 'BO_NOTION_FIELD_IDS_',
    MIGRATION_STATE: 'BO_MIGRATION_STATE'
  }),
  REVIEW: Object.freeze({ PENDING: '검수 대기', REVISION: '보완 필요', REJECTED: '반려', APPROVED: '승인 완료' }),
  CHANGE: Object.freeze({ PENDING: '검수 대기', REVISION: '보완 필요', REJECTED: '반려', APPLIED: '반영 완료' }),
  LINK: Object.freeze({ ACTIVE: '사용 중', STOPPED: '중지' }),
  FILE: Object.freeze({ PENDING: '검수 대기', RECEIVED: '수령 완료', REVISION: '보완 필요', REJECTED: '반려', APPROVED: '승인 완료' }),
  INTAKE_STAGE: '접수·검토',
  /** 폼으로 새로 등록되는 브랜드의 '재영업 분류' 기본값. */
  NEW_BRAND_RECLASS: '신규 · 상품 미등록',
  CHANGE_MARKER: '🔁 변경 요청',
  /**
   * 입점 체크리스트(브랜드 속성). todo: 아직 처리 안 된 값, start: 체크리스트를 시작할 때 넣는 값.
   * 비어 있으면 '미확인'으로 보고 미완료로 세지 않는다(기존 브랜드를 한꺼번에 미완료로 만들지 않기 위해).
   */
  ONBOARD: Object.freeze({
    contract: Object.freeze({ key: 'contractSent', name: '계약서 발송', short: '계약서', todo: '미발송', start: '미발송',
      options: [['미발송', 'gray'], ['발송 완료', 'blue'], ['서명 완료', 'green'], ['해당 없음', 'default']] }),
    pay: Object.freeze({ key: 'onboardPay', name: '입점 입금', short: '입금', todo: '입금 대기', start: '입금 대기', done: '입금 완료',
      options: [['입금 대기', 'yellow'], ['입금 완료', 'green'], ['해당 없음', 'default']] }),
    invoice: Object.freeze({ key: 'onboardInvoice', name: '입점 계산서', short: '계산서', todo: '발행 대기', start: '발행 대기', done: '발행 완료',
      options: [['발행 대기', 'yellow'], ['발행 완료', 'green'], ['해당 없음', 'default']] })
  }),
  /** 계산서 · 입금 내역(브랜드와 반복해서 주고받는 돈). */
  BILLING: Object.freeze({
    KINDS: Object.freeze(['입점비', '상품 매입', '위탁 정산', '샘플·기타']),
    ONBOARD_KIND: '입점비',
    DIRECTIONS: Object.freeze(['받을 돈', '줄 돈']),
    PAY: Object.freeze({ WAIT: '입금 대기', DONE: '입금 완료', NONE: '해당 없음' }),
    INVOICE: Object.freeze({ WAIT: '발행 대기', DONE: '발행 완료', NONE: '해당 없음' })
  }),
  DOC_CATEGORIES: Object.freeze({ '사업자등록증': 'docBusiness', '통장사본': 'docBank', '브랜드 소개서': 'docIntro', '계약서': 'docContract', '기타 브랜드 자료': 'docOther' }),
  ASSET_CATEGORIES: Object.freeze(['대표 이미지', '추가 이미지', '상세페이지', '기타']),
  MOVEMENT_KINDS: Object.freeze(['최초 입고', '추가 입고', '반품', '회수', '재고 조정']),
  ACTIVITY_METHODS: Object.freeze(['전화', '이메일', '미팅', '메신저', '기타'])
});

/**
 * Notion 데이터베이스별 속성 정의.
 * key: [형식, [이름 후보...], 필수 여부]
 * 이름이 바뀌어도 처음 연결된 속성 ID를 스크립트 속성에 저장해 계속 찾아간다.
 */
const BO_SCHEMAS = Object.freeze({
  brand: {
    label: '브랜드 목록', prop: 'BO_NOTION_BRAND_DATA_SOURCE_ID', legacyProp: 'NOTION_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['브랜드명'], true],
      code: ['rich_text', ['브랜드 ID'], true],
      stage: ['select', ['진행 단계'], true],
      company: ['rich_text', ['협력사/회사명', '회사명']],
      reStage: ['select', ['재영업 단계']],
      reClass: ['select', ['재영업 분류']],
      priority: ['select', ['우선순위']],
      contactName: ['rich_text', ['브랜드 담당자']],
      phone: ['rich_text', ['연락처']],
      email: ['rich_text', ['이메일']],
      category: ['multi_select', ['카테고리']],
      trade: ['multi_select', ['희망 거래 방식']],
      area: ['multi_select', ['희망 영역']],
      channel1: ['rich_text', ['희망 채널 1순위']],
      channel2: ['rich_text', ['희망 채널 2순위']],
      channelAny: ['rich_text', ['순위 무관 희망 채널']],
      currentSales: ['rich_text', ['현재 판매 채널']],
      salesChannel: ['multi_select', ['판매 채널']],
      memo: ['rich_text', ['핵심 메모']],
      next: ['rich_text', ['다음 행동']],
      reference: ['rich_text', ['참고 링크/자료']],
      drive: ['url', ['구글 드라이브']],
      feature: ['rich_text', ['상품 특장점']],
      productLine: ['rich_text', ['대표 상품군']],
      bizNo: ['rich_text', ['사업자 번호']],
      received: ['date', ['접수일']],
      launch: ['date', ['브랜드 런칭일자']],
      meeting: ['date', ['미팅일']],
      formSubmitted: ['checkbox', ['폼 제출']],
      issue: ['select', ['이슈 여부']],
      owner: ['people', ['소통 담당자']],
      docBusiness: ['url', ['사업자등록증 Drive URL']],
      docIntro: ['url', ['브랜드 소개서 Drive URL']],
      docContract: ['url', ['계약서 Drive URL']],
      docOther: ['url', ['기타 브랜드 자료 Drive URL']],
      docBank: ['url', ['통장사본 Drive URL']],
      formResponseId: ['rich_text', ['폼 응답 ID']],
      contractSent: ['select', ['계약서 발송']],
      onboardPay: ['select', ['입점 입금']],
      onboardInvoice: ['select', ['입점 계산서']]
    }
  },
  product: {
    label: '상품 · SKU', prop: 'BO_NOTION_PRODUCT_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['상품명'], true],
      productId: ['rich_text', ['운영센터 상품 ID'], true],
      brand: ['relation', ['브랜드'], true],
      review: ['select', ['등록 검수 상태'], true],
      reviewNote: ['rich_text', ['검수 메모']],
      submittedAt: ['date', ['제출일']],
      submitter: ['rich_text', ['제출자']],
      change: ['select', ['변경 요청']],
      thumbnail: ['url', ['대표 이미지 Drive URL']],
      detail: ['url', ['상세페이지 Drive URL']],
      barcode: ['rich_text', ['바코드(텍스트)']],
      option: ['rich_text', ['옵션명']],
      description: ['rich_text', ['제품 설명']],
      retail: ['number', ['소비자가']],
      purchase: ['number', ['매입가(매입 가능시)']],
      consign: ['number', ['공급가(위탁 가능시)']],
      offline: ['number', ['오프라인 위탁 판매가']],
      online: ['number', ['온라인 최저가']],
      moq: ['number', ['MOQ']],
      category: ['multi_select', ['카테고리']],
      reference: ['url', ['참고 링크']],
      channels: ['multi_select', ['노출 희망 채널']],
      image: ['files', ['이미지']],
      created: ['created_time', ['최초 등록일']]
    }
  },
  link: {
    label: '상품등록 링크', prop: 'BO_NOTION_LINK_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['링크명'], true],
      brand: ['relation', ['브랜드'], true],
      token: ['rich_text', ['토큰'], true],
      status: ['select', ['상태'], true],
      expiry: ['date', ['만료일'], true],
      lastAccess: ['date', ['마지막 접속']],
      issuer: ['rich_text', ['발급자']],
      memo: ['rich_text', ['메모']]
    }
  },
  activity: {
    label: '연락 · 진행 이력', prop: 'BO_NOTION_ACTIVITY_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['이력명'], true],
      brand: ['relation', ['브랜드'], true],
      date: ['date', ['일자'], true],
      method: ['select', ['연락 방식']],
      result: ['select', ['결과']],
      counterpart: ['rich_text', ['상대방 담당자']],
      content: ['rich_text', ['통화 내용']],
      next: ['rich_text', ['다음 행동']],
      due: ['date', ['후속 확인일']],
      done: ['checkbox', ['후속 완료']],
      staff: ['people', ['상담 담당자']]
    }
  },
  billing: {
    label: '계산서 · 입금 내역', prop: 'BO_NOTION_BILLING_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['내역명'], true],
      brand: ['relation', ['브랜드'], true],
      kind: ['select', ['구분']],
      direction: ['select', ['방향']],
      amount: ['number', ['금액']],
      date: ['date', ['기준일']],
      payStatus: ['select', ['입금 상태'], true],
      paidAt: ['date', ['입금일']],
      invoiceStatus: ['select', ['계산서 상태'], true],
      invoicedAt: ['date', ['계산서 발행일']],
      memo: ['rich_text', ['메모']],
      registrar: ['rich_text', ['등록자']]
    }
  },
  inventory: {
    label: '[재고현황] 입점 상품 운영', prop: 'BO_NOTION_INVENTORY_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['관리명'], true],
      product: ['relation', ['상품'], true],
      store: ['relation', ['입점 매장'], true],
      stock: ['number', ['실재고'], true],
      brand: ['relation', ['브랜드사']],
      sample: ['number', ['샘플·DP 수량']],
      status: ['select', ['입점 상태']],
      method: ['select', ['판매 방식']],
      consign: ['number', ['위탁 공급가']],
      storePrice: ['number', ['위탁 매장 판매가']],
      location: ['rich_text', ['진열 위치']],
      note: ['rich_text', ['특이사항']],
      noteType: ['multi_select', ['특이사항 유형']],
      check: ['checkbox', ['확인 필요']],
      delivered: ['date', ['납품일']]
    }
  },
  movement: {
    label: '입출고 이력', prop: 'BO_NOTION_MOVEMENT_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['이력명'], true],
      product: ['relation', ['상품'], true],
      store: ['relation', ['입점 매장'], true],
      qty: ['number', ['수량 (+/-)'], true],
      kind: ['select', ['구분']],
      direction: ['select', ['입출고 방향']],
      date: ['date', ['처리일']],
      state: ['select', ['처리 상태']],
      note: ['rich_text', ['비고']],
      brand: ['relation', ['브랜드 연결(회사명용)']]
    }
  },
  store: {
    label: '입점 매장 DB', prop: 'BO_NOTION_STORE_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['매장명'], true],
      code: ['rich_text', ['매장 코드']],
      status: ['select', ['운영 상태']],
      channel: ['select', ['채널 유형']],
      method: ['select', ['기본 거래 방식']]
    }
  },
  terms: {
    label: '벤더 동일 상품 조건', prop: 'BO_NOTION_TERMS_DATA_SOURCE_ID',
    fields: {
      name: ['title', ['조건명'], true],
      vendor: ['relation', ['벤더'], true],
      product: ['relation', ['상품']],
      trade: ['multi_select', ['거래 방식']],
      state: ['select', ['검토 상태']],
      purchase: ['number', ['매입가(매입 가능시)']],
      consign: ['number', ['공급가(위탁 가능시)']],
      retail: ['number', ['소비자가']],
      online: ['number', ['온라인 최저가']],
      moq: ['number', ['MOQ']],
      shipping: ['number', ['배송비']],
      basis: ['date', ['기준일']],
      adopted: ['checkbox', ['현재 채택']],
      onlineCondition: ['select', ['온라인 판매 조건']],
      note: ['rich_text', ['비고']]
    }
  }
});

/** 운영센터가 Notion에 추가로 필요로 하는 속성(초기 설정에서 없으면 만든다). */
const BO_SCHEMA_ADDITIONS = Object.freeze({
  product: [
    { key: 'reviewNote', name: '검수 메모', definition: { rich_text: {} } },
    { key: 'submittedAt', name: '제출일', definition: { date: {} } },
    { key: 'submitter', name: '제출자', definition: { rich_text: {} } },
    { key: 'change', name: '변경 요청', definition: { select: { options: [
      { name: '검수 대기', color: 'yellow' }, { name: '보완 필요', color: 'orange' },
      { name: '반려', color: 'red' }, { name: '반영 완료', color: 'green' }] } } }
  ],
  brand: [
    { key: 'formResponseId', name: '폼 응답 ID', definition: { rich_text: {} } },
    { key: 'docBank', name: '통장사본 Drive URL', definition: { url: {} } }
  ].concat(Object.keys(BO.ONBOARD).map(function (item) {
    const spec = BO.ONBOARD[item];
    return { key: spec.key, name: spec.name, definition: { select: { options: spec.options.map(function (o) { return { name: o[0], color: o[1] }; }) } } };
  }))
});

/** 운영센터가 쓰는 상품 검수 상태 선택지. 없으면 초기 설정에서 추가한다. */
const BO_REQUIRED_OPTIONS = Object.freeze({
  product: { review: [['검수 대기', 'yellow'], ['보완 필요', 'orange'], ['반려', 'red'], ['승인 완료', 'green']] },
  brand: (function () {
    const out = {};
    Object.keys(BO.ONBOARD).forEach(function (item) { out[BO.ONBOARD[item].key] = BO.ONBOARD[item].options; });
    return out;
  })()
});
