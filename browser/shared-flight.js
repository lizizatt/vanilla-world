// Chart-pose adapter for inter-body flight (design/elune.md step D4): the fly camera keeps its chart pose and aim, while motion runs through space-flight.js in inertial space.
import {bodyOf,toInertial,fromInertial} from './bodies.js';
import {createFlight,stepFlight} from './space-flight.js';

const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};

/** Inertial direction of a chart-space direction at a chart pose (finite difference through the planet map). */
export function inertialDir(body,pose,dir,t,eps=1) {
  const a=toInertial(body,pose,t),b=toInertial(body,[pose[0]+dir[0]*eps,pose[1]+dir[1]*eps,pose[2]+dir[2]*eps],t);
  return unit(b.map((v,i)=>v-a[i]));
}

/** One fly-camera step. `flight` is the chart pose [x,y,z,yaw,pitch,...q]; `aim` the chart basis {look,right,up}; `input` {forward,strafe,lift,fast}. Returns {pose,space,parent,swapped}. */
export function stepShared(space,flight,aim,input,dt,t,rate=2,home='azeroth') {
  const body=bodyOf(space?.parent??home);
  const state=space??createFlight(toInertial(body,flight,t),t,body.id,rate);
  const pose=flight.slice(0,3),dir=d=>inertialDir(body,pose,d,t);
  const next=stepFlight(state,{...input,look:dir(aim.look),right:dir(aim.right),up:dir(aim.up),simRate:rate},dt,t);
  const parent=bodyOf(next.parent);
  const chart=fromInertial(parent,next.pos,t,flight[0]);
  return {space:next,parent:next.parent,swapped:next.parent!==state.parent,pose:chart};
}
