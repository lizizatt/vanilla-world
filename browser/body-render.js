// Multi-body render planning (design/elune.md M3): which bodies to draw, in what order, and a depth range that survives inter-body distances.
import {BODIES,centreAt,altitudeAbove} from './bodies.js';

/** Angular radius (rad) of a body seen from eye p at time t. */
export function angularRadius(body,p,t) {
  const c=centreAt(body,t),d=Math.hypot(p[0]-c[0],p[1]-c[1],p[2]-c[2]);
  return d<=body.radius?Math.PI/2:Math.asin(body.radius/d);
}
/** Impostor below this angular radius is a lit disc; above it the body is drawn as chunked globe patches. */
export const IMPOSTOR_ANGLE=.004;

/** Bodies sorted far to near with their draw mode, so nearer bodies overpaint and own the depth buffer. */
export function bodyDrawList(p,t,ids=Object.keys(BODIES)) {
  return ids.map(id=>{
    const b=BODIES[id],c=centreAt(b,t),dist=Math.hypot(p[0]-c[0],p[1]-c[1],p[2]-c[2]),ang=angularRadius(b,p,t);
    return {id,distance:dist,surface:dist-b.radius,angle:ang,mode:ang<IMPOSTOR_ANGLE?'impostor':'patches'};
  }).sort((a,b)=>b.distance-a.distance);
}

/** Reversed-Z depth range: near scales with the nearest surface (keeps precision at a pod's feet and in deep space); far is the farthest limb plus margin. */
export function depthRange(p,t,{minNear=.25,farMargin=1.25}={}) {
  let nearest=Infinity,far=0;
  for(const b of Object.values(BODIES)) {
    nearest=Math.min(nearest,altitudeAbove(b,p,t));
    const c=centreAt(b,t);far=Math.max(far,Math.hypot(p[0]-c[0],p[1]-c[1],p[2]-c[2])+b.radius);
  }
  const near=Math.max(minNear,Math.min(nearest*.05,50000));
  return {near,far:far*farMargin,ratio:far*farMargin/near};
}
/** Past ~1e7 near:far a 24-bit float depth buffer loses sub-pixel ordering; split into a near layer and a far layer drawn with separate ranges. */
export const MAX_DEPTH_RATIO=1e7;
export function depthLayers(p,t,opts) {
  const r=depthRange(p,t,opts);
  if(r.ratio<=MAX_DEPTH_RATIO)return [{near:r.near,far:r.far}];
  const split=Math.sqrt(r.near*r.far);
  return [{near:split,far:r.far},{near:r.near,far:split*1.01}];
}
