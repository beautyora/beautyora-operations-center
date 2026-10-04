/**
 * 뷰티오라 운영센터 v3 — Notion으로 하기 어려운 일을 맡는 내부 도구.
 *
 * 원칙
 * - 브랜드·영업 진행의 원본은 Notion이다. 운영센터는 읽고, 정해진 속성만 자동으로 채운다.
 * - 상품의 원본은 Google 시트(메인 상품목록)다. Notion 상품 DB는 쓰지 않는다.
 * - 입점 신청 폼 → Notion 등록은 별도 Apps Script 프로젝트가 맡는다. 여기서는 다루지 않는다.
 * - 환경별 값(데이터 소스 ID, 폴더 ID, 토큰)은 모두 스크립트 속성에서 읽는다. 코드에 운영 ID를 넣지 않는다.
 */
const BO = Object.freeze({
  VERSION: '3.0.0',
  NOTION_VERSION: '2025-09-03',
  TIMEZONE: 'Asia/Seoul',
  LIST_TTL: 300,
  PROPS: Object.freeze({
    NOTION_TOKEN: 'BO_NOTION_TOKEN',
    LEGACY_NOTION_TOKEN: 'NOTION_TOKEN',
    ADMIN_EMAILS: 'BO_ADMIN_EMAILS',
    ROOT_FOLDER_ID: 'BO_ROOT_FOLDER_ID',
    TEMPLATE_FILE_ID: 'BO_TEMPLATE_FILE_ID',
    ALLOW_EMBED: 'BO_ALLOW_EMBED',
    SCHEMA_IDS: 'BO_SCHEMA_IDS'
  })
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
      memo: ['rich_text', ['핵심 메모']],
      next: ['rich_text', ['다음 행동']],
      drive: ['url', ['구글 드라이브']],
      bizNo: ['rich_text', ['사업자 번호']],
      received: ['date', ['접수일']],
      issue: ['select', ['이슈 여부']],
      owner: ['people', ['소통 담당자']]
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
      next: ['rich_text', ['다음 행동']],
      due: ['date', ['후속 확인일']],
      done: ['checkbox', ['후속 완료']],
      staff: ['people', ['상담 담당자']]
    }
  }
});
