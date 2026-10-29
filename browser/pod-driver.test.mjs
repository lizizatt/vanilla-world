import test from 'node:test';
import assert from 'node:assert/strict';
import {PodRuntime} from './pod-driver.js';
import {beginRamp,stepLaunch,LAUNCH} from './pod-launch.js';
import {TUNING_FIELDS} from './world-tuning.js';

const object=(kind,body='elune')=>({id:kind,kind,body,pos:[0,0,0],yaw:0,...(kind==='ramp'?{angle:90}:{})});
function ground(){
  const pose=[0,3,1,0,0,120,0,1,0,0,0,0,0,0,120,1,1,0],calls=[];
  return {pose,calls,blocked:0,waiting:0,
    telemetry:()=>pose,tuning:()=>TUNING_FIELDS.map(([label,value])=>label==='Gravity'?24:value),
    tick(throttle,steer,flags,pitch,powered){calls.push(powered);pose[8]=this.waiting;if(!pose[8])pose[2]-=2;},
    pod_velocity:()=>[0,0,-120],pod_sweep(){return this.blocked;},
    pod_land(p,v){pose.splice(0,4,...p);calls.push({p,v});},
    pod_engine_step(){},pod_engine_state(){},
  };
}
test('real runtime only collects accepted body-local crossings; reset and no repeated refill',()=>{
  const p=new PodRuntime(),w=ground(),input={throttle:1,steer:0,flags:0};
  p.setObjects([object('powerup','azeroth')]);p.tick(w,input,'elune',720);assert.equal(p.remaining,0);
  p.setObjects([object('powerup')]);w.pose[2]=1;w.waiting=1;p.tick(w,input,'elune',720);assert.equal(p.remaining,0);
  w.waiting=0;p.tick(w,input,'elune',720);assert.equal(p.remaining,15);
  p.remaining=8;w.pose[2]=1;p.tick(w,input,'elune',720);assert.equal(p.remaining,8);
  p.reset();w.pose[2]=1;p.tick(w,input,'elune',720);assert.equal(p.remaining,15);
  p.tick(w,{...input,flags:3},'elune',720);assert.equal(p.remaining,15);assert.equal(w.calls.at(-1),0);
  w.waiting=1;p.tick(w,{...input,flags:2},'elune',720);assert.equal(p.remaining,15);
});
test('ramp entry, streaming holds and collision rollback preserve accepted charge and pose',()=>{
  const p=new PodRuntime(),w=ground(),input={throttle:1,steer:0,flags:2};
  p.setObjects([object('ramp')]);p.remaining=15;
  p.tick(w,{...input,flags:0},'elune',720);assert.equal(p.journey.mode,'ramp');
  const before=structuredClone(p.snapshot());w.blocked=1;
  p.tick(w,input,'elune',720);assert.equal(p.hold,1);assert.deepEqual(p.journey,before.journey);assert.equal(p.remaining,15);
  w.blocked=0;p.tick(w,input,'elune',720);assert.equal(p.remaining,15-LAUNCH.step);
  const charge=p.remaining;w.blocked=3;p.tick(w,input,'elune',720);
  assert.equal(p.journey,null);assert.equal(p.remaining,charge);assert.equal(p.hold,3);
  assert.deepEqual([...w.calls.at(-1).v],[0,0,0]);
});
test('handoff copies inertial authority without changing momentum, rejects damaged charge/tuning',()=>{
  let j=beginRamp(object('ramp'),150,15,720);
  while(j.mode==='ramp')j=stepLaunch(j,{throttle:0,boost:false});
  const p=new PodRuntime(),value={journey:j,remaining:j.remaining,spent:['pickup'],engines:[0,1,1]};
  p.adopt(value,ground());assert.deepEqual(p.journey,j);assert.notEqual(p.journey,j);
  assert.throws(()=>p.adopt({...value,remaining:3}));
  assert.throws(()=>p.adopt({...value,spent:[{}]}));
  assert.throws(()=>p.adopt({...value,journey:{...j,tuning:[]}}));
  assert.throws(()=>p.adopt({...value,journey:{...j,controlAxes:[j.controlAxes[0],j.controlAxes[0],j.controlAxes[0]]}},ground()));
  assert.throws(()=>p.adopt({...value,journey:{...j,up:j.direction}},ground()));
  assert.deepEqual(p.journey,j);
});
