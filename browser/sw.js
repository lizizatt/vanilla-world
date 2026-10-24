const CACHE = 'racer-shell-v155';
const FILES = ['./', './index.html', './world-app.js', './world-client.js', './world-worker.js', './world-renderer.js',
  './world-store.js', './world-camera.js', './wreck.js', './beam.js', './world-view.js', './camera-collision.js', './world-input.js', './world-audio.js', './world-tuning.js',
  './asset-source.js', './asset-folder.js', './swe1r/folder.js', './swe1r/attach.js', './swe1r/cache.js', './swe1r/ui.js', './swe1r/block.js', './swe1r/comp.js', './swe1r/image.js', './swe1r/names.js', './swe1r/model.js', './swe1r/pod.js', './swe1r/skin.js', './swe1r/sfx.js', './swe1r/hud.js', './swe1r/voice-map.js', './swe1r/voice-map.json', './scene-stream.js', './npc-pack.js', './terrain-stream.js', './water-stream.js', './craft-stream.js', './flight.js',
  './far-worker.js', './far-stream.js', './far-channel.js', './asset-worker.js', './asset-channel.js', './loading-art.js',
  './water-shader.js', './music.js', './sky.js', './space.js', './globe-patches.js', './planet-frame.js', './tile-registry.js', './height-bake.js', './adt-synth.js', './demo-source.js', './orient.js', './clouds.js','./particles.js','./actors.js','./hud-model.js','./wander.js','./shadow.js', './race.js', './race-flags.js', './race-gate-preview.js', './race-gates.js', './track-edit.js', './track-editor.js', './vehicles.js', './glb.js', './vehicle-model.js', './tracks/steamwheedle.json', './tracks/track-to-sea.json', './tracks/if-airport-track.json', './world-music.js', './ocean-mesh.js', './worldmap.js', './map-panel.js', './style.css', './icon.svg', './pkg/flats_racer_web.js', './pkg/flats_racer_web_bg.wasm'];
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
