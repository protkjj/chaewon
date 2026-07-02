// Service Worker - Network-First 전략
//
// 동작 방식:
// 1. 항상 서버에서 최신 파일을 먼저 가져옴
// 2. 성공하면 캐시에도 저장 (오프라인 대비)
// 3. 서버 연결 실패 시(오프라인)에만 캐시에서 불러옴
//
// 이렇게 하면 코드를 수정해도 새로고침만 하면 바로 반영됨

const CACHE_NAME = 'flashcard-v3';

// install: 기본 파일들을 미리 캐시 (오프라인 첫 접속 대비)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['./', './index.html', './style.css', './app.js'])
    )
  );
  self.skipWaiting();
});

// activate: 이전 버전 캐시 삭제
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// fetch: 네트워크 우선, 실패 시 캐시
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request)
      .then(response => {
        // 성공하면 캐시에도 저장
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return response;
      })
      .catch(() => {
        // 오프라인이면 캐시에서
        return caches.match(e.request);
      })
  );
});
