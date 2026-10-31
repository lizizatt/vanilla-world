// Chart-pose adapter for inter-body flight (design/elune.md step D4): the fly camera keeps its chart pose and aim, while motion runs through space-flight.js in inertial space.
import {bodyOf,toInertial,fromInertial,axesAt} from './bodies.js';
import {planetFrame,bodyPoint} from './space.js';
import {frameCentre,frameFor} from './frames.js';
import {poleFrameSpec} from './pole-source.js';
import {createFlight,stepFlight} from './space-flight.js';
import {wrapTurn} from './math.js';

const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};

/** Chart axes (x east, y up, z south) at a chart pose as orthonormal inertial vectors. This is the frame the renderer uses for view.look/right/up (the shader's eye frame), so a chart
 *  direction means the same physical direction on screen and in flight. (A finite difference through the folded chart would stretch horizontal components by (R+alt)/R and
 *  point flight away from what the camera shows at altitude.) */
export function chartAxes(body,pose,t) {
  const f=planetFrame(pose[0],pose[2],body.centre,body.radius),ax=axesAt(body,t);
  return [f.east,f.up,f.south].map(v=>[0,1,2].map(i=>ax[0][i]*v[0]+ax[1][i]*v[1]+ax[2][i]*v[2]));
}

/** Inertial direction of a chart-space direction at a chart pose. */
export function inertialDir(body,pose,dir,t) {
  const a=chartAxes(body,pose,t);
  return unit([0,1,2].map(i=>a[0][i]*dir[0]+a[1][i]*dir[1]+a[2][i]*dir[2]));
}

const chartJacobian=chartAxes;

/** Re-express an aim basis {look,right,up} given in `from`'s chart at `fromPose` in `to`'s chart at `toPose`, so the physical (inertial) attitude is unchanged across a gravity-well swap. */
export function rechartAim(from,fromPose,to,toPose,aim,t) {
  return carryAim(from,fromPose,to,toPose,aim,t,false);
}

/** Roll-free parallel transport on one body: the attitude follows the pod along its path by the shortest rotation taking the old local up to the new one
 *  (no twist, so no heading swing from meridian convergence at the poles and no gimbal axis). Same {look,right,up} chart-basis shape as the input. */
export const transportAim=(body,fromPose,toPose,aim,t)=>carryAim(body,fromPose,body,toPose,aim,t,true);

const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
/** Rotate v about the unit axis by the angle whose sine/cosine are s/c (Rodrigues). */
const turn=(v,axis,s,c)=>{const k=cross(axis,v),d=axis[0]*v[0]+axis[1]*v[1]+axis[2]*v[2];return v.map((x,i)=>x*c+k[i]*s+axis[i]*d*(1-c));};

function carryAim(from,fromPose,to,toPose,aim,t,transport) {
  const A=chartJacobian(from,fromPose,t),B=chartJacobian(to,toPose,t),dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const nrm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
  const upA=nrm(A[1]),upB=nrm(B[1]);
  let axis=null,s=0,c=1;
  if(transport){const x=cross(upA,upB);s=Math.hypot(...x);c=dot(upA,upB);if(s>1e-12)axis=x.map(v=>v/s);}
  // Solve B*c=w by orthogonality of B's columns (the folded chart's Jacobian is orthogonal).
  const conv=v=>{let w=nrm([0,1,2].map(i=>A[0][i]*v[0]+A[1][i]*v[1]+A[2][i]*v[2]));if(axis)w=turn(w,axis,s,c);return nrm(B.map(b=>dot(b,w)/dot(b,b)));};
  return {look:conv(aim.look),right:conv(aim.right),up:conv(aim.up)};
}

/** The body with its chart centre carried into frame `id` ('E' or absent: the body itself). */
export const framedBody=(body,id)=>!id||id==='E'?body:{...body,centre:frameCentre(id,body.centre)};
const POLE_BODIES=new Set(['azeroth','elune']);

/** Keeps a chart pose's longitude within half a turn of the body's chart centre. fromInertial unwraps near the previous x for continuity, so without this a flight that circles the world accumulates whole turns and the streaming engine (which indexes terrain by the chart's single turn) never finds the land under it. Mutates and returns pose. */
export function wrapChartLongitude(body,pose) {
  if(body.circumference>0)pose[0]=body.centre[0]+wrapTurn(pose[0]-body.centre[0],body.circumference);
  return pose;
}

/** One fly-camera step. `flight` is the chart pose [x,y,z,yaw,pitch,...q] in frame `frame` ('E', 'N' or 'S'); `aim` the chart basis {look,right,up}; `input` {forward,strafe,lift,fast}.
 *  Returns {pose,space,parent,swapped,frame}; on a swap or a frame hop also `aim`, the same attitude in the new chart. A hop is a pure re-expression (the inertial state is untouched), so it is seamless at any altitude. */
export function stepShared(space,flight,aim,input,dt,t,rate=2,home='azeroth',frame='E') {
  const body=bodyOf(space?.parent??home),bodyF=framedBody(body,frame);
  const state=space??createFlight(toInertial(bodyF,flight,t),t,body.id,rate);
  const pose=flight.slice(0,3),dir=d=>inertialDir(bodyF,pose,d,t);
  const next=stepFlight(state,{...input,look:dir(aim.look),right:dir(aim.right),up:dir(aim.up),simRate:rate},dt,t);
  const parent=bodyOf(next.parent);
  const swapped=next.parent!==state.parent;
  if(swapped) {
    // A new chart's longitude must be unwrapped around its own centre; the old chart's x is meaningless there (it would land a whole circumference away from the tiles).
    const chart=wrapChartLongitude(parent,fromInertial(parent,next.pos,t,parent.centre[0]));
    return {space:next,parent:next.parent,swapped,frame:'E',pose:chart,aim:rechartAim(bodyF,pose,parent,chart,aim,t)};
  }
  // next.pos is carried to the end of the step, so the chart pose is read at the sim time the renderer will draw (t+rate*dt), not at the start.
  const te=t+rate*dt,chart=fromInertial(bodyF,next.pos,te,flight[0]);if(frame==='E')wrapChartLongitude(bodyF,chart);
  const spec=POLE_BODIES.has(parent.id)?poleFrameSpec(parent.id):undefined;
  const {lat}=bodyPoint(chart[0],chart[2],bodyF.centre,parent.radius),to=spec?frameFor([0,Math.sin(lat),0],frame,spec):frame;
  if(to===frame)return {space:next,parent:next.parent,swapped,frame,pose:chart,aim:transportAim(bodyF,pose,chart,aim,t)};
  const bodyT=framedBody(parent,to),hopped=fromInertial(bodyT,next.pos,te,bodyT.centre[0]);
  return {space:next,parent:next.parent,swapped,frame:to,pose:hopped,aim:rechartAim(bodyF,pose,bodyT,hopped,aim,t)};
}