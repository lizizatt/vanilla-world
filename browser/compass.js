// Flight instruments (pure): the compass needle toward the NEAREST body's north pole, and the altitude above that body.
// The screen-right vector decides which side the pole is on, so the result does not depend on the coordinate handedness.
// Everything is computed in inertial space from the camera's chart pose and view basis, so one formula holds on the ground, in orbit, on Elune and in the N/S pole charts.
import {BODIES,centreAt,axesAt,toInertial,nearestSurface} from './bodies.js';
import {chartAxes} from './shared-flight.js';

/** Below this |pole-tangent| (sin of the colatitude, ~0.6 deg) the pole is straight overhead/underfoot and a bearing is meaningless. */
export const OVERHEAD=.01;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const unit=a=>{const n=Math.hypot(...a);return n>0?[a[0]/n,a[1]/n,a[2]/n]:[0,0,0];};
const along=(v,r)=>{const k=dot(v,r);return [v[0]-k*r[0],v[1]-k*r[1],v[2]-k*r[2]];};

/** Needle angle (rad, clockwise from the dial's top = the camera's heading over the local horizon) toward the pole,
 *  for a craft at radial `radial` (unit, centre -> craft) with view basis `look`/`up`/`right` and body north `pole`, all inertial unit vectors.
 *  Looking down, the horizon heading is the camera's up vector (it leans toward the heading); looking up, it is opposite. */
export function poleAngle(radial,pole,look,up,right) {
  const n=along(pole,radial),size=Math.hypot(...n);
  if(size<OVERHEAD)return {angle:0,overhead:true};
  const sign=dot(look,radial)>0?-1:1,l=along(look,radial),u=along(up,radial);
  const f=unit([l[0]+sign*u[0],l[1]+sign*u[1],l[2]+sign*u[2]]);
  if(!(Math.hypot(...f)>0))return {angle:0,overhead:false};
  return {angle:Math.atan2(dot(n,along(right,radial)),dot(n,f)),overhead:false};
}

/** `body` is the active body with its chart centre carried into the active frame (activeFramedBody); `eye` and `view` {look,up,right} are the camera's chart pose and basis; `t` is sim time.
 *  Returns {body: id of the nearest body, altitude: yd above its mean surface, angle, overhead}. */
export function flightInstruments(body,eye,view,t) {
  const pos=toInertial(body,eye,t),near=nearestSurface(pos,t),target=BODIES[near.id];
  const c=centreAt(target,t),radial=unit([pos[0]-c[0],pos[1]-c[1],pos[2]-c[2]]);
  const ax=chartAxes(body,eye,t),inertial=v=>[0,1,2].map(i=>ax[0][i]*v[0]+ax[1][i]*v[1]+ax[2][i]*v[2]);
  const {angle,overhead}=poleAngle(radial,axesAt(target,t)[1],unit(inertial(view.look)),unit(inertial(view.up)),unit(inertial(view.right)));
  return {body:near.id,altitude:near.altitude,angle,overhead};
}
