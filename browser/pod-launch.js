// Original launch guides and inertial pod dynamics; no renderer, timers or browser state.
import {bodyOf,centreAt,toInertial,fromInertial,parentOf,BODIES,podGravityScale} from './bodies.js';
import {chartAxes} from './shared-flight.js';
import {TUNING_FIELDS} from './world-tuning.js';
import {fromBasis,basis} from './orient.js';
import {podInSpace,aimQuaternion,slewAim,validatePodControl} from './pod-attitude.js';

export const LAUNCH={angles:[15,25,45,90],radius:48,width:16,charge:15,power:172,step:1/120};
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const unit=v=>{const n=Math.hypot(...v);if(!n)throw Error('Zero launch direction');return v.map(x=>x/n);};
const add=(a,b,k=1)=>a.map((v,i)=>v+b[i]*k);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const along=yaw=>[-Math.sin(yaw),0,-Math.cos(yaw)];
export function validateLaunchObjects(value) {
  if(!Array.isArray(value)||value.length>128)throw Error('Launch objects must be a list of at most 128 objects');
  const ids=new Set();
  for(const o of value){
    if(!o||typeof o.id!=='string'||!/^[a-z0-9-]{1,80}$/.test(o.id)||ids.has(o.id)||
      !BODIES[o.body]||!['ramp','powerup'].includes(o.kind)||!Array.isArray(o.pos)||o.pos.length!==3||
      !o.pos.every(n=>Number.isFinite(n)&&Math.abs(n)<1e9)||!Number.isFinite(o.yaw)||
      (o.kind==='ramp'&&!LAUNCH.angles.includes(o.angle)))throw Error('Invalid or duplicate launch object');
    ids.add(o.id);
  }
  return value;
}
export function rampPoint(ramp,angle,hover=3) {
  const f=along(ramp.yaw),r=LAUNCH.radius;
  return [ramp.pos[0]+f[0]*r*Math.sin(angle),ramp.pos[1]+hover+r*(1-Math.cos(angle)),ramp.pos[2]+f[2]*r*Math.sin(angle)];
}
export function rampTangent(ramp,angle) {
  const f=along(ramp.yaw);return [f[0]*Math.cos(angle),Math.sin(angle),f[2]*Math.cos(angle)];
}
export function rampCrossing(ramp,a,b) {
  const f=along(ramp.yaw),side=[-f[2],0,f[0]],d=a.slice(0,3).map((v,i)=>v-ramp.pos[i]),e=b.slice(0,3).map((v,i)=>v-ramp.pos[i]);
  const from=dot(d,f),to=dot(e,f);
  if(from>0||to<=0||to<=from)return false;
  const t=-from/(to-from),hit=d.map((v,i)=>v+(e[i]-v)*t);
  return Math.abs(dot(hit,side))<=LAUNCH.width/2&&hit[1]>=0&&hit[1]<=8;
}
export function pickupCrossing(o,a,b) {
  const center=add(o.pos,[0,3,0]),v=b.slice(0,3).map((x,i)=>x-a[i]),d=center.map((x,i)=>x-a[i]);
  const t=Math.max(0,Math.min(1,dot(d,v)/(dot(v,v)||1)));
  return Math.hypot(...d.map((x,i)=>x-v[i]*t))<=5;
}
export function spendCharge(remaining,boost,throttle,dt) {
  if(!Number.isFinite(remaining)||remaining<0||remaining>LAUNCH.charge||!Number.isFinite(dt)||dt<0)throw Error('Invalid powered boost budget');
  const used=boost&&throttle>0?Math.min(remaining,dt):0;
  return {remaining:Math.max(0,remaining-used),used,fraction:dt?used/dt:0};
}
export function beginRamp(ramp,speed,remaining,time,gravity=48,tuning=TUNING_FIELDS.map(f=>f[1])) {
  if(!Number.isFinite(speed)||speed<=0)throw Error('A ramp requires forward speed');
  return {mode:'ramp',parent:ramp.body,ramp:structuredClone(ramp),angle:0,speed,remaining,time,gravity,tuning:[...tuning],interplanetary:remaining>0,
    pose:rampPoint(ramp,0,tuning[11]),look:rampTangent(ramp,0)};
}
const inertialVector=(axes,v)=>[0,1,2].map(i=>axes.reduce((n,a,j)=>n+a[i]*v[j],0));
function launchOrbit(state) {
  if(!state.interplanetary)return {...state,mode:'local',velocity:state.look.map(v=>v*state.speed),direction:state.look.slice()};
  const body=bodyOf(state.parent),axes=chartAxes(body,state.pose,state.time);
  // Exact moving-frame derivative (2 simulation units / real second at normal drive time).
  const before=toInertial(body,state.pose,state.time-.001),after=toInertial(body,state.pose,state.time+.001);
  const carry=after.map((v,i)=>(v-before[i])*1000);
  return {...state,mode:'orbit',pos:toInertial(body,state.pose,state.time),
    controlAxes:axes,
    velocity:add(inertialVector(axes,state.look.map(v=>v*state.speed)),carry),
    direction:unit(inertialVector(axes,state.look)),
    up:unit(inertialVector(axes,[Math.sin(state.ramp.yaw)*Math.sin(state.angle),Math.cos(state.angle),Math.cos(state.ramp.yaw)*Math.sin(state.angle)]))};
}
export function gravityVector(pos,time,baseGravity=48) {
  let g=[0,0,0];
  for(const body of Object.values(BODIES)){
    const d=centreAt(body,time).map((v,i)=>v-pos[i]),r=Math.hypot(...d);
    if(!Number.isFinite(r)||r<1)throw Error('Ballistic position is at a body centre');
    g=add(g,d,baseGravity*podGravityScale(body.id)*body.radius**2/r**3);
  }
  return g;
}
export function stepLaunch(state,input,dt=LAUNCH.step) {
  validatePodControl(input.podControl);
  if(!Number.isFinite(dt)||dt<=0||dt>1/30||![input.throttle,input.pitch??0,input.steer??0].every(Number.isFinite))throw Error('Invalid ballistic step');
  const throttle=input.brake?0:Math.max(-1,Math.min(1,input.throttle)),boost=input.boost&&throttle>0;
  const budget=spendCharge(state.remaining,boost,throttle,dt),tuning=state.tuning;
  const ordinary=(tuning[2]+(boost?tuning[3]:0))*(state.mode==='ramp'?1:tuning[16]);
  const thrust=throttle*(ordinary*(1-budget.fraction)+LAUNCH.power*budget.fraction);
  const next={...state,remaining:budget.remaining,time:state.time+2*dt};
  if(state.mode==='ramp'){
    const g=state.gravity*podGravityScale(state.parent);
    const speed=Math.max(0,state.speed+(thrust-g*Math.sin(state.angle))*dt);
    const angle=Math.min(state.ramp.angle*Math.PI/180,state.angle+(state.speed+speed)*.5*dt/LAUNCH.radius);
    Object.assign(next,{speed,angle,pose:rampPoint(state.ramp,angle,tuning[11]),look:rampTangent(state.ramp,angle)});
    if(angle>=state.ramp.angle*Math.PI/180)return launchOrbit(next);
    return next;
  }
  let direction=state.direction,carriedUp=state.up;
  const control=input.podControl;
  if(podInSpace(state)&&control?.active){
    const aimed=basis(slewAim(aimQuaternion(direction,carriedUp),control.aim,dt));
    direction=aimed.look;carriedUp=aimed.up;
    next.freeAttitude=true;
  }
  if(state.remaining<=0&&!next.freeAttitude){
    const axes=state.mode==='local'?[[1,0,0],[0,1,0],[0,0,1]]:state.controlAxes;
    const look=state.mode==='local'?state.look:axes.map(a=>dot(a,state.direction));
    const yaw=Math.atan2(-look[0],-look[2])+(input.steer||0)*tuning[6]*tuning[16]*dt,pitch=Math.max(-1,Math.min(1,input.pitch||0))*20*Math.PI/180;
    const target=inertialVector(axes,[-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)]);
    direction=unit(add(state.direction,target.map((v,i)=>v-state.direction[i]),-Math.expm1(-8*dt)));
  }
  if(state.mode==='local'){
    const a=add(direction.map(v=>v*thrust),[0,-state.gravity*podGravityScale(state.parent),0]);
    const velocity=add(state.velocity,a,dt),drag=Math.exp(-tuning[5]*tuning[16]*dt);
    velocity[0]*=drag;velocity[2]*=drag;
    const horizontal=Math.hypot(velocity[0],velocity[2]),cap=tuning[boost?1:0];
    if(horizontal>cap){velocity[0]*=cap/horizontal;velocity[2]*=cap/horizontal;}
    const pose=add(state.pose,add(state.velocity,velocity),dt/2);
    if(![...pose,...velocity].every(Number.isFinite))throw Error('Nonfinite local launch state');
    return {...next,pose,velocity,direction,look:direction};
  }
  let force=direction.map(v=>v*thrust);
  if(budget.fraction<1&&throttle!==0){
    // Govern ordinary engine work on the whole airspeed, never ballistic momentum or gravity.
    const body=bodyOf(state.parent);
    const before=toInertial(body,state.pose,state.time-.001),after=toInertial(body,state.pose,state.time+.001);
    const relative=state.velocity.map((v,i)=>v-(after[i]-before[i])*1000);
    if(Math.hypot(...relative)>=tuning[boost?1:0]&&dot(direction,relative)*throttle>0)
      force=direction.map(v=>v*throttle*LAUNCH.power*budget.fraction);
  }
  const g=gravityVector(state.pos,state.time,state.gravity),a=add(g,force);
  const pos=add(add(state.pos,state.velocity,dt),a,.5*dt*dt);
  const end=add(gravityVector(pos,next.time,state.gravity),force);
  const velocity=add(state.velocity,add(a,end),.5*dt);
  const parent=parentOf(pos,next.time,state.parent),body=bodyOf(parent);
  const pose=fromInertial(body,pos,next.time,parent===state.parent?state.pose[0]:body.centre[0]);
  const axes=chartAxes(body,pose,next.time),look=axes.map(v=>dot(v,direction));
  // Carry roll with the forward axis, rather than rebuilding "up" from the new gravity well.
  const up=unit(add(carriedUp,direction,-dot(carriedUp,direction)));
  if(![...pos,...velocity,...pose,...look].every(Number.isFinite))throw Error('Nonfinite ballistic state');
  return {...next,parent,pos,velocity,pose,look,direction,up};
}
export function launchTelemetry(state,base) {
  const p=Array.from(base),speed=state.velocity?Math.hypot(...state.velocity):state.speed;
  p.splice(0,5,...state.pose,Math.atan2(-state.look[0],-state.look[2]),0);
  p[5]=speed;p[7]=0;p[8]=0;p[11]=Math.round(p[0]);p[12]=Math.round(p[2]);p[14]=speed;
  p[17]=Math.asin(Math.max(-1,Math.min(1,state.look[1])));
  if(state.mode==='orbit'){
    const axes=chartAxes(bodyOf(state.parent),state.pose,state.time),up=axes.map(a=>dot(a,state.up));
    p.splice(18,4,...fromBasis(cross(state.look,up),up,state.look));
  }
  return p;
}

export function launchAsset(o) {
  const vertices=[],indices=[],color=o.kind==='ramp'?[.2,.65,.85,1]:[.4,1,.55,1];
  const push=p=>vertices.push(...p,0,1,0,0,0,...color);
  if(o.kind==='ramp'){
    for(let i=0;i<=24;i++){
      const a=i/24*o.angle*Math.PI/180,x=LAUNCH.radius*Math.sin(a),y=LAUNCH.radius*(1-Math.cos(a));
      push([-LAUNCH.width/2,y,-x]);push([LAUNCH.width/2,y,-x]);
      if(i){const n=i*2;indices.push(n-2,n,n-1,n-1,n,n+1);}
    }
  }else{
    for(const p of [[0,7,0],[-3,3,0],[0,3,-3],[3,3,0],[0,3,3],[0,-1,0]])push(p);
    for(let i=1;i<=4;i++){const j=i===4?1:i+1;indices.push(0,i,j,5,j,i);}
  }
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),
    batches:[{firstIndex:0,indexCount:indices.length,texture:null,doubleSided:true,emissive:.3}]};
}
