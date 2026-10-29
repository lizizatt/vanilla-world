// Pole frames (design/poles.md 4): each body has frame E (its authored equirect chart, wrapping in longitude) plus pole frames N and S.
// A pole frame is the SAME equirect chart rotated by a fixed 3x3 Q so the pole sits at the chart origin; chart x = R*lon', chart z = -R*lat', centre [0,0].
// Pure and body-agnostic (radius/centre passed in). Rotations are exact permutations, so a hop is a closed-form re-expression of the pose.
import {latLonOf,flatOf,dirLatLon} from './equirect.js';

// Columns of Q: where frame axes X (lon' 0, lat' 0), Y (frame north), Z (frame east, lon' +90) land in body space (Y north).
// N: pole at chart origin, chart "up the screen" (-z) runs away from the pole along the body lon-0 meridian. S: same meridian.
const Q={
  N:[[0,1,0],[1,0,0],[0,0,-1]],// rows: body x = frame y, body y = frame x, body z = -frame z
  S:[[0,1,0],[-1,0,0],[0,0,1]],// body x = frame y, body y = -frame x, body z = frame z
};
export const FRAME_IDS=Object.freeze(['E','N','S']);
export const isPoleFrame=id=>id==='N'||id==='S';
/** Global (render) coordinates of each pole chart's origin; mirrors POLE_ANCHORS in world.rs (poles are far outside every authored region). */
export const POLE_ANCHORS=Object.freeze({N:Object.freeze([0,-200000]),S:Object.freeze([0,200000])});
/** Rotation (rows) taking frame axes to body axes, or undefined for E. */
export const frameQ=id=>Q[id];
/**
 * Chart centre of frame id as the engine sees it: E is the body's authored centre; a pole frame is its anchor, carrying its rotation as .q.
 * Carrying q on the centre array lets every existing (centre, radius) call site become frame-aware without a signature change.
 */
export function frameCentre(id,centre) {
  if(!isPoleFrame(id))return centre;
  const c=[...POLE_ANCHORS[id]];c.q=Q[id];c.frame=id;return c;
}
/** Rotation of a chart centre produced by frameCentre (undefined for E). */
export const centreQ=centre=>centre?.q;

const mul=(m,v)=>[m[0][0]*v[0]+m[0][1]*v[1]+m[0][2]*v[2],m[1][0]*v[0]+m[1][1]*v[1]+m[1][2]*v[2],m[2][0]*v[0]+m[2][1]*v[1]+m[2][2]*v[2]];
const mulT=(m,v)=>[m[0][0]*v[0]+m[1][0]*v[1]+m[2][0]*v[2],m[0][1]*v[0]+m[1][1]*v[1]+m[2][1]*v[2],m[0][2]*v[0]+m[1][2]*v[1]+m[2][2]*v[2]];
export const rotate=(q,v)=>mul(q,v);
export const dirToBody=(id,d)=>id==='E'?d:mul(Q[id],d);
export const dirToFrame=(id,d)=>id==='E'?d:mulT(Q[id],d);
const centreOf=(id,centre)=>id==='E'?centre:[0,0];

/** Chart (x, z) of frame `id` -> unit direction in body space. */
export function chartToDir(id,x,z,centre,radius) {
  const {lat,lon}=latLonOf(x,z,centreOf(id,centre),radius),cl=Math.cos(lat);
  return dirToBody(id,[cl*Math.cos(lon),Math.sin(lat),cl*Math.sin(lon)]);
}
/** Unit body direction -> chart [x, z] of frame `id` (longitude is NOT wrapped here; callers pick the branch). */
export function dirToChart(id,d,centre,radius,nearLon) {
  const {lat,lon}=dirLatLon(dirToFrame(id,d));
  let l=lon;if(nearLon!==undefined)l+=2*Math.PI*Math.round((nearLon-lon)/(2*Math.PI));
  return flatOf(lat,l,centreOf(id,centre),radius);
}
/** Body latitude (rad) of a body direction. */
export const bodyLat=d=>Math.asin(Math.max(-1,Math.min(1,d[1])));

/**
 * Frame selection with hysteresis. `handoff` is the |lat| (rad) at which E hands over to the pole frame; the way back needs |lat| < handoff - hysteresis.
 * Returns the frame id for direction `d` given the current frame.
 */
export function frameFor(d,current,{handoff,hysteresis=Math.PI/180}) {
  const lat=bodyLat(d),a=Math.abs(lat);
  if(current==='E')return a>=handoff?(lat>0?'N':'S'):'E';
  // in a pole frame: leave only well inside the E zone; a pole frame never jumps straight to the other pole
  if(a<handoff-hysteresis)return 'E';
  return current;
}

/** Heading vector of a chart yaw (pod convention, pod-driver.js:42: forward = (-sin yaw, -cos yaw) in (x, z)). */
export const headingOf=yaw=>[-Math.sin(yaw),-Math.cos(yaw)];
export const yawOf=(hx,hz)=>Math.atan2(-hx,-hz);

/** 3D tangent of unit direction per chart yard (finite difference both ways, exact enough at 1 yd on a 5-14 kyd sphere). */
function jacobian(id,x,z,centre,radius) {
  const e=1,dx=chartToDir(id,x+e,z,centre,radius),dxm=chartToDir(id,x-e,z,centre,radius),dz=chartToDir(id,x,z+e,centre,radius),dzm=chartToDir(id,x,z-e,centre,radius);
  return {ex:dx.map((v,i)=>(v-dxm[i])/(2*e)),ez:dz.map((v,i)=>(v-dzm[i])/(2*e))};
}
/** True (spherical) length in yd of a chart displacement (dx, dz) at chart point (x, z). */
export function trueLength(id,x,z,dx,dz,centre,radius) {
  const {ex,ez}=jacobian(id,x,z,centre,radius),v=ex.map((a,i)=>a*dx+ez[i]*dz);
  return Math.hypot(...v)*radius;
}

/**
 * Exact hand-off between frames: the same point and the same true velocity re-expressed in `to`.
 * state = {x, z, yaw, vx, vz} in the `from` chart; returns the same shape in the `to` chart.
 */
export function hop(state,from,to,centre,radius) {
  const d=chartToDir(from,state.x,state.z,centre,radius),{ex,ez}=jacobian(from,state.x,state.z,centre,radius);
  const [nx,nz]=dirToChart(to,d,centre,radius,to==='E'?(state.x-centre[0])/radius:undefined);
  const J=jacobian(to,nx,nz,centre,radius);
  // true 3D tangent -> target chart components via the 2x2 normal equations
  const toTarget=t=>{
    const a=J.ex.reduce((s,v,i)=>s+v*J.ex[i],0),b=J.ex.reduce((s,v,i)=>s+v*J.ez[i],0),c=J.ez.reduce((s,v,i)=>s+v*J.ez[i],0);
    const p=J.ex.reduce((s,v,i)=>s+v*t[i],0),q=J.ez.reduce((s,v,i)=>s+v*t[i],0),det=a*c-b*b;
    return [(c*p-b*q)/det,(a*q-b*p)/det];
  };
  const [hx,hz]=headingOf(state.yaw),tHead=ex.map((v,i)=>v*hx+ez[i]*hz),tVel=ex.map((v,i)=>v*state.vx+ez[i]*state.vz);
  const [nhx,nhz]=toTarget(tHead),[nvx,nvz]=toTarget(tVel);
  return {x:nx,z:nz,yaw:yawOf(nhx,nhz),vx:nvx,vz:nvz};
}
