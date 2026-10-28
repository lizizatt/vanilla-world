const DATABASE='vanilla-world-local-overworld';
export const LAYOUT_VERSION=4;
let connection;

function database() {
  if(connection)return connection;
  const pending=new Promise((resolve,reject)=>{
    let failed=false;
    const request=indexedDB.open(DATABASE,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('saves');
    request.onsuccess=()=>{
      const db=request.result;
      if(failed){db.close();return;}
      const invalidate=()=>{if(connection===pending)connection=undefined;};
      db.onversionchange=()=>{invalidate();db.close();};
      db.onclose=invalidate;
      resolve(db);
    };
    request.onerror=()=>{failed=true;reject(request.error);};
    request.onblocked=()=>{failed=true;reject(new Error('World saves are blocked by another tab.'));};
  });
  connection=pending;
  void pending.catch(()=>{if(connection===pending)connection=undefined;});
  return pending;
}
async function stored(key,record) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('saves',record===undefined?'readonly':'readwrite');
    const store=tx.objectStore('saves');
    const request=record===undefined?store.get(key):store.put(record,key);
    tx.oncomplete=()=>resolve(request.result);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error || new Error('World save transaction aborted.'));
  });
}
export const worldSave=(sourceId,record)=>stored(`${LAYOUT_VERSION}:${sourceId}`,record);
export const worldTuning=(sourceId,record)=>stored(`tuning:${LAYOUT_VERSION}:${sourceId}`,record);
export const raceScores=(trackId,record)=>stored(`race:1:${trackId}`,record);
export const trackOverride=(id,record)=>stored(`track:1:${id}`,record);
export const worldLiquids=(sourceId,tile,record)=>stored(`liquids:2:${sourceId}:${tile}`,record);
/** Locally derived far-horizon minimap colour (32x32 RGBA per tile), keyed by data fingerprint; never committed or shipped. */
export const farMinimap=(sourceId,tile,record)=>stored(`minimap:1:${sourceId}:${tile}`,record);
/** Generated parchment map (webp blob + the far-tile count it was drawn from), keyed by data fingerprint and chart frame; derived from the user's data, never committed. */
export const mapBitmap=(sourceId,key,record)=>stored(`map:2:${sourceId}:${key}`,record);
export function validateWorldSave(save,sourceId) {
  if (!save) return;
  const pose=p=>Array.isArray(p) && p.length===4 && p.every(v=>typeof v==='number' && Number.isFinite(v) && Math.abs(v)<1e12);
  const camera=p=>Array.isArray(p) && p.length===5 && p.every(v=>typeof v==='number' && Number.isFinite(v) && Math.abs(v)<1e12)
    && p[1]>=-10000 && p[1]<=150000 && Math.abs(p[4])<=1.55;
  if (save.version!==1 || save.layout!==LAYOUT_VERSION || save.sourceId!==sourceId
    || !['drive','fly'].includes(save.mode) || !pose(save.vehicle)
    || (save.mode==='fly' && !camera(save.camera))
    || !save.settings || typeof save.settings.horizon!=='boolean' || typeof save.settings.scenery!=='boolean'
    || (save.settings.distant!==undefined && typeof save.settings.distant!=='boolean')
    || (save.settings.sound!==undefined && typeof save.settings.sound!=='boolean')
    || (save.settings.cockpit!==undefined && typeof save.settings.cockpit!=='boolean')
    || (save.settings.controls!==undefined && !['native','legacy'].includes(save.settings.controls))
    || (save.settings.cameraDistance!==undefined && (typeof save.settings.cameraDistance!=='number'
      || !Number.isFinite(save.settings.cameraDistance) || save.settings.cameraDistance<0 || save.settings.cameraDistance>50))) {
    throw new Error('Saved world state is incompatible or damaged. It has been retained; choose Start at raceway to recover.');
  }
}
