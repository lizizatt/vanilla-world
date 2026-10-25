// Clock/sky/light coupling across bodies (design/elune.md M4). Pure functions on the shared inertial frame of bodies.js.
import {sunDirection} from './clouds.js';
import {daylightAt} from './sim-clock.js';
import {BODIES,centreAt,axesAt} from './bodies.js';

/** Sun as a unit direction in the inertial frame. The legacy sun is expressed in the local view frame (east, up, south); Azeroth's frame at chart [0,0] is east=+Z, up=+X, south=-Y, so the sun circles Azeroth about Y once per day. */
export function sunInertial(t) {
  const [e,u,s]=sunDirection(t);
  return [u,-s,e];
}
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm=a=>{const n=Math.hypot(...a);return a.map(v=>v/n);};

/** Sun direction in a body's local frame (x lon0/lat0, y north, z lon+90). Azeroth: identity. */
export function sunInBody(body,t) {
  const a=axesAt(body,t),s=sunInertial(t);
  return [dot(a[0],s),dot(a[1],s),dot(a[2],s)];
}

/** Sun elevation (sin of the angle above the local horizon) at a body-local unit up vector. */
export const sunElevation=(body,t,up)=>dot(sunInBody(body,t),up);

/** Daylight 0..1. Azeroth keeps the existing clock curve (bit-identical); airless Elune has a sharp terminator from the true sun elevation. */
export function daylightFor(body,t,up) {
  if(body.id==='azeroth')return daylightAt(t);
  const e=sunElevation(body,t,up),x=Math.min(1,Math.max(0,(e+.02)/.1));
  return x*x*(3-2*x);
}

/** Fraction (0..1) of body A's disc lit as seen from body B: 1 is full. */
export function litFraction(a,b,t) {
  const toViewer=norm(centreAt(b,t).map((v,i)=>v-centreAt(a,t)[i])),s=sunInertial(t);
  return (1+dot(toViewer,s))/2;
}
/** Earthshine on Elune's night side: Azeroth's lit fraction seen from Elune, scaled to a small ambient floor. */
export const earthshine=t=>.02+.05*litFraction(BODIES.azeroth,BODIES.elune,t);

/** Ambient floor for a body: Azeroth unchanged (handled by its own day/night curve), Elune black sky plus earthshine. */
export const ambientFor=(body,t)=>body.id==='azeroth'?null:.03+earthshine(t);

/** Sim-time warp clamp: close to a body the sim scale must not outrun a pod; returns the largest allowed scale of [0,1,10,100,1000]. */
export function warpClamp(nearestSurfaceYd,scales=[0,1,10,100,1000]) {
  const cap=nearestSurfaceYd<2e3?1:nearestSurfaceYd<2e4?10:nearestSurfaceYd<1e5?100:1000;
  return Math.max(...scales.filter(s=>s<=cap));
}
