// v7 - geocodeAddress 엔드포인트 추가
const functions = require('firebase-functions');
const logger = require('firebase-functions/logger');

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

    logger.info('Keys check:', { vision: !!VISION_KEY, gemini: !!GEMINI_KEY, kakao: !!KAKAO_KEY });

    if (!VISION_KEY || !GEMINI_KEY || !KAKAO_KEY) {
      res.status(500).json({ status: 'error', message: 'API 키 환경변수 미설정' }); return;
    }

    try {
      logger.info('STEP 1: Vision API');
      const rawText = await extractTextWithVision(imageBase64, VISION_KEY);

      logger.info('STEP 2: Gemini API');
      const parsed = await parseWithGemini(rawText, GEMINI_KEY);

      logger.info('STEP 3: Kakao API');
      const location = await standardizeAddress(parsed.address, KAKAO_KEY);

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
        },
      });
    } catch (err) {
      logger.error('오류:', err);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

async function extractTextWithVision(base64Image, apiKey) {
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content: base64Image }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }] }),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(`Vision: ${e.error?.message || res.status}`); }
  const data = await res.json();
  const ann = data.responses?.[0]?.fullTextAnnotation || data.responses?.[0]?.textAnnotations?.[0];
  if (!ann) throw new Error('Vision: 텍스트 인식 실패');
  return ann.text || ann.description || '';
}

async function parseWithGemini(rawText, apiKey) {
  const prompt = "너는 마트 영수증 데이터 파싱 전문가야. 아래 OCR 텍스트에서 1. 고객명('성명:' 옆), 2. 연락처('010' 패턴), 3. 주소('주소:' 뒤 전체)를 추출해서 {\"name\":\"...\",\"phone\":\"...\",\"address\":\"...\"} 형식의 JSON으로만 응답해.\n\n[OCR]\n" + rawText;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 512,
        responseMimeType: 'application/json'
      }
    }),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(`Gemini: ${e.error?.message || res.status}`); }
  const data = await res.json();
  logger.info('Gemini raw response:', JSON.stringify(data.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 200)));
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw.trim()) throw new Error('Gemini: 응답 없음');
  try {
    return JSON.parse(raw);
  } catch (e) {
    const m = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Gemini: JSON 없음 - raw: ' + raw.slice(0, 100));
    return JSON.parse(m[0]);
  }
}

// ── 주소 → 좌표 변환 엔드포인트 (수동 입력용)
exports.geocodeAddress = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ status: 'error', message: 'POST only' }); return; }

    const { address } = req.body;
    if (!address) { res.status(400).json({ status: 'error', message: 'address 없음' }); return; }

    const KAKAO_KEY = process.env.KAKAO_KEY;
    if (!KAKAO_KEY) { res.status(500).json({ status: 'error', message: 'KAKAO_KEY 미설정' }); return; }

    try {
      const location = await standardizeAddress(address, KAKAO_KEY);
      res.status(200).json({ status: 'success', data: location });
    } catch (err) {
      logger.error('geocodeAddress 오류:', err);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

async function standardizeAddress(rawAddress, kakaoKey) {
  if (!rawAddress?.trim()) return { road_address: '', detail_address: '', lat: null, lng: null };
  const dm = rawAddress.match(/\d+호|\d+동|\d+층/);
  const da = dm ? dm[0] : '';
  const q  = da ? rawAddress.slice(0, rawAddress.lastIndexOf(da)).trim() : rawAddress.trim();
  const res = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(q)}&size=1`, {
    headers: { Authorization: `KakaoAK ${kakaoKey}` },
  });
  if (!res.ok) throw new Error(`Kakao: ${res.status}`);
  const data = await res.json();
  const doc = data.documents?.[0];
  if (!doc) return { road_address: q, detail_address: da, lat: null, lng: null };
  return { road_address: doc.road_address?.address_name || doc.address?.address_name || q, detail_address: da, lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
}
