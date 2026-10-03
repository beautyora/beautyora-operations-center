# 운영센터를 ops.beautyora.kr로 여는 방법

운영센터(직원용)를 `script.google.com` 주소, "확인되지 않은 앱" 경고, Drive 전체 권한 동의 화면 없이
**일반 "Google로 로그인" 버튼**으로 여는 설정입니다. 상품등록센터(`docs/PARTNER_DOMAIN_GUIDE.md`)와 같은 구조입니다.

```
관리자 → https://ops.beautyora.kr   (Cloudflare Pages: 화면만)
           │ ① Google로 로그인 → Google이 서명한 ID 토큰(약 1시간)
           │ ② 요청마다 ID 토큰을 함께 보냄 (fetch, text/plain JSON)
           ▼
      Apps Script 웹앱 doPost   (브랜드용 배포와 같은 웹앱, 소유자 권한)
           │ ③ Google tokeninfo로 토큰 확인 → 이 클라이언트 ID용인지, 이메일 인증 여부, 만료 확인
           │ ④ 이메일이 BO_ADMIN_EMAILS에 있어야 관리자 작업 처리
           ▼
      Notion · Google Drive
```

- 로그인 버튼은 **이메일 확인만** 요청합니다. Drive 같은 권한을 묻지 않으므로 경고 화면이 없습니다.
- 서버는 브라우저의 Google 로그인 상태(쿠키)를 믿지 않고, 요청에 담긴 ID 토큰만 믿습니다.
- 작업은 소유자 계정 권한으로 실행됩니다. 기록(검수 메모·영업 기록 작성자 등)에는 로그인한 이메일이 남습니다.
- 기존 `script.google.com` 운영센터 주소도 그대로 동작합니다.

## 1. Google 로그인용 클라이언트 ID 만들기 (한 번, 무료)

[Google Cloud 콘솔](https://console.cloud.google.com)에서 운영센터 소유 계정으로 진행합니다.

1. 위쪽 프로젝트 선택 → **새 프로젝트** → 이름 `beautyora-ops` → 만들기
2. **API 및 서비스 → OAuth 동의 화면**(또는 **Google 인증 플랫폼 → 브랜딩**)
   - 앱 이름 `뷰티오라 운영센터`, 사용자 지원 이메일, 개발자 연락처 이메일 입력
   - 대상(User type): **외부**
   - 범위(데이터 액세스)는 추가하지 않습니다(기본 `openid`·`email`·`profile`만 사용 → 앱 검증 불필요)
   - **대상 → 앱 게시(프로덕션으로 푸시)**. 테스트 상태로 두면 테스트 사용자로 등록한 계정만 로그인할 수 있습니다.
3. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**(또는 **클라이언트 → 클라이언트 만들기**)
   - 애플리케이션 유형: **웹 애플리케이션**, 이름 `ops.beautyora.kr`
   - **승인된 JavaScript 원본**: `https://ops.beautyora.kr`, `https://beautyora-ops.pages.dev`
   - 리디렉션 URI는 비워 둡니다.
4. 만들어진 **클라이언트 ID**(`123456789012-xxxx.apps.googleusercontent.com`)를 복사합니다. 공개값이라 비밀이 아닙니다.
   클라이언트 보안 비밀번호는 쓰지 않습니다.

## 2. Apps Script 스크립트 속성

`BO_GOOGLE_CLIENT_ID` = 위에서 복사한 클라이언트 ID

브랜드용 배포(`AKfycbwWlj4W…`)가 **실행: 나 / 액세스: 모든 사용자**인지 확인합니다(상품등록센터와 같은 웹앱을 씁니다).

## 3. Cloudflare Pages 프로젝트

**Workers & Pages → Create → Pages → Connect to Git** → `beautyora-operations-center`
(Workers가 아니라 **Pages**입니다. 설정 화면에 Deploy command 칸이 없어야 합니다.)

| 항목 | 값 |
|---|---|
| Project name | `beautyora-ops` |
| Production branch | `main` |
| Framework preset | None |
| Build command | `node scripts/build-web.cjs admin dist/ops` |
| Build output directory | `dist/ops` |
| Environment variables | `BO_GOOGLE_CLIENT_ID` = 클라이언트 ID |

`BO_GOOGLE_CLIENT_ID`가 없으면 빌드가 실패하며 이유를 알려 줍니다.

## 4. ops.beautyora.kr 연결

1. Cloudflare `beautyora-ops` → **Custom domains → Set up a custom domain** → `ops.beautyora.kr` → **My DNS provider**
2. Netlify → **Domains → beautyora.kr → Add new record**: `CNAME  ops  beautyora-ops.pages.dev`
3. Cloudflare에서 **Check DNS records** → **Active**

## 확인

1. `https://ops.beautyora.kr` → "운영센터 로그인" 창 → Google 계정 선택 → 홈 화면
2. `BO_ADMIN_EMAILS`에 없는 계정으로 로그인하면 "관리자로 등록되어 있지 않습니다"가 나와야 합니다.
3. 설정 → 연결 점검의 **운영센터 주소 로그인**이 "정상"인지 봅니다.

| 증상 | 원인 |
|---|---|
| 로그인 창에 "origin is not allowed"·버튼이 안 보임 | 1-3의 승인된 JavaScript 원본에 지금 주소가 없음 |
| 로그인 후 "운영센터 로그인이 설정되지 않았습니다" | 스크립트 속성 `BO_GOOGLE_CLIENT_ID` 없음 |
| 로그인할 때마다 다시 로그인하라고 함 | Cloudflare의 `BO_GOOGLE_CLIENT_ID`와 스크립트 속성 값이 다름 |
| "인터넷 연결이 불안정합니다" | 브랜드용 배포가 "모든 사용자"가 아님 |
| 동의 화면에서 "액세스 차단됨: 테스트 중인 앱" | 1-2의 앱 게시를 하지 않음 |
| 홈·입점 신청은 열리는데 브랜드·상품·재고가 계속 로딩 | Apps Script가 큰 doPost 응답을 브라우저에 넘기지 못함(googleusercontent 주소가 404, 실행 기록은 '완료됨'). 서버가 큰 응답을 gzip 조각으로 나눠 보내도록 고쳤으므로, 이 증상이 보이면 Apps Script 배포가 최신 버전인지 확인 |
