// Free flight between bodies (design/elune.md M5): the fly camera is an inertial f64 position; speed follows the nearest surface; the parent gravity well swaps with hysteresis and the frame velocity blends over 3 s, so nothing pops.
import {BODIES,centreAt,altitudeAbove,nearestSurface,parentOf,bodyOf,toInertial,fromInertial} from './bodies.js';

/** v = max(floor, K * nearest-surface altitude): exponential climb away from a surface and braking on approach. K tuned so Azeroth->Elune takes ~30 s walking, ~10 s with Shift. */
export const FLY={walkFloor:1200,fastFloor:8000,walkK:.31,fastK:.93,minAltitude:2,blend:3,corotateNear:2,corotateFar:5};
export const flySpeed=(altitude,fast)=>Math.max(fast?FLY.fastFloor:FLY.walkFloor,(fast?FLY.fastK:FLY.walkK)*Math.max(0,altitude));

// Velocity of the frame in yd per real second (per-sim-unit difference times the sim rate; 2 units per real second at 1x): the centre's motion plus, near a body, the rotation of its (tidally locked) surface so a hovering camera stays above the same ground; the co-rotation fades out between corotateNear and corotateFar body radii of altitude.
const carryOf=(body,t,rate,pos)=>{
  const a=centreAt(body,t-.5),b=centreAt(body,t+.5),v=b.map((x,i)=>(x-a[i])*rate);
  if(!pos||!body.rail)return v;
  const c=centreAt(body,t),h=Math.hypot(pos[0]-c[0],pos[1]-c[1],pos[2]-c[2])/body.radius-1,x=Math.min(1,Math.max(0,(h-FLY.corotateNear)/(FLY.corotateFar-FLY.corotateNear))),s=1-x*x*(3-2*x);
  if(s<=0)return v;
  const p=fromInertial(body,pos,t),p0=toInertial(body,p,t-.5),p1=toInertial(body,p,t+.5);
  return v.map((x,i)=>x+s*((p1[i]-p0[i])*rate-x));
};

export function createFlight(pos,t,parent='azeroth',rate=2) {
  return {pos:pos.slice(),parent,carry:carryOf(bodyOf(parent),t,rate,pos),from:null,age:Infinity};
}

/** input: {look,right,up (unit, inertial), forward,strafe,lift (-1..1), fast}. dt real seconds, t sim time. Returns a new state. */
export function stepFlight(state,input,dt,t) {
  const near=nearestSurface(state.pos,t),speed=flySpeed(near.altitude,input.fast)*dt;
  const move=[0,1,2].map(i=>(input.look[i]*(input.forward||0)+input.right[i]*(input.strafe||0)+input.up[i]*(input.lift||0))*speed);
  const parent=parentOf(state.pos,t,state.parent);
  let {from,age,carry}=state;
  if(parent!==state.parent){from=state.carry;age=0;}
  const target=carryOf(bodyOf(parent),t,input.simRate??2,state.pos);
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
