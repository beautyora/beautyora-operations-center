'use strict';
/**
 * 브랜드 상품등록센터를 Netlify(partner.beautyora.kr)에 올릴 정적 페이지로 만든다.
 * Apps Script와 같은 화면(src/Index.html + Common + Partner)을 그대로 쓰고,
 * 서버 호출만 google.script.run 대신 브랜드용 웹앱(doPost)으로 보낸다.
 *
 * 사용: BO_PARTNER_API_URL=https://script.google.com/macros/s/<브랜드용 배포 ID>/exec \
 *       node scripts/build-partner-web.cjs [출력 폴더]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'partner'));

// 브랜드용 웹앱(소유자 권한 실행, 모든 사용자 접근). 공개 배포 ID이며 비밀값이 아니다.
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbwWlj4WX95rewTS0gGKL2ne_qQErbrNB-9tR-pTPoy4oyZEIE4EW3BuZSQa3gMfbNOc/exec';
const API_URL = String(process.env.BO_PARTNER_API_URL || DEFAULT_API_URL).trim();
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(API_URL)) {
  console.error('BO_PARTNER_API_URL 형식이 올바르지 않습니다: ' + API_URL);
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
let html = render(read('Index.html'), { view: 'partner', token: '', version });

const head = [
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="no-referrer">',
  '<meta name="description" content="뷰티오라 입점 브랜드 전용 상품등록센터">',
  '<title>뷰티오라 상품등록센터</title>',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'
].join('\n  ');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  ' + head);
html = html.replace('<body ', '<body data-api="' + esc(API_URL) + '" ');
if (html.indexOf('data-api=') < 0 || html.indexOf('<title>') < 0) throw new Error('Index.html 구조가 바뀌어 페이지를 만들 수 없습니다.');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111"/><text x="32" y="43" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">B</text></svg>');
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log('상품등록센터 페이지를 만들었습니다: ' + path.relative(ROOT, OUT) + ' (API ' + API_URL + ')');
