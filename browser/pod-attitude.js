import {bodyOf} from './bodies.js';
import {basis,fromBasis,fromEuler,rotate} from './orient.js';

export const POD_TURN={mouse:.004,stick:Math.PI/2,rate:Math.PI,ease:8};
export const podInSpace=journey=>journey?.mode==='orbit'&&journey.pose[1]>bodyOf(journey.parent).atmosphereEdge;
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
export const aimQuaternion=(look,up)=>fromBasis([look[1]*up[2]-look[2]*up[1],look[2]*up[0]-look[0]*up[2],look[0]*up[1]-look[1]*up[0]],up,look);
export const inverseAim=q=>[-q[0],-q[1],-q[2],q[3]];
export function composeAim(frame,q){
  const b=basis(q);return aimQuaternion(rotate(frame,b.look),rotate(frame,b.up));
}

export function validatePodControl(control){
  if(control===undefined)return;
  if(!control||typeof control.active!=='boolean'||
    (control.active&&(!Array.isArray(control.aim)||control.aim.length!==4||
      !control.aim.every(Number.isFinite)||Math.abs(Math.hypot(...control.aim)-1)>1e-8)))
    throw Error('Invalid orbital pod control');
}

/** Fixed hold-start up, then yawed right: no incremental roll and no Euler extraction at poles. */
export function movePodAim(previous,seed,mouse,stick,dt){
  const base=previous?.base??seed;
  const yaw=(previous?.yaw??0)-mouse[0]*POD_TURN.mouse-stick[0]*POD_TURN.stick*dt;
  const pitch=(previous?.pitch??0)-mouse[1]*POD_TURN.mouse+stick[1]*POD_TURN.stick*dt;
  return {base,yaw,pitch,q:composeAim(base,fromEuler(yaw,pitch))};
}

/** Shortest quaternion arc, bounded angular speed, exponential arrival and exact settling. */
export function slewAim(from,to,dt,rate=POD_TURN.rate,ease=POD_TURN.ease){
  if(dt<=0)return from;
  const d=dot(from,to),target=d<0?to.map(v=>-v):to,cos=Math.min(1,Math.abs(d));
  const angle=2*Math.acos(cos);
  if(angle<1e-7)return target;
  const step=Math.min(rate*dt,angle*(-Math.expm1(-ease*dt))),t=step/angle;
  const half=angle/2,s=Math.sin(half),a=Math.sin((1-t)*half)/s,b=Math.sin(t*half)/s;
  const q=from.map((v,i)=>a*v+b*target[i]),n=Math.hypot(...q);
  return q.map(v=>v/n);
}
