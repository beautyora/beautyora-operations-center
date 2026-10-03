'use strict';
// 예전 이름. Cloudflare Pages 빌드 명령(node scripts/build-partner-web.cjs dist/partner)이 이 파일을 부른다.
process.argv.splice(2, 0, 'partner');
require('./build-web.cjs');
