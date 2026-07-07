// v4 - token auth
/**
 * 햇배달 - 영수증 OCR 파이프라인 + 문자/카톡 주문 자동 접수
 * Firebase Cloud Functions (2세대 HTTP)
 * 파이프라인: Vision API → Gemini API → Kakao Local API
 */

const functions = require('firebase-functions');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { GoogleGenAI } = require('@google/genai');
const bcrypt = require('bcryptjs');
require('./lib/utils'); // haversineKm/scoreKeywordMatch는 lib/receipt-utils.js가 내부적으로 사용
const {
  resolveLearnKey,
  kakaoAddrSearch,
  kakaoKeywordSearch,
  preprocessOcrText,
  parseAddressComponents,
  buildLearnedLocationResponse,
  splitDetailAndAccessInfo,
  maskForLog,
} = require('./lib/receipt-utils');


if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.database();

// ══════════════════════════════════════════════════════
// SEC-002: Firebase ID Token 인증 공통 헬퍼
// Authorization: Bearer <idToken> 검증 후 uid/tenantId/superadmin 여부 반환
// ══════════════════════════════════════════════════════
async function verifyAuthAndResolveTenantId(req) {
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return { authError: 401, message: '인증 토큰 없음' };

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { authError: 401, message: '유효하지 않은 인증 토큰' };
  }

  const uid = decoded.uid;

  const superadminSnap = await db.ref('superadmins/' + uid).once('value');
  if (superadminSnap.val() === true) {
    return { uid, isSuperadmin: true, tenantId: null };
  }

  if (decoded.tenantId) {
    // 기사 커스텀 토큰
    return { uid, isSuperadmin: false, tenantId: decoded.tenantId };
  }

  // 일반 관리자 계정: users/{uid}/tenantId 조회
  const userSnap = await db.ref('users/' + uid + '/tenantId').once('value');
  const tenantId = userSnap.val() || null;
  return { uid, isSuperadmin: false, tenantId };
}

exports.processReceipt = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 60, memory: '512MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ status: 'error', message: 'POST only' }); return; }

    const { imageBase64, tenantId, martLat: clientMartLat, martLng: clientMartLng } = req.body;
    if (!imageBase64) { res.status(400).json({ status: 'error', message: 'imageBase64 없음' }); return; }

    const authResult = await verifyAuthAndResolveTenantId(req);
    if (authResult.authError) { res.status(authResult.authError).json({ status: 'error', message: authResult.message }); return; }
    if (!authResult.isSuperadmin && authResult.tenantId !== tenantId) {
      res.status(403).json({ status: 'error', message: '테넌트 권한 없음' }); return;
    }

    // 멀티테넌트: tenantId가 있으면 테넌트 경로 사용
    const dbBase = tenantId ? `tenants/${tenantId}` : '';

    const VISION_KEY = process.env.GOOGLE_VISION_KEY;
    const GEMINI_KEY  = process.env.GEMINI_KEY;
    const KAKAO_KEY   = process.env.KAKAO_KEY;

    if (!VISION_KEY || !GEMINI_KEY || !KAKAO_KEY) {
      res.status(500).json({ status: 'error', message: 'API 키 환경변수 미설정' }); return;
    }

    try {
      logger.info('STEP 1: Vision API');
      const rawText = await extractTextWithVision(imageBase64, VISION_KEY);

      logger.info('STEP 2: Gemini API');
      const parsed = await parseWithGemini(rawText, GEMINI_KEY);

      logger.info('STEP 3: Kakao API');
      // 학습주소 먼저 확인 (전화번호 우선, 없으면 성명으로 fallback)
      // 영수증은 매번 새로 읽는 게 원칙이므로, 학습주소는 이번 영수증 주소와
      // 유사할 때만(buildLearnedLocationResponse 내부 게이트) 적용되고, 아니면
      // null을 반환해 아래 standardizeAddress()로 이번 영수증 기준 표준화가
      // 이어지도록 함 — 학습주소가 이번 결과를 무조건 덮어쓰지 않도록 하는 핵심 지점.
      const learnKey = resolveLearnKey(parsed.phone, parsed.name);
      if (learnKey) {
        const learnedSnap = await db.ref((dbBase ? dbBase + '/' : '') + 'settings/learnedLocations/' + learnKey).once('value').catch(() => null);
        const learned = learnedSnap?.val();
        const learnedLocation = buildLearnedLocationResponse(parsed.address, learned);
        if (learnedLocation) {
          // PII(전화번호/성명/주소 원문)는 로그에 남기지 않음 — 적용 여부만 기록
          logger.info('학습주소 적용됨(주소 유사도 일치) / access_info 포함:', !!learnedLocation.access_info);
          res.status(200).json({ status: 'success', data: {
            customer: { name: parsed.name, phone: parsed.phone || '' },
            location: learnedLocation,
            totalAmount: parsed.totalAmount || '',
          }});
          return;
        }
        if (learned?.road_address) {
          logger.info('학습주소 존재하지만 주소 불일치로 미적용 → 이번 영수증 기준 표준화 진행');
        }
      }
      const martSnap = await db.ref((dbBase ? dbBase + '/' : '') + 'settings/martLocation').once('value').catch(() => null);
      const martData = martSnap?.val() || {};
      const savedDongs = Array.isArray(martData.nearbyDongs) ? martData.nearbyDongs : [];
      // 마트 기본 동(이태원동 등)을 항상 맨 앞에
      const martDongMatch = (martData.oldAddress || '').match(/([가-힣]+동)/);
      const martDong = martDongMatch ? martDongMatch[1] : '';
      const nearbyDongs = martDong
        ? [martDong, ...savedDongs.filter(d => d !== martDong)]
        : savedDongs;
      // DB에서 마트 좌표 못 읽으면 클라이언트에서 전달한 값 사용
      const finalMartLat = martData.lat || clientMartLat || null;
      const finalMartLng = martData.lng || clientMartLng || null;
      logger.info('주변 동 검색 순서:', nearbyDongs.join(' → '));
      const finalMartRadius = martData.nearbyRadius || null;
      const location = await standardizeAddress(parsed.address, KAKAO_KEY, nearbyDongs, finalMartLat, finalMartLng, parsed.name, finalMartRadius);
      // OCR 원문 괄호에 섞여있던 출입정보(공동현관 비밀번호 등)를 detail_address에서
      // 분리 — parseAddressComponents/standardizeAddress 자체는 건드리지 않고,
      // 최종 응답 직전에 한 번만 분리한다(학습주소 없는 신규 주소라 기존 access_info
      // 값과 충돌할 여지가 없음).
      const splitResult = splitDetailAndAccessInfo(location.detail_address || '');

      res.status(200).json({
        status: 'success',
        data: {
          customer: { name: parsed.name || '', phone: parsed.phone || '' },
          location: {
            road_address:   location.road_address   || parsed.address || '',
            detail_address: splitResult.detailAddress,
            access_info: splitResult.accessInfo, // OCR 괄호에서 자동 분리(학습값 없는 신규 주소)
            lat: location.lat || null,
            lng: location.lng || null,
          },
          totalAmount: parsed.totalAmount || '',
        },
      });
    } catch (err) {
      logger.error('오류:', err);
      res.status(500).json({ status: 'error', message: err.message });
    }
  }
);

async function extractTextWithVision(base64Image, apiKey) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: base64Image }, features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }] }] }),
    }
  );
  if (!res.ok) { const e = await res.json(); throw new Error(`Vision: ${e.error?.message || res.status}`); }
  const data = await res.json();
  const ann = data.responses?.[0]?.fullTextAnnotation || data.responses?.[0]?.textAnnotations?.[0];
  if (!ann) throw new Error('Vision: 텍스트 인식 실패');
  const text = ann.text || ann.description || '';
  if (!text.trim()) throw new Error('Vision: 텍스트 없음');
  return text;
}

async function parseWithGemini(rawText, apiKey) {
  // OCR 줄바꿈 오분리 보정: 숫자 뒤에서 끊긴 층/호/동 합치기
  // 예) "737-42 1\n층" → "737-42 1층"
  // 영수증 원문(고객 성명/전화번호/주소 포함 가능)은 로그에 남기지 않고 길이만 기록
  logger.info('[DEBUG] Vision rawText length:', rawText.length);
  rawText = preprocessOcrText(rawText);
  logger.info('[DEBUG] preprocessed rawText length:', rawText.length);
  const prompt = `너는 마트 영수증 데이터 파싱 전문가야. 아래 OCR 텍스트에서 다음 4가지를 추출해:
1. name: 고객명 ('성명:' 옆 텍스트. '합계금액' 키워드 자체는 이름이 아님)
2. phone: 연락처 (전화번호. 010 없이 국번만 있어도 그대로 추출. 없으면 null)
3. address: 주소 ('주소:' 키워드 바로 뒤 텍스트만 추출. 영수증 상단 마트/가게 주소는 절대 제외. 고객 배달 주소만. 주소가 여러 줄에 걸쳐 있을 경우(다음 줄이 숫자/층/호/동으로 시작하면) 합쳐서 하나의 address로 만들어. 예1) "녹사평대로210-26\n1층" → "녹사평대로210-26 1층". 예2) "한남동 737-42\n1층" → "한남동 737-42 1층". ★중요: 숫자 사이 공백은 절대 제거하지 말 것. 예3) "45-4 8 피스릿길1층" → "45-4 8 피스릿길1층" (절대로 "45-48"로 합치면 안 됨). OCR에 있는 공백과 숫자를 그대로 보존할 것. ★칸이동 공백: 영수증 칸 구분으로 한글 단어 중간에 공백이 들어간 경우 붙여서 추출. 예4) "수 호2동 101호" → "수호2동 101호" (칸 이동으로 분리된 건물명은 합칠 것). ★번지 줄바꿈: 번지 숫자가 두 줄에 나뉜 경우 공백 없이 붙일 것. 예5) "회나무로12나길1\n0 목멱어린이집" → "회나무로12나길10 목멱어린이집" (1과 0 사이 공백 없음). ★복수 주소: '주소:' 뒤에 "1. 주소A 2. 주소B" 처럼 번호가 매겨진 여러 주소가 있으면 가장 마지막 번호의 주소를 선택(앞 번호는 취소된 주소). 예6) "주소: 1.한신디테라스108-7\n2.민락엘레트 1903-1505" → "민락엘레트 1903-1505")
4. totalAmount: 합계금액 (영수증에서 '합계', '합 계', '총합계', '결제금액', '착불매출', '착불금액', '매출합계' 키워드 바로 옆/아래 숫자. 쉼표 제거한 순수 숫자만. 상품 바코드나 상품코드가 아닌 최종 결제 금액)

반드시 JSON({name,phone,address,totalAmount})으로만 응답. totalAmount는 숫자 문자열(예: "17300").

[OCR]
` + rawText;
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { thinkingConfig: { thinkingBudget: 0 }, temperature: 0, maxOutputTokens: 256 }
  });
  const raw = response.text || '{}';
  const m = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Gemini: JSON 없음');
  const parsed = JSON.parse(m[0]);
  // 고객 성명/전화번호/주소는 로그에 원문으로 남기지 않고 존재 여부/길이만 기록
  logger.info('[DEBUG] Gemini parsed (마스킹):', {
    name: maskForLog(parsed.name),
    phone: maskForLog(parsed.phone),
    address: maskForLog(parsed.address),
    totalAmount: parsed.totalAmount || null,
  });
  return parsed;
}

// ══════════════════════════════════════════════════════
// 문자/카톡 주문 자동 접수
// MacroDroid → receiveOrder → Gemini 파싱 → Firebase RTDB → OMS
// ══════════════════════════════════════════════════════
exports.receiveOrder = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, Accept');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    // 인증 토큰 확인 (SEC-002: 기본값 폴백 제거, 환경변수 미설정 시 즉시 실패)
    const AUTH_TOKEN = process.env.ORDER_AUTH_TOKEN;
    if (!AUTH_TOKEN) { res.status(500).json({ error: 'ORDER_AUTH_TOKEN 미설정' }); return; }
    const token = req.headers['x-auth-token'];
    if (token !== AUTH_TOKEN) { res.status(401).json({ error: 'Unauthorized' }); return; }

    // JSON 또는 form-urlencoded 둘 다 지원
    const body = req.body || {};
    const message = (body.message || '').trim();
    const channel = body.channel || 'sms';
    const sender  = body.sender  || '';
    if (!message) { res.status(400).json({ error: 'message 없음' }); return; }

    const GEMINI_KEY = process.env.GEMINI_KEY;
    const KAKAO_KEY  = process.env.KAKAO_KEY;
    if (!GEMINI_KEY) { res.status(500).json({ error: 'GEMINI_KEY 미설정' }); return; }

    try {
      // 1. Gemini로 주문 파싱 (스팸 필터 포함)
      const parsed = await parseOrderWithGemini(message, GEMINI_KEY);

      const msgType = parsed.type || (parsed.isOrder ? 'order' : 'spam');

      // 스팸 — 저장 없이 리턴
      if (msgType === 'spam') {
        logger.info('스팸/비주문 메시지 무시:', message.slice(0, 50));
        res.status(200).json({ success: false, skipped: true, reason: 'not_an_order' });
        return;
      }

      // 취소 요청 — 같은 전화번호 최근 주문 cancelled 처리
      if (msgType === 'cancel') {
        const phone = parsed.phone || sender;
        let cancelled = false;
        if (phone) {
          const snap = await db.ref('orders').orderByChild('phone').equalTo(phone).limitToLast(5).once('value');
          const existing = snap.val();
          if (existing) {
            const active = Object.entries(existing)
              .filter(([,o]) => o.status === 'pending' || o.status === 'confirmed')
              .sort(([,a],[,b]) => (b.createdAt||0) - (a.createdAt||0));
            if (active.length > 0) {
              const [cancelId] = active[0];
              await db.ref('orders/' + cancelId).update({ status: 'cancelled', cancelledAt: Date.now(), cancelReason: message });
              logger.info('주문 취소 처리:', cancelId);
              cancelled = true;
              res.status(200).json({ success: true, type: 'cancel', cancelledOrderId: cancelId });
              return;
            }
          }
        }
        if (!cancelled) {
          res.status(200).json({ success: false, type: 'cancel', reason: '취소할 주문 없음' });
          return;
        }
      }

      // 추가 요청 — 같은 전화번호 최근 주문에 품목 추가
      if (msgType === 'add') {
        const phone = parsed.phone || sender;
        let added = false;
        if (phone && parsed.items && parsed.items.length > 0) {
          const snap = await db.ref('orders').orderByChild('phone').equalTo(phone).limitToLast(5).once('value');
          const existing = snap.val();
          if (existing) {
            const active = Object.entries(existing)
              .filter(([,o]) => o.status === 'pending' || o.status === 'confirmed')
              .sort(([,a],[,b]) => (b.createdAt||0) - (a.createdAt||0));
            if (active.length > 0) {
              const [addId, addOrder] = active[0];
              const mergedItems = [...(addOrder.items||[]), ...parsed.items.map(it => ({ name: it.name||'', qty: it.qty||1, price: 0 }))];
              await db.ref('orders/' + addId).update({ items: mergedItems, updatedAt: Date.now() });
              logger.info('품목 추가 처리:', addId, parsed.items);
              added = true;
              res.status(200).json({ success: true, type: 'add', updatedOrderId: addId, addedItems: parsed.items });
              return;
            }
          }
        }
        if (!added) {
          // 추가할 기존 주문이 없으면 새 주문으로 처리
          logger.info('추가 요청이지만 기존 주문 없음 → 신규 주문으로 처리');
        }
      }

      // 2. 마트 위치 읽기 (주소 보완용)
      let martDistrict = '';
      try {
        const martSnap = await db.ref('settings/martLocation').once('value');
        const martData = martSnap.val();
        // 구주소(동 포함)가 있으면 우선 사용, 없으면 신주소에서 구 추출
        if (martData?.oldAddress) {
          // "서울 용산구 이태원동 224-3" → "서울 용산구 이태원동" (동까지만)
          const dm = martData.oldAddress.match(/^(.+?동)/);
          martDistrict = dm ? dm[1].trim() : martData.oldAddress.trim();
        } else if (martData?.address) {
          const m = martData.address.match(/^(.+?(?:구|군))/);
          if (m) martDistrict = m[1].trim();
        }
      } catch(e) { logger.warn('마트 위치 읽기 실패'); }

      // 3. Kakao로 주소 표준화 (KAKAO_KEY 있을 때만)
      let finalAddress = parsed.address || '미확인';
      if (parsed.address && KAKAO_KEY) {
        try {
          // 짧은 지번(예: 390-71)이면 마트 지역 앞에 붙여서 검색
          const queryAddr = (martDistrict && parsed.address.match(/^\d+-?\d*$/))
            ? martDistrict + ' ' + parsed.address
            : parsed.address;
          logger.info('STEP Kakao: 주소 검색 쿼리:', queryAddr);
          const loc = await standardizeAddress(queryAddr, KAKAO_KEY);
          logger.info('STEP Kakao: 결과:', JSON.stringify(loc));
          // lat이 있을 때만 실제로 찾은 것 (없으면 Kakao가 원본 쿼리를 그대로 반환한 것)
          if (loc.road_address && loc.lat !== null) {
            finalAddress = loc.road_address + (loc.detail_address ? ' ' + loc.detail_address : '');
            logger.info('STEP Kakao: 변환 완료:', finalAddress);
          } else {
            logger.warn('STEP Kakao: 주소 못 찾음, 원본 사용:', parsed.address);
            finalAddress = (parsed.address || '') + ' ⚠️주소확인필요';
          }
        } catch (e) {
          logger.warn('STEP Kakao: 오류, 원본 사용:', e.message);
        }
      } else {
        logger.info('STEP Kakao: 스킵 (주소없음 또는 키없음)');
      }

      // 3. 정규식 보조 파서 (Gemini가 ?? 또는 null 반환 시 보완)
      logger.info('원본 메시지:', message, '/ 길이:', message.length);

      // 이름: 토큰 분리 후 첫 번째 한글 단어 (유니코드 범위 사용)
      const koreanWord = /^[가-힣]+$/;
      const tokens = message.trim().split(/\s+/);
      const nameFromMsg = tokens.find(t => t.length >= 2 && t.length <= 5 && koreanWord.test(t)) || null;
      const finalName = (parsed.name && parsed.name !== '??' && parsed.name !== '???') ? parsed.name : nameFromMsg;

      // 품목: 단위 앞 한글 단어 추출
      const itemPattern = /([가-힣a-zA-Z]+)\s*(\d+)\s*(개|판|통|봉|kg|g|L|묶음|세트|팩)/g;
      const itemsFromMsg = [];
      let im;
      while ((im = itemPattern.exec(message)) !== null) {
        itemsFromMsg.push({ name: im[1], qty: parseInt(im[2]), price: 0 });
      }
      const hasValidItems = Array.isArray(parsed.items) && parsed.items.length > 0 &&
        parsed.items.some(it => it.name && it.name !== '??' && it.name !== '???');
      const finalItems = hasValidItems
        ? parsed.items.map(it => ({ name: it.name || '', qty: it.qty || 1, price: 0 }))
        : (itemsFromMsg.length > 0 ? itemsFromMsg : []);

      logger.info('최종 이름:', finalName, '/ 최종 품목:', JSON.stringify(finalItems));

      // 3-1. 기존 고객 조회: 주소 또는 전화번호 누락 시 과거 주문에서 보완
      const needAddress = !parsed.address;
      const needPhone   = !parsed.phone && !sender;
      let lookedUpAddress = null;
      let lookedUpPhone   = null;

      if (needAddress || needPhone) {
        try {
          let pastOrders = null;

          // 전화번호로 조회 (전화번호 있으면 더 정확)
          if (parsed.phone || sender) {
            const phoneKey = parsed.phone || sender;
            const snap = await db.ref('orders').orderByChild('phone').equalTo(phoneKey).limitToLast(5).once('value');
            pastOrders = snap.val();
          }

          // 전화번호 조회 실패 or 전화 없으면 이름으로 조회
          if (!pastOrders && finalName) {
            const snap = await db.ref('orders').orderByChild('customerName').equalTo(finalName).limitToLast(10).once('value');
            pastOrders = snap.val();
          }

          if (pastOrders) {
            // 가장 최근 주문 중 주소/전화가 있는 것 선택
            const sorted = Object.values(pastOrders)
              .filter(o => o.address && o.address !== '미확인')
              .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            if (sorted.length > 0) {
              const best = sorted[0];
              if (needAddress && best.address) {
                lookedUpAddress = best.address;
                logger.info('고객 DB 주소 보완:', finalName, '→', lookedUpAddress);
              }
              if (needPhone && best.phone && best.phone !== '-') {
                lookedUpPhone = best.phone;
                logger.info('고객 DB 전화 보완:', finalName, '→', lookedUpPhone);
              }
            }
          }
        } catch(e) {
          logger.warn('고객 조회 실패:', e.message);
        }
      }

      // 주소 최종 결정: 파싱된 주소 > 조회된 주소 > 미확인
      if (needAddress && lookedUpAddress) {
        finalAddress = lookedUpAddress;
      }
      const finalPhone = parsed.phone || sender || lookedUpPhone || '-';

      logger.info('최종 이름:', finalName, '/ 최종 품목:', JSON.stringify(finalItems));

      // 4. Firebase RTDB에 주문 저장
      const orderId = 'ext_' + Date.now();
      const order = {
        id:           orderId,
        customerName: finalName   || '미확인',
        address:      finalAddress,
        phone:        finalPhone,
        items:        finalItems,
        memo:         parsed.memo    || '',
        status:       'pending',
        channel:      channel,
        rawMessage:   message,
        sender:       sender,
        createdAt:    Date.now(),
        source:       'external',
      };

      await db.ref('orders/' + orderId).set(order);

      logger.info('주문 접수 완료:', orderId, parsed);
      res.status(200).json({ success: true, orderId, parsed });

    } catch (err) {
      logger.error('receiveOrder 오류:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

async function parseOrderWithGemini(message, apiKey) {
  const prompt = `마트 배달 주문 문자를 분석해서 JSON으로만 답해. 반드시 JSON({type,name,address,phone,items:[{name,qty}],memo})만 출력.
- type: 아래 중 하나만
  "order"  = 새 배달 주문 (상품+주소 포함)
  "cancel" = 주문 취소 요청 ("취소", "안 시켜요", "취소해주세요" 등)
  "add"    = 기존 주문에 품목 추가 ("추가", "하나 더", "더 주세요" 등)
  "spam"   = 광고/인증번호/배송알림/스팸/안부인사 등 주문 무관
- name: 첫 번째 한글 단어(이름), 없으면 null
- phone: 010 패턴 전화번호, 없으면 null
- address: 지번(숫자-숫자) 또는 건물명+동호수, 없으면 null
- items: 상품명 그대로 + 수량. 예) 감자2개→{"name":"감자","qty":2}, 계란1판→{"name":"계란","qty":1}
- memo: 특이사항, 없으면 null

[메시지] ${message}`;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 0,
      maxOutputTokens: 512,
    }
  });

  const raw = response.text || '{}';
  logger.info('Gemini 원본 응답:', raw);
  const m = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
  if (!m) { logger.warn('JSON 추출 실패. raw:', raw); return {}; }
  try { return JSON.parse(m[0]); } catch (e) { logger.warn('JSON 파싱 실패:', m[0]); return {}; }
}

// kakaoAddrSearch, kakaoKeywordSearch는 lib/receipt-utils.js로 이동
// (fetch 모킹 기반 테스트를 위해 분리 — functions/test/receipt-utils.kakao.test.js 참고)

async function standardizeAddress(rawAddress, kakaoKey, nearbyDongs = [], martLat, martLng, fallbackName, martRadius) {
  if (!rawAddress?.trim()) {
    // 주소 없으면 상호명/고객명으로 키워드 검색
    if (fallbackName) {
      logger.info('주소 없음 → 상호명 키워드 검색:', maskForLog(fallbackName));
      const rk = await kakaoKeywordSearch(fallbackName, kakaoKey, martLat, martLng, martRadius);
      if (rk) { logger.info('상호명 검색 성공:', maskForLog(rk.road_address)); return { ...rk, detail_address: '' }; }
    }
    return { road_address: '', detail_address: '', lat: null, lng: null };
  }

  // 순수 문자열 파싱(아파트 약어 정규화, 동-호 분리, 괄호/건물명/약식 동호 분리)은
  // lib/receipt-utils.js의 parseAddressComponents로 분리 (functions/test/receipt-utils.test.js 참고)
  const { query: q, detailAddress: daFinal } = parseAddressComponents(rawAddress);

  // 1차: 원본 주소 검색 (마트 좌표 기준 거리순)
  const r1 = await kakaoAddrSearch(q, kakaoKey, martLat, martLng, martRadius);
  if (r1) return { ...r1, detail_address: daFinal };

  // 주소가 숫자 시작(지번)이면 주변 동 검색, 아니면 키워드 검색(건물명/아파트)
  if (/^\d/.test(q)) {
    // 지번 뒤 건물명 분리: "258-116 새남교회" → jibun="258-116", bldg="새남교회"
    const jibunMatch = q.match(/^(\d+(?:-\d+)?)\s*(.*)$/);
    const jibunOnly = jibunMatch ? jibunMatch[1] : q;
    const bldgName  = jibunMatch ? jibunMatch[2].trim() : '';

    // 2차: 주변 동 이름 병렬 시도 (지번만으로) — 거리순 정렬 유지, Promise.all로 동시 요청
    if (nearbyDongs.length > 0) {
      const r2Results = await Promise.all(
        nearbyDongs.map(dong => kakaoAddrSearch(dong + ' ' + jibunOnly, kakaoKey, martLat, martLng, martRadius))
      );
      const r2Idx = r2Results.findIndex(r => r !== null);
      if (r2Idx !== -1) {
        logger.info('주변동 병렬 검색 성공:', nearbyDongs[r2Idx], maskForLog(r2Results[r2Idx].road_address));
        return { ...r2Results[r2Idx], detail_address: [bldgName, daFinal].filter(Boolean).join(' ') };
      }
    }
    // 3차: 건물명 있으면 키워드 검색
    if (bldgName) {
      logger.info('지번+건물명 키워드 검색:', maskForLog(bldgName));
      const rk3 = await kakaoKeywordSearch(bldgName, kakaoKey, martLat, martLng, martRadius);
      if (rk3) { logger.info('건물명 키워드 검색 성공:', maskForLog(rk3.road_address)); return { ...rk3, detail_address: daFinal }; }
    }
    // 4차: 지번만으로 주소 검색 (마트 좌표 있을 때만 — haversine으로 가장 가까운 결과 선택)
    // nearbyDongs 없어도 마트 좌표가 있으면 "211-14" → 마트 근처 매칭 가능
    if (martLat && martLng) {
      const r4 = await kakaoAddrSearch(jibunOnly, kakaoKey, martLat, martLng, martRadius);
      if (r4) {
        const detailParts = [bldgName, daFinal].filter(Boolean).join(' ');
        logger.info('4차 지번 단독 검색 성공:', maskForLog(r4.road_address), '/ 세부:', maskForLog(detailParts));
        return { ...r4, detail_address: detailParts };
      }
    }
  } else {
    // 끝에 "숫자-숫자" 패턴(동-호) 분리: "대림APT 113-104" → bldg="대림APT", unit="113-104"
    const unitMatch = q.match(/^(.+?)\s+(\d+[-]\d+)$/);
    const searchQ = unitMatch ? unitMatch[1] : q;
    const unitDetail = unitMatch ? unitMatch[2] : '';
    const finalDa = [unitDetail, daFinal].filter(Boolean).join(' ') || daFinal;

    // 건물명/아파트 → 키워드 검색 (괄호 제거, APT→아파트 치환 후 검색)
    const qClean = searchQ.replace(/\(.*?\)/g, '').replace(/\bAPT\b/gi, '아파트').replace(/@/g, '아파트').trim();
    logger.info('건물명 키워드 검색:', maskForLog(qClean));
    const rk = await kakaoKeywordSearch(qClean, kakaoKey, martLat, martLng, martRadius);
    if (rk) { logger.info('키워드 검색 성공:', maskForLog(rk.road_address)); return { ...rk, detail_address: finalDa }; }

    // 주소 검색 실패 시 고객명(상호명)으로 2차 시도
    // 지하/층 등 위치 설명어 제거 후 순수 상호명만 사용
    if (fallbackName && fallbackName !== q) {
      const pureName = fallbackName.replace(/(지하|[0-9]+층|B[0-9]+|옥상)$/g, '').trim();
      logger.info('고객명으로 2차 키워드 검색:', maskForLog(pureName));
      const rk2 = await kakaoKeywordSearch(pureName, kakaoKey, martLat, martLng, martRadius);
      if (rk2) { logger.info('고객명 검색 성공:', maskForLog(rk2.road_address)); return { ...rk2, detail_address: daFinal }; }
    }
  }

  // 카카오 검색 완전 실패 — 파싱된 세부주소(daFinal)는 그대로 반환
  return { road_address: q || rawAddress, detail_address: daFinal || '', lat: null, lng: null };
}

// ══════════════════════════════════════════════════════
// geocodeAddress: 주소 → 좌표 변환 프록시
// ══════════════════════════════════════════════════════
exports.geocodeAddress = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 15, memory: '128MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const authResult = await verifyAuthAndResolveTenantId(req);
    if (authResult.authError) { res.status(authResult.authError).json({ status: 'error', message: authResult.message }); return; }

    const KAKAO_KEY = process.env.KAKAO_KEY;
    if (!KAKAO_KEY) { res.status(500).json({ status: 'error', message: 'KAKAO_KEY 미설정' }); return; }

    const { address, martLat, martLng } = req.body || {};
    if (!address) { res.status(400).json({ status: 'error', message: 'address 없음' }); return; }

    try {
      const location = await standardizeAddress(address, KAKAO_KEY, [], martLat || null, martLng || null, null);
      res.status(200).json({ status: 'success', data: location });
    } catch (err) {
      logger.error('geocodeAddress 오류:', err);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

// ══════════════════════════════════════════════════════
// reverseGeocode: 좌표 → 행정동 배치 변환 프록시
// ══════════════════════════════════════════════════════
exports.reverseGeocode = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const authResult = await verifyAuthAndResolveTenantId(req);
    if (authResult.authError) { res.status(authResult.authError).json({ status: 'error', message: authResult.message }); return; }

    const KAKAO_KEY = process.env.KAKAO_KEY;
    if (!KAKAO_KEY) { res.status(500).json({ status: 'error', message: 'KAKAO_KEY 미설정' }); return; }

    const { coords } = req.body || {};
    if (!Array.isArray(coords) || !coords.length) {
      res.status(400).json({ status: 'error', message: 'coords 없음' }); return;
    }

    try {
      const results = await Promise.all(
        coords.map(async ({ lat, lng }) => {
          if (!lat || !lng) return [];
          const r = await fetch(
            `https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?x=${lng}&y=${lat}`,
            { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } }
          );
          if (!r.ok) return [];
          const data = await r.json();
          return data.documents || [];
        })
      );
      res.status(200).json({ results });
    } catch (err) {
      logger.error('reverseGeocode 오류:', err);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

// ══════════════════════════════════════════════════════
// kakaoWaypoints: 카카오 다중경유지 경로 최적화 프록시
// ══════════════════════════════════════════════════════
exports.kakaoWaypoints = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const authResult = await verifyAuthAndResolveTenantId(req);
    if (authResult.authError) { res.status(authResult.authError).json({ status: 'error', message: authResult.message }); return; }

    const KAKAO_KEY = process.env.KAKAO_KEY;
    if (!KAKAO_KEY) { res.status(500).json({ status: 'error', message: 'KAKAO_KEY 미설정' }); return; }

    const { origin, destination, waypoints, priority } = req.body || {};
    if (!origin || !destination) {
      res.status(400).json({ status: 'error', message: 'origin/destination 없음' }); return;
    }

    try {
      const r = await fetch('https://apis-navi.kakaomobility.com/affiliate/v1/waypoints/directions100', {
        method: 'POST',
        headers: { Authorization: `KakaoAK ${KAKAO_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination, waypoints: waypoints || [], priority: priority || 'RECOMMEND' }),
      });
      if (!r.ok) {
        const errText = await r.text();
        logger.error('kakaoWaypoints Kakao 오류:', r.status, errText);
        res.status(r.status).json({ status: 'error', message: errText }); return;
      }
      const data = await r.json();
      res.status(200).json({ status: 'success', data });
    } catch (err) {
      logger.error('kakaoWaypoints 오류:', err);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

// ══════════════════════════════════════════════════════
// issueDriverToken: 기사 로그인 → Firebase Custom Token 발급
// ══════════════════════════════════════════════════════
exports.issueDriverToken = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 15, memory: '128MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ status: 'error', message: 'POST only' }); return; }

    const { tenantId, driverId, password } = req.body || {};
    if (!tenantId || !driverId || !password) {
      res.status(400).json({ status: 'error', message: '필수 파라미터 없음' }); return;
    }

    try {
      const snap = await db.ref(`tenants/${tenantId}/driverAccounts/${driverId}`).once('value');
      const driver = snap.val();
      if (!driver || !driver.active) {
        res.status(401).json({ status: 'error', message: '존재하지 않거나 비활성화된 계정입니다' }); return;
      }
      const pwMatch = driver.password.startsWith('$2') 
        ? await bcrypt.compare(password, driver.password)
        : driver.password === password; // 레거시 plain text 폴백
      if (!pwMatch) {
        res.status(401).json({ status: 'error', message: '비밀번호가 올바르지 않습니다' }); return;
      }
      const settingsSnap = await db.ref(`tenants/${tenantId}/settings`).once('value');
      const settings = settingsSnap.val() || {};
      const uid = `${tenantId}_driver_${driverId}`;
      const token = await admin.auth().createCustomToken(uid, { tenantId, driverId, role: 'driver' });
      res.status(200).json({
        status: 'success',
        token,
        tenantName: settings.martName || tenantId,
        driverName: driver.name || driverId,
      });
    } catch (err) {
      logger.error('issueDriverToken 오류:', err);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });
