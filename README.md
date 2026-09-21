# 뷰티오라 운영 자동화

뷰티오라 브랜드 입점·파트너 운영을 위한 Google Apps Script 프로젝트입니다.

## 주요 기능

- Google Form 브랜드 입점 응답 수집
- 검토 시트 기반 신규 브랜드 승인
- Notion 브랜드 데이터베이스 신규 페이지 생성
- Notion 데이터를 Google Sheets 브랜드 목록으로 동기화
- 관리자 및 파트너용 웹 앱 화면 제공
- 파트너 상품 등록 및 운영 보조 기능

## 2026-09-21 수정 사항

Notion API가 다음 오류로 중단되던 문제를 수정했습니다.

```text
Notion API 400: 3만원 미만 상품 is not a property that exists.
```

현재 Notion `브랜드 목록` 데이터베이스에는 `3만원 미만 상품` 속성이 없고,
최신 폼 데이터는 `순위 무관 희망 채널` 속성을 사용합니다.
따라서 Notion 페이지 생성 payload에서 폐기된 `3만원 미만 상품` 속성 전송을 제거했습니다.

## 디렉터리

- `src/*.gs`: Apps Script 서버 코드
- `src/*.html`: Apps Script HTML 템플릿 및 프런트엔드 코드

## 환경 설정

API 토큰과 운영 설정값은 소스 코드에 직접 넣지 않고 Apps Script의
스크립트 속성(`PropertiesService`)으로 관리합니다.

주요 속성 이름:

- `BO_NOTION_TOKEN`
- `BO_NOTION_DATABASE_ID`
- `BO_SPREADSHEET_ID`
- `BO_ROOT_FOLDER_ID`
- `BO_GOOGLE_FORM_ID`
- `BO_ADMIN_EMAILS`
- `BO_PARTNER_WEBAPP_URL`

레거시 브랜드 동기화 코드에서는 `NOTION_TOKEN`과
`NOTION_DATA_SOURCE_ID` 설정도 사용합니다.

## 보안 주의사항

- 실제 Notion 토큰, Google 인증 정보, 개인정보가 포함된 운영 데이터는 커밋하지 않습니다.
- 배포 전 Apps Script의 스크립트 속성과 권한 범위를 확인합니다.
- 이 저장소는 비공개 상태를 유지하는 것을 권장합니다.

## 원본 프로젝트

Google Apps Script 프로젝트: `뷰티오라 브랜드 DB 자동동기화`
