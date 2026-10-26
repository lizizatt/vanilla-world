// Chart-pose adapter for inter-body flight (design/elune.md step D4): the fly camera keeps its chart pose and aim, while motion runs through space-flight.js in inertial space.
import {bodyOf,toInertial,fromInertial} from './bodies.js';
import {createFlight,stepFlight} from './space-flight.js';

const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};

/** Inertial direction of a chart-space direction at a chart pose (finite difference through the planet map). */
export function inertialDir(body,pose,dir,t,eps=1) {
  const a=toInertial(body,pose,t),b=toInertial(body,[pose[0]+dir[0]*eps,pose[1]+dir[1]*eps,pose[2]+dir[2]*eps],t);
  return unit(b.map((v,i)=>v-a[i]));
}

/** Chart axes (x,y,z) of a body at a chart pose, as inertial unit vectors. */
export const chartAxes=(body,pose,t)=>[[1,0,0],[0,1,0],[0,0,1]].map(d=>inertialDir(body,pose,d,t));

/** Unnormalised Jacobian columns of chart->inertial (the chart is folded, so axis scales differ and directions must be mapped linearly before normalising). */
const chartJacobian=(body,pose,t,eps=1)=>[[1,0,0],[0,1,0],[0,0,1]].map(d=>{
  const a=toInertial(body,pose.slice(0,3),t),b=toInertial(body,pose.slice(0,3).map((v,i)=>v+d[i]*eps),t);
  return b.map((v,i)=>(v-a[i])/eps);
});

/** Re-express an aim basis {look,right,up} given in `from`'s chart at `fromPose` in `to`'s chart at `toPose`, so the physical (inertial) attitude is unchanged across a gravity-well swap. */
export function rechartAim(from,fromPose,to,toPose,aim,t) {
  const A=chartJacobian(from,fromPose,t),B=chartJacobian(to,toPose,t),dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const nrm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
  // Solve B*c=w by orthogonality of B's columns (the folded chart's Jacobian is orthogonal).
  const conv=v=>{const w=[0,1,2].map(i=>A[0][i]*v[0]+A[1][i]*v[1]+A[2][i]*v[2]);return nrm(B.map(b=>dot(b,w)/dot(b,b)));};
  return {look:conv(aim.look),right:conv(aim.right),up:conv(aim.up)};
}

/** One fly-camera step. `flight` is the chart pose [x,y,z,yaw,pitch,...q]; `aim` the chart basis {look,right,up}; `input` {forward,strafe,lift,fast}. Returns {pose,space,parent,swapped}; on a swap also `aim`, the same attitude in the new parent's chart. */
export function stepShared(space,flight,aim,input,dt,t,rate=2,home='azeroth') {
  const body=bodyOf(space?.parent??home);
  const state=space??createFlight(toInertial(body,flight,t),t,body.id,rate);
  const pose=flight.slice(0,3),dir=d=>inertialDir(body,pose,d,t);
  const next=stepFlight(state,{...input,look:dir(aim.look),right:dir(aim.right),up:dir(aim.up),simRate:rate},dt,t);
  const parent=bodyOf(next.parent);
  const swapped=next.parent!==state.parent;
  // A new chart's longitude must be unwrapped around its own centre; the old chart's x is meaningless there (it would land a whole circumference away from the tiles).
  const chart=fromInertial(parent,next.pos,t,swapped?parent.centre[0]:flight[0]);
  return {space:next,parent:next.parent,swapped,pose:chart,...(swapped?{aim:rechartAim(body,pose,parent,chart,aim,t)}:{})};
}
