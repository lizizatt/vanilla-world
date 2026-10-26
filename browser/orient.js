// Fly-camera orientation as a unit quaternion [x,y,z,w] (camera local: right +x, up +y, forward -z), so there is no pole to lock at.
// World up is +Y: the planet is rebuilt under the eye every frame, so +Y is always the local radial.
// Tuning: altitude band (yd) over which control blends from ground-levelled to free attitude, pitch limit (rad),
// horizon self-levelling max rate (rad/s) and ease rate (1/s).
export const ORIENT=Object.freeze({levelAlt:Object.freeze([800,4000]),pitchLimit:1.5707,levelRate:1.5,levelEase:8});
import {smoothstep} from './math.js';
const smooth=smoothstep;
export const spaceBlend=altitude=>smooth(ORIENT.levelAlt[0],ORIENT.levelAlt[1],altitude);
const mul=(a,b)=>[a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const unit=q=>{const n=Math.hypot(...q)||1;return q.map(v=>v/n);};
const axisAngle=(a,r)=>{const n=Math.hypot(...a)||1,s=Math.sin(r/2)/n;return [a[0]*s,a[1]*s,a[2]*s,Math.cos(r/2)];};
export function rotate(q,v) {
  const [x,y,z,w]=q,t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])];
  return [v[0]+w*t[0]+y*t[2]-z*t[1],v[1]+w*t[1]+z*t[0]-x*t[2],v[2]+w*t[2]+x*t[1]-y*t[0]];
}
export const turnAround=q=>mul(axisAngle([0,1,0],Math.PI),q);
export const basis=q=>({right:rotate(q,[1,0,0]),up:rotate(q,[0,1,0]),look:rotate(q,[0,0,-1])});
export const fromEuler=(yaw,pitch)=>unit(mul(axisAngle([0,1,0],yaw),axisAngle([1,0,0],pitch)));
/** Unit quaternion whose camera basis is (right, up, look): the inverse of `basis`. The inputs are orthonormalised first (Gram-Schmidt from look and up). */
export function fromBasis(right,up,look) {
  const n=v=>{const l=Math.hypot(...v)||1;return v.map(a=>a/l);},dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const z=n(look.map(a=>-a)),u0=n(up),x=n([u0[1]*z[2]-u0[2]*z[1],u0[2]*z[0]-u0[0]*z[2],u0[0]*z[1]-u0[1]*z[0]]),y=[z[1]*x[2]-z[2]*x[1],z[2]*x[0]-z[0]*x[2],z[0]*x[1]-z[1]*x[0]];
  const flip=dot(x,right)<0?-1:1,m=[[x[0]*flip,y[0],z[0]],[x[1]*flip,y[1],z[1]],[x[2]*flip,y[2],z[2]]],tr=m[0][0]+m[1][1]+m[2][2];
  let q;
  if(tr>0){const s=Math.sqrt(tr+1)*2;q=[(m[2][1]-m[1][2])/s,(m[0][2]-m[2][0])/s,(m[1][0]-m[0][1])/s,s/4];}
  else if(m[0][0]>m[1][1]&&m[0][0]>m[2][2]){const s=Math.sqrt(1+m[0][0]-m[1][1]-m[2][2])*2;q=[s/4,(m[0][1]+m[1][0])/s,(m[0][2]+m[2][0])/s,(m[2][1]-m[1][2])/s];}
  else if(m[1][1]>m[2][2]){const s=Math.sqrt(1+m[1][1]-m[0][0]-m[2][2])*2;q=[(m[0][1]+m[1][0])/s,s/4,(m[1][2]+m[2][1])/s,(m[0][2]-m[2][0])/s];}
  else{const s=Math.sqrt(1+m[2][2]-m[0][0]-m[1][1])*2;q=[(m[0][2]+m[2][0])/s,(m[1][2]+m[2][1])/s,s/4,(m[1][0]-m[0][1])/s];}
  return unit(q);
}
/** Yaw/pitch of the forward direction; at the poles the previous yaw is kept so it never snaps. */
export function toEuler(q,prevYaw=0) {
  const {look}=basis(q),h=Math.hypot(look[0],look[2]);
  return [h>1e-4?Math.atan2(-look[0],-look[2]):prevYaw,Math.asin(Math.max(-1,Math.min(1,look[1])))];
}
/** One step: pitch about the camera's right, roll about its forward, yaw about world up at low altitude fading to the camera's own up in space,
 *  and below the fade the horizon is levelled (roll eased out) and the pitch cannot pass the vertical, so ground flight matches yaw/pitch control. */
export function stepOrient(q,{yaw=0,pitch=0,roll=0},altitude,dt=0) {
  const w=spaceBlend(altitude);
  let b=basis(q);
  if(w<.5&&pitch&&b.up[1]>=0){const p0=Math.asin(Math.max(-1,Math.min(1,b.look[1])));pitch=Math.max(-ORIENT.pitchLimit,Math.min(ORIENT.pitchLimit,p0+pitch))-p0;}
  q=mul(q,mul(axisAngle([1,0,0],pitch),axisAngle([0,0,-1],roll)));
  b=basis(q);
  const axis=[0,1,2].map(i=>(1-w)*[0,1,0][i]+w*b.up[i]);
  if(yaw)q=mul(axisAngle(Math.hypot(...axis)>1e-6?axis:[0,1,0],yaw),q);
  b=basis(q);
  const lean=Math.min(1,Math.hypot(b.look[0],b.look[2])/.3),err=Math.atan2(b.right[1],b.up[1])*lean;
  if(w<1&&dt>0)q=mul(axisAngle(b.look,Math.max(-ORIENT.levelRate*dt,Math.min(ORIENT.levelRate*dt,err*(1-w)*(1-Math.exp(-ORIENT.levelEase*dt))))),q);
  return unit(q);
}
