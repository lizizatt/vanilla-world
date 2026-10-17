const CACHE = 'racer-shell-v1';
const FILES = ['./', './index.html', './app.js', './style.css', './pkg/flats_racer_web.js', './pkg/flats_racer_web_bg.wasm'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('racer-shell-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  // Network-first avoids stale development builds; only the explicit shell is available offline.
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    return cached || new Response('Not in offline shell cache', { status: 503 });
  }));
});
