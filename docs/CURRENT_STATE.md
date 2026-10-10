# 뷰티오라 서비스 현재 상태

운영센터와 브랜드 랜딩의 현재 상태를 기록하는 **단일 원본**입니다. 다른 저장소에는 이 문서의 링크만 둡니다. 문서 자체는 자동으로 최신화되지 않으므로 작업 시작과 세션 재개 때 최신 main 및 실제 배포 상태를 다시 확인하세요.

- 마지막 코드·배포 상태 확인: **2026-10-05 12:53 UTC**
- 이 확인은 저장소와 배포 기록의 읽기 확인입니다. 실제 신규 신청을 제출하거나 Google·Notion·Drive 업무 데이터를 재검증하지 않았습니다.
- main 반영, 배포 성공, 실제 운영 동작 검증은 별개입니다.

## 서비스 역할

| 영역 | 코드 또는 원본 | 경계 |
| --- | --- | --- |
| 브랜드 랜딩·입점 입력 화면 | [beautyora-brand](https://github.com/beautyora/beautyora-brand) | Netlify가 dist를 배포 |
| Google Form 브릿지 | landing의 google-apps-script/form-bridge.gs | 별도 Apps Script 배포. Netlify나 운영센터 배포로 갱신되지 않음 |
| 접수 원본 | Google Form과 연결 응답 시트 | 원본 FormResponse ID로 식별. 시트 행번호로 대체하지 않음 |
| 신규 등록·Drive 준비 | 이 저장소 src/18_BrandIntake.gs, src/16_BrandFolders.gs | Form 폴링 → 신규 Notion 브랜드 → BO ID → Drive |
| 브랜드·영업 진행 | Notion 브랜드 목록 | 영업 단계는 직원이 수정. 자동 등록은 신규 초기값만 설정 |

실제 연결 ID와 인증값은 승인된 운영 설정에서 확인하며 이 문서에 복사하지 않습니다.

## 코드와 배포 상태

### 운영센터

- 확인한 main은 [PR44](https://github.com/beautyora/beautyora-operations-center/pull/44)(커밋 `e93e3a9`)의 공유 창 캐시 수정(홈·브랜드 탭 느려짐)입니다. 앞서 [PR42](https://github.com/beautyora/beautyora-operations-center/pull/42)(v114)에서 공유 창 문구 정리·자사 브랜드 폴더 안내, [PR41](https://github.com/beautyora/beautyora-operations-center/pull/41)(v113)에서 브랜드 공유 창 단순화, [PR39](https://github.com/beautyora/beautyora-operations-center/pull/39)(v112)에서 홈·브랜드 탭 로딩 개선, [PR37](https://github.com/beautyora/beautyora-operations-center/pull/37)(v111)에서 ops.beautyora.kr Google 로그인 복구·브랜드 자료 현황·운영진·브랜드 Drive 공유가 반영되었습니다.
- [운영 배포 실행](https://github.com/beautyora/beautyora-operations-center/actions/runs/37312387026)에서 **v115** 기존 운영 웹앱 갱신을 확인했습니다(로그 `Deployed … @115`, 커밋 `e93e3a9`). 배포 시각은 2026-10-05 12:51 UTC입니다. 직전 v114는 같은 날 12:35 UTC([실행](https://github.com/beautyora/beautyora-operations-center/actions/runs/37310511374)). 웹앱 실행 방식은 v111부터 `USER_DEPLOYING`·`ANYONE_ANONYMOUS`입니다.
- 같은 변경의 PR [서버·Chromium CI](https://github.com/beautyora/beautyora-operations-center/actions/runs/37311769494)는 성공했고, 배포 실행 안의 서버 테스트도 통과했습니다. `Cloudflare Pages: beautyora-partner` 검사는 v3에서 제거된 브랜드용 페이지라 계속 실패하며 운영센터와 무관합니다.
- Cloudflare Pages `beautyora-ops`는 main 반영 시 자동 빌드되는 것으로 보이며(PR 미리보기 빌드 성공), main 커밋의 운영 빌드 결과는 이 문서 작업에서 확인하지 못했습니다.
- 배포 대상은 scripts/verify-deploy-target.cjs의 승인된 운영 대상과 대조합니다. 옛 미사용 프로젝트로 바꾸지 않습니다.
- **미검증:** v110 규칙으로 다음 실제 신규 신청의 폴더가 생성되는 전체 운영 흐름. 모의 테스트나 배포 성공으로 대체하지 않습니다.
- **미검증(v111):** 실제 ops.beautyora.kr Google 로그인(운영진 통과·미등록 계정 거절), 홈의 브랜드 자료 현황 실제 폴더 집계, 운영진 `권한 맞추기`와 브랜드 `공유` 실제 반영. 모의 Notion·Drive 테스트와 Chromium 화면 테스트만 통과했습니다.
- v112 변경 요약: 브랜드 목록은 Notion에 필요한 속성만 요청(`filter_properties`, 거절 시 자동 대체)하고 전체 다시 읽기를 10분 → 30분으로, 브랜드 자료 현황은 지난 결과 먼저 표시·동시 재계산 방지·Drive 질의 거절 시 분할·한 번에 읽는 기준 시트 3개, 화면 요청 90초 제한, 느린 요청 실행 기록(`api.slow`, `activity.slow`). 테스트용 가짜 Notion 속성 ID 충돌로 드물게 실패하던 테스트 수정(운영 코드 무관).
- v115 변경 요약: v113부터 공유 창 열기(저장은 두 번)마다 브랜드 목록 캐시 전체와 브랜드 자료 현황 결과를 지워 다음 홈·브랜드 탭 요청이 Notion 전체를 다시 읽던 문제 수정. 이제 해당 브랜드 페이지만 다시 읽어 목록 캐시의 그 항목만 바꿈(`syncedRefreshPage_`). 폴더 만들기·브랜드 ID 직접 조회도 같은 방식.
- **미검증(v115):** 운영 화면에서 공유 창 사용 뒤 홈·브랜드 탭 체감 속도.
- v114 변경 요약: 브랜드 공유 창 안내를 한 줄로 줄이고 부가 설명 문구 정리(`같은 폴더 사용` 한 줄, `저장하면 해제`). 자사 브랜드(BO-0032·BO-0033)에서 `폴더 만들기`가 건너뛰면 성공 대신 이유를 표시.
- **데이터 반영(2026-10-05, 사용자 요청):** 자사 통합 브랜드 마이베스룸(BO-0032)·마이랩스(BO-0033)의 Notion `구글 드라이브`를 기존 통합 폴더 `[BO-0032] 뷰티오라 · 픽오라_마이베스룸`으로 연결했습니다(두 브랜드가 같은 폴더를 공유). 이전에 만들어진 빈 폴더 `마이베스룸 (BO-0032)`는 이동·삭제하지 않았습니다.
- v113 변경 요약: 브랜드 공유 창에서 Notion `자료 공유 이메일`을 보고 직접 고쳐 저장하면 Notion에 기록하고 Drive 편집자를 그 목록에 맞춤(있으면 편집자, 없으면 권한 없음). Google 알림 메일 제거. 소유자·운영진·`BO_STAFF_EMAILS`·배포 계정·최상위 폴더 공유 계정·링크 공유는 건드리지 않음. 이전 방식의 스크립트 속성 `BO_SHARE_ADDED_<폴더 ID>`는 더 이상 읽지 않습니다(남아 있어도 무해).
- **미검증(v113):** 실제 브랜드 폴더에서의 공유 저장(Notion 기록·Drive 편집자 추가/해제).
- **미검증(v112):** 운영 데이터에서의 실제 로딩 시간. 배포 후 `api.slow`·`activity.slow` 실행 기록과 홈 확인 시각의 단계별 시간으로 확인합니다.
- v111 변경 요약: 첫 화면 깨짐 원인 두 가지(v3 정리 때 빠진 `.boot` 시작 화면 스타일, iframe 안에서 막히던 Google 로그인)를 고침. ops 주소는 정적 화면 + `doPost`, 요청마다 Google ID 토큰 확인 후 `BO_ADMIN_EMAILS`와 비교. 홈 브랜드 자료 현황(읽기 전용, 홈을 열어 둔 동안 1분 주기). Drive 공유: 운영진 ↔ 최상위 폴더 편집자, Notion `자료 공유 이메일` ↔ 브랜드 폴더 편집자(미리보기 후 반영).
- **확인한 Drive 공유 상태(2026-10-05, 읽기만):** 최상위 `뷰티오라` 폴더와 확인한 브랜드 폴더 두 곳은 '링크가 있는 모든 사용자: 뷰어'라 브랜드가 업로드·편집할 수 없고 서류가 링크로 열립니다. 두 폴더의 사용자 권한은 소유 계정과 편집자 한 명뿐입니다(그 밖의 운영진 계정은 링크 뷰어로만 열 수 있음). 권한은 바꾸지 않았습니다.

### 브랜드 랜딩과 브릿지

- [PR14](https://github.com/beautyora/beautyora-brand/pull/14)는 main에 반영되어 접수증 담당자 선택과 브릿지 달력 날짜 처리를 수정했습니다.
- 위 확인 시각 기준으로 **PR14의 Netlify production 배포는 게시되지 않았습니다**. 접수증 화면 수정이 운영에 반영되었다고 보고하지 않습니다. preview 성공도 production 성공을 뜻하지 않습니다.
- 별도 Form 브릿지의 실제 배포 버전·런타임은 이번 문서 작업에서 재확인하지 않았습니다. 랜딩 배포 상태로 브릿지 상태를 추정하지 않습니다.
- [접수증·날짜 변경 가이드](https://github.com/beautyora/beautyora-brand/blob/main/docs/apply-receipt-date-fix.md)는 작성 당시 절차를 담고 있습니다. 당시의 draft/미배포 표현을 현재 상태로 읽거나 실등록 절차를 재실행하지 않습니다.

## 접수 브랜드 중복 방지 변경 (미배포)

- 2026-10-10 코드 조사: 정규화 이름만 비교하던 경로는 한글·영문 별칭을 구별하지 못했다. 확인된 별칭 → BO ID 연결, 사업자/이메일만 같은 다른 이름의 검토, 응답 한정 신규 승인과 회귀 테스트를 추가했다. 검토 알림은 응답별 발송 성공 후에만 완료로 기록하고 쿼터/일시 실패는 시간당 최대 한 번 재시도한다. [조사·검토·적용 계획](BRAND_INTAKE_IDENTITY.md).
- 위 v115 배포 로그와 관련 소스 일치는 재확인했으나 10월 9일 실제 트리거 소스/실행/journal은 미확인이다. 이 변경은 운영 미배포이며 데이터 정리·설정 변경·운영 해결 완료를 뜻하지 않는다. 기존 배포 확인시각을 갱신하지 않는다.

## 현재 접수 경로와 보호 범위

현재 구현은 **랜딩 또는 직접 Form 제출 → 원본 Form → 운영센터 1분 폴링 → 신규 Notion 브랜드 → Drive**입니다. '별도 미확인 등록 프로젝트가 Notion 생성을 담당한다'는 초기 설명은 역사적 조사 내용입니다. [PR33](https://github.com/beautyora/beautyora-operations-center/pull/33)의 폴링 복구가 현재 코드입니다.

- [Google 공식 제약](https://developers.google.com/apps-script/guides/triggers/installable#restrictions)상 FormResponse.submit()은 form-submit 트리거를 발생시키지 않습니다. 현재 폴링을 옛 onBrandFormSubmit 복원과 동일시하지 않습니다.
- setupBrandIntake는 명시적으로 활성화하는 별도 절차입니다. 최초 원본 응답 ID 기준점을 유지하며 과거 응답을 자동 재처리하지 않습니다.
- 기존 같은 브랜드는 신규 생성과 영업 속성 변경을 건너뜁니다. 모호한 매칭은 확인 전 중단합니다.
- [PR34](https://github.com/beautyora/beautyora-operations-center/pull/34)의 복구 helper는 승인된 대상과 필드에 한정됩니다. 코드 존재는 재실행·대상 변경·과거 전체 replay의 승인이 아닙니다.
- setup은 관리 대상 트리거만 정리하며 다른 핸들러와 다른 계정 소유 트리거를 임의 제거하지 않습니다.

## 현재 Drive 폴더 규칙

[폴더 설계 문서](AUTOMATIC_BRAND_FOLDERS.md)와 src/16_BrandFolders.gs를 함께 읽습니다.

- 바깥 이름 형식: `회사명 | 브랜드명 · 브랜드명 [BO-0001 · BO-0002]`
- 회사명, 모든 활성 공동 브랜드명, BO ID 목록을 포함하며 BO 숫자순으로 정렬합니다.
- 기존 URL → pending/영구 폴더 ID → 정확한 BO 구획 → 유일한 동일 사업자번호 폴더 → 신규 폴더 순서로 판정합니다.
- 사업자번호 후보가 여러 폴더이면 중단합니다. 회사명 유사성만으로 합치지 않습니다.
- 보관·조회 불가·다른 URL의 BO 구성원이 있으면 이름을 축약하지 않습니다. 접근 실패를 새 폴더 생성으로 우회하지 않습니다.
- 기존 브랜드 제외 기준점과 자사 브랜드의 신규 폴더 생성 제외를 유지합니다.
- 기존 폴더 ID·부모·권한·자료를 보존합니다. 기존 폴더끼리 병합하거나 파일을 이동·삭제하지 않습니다.
- 표시명 예외와 세부 재사용 조건은 기존 코드·설계 문서를 참조합니다. 실제 폴더 정리나 복구의 완료 여부는 별도 운영 기록으로 확인합니다.

## 문서 갱신과 과거 기록

1. 코드 변경 PR에는 동작·제약·검증 결과와 미배포 여부를 함께 반영합니다.
2. 실제 배포 후에만 대상·버전·커밋·UTC 확인시각·공개 근거 링크를 갱신합니다. Netlify, 운영센터, Form 브릿지를 구분합니다.
3. 운영 검증을 못 했으면 마지막 확인시각과 미검증 항목을 남깁니다. 문서 수정 시각을 운영 검증 시각으로 쓰지 않습니다.
4. 랜딩 변경이 서비스에 영향을 주면 이 원본도 갱신하고 두 저장소 PR을 서로 연결합니다. 상태 사본을 만들지 않습니다.
5. 문서가 코드나 런타임과 충돌하면 관련 작업을 멈추고 확인합니다. 과거 절차를 근거로 setup, replay, 실등록, 배포를 자동 실행하지 않습니다.

기존 README와 docs의 작업 이력·조사 수치·'이번 작업에서 미실행' 문구는 **각 문서 작성 당시의 기록**입니다. 역사 기록은 삭제하지 않으며 현재 운영 상태의 증거로 사용하지 않습니다. 특히 폴더 전환 문서의 초기 등록기 미확인 설명은 이후 접수 폴링 구현과 구분하세요.

- [공동 작업 규칙](../AGENTS.md)
- [운영센터 개요와 테스트 명령](../README.md)
- [배포 절차](APPS_SCRIPT_DEPLOYMENT_GUIDE.md)
- [접수 폴링 설계](BRAND_INTAKE_RECOVERY.md)
- [한정 복구 절차](BRAND_INTAKE_TWO_RECOVERY.md)
- [브랜드 랜딩 개요](https://github.com/beautyora/beautyora-brand/blob/main/README.md)
