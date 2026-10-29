import {LAUNCH,validateLaunchObjects,rampCrossing,pickupCrossing,spendCharge,beginRamp,stepLaunch,launchTelemetry} from './pod-launch.js';
import {bodyOf,podGravityScale,toInertial} from './bodies.js';
import {chartAxes} from './shared-flight.js';
import {validateTuningRecord} from './world-tuning.js';
import {podInSpace} from './pod-attitude.js';
import {POLE_FRAME_SPEC} from './pole-source.js';
import {poleLanding} from './pole-prefetch.js';
/** Land at pose facing yaw; poleward of the frame handoff the pose and velocity are re-expressed in the pole chart (the journey itself is flown in E). */
const land=(world,body,pose,yaw,v)=>{const p=poleLanding(POLE_FRAME_SPEC[body],pose,yaw,v);world.pod_land(new Float64Array(p?p.pose:[...pose,yaw]),new Float32Array(p?p.velocity:v));};

export class PodRuntime {
  constructor(){this.objects=[];this.remaining=0;this.spent=new Set();this.journey=null;this.time=720;this.hold=0;this.control=undefined;}
  reset(){this.remaining=0;this.spent.clear();this.journey=null;this.hold=0;this.control=undefined;}
  queueControl(control){
    this.control=podInSpace(this.journey)?control:undefined;
  }
  setObjects(objects){this.objects=structuredClone(validateLaunchObjects(objects));}
  telemetry(world){const p=this.journey?launchTelemetry(this.journey,world.telemetry()):Array.from(world.telemetry());if(this.hold)p[8]=this.hold;return p;}
  snapshot(world){const p=world?.telemetry();return {remaining:this.remaining,spent:[...this.spent],journey:this.journey,hold:this.hold,engines:p?[p[6],p[15],p[16]]:undefined};}
  adopt(value,world){
    const j=value?.journey;
    if(!j||j.mode!=='orbit'||!Number.isFinite(j.time)||!bodyOf(j.parent)||
      (j.freeAttitude!==undefined&&typeof j.freeAttitude!=='boolean')||
      ![j.pos,j.velocity,j.direction,j.pose,j.look,j.up].every(a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite))||
      !Array.isArray(j.controlAxes)||j.controlAxes.length!==3||!j.controlAxes.every(a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite)&&Math.abs(Math.hypot(...a)-1)<1e-8)||
      !j.controlAxes.every((a,i)=>j.controlAxes.every((b,k)=>i===k||Math.abs(a.reduce((sum,v,n)=>sum+v*b[n],0))<1e-8))||
      !Number.isFinite(j.gravity)||j.gravity<=0||!Number.isFinite(value.remaining)||value.remaining<0||value.remaining>15||
      j.remaining!==value.remaining||!Array.isArray(value.spent)||value.spent.length>256||
      !value.spent.every(id=>typeof id==='string'&&/^[a-z0-9-]{1,80}$/.test(id))||
      Math.abs(Math.hypot(...j.direction)-1)>1e-8||
      Math.abs(Math.hypot(...j.up)-1)>1e-8||Math.abs(j.up.reduce((sum,v,i)=>sum+v*j.direction[i],0))>1e-8||
      !Array.isArray(value.engines)||value.engines.length!==3||!value.engines.every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('Invalid pod handoff');
    validateTuningRecord({version:1,values:j.tuning,cameraSeconds:0});
    world.pod_engine_state(new Float32Array(value.engines));
    this.journey=structuredClone(j);this.remaining=value.remaining;this.spent=new Set(value.spent);this.hold=0;this.control=undefined;
  }
  tick(world,input,body,time){
    const dt=LAUNCH.step;this.hold=0;
    if(!this.journey){
      this.time=time;
      const before=Array.from(world.telemetry()),budget=spendCharge(this.remaining,!!(input.flags&2)&&!(input.flags&1),input.throttle,dt);
      world.tick(input.throttle,input.steer,input.flags,input.pitch??0,budget.fraction);
      const after=Array.from(world.telemetry());
      if(after[8])return;
      this.remaining=budget.remaining;
      for(const o of this.objects){
        if(o.body!==body)continue;
        if(o.kind==='powerup'&&!this.spent.has(o.id)&&pickupCrossing(o,before,after)){
          this.remaining=LAUNCH.charge;this.spent.add(o.id);
        }else if(o.kind==='ramp'&&rampCrossing(o,before,after)){
          const v=Array.from(world.pod_velocity()),speed=-Math.sin(o.yaw)*v[0]-Math.cos(o.yaw)*v[2];
          if(speed>0){
            const tuning=Array.from(world.tuning());
            const journey=beginRamp(o,speed,this.remaining,time,tuning[14]/podGravityScale(body),tuning);
            if(world.pod_sweep(new Float64Array(after.slice(0,3)),new Float64Array(journey.pose))===0)this.journey=journey;
            break;
          }
        }
      }
      return;
    }
    if(this.journey.parent!==body)return;
    const old=this.journey,next=stepLaunch(old,{...input,podControl:this.control,boost:!!(input.flags&2),brake:!!(input.flags&1)});
    // At an SOI transition the destination worker checks its own chart on the next step.
    const collision=next.parent===old.parent?world.pod_sweep(new Float64Array(old.pose),new Float64Array(next.pose)):0;
    if(collision===1){this.hold=1;return;}
    if(collision){
      const pose=old.pose;
      const axes=chartAxes(bodyOf(body),pose,old.time);
      const a=toInertial(bodyOf(body),pose,old.time-.001),b=toInertial(bodyOf(body),pose,old.time+.001);
      const inertial=old.mode==='orbit'?old.velocity.map((v,i)=>v-(b[i]-a[i])*1000):[0,0,0];
      const v=collision===3?[0,0,0]:old.mode==='local'?old.velocity.slice():axes.map(axis=>axis.reduce((n,x,i)=>n+x*inertial[i],0));
      v[1]=Math.max(0,v[1]);
      land(world,body,pose,Math.atan2(-old.look[0],-old.look[2]),v);
      this.journey=null;this.hold=collision===3?3:0;return;
    }
    if(next.mode==='ramp'&&next.speed<=0){
      land(world,body,next.pose,next.ramp.yaw,[0,0,0]);
      this.journey=null;return;
    }
    world.pod_engine_step(input.throttle,input.flags,(old.remaining-next.remaining)/dt);
    this.journey=next;this.remaining=next.remaining;this.time=next.time;
  }
}
