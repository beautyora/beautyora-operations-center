# 뷰티오라 Apps Script 간편 배포 가이드

## 목표

GitHub를 코드의 유일한 기준으로 사용합니다.

- 작업 브랜치 → 테스트 Apps Script
- `main` 브랜치 → 운영 Apps Script
- 테스트·운영 DB ID와 토큰은 각 Apps Script의 스크립트 속성에서 별도 관리
- GitHub에는 실제 DB ID, Notion 토큰, Google 인증 파일을 커밋하지 않음

## 배포 전 환경 연결 확인

테스트와 운영 Apps Script의 **프로젝트 설정 → 스크립트 속성**에
각 환경의 Notion 데이터 소스 ID와 Drive 폴더를 따로 넣습니다(목록은 `README.md` 참고).

- **테스트 환경은 반드시 테스트용 Notion DB를 가리키게 합니다.** 운영 DB ID를 테스트 스크립트에 넣지 않습니다.
  테스트용 DB는 운영 브랜드 목록·연락 진행 이력 DB를 Notion에서 복제해 만들면 됩니다.
- 새 환경에서는 배포 후 운영센터 → **설정 → 초기 설정 실행**을 한 번 누릅니다.
- **설정 → 연결 상태**가 모두 "정상"인지 확인합니다.

## 한 번만 설정할 항목

GitHub 저장소의 **Settings → Secrets and variables → Actions → New repository secret**에서 다음 5개를 등록합니다.

| Secret | 내용 |
|---|---|
| `CLASPRC_JSON_BASE64` | `clasp login` 후 만들어진 `.clasprc.json`을 Base64로 변환한 값 |
| `TEST_SCRIPT_ID` | 테스트 Apps Script의 스크립트 ID |
| `TEST_DEPLOYMENT_ID` | 현재 테스트 웹앱 배포 ID |
| `PROD_SCRIPT_ID` | 운영 Apps Script의 스크립트 ID |
| `PROD_DEPLOYMENT_ID` | 디자인V2 운영 웹앱의 배포 ID |

### 인증값 만들기

PC에 Node.js 22 이상을 설치한 뒤 터미널에서 실행합니다.

```bash
npx @google/clasp@3 login
```

로그인 완료 후 사용자 폴더에 생성된 `.clasprc.json`을 Base64 문자열로 변환합니다.

Windows PowerShell:

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$env:USERPROFILE\.clasprc.json")
) | Set-Clipboard
```

클립보드 내용을 GitHub의 `CLASPRC_JSON_BASE64` Secret 값으로 붙여 넣습니다. 이 값은 비밀번호처럼 취급하며 코드·채팅·문서에 남기지 않습니다.

## GPT 또는 Claude로 수정할 때

작업을 요청할 때 아래 문장을 같이 사용합니다.

> `main`은 수정하지 말고 새 작업 브랜치를 만든 뒤 변경사항을 커밋해 주세요. Apps Script 환경값과 실제 데이터는 수정하지 마세요.

권장 브랜치 이름:

```text
design/header-cleanup
design/mobile-card
feature/change-history
fix/brand-list
```

## 테스트 Apps Script에 반영

1. GitHub 저장소의 **Actions** 탭으로 이동
2. **Apps Script 배포** 선택
3. **Run workflow** 선택
4. 수정한 작업 브랜치 선택
5. `target`: **test**
6. 설명 입력
7. **Run workflow** 실행
8. 완료 후 기존 테스트 웹앱 URL을 새로고침

테스트 배포는 기존 배포 ID를 갱신하므로 URL이 바뀌지 않습니다.

## 마음에 들면 운영으로 승격

1. 작업 브랜치에서 `main`으로 Pull Request 생성
2. 변경 파일과 테스트 결과 확인
3. **Merge**
4. Actions → **Apps Script 배포**
5. 브랜치: **main**
6. `target`: **production**
7. 설명 예시: `디자인V2 v44 - 모바일 카드 개선`
8. **Run workflow** 실행

워크플로는 새 Apps Script 버전을 만들고 기존 운영 배포를 갱신합니다. 기존 운영 URL은 유지됩니다.

## ops.beautyora.kr 로그인 방식으로 바꿀 때(한 번)

웹앱 실행 방식이 `USER_ACCESSING`(접속한 사용자)에서 `USER_DEPLOYING`(배포 계정)·익명 접근으로 바뀝니다. 화면은 Cloudflare Pages(ops.beautyora.kr)가 정적 페이지로 올리고, 서버 호출은 웹앱 `doPost`로 옵니다. 두 쪽을 **잇달아** 배포해야 합니다(사이에 옛 iframe 페이지는 Apps Script 안내 화면만 보여 줍니다).

1. 확인: 스크립트 속성 `BO_GOOGLE_CLIENT_ID`, 그 OAuth 클라이언트의 승인된 JavaScript 원본에 `https://ops.beautyora.kr`, 배포 계정(`CLASPRC_JSON_BASE64`의 계정)이 브랜드 자료 최상위 폴더의 소유자 또는 편집자인지.
2. Actions → **Apps Script 배포**(production, existing). 매니페스트의 실행 방식이 함께 반영됩니다. 처음이면 배포 계정으로 Apps Script 편집기에서 권한 승인이 필요할 수 있습니다.
3. 곧바로 Cloudflare Pages `beautyora-ops`를 다시 빌드(`node scripts/build-web.cjs admin dist/ops`, 출력 폴더 `dist/ops`).
4. ops.beautyora.kr을 새 창(로그인 안 된 상태 포함)으로 열어 Google 로그인 화면 → 운영진 계정으로 홈 진입, 운영진이 아닌 계정은 거절되는지 확인.
5. 설정 → 연결 상태에서 `운영센터 로그인`, `운영진 Drive 권한`을 확인하고 필요하면 운영진 계정 → `권한 맞추기`.

되돌리기: `appsscript.json`의 `webapp`을 이전 값으로 되돌린 커밋을 배포하고, Cloudflare Pages를 이전 배포로 롤백합니다.

## 절대 하지 않을 것

- 테스트 브랜치에서 production 배포
- Apps Script 편집기와 GitHub를 동시에 수정
- 테스트 Notion DB의 가짜 데이터를 운영 Notion DB로 복사
- Notion 토큰이나 `.clasprc.json`을 저장소에 커밋
- 테스트 프로젝트의 스크립트 속성을 운영값으로 변경

## 긴급 수정

운영 Apps Script에서 직접 고쳤다면 즉시 같은 변경을 GitHub `main`에도 반영해야 합니다. 가능하면 긴급 상황에서도 `fix/... → test → PR → main → production` 순서를 사용합니다.

## 현재 테스트 환경

- 테스트 Script ID: Apps Script 프로젝트 설정에서 확인
- 테스트 업로드 폴더: `뷰티오라_테스트_파일`
- 테스트 Notion: 운영 DB를 복제한 테스트 전용 DB
