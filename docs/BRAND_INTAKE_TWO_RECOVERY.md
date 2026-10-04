# 승인된 과거 응답 두 건 복구

이 기능은 관리자만 실행할 수 있습니다. 현재 UI에는 버튼을 추가하지 않습니다. Script Properties 설정만으로 자동 실행되지 않으며, merge/배포/실행은 별도 조율합니다. 기존 polling baseline, Form/Sheet 원본, 기존 브랜드 영업 속성은 변경하지 않습니다.

## 1. 읽기 전용 preview

**지원되는 편집기 경로:** Script Property `BO_INTAKE_RECOVERY_TWO_V1`에 아래 두 대상 설정을 저장한 뒤 편집기 함수 목록에서 `inspectBrandIntakeRecovery`를 선택하고 Run 합니다. 관리자 확인 후 읽기 전용 preview를 호출하고 실행 로그에 실제 응답 ID, 실제 Form timestamp, source hash, expectedMatch, 질문 ID/제목/유형/답변 hash만 기록합니다. 회사명·브랜드명·전화·이메일·답변 원문은 로그하지 않습니다. 원문은 이미 확보한 Sheet와 별도 대조합니다. 로그 메타데이터도 공개 PR에 복사하지 마세요.

`previewBrandIntakeRecovery(config)`는 원문을 반환하는 내부 검토용 관리자 진입점입니다. 인자를 생략하면 동일 Script Property를 읽습니다. 편집기에서는 반환값이 자동 표시되지 않으므로 위 inspector를 사용합니다. 임의 브라우저 런타임 코드 주입은 필요하지 않습니다.

```json
{"targets":[
  {"brand":"<승인 브랜드 1>","company":"<회사 1>","timestamp":"<시간대 포함 원본 접수 ISO 시각>"},
  {"brand":"<승인 브랜드 2>","company":"<회사 2>","timestamp":"<시간대 포함 원본 접수 ISO 시각>"}
]}
```

정확히 두 건, 각 브랜드/회사 일치 및 입력 접수시각 ±1초 안의 응답이 하나씩이어야 합니다. preview만 Sheet 숫자 변환/표시 반올림 오차를 허용합니다. 복수 일치하면 중단하며 가장 가까운 응답을 임의 선택하지 않습니다. 승인 설정의 timestamp는 inspector가 반환한 실제 Form timestamp로 교체해야 합니다. replay는 밀리초까지 정확히 일치해야 합니다. 응답 순번이나 UI `ACYDB...` ID를 실제 FormResponse ID로 사용하지 않습니다.

반환: `responses[].source`(실제 응답 ID, timestamp, 질문 ID/제목/유형/원문 답변), `sourceHash`, `currentMapping`. currentMapping은 참고용이며 승인된 필드가 아닙니다. 현재 Form에서 삭제된 과거 질문은 반환되지 않을 수 있으므로 원본 Sheet와 별도 대조합니다. 과거 채널/거래 방식 필드를 현 제목만 보고 추측하지 않습니다.

## 2. 승인 설정 확정

원본 대조 후 각 target에 `responseId`, `sourceHash`, `fields`를 추가하여 **Script Property `BO_INTAKE_RECOVERY_TWO_V1`**에 저장합니다. fields는 내부 필드명 → 원본 질문 ID 문자열입니다. `brand`, `company`는 필수이며, 그 외는 확인한 항목만 명시합니다.

예: `"fields":{"brand":"<질문ID>","company":"<질문ID>","contactName":"<질문ID>"}`.

허용 필드는 `BO_FORM_QUESTIONS`의 키입니다. 값을 직접 덮어쓰는 기능은 없습니다. 누락된 필드는 자동 매핑하지 않습니다. 조회 가능한 Form 원문은 신규 페이지 본문에 보존됩니다. 삭제된 과거 질문의 Sheet 보충은 부모 담당자가 별도로 검토/추가하며 이 helper는 하지 않습니다.

## 3. 명시적 replay

배포와 설정 검토 후 관리자 편집기 또는 관리자 웹 앱에서 `replayBrandIntakeRecovery()`를 실행합니다. 인자를 받지 않으며 저장된 설정만 사용합니다.

- 기존 ScriptLock 안에서 두 건 전부 검증한 뒤 첫 쓰기를 시작합니다.
- 실제 ID/hash, 승인 질문 ID, 회사/브랜드, 응답당 한 브랜드, 기존 baseline 제외 응답 포함 여부를 확인합니다.
- 첫 실행 때 설정 hash를 `BO_INTAKE_RECOVERY_FROZEN_V1`에 고정합니다. 그 후 대상/매핑 변경은 거부합니다. 이 속성을 삭제하여 다른 대상에 재사용하지 않습니다.
- 기존 응답 journal, 중복 확인, BO ID 배정, Drive 생성/복구를 재사용합니다. 재실행 시 완료 건은 건너뛰고 중단 건만 복구합니다. Notion 생성 결과가 불명확하면 기존 로직대로 중단합니다.
- 두 건은 트랜잭션이 아닙니다. 첫 건 성공 후 둘째가 실패할 수 있으며, 동일 설정으로 재실행합니다. 실패에 맞춰 설정을 바꿔 재실행하지 않습니다.

완료 후 부모의 기존 snapshot과 기존 브랜드 속성을 대조하고 신규 두 페이지/폴더만 확인합니다. 신규 테스트 응답 제출은 필요 없습니다.

## 검증

`node --test tests/*.test.cjs`: 관리자 권한, 읽기 전용 preview, 정확히 두 건 제한, ID/hash/질문 검증, baseline/기존 브랜드 보존, 설정 동결, 공유 lock, Drive 부분 실패와 중복 없는 재실행을 포함합니다.
