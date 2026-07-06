'use strict';

/**
 * 두 좌표 간 거리(km) - Haversine 공식
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * 카카오 키워드 검색 결과 이름 유사도 점수
 * 쿼리를 2자 이상 한글 토큰으로 분리 후 place_name 포함 여부 카운트
 * @param {string} query  - 검색 쿼리 (예: "민락 대광로제비앙")
 * @param {string} placeName - 후보 장소명 (예: "민락대광로제비앙포레스트아파트")
 * @returns {number} 일치 토큰 수
 */
function scoreKeywordMatch(query, placeName) {
  const tokens = (query.match(/[가-힣]{2,}/g) || []);
  return tokens.filter(t => placeName.includes(t)).length;
}

module.exports = { haversineKm, scoreKeywordMatch };
