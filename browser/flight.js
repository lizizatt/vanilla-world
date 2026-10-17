import { readRoute, writeRouteView } from './voyage-store.js';

export function worldBounds(manifest) {
  return manifest.horizons.map(h => {
    const r=manifest.regions[h.region],s=1600/3;
    return [r.placement[0]+(h.source_bounds[0]-r.tile_origin[0])*s,
      r.placement[1]+(h.source_bounds[1]-r.tile_origin[1])*s,
      r.placement[0]+(h.source_bounds[2]-r.tile_origin[0])*s,
      r.placement[1]+(h.source_bounds[3]-r.tile_origin[1])*s];
  });
}
export function overview(manifest) {
  const bounds=worldBounds(manifest);
  const x0=Math.min(...bounds.map(b=>b[0])),z0=Math.min(...bounds.map(b=>b[1]));
  const x1=Math.max(...bounds.map(b=>b[2])),z1=Math.max(...bounds.map(b=>b[3]));
  const size=Math.max(x1-x0,z1-z0);
  return [(x0+x1)/2,size*.75,(z0+z1)/2+size*.34,0,-1.15];
}
export function moveFlight(pose,keys,dt) {
  const p=pose.slice(),down=k=>Number(keys.has(k));
  p[3]+=(down('ArrowLeft')-down('ArrowRight'))*dt;
  p[4]=Math.max(-1.55,Math.min(1.55,p[4]+(down('ArrowUp')-down('ArrowDown'))*dt));
  const speed=(keys.has('ShiftLeft') || keys.has('ShiftRight') ? 8000 : 1200)*dt;
  const f=down('KeyW')-down('KeyS'),s=down('KeyD')-down('KeyA');
  p[0]+=(-Math.sin(p[3])*Math.cos(p[4])*f+Math.cos(p[3])*s)*speed;
  p[2]+=(-Math.cos(p[3])*Math.cos(p[4])*f-Math.sin(p[3])*s)*speed;
  p[1]=Math.max(-10000,Math.min(150000,p[1]+(Math.sin(p[4])*f+down('KeyE')-down('KeyQ'))*speed));
  return p;
}
export async function saveFlight(pack,pose) {
  await writeRouteView({version:1,packId:pack.id,pose});
}
export async function loadFlight(pack) {
  const view=await readRoute('meta','view');
  if (!view) return overview(pack.manifest);
  if (view.version!==1 || view.packId!==pack.id || !Array.isArray(view.pose) || view.pose.length!==5
    || !view.pose.every(v=>typeof v==='number' && Number.isFinite(v) && Math.abs(v)<1e12)
    || view.pose[1]<-10000 || view.pose[1]>150000 || Math.abs(view.pose[4])>1.55) {
    throw new Error('Free-flight save incompatible or damaged. Overview then Save replaces it explicitly; driving saves are untouched.');
  }
  return view.pose;
}
