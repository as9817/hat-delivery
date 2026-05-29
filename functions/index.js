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

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.database();

exports.processReceipt = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 60, memory: '512MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ status: 'error', message: 'POST only' }); return; }

    const { imageBase64 } = req.body;
    if (!imageBase64) { res.status(400).json({ status: 'error', message: 'imageBase64 없음' }); return; }

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
      // 마트 지역 읽어서 짧은 지번 주소 앞에 붙이기
      let martDistrict = '';
      try {
        const martSnap = await db.ref('settings/martLocation').once('value');
        const martData = martSnap.val();
        // 구 단위까지만 추출 (동 붙이면 다른 동 지번 검색 시 오류)
        const baseAddr = martData?.oldAddress || martData?.address || '';
        const m = baseAddr.match(/^(.+?(?:구|군))/);
        if (m) martDistrict = m[1].trim();
      } catch(e) { logger.warn('마트 위치 읽기 실패'); }

      const queryAddr = (martDistrict && parsed.address && /^\d/.test(parsed.address))
        ? martDistrict + ' ' + parsed.address
        : parsed.address;
      logger.info('Kakao 검색 주소:', queryAddr);
      const martCoords = await db.ref('settings/martLocation').once('value').then(s => s.val()).catch(() => null);
      const location = await standardizeAddress(queryAddr, KAKAO_KEY, martCoords?.lat, martCoords?.lng);

      res.status(200).json({
        status: 'success',
        data: {
          customer: { name: parsed.name || '', phone: parsed.phone || '' },
          location: {
            road_address:   location.road_address   || parsed.address || '',
            detail_address: location.detail_address || '',
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
  const prompt = `너는 마트 영수증 데이터 파싱 전문가야. 아래 OCR 텍스트에서 다음 4가지를 추출해:
1. name: 고객명 ('성명:' 옆 텍스트. '합계금액' 키워드 자체는 이름이 아님)
2. phone: 연락처 ('010'으로 시작하는 전화번호)
3. address: 주소 ('주소:' 뒤 텍스트 한 줄 병합)
4. totalAmount: 합계금액 (영수증에서 '합계', '합 계', '총합계', '결제금액' 키워드 바로 옆/아래 숫자. 쉼표 제거한 순수 숫자만. 상품 바코드나 상품코드가 아닌 최종 결제 금액)

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
  return JSON.parse(m[0]);
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

    // 인증 토큰 확인
    const AUTH_TOKEN = process.env.ORDER_AUTH_TOKEN || 'hatdelivery2026';
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

      // 4. Firebase RTDB에 주문 저장
      const orderId = 'ext_' + Date.now();
      const order = {
        id:           orderId,
        customerName: finalName   || '미확인',
        address:      finalAddress,
        phone:        parsed.phone   || sender || '-',
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

async function standardizeAddress(rawAddress, kakaoKey, martLat, martLng) {
  if (!rawAddress?.trim()) return { road_address: '', detail_address: '', lat: null, lng: null };
  const dm = rawAddress.match(/\d+호|\d+동|\d+층/);
  const da = dm ? dm[0] : '';
  const q  = da ? rawAddress.slice(0, rawAddress.lastIndexOf(da)).trim() : rawAddress.trim();

  // 1차: 주소 검색 API
  const res = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(q)}&size=1`, { headers: { Authorization: `KakaoAK ${kakaoKey}` } });
  if (!res.ok) throw new Error(`Kakao: ${res.status}`);
  const data = await res.json();
  const doc = data.documents?.[0];
  if (doc) {
    return { road_address: doc.road_address?.address_name || doc.address?.address_name || q, detail_address: da, lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
  }

  // 2차: 마트 좌표 기준 반경 3km 키워드 검색 (지번만 있을 때 동 이름 없이도 찾기)
  if (martLat && martLng) {
    const pureNum = rawAddress.match(/^\d+[\-\d\s]*\d*/)?.[0]?.trim();
    if (pureNum) {
      logger.info('Kakao 2차 검색 (좌표 기반):', pureNum);
      const res2 = await fetch(
        `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(pureNum)}&size=5`,
        { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
      );
      if (res2.ok) {
        const data2 = await res2.json();
        // 마트 좌표와 가장 가까운 결과 선택
        const docs = data2.documents || [];
        let best = null, bestDist = Infinity;
        for (const d of docs) {
          const dlat = parseFloat(d.y), dlng = parseFloat(d.x);
          const dist = Math.sqrt((dlat - martLat) ** 2 + (dlng - martLng) ** 2);
          if (dist < bestDist) { bestDist = dist; best = d; }
        }
        if (best) {
          logger.info('Kakao 2차 검색 성공:', best.road_address?.address_name || best.address?.address_name);
          return { road_address: best.road_address?.address_name || best.address?.address_name || q, detail_address: da, lat: parseFloat(best.y), lng: parseFloat(best.x) };
        }
      }
    }
  }

  return { road_address: q, detail_address: da, lat: null, lng: null };
}
