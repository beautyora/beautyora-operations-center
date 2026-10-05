'use strict';
/**
 * ops.beautyora.kr(Cloudflare Pages "beautyora-ops")에 올릴 운영센터 페이지를 만든다.
 * 화면(src/Index.html + Styles + Common + Admin)을 그대로 정적 페이지로 만들고,
 * 서버 호출은 Apps Script 웹앱(소유자 권한·익명 접근)의 doPost로 보낸다.
 * 로그인은 Google Identity Services로 하고, 서버가 요청마다 ID 토큰을 Google에 확인한 뒤 운영진 목록과 비교한다.
 * (iframe으로 웹앱을 띄우지 않는다: Google 로그인 화면이 iframe 안에서 막혀 첫 화면이 깨지던 문제)
 *
 * 사용: node scripts/build-web.cjs admin [출력 폴더]
 *   BO_OPS_APP_URL=https://script.google.com/macros/s/<운영센터 배포 ID>/exec  (선택)
 *   BO_GOOGLE_CLIENT_ID=<…>.apps.googleusercontent.com  (선택, 공개값. 없으면 화면이 서버의 BO_GOOGLE_CLIENT_ID를 받아 쓴다)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
if (process.argv[2] !== 'admin') {
  console.error('사용: node scripts/build-web.cjs admin [출력 폴더]');
  process.exit(1);
}
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'ops'));

// 운영센터 운영 배포. 공개 배포 ID이며 비밀값이 아니다.
const DEFAULT_APP_URL = 'https://script.google.com/macros/s/AKfycbwru7mqa1KHPZvQKahlAooFqtM7gjqxnJLaOq8oK5QqStv-X8B4sPo6cveo7HBEfHnM/exec';
const APP_URL = String(process.env.BO_OPS_APP_URL || DEFAULT_APP_URL).trim();
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(APP_URL)) {
  console.error('BO_OPS_APP_URL 형식이 올바르지 않습니다: ' + APP_URL);
  process.exit(1);
}
// Google 로그인 클라이언트 ID는 공개값이다(비밀값 아님). 서버의 BO_GOOGLE_CLIENT_ID와 같아야 한다.
const CLIENT_ID = String(process.env.BO_GOOGLE_CLIENT_ID || '').trim();
if (CLIENT_ID && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID)) {
  console.error('BO_GOOGLE_CLIENT_ID 형식이 올바르지 않습니다: ' + CLIENT_ID);
  process.exit(1);
}

const read = (name) => fs.readFileSync(path.join(SRC, name), 'utf8');
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Apps Script HtmlTemplate과 같은 규칙: <?= ?> 이스케이프, <?!= ?> 그대로, <? ?> 코드. */
function render(source, data) {
  let js = 'var __o="";with(__data){';
  let last = 0;
  const re = /<\?(!?=)?([\s\S]*?)\?>/g;
  let m;
  while ((m = re.exec(source))) {
    js += '__o+=' + JSON.stringify(source.slice(last, m.index)) + ';';
    const expr = m[2].trim().replace(/;$/, '');
    if (m[1] === '=') js += '__o+=__esc(' + expr + ');';
    else if (m[1] === '!=') js += '__o+=(' + expr + ');';
    else js += m[2];
    last = re.lastIndex;
  }
  js += '__o+=' + JSON.stringify(source.slice(last)) + ';}return __o;';
  return new Function('__data', '__esc', 'include_', js)(data, esc, (name) => read(name + '.html'));
}

const version = (read('00_Config.gs').match(/VERSION:\s*'([^']+)'/) || [])[1] || '';
let html = render(read('Index.html'), { version, apiUrl: APP_URL, clientId: CLIENT_ID });
const head = [
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  // Google 로그인 버튼이 출처(origin)를 확인하므로 출처만 보낸다(경로·쿼리는 보내지 않음).
  '<meta name="referrer" content="strict-origin">',
  '<title>뷰티오라 운영센터</title>',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'
].join('\n  ');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  ' + head);
if (html.indexOf('data-api="' + esc(APP_URL) + '"') < 0 || html.indexOf('<title>') < 0) throw new Error('Index.html 구조가 바뀌어 페이지를 만들 수 없습니다.');

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
  // Google 로그인(FedCM/팝업)이 동작하도록 팝업과의 연결은 허용한다.
  '  Cross-Origin-Opener-Policy: same-origin-allow-popups',
  '  Cache-Control: no-cache',
  ''
].join('\n'));
console.log('운영센터 페이지를 만들었습니다: ' + path.relative(ROOT, OUT) + ' (' + APP_URL + (CLIENT_ID ? ', 로그인 클라이언트 ID 포함' : ', 로그인 클라이언트 ID는 서버에서 받음') + ')');
