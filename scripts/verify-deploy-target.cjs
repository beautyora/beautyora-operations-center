'use strict';

// 공개 프로젝트 식별자. 인증값이 아니며 실제 Secret 값은 출력하지 않는다.
const EXPECTED_PRODUCTION_SCRIPT_ID = '1npgGPeWwkUxCijrHFvDdG3RMTyUvz2kdv6tLoS1qDi4UntXgLSNfnVTS';

function verifyDeployTarget(env) {
  if (!['test', 'production'].includes(env.TARGET)) throw new Error('배포 대상이 올바르지 않습니다.');
  if (env.TARGET === 'production' && env.PROD_SCRIPT_ID !== EXPECTED_PRODUCTION_SCRIPT_ID) {
    throw new Error('운영 프로젝트 불일치 또는 미설정: 코드 반영을 중단합니다. Secret 값은 출력하지 않습니다.');
  }
  return env.TARGET === 'production' ? '운영 프로젝트 확인: 일치' : '테스트 환경 선택';
}

if (require.main === module) {
  try { console.log(verifyDeployTarget(process.env)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyDeployTarget, EXPECTED_PRODUCTION_SCRIPT_ID };
