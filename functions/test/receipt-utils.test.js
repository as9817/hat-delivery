'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { preprocessOcrText, parseAddressComponents, isSimilarAddress, buildLearnedLocationResponse, buildAccessInfoSuggestion, resolveLearnKey, splitDetailAndAccessInfo } = require('../lib/receipt-utils');

// 아래 테스트 데이터는 전부 합성(가상) 주소/영수증 텍스트입니다.
// 실제 고객명/전화번호/영수증 원문은 포함하지 않습니다.

describe('preprocessOcrText', () => {
  it('⓪ 하이픈 건물번호 줄바꿈 합치기', () => {
    assert.equal(preprocessOcrText('가상로210-2\n6 1층'), '가상로210-26 1층');
  });

  it('① 숫자\\n숫자 층/호 → 공백 연결', () => {
    assert.equal(preprocessOcrText('가상로123\n8 1층'), '가상로123 8 1층');
  });

  it('② 숫자\\n숫자층/호 (공백 없이 붙은 경우)', () => {
    assert.equal(preprocessOcrText('가상동 737-42\n1층'), '가상동 737-42 1층');
    assert.equal(preprocessOcrText('가상동 45-48\n1층'), '가상동 45-48 1층');
  });

  it('③ 숫자 뒤 줄바꿈 후 층/호/동 (공백 없이 붙이기)', () => {
    assert.equal(preprocessOcrText('가상동 737-42 1\n층'), '가상동 737-42 1층');
  });

  it('④ 칸 이동으로 인한 한글 단어 중간 공백 제거', () => {
    assert.equal(preprocessOcrText('수 호2동 101호'), '수호2동 101호');
  });

  it('⑤ 주소 번지 줄바꿈 합치기 (신규 케이스)', () => {
    assert.equal(preprocessOcrText('가상로12나길1\n0 가상어린이집'), '가상로12나길10 가상어린이집');
  });

  it('숫자 사이 공백은 보존 (오합치기 방지)', () => {
    // "45-4 8 가상길1층" 같은 패턴이 "45-48"로 잘못 합쳐지지 않아야 함
    const input = '가상길 45-4 8 가상로1층';
    const result = preprocessOcrText(input);
    assert.ok(!result.includes('45-48'), `잘못 합쳐짐: ${result}`);
  });

  it('여러 패턴이 한 텍스트에 섞여도 순서대로 정상 처리', () => {
    const input = '주소: 가상동 210-2\n6 1층\n성명: 홍길동';
    const result = preprocessOcrText(input);
    assert.ok(result.includes('가상동 210-26 1층'), `결과: ${result}`);
  });
});

describe('parseAddressComponents', () => {
  // 과거(WIP) 정규식 /[@A]\b/ 는 '@'가 word character가 아니라서 \b가 절대 성립하지
  // 않아 '@' 케이스가 치환되지 않는 버그가 있었음. '@'는 negative lookahead
  // ((?![A-Za-z0-9_]))로 \b와 동등한 조건을 대신 적용해 수정함.
  it('아파트 약어(@, 뒤에 공백+동호)는 정상 치환됨', () => {
    const { query, detailAddress } = parseAddressComponents('가상마을@ 101-203호');
    assert.equal(query, '가상마을아파트');
    assert.equal(detailAddress, '101동 203호');
  });

  it('아파트 약어(@, 문자열 끝)는 정상 치환됨', () => {
    const { query } = parseAddressComponents('용산@');
    assert.equal(query, '용산아파트');
  });

  it('@ 뒤에 영숫자가 바로 이어지면(예: 이메일 형태) "아파트"로 치환하지 않음', () => {
    // "101동"은 별개의 동호수 분리 로직이 detailAddress로 뽑아가므로 query에는
    // "용산@"만 남음 — 여기서 확인하려는 건 "@"가 "아파트"로 바뀌지 않았다는 것
    const { query } = parseAddressComponents('용산@101동');
    assert.equal(query, '용산@', 'A 케이스와 동일하게 뒤에 영숫자가 바로 붙으면 경계로 보지 않아야 함');
    assert.ok(!query.includes('아파트'), `@가 잘못 치환됨: ${query}`);
  });

  it('아파트 약어(A, 단독 뒤 공백/끝)는 계속 정상 치환됨', () => {
    const { query } = parseAddressComponents('가상마을A 101-203호');
    assert.equal(query, '가상마을아파트');
  });

  it('아파트 약어(APT) 정규화', () => {
    const { query } = parseAddressComponents('가상마을APT 101-203호');
    assert.equal(query, '가상마을아파트');
  });

  it('Gemini가 붙인 동 이름 접두어 제거 (지번 앞 동명)', () => {
    const { query } = parseAddressComponents('가상동 258-116');
    assert.equal(query, '258-116');
  });

  it('지번 뒤 호/층이 바로 붙으면 동 이름 접두어 유지', () => {
    // "한신1동 703호" 패턴 — 동명 제거 대상이 아님을 확인
    const { query } = parseAddressComponents('가상1동 703호');
    assert.ok(query.includes('가상1동'), `동명이 잘못 제거됨: ${query}`);
  });

  it('지하/옥상 등 위치 설명어를 세부주소로 분리', () => {
    const { query, detailAddress } = parseAddressComponents('가상로10길5 지하');
    assert.equal(query, '가상로10길5');
    assert.ok(detailAddress.includes('지하'));
  });

  it('괄호 안 세부정보 분리 (+ 이어서 동호 약식 표기도 분리되는 체이닝 동작)', () => {
    const { query, detailAddress } = parseAddressComponents('가상마을 1903-104 (현관 비밀번호 1234)');
    // 괄호 제거 후 남은 "가상마을 1903-104"에 동호 약식 분리(trailingUnitMatch)가
    // 이어서 적용되어 "1903-104"까지 동/호로 분리되는 것이 의도된 동작
    assert.equal(query, '가상마을');
    assert.ok(detailAddress.includes('1903동 104호'), `detailAddress: ${detailAddress}`);
    assert.ok(detailAddress.includes('현관 비밀번호 1234'), `detailAddress: ${detailAddress}`);
  });

  it('숫자로 끝나는 주소 뒤 건물명 분리', () => {
    const { query, detailAddress } = parseAddressComponents('가상로12나길10 가상어린이집');
    assert.equal(query, '가상로12나길10');
    assert.ok(detailAddress.includes('가상어린이집'));
  });

  it('끝에 남은 동호 약식 표기(숫자-숫자) 분리', () => {
    const { query, detailAddress } = parseAddressComponents('가상마을 1903-104');
    assert.equal(query, '가상마을');
    assert.ok(detailAddress.includes('1903동 104호'), `detailAddress: ${detailAddress}`);
  });

  it('101호/3층 같은 일반 상세주소 분리', () => {
    const { query, detailAddress } = parseAddressComponents('가상로20길8 101호');
    assert.equal(query, '가상로20길8');
    assert.equal(detailAddress, '101호');
  });

  it('상세주소 패턴 없는 순수 도로명 주소는 그대로 query로', () => {
    const { query, detailAddress } = parseAddressComponents('가상로20길8');
    assert.equal(query, '가상로20길8');
    assert.equal(detailAddress, '');
  });
});

describe('isSimilarAddress (출입정보 오적용 방지 기준)', () => {
  it('완전 동일 주소 → true', () => {
    assert.equal(isSimilarAddress('서울 용산구 가상로 100', '서울 용산구 가상로 100'), true);
  });

  it('공백/대소문자만 다른 주소 → true', () => {
    assert.equal(isSimilarAddress('서울용산구가상로100', '서울 용산구 가상로 100'), true);
  });

  it('한쪽이 다른 쪽을 포함(부분 표기 차이) → true', () => {
    assert.equal(isSimilarAddress('가상로 100', '서울 용산구 가상로 100'), true);
    assert.equal(isSimilarAddress('서울 용산구 가상로 100', '가상로 100'), true);
  });

  it('서로 다른 주소 → false', () => {
    assert.equal(isSimilarAddress('서울 용산구 가상로 100', '서울 강남구 가상로 200'), false);
  });

  it('둘 중 하나가 비어있으면 false (애매하면 미적용)', () => {
    assert.equal(isSimilarAddress('', '서울 용산구 가상로 100'), false);
    assert.equal(isSimilarAddress('서울 용산구 가상로 100', ''), false);
    assert.equal(isSimilarAddress(null, '서울 용산구 가상로 100'), false);
    assert.equal(isSimilarAddress(undefined, undefined), false);
  });
});

describe('buildLearnedLocationResponse (학습주소 응답 변환 + access_info 게이팅)', () => {
  it('학습 레코드 없음 → null', () => {
    assert.equal(buildLearnedLocationResponse('서울 용산구 가상로 100', null), null);
    assert.equal(buildLearnedLocationResponse('서울 용산구 가상로 100', undefined), null);
  });

  it('학습 레코드에 road_address 없음 → null', () => {
    assert.equal(buildLearnedLocationResponse('서울 용산구 가상로 100', { access_info: '현관 1234' }), null);
  });

  it('현재 주소와 학습 주소가 유사 → access_info 포함', () => {
    const learned = { road_address: '서울 용산구 가상로 100', detail_address: '101동 202호', access_info: '현관 104열쇠 2634종', lat: 37.5, lng: 127.0 };
    const result = buildLearnedLocationResponse('서울 용산구 가상로 100', learned);
    assert.deepEqual(result, {
      road_address: '서울 용산구 가상로 100',
      detail_address: '101동 202호',
      access_info: '현관 104열쇠 2634종',
      lat: 37.5,
      lng: 127.0,
    });
  });

  it('현재 주소와 학습 주소가 다름 → null 반환(road_address/detail_address/access_info 전부 미적용, standardizeAddress 폴백 신호)', () => {
    const learned = { road_address: '서울 용산구 가상로 100', detail_address: '101동 202호', access_info: '현관 104열쇠 2634종', lat: 37.5, lng: 127.0 };
    const result = buildLearnedLocationResponse('서울 강남구 가상로 999', learned);
    assert.equal(result, null);
  });

  it('학습 레코드에 access_info 자체가 없음 → 빈 값', () => {
    const learned = { road_address: '서울 용산구 가상로 100', detail_address: '101동 202호', lat: 37.5, lng: 127.0 };
    const result = buildLearnedLocationResponse('서울 용산구 가상로 100', learned);
    assert.equal(result.access_info, '');
  });

  it('lat/lng 없는 학습 레코드 → null로 대체', () => {
    const learned = { road_address: '서울 용산구 가상로 100' };
    const result = buildLearnedLocationResponse('서울 용산구 가상로 100', learned);
    assert.equal(result.lat, null);
    assert.equal(result.lng, null);
  });
});

// driver.html 클라이언트 저장 키가 서버 조회 키(resolveLearnKey)와 어긋나면
// access_info/detail_address를 학습해도 다시 불러오지 못하는 문제가 있었음(전화번호
// 우선 조회 vs 성명 키 저장 불일치). 아래는 그 회귀 방지 테스트 — driver.html은 이
// resolveLearnKey와 동일한 로직(phone || name || null)을 그대로 복제해서 쓰므로,
// "전화번호 키로 저장된 학습 레코드가 실제로 응답에 포함되는지"를 서버 쪽 순수
// 함수 조합으로 검증한다.
describe('학습주소 키 일치성(전화번호 우선 저장 → 조회 → access_info 응답 포함)', () => {
  it('전화번호가 있으면 phone이 조회 키 → 그 키로 저장된 레코드의 access_info가 응답에 포함됨', () => {
    const phone = '010-0000-1234';
    const name = '가상고객';
    const learnKey = resolveLearnKey(phone, name);
    assert.equal(learnKey, phone, '전화번호가 있으면 phone이 우선 키여야 함');

    // driver.html이 이 키(phone)로 저장했다고 가정한 학습 레코드
    const learnedRecordSavedUnderPhoneKey = {
      road_address: '서울 용산구 가상로 100',
      detail_address: '101동 202호',
      access_info: '현관 104열쇠 2634종',
      name, phone,
      lat: 37.5, lng: 127.0,
      updatedAt: Date.now(),
    };
    const result = buildLearnedLocationResponse('서울 용산구 가상로 100', learnedRecordSavedUnderPhoneKey);
    assert.equal(result.access_info, '현관 104열쇠 2634종');
    assert.equal(result.road_address, '서울 용산구 가상로 100');
  });

  it('전화번호가 없으면 name으로 fallback', () => {
    const name = '가상고객2';
    const learnKey = resolveLearnKey(null, name);
    assert.equal(learnKey, name);
    assert.equal(resolveLearnKey('', name), name);
    assert.equal(resolveLearnKey(undefined, name), name);
  });

  it('전화번호 키로 저장된 레코드라도 이번 영수증 주소가 다르면 null(road_address/detail_address/access_info 전부 오적용 방지)', () => {
    const phone = '010-0000-5678';
    const name = '가상고객3';
    const learnKey = resolveLearnKey(phone, name);
    const learnedRecordSavedUnderPhoneKey = {
      road_address: '서울 용산구 가상로 100',
      detail_address: '101동 202호',
      access_info: '현관 104열쇠 2634종',
      name, phone,
      lat: 37.5, lng: 127.0,
    };
    const result = buildLearnedLocationResponse('서울 강남구 다른로 999', learnedRecordSavedUnderPhoneKey);
    assert.equal(learnKey, phone);
    assert.equal(result, null);
  });

  it('전화번호가 있으면 phone이 키 → 같은 전화번호 + 같은 주소면 road_address/detail_address/access_info 전부 적용됨', () => {
    const phone = '010-0000-9012';
    const name = '가상고객4';
    const learnKey = resolveLearnKey(phone, name);
    const learned = {
      road_address: '서울 마포구 가상로 200',
      detail_address: '301동 501호',
      access_info: '공동현관 5678',
      name, phone,
      lat: 37.55, lng: 126.9,
    };
    const result = buildLearnedLocationResponse('서울 마포구 가상로 200', learned);
    assert.equal(learnKey, phone);
    assert.deepEqual(result, {
      road_address: '서울 마포구 가상로 200',
      detail_address: '301동 501호',
      access_info: '공동현관 5678',
      lat: 37.55,
      lng: 126.9,
    });
  });

  it('전화번호가 없어 name이 키가 된 경우 — 같은 이름이라도 주소가 다르면 null(road_address/detail_address/access_info 전부 미적용)', () => {
    const name = '가상고객5';
    const learnKey = resolveLearnKey(null, name);
    const learnedRecordSavedUnderNameKey = {
      road_address: '서울 종로구 가상로 300',
      detail_address: '5층',
      access_info: '경비실 호출',
      name,
      lat: 37.57, lng: 126.98,
    };
    const result = buildLearnedLocationResponse('서울 종로구 완전다른로 777', learnedRecordSavedUnderNameKey);
    assert.equal(learnKey, name);
    assert.equal(result, null, '이름이 같아도 주소가 다르면 학습값을 적용하면 안 됨');
  });

  it('주소가 유사하지 않으면(전혀 다른 주소) access_info만 따로 남지 않고 통째로 미적용됨', () => {
    const phone = '010-0000-3456';
    const learned = {
      road_address: '부산 해운대구 가상로 1',
      detail_address: '10층',
      access_info: '문 앞 호출',
      phone,
      lat: 35.16, lng: 129.16,
    };
    const result = buildLearnedLocationResponse('서울 노원구 완전다른동네 999', learned);
    assert.equal(result, null, '주소가 유사하지 않으면 access_info만 남기지 않고 전체를 미적용해야 함');
  });
});

describe('buildAccessInfoSuggestion (원칙 B — phone-key access_info 적극 활용)', () => {
  it('phone 있음 + learned.access_info 있음 → 제안값 반환(accessInfoSource=phone_history, needsConfirm=true)', () => {
    const phone = '010-0000-9001';
    const learned = { road_address: '서울 강남구 가상로 1', access_info: '공동현관 9999', phone };
    const result = buildAccessInfoSuggestion(phone, learned);
    assert.deepEqual(result, { accessInfo: '공동현관 9999', accessInfoSource: 'phone_history', accessInfoNeedsConfirm: true });
  });

  it('phone 없으면(name-key만 있는 상황) 제안하지 않음', () => {
    const learned = { road_address: '서울 강남구 가상로 1', access_info: '공동현관 9999' };
    assert.equal(buildAccessInfoSuggestion(null, learned), null);
    assert.equal(buildAccessInfoSuggestion('', learned), null);
    assert.equal(buildAccessInfoSuggestion(undefined, learned), null);
  });

  it('learned 레코드 자체가 없으면 제안하지 않음', () => {
    assert.equal(buildAccessInfoSuggestion('010-0000-9001', null), null);
    assert.equal(buildAccessInfoSuggestion('010-0000-9001', undefined), null);
  });

  it('learned.access_info가 비어있으면 제안하지 않음', () => {
    const learned = { road_address: '서울 강남구 가상로 1', access_info: '' };
    assert.equal(buildAccessInfoSuggestion('010-0000-9001', learned), null);
    const learnedNoField = { road_address: '서울 강남구 가상로 1' };
    assert.equal(buildAccessInfoSuggestion('010-0000-9001', learnedNoField), null);
  });

  it('access_info가 너무 길면(40자 초과) 방어적으로 제외', () => {
    const longText = '가'.repeat(41);
    const learned = { road_address: '서울 강남구 가상로 1', access_info: longText };
    assert.equal(buildAccessInfoSuggestion('010-0000-9001', learned), null);
  });

  it('주소 유사도와 무관하게 동작 — 주소가 다른 학습 레코드에서도 access_info만 제안', () => {
    // 이 함수 자체는 주소 비교를 하지 않음(호출부가 이미 게이트 실패를 확인한 뒤에만 호출)
    const learned = { road_address: '완전히 다른 지역 주소', access_info: '경비실 호출', phone: '010-0000-9001' };
    const result = buildAccessInfoSuggestion('010-0000-9001', learned);
    assert.equal(result.accessInfo, '경비실 호출');
  });
});

describe('splitDetailAndAccessInfo (OCR 괄호 출입정보 자동 분리)', () => {
  it('"종" 키워드 없이도 "열쇠"로 "104열쇠 2634종" 케이스가 분리됨 ("종" 단독 매칭 제거 회귀 확인)', () => {
    const result = splitDetailAndAccessInfo('101동 202호 (현관 104열쇠 2634종)');
    assert.equal(result.detailAddress, '101동 202호');
    assert.equal(result.accessInfo, '현관 104열쇠 2634종');
  });

  it('"1903동 104호 (현관 비번 1234)" → 분리됨', () => {
    const result = splitDetailAndAccessInfo('1903동 104호 (현관 비번 1234)');
    assert.equal(result.detailAddress, '1903동 104호');
    assert.equal(result.accessInfo, '현관 비번 1234');
  });

  it('"101동 202호 (공동현관 #1234)" → 분리됨', () => {
    const result = splitDetailAndAccessInfo('101동 202호 (공동현관 #1234)');
    assert.equal(result.detailAddress, '101동 202호');
    assert.equal(result.accessInfo, '공동현관 #1234');
  });

  it('"3층 (경비실 호출)" → 분리됨', () => {
    const result = splitDetailAndAccessInfo('3층 (경비실 호출)');
    assert.equal(result.detailAddress, '3층');
    assert.equal(result.accessInfo, '경비실 호출');
  });

  it('"B동 502호 (문 앞 호출)" → 분리됨', () => {
    const result = splitDetailAndAccessInfo('B동 502호 (문 앞 호출)');
    assert.equal(result.detailAddress, 'B동 502호');
    assert.equal(result.accessInfo, '문 앞 호출');
  });

  it('"1204호 (비밀번호 2580*)" → 분리됨', () => {
    const result = splitDetailAndAccessInfo('1204호 (비밀번호 2580*)');
    assert.equal(result.detailAddress, '1204호');
    assert.equal(result.accessInfo, '비밀번호 2580*');
  });

  it('괄호 없음 → accessInfo 빈 값, detailAddress 그대로', () => {
    const result = splitDetailAndAccessInfo('101동 202호');
    assert.equal(result.detailAddress, '101동 202호');
    assert.equal(result.accessInfo, '');
  });

  it('괄호 안 내용이 전부인 경우("(현관 비번 1234)") → detailAddress 빈 값, accessInfo 있음', () => {
    const result = splitDetailAndAccessInfo('(현관 비번 1234)');
    assert.equal(result.detailAddress, '');
    assert.equal(result.accessInfo, '현관 비번 1234');
  });

  it('애매한 케이스 — "상가 2층 (왼쪽 문)": 출입정보 키워드 없어 분리하지 않음(원문 그대로 유지)', () => {
    const result = splitDetailAndAccessInfo('상가 2층 (왼쪽 문)');
    assert.equal(result.detailAddress, '상가 2층 (왼쪽 문)');
    assert.equal(result.accessInfo, '');
  });

  it('빈 문자열/undefined 입력 → 둘 다 빈 값', () => {
    assert.deepEqual(splitDetailAndAccessInfo(''), { detailAddress: '', accessInfo: '' });
    assert.deepEqual(splitDetailAndAccessInfo(undefined), { detailAddress: '', accessInfo: '' });
  });
});

describe('buildLearnedLocationResponse + splitDetailAndAccessInfo 연동 (병합 규칙)', () => {
  it('학습 레코드의 detail_address에 괄호 출입정보가 남아있고 access_info가 비어있으면 분리 결과로 채움', () => {
    const learned = {
      road_address: '서울 용산구 가상로 100',
      detail_address: '1903동 104호 (현관 비번 9999)',
      lat: 37.5, lng: 127.0,
    };
    const result = buildLearnedLocationResponse('서울 용산구 가상로 100', learned);
    assert.equal(result.detail_address, '1903동 104호');
    assert.equal(result.access_info, '현관 비번 9999');
  });

  it('이미 access_info가 저장돼 있으면 detail_address 괄호 분리 결과로 덮어쓰지 않음(기존값 우선)', () => {
    const learned = {
      road_address: '서울 용산구 가상로 100',
      detail_address: '1903동 104호 (현관 비번 9999)',
      access_info: '기존에 저장된 진짜 출입정보',
      lat: 37.5, lng: 127.0,
    };
    const result = buildLearnedLocationResponse('서울 용산구 가상로 100', learned);
    assert.equal(result.detail_address, '1903동 104호', 'detail_address는 항상 분리됨');
    assert.equal(result.access_info, '기존에 저장된 진짜 출입정보', '기존 access_info가 우선');
  });

  it('주소가 다르면(오적용 방지 게이트) null 반환 — 괄호에서 분리됐을 detail_address/accessInfo도 통째로 미적용', () => {
    const learned = {
      road_address: '서울 용산구 가상로 100',
      detail_address: '1903동 104호 (현관 비번 9999)',
      lat: 37.5, lng: 127.0,
    };
    const result = buildLearnedLocationResponse('서울 강남구 다른로 999', learned);
    assert.equal(result, null, '주소 불일치 시 road_address/detail_address/access_info 전부 미적용(null)');
  });
});
