// Hop pre-streaming (design/poles.md 19): the wasm hop is atomic and only lands on resident terrain, so the tiles just across a frame boundary
// must already be loaded by the time the pod (or fly camera) gets there. Pure: given a position, say which global points the engine should stream around.
import {FRAME_IDS,POLE_ANCHORS,chartToDir,dirToChart,bodyLat,frameFor,hop} from './frames.js';
import {focusRegionOf} from './world-worker-logic.js';

/** Frame index (0 E, 1 N, 2 S) whose region contains global point p = [x, z]. */
export const frameOfPoint=(manifest,p)=>manifest.regions[focusRegionOf(manifest,[p[0],0,p[1]])]?.frame||0;

const anchor=id=>POLE_ANCHORS[id]||[0,0];
const dirAtLat=(d,lat)=>{const lon=Math.atan2(d[2],d[0]),c=Math.cos(lat);return [c*Math.cos(lon),Math.sin(lat),c*Math.sin(lon)];};

/**
 * Global points on the far side of the frame boundary nearest to p: where the pod would land if it hopped now, and one step further in.
 * Empty unless p is within `margin` (rad of latitude) of the boundary. `spec` is the wasm pole spec (radius, centre, handoff, hysteresis).
 */
export function hopTargets(spec,frameIndex,p,margin) {
  const id=FRAME_IDS[frameIndex]||'E',a=anchor(id),d=chartToDir(id,p[0]-a[0],p[1]-a[1],spec.centre,spec.radius),lat=bodyLat(d),abs=Math.abs(lat),sign=lat<0?-1:1;
  const out=[];
  if(id==='E') {
    if(abs<spec.handoff-margin)return out;
    const to=sign>0?'N':'S';
    for(const l of [spec.handoff,spec.handoff+margin/2]){const c=dirToChart(to,dirAtLat(d,sign*Math.min(l,Math.PI/2-1e-3)),spec.centre,spec.radius),o=anchor(to);out.push([c[0]+o[0],c[1]+o[1]]);}
    return out;
  }
  if(abs>spec.handoff+margin)return out;
  for(const l of [spec.handoff-spec.hysteresis,spec.handoff-spec.hysteresis-margin/2])out.push(dirToChart('E',dirAtLat(d,sign*l),spec.centre,spec.radius));
  return out;
}

/**
 * Pod-launch landing: a journey is flown in the E chart, so a touchdown poleward of the handoff has no E terrain under it.
 * Returns the wasm landing [x, y, z, yaw, frame] (frame-local chart pose) and the velocity re-expressed in that chart, or undefined to land in E as before.
 */
export function poleLanding(spec,pose,yaw,velocity) {
  if(!spec)return;
  const d=chartToDir('E',pose[0],pose[2],spec.centre,spec.radius),to=frameFor(d,'E',spec);
  if(to==='E')return;
  const h=hop({x:pose[0],z:pose[2],yaw,vx:velocity[0],vz:velocity[2]},'E',to,spec.centre,spec.radius);
  return {pose:[h.x,pose[1],h.z,h.yaw,FRAME_IDS.indexOf(to)],velocity:[h.vx,velocity[1],h.vz]};
}