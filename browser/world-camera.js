import {basis,stepOrient,ORIENT} from './orient.js';
import {wrapAngle as wrap} from './math.js';
import {activeFramedBody} from './body-shaders.js';
import {podCameraFrame} from './pod-render-frame.js';
import {chartAxes} from './shared-flight.js';
import {aimQuaternion,composeAim,inverseAim,slewAim} from './pod-attitude.js';
const unit=v=>{const length=Math.hypot(...v);return length?v.map(n=>n/length):[0,0,-1];};
// Tuning: cockpit look pitch limit (rad), mouse-orbit sensitivity (rad/px), return-to-centre rate (1/s).
export const CAMERA=Object.freeze({pitchLimit:89*Math.PI/180,orbitSense:.004,recentre:7});
const PITCH_LIMIT=CAMERA.pitchLimit;

/** `drop` lowers the craft below the physics position (ground-riding skins; see ridePlan). */
export function craftMatrix(state,origin,scale,drop=0) {
  if(state.length===22){
    const {look,right,up}=basis(state.slice(18)),m=new Float32Array(16);
    for(const [column,v] of [look,right.map(n=>-n),up].entries())m.set(v.map(n=>n*scale),column*4);
    m.set([state[0]-origin[0],state[1]-drop,state[2]-origin[1],1],12);
    return m;
  }
  const c=Math.cos(state[3]),s=Math.sin(state[3]),cb=Math.cos(state[4]),sb=-Math.sin(state[4]); // physics bank is negative for a left steer; render left side down
  const cp=Math.cos(state[17]??0),sp=Math.sin(state[17]??0);
  const m=new Float32Array(16);
  for(const [column,v] of [[0,[0,0,-1]],[1,[-1,0,0]],[2,[0,1,0]]]){
    const x=v[0]*cb-v[1]*sb,by=v[0]*sb+v[1]*cb;
    const y=by*cp-v[2]*sp,z=by*sp+v[2]*cp;
    m.set([(x*c+z*s)*scale,y*scale,(-x*s+z*c)*scale,0],column*4);
  }
  m.set([state[0]-origin[0],state[1]-drop,state[2]-origin[1],1],12);
  return m;
}
export function cockpitAnchor(metadata) {
  const seat=metadata.posedAttachment0;
  if(!seat)return undefined;
  if(seat.space!=='model-local'||seat.pose!=='stand-frame-0'||!Array.isArray(seat.position)||
    seat.position.length!==3||!seat.position.every(Number.isFinite))throw Error('Invalid posed cockpit seat');
  // Functional eye height above the authored seat, not a selected avatar's animated head.
  return [seat.position[0],seat.position[1],seat.position[2]+.75];
}

/** Keeps a free or chase camera above terrain and the sea (rig.cameraFloor is supplied by camera collision; absent until it loads). */
export function lifted(rig,eye,origin) {
  const floor=floorAt(rig,eye,origin);
  return floor!==undefined&&eye[1]<floor?[eye[0],floor,eye[2]]:eye;
}
/** Single lookup of the camera floor (world y) under a camera-relative eye; undefined until collision tiles load. */
export const floorAt=(rig,eye,origin)=>rig.cameraFloor?.(eye[0]+origin[0],eye[1],eye[2]+origin[1]);
/** How far to raise an eye at eyeY to reach the floor, never more than cap (0 without a floor or when already above it). */
export const floorLift=(floor,eyeY,cap=Infinity)=>floor===undefined?0:Math.max(0,Math.min(floor-eyeY,cap));

export function cameraView(rig,state,flight,dt,origin,settings={},lookBack=false) {
  if(!flight&&state.length===22)return orbitalCamera(rig,state,dt,origin,settings,lookBack);
  rig.orbitalLook=undefined;
  rig.podCameraAim=undefined;rig.podAimHeld=false;rig.podAimFollow=undefined;
  const aim=flatCameraView(rig,state,flight,dt,origin,settings,lookBack);
  if(flight||settings.planet===false)return aim;
  const offset=[rig.camera[0]+origin[0]-state[0],rig.camera[1]-state[1],rig.camera[2]+origin[1]-state[2]];
  const frame=podCameraFrame(activeFramedBody(),state,offset,aim.look,aim.up);
  const collisionReady=placePodCamera(rig,state,origin,frame,rig.cameraMode==='cockpit');
  return {...aim,look:frame.look,up:frame.up,collisionReady};
}

function placePodCamera(rig,state,origin,frame,cockpit){
  const eye=[frame.eye[0]-origin[0],frame.eye[1],frame.eye[2]-origin[1]];
  const pivot=[state[0]-origin[0],state[1],state[2]-origin[1]],clear=rig.clipCamera?.(pivot,eye,origin);
  rig.cameraBlocked=undefined;
  if(cockpit){
    if(!clear)rig.cameraBlocked='pending';
    else if(Math.hypot(...clear.map((v,i)=>v-eye[i]))>1e-5)rig.cameraBlocked=rig.cameraCollisionReady===false?'pending':'geometry';
  }
  rig.camera=!cockpit&&clear?clear:eye;
  return !!clear&&!rig.cameraBlocked;
}

function orbitalCamera(rig,state,dt,origin,settings,lookBack){
  rig.origin=origin;rig.cameraBlocked=undefined;
  const cockpit=settings.cockpit&&rig.craft?.anchor;
  rig.cameraMode=cockpit?'cockpit':'chase';
  rig.orbitalLook??=[0,0];
  const input=settings.cameraLook||[0,0],orbit=settings.cameraOrbit||[0,0];
  if(!settings.podAim&&!rig.podAimHeld&&!rig.podAimFollow&&(input.some(Boolean)||orbit.some(Boolean))){
    rig.orbitalLook[0]=wrap(rig.orbitalLook[0]-input[0]*Math.PI*dt-orbit[0]*CAMERA.orbitSense);
    rig.orbitalLook[1]=Math.max(-PITCH_LIMIT,Math.min(PITCH_LIMIT,rig.orbitalLook[1]+input[1]*Math.PI/2*dt-orbit[1]*CAMERA.orbitSense));
  }else if(!settings.podAim&&(cockpit||settings.cameraRecentre))rig.orbitalLook=rig.orbitalLook.map(n=>n*Math.exp(-CAMERA.recentre*dt));
  const {look:forward,right,up}=basis(state.slice(18));
  const heading=rig.orbitalLook[0]+(lookBack?Math.PI:0),pitch=rig.orbitalLook[1]+(cockpit?0:-Math.atan(.3));
  let look=forward.map((v,i)=>v*Math.cos(heading)*Math.cos(pitch)-right[i]*Math.sin(heading)*Math.cos(pitch)+up[i]*Math.sin(pitch)),cameraUp=up;
  const axes=settings.planet===false?[[1,0,0],[0,1,0],[0,0,1]]:chartAxes(activeFramedBody(),state,settings.podTime??rig.timeOfDay??0);
  const inertial=v=>[0,1,2].map(i=>axes.reduce((sum,a,k)=>sum+a[i]*v[k],0));
  const chart=v=>axes.map(a=>a.reduce((sum,n,i)=>sum+n*v[i],0));
  const craftAim=aimQuaternion(inertial(forward),inertial(up));
  let aim=aimQuaternion(inertial(look),inertial(up));
  if(settings.podAim){
    aim=settings.podAim;rig.podAimHeld=true;rig.podAimFollow=undefined;
  }else if(rig.podAimHeld){
    // Capture the exact displayed frame on release; only subsequent frames ease back to follow.
    rig.podAimFollow=composeAim(inverseAim(craftAim),rig.podCameraAim);
    rig.podAimHeld=false;rig.orbitalLook=[0,0];aim=rig.podCameraAim;
  }else if(rig.podAimFollow){
    const target=composeAim(inverseAim(craftAim),aim);
    rig.podAimFollow=input.some(Boolean)||orbit.some(Boolean)
      ?stepOrient(rig.podAimFollow,{yaw:-input[0]*Math.PI*dt-orbit[0]*CAMERA.orbitSense,pitch:input[1]*Math.PI/2*dt-orbit[1]*CAMERA.orbitSense},ORIENT.levelAlt[1])
      :slewAim(rig.podAimFollow,target,dt,Math.PI,CAMERA.recentre);
    aim=composeAim(craftAim,rig.podAimFollow);
    if(Math.abs(rig.podAimFollow.reduce((sum,v,i)=>sum+v*target[i],0))>1-1e-14)rig.podAimFollow=undefined;
  }
  rig.podCameraAim=aim;
  const aimed=basis(aim);look=chart(aimed.look);cameraUp=chart(aimed.up);
  const anchor=rig.craft?.anchor,scale=rig.craft?.metadata.scale??1;
  const offset=cockpit?forward.map((v,i)=>(v*anchor[0]-right[i]*anchor[1]+up[i]*anchor[2])*scale)
    :look.map((v,i)=>up[i]*3-v*Math.max(0,(settings.cameraDistance??15)-.15));
  const frame=settings.planet===false?{eye:state.slice(0,3).map((v,i)=>v+offset[i]),look,up:cameraUp}:podCameraFrame(activeFramedBody(),state,offset,look,cameraUp);
  const collisionReady=placePodCamera(rig,state,origin,frame,cockpit);
  return {look:frame.look,up:frame.up,near:orbitalNear(frame.eye[1],cockpit,settings.cameraDistance),collisionReady};
}

/** Near plane for the pod camera. A fixed 0.1 leaves a 24-bit depth buffer ~800 yd of resolution at 37 kyd, so far terrain layers z-fight (shimmer at speed);
 *  scale with altitude like the fly camera, but keep a chase pod (about cameraDistance away) inside the frustum. The cockpit view does not draw the craft. */
export function orbitalNear(altitude,cockpit,cameraDistance=15){
  const cap=cockpit?100:Math.max(.1,cameraDistance*.2);
  return Math.max(.1,Math.min(cap,Math.abs(altitude)*.01));
}

function flatCameraView(rig,state,flight,dt,origin,settings={},lookBack=false) {
  rig.origin=origin;
  const mode=flight?'fly':settings.cockpit&&rig.craft?.anchor?'cockpit':'chase';
  if(rig.cameraMode!==undefined && mode!==rig.cameraMode)rig.camera=undefined;
  rig.cameraMode=mode;rig.cameraBlocked=undefined;
  if(flight) {
    rig.camera=lifted(rig,[flight[0]-origin[0],flight[1],flight[2]-origin[1]],origin);
    const aim=flight.length>=9?basis(flight.slice(5,9)):undefined;
    return {look:aim?.look??[-Math.sin(flight[3])*Math.cos(flight[4]),Math.sin(flight[4]),-Math.cos(flight[3])*Math.cos(flight[4])],up:aim?.up,
      near:Math.max(.1,Math.min(100,Math.abs(flight[1])*.01)),collisionReady:true};
  }
  if(mode==='cockpit') {
    if(!rig.camera || !rig.cockpitLook || lookBack!==rig.lookBack)rig.cockpitLook=[0,0];
    const look=settings.cameraLook||[0,0],orbit=settings.cameraOrbit||[0,0];
    if(look.some(Boolean)||orbit.some(Boolean)){
      rig.cockpitLook[0]=wrap(rig.cockpitLook[0]-look[0]*Math.PI*dt-orbit[0]*CAMERA.orbitSense);
      rig.cockpitLook[1]=Math.max(-PITCH_LIMIT,Math.min(PITCH_LIMIT,rig.cockpitLook[1]+look[1]*Math.PI/2*dt-orbit[1]*CAMERA.orbitSense));
    } else {
      const follow=Math.exp(-CAMERA.recentre*Math.max(0,dt));
      rig.cockpitLook=rig.cockpitLook.map(n=>n*follow);
    }
    rig.lookBack=lookBack;
    const drop=rig.craftDrop??0,matrix=craftMatrix(state,origin,rig.craft.metadata.scale,drop),anchor=rig.craft.anchor;
    const transform=v=>[0,1,2].map(i=>matrix[i]*v[0]+matrix[4+i]*v[1]+matrix[8+i]*v[2]);
    const pivot=[state[0]-origin[0],state[1],state[2]-origin[1]];
    const eye=transform(anchor).map((n,i)=>n+pivot[i]);
    const clear=rig.clipCamera?.(pivot,eye,origin);
    if(!clear)rig.cameraBlocked='pending';
    else if(Math.hypot(...clear.map((n,i)=>n-eye[i]))>1e-5)
      rig.cameraBlocked=rig.cameraCollisionReady===false?'pending':'geometry';
    rig.camera=eye;
    const heading=rig.cockpitLook[0]+(lookBack?Math.PI:0),pitch=rig.cockpitLook[1];
    return {look:unit(transform([Math.cos(heading)*Math.cos(pitch),Math.sin(heading)*Math.cos(pitch),Math.sin(pitch)])),
      up:unit(Array.from(matrix.slice(8,11))),near:.1,collisionReady:!rig.cameraBlocked};
  }
  const reset=!rig.camera,yaw=state[3]+(lookBack?Math.PI:0),pitch=-Math.atan(.3);
  const look=settings.cameraLook || [0,0],orbit=settings.cameraOrbit || [0,0];
  if(reset || !rig.chase || lookBack!==rig.lookBack)rig.chase=[0,pitch];
  else if(look.some(Boolean) || orbit.some(Boolean)) {
    rig.chase[0]=wrap(rig.chase[0]-look[0]*Math.PI*dt-orbit[0]*CAMERA.orbitSense);
    rig.chase[1]=Math.max(-PITCH_LIMIT,Math.min(PITCH_LIMIT,rig.chase[1]+look[1]*Math.PI/2*dt-orbit[1]*CAMERA.orbitSense));
  } else if(settings.cameraRecentre) {
    // Recentre only while the user drives with keys/pad; a mouse orbit otherwise stays where it was left.
    const follow=-Math.expm1(-7*Math.max(0,dt));
    rig.chase[0]=wrap(rig.chase[0]* (1-follow));
    rig.chase[1]+=(pitch-rig.chase[1])*follow;
  }
  // While steering with the mouse the camera keeps its world heading and the craft turns toward it.
  if(settings.cameraSteer && Number.isFinite(rig.lastYaw))rig.chase[0]=wrap(rig.chase[0]-(state[3]-rig.lastYaw));
  rig.lastYaw=state[3];
  rig.lookBack=lookBack;
  const distance=settings.cameraDistance ?? 15,seconds=settings.cameraSeconds ?? .5;
  const heading=yaw+rig.chase[0],tilt=rig.chase[1],pivot=[state[0]-origin[0],state[1]+3,state[2]-origin[1]];
  const direction=[Math.sin(heading)*Math.cos(tilt),-Math.sin(tilt),Math.cos(heading)*Math.cos(tilt)];
  const clip=point=>rig.clipCamera?rig.clipCamera(pivot,point,origin):point;
  const wanted=clip(pivot.map((n,i)=>n+direction[i]*Math.max(0,distance-.15)));
  const blend=reset || seconds===0?1:-Math.expm1(-Math.max(0,dt)/seconds);
  const allowed=Math.hypot(...wanted.map((n,i)=>n-pivot[i]));
  rig.chaseDistance=reset||!Number.isFinite(rig.chaseDistance)?allowed:
    Math.min(allowed,rig.chaseDistance+(allowed-rig.chaseDistance)*blend);
  const grounded=state[7]===1&&!state[8];
  // Only suspension-scale vertical motion is damped; climbs and jumps cannot accumulate camera lag.
  rig.chaseBounce=!reset&&grounded&&rig.chaseGrounded&&seconds!==0
    ?Math.max(-.35,Math.min(.35,((rig.chaseBounce||0)-(state[1]-rig.chaseY))*(1-blend))):0;
  rig.chaseY=state[1];rig.chaseGrounded=grounded;
  // Soft floor: only acts while the clipped eye is below the surface, easing the eye up (never touching yaw/pitch input) and capping the lift at half the eye-pivot distance.
  const eye=clip(pivot.map((n,i)=>n+direction[i]*rig.chaseDistance+(i===1?rig.chaseBounce:0)));
  const need=floorLift(floorAt(rig,eye,origin),eye[1],Math.max(0,pivot[1]+rig.chaseDistance*.5-eye[1]));
  const settle=reset||seconds===0?1:-Math.expm1(-15*Math.max(0,dt));
  rig.chaseLift=need>(rig.chaseLift||0)?need:(reset?0:(rig.chaseLift||0)+(need-(rig.chaseLift||0))*settle);
  rig.camera=[eye[0],eye[1]+rig.chaseLift,eye[2]];
  const offset=pivot.map((n,i)=>n+(i===1?rig.chaseBounce:0)-rig.camera[i]);
  return {look:Math.hypot(...offset)>1e-6?unit(offset):direction.map(n=>-n),near:.1,collisionReady:!!rig.clipCamera};
}
