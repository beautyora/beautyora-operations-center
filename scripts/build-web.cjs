'use strict';
/**
 * Apps Script 화면을 뷰티오라 주소(Cloudflare Pages 또는 Netlify)에 올릴 정적 페이지로 만든다.
 * - partner: 브랜드 상품등록센터(partner.beautyora.kr). 링크 토큰으로 확인.
 * - admin:   운영센터(ops.beautyora.kr). Google 로그인으로 확인(BO_GOOGLE_CLIENT_ID 필요).
 * 화면(src/Index.html + Common + Partner/Admin)은 그대로 쓰고, 서버 호출만 google.script.run 대신
 * 소유자 권한 웹앱의 doPost로 보낸다.
 *
 * 사용: node scripts/build-web.cjs <partner|admin> [출력 폴더]
 *   BO_API_URL=https://script.google.com/macros/s/<배포 ID>/exec  (선택, 예전 이름 BO_PARTNER_API_URL)
 *   BO_GOOGLE_CLIENT_ID=<…>.apps.googleusercontent.com          (admin 필수)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const VIEW = process.argv[2];
if (VIEW !== 'partner' && VIEW !== 'admin') {
  console.error('사용: node scripts/build-web.cjs <partner|admin> [출력 폴더]');
  process.exit(1);
}
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'dist', VIEW === 'admin' ? 'ops' : 'partner'));

// 소유자 권한·모든 사용자 접근 웹앱(브랜드용 배포). 공개 배포 ID이며 비밀값이 아니다.
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbwWlj4WX95rewTS0gGKL2ne_qQErbrNB-9tR-pTPoy4oyZEIE4EW3BuZSQa3gMfbNOc/exec';
const API_URL = String(process.env.BO_API_URL || process.env.BO_PARTNER_API_URL || DEFAULT_API_URL).trim();
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(API_URL)) {
  console.error('BO_API_URL 형식이 올바르지 않습니다: ' + API_URL);
  process.exit(1);
}
// Google 로그인 클라이언트 ID는 공개값이다(비밀값 아님). 서버의 BO_GOOGLE_CLIENT_ID와 같아야 한다.
const CLIENT_ID = String(process.env.BO_GOOGLE_CLIENT_ID || '').trim();
if (VIEW === 'admin' && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID)) {
  console.error('운영센터 페이지에는 BO_GOOGLE_CLIENT_ID(…apps.googleusercontent.com)가 필요합니다. 지금 값: ' + (CLIENT_ID || '(없음)'));
  process.exit(1);
}
const TITLE = VIEW === 'admin' ? '뷰티오라 운영센터' : '뷰티오라 상품등록센터';
// 브랜드 화면은 주소에 링크 토큰이 있으므로 리퍼러를 아예 보내지 않는다.
// 운영센터는 Google 로그인 버튼이 출처(origin)를 확인하므로 출처만 보낸다(경로·쿼리는 보내지 않음).
const REFERRER = VIEW === 'admin' ? 'strict-origin' : 'no-referrer';

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
let html = render(read('Index.html'), { view: VIEW, token: '', version });

const head = [
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="' + REFERRER + '">',
  '<meta name="description" content="' + (VIEW === 'admin' ? '뷰티오라 내부 운영센터' : '뷰티오라 입점 브랜드 전용 상품등록센터') + '">',
  '<title>' + TITLE + '</title>',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'
].join('\n  ');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  ' + head);
html = html.replace('<body ', '<body data-api="' + esc(API_URL) + '" ' + (VIEW === 'admin' ? 'data-client-id="' + esc(CLIENT_ID) + '" ' : ''));
if (html.indexOf('data-api=') < 0 || html.indexOf('<title>') < 0) throw new Error('Index.html 구조가 바뀌어 페이지를 만들 수 없습니다.');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111"/><text x="32" y="43" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">B</text></svg>');
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
// Netlify와 Cloudflare Pages가 똑같이 읽는 헤더 파일.
fs.writeFileSync(path.join(OUT, '_headers'), [
  '/*',
  '  Referrer-Policy: ' + REFERRER,
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '  X-Robots-Tag: noindex, nofollow',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
  '  Cache-Control: no-cache',
  ''
].join('\n'));
console.log(TITLE + ' 페이지를 만들었습니다: ' + path.relative(ROOT, OUT) + ' (API ' + API_URL + ')');
