'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, scoreKeywordMatch } = require('../lib/utils');

// ── haversineKm ────────────────────────────────────────────
describe('haversineKm', () => {
  it('같은 좌표 → 0km', () => {
    assert.equal(haversineKm(37.5, 127.0, 37.5, 127.0), 0);
  });

  it('서울-부산 약 325km', () => {
    const d = haversineKm(37.5665, 126.9780, 35.1796, 129.0756);
    assert.ok(d > 300 && d < 340, `기대 300~340km, 실제: ${d.toFixed(1)}km`);
  });

  it('마트 주변 2km 이내 두 점', () => {
    // 의정부 낙양동 기준 두 점 (민락동 주변)
    const d = haversineKm(37.7384, 127.0645, 37.7475, 127.0588);
    assert.ok(d < 2, `기대 2km 이내, 실제: ${d.toFixed(2)}km`);
  });

  it('reject 기준 5km 초과 판별', () => {
    // 의정부 낙양동(마트) ↔ 서울 도봉구: 약 15km
    const d = haversineKm(37.7384, 127.0645, 37.6789, 127.0470);
    assert.ok(d > 5, `기대 5km 초과, 실제: ${d.toFixed(2)}km`);
  });
});

// ── scoreKeywordMatch ─────────────────────────────────────
describe('scoreKeywordMatch', () => {
  it('민락 대광로제비앙 → 민락대광로제비앙포레스트: 2점 (정답)', () => {
    assert.equal(scoreKeywordMatch('민락 대광로제비앙', '민락대광로제비앙포레스트아파트'), 2);
  });

  it('민락 대광로제비앙 → 대광로제비앙더퍼스트: 1점 (오답)', () => {
    assert.equal(scoreKeywordMatch('민락 대광로제비앙', '대광로제비앙더퍼스트아파트'), 1);
  });

  it('정답이 오답보다 높은 점수', () => {
    const correct = scoreKeywordMatch('민락 대광로제비앙', '민락대광로제비앙포레스트아파트');
    const wrong   = scoreKeywordMatch('민락 대광로제비앙', '대광로제비앙더퍼스트아파트');
    assert.ok(correct > wrong, `정답(${correct}) > 오답(${wrong}) 이어야 함`);
  });

  it('민락엘레트 단일 토큰: 1점', () => {
    assert.equal(scoreKeywordMatch('민락엘레트', '민락엘레트'), 1);
  });

  it('빈 쿼리 → 0점', () => {
    assert.equal(scoreKeywordMatch('', '민락대광로제비앙포레스트아파트'), 0);
  });

  it('1자 한글 토큰은 무시', () => {
    // "동" "로" 같은 1자 토큰은 place_name에 대부분 포함돼 노이즈 → 제외 확인
    assert.equal(scoreKeywordMatch('동 로', '아무아파트'), 0);
  });
});
