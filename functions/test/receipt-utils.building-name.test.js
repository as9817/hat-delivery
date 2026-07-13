'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { enrichDetailAddressWithBuildingName, buildLearnedLocationResponse } = require('../lib/receipt-utils');

const ROOT = path.join(__dirname, '..', '..');

// 아래 테스트 데이터는 전부 합성(가상) 건물명/주소입니다. 실제 고객 데이터 아님.

describe('enrichDetailAddressWithBuildingName', () => {
  it('1) 건물명이 detailAddress 앞에 붙어있으면 떼어내서 뒤 괄호로 정리', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('가상캐슬 1201동 1603호', '가상캐슬'),
      '1201동 1603호 (가상캐슬)'
    );
  });

  it('2) 다른 건물명도 동일하게 정리', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('가상브래뉴 102동 203호', '가상브래뉴'),
      '102동 203호 (가상브래뉴)'
    );
  });

  it('3) 세 번째 건물명 케이스', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('가상엘레트 908동 1903호', '가상엘레트'),
      '908동 1903호 (가상엘레트)'
    );
  });

  it('4) detailAddress에 건물명이 없고 후보만 있으면 뒤에 괄호로 추가', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('1201동 1603호', '가상캐슬'),
      '1201동 1603호 (가상캐슬)'
    );
  });

  it('5) 4번과 동일 패턴, 다른 건물명', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('102동 203호', '가상브래뉴'),
      '102동 203호 (가상브래뉴)'
    );
  });

  it('6) 이미 괄호 건물명이 있으면 중복 삽입하지 않고 그대로 유지', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('102동 203호 (가상브래뉴)', '가상브래뉴'),
      '102동 203호 (가상브래뉴)'
    );
  });

  it('7) detailAddress가 비어있으면 1차에서는 빈 값 유지(보강 안 함)', () => {
    assert.equal(enrichDetailAddressWithBuildingName('', '가상캐슬'), '');
  });

  it('8) 건물명만 있고 동/호수가 없으면(떼어내면 빈 문자열) 보강하지 않고 그대로 유지', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('가상캐슬', '가상캐슬'),
      '가상캐슬'
    );
  });

  it('9) 건물명 후보가 "아파트" 같은 일반 종류명이면 미삽입', () => {
    assert.equal(enrichDetailAddressWithBuildingName('102동 203호', '아파트'), '102동 203호');
  });

  it('10) 건물명 후보가 "빌라"여도 미삽입', () => {
    assert.equal(enrichDetailAddressWithBuildingName('102동 203호', '빌라'), '102동 203호');
  });

  it('11) 건물명 후보가 출입정보성 문자열("#1234")이면 미삽입', () => {
    assert.equal(enrichDetailAddressWithBuildingName('102동 203호', '#1234'), '102동 203호');
  });

  it('13) OCR 후보 없이 카카오 building_name만 있는 경우도 동일하게 보강', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('1201동 1603호', '가상캐슬'),
      '1201동 1603호 (가상캐슬)'
    );
  });

  it('14) 건물명 후보가 없으면(null) 원문 그대로', () => {
    assert.equal(enrichDetailAddressWithBuildingName('1201동 1603호', null), '1201동 1603호');
    assert.equal(enrichDetailAddressWithBuildingName('1201동 1603호', undefined), '1201동 1603호');
  });

  it('15) detailAddress 자체에 일반단어("아파트")가 섞여있고 건물명 후보가 없으면 원문 유지', () => {
    assert.equal(
      enrichDetailAddressWithBuildingName('아파트 1201동 1603호', null),
      '아파트 1201동 1603호'
    );
  });

  it('건물명 후보가 너무 길면(12자 초과) 미삽입', () => {
    const longName = '가나다라마바사아자차카타파하'; // 13자
    assert.equal(enrichDetailAddressWithBuildingName('102동 203호', longName), '102동 203호');
  });

});

describe('12) processReceipt 순서 시뮬레이션 — split 이후 enrich, accessInfo와 분리 유지', () => {
  it('괄호 안 출입정보와 건물명이 섞이지 않고 각자 분리된 상태로 남음', () => {
    const { splitDetailAndAccessInfo } = require('../lib/receipt-utils');
    // standardizeAddress가 반환했을 법한 원본: 건물명이 이미 detailAddress 앞에 붙어있고
    // 끝에는 출입정보 괄호가 남아있는 상태(카카오 파싱 단계 결과물 흉내)
    const rawDetail = '가상캐슬 1201동 1603호 (공동현관 #1234)';
    const split = splitDetailAndAccessInfo(rawDetail);
    assert.equal(split.accessInfo, '공동현관 #1234');
    assert.equal(split.detailAddress, '가상캐슬 1201동 1603호');

    const enriched = enrichDetailAddressWithBuildingName(split.detailAddress, '가상캐슬');
    assert.equal(enriched, '1201동 1603호 (가상캐슬)');
    // accessInfo는 enrich 단계에서 전혀 건드리지 않음
    assert.equal(split.accessInfo, '공동현관 #1234');
  });
});

describe('16) 학습주소 경로는 건물명 보강 로직을 타지 않음', () => {
  it('buildLearnedLocationResponse는 저장된 detail_address를 그대로 반환(보강 없음)', () => {
    const currentAddress = '서울시 가상구 가상로 1';
    const learned = {
      road_address: '서울시 가상구 가상로 1',
      detail_address: '1201동 1603호', // 건물명 없이 저장된 과거 학습값
      access_info: '',
      lat: 37.5, lng: 127.0,
    };
    const result = buildLearnedLocationResponse(currentAddress, learned);
    assert.equal(result.detail_address, '1201동 1603호'); // 괄호/건물명 추가 없이 그대로
  });
});

describe('17) 수기 입력(driver.html geocodeAndAdd)은 이번 변경과 무관', () => {
  it('saas/driver.html 소스에 건물명 보강 관련 식별자가 전혀 없음(정적 검사)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'saas', 'driver.html'), 'utf8');
    assert.ok(!src.includes('enrichDetailAddressWithBuildingName'), 'driver.html이 건물명 보강 로직을 참조하면 안 됨');
    assert.ok(!src.includes('buildingName'), 'driver.html이 buildingName 필드를 참조하면 안 됨(수기 입력 경로 미변경)');
  });
});
