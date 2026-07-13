'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { kakaoAddrSearch, kakaoKeywordSearch, resolveLearnKey, scoreKakaoKeywordCandidate } = require('../lib/receipt-utils');

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
    assert.equal(result.confidence, 'high', '도로명/지번 직접검색은 신뢰도 high여야 함');
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

  it('confidence는 항상 low(도로명/지번 직접검색이 아니므로 신뢰도 낮음으로 분류)', async () => {
    mockFetchOnce({ documents: [CORRECT_PLACE] });
    const result = await kakaoKeywordSearch('가상마을 대광로제비앙', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result.confidence, 'low');
  });

  it('candidates에 place_name 포함 최대 3개, 점수순 정렬(저신뢰 후보 선택 UX용)', async () => {
    const p1 = { place_name: '무관후보1', road_address_name: '가상로1길 1', x: '127.10', y: '37.70' };
    const p2 = { place_name: '가상마을대광로제비앙포레스트아파트', road_address_name: '가상로1길 10', x: '127.0588', y: '37.7475' }; // 최고점
    const p3 = { place_name: '무관후보3', road_address_name: '가상로1길 3', x: '127.30', y: '37.30' };
    const p4 = { place_name: '무관후보4', road_address_name: '가상로1길 4', x: '127.40', y: '37.40' };
    mockFetchOnce({ documents: [p1, p2, p3, p4] });
    const result = await kakaoKeywordSearch('가상마을 대광로제비앙', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result.candidates.length, 3, `5개 중 최대 3개만 반환해야 함: ${JSON.stringify(result.candidates)}`);
    assert.equal(result.candidates[0].place_name, '가상마을대광로제비앙포레스트아파트', '최고점 후보가 1번째여야 함');
    assert.ok('road_address' in result.candidates[0] && 'lat' in result.candidates[0] && 'lng' in result.candidates[0], 'candidates 항목에 road_address/lat/lng 있어야 함');
  });

  it('후보가 3개 미만이면 있는 만큼만 반환', async () => {
    mockFetchOnce({ documents: [CORRECT_PLACE, WRONG_PLACE] });
    const result = await kakaoKeywordSearch('가상마을 대광로제비앙', 'fake-key', MART_LAT, MART_LNG, 5);
    assert.equal(result.candidates.length, 2);
  });
});

describe('scoreKakaoKeywordCandidate (카테고리 가점/감점 순수함수)', () => {
  it('주거시설 카테고리는 가점, 부동산서비스/입출구 카테고리는 감점', () => {
    const apt = scoreKakaoKeywordCandidate('가상단지', { place_name: '가상단지아파트', category_name: '부동산 > 주거시설 > 아파트' }, 3.7);
    const salesOffice = scoreKakaoKeywordCandidate('가상단지', { place_name: '가상단지 분양홍보관', category_name: '부동산 > 부동산서비스 > 분양사무소' }, 2.3);
    // 토큰매치 동일(둘 다 쿼리 포함), 분양홍보관이 1.4km 더 가까워도 카테고리 보정으로 아파트가 더 높아야 함
    assert.ok(apt > salesOffice, `카테고리 보정이 거리 차이를 못 이김: apt=${apt}, salesOffice=${salesOffice}`);
  });

  it('category_name이 없으면 조정 없이 토큰매치+거리만 반영', () => {
    const withCategory = scoreKakaoKeywordCandidate('가상단지', { place_name: '가상단지아파트', category_name: '부동산 > 주거시설 > 아파트' }, 1);
    const noCategory = scoreKakaoKeywordCandidate('가상단지', { place_name: '가상단지아파트' }, 1);
    assert.ok(withCategory > noCategory, '카테고리 정보가 있을 때 가점이 반영되지 않음');
  });

  it('거리 페널티가 완화되어, 근소한 거리 차이만으로는 순위가 안 뒤집힘(카테고리 동일할 때)', () => {
    const near = scoreKakaoKeywordCandidate('가상단지', { place_name: '가상단지아파트' }, 2.3);
    const far  = scoreKakaoKeywordCandidate('가상단지', { place_name: '가상단지아파트' }, 3.7);
    // 카테고리가 같으면 여전히 가까운 쪽이 근소 우위 — 페널티 자체가 없어진 건 아님
    assert.ok(near > far, '거리 페널티가 완전히 사라짐(방향성 자체가 깨짐)');
    assert.ok(near - far < 2, `거리 페널티가 여전히 과도하게 큼: 차이=${near - far}`);
  });
});

describe('탑석자이 실사고 회귀 재현 (2026-07-13, 실측 카카오 응답 기반 — 공개 장소명/도로명만 사용)', () => {
  // 실제 라이브 카카오 keyword API를 "탑석 자이" 쿼리 + 와마트 민락(공개 사업장) 좌표로
  // 직접 호출해 확보한 5개 후보를 그대로 재현. 실제 고객 정보 없음(장소명/도로명은
  // 카카오맵에 등록된 공개 정보). 마트 좌표도 이 테넌트의 공개 사업장 주소.
  const MART_LAT = 37.7501140454422;
  const MART_LNG = 127.120088494083;
  const MART_RADIUS = 5;
  const REAL_CANDIDATES = [
    { place_name: '탑석센트럴자이 분양홍보관', road_address_name: '경기 의정부시 용민로 198', address_name: '경기 의정부시 민락동 806', category_name: '부동산 > 부동산서비스 > 분양사무소', x: '127.09398378505', y: '37.7461652044663' },
    { place_name: '탑석센트럴자이아파트', road_address_name: '경기 의정부시 용민로 10', address_name: '경기 의정부시 용현동 567', category_name: '부동산 > 주거시설 > 아파트', x: '127.08264883554395', y: '37.73393403167369' },
    { place_name: '탑석센트럴자이아파트 게이트2', road_address_name: '', address_name: '경기 의정부시 용현동 217-22', category_name: '교통,수송 > 입출구', x: '127.08272223034', y: '37.732605049176' },
    { place_name: '탑석자이 원탑부동산', road_address_name: '경기 의정부시 용민로 18', address_name: '경기 의정부시 용현동 264-10', category_name: '부동산 > 부동산서비스 > 부동산중개업', x: '127.08115886005983', y: '37.73456124108037' },
    { place_name: '탑석센트럴자이아파트 게이트1', road_address_name: '경기 의정부시 용민로 10', address_name: '경기 의정부시 용현동 567', category_name: '교통,수송 > 입출구', x: '127.08040203651464', y: '37.73442931711796' },
  ];

  it('수정 전 채점식이었다면 분양홍보관(오답)이 선택됐을 것을 재확인(회귀 기준선)', () => {
    // 실사고 당시 점수식: matchCount*100 - dist(가중치 없음). 카테고리 보정 없이 순수 거리로만 계산.
    const scores = REAL_CANDIDATES.map(doc => {
      const matchCount = 2; // 실사고 로그: 두 후보 모두 "탑석"/"자이" 토큰 매치
      const dist = require('../lib/utils').haversineKm(MART_LAT, MART_LNG, parseFloat(doc.y), parseFloat(doc.x));
      return { place_name: doc.place_name, score: matchCount * 100 - dist };
    });
    const winner = scores.reduce((a, b) => (b.score > a.score ? b : a));
    assert.equal(winner.place_name, '탑석센트럴자이 분양홍보관', '회귀 기준선 자체가 틀림 — 실사고 재현 실패');
  });

  it('수정된 kakaoKeywordSearch는 분양홍보관이 아니라 실제 아파트(용민로 10)를 선택한다', async () => {
    mockFetchOnce({ documents: REAL_CANDIDATES });
    const result = await kakaoKeywordSearch('탑석 자이', 'fake-key', MART_LAT, MART_LNG, MART_RADIUS);
    assert.equal(result.road_address, '경기 의정부시 용민로 10', `여전히 잘못된 후보가 선택됨: ${JSON.stringify(result)}`);
  });

  it('거리가 더 가까운 게이트/중개업소가 아니라 아파트 카테고리가 우선된다', async () => {
    mockFetchOnce({ documents: REAL_CANDIDATES });
    const result = await kakaoKeywordSearch('탑석 자이', 'fake-key', MART_LAT, MART_LNG, MART_RADIUS);
    // 용민로 10은 게이트1(교통,수송>입출구)의 road_address_name과 우연히 동일하므로,
    // lat/lng까지 아파트 후보(37.73393403167369, 127.08264883554395)와 일치하는지 확인
    assert.equal(result.lat, 37.73393403167369);
    assert.equal(result.lng, 127.08264883554395);
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
