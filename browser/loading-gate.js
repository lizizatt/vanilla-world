// Loading-screen release rule: the first few terrain chunks around the player must be resident (not just the support footprint).
// The wait is bounded so a slow or partial Data folder can never hang the loading screen.
export const ARRIVAL = Object.freeze({tiles:4,models:8,npcs:4,radius:128,timeoutMs:15000,pollMs:25});
export const NEAR_CHUNKS = ARRIVAL.tiles;
export const NEAR_TIMEOUT_MS = ARRIVAL.timeoutMs;

// Require the nearest footprint, not four arbitrary tiles left over from the departure.
export function arrivalResources(scene) {
  const near=(scene.instances||[]).filter(i=>!i.distant&&i.score<=ARRIVAL.radius).sort((a,b)=>a.score-b.score);
  const models=near.filter(i=>!i.id.includes(':npc:')).slice(0,ARRIVAL.models);
  const npcs=near.filter(i=>i.id.includes(':npc:')).slice(0,ARRIVAL.npcs);
  const keys=[...new Set([...models,...npcs].map(i=>i.key))],textures=new Set();
  for(const key of keys)for(const batch of scene.cache.get(key)?.value.batches||[])
    if(batch.texture)textures.add(`texture:${batch.texture}`);
  const loaded=key=>scene.cache.has(key);
  const roots=[...scene.requests.values()].filter(r=>r.kind==='wmo'&&!r.distant&&r.score<=ARRIVAL.radius&&!loaded(r.key)).map(r=>r.key);
  const critical=[...scene.requests.values()].filter(r=>r.required&&!loaded(r.key));
  return {keys,textures:[...textures],roots,models:models.length,npcs:npcs.length,
    loaded:keys.filter(loaded).length,critical:critical.length,
    selected:!!scene.visualPosition&&scene.visualRevision===scene.revision&&scene.visualMap===scene.map&&scene.visualPlacementRevision===scene.placementRevision&&
      !!scene.position&&Math.hypot(...scene.position.map((v,i)=>v-scene.visualPosition[i]))<16,
    failed:critical.filter(r=>scene.failures.has(r.key)).length};
}

export function arrivalReadiness(state,renderer,elapsedMs) {
  const a=state?.arrival,checks=a?{
    ground:a.ground&&a.waiting===0,
    terrain:a.tiles.every(i=>state.resident.includes(i)&&renderer.tiles.has(i)),
    scenery:a.resources.selected&&!a.resources.roots.length&&a.resources.loaded===a.resources.keys.length&&
      a.resources.keys.every(k=>renderer.assets.has(k))&&
      a.resources.textures.every(k=>renderer.textures.has(k.slice(8))),
    critical:a.resources.critical===0,
  }:{ground:false,terrain:false,scenery:false,critical:false};
  const completed=Object.values(checks).filter(Boolean).length,ready=completed===4,timedOut=!ready&&elapsedMs>=ARRIVAL.timeoutMs;
  return {ready,timedOut,proceed:ready||timedOut,completed,total:4,checks,elapsedMs,
    tiles:a?.tiles.length||0,models:a?.resources.models||0,npcs:a?.resources.npcs||0,
    critical:a?.resources.critical,failed:a?.resources.failed||0};
}

export function nearChunksReady(near, elapsedMs, { need = NEAR_CHUNKS, timeoutMs = NEAR_TIMEOUT_MS } = {}) {
  if (!near || elapsedMs >= timeoutMs) return true;
  return near.resident >= Math.min(need, near.total);
}
