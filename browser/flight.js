import {wrapFlat} from './space.js';
function worldBounds(manifest) {
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
// Speed law: 1x up to 1 kyd, then 40x by 1000 kyd, log-spaced and smoothstepped so speed is continuous (C1) in altitude on ascent and descent. Horizontal speed uses sqrt of it so angular travel around the globe stays controllable.
export const FLIGHT_CEILING=1000000,FLIGHT_PITCH=Math.PI/2;
export function flightBoost(altitude) {
  const t=Math.min(1,Math.max(0,Math.log(Math.max(altitude,1)/1000)/Math.log(1000)));
  return 40**(t*t*(3-2*t));
}export function moveFlight(pose,keys,dt) {
  const p=pose.slice(),down=k=>Number(keys.has(k));
  p[3]+=(down('ArrowLeft')-down('ArrowRight'))*dt;
  p[4]=Math.max(-FLIGHT_PITCH,Math.min(FLIGHT_PITCH,p[4]+(down('ArrowUp')-down('ArrowDown'))*dt));
  const speed=(keys.has('ShiftLeft') || keys.has('ShiftRight') ? 8000 : 1200)*dt,boost=flightBoost(p[1]),horizontal=speed*Math.sqrt(boost),vertical=speed*boost;
  const f=down('KeyW')-down('KeyS'),s=down('KeyD')-down('KeyA');
  p[0]+=(-Math.sin(p[3])*Math.cos(p[4])*f+Math.cos(p[3])*s)*horizontal;
  p[2]+=(-Math.cos(p[3])*Math.cos(p[4])*f-Math.sin(p[3])*s)*horizontal;
  p[1]=Math.max(-10000,Math.min(FLIGHT_CEILING,p[1]+(Math.sin(p[4])*f+down('KeyE')-down('KeyQ'))*vertical));
  [p[0],p[2]]=wrapFlat(p[0],p[2]);
  return p;
}
