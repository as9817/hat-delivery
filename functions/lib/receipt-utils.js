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
 * 로그에 개인정보(주소/이름/전화번호 등)를 원문으로 남기지 않기 위한 마스킹
 * 헬퍼. 값이 있었는지와 길이만 남기고 실제 내용은 남기지 않는다 — 운영
 * 디버깅에 필요한 최소 신호(비어있었는지, 길이가 비정상적으로 짧은지 등)만
 * 남기고 원문 노출은 하지 않는다는 원칙.
 * @param {*} value
 * @returns {string}
 */
function maskForLog(value) {
  if (value === null || value === undefined || value === '') return '(없음)';
  return `[len:${String(value).length}]`;
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
  // 카카오는 같은 건물의 구/신 도로명이 여럿일 때 최신 도로명을 마지막에 반환함.
  // reverse() 후 stable sort하면 동거리 후보 중 마지막(최신) 도로명이 pool[0]에 유지됨.
  pool.reverse();
  // 마트 좌표가 있으면 거리 계산 후 가장 가까운 결과 선택
  if (martLat && martLng) {
    pool.sort((a, b) => {
      const dA = haversineKm(martLat, martLng, parseFloat(a.y), parseFloat(a.x));
      const dB = haversineKm(martLat, martLng, parseFloat(b.y), parseFloat(b.x));
      return dA - dB;
    });
    const bestDist = haversineKm(martLat, martLng, parseFloat(pool[0].y), parseFloat(pool[0].x));
    // 주소 원문은 로그에 남기지 않고 거리(km)만 남김 — PII 노출 방지
    logger.info('kakaoAddrSearch 후보 거리순(주소 마스킹):', pool.map(d => {
      const km = haversineKm(martLat, martLng, parseFloat(d.y), parseFloat(d.x)).toFixed(2);
      return `${km}km`;
    }).join(' / '));
    // 가장 가까운 결과도 설정 반경 초과면 reject → 키워드 검색으로 넘김
    const rejectThreshold = martRadius || 5;
    if (bestDist > rejectThreshold) {
      logger.info(`kakaoAddrSearch 쿼리 ${maskForLog(query)}: 최근접 ${bestDist.toFixed(1)}km > ${rejectThreshold}km → reject`);
      return null;
    }
  }
  const doc = pool[0];
  return {
    road_address: doc.road_address?.address_name || doc.address?.address_name || query,
    lat: parseFloat(doc.y), lng: parseFloat(doc.x),
    // 카카오 주소검색이 도로명주소에 등록된 건물명(주로 아파트 단지명)을 반환하는 경우 함께 실어 나름.
    // 검색어(query)와 무관하게 카카오 DB에 등록된 값이라 OCR 품질과 별개로 신뢰도가 높음.
    buildingName: doc.road_address?.building_name || null,
    // 도로명/지번 주소 DB 직접 매칭 — 여러 장소가 경쟁하는 키워드검색과 달리 사실상
    // 유일 후보에 가까워 신뢰도 높음으로 분류(저신뢰 후보 선택 UX 노출 기준).
    confidence: 'high',
  };
}

// 카테고리 기반 가점/감점 — 실거주 건물(아파트/공동주택 등)은 가점, 실거주지가
// 아닌 부동산 판촉/중개 시설이나 단지 출입구(게이트)는 감점. "탑석자이" 실사고
// 실측(2026-07-13)에서, 분양홍보관이 실제 아파트 동보다 마트에 더 가깝다는
// 이유만으로 거리 페널티에 밀려 오선택된 것을 확인 — 카테고리 신호를 반영해
// 이런 역전을 막는다. category_name이 없는 후보는 조정 없음(0).
const CATEGORY_BONUS_KEYWORDS = ['주거시설', '공동주택'];
const CATEGORY_PENALTY_KEYWORDS = ['분양사무소', '분양', '중개업', '입출구'];
const CATEGORY_BONUS = 30;
const CATEGORY_PENALTY = -50;
// 거리 페널티 가중치 — 기존 "거리(km) 그대로 차감" 방식은 실거주 건물과
// 판촉/중개 시설이 1~2km 차이로 근접해 있을 때 손쉽게 순위를 뒤집었음
// (탑석자이 실사고: 1.4km 차이로 분양홍보관이 아파트보다 위로 올라감).
// 가중치를 낮춰 카테고리/토큰매치 신호가 거리보다 우선하도록 완화.
const DIST_PENALTY_WEIGHT = 0.3;

/**
 * 카카오 키워드검색 후보 1건의 점수를 계산하는 순수함수 — 실측 회귀 테스트 및
 * kakaoKeywordSearch() 내부에서 공용으로 사용.
 * @param {string} query
 * @param {{place_name?:string, category_name?:string}} doc
 * @param {number} distKm
 * @returns {number}
 */
function scoreKakaoKeywordCandidate(query, doc, distKm) {
  const matchCount = scoreKeywordMatch(query, doc.place_name || '');
  const category = doc.category_name || '';
  let categoryAdj = 0;
  if (CATEGORY_PENALTY_KEYWORDS.some(kw => category.includes(kw))) categoryAdj = CATEGORY_PENALTY;
  else if (CATEGORY_BONUS_KEYWORDS.some(kw => category.includes(kw))) categoryAdj = CATEGORY_BONUS;
  return matchCount * 100 + categoryAdj - distKm * DIST_PENALTY_WEIGHT;
}

// 저신뢰 주소 후보 선택 UX에 노출할 최대 후보 수 — 너무 많으면 기사가 고르기
// 번거로우므로 상위 3개로 제한.
const MAX_KEYWORD_CANDIDATES = 3;

/**
 * 카카오 키워드(건물명) 검색. 후보 중 쿼리 토큰 매치 수(scoreKeywordMatch) +
 * 카테고리(실거주 건물 가점/판촉·중개·출입구 감점) + 거리(가까울수록 가점,
 * 완화된 가중치)로 최적 후보를 선택. 여러 장소가 경쟁하는 구조라 주소검색
 * (kakaoAddrSearch)보다 신뢰도가 낮으므로 confidence:'low'와 함께, 기사가
 * 직접 고를 수 있도록 상위 후보 목록(candidates)도 함께 반환한다.
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
  const scored = docs.map(doc => {
    const dist = (martLat && martLng) ? haversineKm(martLat, martLng, parseFloat(doc.y), parseFloat(doc.x)) : 99;
    return { doc, score: scoreKakaoKeywordCandidate(query, doc, dist) };
  }).sort((a, b) => b.score - a.score);
  const bestDoc = scored[0].doc;
  const bestScore = scored[0].score;
  // 건물명/place_name은 로그에 남기지 않고 후보 수/점수만 남김 — PII 노출 방지
  logger.info('kakaoKeywordSearch: 후보', docs.length, '건 중 최고점 선택 (score:', bestScore, ')');
  return {
    road_address: bestDoc.road_address_name || bestDoc.address_name || query,
    lat: parseFloat(bestDoc.y), lng: parseFloat(bestDoc.x),
    confidence: 'low',
    candidates: scored.slice(0, MAX_KEYWORD_CANDIDATES).map(({ doc }) => ({
      road_address: doc.road_address_name || doc.address_name || query,
      lat: parseFloat(doc.y), lng: parseFloat(doc.x),
      place_name: doc.place_name || null, // 기사가 후보를 구분할 유일한 단서(카카오맵 공개 장소명, PII 아님)
    })),
  };
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

/**
 * 두 주소 문자열이 같거나 매우 유사한지 판단 (공백/대소문자 무시 후 완전일치
 * 또는 한쪽이 다른 쪽을 포함). 학습된 출입정보(access_info) 오적용 방지용
 * 최소 기준 — 애매하면 false를 반환해 자동 적용을 막는다.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSimilarAddress(a, b) {
  if (!a || !b) return false;
  const norm = s => String(s).replace(/\s+/g, '').toLowerCase();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * 학습주소(settings/learnedLocations 레코드)를 processReceipt 응답의 location으로
 * 변환. 영수증은 매번 새로 읽는 것이 원칙이므로, 이번 영수증 주소(currentAddress)와
 * 학습된 road_address가 유사할 때만 road_address/detail_address/access_info를
 * 통째로 적용한다. 주소가 다르면(애매한 경우 포함) null을 반환해 호출부가
 * standardizeAddress()로 이번 영수증 주소 기준 표준화를 계속 진행하도록 한다 —
 * 학습주소가 "이번 영수증 결과를 대체하는 원본"이 되지 않도록 하는 게 핵심.
 * @param {string} currentAddress - 이번 영수증에서 Gemini가 추출한 원본 주소
 * @param {object|null} learned - settings/learnedLocations/{key} 레코드
 * @returns {{road_address:string, detail_address:string, access_info:string, lat:number|null, lng:number|null}|null}
 *          주소가 유사하지 않으면 null(=학습주소 미적용, 표준화 폴백 신호)
 */
function buildLearnedLocationResponse(currentAddress, learned) {
  if (!learned || !learned.road_address) return null;
  const addressMatches = isSimilarAddress(currentAddress, learned.road_address);
  if (!addressMatches) return null;
  // 학습 레코드의 detail_address 자체가 과거(이 기능 도입 전)에 괄호가 안 분리된
  // 채로 저장됐을 수 있어 여기서도 한 번 더 분리를 시도 — 이미 access_info가
  // 저장돼 있으면 그 값이 우선(덮어쓰지 않음), 없을 때만 분리 결과로 채움.
  const split = splitDetailAndAccessInfo(learned.detail_address || '');
  const accessInfo = learned.access_info || split.accessInfo || '';
  return {
    road_address: learned.road_address,
    detail_address: split.detailAddress,
    access_info: accessInfo,
    lat: learned.lat || null,
    lng: learned.lng || null,
  };
}

// phone-history access_info 제안값이 이 길이를 넘으면 노출하지 않음 — 과거 메모성
// 텍스트/오기입으로 보고 방어적으로 스킵(정상 출입정보는 이보다 훨씬 짧음).
const ACCESS_INFO_SUGGESTION_MAX_LENGTH = 40;

/**
 * 주소 유사도 게이트(isSimilarAddress)를 통과하지 못해 학습주소 전체는 자동
 * 적용되지 않더라도, access_info만은 phone-key로 조회된 경우에 한해 더 적극적으로
 * 활용한다("원칙 B"). name-key로만 조회된 경우는 신원 신호가 약해 제외 — 이번
 * 영수증에서 인식된 전화번호(phone)가 있어야만(즉 resolveLearnKey가 실제로
 * phone을 키로 사용했을 것이 보장되는 경우에만) 제안한다.
 * @param {string|null|undefined} phone - 이번 영수증에서 인식된 전화번호
 * @param {object|null} learned - settings/learnedLocations/{key} 레코드(주소 불일치와 무관하게 존재하기만 하면 됨)
 * @returns {{accessInfo:string, accessInfoSource:'phone_history', accessInfoNeedsConfirm:true}|null}
 */
function buildAccessInfoSuggestion(phone, learned) {
  if (!phone || !learned) return null;
  const accessInfo = String(learned.access_info || '').trim();
  if (!accessInfo) return null;
  if (accessInfo.length > ACCESS_INFO_SUGGESTION_MAX_LENGTH) return null;
  return { accessInfo, accessInfoSource: 'phone_history', accessInfoNeedsConfirm: true };
}

// 괄호 안에 이 키워드 중 하나라도 있으면 출입정보로 판단 — 없으면 애매한 것으로
// 보고 분리하지 않음(기존처럼 detailAddress에 그대로 둠). "#"/"*"는 실제
// 비밀번호 표기("#1234", "2580*")에서 흔히 등장하는 짧은 표식이라 포함시킴.
// "종"(예: "2634종")은 넣지 않음 — "종로" 등 지명과 겹쳐 오탐 가능성이 있고,
// "현관 104열쇠 2634종" 같은 케이스도 "열쇠" 키워드만으로 이미 분리되므로 불필요.
const ACCESS_INFO_KEYWORDS = [
  '공동현관', '비밀번호', '비번', '호출', '경비실', '문 앞', '출입', '열쇠', '#', '*',
];

/**
 * detailAddress 문자열 끝에 붙은 괄호 안 내용이 출입정보(공동현관 비밀번호/호출
 * 등)로 보이면 detailAddress와 accessInfo로 분리한다. parseAddressComponents/
 * standardizeAddress의 결과(항상 끝에 괄호가 남는 형태)를 대상으로 하며, 그
 * 파싱 로직 자체는 건드리지 않고 이후 단계에서 한 번 더 나누는 방식이다.
 * 괄호가 없거나, 괄호 안에 출입정보로 볼 근거(키워드)가 없으면 원문을 그대로
 * detailAddress로 반환하고 accessInfo는 빈 값 — 애매하면 분리하지 않는다.
 * @param {string} detailText
 * @returns {{detailAddress: string, accessInfo: string}}
 */
function splitDetailAndAccessInfo(detailText) {
  const text = (detailText || '').trim();
  if (!text) return { detailAddress: '', accessInfo: '' };
  const m = text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { detailAddress: text, accessInfo: '' };
  const before = m[1].trim();
  const inside = m[2].trim();
  const looksLikeAccessInfo = ACCESS_INFO_KEYWORDS.some(kw => inside.includes(kw));
  if (!looksLikeAccessInfo) return { detailAddress: text, accessInfo: '' };
  return { detailAddress: before, accessInfo: inside };
}

// 건물명으로 보기엔 "종류명"일 뿐 고유명사가 아닌 단어들 — 이 단어와 완전히
// 일치하는 후보는 건물명으로 보강하지 않는다(예: "아파트" 단독).
const GENERIC_BUILDING_WORDS = [
  '아파트', '빌라', '오피스텔', '맨션', '주택', '건물', '공동주택', '연립', '다세대', '주공',
];

// 건물명 후보가 이 길이를 넘으면 보강하지 않음 — 정상적인 단지명보다 훨씬 길면
// 파싱 실수(다른 문장이 섞였을 가능성)로 보고 보수적으로 스킵.
const BUILDING_NAME_MAX_LENGTH = 12;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 확인된 건물명(buildingName)을 detailAddress에 안전하게 보강한다.
 * - buildingName/detailAddress 둘 중 하나라도 없으면 원문 그대로 반환(1차: 보강 안 함)
 * - detailAddress 앞부분이 buildingName으로 시작하면 그 부분을 떼어내고
 *   "{나머지} ({건물명})" 형태로 정리
 * - detailAddress에 이미 buildingName이 포함돼 있으면 중복 삽입하지 않음
 * - detailAddress에 이미 괄호가 있으면(무엇이 들어있든) 1차에서는 보수적으로 스킵
 * - buildingName이 일반 종류명 단독/출입정보성 문자열/과도하게 긴 경우 스킵
 * - 건물명을 떼어내고 남은 부분이 비면(=동/호수 등 세부정보가 없으면) 보강하지 않음
 * @param {string} detailAddress
 * @param {string|null|undefined} buildingName
 * @returns {string} 보강되었거나 원문 그대로인 detailAddress
 */
function enrichDetailAddressWithBuildingName(detailAddress, buildingName) {
  const original = detailAddress || '';
  const bn = (buildingName || '').trim();
  const da = original.trim();
  if (!bn || !da) return original;
  if (GENERIC_BUILDING_WORDS.includes(bn)) return original;
  if (ACCESS_INFO_KEYWORDS.some(kw => bn.includes(kw))) return original;
  if (bn.length > BUILDING_NAME_MAX_LENGTH) return original;
  if (/\([^)]*\)/.test(da)) return original; // 이미 괄호가 있으면 1차는 보수적으로 스킵

  let core = da;
  const prefixRe = new RegExp('^' + escapeRegExp(bn) + '\\s*');
  if (prefixRe.test(core)) core = core.replace(prefixRe, '').trim();

  const norm = s => s.replace(/\s+/g, '').toLowerCase();
  if (norm(core).includes(norm(bn))) return original; // 이미 어딘가에 포함됨 → 중복 방지
  if (!core) return original; // 건물명을 떼어내니 세부정보가 남지 않음 → 보강하지 않음

  return `${core} (${bn})`;
}

module.exports = {
  resolveLearnKey,
  kakaoAddrSearch,
  kakaoKeywordSearch,
  preprocessOcrText,
  parseAddressComponents,
  isSimilarAddress,
  buildLearnedLocationResponse,
  buildAccessInfoSuggestion,
  splitDetailAndAccessInfo,
  enrichDetailAddressWithBuildingName,
  scoreKakaoKeywordCandidate,
  maskForLog,
};
