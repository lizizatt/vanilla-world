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
// Tuning (yd, yd/s): walk/fast cruise speed, altitude floor and ceiling, and the boost law's 1x..40x span.
export const FLIGHT=Object.freeze({walkSpeed:1200,fastSpeed:8000,floor:-10000,ceiling:1000000,pitch:Math.PI/2,boostFrom:1000,boostMax:40});
export const FLIGHT_CEILING=FLIGHT.ceiling,FLIGHT_PITCH=FLIGHT.pitch;
export function flightBoost(altitude) {
  const t=Math.min(1,Math.max(0,Math.log(Math.max(altitude,1)/FLIGHT.boostFrom)/Math.log(FLIGHT.ceiling/FLIGHT.boostFrom)));
  return FLIGHT.boostMax**(t*t*(3-2*t));
}/** With `aim` ({look,right} from the quaternion camera) the caller owns turning and the direction vectors come from it. */
export function moveFlight(pose,keys,dt,aim) {
  const p=pose.slice(),down=k=>Number(keys.has(k));
  if(!aim){p[3]+=(down('ArrowLeft')-down('ArrowRight'))*dt;
    p[4]=Math.max(-FLIGHT_PITCH,Math.min(FLIGHT_PITCH,p[4]+(down('ArrowUp')-down('ArrowDown'))*dt));}
  const look=aim?.look??[-Math.sin(p[3])*Math.cos(p[4]),Math.sin(p[4]),-Math.cos(p[3])*Math.cos(p[4])],right=aim?.right??[Math.cos(p[3]),0,-Math.sin(p[3])];
  const speed=(keys.has('ShiftLeft') || keys.has('ShiftRight') ? FLIGHT.fastSpeed : FLIGHT.walkSpeed)*dt,boost=flightBoost(p[1]),horizontal=speed*Math.sqrt(boost),vertical=speed*boost;
  const f=down('KeyW')-down('KeyS'),s=down('KeyD')-down('KeyA');
  p[0]+=(look[0]*f+right[0]*s)*horizontal;
  p[2]+=(look[2]*f+right[2]*s)*horizontal;
  p[1]=Math.max(FLIGHT.floor,Math.min(FLIGHT.ceiling,p[1]+(look[1]*f+down('KeyE')-down('KeyQ'))*vertical));
  let flipped;[p[0],p[2],flipped]=wrapFlat(p[0],p[2]);if(flipped){p[3]+=Math.PI;p.poleFlip=true;}
  return p;
}
