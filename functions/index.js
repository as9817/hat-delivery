/**
 * 햇배달 - 영수증 OCR 파이프라인
 * Firebase Cloud Functions (2세대 HTTP)
 * 파이프라인: Vision API → Gemini API → Kakao Local API
 */

const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

exports.processReceipt = onRequest(
  {
    region: 'asia-northeast3',
    timeoutSeconds: 60,
    memory: '512MiB',
  },
  async (req, res) => {
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
  }
);

async function extractTextWithVision(base64Image, apiKey) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: base64Image }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }] }),
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
  const prompt = "너는 마트 영수증 데이터 파싱 전문가야. 1. 고객명('성명:' 옆 텍스트, '합계금액' 무시), 2. 연락처('010' 패턴), 3. 주소('주소:' 뒤 한 줄 병합). 반드시 JSON({name,phone,address})으로만 응답.\n\n[OCR]\n" + rawText;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 256 } }) }
  );
  if (!res.ok) { const e = await res.json(); throw new Error(`Gemini: ${e.error?.message || res.status}`); }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const m = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Gemini: JSON 없음');
  return JSON.parse(m[0]);
}

async function standardizeAddress(rawAddress, kakaoKey) {
  if (!rawAddress?.trim()) return { road_address: '', detail_address: '', lat: null, lng: null };
  const dm = rawAddress.match(/\d+호|\d+동|\d+층/);
  const da = dm ? dm[0] : '';
  const q  = da ? rawAddress.slice(0, rawAddress.lastIndexOf(da)).trim() : rawAddress.trim();
  const res = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(q)}&size=1`, { headers: { Authorization: `KakaoAK ${kakaoKey}` } });
  if (!res.ok) throw new Error(`Kakao: ${res.status}`);
  const data = await res.json();
  const doc = data.documents?.[0];
  if (!doc) return { road_address: q, detail_address: da, lat: null, lng: null };
  return { road_address: doc.road_address?.address_name || doc.address?.address_name || q, detail_address: da, lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
}
