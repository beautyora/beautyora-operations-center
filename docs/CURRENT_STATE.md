# 뷰티오라 서비스 현재 상태

운영센터와 브랜드 랜딩의 현재 상태를 기록하는 **단일 원본**입니다. 다른 저장소에는 이 문서의 링크만 둡니다. 문서 자체는 자동으로 최신화되지 않으므로 작업 시작과 세션 재개 때 최신 main 및 실제 배포 상태를 다시 확인하세요.

- 마지막 코드·배포 상태 확인: **2026-10-05 10:08 UTC**
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

- 확인한 main은 [PR35](https://github.com/beautyora/beautyora-operations-center/pull/35)의 회사·브랜드 공동 폴더 명명 및 안전한 재사용 변경입니다.
- [운영 배포 실행](https://github.com/beautyora/beautyora-operations-center/actions/runs/37286431706)에서 **v110** 기존 운영 웹앱 갱신을 확인했습니다. 배포 시각은 2026-10-05 08:53 UTC입니다.
- 같은 코드의 [서버·Chromium CI](https://github.com/beautyora/beautyora-operations-center/actions/runs/37286213426)는 성공했습니다. 별도 외부 배포 검사 실패도 존재하므로 모든 검사가 성공했다고 표현하지 않습니다.
- 배포 대상은 scripts/verify-deploy-target.cjs의 승인된 운영 대상과 대조합니다. 옛 미사용 프로젝트로 바꾸지 않습니다.
- **미검증:** v110 규칙으로 다음 실제 신규 신청의 폴더가 생성되는 전체 운영 흐름. 모의 테스트나 배포 성공으로 대체하지 않습니다.
- **미배포(브랜치 `claude/dazzling-gates-pgd8gv`):** 홈의 브랜드 자료 현황(src/17_BrandActivity.gs, 읽기 전용, 홈을 열어 둔 동안 1분 주기 확인). 모의 Drive·Chromium 테스트만 통과했고 실제 브랜드 폴더로 확인하지 않았습니다. v110에는 없습니다.
- **미해결:** ops.beautyora.kr 첫 진입 화면 깨짐·Google 로그인 없음. 현재 페이지는 USER_ACCESSING 웹앱을 iframe으로 띄우므로 Google에 로그인되지 않았거나 여러 계정이 로그인된 브라우저에서 Google 로그인 화면이 iframe 안에서 막히는 것으로 추정합니다(운영 화면 직접 확인 전). 인증 방식 변경은 별도 승인 후 진행합니다.

### 브랜드 랜딩과 브릿지

- [PR14](https://github.com/beautyora/beautyora-brand/pull/14)는 main에 반영되어 접수증 담당자 선택과 브릿지 달력 날짜 처리를 수정했습니다.
- 위 확인 시각 기준으로 **PR14의 Netlify production 배포는 게시되지 않았습니다**. 접수증 화면 수정이 운영에 반영되었다고 보고하지 않습니다. preview 성공도 production 성공을 뜻하지 않습니다.
- 별도 Form 브릿지의 실제 배포 버전·런타임은 이번 문서 작업에서 재확인하지 않았습니다. 랜딩 배포 상태로 브릿지 상태를 추정하지 않습니다.
- [접수증·날짜 변경 가이드](https://github.com/beautyora/beautyora-brand/blob/main/docs/apply-receipt-date-fix.md)는 작성 당시 절차를 담고 있습니다. 당시의 draft/미배포 표현을 현재 상태로 읽거나 실등록 절차를 재실행하지 않습니다.

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
