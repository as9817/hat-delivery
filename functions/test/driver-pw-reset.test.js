'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const src = fs.readFileSync(INDEX_PATH, 'utf8');

function extractBetween(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('start marker not found: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('end marker not found: ' + endMarker);
  return src.slice(s, e + endMarker.length);
}

const constsBlock = extractBetween(
  'const DRIVER_PW_RESET_MAX_ATTEMPTS',
  "const DRIVER_PW_RESET_GENERIC_FAIL = '입력하신 정보와 일치하는 계정을 찾을 수 없습니다';"
);
const logFnBlock = extractBetween('async function logDriverPwResetAttempt', '\n}\n');

const handlerStart = src.indexOf('exports.resetDriverPassword');
const bodyStart = src.indexOf('async (req, res) => {', handlerStart);
let i = src.indexOf('{', bodyStart);
let depth = 1, j = i + 1;
while (depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
const handlerBody = src.slice(i, j);

function makeMockDb(initialDriver, tenantId = 'testmart', driverId = 'drv1') {
  const key = `tenants/${tenantId}/driverAccounts/${driverId}`;
  const store = { [key]: initialDriver };
  const auditLog = [];
  return {
    ref(p) {
      return {
        async once() { return { val: () => store[p] }; },
        async update(patch) { store[p] = Object.assign({}, store[p], patch); },
        async push(entry) { if (p === 'system_logs/driverPwReset') auditLog.push(entry); },
      };
    },
    _store: store,
    _key: key,
    _auditLog: auditLog,
  };
}

async function runHandler({ tenantId, driverId, phone }, mockDb) {
  const req = { method: 'POST', body: { tenantId, driverId, phone } };
  const resData = { statusCode: null, body: null };
  const res = {
    set() { return this; },
    status(code) { resData.statusCode = code; return this; },
    json(obj) { resData.body = obj; return this; },
    send() { return this; },
  };
  const fn = new Function('db', 'bcrypt', 'crypto', 'logger', 'req', 'res',
    constsBlock + '\n' + logFnBlock + '\n' + 'return (async () => ' + handlerBody + ')();'
  );
  const logger = { error: () => {}, info: () => {}, warn: () => {} };
  await fn(mockDb, bcrypt, crypto, logger, req, res);
  return resData;
}

describe('resetDriverPassword (functions/index.js 실제 소스 추출 검증)', () => {
  it('존재하지 않는 계정 → 401, 일반 실패 메시지', async () => {
    const mockDb = makeMockDb(null);
    const r = await runHandler({ tenantId: 'testmart', driverId: 'drv1', phone: '01000001111' }, mockDb);
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.message, '입력하신 정보와 일치하는 계정을 찾을 수 없습니다');
  });

  it('비활성 계정 → 401, 존재하지 않는 계정과 동일한 메시지(계정 존재 유추 방지)', async () => {
    const hash = await bcrypt.hash('원래비번', 10);
    const mockDb = makeMockDb({ name: '기사A', phone: '01011112222', password: hash, active: false });
    const r = await runHandler({ tenantId: 'testmart', driverId: 'drv1', phone: '01011112222' }, mockDb);
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.message, '입력하신 정보와 일치하는 계정을 찾을 수 없습니다');
  });

  it('전화번호 불일치 → 401, 동일한 일반 메시지 + 실패 카운트 증가', async () => {
    const hash = await bcrypt.hash('원래비번', 10);
    const mockDb = makeMockDb({ name: '기사A', phone: '01011112222', password: hash, active: true });
    const r = await runHandler({ tenantId: 'testmart', driverId: 'drv1', phone: '01099998888' }, mockDb);
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.message, '입력하신 정보와 일치하는 계정을 찾을 수 없습니다');
    assert.equal(mockDb._store[mockDb._key].pwResetAttempts, 1);
  });

  it('정상 재설정 → 200, bcrypt 해시 저장(평문 아님), mustChangePassword=true, 카운터 초기화', async () => {
    const hash = await bcrypt.hash('원래비번', 10);
    const mockDb = makeMockDb({ name: '기사A', phone: '01011112222', password: hash, active: true });
    const r = await runHandler({ tenantId: 'testmart', driverId: 'drv1', phone: '01011112222' }, mockDb);
    const rec = mockDb._store[mockDb._key];
    assert.equal(r.statusCode, 200);
    assert.equal(String(r.body.tempPassword).length, 6);
    assert.equal(rec.mustChangePassword, true);
    assert.equal(rec.pwResetAttempts, 0);
    assert.ok(rec.password.startsWith('$2'), '저장된 password가 bcrypt 해시 형식이 아님');
    assert.ok(await bcrypt.compare(r.body.tempPassword, rec.password), '응답 tempPassword가 저장된 해시와 불일치');
  });

  it('레이트리밋: 동일 계정 5회 실패 후 6번째 시도는 429', async () => {
    const hash = await bcrypt.hash('원래비번', 10);
    const mockDb = makeMockDb({ name: '기사A', phone: '01011112222', password: hash, active: true });
    let last;
    for (let n = 1; n <= 6; n++) {
      last = await runHandler({ tenantId: 'testmart', driverId: 'drv1', phone: '01000000000' }, mockDb);
    }
    assert.equal(last.statusCode, 429);
  });

  it('레이트리밋 윈도우 만료 후에는 카운터가 리셋되어 재시도 가능', async () => {
    const hash = await bcrypt.hash('원래비번', 10);
    const mockDb = makeMockDb({
      name: '기사A', phone: '01011112222', password: hash, active: true,
      pwResetAttempts: 5, pwResetWindowStart: Date.now() - (2 * 60 * 60 * 1000),
    });
    const r = await runHandler({ tenantId: 'testmart', driverId: 'drv1', phone: '01011112222' }, mockDb);
    assert.equal(r.statusCode, 200);
  });

  it('감사 로그에는 timestamp/tenantId/driverId/success/reason만 기록, 전화번호·임시비밀번호·해시 미포함', async () => {
    const hash = await bcrypt.hash('원래비번', 10);
    const mockDb = makeMockDb({ name: '기사A', phone: '01011112222', password: hash, active: true });
    await runHandler({ tenantId: 'testmart', driverId: 'drv1', phone: '01011112222' }, mockDb);
    const entry = mockDb._auditLog[0];
    assert.deepEqual(Object.keys(entry).sort(), ['driverId', 'reason', 'success', 'tenantId', 'timestamp'].sort());
    assert.ok(!JSON.stringify(entry).includes('01011112222'), '감사 로그에 전화번호가 포함됨');
  });

  it('issueDriverToken 응답에 mustChangePassword 필드가 포함됨 (소스 정적 확인)', () => {
    assert.match(src, /mustChangePassword: driver\.mustChangePassword === true/);
  });
});
