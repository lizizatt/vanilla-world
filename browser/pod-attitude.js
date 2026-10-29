import {bodyOf} from './bodies.js';
import {basis,fromBasis,stepOrient,ORIENT} from './orient.js';

export const POD_TURN={mouse:.004,stick:Math.PI/2};
export const podInSpace=journey=>journey?.mode==='orbit'&&journey.pose[1]>bodyOf(journey.parent).atmosphereEdge;

export function validatePodControl(control){
  if(control===undefined)return;
  if(!control||typeof control.active!=='boolean'||
    ![control.mouse,control.stick].every(a=>Array.isArray(a)&&a.length===2&&a.every(Number.isFinite))||
    control.mouse.some(v=>Math.abs(v)>1e6)||control.stick.some(v=>Math.abs(v)>1))
    throw Error('Invalid orbital pod control');
}

export function podControl(journey,enabled,right,look,orbit,padHold){
  if(!enabled||!podInSpace(journey))return undefined;
  return {active:right||padHold,mouse:orbit.map(v=>-v*POD_TURN.mouse||0),
    stick:padHold?[-look[0],look[1]]:[0,0]};
}

export function turnPod(direction,up,mouse,stick,dt){
  const right=[direction[1]*up[2]-direction[2]*up[1],direction[2]*up[0]-direction[0]*up[2],direction[0]*up[1]-direction[1]*up[0]];
  const q=stepOrient(fromBasis(right,up,direction),
    {yaw:mouse[0]+stick[0]*POD_TURN.stick*dt,pitch:mouse[1]+stick[1]*POD_TURN.stick*dt},
    ORIENT.levelAlt[1]);
  const b=basis(q);return {direction:b.look,up:b.up};
}
