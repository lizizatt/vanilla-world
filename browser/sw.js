// Stamped by server.mjs and build-dist.mjs from shell-manifest.mjs (import graph); unstamped copies skip precaching and stay network-first.
const SHELL = /*SHELL_MANIFEST*/null;
const CACHE = 'racer-shell-' + (SHELL?.hash ?? 'unstamped');
const FILES = SHELL?.files.filter(f => f !== './sw.js') ?? [];
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
  if(new URL(event.request.url).pathname.endsWith('/local/npc-spawns.json')) {
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
