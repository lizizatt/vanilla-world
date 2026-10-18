const CACHE = 'racer-shell-v28';
const FILES = ['./', './index.html', './world-app.js', './world-client.js', './world-worker.js', './world-renderer.js',
  './world-store.js', './world-camera.js', './camera-collision.js', './world-input.js', './world-audio.js', './world-tuning.js',
  './asset-source.js', './asset-folder.js', './scene-stream.js', './terrain-stream.js', './water-stream.js', './craft-stream.js', './flight.js',
  './style.css', './pkg/flats_racer_web.js', './pkg/flats_racer_web_bg.wasm'];
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
  if(new URL(event.request.url).pathname==='/local/npc-spawns.json') {
    event.respondWith((async()=>{
      const cache=await caches.open('world-private-population-v1');
      try {
        const response=await fetch(event.request);
        if(response.ok)await cache.put(event.request,response.clone());
        else if(response.status===404)await cache.delete(event.request);
        return response;
      } catch {
        return await cache.match(event.request) || new Response('No offline private population pack',{status:404});
      }
    })());
    return;
  }
  // Network-first avoids stale development builds; only explicitly cached local content is available offline.
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    return cached || new Response('Not in offline shell cache', { status: 503 });
  }));
});
