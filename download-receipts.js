// 영수증 사진 일괄 다운로드
// 사용법: node download-receipts.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const ORDERS_JSON = path.join(__dirname, 'orders.json');
const OUT_DIR = path.join(__dirname, '영수증_다운로드');

if (!fs.existsSync(ORDERS_JSON)) {
  console.error('orders.json이 없습니다. 먼저 아래 명령으로 내려받으세요:');
  console.error('firebase database:get /orders --project wellbingmart-d5ee1 -o orders.json');
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const orders = JSON.parse(fs.readFileSync(ORDERS_JSON, 'utf-8'));

function download(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

(async () => {
  let count = 0, fail = 0;
  for (const [orderId, order] of Object.entries(orders)) {
    if (!order || !order.receiptPhotoUrl) continue;
    const date = order.createdAt ? new Date(order.createdAt).toISOString().slice(0,10) : 'unknown';
    const name = (order.customerName || order.customer?.name || '고객').replace(/[\\/:*?"<>|]/g, '_');
    const ext = '.jpg';
    const fileName = `${date}_${name}_${orderId}${ext}`;
    const filePath = path.join(OUT_DIR, fileName);
    try {
      await download(order.receiptPhotoUrl, filePath);
      count++;
      console.log('다운로드:', fileName);
    } catch (e) {
      fail++;
      console.warn('실패:', fileName, e.message);
    }
  }
  console.log(`\n완료: ${count}개 성공, ${fail}개 실패`);
  console.log('저장 위치:', OUT_DIR);
})();
