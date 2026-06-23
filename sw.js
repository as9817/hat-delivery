// 햇배달 Service Worker v3 — 네트워크 우선, 구 캐시 즉시 삭제
const CACHE_NAME = 'hatdelivery-v3';

self.addEventListener('install', () => {
  self.skipWaiting(); // 즉시 활성화
});

self.addEventListener('activate', e => {
  // 이전 버전 캐시 전부 삭제
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // 열린 탭 즉시 제어권 획득
  );
});

self.addEventListener('fetch', e => {
  // 항상 네트워크 우선 — 오프라인 시에만 캐시 사용
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
