const DATABASE='vanilla-world-local-overworld';
export const LAYOUT_VERSION=3;

async function database() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DATABASE,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('saves');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('World saves are blocked by another tab.'));
  });
}
async function stored(key,record) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('saves',record===undefined?'readonly':'readwrite');
    const store=tx.objectStore('saves');
    const request=record===undefined?store.get(key):store.put(record,key);
    tx.oncomplete=()=>{db.close();resolve(request.result);};
    tx.onerror=()=>{db.close();reject(tx.error);};
    tx.onabort=()=>{db.close();reject(tx.error || new Error('World save transaction aborted.'));};
  });
}
export const worldSave=(sourceId,record)=>stored(`${LAYOUT_VERSION}:${sourceId}`,record);
export const worldTuning=(sourceId,record)=>stored(`tuning:${LAYOUT_VERSION}:${sourceId}`,record);
export const worldLiquids=(sourceId,tile,record)=>stored(`liquids:1:${sourceId}:${tile}`,record);
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
