'use strict';

const logger = require('firebase-functions/logger');
const { haversineKm, scoreKeywordMatch } = require('./utils');

/**
 * 학습주소 조회 키 결정: 전화번호가 있으면 우선 사용, 없으면 성명으로 fallback
 * (전화번호가 이름보다 안정적인 식별자라 우선순위를 둠)
 * @param {string|null|undefined} phone
 * @param {string|null|undefined} name
 * @returns {string|null} 학습주소 조회에 사용할 키 (둘 다 없으면 null)
 */
function resolveLearnKey(phone, name) {
  return phone || name || null;
}

/**
 * 카카오 주소 검색 (지번/도로명). 마트 좌표가 있으면 거리순 정렬 후
 * 가장 가까운 후보를 선택하고, 반경(martRadius, 기본 5km) 초과 시 null 반환(reject).
 * 실제 네트워크 호출은 global.fetch를 사용 — 테스트 시 모킹 대상.
 */
async function kakaoAddrSearch(query, kakaoKey, martLat, martLng, martRadius) {
  const res = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=5`, { headers: { Authorization: `KakaoAK ${kakaoKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const docs = data.documents || [];
  if (!docs.length) return null;
  // 신주소(road_address) 있는 후보 우선, 없으면 전체
  const candidates = docs.filter(d => d.road_address?.address_name);
  const pool = candidates.length ? candidates : docs;
  // 마트 좌표가 있으면 거리 계산 후 가장 가까운 결과 선택
  if (martLat && martLng) {
    pool.sort((a, b) => {
      const dA = haversineKm(martLat, martLng, parseFloat(a.y), parseFloat(a.x));
      const dB = haversineKm(martLat, martLng, parseFloat(b.y), parseFloat(b.x));
      return dA - dB;
    });
    const bestDist = haversineKm(martLat, martLng, parseFloat(pool[0].y), parseFloat(pool[0].x));
    logger.info('kakaoAddrSearch 거리순:', pool.map(d => {
      const km = haversineKm(martLat, martLng, parseFloat(d.y), parseFloat(d.x)).toFixed(2);
      return `${d.road_address?.address_name || d.address?.address_name}(${km}km)`;
    }).join(' / '));
    // 가장 가까운 결과도 설정 반경 초과면 reject → 키워드 검색으로 넘김
    const rejectThreshold = martRadius || 5;
    if (bestDist > rejectThreshold) {
      logger.info(`kakaoAddrSearch '${query}': 최근접 ${bestDist.toFixed(1)}km > ${rejectThreshold}km → reject`);
      return null;
    }
  }
  const doc = pool[0];
  return { road_address: doc.road_address?.address_name || doc.address?.address_name || query, lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
}

/**
 * 카카오 키워드(건물명) 검색. 후보 중 쿼리 토큰 매치 수(scoreKeywordMatch) +
 * 거리(가까울수록 가점)로 최적 후보를 선택.
 */
async function kakaoKeywordSearch(query, kakaoKey, martLat, martLng, martRadius) {
  if (!query?.trim()) return null;
  const url = martLat && martLng
    ? `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&x=${martLng}&y=${martLat}&radius=${Math.round((martRadius||5)*1000)}&size=5`
    : `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=5`;
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${kakaoKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const docs = data.documents || [];
  if (!docs.length) return null;
  // 쿼리 토큰(2자 이상 한글)이 place_name에 많이 포함될수록 우선 선택
  // 동점이면 마트와의 거리가 가까운 쪽 선택
  let bestDoc = docs[0];
  let bestScore = -Infinity;
  docs.forEach(doc => {
    const matchCount = scoreKeywordMatch(query, doc.place_name || '');
    const dist = (martLat && martLng) ? haversineKm(martLat, martLng, parseFloat(doc.y), parseFloat(doc.x)) : 99;
    const score = matchCount * 100 - dist;
    if (score > bestScore) { bestScore = score; bestDoc = doc; }
  });
  logger.info('kakaoKeywordSearch 선택:', bestDoc.place_name,
    '/ 후보:', docs.map(d => d.place_name).join(', '));
  return { road_address: bestDoc.road_address_name || bestDoc.address_name || query, lat: parseFloat(bestDoc.y), lng: parseFloat(bestDoc.x) };
}

/**
 * OCR 원문 전처리: 영수증 스캔 시 줄바꿈으로 잘못 분리된 주소/층/호 표기를 합침
 * Vision API 결과를 Gemini에 넘기기 전 적용
 */
function preprocessOcrText(rawText) {
  // ⓪ 하이픈 건물번호 줄바꿈 합치기 (층/호가 바로 이어지지 않는 경우만)
  //    예) "210-2\n6 1층" → "210-26 1층" / "737-42\n1층"은 1 뒤에 층→ 해당 없음
  rawText = rawText.replace(/(-\d+)\n(\d+)(?![층호])/g, '$1$2');
  // ① "숫자\n숫자 층/호" → 공백으로 연결
  //    예) "어딘가로123\n8 1층" → "어딘가로123 8 1층"
  rawText = rawText.replace(/(\d)\n(\d+)\s+(층|호[수]?|\d+층|\d+호)/g, '$1 $2 $3');
  // ② "숫자\n숫자층/호" (공백 없이 붙은 경우)
  //    예) "737-42\n1층" → "737-42 1층", "45-48\n1층" → "45-48 1층"
  rawText = rawText.replace(/(\d)\n(\d+)(층|호)/g, '$1 $2$3');
  // ③ 숫자 뒤 줄바꿈 후 바로 층/호/동 (공백 없이 붙이기)
  //    예) "737-42 1\n층" → "737-42 1층"
  rawText = rawText.replace(/(\d)\n\s*(층|호|동)/g, '$1$2');
  // ④ 칸 이동으로 인한 한글 단어 중간 공백 제거 (한글 + 공백 + 한글+숫자 패턴)
  //    예) "수 호2동" → "수호2동" (영수증 칸이 열로 나뉠 때 OCR이 공백으로 읽는 현상)
  rawText = rawText.replace(/([가-힣])\s+([가-힣]\d)/g, '$1$2');
  // ⑤ 주소 번지 줄바꿈 합치기: 한글+숫자로 끝난 줄 다음에 숫자+공백+한글이 오면 붙임
  //    예) "회나무로12나길1\n0 목멱어린이집" → "회나무로12나길10 목멱어린이집"
  rawText = rawText.replace(/([가-힣]\d+)\n(\d+)(\s+[가-힣])/g, '$1$2$3');
  return rawText;
}

/**
 * 원본 주소 문자열을 카카오 검색용 쿼리(query)와 세부주소(detailAddress)로 분리
 * Kakao API 호출 전 순수 문자열 파싱 단계 (네트워크 의존 없음)
 * @param {string} rawAddress - Gemini가 추출한 원본 주소
 * @returns {{ query: string, detailAddress: string }}
 */
function parseAddressComponents(rawAddress) {
  // 아파트 약어 정규화: "용산A" / "대림APT" / "용산@" → "용산아파트" / "대림아파트"
  // ※ '@'는 word character가 아니라서 \b가 절대 성립하지 않음 — 뒤에 영숫자가
  //   바로 이어지지 않는지(negative lookahead)로 \b와 동등한 조건을 대신 사용
  let addr = rawAddress
    .replace(/([가-힣]+)\s*@(?![A-Za-z0-9_])/g, '$1아파트')
    .replace(/([가-힣]+)\s*A\b/g, '$1아파트')
    .replace(/([가-힣]+)\s*[Aa][Pp][Tt]\b/g, '$1아파트');

  // Gemini가 동 이름을 주소 앞에 포함한 경우 제거
  // "이태원동 258-116" → "258-116", "이태원1동44-50 1층" → "44-50 1층"
  const dongPrefixMatch = addr.match(/^([가-힣][가-힣\d]*동)\s*(\d+(?:-\d+)*(?=\s|$).*)$/);
  const rawAddressClean = dongPrefixMatch ? dongPrefixMatch[2] : addr;

  // 아파트 동-호 형식 정규화: "109-302호" → "109동 302호"
  const aptDongHoMatch = rawAddressClean.match(/(\d{2,4})-(\d{2,4}호)/);
  const aptDongHoDetail = aptDongHoMatch ? `${aptDongHoMatch[1]}동 ${aptDongHoMatch[2]}` : null;
  const addrBase = aptDongHoDetail
    ? rawAddressClean.slice(0, rawAddressClean.lastIndexOf(aptDongHoMatch[0])).trim()
    : rawAddressClean;

  // 지하/지중/지층 등 위치 설명어 제거 (검색 전)
  const locDescMatch = addrBase.match(/\s*(지하|지중|지층|옥상|B\d+)$/);
  const locDesc = locDescMatch ? locDescMatch[0].trim() : '';
  const addrClean = locDesc ? addrBase.slice(0, addrBase.lastIndexOf(locDescMatch[0])).trim() : addrBase;

  // 상세주소 패턴: 101호, 3층, 나-516, 가동 101호 등
  const dm = aptDongHoDetail ? null : addrClean.match(/[가-힣]?-?\d+호|\d+층|(?<![가-힣\d])\d+동\s*\d*호?|[가나다라마바사아자차카타파하]-\d+/);
  const dmIdx = dm ? addrClean.lastIndexOf(dm[0].trimEnd()) : -1;
  const da = aptDongHoDetail
    ? [aptDongHoDetail, locDesc].filter(Boolean).join(' ')
    : [dmIdx >= 0 ? addrClean.slice(dmIdx).trim() : '', locDesc].filter(Boolean).join(' ');
  const q0 = da && dm ? addrClean.slice(0, dmIdx).replace(/-\s*$/, '').trim() : addrClean.trim();

  let q = q0;
  let daFull = da;
  if (q) {
    // 괄호 안 내용을 먼저 세부주소로 분리
    // 예) "민락엘레트 1903-104 (현관 104열쇠 2634종)" → q="민락엘레트 1903-104", da="(현관 104열쇠 2634종)"
    const parenMatch = q.match(/^(.+?)\s*(\([^)]+\))\s*$/);
    if (parenMatch) {
      daFull = [parenMatch[2].trim(), daFull].filter(Boolean).join(' ');
      q = parenMatch[1].trim();
    }
    // 숫자로 끝나는 주소 뒤에 한글 건물명이 붙어있으면 분리
    // 예) "회나무로12나길10 목멱어린이집" → q="회나무로12나길10", daFull="목멱어린이집"
    const extraMatch = q.match(/^(.*\d+(?:-\d+)?)\s+([가-힣].*)$/);
    if (extraMatch) {
      daFull = [extraMatch[2].trim(), daFull].filter(Boolean).join(' ');
      q = extraMatch[1].replace(/-\s*$/, '').trim();
    }
    // 주소 끝에 "숫자-숫자" 동호 약식 표기가 남아있으면 분리
    // 예) "오목로35번길66 101-405" → q="오목로35번길66", daFull="101동 405호"
    // 예) "민락엘레트 1903-104" → q="민락엘레트", daFull="1903동 104호"
    const trailingUnitMatch = q.match(/^(.+\S)\s+(\d{2,4}-\d{2,4})$/);
    if (trailingUnitMatch) {
      const unitStr = trailingUnitMatch[2].replace(/^(\d+)-(\d+)$/, '$1동 $2호');
      daFull = [unitStr, daFull].filter(Boolean).join(' ');
      q = trailingUnitMatch[1].trim();
    }
  }
  const daFinal = daFull || da;

  return { query: q, detailAddress: daFinal };
}

module.exports = {
  resolveLearnKey,
  kakaoAddrSearch,
  kakaoKeywordSearch,
  preprocessOcrText,
  parseAddressComponents,
};
