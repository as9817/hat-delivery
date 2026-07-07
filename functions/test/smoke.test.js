'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ── firebase.json ────────────────────────────────────────
describe('firebase.json', () => {
  let config;
  it('유효한 JSON', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8');
    config = JSON.parse(raw);
    assert.ok(config);
  });
  it('hosting / functions / database 필드 존재', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8');
    const c = JSON.parse(raw);
    assert.ok(c.hosting,  'hosting 없음');
    assert.ok(c.functions,'functions 없음');
    assert.ok(c.database, 'database 없음');
  });
  it('node_modules가 hosting ignore에 포함', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8');
    const c = JSON.parse(raw);
    const ignore = c.hosting.ignore || [];
    assert.ok(ignore.some(i => i.includes('node_modules')), 'node_modules ignore 없음');
  });
  it('functions 소스 디렉터리가 실제 존재', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8');
    const c = JSON.parse(raw);
    const src = c.functions?.source || 'functions';
    assert.ok(fs.existsSync(path.join(ROOT, src)), `${src} 폴더 없음`);
  });
});

// ── index.js exports ─────────────────────────────────────
describe('functions/index.js exports', () => {
  it('필수 엔드포인트 6개 모두 exports', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    const required = [
      'processReceipt',
      'receiveOrder',
      'geocodeAddress',
      'reverseGeocode',
      'kakaoWaypoints',
      'issueDriverToken',
    ];
    required.forEach(fn => {
      assert.ok(src.includes(`exports.${fn}`), `exports.${fn} 없음`);
    });
  });

  it('lib/utils require 구문 존재', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    assert.ok(src.includes("require('./lib/utils')"), 'lib/utils require 없음');
  });
});

// ── saas/app.html ─────────────────────────────────────────
describe('saas/app.html', () => {
  it('파일 존재', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'saas', 'app.html')));
  });
  it('Firebase SDK 참조 포함', () => {
    const src = fs.readFileSync(path.join(ROOT, 'saas', 'app.html'), 'utf8');
    assert.ok(src.includes('firebase'), 'Firebase SDK 없음');
  });
  // APP_VERSION 업데이트 배너는 driver.html 전용 설계(CLAUDE.md 참고)라
  // app.html에는 애초에 존재하지 않음 — 기존 테스트의 잘못된 가정이라 제거함.
  it('onAuthStateChanged 포함', () => {
    const src = fs.readFileSync(path.join(ROOT, 'saas', 'app.html'), 'utf8');
    assert.ok(src.includes('onAuthStateChanged'), 'onAuthStateChanged 없음');
  });
});

// ── saas/driver.html ──────────────────────────────────────
describe('saas/driver.html', () => {
  it('파일 존재', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'saas', 'driver.html')));
  });
  it('Firebase SDK 참조 포함', () => {
    const src = fs.readFileSync(path.join(ROOT, 'saas', 'driver.html'), 'utf8');
    assert.ok(src.includes('firebase'), 'Firebase SDK 없음');
  });
  it('APP_VERSION 상수 포함', () => {
    const src = fs.readFileSync(path.join(ROOT, 'saas', 'driver.html'), 'utf8');
    assert.ok(src.includes('APP_VERSION'), 'APP_VERSION 없음');
  });
  it('update-banner 엘리먼트 포함', () => {
    const src = fs.readFileSync(path.join(ROOT, 'saas', 'driver.html'), 'utf8');
    assert.ok(src.includes('update-banner'), 'update-banner 없음');
  });
});

// ── database.rules.json ───────────────────────────────────
// SEC-001 이후 규칙은 단순 'auth != null' 문자열이 아니라 테넌트 스코핑을
// 포함한 조건식으로 바뀜(699ff4c). 정확한 문자열을 고정하면 다음 정당한
// 규칙 개선 때 또 stale해지므로, "무조건 공개(true)인 경로가 없는지"와
// "테넌트 격리 조건이 실제로 존재하는지" 두 가지 불변식만 확인한다.
describe('database.rules.json', () => {
  function assertNoUnconditionalPublic(node, pathStr) {
    if (!node || typeof node !== 'object') return;
    assert.notEqual(node['.read'], true, `${pathStr}.read 가 무조건 공개(true)임`);
    assert.notEqual(node['.write'], true, `${pathStr}.write 가 무조건 공개(true)임`);
    for (const key of Object.keys(node)) {
      if (key === '.read' || key === '.write') continue;
      assertNoUnconditionalPublic(node[key], `${pathStr}/${key}`);
    }
  }

  it('superadmins/system_logs/tenant_meta/users/tenants 어디에도 무조건 공개 경로가 없음', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8');
    const r = JSON.parse(raw).rules;
    ['superadmins', 'system_logs', 'tenant_meta', 'users', 'tenants'].forEach(key => {
      assertNoUnconditionalPublic(r[key], key);
    });
  });

  it('tenants/$tenantId 규칙에 SEC-001 테넌트 스코핑 조건이 존재 (회귀 방지)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8');
    const r = JSON.parse(raw).rules;
    const tenantRule = r.tenants?.['$tenantId'];
    assert.ok(tenantRule, 'tenants/$tenantId 규칙 없음');
    assert.ok(tenantRule['.read']?.includes('auth'), 'tenants read에 auth 조건 없음');
    assert.ok(tenantRule['.read']?.includes('tenantId'), 'tenants read에 tenantId 스코핑 없음 (SEC-001 회귀)');
    assert.ok(tenantRule['.write']?.includes('tenantId'), 'tenants write에 tenantId 스코핑 없음 (SEC-001 회귀)');
  });

  it('settings.write 는 false (읽기 전용)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8');
    const rules = JSON.parse(raw);
    assert.equal(rules.rules?.settings?.['.write'], false);
  });
});

// ── processReceipt PII 로그 노출 방지 (정적 검사) ──────────
// Vision 원문/Gemini 파싱 결과/학습주소 키/주소 등을 logger.info로 그대로
// 남기던 걸 마스킹으로 바꾼 회귀 방지 테스트. 코드 실행 없이 소스 문자열
// 패턴만 확인하므로 실제 고객 데이터는 전혀 다루지 않는다.
describe('processReceipt PII 로그 노출 방지 (정적 검사)', () => {
  it('functions/index.js: Vision 원문/Gemini 파싱 결과를 그대로 로그에 남기지 않음', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    assert.ok(!src.includes("logger.info('[DEBUG] Vision rawText:', JSON.stringify(rawText))"), 'Vision 원문이 그대로 로그에 남음');
    assert.ok(!src.includes("logger.info('[DEBUG] preprocessed rawText:', JSON.stringify(rawText))"), '전처리된 원문이 그대로 로그에 남음');
    assert.ok(!src.includes("logger.info('[DEBUG] Gemini parsed:', JSON.stringify(parsed))"), 'Gemini 파싱 결과 원문이 그대로 로그에 남음');
  });

  it('functions/index.js: 학습주소 적용 로그에 learnKey/road_address 원문을 직접 넘기지 않음', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    assert.ok(!src.includes("logger.info('학습주소 적용:', learnKey, learnedLocation.road_address"), '학습주소 적용 로그에 learnKey/road_address 원문이 그대로 남음');
  });

  it('functions/index.js: maskForLog 헬퍼를 실제로 사용함 (로그 마스킹 적용 확인)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    const count = (src.match(/maskForLog\(/g) || []).length;
    assert.ok(count >= 8, `maskForLog 사용 횟수가 예상보다 적음 (count=${count})`);
  });

  it('functions/lib/receipt-utils.js: kakaoAddrSearch/kakaoKeywordSearch가 주소/건물명 원문을 로그에 남기지 않음', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'lib', 'receipt-utils.js'), 'utf8');
    assert.ok(!src.includes('d.road_address?.address_name || d.address?.address_name}(${km}km)'), 'kakaoAddrSearch 거리순 로그에 주소 원문이 남음');
    assert.ok(!src.includes("'kakaoKeywordSearch 선택:', bestDoc.place_name"), 'kakaoKeywordSearch 로그에 place_name 원문이 남음');
    assert.ok(src.includes('function maskForLog'), 'maskForLog 헬퍼가 정의되어 있지 않음');
  });
});
