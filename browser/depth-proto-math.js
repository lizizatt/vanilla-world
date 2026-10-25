// Depth/precision prototype maths (design/elune.md step B): eye-relative f64 sphere set, analytic reference ray-cast, layer plan.
// The GPU prototype (depth-proto.js) renders these spheres and is checked pixel-for-pixel against `classify`.
import {BODIES,centreAt,altitudeAbove} from './bodies.js';
import {depthLayers,depthRange} from './body-render.js';

export const POD_RADIUS=1;
export const FOV_Y=60*Math.PI/180;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>{const n=Math.hypot(...a);return a.map(v=>v/n);};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

/** Right-handed camera basis (right, up, forward) from a forward direction and an approximate up. */
export function basis(forward,up=[0,1,0]) {
  const f=unit(forward);let r=cross(f,up);if(Math.hypot(...r)<1e-9)r=cross(f,[1,0,0]);r=unit(r);
  return {right:r,up:cross(r,f),forward:f};
}

/** Spheres in view space, computed in f64 from inertial positions (the eye-relative offset). `k` = |c|^2-R^2 evaluated as (|c|-R)(|c|+R) so it survives f32. */
export function viewSpheres(eye,cam,t,{pod=null}={}) {
  const out=[];
  const push=(centre,radius,id)=>{
    const rel=[centre[0]-eye[0],centre[1]-eye[1],centre[2]-eye[2]],d=Math.hypot(...rel);
    out.push({c:[dot(rel,cam.right),dot(rel,cam.up),dot(rel,cam.forward)],r:radius,k:(d-radius)*(d+radius),id});
  };
  push(centreAt(BODIES.azeroth,t),BODIES.azeroth.radius,0);
  push(centreAt(BODIES.elune,t),BODIES.elune.radius,1);
  if(pod)push(pod,POD_RADIUS,2);
  return out;
}

/** Reference: nearest sphere id hit by view-space ray (ndcX,ndcY), or -1. Quadratic solved in the cancellation-free form. */
export function classify(spheres,ndcX,ndcY,aspect,fov=FOV_Y) {
  const ty=Math.tan(fov/2),d=unit([ndcX*ty*aspect,ndcY*ty,1]);
  let best=-1,bestZ=Infinity;
  for(const s of spheres) {
    const b=dot(d,s.c),disc=b*b-s.k;
    if(disc<0||b<=0)continue;
    const t=s.k/(b+Math.sqrt(disc)),z=t*d[2];
    if(z>0&&z<bestZ){bestZ=z;best=s.id;}
  }
  return best;
}

/** Layer plan for the three depth strategies compared in the prototype. */
export function planFor(mode,eye,t) {
  const r=depthRange(eye,t);
  if(mode==='std24')return {reversed:false,format:'depth24plus',layers:[{near:r.near,far:r.far}]};
  if(mode==='rev32')return {reversed:true,format:'depth32float',layers:[{near:r.near,far:r.far}]};
  const layers=depthLayers(eye,t,{});
  // Force a split even when the ratio is acceptable so the seam path is exercised.
  const split=Math.sqrt(r.near*r.far);
  const forced=layers.length>1?layers:[{near:split,far:r.far},{near:r.near,far:split*1.01}];
  return {reversed:true,format:'depth32float',layers:forced};
}

/** The captured scenarios: eye (inertial f64), look direction, time. Azeroth is ~42.8 kyd in radius, Elune ~5.1 kyd. */
export function scenarios(t=1000) {
  const A=BODIES.azeroth,E=BODIES.elune,ec=centreAt(E,t);
  const on=(b,h,dir)=>{const c=centreAt(b,t),d=unit(dir);return d.map((v,i)=>c[i]+v*(b.radius+h));};
  const tangent=u=>unit(cross(Math.abs(u[1])>.99?[1,0,0]:[0,1,0],u));
  const aim=(u,pitch)=>tangent(u).map((v,i)=>v*Math.cos(pitch)+u[i]*Math.sin(pitch));
  const dip=(b,h)=>-Math.acos(b.radius/(b.radius+h));
  const toE=unit(ec),fromE=toE.map(v=>-v),up=[0,1,0];
  const out=[];
  out.push({name:'azeroth-low-horizon',t,eye:on(A,1.5,up),look:aim(up,0)});
  out.push({name:'azeroth-low-elune-zenith',t,eye:on(A,1.5,toE),look:toE});
  out.push({name:'azeroth-limb-5kyd',t,eye:on(A,5000,up),look:aim(up,dip(A,5000))});
  const mid=[ec[0]*.5,400000,ec[2]*.5];
  out.push({name:'transit-both-visible',t,eye:mid,look:[ec[0]*.5-mid[0],-mid[1],ec[2]*.5-mid[2]]});
  const eyeE=on(E,1.5,fromE);
  out.push({name:'elune-low-pod',t,eye:eyeE,look:aim(fromE,0),pod:true});
  out.push({name:'elune-low-azeroth-sky',t,eye:eyeE,look:fromE});
  out.push({name:'elune-limb-400',t,eye:on(E,400,fromE),look:aim(fromE,dip(E,400))});
  for(const s of out)if(s.pod){const f=unit(s.look);s.pod=s.eye.map((v,i)=>v+f[i]*6);}
  return out;
}

export const nearestBody=(eye,t)=>Object.values(BODIES).map(b=>({id:b.id,alt:altitudeAbove(b,eye,t)})).sort((a,b)=>a.alt-b.alt)[0];

/** View-space camera for a scenario: up is the radial direction of the nearest body. */
export function cameraFor(s) {
  const nb=nearestBody(s.eye,s.t),c=centreAt(BODIES[nb.id],s.t);
  return basis(s.look,unit(s.eye.map((v,i)=>v-c[i])));
}
