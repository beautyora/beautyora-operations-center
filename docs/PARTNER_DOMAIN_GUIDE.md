# 브랜드 상품등록센터를 partner.beautyora.kr로 여는 방법

브랜드사가 상품등록 링크를 처음 열 때 Google 로그인, "확인되지 않은 앱" 경고, `script.google.com` 주소,
"Google Apps Script 사용자가 만든 애플리케이션" 안내문이 보이지 않게 하는 설정입니다.

```
브랜드사 → https://partner.beautyora.kr/?token=…   (Cloudflare Pages: 화면만, 뷰티오라 주소)
              │ fetch (text/plain JSON)
              ▼
         브랜드용 Apps Script 웹앱 doPost   (소유자 권한, 브랜드 작업만 받음)
              ▼
         Notion · Google Drive
```

- 화면은 `src/`의 상품등록센터 화면을 그대로 묶습니다(`scripts/build-partner-web.cjs`). 화면을 고치면 두 주소에 함께 반영됩니다.
- `doPost`는 브랜드 작업(`partner.*`)만 받고, 모든 요청에서 링크 토큰을 확인합니다. 관리자 작업은 언제나 거절합니다.
- 기존 `script.google.com/...?token=` 링크도 계속 동작합니다.

## 1. 브랜드용 Apps Script 배포 설정 (한 번)

Apps Script 편집기 → **배포 → 배포 관리** → 브랜드용 배포(`AKfycbwWlj4W…`) → ✏️ 수정

| 항목 | 값 |
|---|---|
| 버전 | 새 버전 (`doPost`가 들어간 코드) |
| 다음 사용자 인증 정보로 실행 | **나(소유자 계정)** |
| 액세스 권한이 있는 사용자 | **모든 사용자** ("Google 계정이 있는 모든 사용자" 아님) |

이 설정이 아니면 새 주소에서 "인터넷 연결이 불안정합니다"가 뜹니다. Google 로그인 화면으로 넘어가서 응답을 읽지 못하는 상태입니다.
GitHub Actions의 운영 배포 뒤 시크릿 창에서 브랜드용 주소를 열어 로그인 화면이 다시 뜨면, 이 설정이 되돌려진 것입니다. 다시 맞춰 주세요.

## 2. Cloudflare Pages 프로젝트 만들기 (한 번, 무료·상업적 사용 가능)

Netlify 무료 플랜은 배포마다 크레딧을 써서 랜딩페이지(beautyora.kr)와 나눠 써야 하므로, 이 화면은 Cloudflare Pages에 둡니다.
Cloudflare에는 화면 HTML 파일만 있고 데이터·토큰·비밀값은 없습니다.

1. Cloudflare 가입 → **Workers & Pages → Create → Pages → Connect to Git** → GitHub에서 `beautyora-operations-center` 허용·선택
2. 설정

| 항목 | 값 |
|---|---|
| Project name | `beautyora-partner` (주소 `beautyora-partner.pages.dev`) |
| Production branch | `main` |
| Framework preset | None |
| Build command | `node scripts/build-partner-web.cjs dist/partner` |
| Build output directory | `dist/partner` |

3. **Save and Deploy**. `https://beautyora-partner.pages.dev`에서 "상품등록 링크가 필요합니다"가 보이면 정상입니다(토큰 없이 열었기 때문).
4. (선택) 브랜드용 배포 주소가 바뀌면 **Settings → Variables**에 `BO_PARTNER_API_URL=https://script.google.com/macros/s/<배포 ID>/exec`

이후 `main`에 머지할 때마다 자동으로 다시 배포됩니다. 보안 헤더는 빌드가 만드는 `_headers` 파일로 적용됩니다.

## 3. partner.beautyora.kr 연결 (한 번)

1. Cloudflare Pages 프로젝트 → **Custom domains → Set up a custom domain** → `partner.beautyora.kr`
2. Cloudflare가 "CNAME을 추가하라"고 안내하면, `beautyora.kr` DNS를 관리하는 곳에 추가합니다.
   - Netlify DNS: Netlify → **Domains → beautyora.kr → Add new record** (배포가 아니라서 크레딧을 쓰지 않음)
   - 예스닉: 예스닉 DNS 관리(대표님 계정)
   ```
   종류 CNAME   이름 partner   값 beautyora-partner.pages.dev
   ```
3. Cloudflare 화면에서 상태가 **Active**가 되면 완료(보통 몇 분, HTTPS 자동).

랜딩페이지 `beautyora.kr`에는 영향이 없습니다. 나중에 Netlify로 옮기려면 같은 저장소의 `netlify.toml`을 쓰고 CNAME 값만 바꾸면 됩니다.

## 4. 새 링크가 새 주소로 나가게 하기

Apps Script 스크립트 속성 `BO_PARTNER_WEBAPP_URL` = `https://partner.beautyora.kr`

이후 운영센터에서 발급하는 상품등록 링크는 `https://partner.beautyora.kr/?token=…` 형태가 됩니다.

## 확인

시크릿 창에서 새 링크를 열어 로그인 화면이나 경고 없이 브랜드 상품 목록이 바로 보이면 완료입니다.

```sh
node scripts/build-partner-web.cjs            # dist/partner/index.html 생성
node --test tests/server.test.cjs              # doPost 보안 테스트 포함
NODE_PATH=$(npm root -g) node tests/ui.e2e.cjs # 브랜드 주소 화면 테스트(20-brand-domain.png) 포함
```
