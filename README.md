# 뷰티오라 운영센터 v2

뷰티오라 브랜드 입점·상품 등록·검수·영업 기록·재고를 다루는 Google Apps Script 웹앱입니다.
**데이터 원본은 Notion**이고, Google Sheets는 더 이상 데이터 저장소로 쓰지 않습니다.

## 구조 한눈에 보기

| 무엇 | 어디에 저장 | 비고 |
|---|---|---|
| 브랜드 | Notion `브랜드 목록` | 입점 신청 폼 → `접수·검토` 단계로 자동 생성 |
| 상품·검수 상태 | Notion `상품 · SKU` | `등록 검수 상태`, `변경 요청`, `검수 메모`, `제출일`, `제출자` |
| 승인된 상품의 변경 요청 | 상품 페이지 본문의 `🔁 변경 요청` 토글 | 승인 전까지 속성은 그대로 |
| 상품등록 링크(토큰) | Notion `상품등록 링크` | 초기 설정에서 자동 생성 |
| 영업 기록 | Notion `연락 · 진행 이력` | |
| 입점 체크(계약서 발송·입점 입금·입점 계산서) | Notion `브랜드 목록`의 선택 속성 3개 | 비어 있으면 '미확인'. 입점 신청 검토 때 시작 가능 |
| 계산서·입금 내역 | Notion `계산서 · 입금 내역` | 초기 설정에서 자동 생성. 입점비·매입·위탁 정산 등 반복 거래를 한 줄씩. 구분이 `입점비`면 브랜드 입점 체크에 자동 반영 |
| 재고 | Notion `[재고현황] 입점 상품 운영` + `입출고 이력` | 입출고 기록 시 실재고 자동 조정 |
| 매장 | Notion `입점 매장 DB` | |
| 공급조건 | Notion `벤더 동일 상품 조건` | 읽기 전용 표시 |
| 이미지·서류 파일 | Google Drive | 파일 목록은 Drive `appProperties`로 찾음(시트 없음) |
| 설정값·토큰 | Apps Script 스크립트 속성 | 코드·저장소에 넣지 않음 |

화면은 두 가지입니다.

- **운영센터(직원)**: 웹앱 주소. `BO_ADMIN_EMAILS`에 있는 Google 계정만 사용 가능.
  홈 · 입점 신청 · 브랜드 · 상품 · 검수 · 재고 · 설정
- **상품등록센터(브랜드)**: `?token=` 링크. 로그인 없이 자기 브랜드 상품만 등록·수정 요청·서류 제출.
  `https://partner.beautyora.kr`(Netlify)에서 같은 화면을 열 수 있습니다. 설정: `docs/PARTNER_DOMAIN_GUIDE.md`

## 디렉터리

```
src/
  00_Config.gs      속성 이름·상태값·Notion DB 스키마 정의
  01_Util.gs        오류·잠금·캐시·검증 도구
  02_Notion.gs      Notion API(재시도 포함)·스키마 해석·값 변환
  03_Auth.gs        관리자·소유자·트리거 확인
  10_Brands.gs      브랜드
  11_Products.gs    상품, 브랜드 입력 항목(Notion 속성에서 자동 생성)
  12_Review.gs      상품 검수(신규·변경 요청)
  13_Partner.gs     브랜드 상품등록센터 API
  14_Links.gs       상품등록 링크
  15_Files.gs       Drive 파일·서류 검수
  16_Intake.gs      입점 신청 폼 → Notion
  17_Crm.gs         영업 기록·공급조건
  18_Inventory.gs   재고·입출고
  23_Billing.gs     계산서·입금 내역, 입점비 → 입점 체크 반영
  19_Dashboard.gs   홈 화면
  20_Setup.gs       초기 설정·연결 점검·트리거
  21_Migration.gs   기존 시트 데이터 1회 이관
  90_Main.gs        doGet, 단일 API 진입점 api(), 브랜드 주소용 doPost(브랜드 작업만)
  Index.html / Styles.html / Common.html / Admin.html / Partner.html
scripts/
  build-partner-web.cjs  상품등록센터 화면을 Netlify용 정적 페이지로 묶음 (netlify.toml)
tests/
  harness.cjs       가짜 Notion·Drive·Apps Script 환경
  server.test.cjs   서버 흐름·보안 테스트 (node --test)
  ui.e2e.cjs        Chromium 화면 테스트 + 스크린샷
```

## 목록 최신화

브랜드·상품·재고·계산서 목록은 10분 동안 저장해 두고, 그 사이에는 요청 때마다(10초 간격) Notion에 **마지막으로 읽은 뒤 수정된 페이지만** 물어 바꿔 끼웁니다.
그래서 Notion에서 직접 바꾼 값도 새로 고침 없이 곧바로 운영센터 목록에 보입니다(`src/02_Notion.gs`의 `syncedList_`).

## 상품등록센터(브랜드) 규칙

- 브랜드에게는 Notion 상품 중 **`브랜드`에 그 브랜드가 연결된 상품이 모두** 보입니다. `운영센터 상품 ID`가 없는 상품(직원이 Notion에 직접 넣은 상품 등)에는 브랜드 화면을 열 때와 초기 설정에서 ID를 자동으로 붙입니다.
- 승인 완료·상태 없음 상품을 고치면 **수정 요청**으로 접수되고, 검수에서 승인해야 Notion에 반영됩니다. Notion에 이미 이미지 링크가 있으면 수정 요청 때 다시 올리지 않아도 됩니다.
- **상품 관리 화면**(상품이 많아도 찾고 고치기 쉽게):
  - 왼쪽에서 상태(보완 필요·검수 중·수정 요청 검토 중·등록 완료)·카테고리·대표 이미지 없음·바코드 없음으로 거르기, 상품명·바코드·옵션 검색(`/`), 정렬, 한 쪽에 50개씩.
  - 상품을 누르면 오른쪽 **수정 패널**이 열린다. 바뀐 칸은 노란색과 원래 값으로 보이고, 이전/다음(← →)으로 넘기며 "요청함에 담고 다음"으로 여러 상품을 고친 뒤 한 번에 제출한다.
  - 여러 상품을 체크하면 **표로 한꺼번에 수정**·**가격만 바꾸기**(% 올리기·내리기, 같은 값)로 고친다.
  - **엑셀로 내려받기 → 고친 뒤 엑셀 올리기**: '상품 ID' 열로 같은 상품을 찾아 바뀐 상품만 수정 요청으로 담는다.
- 상품등록 링크 기간: 14일·30일·60일·90일·180일·1년.
- 여러 상품의 사진은 파일 이름을 `바코드_대표.jpg`, `바코드_상세_1.jpg`, `바코드_추가_1.jpg`(바코드가 없으면 엑셀 행 번호 `3_대표.jpg`나 상품명)로 붙여 **사진 한꺼번에**로 올립니다.
  - 작성 중 상품을 먼저 찾고, 없으면 **등록된 상품**을 바코드·상품명으로 찾아 수정 요청 초안을 자동으로 만듭니다.
  - 대표 이미지는 항상 교체, 상세·추가 이미지는 **교체**(기본)나 **추가**를 고릅니다. 교체된 옛 파일은 지우지 않고 상품 폴더의 `이전 파일`로 옮깁니다(수정 요청은 승인할 때, 신규·보완 제출은 제출할 때). 반려된 요청의 새 파일도 `이전 파일`로 옮깁니다.
  - 올린 파일에는 내용 지문(SHA-256, Drive `boHash`)을 남겨, 이미 올라간 것과 같은 파일은 건너뜁니다.

## 보안 원칙

- 화면에서 부를 수 있는 서버 함수는 `api()` 하나입니다. 요청마다 관리자 이메일 또는 링크 토큰을 확인합니다.
- 편집기·트리거 전용 함수(`setupBeautyora`, `runHealthCheck`, `migrateLegacySheets`, `onBrandFormSubmit`, `scheduledHealthCheck`)는 소유자 실행이나 설치된 트리거에서만 동작합니다.
- 테스트(`only the audited entry points…`)가 새 공개 함수가 생기면 실패하도록 막습니다.
- 브랜드 화면에는 내부 오류 내용을 보여 주지 않고 문의 코드만 보여 줍니다.
- 다른 페이지 안에 넣는(iframe) 표시는 기본으로 막혀 있습니다. 필요하면 `BO_ALLOW_EMBED=true`.

## 스크립트 속성

| 속성 | 필수 | 내용 |
|---|---|---|
| `BO_NOTION_TOKEN` | ✅ | Notion 통합 토큰 (예전 `NOTION_TOKEN`도 읽음) |
| `BO_ADMIN_EMAILS` | ✅ | 관리자 Google 계정, 쉼표로 구분 |
| `BO_NOTION_BRAND_DATA_SOURCE_ID` | ✅ | 브랜드 목록 데이터 소스 ID |
| `BO_NOTION_PRODUCT_DATA_SOURCE_ID` | ✅ | 상품 · SKU 데이터 소스 ID |
| `BO_ROOT_FOLDER_ID` | ✅ | 브랜드 자료 루트 Drive 폴더 |
| `BO_PARTNER_WEBAPP_URL` | 권장 | 상품등록 링크의 기본 주소. 예: `https://partner.beautyora.kr` 또는 브랜드용 웹앱 주소 |
| `BO_GOOGLE_FORM_ID` | 권장 | 입점 신청 Google Form ID |
| `BO_NOTION_ACTIVITY_DATA_SOURCE_ID` | 권장 | 연락 · 진행 이력 (자동으로 찾을 수 없음) |
| `BO_NOTION_LINK_DATA_SOURCE_ID` | 자동 | 초기 설정이 만들고 채움 |
| `BO_NOTION_BILLING_DATA_SOURCE_ID` | 자동 | 계산서 · 입금 내역 DB. 초기 설정이 만들고 채움 |
| `BO_NOTION_INVENTORY_/MOVEMENT_/STORE_/TERMS_DATA_SOURCE_ID` | 자동 | 초기 설정이 관계형 속성을 따라가 찾음 |
| `BO_NOTION_PARENT_PAGE_ID` | 선택 | 링크 DB를 만들 페이지(없으면 브랜드 DB가 있는 페이지) |
| `BO_NOTION_BRAND_TEMPLATE` | 선택 | 새 브랜드 페이지 템플릿: `default` 또는 템플릿 ID |
| `BO_NOTION_PRODUCT_VIEW_ID` | 선택 | 브랜드 입력 항목 순서로 쓸 Notion 보기 |
| `BO_SPREADSHEET_ID` | 이관 때만 | 예전 운영 스프레드시트 |

## 처음 설정(환경마다 한 번)

1. 위 필수 스크립트 속성을 넣습니다. Notion에서 각 DB에 통합(Integration)을 연결합니다.
2. 운영센터 → **설정 → 초기 설정 실행** (또는 편집기에서 `setupBeautyora` 실행)
   - 상품 DB에 `검수 메모`·`제출일`·`제출자`·`변경 요청` 속성 추가
   - 브랜드 DB에 `폼 응답 ID`, 입점 체크(`계약서 발송`·`입점 입금`·`입점 계산서`) 속성 추가
   - `상품등록 링크`·`계산서 · 입금 내역` DB 생성, 재고·입출고·매장·공급조건 DB 자동 연결
   - 폼 제출 트리거·6시간 연결 점검 트리거 설치, 예전 트리거 정리
3. 기존 시트에서 옮길 데이터가 있으면 **설정 → 기존 시트 데이터 이관** (자세한 순서: `docs/V2_전환_가이드.md`)

## 테스트

```sh
node --test tests/server.test.cjs                     # 서버 흐름·보안 (의존성 없음)
npm install --no-save playwright && npx playwright install chromium
node tests/ui.e2e.cjs .ui-shots                       # 화면 테스트 + 스크린샷
```

배포 방법은 `docs/APPS_SCRIPT_DEPLOYMENT_GUIDE.md`를 봅니다.
