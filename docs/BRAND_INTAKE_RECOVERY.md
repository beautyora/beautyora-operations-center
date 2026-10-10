# 랜딩 입점 신청 등록 경로 복구

## 원인과 복구 범위

삭제 전 `src/16_Intake.gs`는 `onBrandFormSubmit`에서 즉시 Notion 브랜드를 만들던 실제 경로였다. PR24의 `077ea59`에서 삭제되었다. 별도 프로젝트가 담당한다는 이전 README 설명은 이 실행 경로와 일치하지 않았다. 이번 변경은 승인형 영업 단계 전환이나 과거 일괄 가져오기를 복원하지 않는다.

랜딩 `beautyora-brand/dist/apply.js`는 Apps Script bridge에 `{answers, hp}`를 POST한다. bridge는 검증 후 `FormResponse.submit()`을 호출한다. [Google 공식 제약](https://developers.google.com/apps-script/guides/triggers/installable#restrictions)에 따라 이 프로그램 제출은 form-submit 트리거를 발생시키지 않는다. 따라서 원본 Form 응답을 1분마다 읽는 `scheduledBrandIntake`를 추가한다. 원래 Google Form 직접 제출도 같은 응답 목록에 있으므로 함께 처리한다.

입력 경로는 랜딩/직접 Form → 원본 Form 및 연결 응답 시트 → 원본 Form 응답 ID 기반 폴링 → 신규 Notion 브랜드 → Drive다. 시트에는 응답 ID 열이 없으므로 행 번호/타임스탬프만으로 식별하지 않으며 원본 시트에는 아무 열도 추가하거나 값을 쓰지 않는다. 원본 Form과 연결 시트 ID 일치를 검증한다. 실제 시트 반영은 아래 실폼 테스트에서 별도 확인해야 한다. Form117건/Sheet112행의 기존 차이는 자동 보정하지 않는다.

## 동작·안전 경계

- `setupBrandIntake`를 기존 `BO_ADMIN_EMAILS` 허용 목록의 관리자가 명시적으로 실행해야 활성화된다. 배포 또는 `setupBeautyora`만으로 활성화하지 않는다. `BO_GOOGLE_FORM_ID`, `BO_INTAKE_RESPONSE_SHEET_ID`, 기존 Notion 브랜드 연결 및 Drive 기준점이 필요하다.
- 최초 Form 응답 ID를 해시해 80개씩 `BO_INTAKE_EXCLUDED_V1_*`에 저장한다. 완료 manifest인 `BO_INTAKE_BASELINE_V1`을 마지막에 기록한다. 재실행은 기준점을 유지한다. 실패한 최초 설정은 미활성 상태이며 재시도에서 그 시점까지의 응답을 기준으로 다시 초기화한다. 확정 스냅샷 손상은 자동 재작성하지 않는다.
- 최초 읽기 시작 분보다 1분 앞선 시각부터 폴링하되 기존 ID는 제외한다. 같은 타임스탬프·자정·설정 저장 중 등록도 처리한다. 초기 조회에 포함된 응답은 기존으로 분류되므로 테스트는 성공한 활성화 이후에 제출한다. 활성화 중 실제 신규 건이 있었다면 별도로 대조한다.
- 과거 은휘플로우/노아카 2건, 재신청9건, 과거19건 일괄 생성 흔적과 legacy 응답 ID는 일괄 재처리/삭제하지 않는다. 기존132브랜드/기존Drive기준점 및 제외 대상은 유지한다.
- 기존 브랜드 식별은 [별칭·검토 규칙](BRAND_INTAKE_IDENTITY.md)을 따른다(코드 변경, 미배포). 확인된 별칭/유일한 이름과 사업자번호를 대조하며 동일 사업자·다른 이름은 검토한다. 기존 페이지 속성·영업 단계·댓글·Drive는 수정하지 않는다. 새 신청 원본은 Form/응답 시트에 유지하고 journal에 기존 BO ID 연결을 남긴다.
- 복수 브랜드는 괄호 밖 쉼표/세미콜론/줄바꿈으로 구분하고 대소문자/공백 정규화 중복을 제거한다. 1응답 최대25브랜드다. 신규에만 `접수·검토`, `신규 · 상품 미등록`, 새 BO ID, 연락/신청정보 및 `폼 응답 ID`를 기록한다. 기존 선택지를 추가하지 않고 알려진 다중 선택지만 쓰며 원문 전체를 새 페이지 본문에 보존한다.
- `폼 응답 ID` rich_text 속성이 필수다. 기존 속성 및 값은 그대로 사용하고 스키마를 자동 추가/변경하지 않는다. 없으면 부모가 확인/조율 후 처리해야 한다.
- 전역 잠금으로 폴링·수동 API·폴더 트리거를 직렬화한다. 응답별 처리 기록은 `BO_INTAKE_JOB_V1_<응답ID해시>`에 저장하며 부분 완료를 보존한다. 완료 기록은 작은 `done` 표시로 압축하되 기존 브랜드에 연결한 `matches`는 보존한다. 한 값8KB, 전체400KB 보수적 상한 초과 시 생성 전에 중단하고 관리자에게 알린다. 기록을 임의 삭제하면 재처리 위험이 있으므로 자동 정리는 하지 않는다. 장기 사용으로 한도에 접근하면 별도 보관/이관 설계가 필요하다.
- Notion 생성 POST는 자동 재전송하지 않는다. POST 전 `creating` 상태와 BO ID·이름 해시를 예약한다. 응답 유실/5xx의 불명확한 결과는 `폼 응답 ID`로 생성 페이지가 확인되면 복구하고, 확인되지 않으면 재생성하지 않는다. 다른 응답도 예약된 BO ID·같은 이름을 재사용하지 않는다. 명백한 거부(400/401/403/404/429)만 이후 폴링에서 재시도한다. 불명확한 결과가 계속 조회되지 않으면 관리자가 Notion 생성 여부를 대조한 후 제한적으로 처리 기록 복구를 조율해야 한다. 무조건 초기화하지 않는다.
- 페이지 생성 후 Drive 실패는 페이지/폴더 재사용으로 복구한다. 기존 영업값은 건드리지 않는다. 처리 중 응답 수정 또는 생성 페이지 삭제/이동은 자동 재생성 없이 중단한다.
- 새 성공 메일/신청자 연락/Slack 발송은 없다. 실패 시 기존 `notifyAdmins_`만 관리자 메일에 오류 참조번호를 보낸다. 응답 원문/연락처는 알림에 넣지 않는다. 부모가 확인한 Form 설정은 이메일 수집·응답사본·수정허용·1회제한 모두 꺼짐이다. 실제 실행 전 설정 유지 여부를 재확인한다.
- 새 setup은 현재 설치 계정의 `scheduledBrandIntake`만 교체한다. 다른 사람 소유 및 `scheduledBeautyoraSync`, `handleBrandFormSubmit` 등 기존 트리거는 변경하지 않는다. 한 지정 계정으로 설치한다. 다른 사용자가 중복 설치해도 프로젝트 잠금/처리 기록으로 중복 생성을 막지만 트리거 비용은 늘어난다. 레거시 다른 핸들러 복구/삭제는 별도 범위다.

## 코드·모의 검증

`node --test tests/*.test.cjs`를 실행한다. CI와 배포 전 테스트도 두 테스트 파일을 모두 실행한다. `tests/fixtures/form-bridge.gs`는 beautyora-brand main `a0c5c82`의 원본 bridge 사본으로, VM 모의 테스트가 실제 `doPost`의 필수입력 검증과 프로그램 제출을 실행한다. 원본 Form 응답/시트, Notion, Drive는 가짜 객체다. 이것을 운영 E2E 완료로 보고하지 않는다. 해당 fixture는 landing bridge 변경 시 함께 대조해야 한다.

## 부모가 수행할 운영 활성화·실폼 검증

1. 새 PR/CI/독립 리뷰 확인. main 최신 변경을 보존해 승인 head만 병합한다. 운영 배포 guard의 기대 프로젝트는 `1npgGPe…fnVTS`이며 '(미사용)' 옛 프로젝트는 사용하지 않는다.
2. 부모 browserworker가 배포 직전 현재 원본 Form 응답수·시트 실제 행수·Notion132개·Drive연결130개(자사2개 제외)·영업 단계와 기타 필드·현재7개 트리거를 읽기 대조한다. Form117/Sheet112 차이는 별도로 기록하며 삭제/정리하지 않는다.
3. 운영 Script Properties에서 기존 `BO_GOOGLE_FORM_ID`가 원본 Form `1j-c_1ouJu4nZP7o6NWFQyjp6U9Nltk3kc6JDitFUAWo`인지 확인한다. `BO_INTAKE_RESPONSE_SHEET_ID`에는 연결 시트 `1W_nwOtM7nylhN-ry-aXV_2XA6b1cBEunTIIKja8PaYE`를 설정한다. `폼 응답 ID` 속성 존재/형식, 기존 Drive baseline132 ID를 확인한다. 토큰은 출력/변경하지 않는다.
4. Actions `main`, `target=production`, `mode=existing`, 추가 배포 ID 빈칸으로 배포. `운영 프로젝트 확인: 일치` 로그 및 새 배포 버전/커밋을 확인한다. 새로운 OAuth 동의가 나타나면 범위를 정확히 보고하고 부모와 조율한다. Form 읽기는 FormApp 권한이 필요하며 임의 새 인증값을 발급하지 않는다.
5. 기존 `BO_ADMIN_EMAILS`에 등록된 동일 운영 계정에서 **`setupBrandIntake`를 한 번만 실행**한다. 편집기에서도 명시적 관리자 검사에 통과해야 하며 `active===effective`만으로 허용하지 않는다. thanks929292 운영 계정의 기존 관리자 등록 여부를 읽기로 확인하고, 자동으로 허용 목록을 확대하지 않는다. `setupBeautyora`/폴더 기준점 초기화를 반복할 필요 없다. 반환된 `activatedAt`, `excludedResponses`, 새 `scheduledBrandIntake` 1분 트리거를 기록한다. 예상 총트리거는 기존7개 보존+신규1개지만 실제 계정별 가시성 차이를 확인한다. 초기 제외 건수는 시트112가 아니라 실행 시 Form 응답수다.
6. 성공 후에만 부모의 승인된 TEST 1건을 `https://beautyora.kr/apply/?from=partner`에서 제출한다. `TEST_뷰티오라_연동확인`, 000-00-00000, 000-0000-0000, beautyora-e2e-test@example.com, https://example.com/beautyora-test 표식을 사용한다. 외부 실연락처를 쓰지 않는다. 한 번만 전송하고 성공 화면/시각을 기록한다. 실패/타임아웃이면 재전송 전에 Form/시트부터 확인한다.
7. 원본 Form+1, 응답 시트+1, Notion 해당 TEST 이름1개·고유BO ID·폼 응답 ID·신규 초기 단계·입력필드, Drive 폴더1개·3하위폴더·Notion URL을 확인한다. 기존132개 영업값과 legacy응답ID 무변경, 은휘플로우/노아카 소급 생성 없음, 자사2개 Drive 제외 유지 확인.
8. 다음 두 번의 폴링 및 기존 폴더 트리거 실행 후 TEST Notion/Drive 중복0을 확인한다. 오류 실행/관리자 오류메일 유무도 기록한다. 실제 데이터 삭제는 승인되지 않았으므로 TEST 기록도 표식 그대로 남기고 정리는 별도 조율한다.

## 중단과 복구

부모가 지정 설치 계정의 `scheduledBrandIntake`만 중지/제거한다. 일반 `setupBeautyora`는 이 핸들러를 제거하지 않는다. Notion/Drive/응답시트/legacy트리거 및 기준점/처리 기록을 보존한다. 소스 롤백은 시간 트리거가 최신 프로젝트 코드를 실행한다는 점을 고려한다. 재개 시 `setupBrandIntake`는 기존 기준점을 유지한다. 과거 누락2건의 처리는 별도 명시 승인 작업으로 남긴다.
