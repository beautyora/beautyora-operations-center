'use strict';
/**
 * ops.beautyora.kr(Cloudflare Pages "beautyora-ops")에 올릴 페이지를 만든다.
 * 운영센터(Apps Script 웹앱)를 화면 전체에 띄운다. 서버 호출은 웹앱 안의 google.script.run 그대로라 속도가 같고,
 * Apps Script 주소로 직접 열 때 나오는 Google 안내 문구가 보이지 않는다.
 * 웹앱 쪽 스크립트 속성 BO_ALLOW_EMBED=true가 있어야 다른 주소 안에 표시된다.
 *
 * 사용: node scripts/build-web.cjs admin [출력 폴더]
 *   BO_OPS_APP_URL=https://script.google.com/macros/s/<운영센터 배포 ID>/exec  (선택)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
if (process.argv[2] !== 'admin') {
  console.error('사용: node scripts/build-web.cjs admin [출력 폴더]');
  process.exit(1);
}
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'ops'));

// 운영센터(직원용) 운영 배포. 공개 배포 ID이며 비밀값이 아니다.
const DEFAULT_APP_URL = 'https://script.google.com/macros/s/AKfycbwru7mqa1KHPZvQKahlAooFqtM7gjqxnJLaOq8oK5QqStv-X8B4sPo6cveo7HBEfHnM/exec';
const APP_URL = String(process.env.BO_OPS_APP_URL || DEFAULT_APP_URL).trim();
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(APP_URL)) {
  console.error('BO_OPS_APP_URL 형식이 올바르지 않습니다: ' + APP_URL);
  process.exit(1);
}

const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="referrer" content="strict-origin">
  <title>뷰티오라 운영센터</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    html, body { margin: 0; height: 100%; background: #f5f5f2; }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe src="${APP_URL}" title="뷰티오라 운영센터" allow="clipboard-write"></iframe>
  <noscript><p><a href="${APP_URL}">운영센터 열기</a></p></noscript>
</body>
</html>
`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111"/><text x="32" y="43" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">B</text></svg>');
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
fs.writeFileSync(path.join(OUT, '_headers'), [
  '/*',
  '  Referrer-Policy: strict-origin',
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '  X-Robots-Tag: noindex, nofollow',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
  '  Cache-Control: no-cache',
  ''
].join('\n'));
console.log('운영센터 페이지를 만들었습니다: ' + path.relative(ROOT, OUT) + ' (' + APP_URL + ')');
