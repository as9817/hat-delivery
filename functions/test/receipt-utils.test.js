'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { preprocessOcrText, parseAddressComponents } = require('../lib/receipt-utils');

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
