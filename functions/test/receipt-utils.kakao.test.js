'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { kakaoAddrSearch, kakaoKeywordSearch, resolveLearnKey } = require('../lib/receipt-utils');

// 실제 Kakao API는 호출하지 않습니다 — global.fetch를 모킹해서 사용합니다.
// 아래 좌표/주소는 전부 합성 데이터이며 실제 고객 정보가 아닙니다.

let originalFetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; });

function mockFetchOnce(jsonBody, ok = true) {
  global.fetch = async () => ({
    ok,
    json: async () => jsonBody,
  });
}

// 마트 좌표 (가상 기준점)
const MART_LAT = 37.7384;
const MART_LNG = 127.0645;

// 가상 후보: 마트 근처(약 1.2km), 마트 멀리(약 20km)
const NEAR_DOC = { road_address: { address_name: '가상로1길 10' }, address: { address_name: '가상동 10' }, x: '127.0588', y: '37.7475' };
const FAR_DOC   = { road_address: { address_name: '가상로9길 99' }, address: { address_name: '가상동 99' }, x: '127.0470', y: '37.6789' };

describe('kakaoAddrSearch (fetch mock)', () => {
  it('후보 여러 개 중 마트와 가장 가까운 후보를 선택', async () => {
    mockFetchOnce({ documents: [FAR_DOC, NEAR_DOC] }); // 일부러 먼 것을 먼저 배치
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.ok(result, '결과가 null이면 안 됨');
    assert.equal(result.road_address, '가상로1길 10', `가까운 후보(NEAR_DOC)가 선택되지 않음: ${JSON.stringify(result)}`);
  });

  it('가장 가까운 후보도 martRadius 초과면 reject(null)', async () => {
    mockFetchOnce({ documents: [FAR_DOC] }); // 약 20km, 마트 반경 5km 밖
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result, null, `반경 초과인데 reject 안 됨: ${JSON.stringify(result)}`);
  });

  it('반경 안 후보는 정상 반환', async () => {
    mockFetchOnce({ documents: [NEAR_DOC] }); // 약 1.2km, 반경 5km 이내
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.ok(result, '반경 이내인데 null 반환됨');
    assert.equal(result.road_address, '가상로1길 10');
  });

  it('martLat/martLng 없으면 거리 계산 없이 첫 번째 후보 그대로 사용', async () => {
    mockFetchOnce({ documents: [FAR_DOC, NEAR_DOC] }); // 순서상 FAR_DOC이 첫 번째
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', null, null, 5);
    assert.equal(result.road_address, '가상로9길 99', `마트 좌표 없을 때 첫 번째 후보가 아님: ${JSON.stringify(result)}`);
  });

  it('후보 0개면 null 반환', async () => {
    mockFetchOnce({ documents: [] });
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result, null);
  });

  it('documents 필드 자체가 없어도 null 반환 (방어적 처리)', async () => {
    mockFetchOnce({});
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result, null);
  });

  it('API 응답이 !ok면 null 반환', async () => {
    mockFetchOnce({ documents: [NEAR_DOC] }, false);
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result, null);
  });

  it('martRadius 미지정 시 기본값 5km 적용', async () => {
    mockFetchOnce({ documents: [FAR_DOC] }); // 20km — 기본 5km 반경 밖
    const result = await kakaoAddrSearch('가상 주소', 'fake-key', MART_LAT, MART_LNG, undefined);
    assert.equal(result, null, '기본 반경(5km)이 적용되지 않음');
  });
});

describe('kakaoKeywordSearch (fetch mock)', () => {
  const CORRECT_PLACE = { place_name: '가상마을대광로제비앙포레스트아파트', road_address_name: '가상로1길 10', address_name: '가상동 10', x: '127.0588', y: '37.7475' };
  const WRONG_PLACE   = { place_name: '대광로제비앙더퍼스트아파트', road_address_name: '가상로9길 99', address_name: '가상동 99', x: '127.0470', y: '37.6789' };

  it('토큰 매치 점수(scoreKeywordMatch)가 높은 후보를 선택', async () => {
    mockFetchOnce({ documents: [WRONG_PLACE, CORRECT_PLACE] }); // 오답을 먼저 배치
    const result = await kakaoKeywordSearch('가상마을 대광로제비앙', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result.road_address, '가상로1길 10', `토큰 매치가 높은 후보(CORRECT_PLACE)가 선택되지 않음: ${JSON.stringify(result)}`);
  });

  it('토큰 매치 동점이면 마트와 거리가 가까운 후보를 선택', async () => {
    // 두 후보 모두 place_name에 쿼리 토큰이 하나도 안 걸리게 해서 동점(0점) 유도 → 거리로만 결정
    const nearPlace = { place_name: '무관한이름1', road_address_name: '가상로1길 10', x: '127.0588', y: '37.7475' }; // 가까움
    const farPlace   = { place_name: '무관한이름2', road_address_name: '가상로9길 99', x: '127.0470', y: '37.6789' }; // 멂
    mockFetchOnce({ documents: [farPlace, nearPlace] });
    const result = await kakaoKeywordSearch('전혀다른쿼리', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result.road_address, '가상로1길 10', `동점 시 가까운 후보가 선택되지 않음: ${JSON.stringify(result)}`);
  });

  it('martLat/martLng 없으면 거리 미반영, 토큰 매치만으로 선택', async () => {
    mockFetchOnce({ documents: [WRONG_PLACE, CORRECT_PLACE] });
    const result = await kakaoKeywordSearch('가상마을 대광로제비앙', 'fake-key', null, null, 5);
    assert.equal(result.road_address, '가상로1길 10');
  });

  it('빈 쿼리 문자열이면 fetch 호출 없이 null 반환', async () => {
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ documents: [] }) }; };
    const result = await kakaoKeywordSearch('   ', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result, null);
    assert.equal(fetchCalled, false, '빈 쿼리인데 fetch가 호출됨');
  });

  it('후보 0개면 null 반환', async () => {
    mockFetchOnce({ documents: [] });
    const result = await kakaoKeywordSearch('가상 검색어', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result, null);
  });
});

describe('resolveLearnKey (학습주소 조회 키 우선순위)', () => {
  it('전화번호가 있으면 전화번호 우선', () => {
    assert.equal(resolveLearnKey('010-0000-0000', '홍길동'), '010-0000-0000');
  });
  it('전화번호 없으면 성명으로 fallback', () => {
    assert.equal(resolveLearnKey(null, '홍길동'), '홍길동');
    assert.equal(resolveLearnKey(undefined, '홍길동'), '홍길동');
    assert.equal(resolveLearnKey('', '홍길동'), '홍길동');
  });
  it('둘 다 없으면 null', () => {
    assert.equal(resolveLearnKey(null, null), null);
    assert.equal(resolveLearnKey('', ''), null);
  });
});
