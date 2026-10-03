# 브랜드 상품등록센터를 partner.beautyora.kr로 여는 방법

브랜드사가 상품등록 링크를 처음 열 때 Google 로그인, "확인되지 않은 앱" 경고, `script.google.com` 주소,
"Google Apps Script 사용자가 만든 애플리케이션" 안내문이 보이지 않게 하는 설정입니다.

```
브랜드사 → https://partner.beautyora.kr/?token=…   (Netlify: 화면만, 뷰티오라 주소)
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

## 2. Netlify 사이트 만들기 (한 번)

1. Netlify → **Add new project → Import an existing project → GitHub** → `beautyora/beautyora-operations-center`
2. 빌드 설정은 저장소의 `netlify.toml`을 그대로 씁니다(빌드 명령 `node scripts/build-partner-web.cjs dist/partner`, 공개 폴더 `dist/partner`).
3. 사이트 이름은 예: `beautyora-partner`
4. (선택) 브랜드용 배포 주소가 바뀌면 **Project configuration → Environment variables**에 `BO_PARTNER_API_URL=https://script.google.com/macros/s/<배포 ID>/exec`

## 3. partner.beautyora.kr 연결 (한 번)

새 사이트 → **Domain management → Add a domain** → `partner.beautyora.kr`

- `beautyora.kr`을 **Netlify DNS**로 관리 중이면(팀 → Domains에 `beautyora.kr`이 보임) DNS 레코드와 HTTPS 인증서가 자동으로 만들어집니다. 예스닉 로그인은 필요 없습니다.
- **외부 DNS**(예스닉)로 관리 중이면 예스닉에 아래 한 줄을 추가해야 합니다(대표님 계정, 한 번만).
  `CNAME  partner  →  beautyora-partner.netlify.app`

랜딩페이지 `beautyora.kr`에는 영향이 없습니다.

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
