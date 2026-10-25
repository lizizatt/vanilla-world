// Free flight between bodies (design/elune.md M5): the fly camera is an inertial f64 position; speed follows the nearest surface; the parent gravity well swaps with hysteresis and the frame velocity blends over 3 s, so nothing pops.
import {BODIES,centreAt,altitudeAbove,nearestSurface,parentOf,bodyOf} from './bodies.js';

/** v = max(floor, K * nearest-surface altitude): exponential climb away from a surface and braking on approach. K tuned so Azeroth->Elune takes ~30 s walking, ~10 s with Shift. */
export const FLY={walkFloor:1200,fastFloor:8000,walkK:.31,fastK:.93,minAltitude:2,blend:3};
export const flySpeed=(altitude,fast)=>Math.max(fast?FLY.fastFloor:FLY.walkFloor,(fast?FLY.fastK:FLY.walkK)*Math.max(0,altitude));

// Centre velocity in yd per real second: per-sim-unit difference times the sim rate (units per real second; 2 at 1x).
const carryOf=(body,t,rate)=>{const a=centreAt(body,t-.5),b=centreAt(body,t+.5);return b.map((v,i)=>(v-a[i])*rate);};

export function createFlight(pos,t,parent='azeroth',rate=2) {
  return {pos:pos.slice(),parent,carry:carryOf(bodyOf(parent),t,rate),from:null,age:Infinity};
}

/** input: {look,right,up (unit, inertial), forward,strafe,lift (-1..1), fast}. dt real seconds, t sim time. Returns a new state. */
export function stepFlight(state,input,dt,t) {
  const near=nearestSurface(state.pos,t),speed=flySpeed(near.altitude,input.fast)*dt;
  const move=[0,1,2].map(i=>(input.look[i]*(input.forward||0)+input.right[i]*(input.strafe||0)+input.up[i]*(input.lift||0))*speed);
  const parent=parentOf(state.pos,t,state.parent);
  let {from,age,carry}=state;
  if(parent!==state.parent){from=state.carry;age=0;}
  const target=carryOf(bodyOf(parent),t,input.simRate??2);
  if(from){age+=dt;const x=Math.min(1,age/FLY.blend),w=x*x*(3-2*x);carry=from.map((v,i)=>v+(target[i]-v)*w);if(age>=FLY.blend)from=null;}
  else carry=target;
  const pos=state.pos.map((v,i)=>v+move[i]+carry[i]*dt);
  return clampSurface({parent,pos,carry,from,age},t);
}

/** Keep the camera above every body's surface (no flying through the planet). */
export function clampSurface(state,t) {
  let pos=state.pos;
  for(const b of Object.values(BODIES)) {
    const c=centreAt(b,t),d=pos.map((v,i)=>v-c[i]),r=Math.hypot(...d),min=b.radius+FLY.minAltitude;
    if(r<min)pos=c.map((v,i)=>v+d[i]/r*min);
  }
  return {...state,pos};
}

/** Floating origin: eye position relative to a body centre, as f32-safe small numbers near that body. */
export function eyeRelative(state,body,t) {
  const c=centreAt(body,t);
  return state.pos.map((v,i)=>v-c[i]);
}
export const nearestAltitude=(state,t)=>nearestSurface(state.pos,t).altitude;
export {altitudeAbove};
