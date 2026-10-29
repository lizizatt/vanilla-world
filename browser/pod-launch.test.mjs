import test from 'node:test';
import assert from 'node:assert/strict';
import {LAUNCH,validateLaunchObjects,rampCrossing,rampPoint,pickupCrossing,spendCharge,beginRamp,stepLaunch,gravityVector,launchTelemetry} from './pod-launch.js';
import {bodyOf,altitudeAbove} from './bodies.js';
import {chartAxes} from './shared-flight.js';
import {basis} from './orient.js';
const ramp=angle=>({id:'ramp',kind:'ramp',body:'elune',pos:[-300,10,0],yaw:0,angle});
test('all ramp angles share a smooth horizontal entrance and directional swept contact',()=>{
  for(const angle of LAUNCH.angles){
    const r=ramp(angle);assert.equal(validateLaunchObjects([r])[0],r);
    assert.deepEqual(rampPoint(r,0),[-300,13,0]);
    assert(rampCrossing(r,[-300,13,5],[-300,13,-5]));
    assert(!rampCrossing(r,[-300,13,-5],[-300,13,5]));
    assert(!rampCrossing(r,[-280,13,5],[-280,13,-5]));
  }
  assert.throws(()=>validateLaunchObjects([ramp(30)]));
  assert.throws(()=>validateLaunchObjects([ramp(90),ramp(90)]));
  assert(pickupCrossing({...ramp(90),kind:'powerup'},[-320,13,0],[-280,13,0]));
});
test('powered budget counts positive boost use, with exact partial ticks and no idle consumption',()=>{
  let left=15;
  for(let i=0;i<600;i++)left=spendCharge(left,false,1,1/60).remaining;
  assert.equal(left,15);assert.equal(spendCharge(left,true,-1,.1).remaining,15);
  assert.equal(spendCharge(left,true,0,.1).remaining,15);
  let burned=0;for(let i=0;i<1801;i++){const s=spendCharge(left,true,1,1/120);left=s.remaining;burned+=s.used;}
  assert.equal(left,0);assert(Math.abs(burned-15)<1e-10);
  assert.equal(spendCharge(.001,true,1,.01).fraction,.1);
});
test('production ballistic trajectory reports ramp burn and coast on both bodies',()=>{
  for(const angle of LAUNCH.angles){
    let s=beginRamp(ramp(angle),150,15,720),burned=0,swapped=false;
    for(let i=0;i<120*1800;i++){
      const previous=s;
      s=stepLaunch(s,{throttle:s.mode==='ramp'?0:s.remaining>0?1:0,boost:s.mode==='orbit'&&s.remaining>0});
      burned+=previous.remaining-s.remaining;
      if(s.parent!==previous.parent){swapped=true;assert(Math.hypot(...s.pos.map((v,i)=>v-previous.pos[i]))<100);}
      if(s.mode==='orbit'&&(altitudeAbove(bodyOf(s.parent),s.pos,s.time)<0||s.parent==='azeroth'&&s.pose[1]<500)){
        console.log(JSON.stringify({angle,time:i/120,body:s.parent,height:s.pose[1],speed:Math.hypot(...s.velocity),burned,swapped}));
        break;
      }
      if(i===120*1800-1)console.log(JSON.stringify({angle,body:s.parent,height:s.pose[1],burned,swapped}));
    }
    assert(Math.abs(burned-15)<1e-7);
    if(angle===90)assert(swapped&&s.parent==='azeroth'&&s.pose[1]<500);
  }
});
test('ordinary Azeroth ramp launch returns to limited attitude and falls without a powered pickup',()=>{
  for(const speed of [150,300]){
    let s=beginRamp({...ramp(90),body:'azeroth'},speed,0,720),peak=0,landed=false;
    for(let i=0;i<120*120;i++){
      s=stepLaunch(s,{throttle:1,boost:true,pitch:1});
      peak=Math.max(peak,s.pose[1]);
      assert.equal(s.parent,'azeroth');
      if(s.mode==='local'&&s.pose[1]<10){landed=true;break;}
    }
    console.log(JSON.stringify({ordinaryAzerothRamp:speed,peak,landed}));
    assert(landed);assert(peak<2500);assert.equal(s.mode,'local');
  }
});
test('analog configured thrust and remaining-fraction burn agree across step subdivision',()=>{
  let s=beginRamp(ramp(90),150,15,720);
  while(s.mode==='ramp')s=stepLaunch(s,{throttle:0,boost:false});
  const half=stepLaunch(s,{throttle:.5,boost:true}),full=stepLaunch(s,{throttle:1,boost:true});
  const coast=stepLaunch(s,{throttle:0,boost:false});
  const gain=x=>x.velocity.reduce((sum,v,i)=>sum+(v-coast.velocity[i])*s.direction[i],0);
  assert(Math.abs(gain(half)/gain(full)-.5)<1e-5);
  let a=s,b=s;
  for(let i=0;i<120;i++)a=stepLaunch(a,{throttle:1,boost:true},1/120);
  for(let i=0;i<240;i++)b=stepLaunch(b,{throttle:1,boost:true},1/240);
  assert(Math.hypot(...a.pos.map((v,i)=>v-b.pos[i]))<.01);
  assert(Math.abs(a.remaining-b.remaining)<1e-10);
  const stopped=stepLaunch(s,{throttle:1,boost:true,brake:true});
  assert.equal(stopped.remaining,s.remaining);
  assert.throws(()=>stepLaunch(s,{throttle:1,pitch:NaN}));
});
test('powered boost replaces the entire engine; exhaustion with the button held restores the ordinary governor',()=>{
  let s=beginRamp(ramp(90),150,15,720);
  while(s.mode==='ramp')s=stepLaunch(s,{throttle:0,boost:false});
  const normal=stepLaunch(s,{throttle:1,boost:true}),tuned={...s,tuning:s.tuning.map((v,i)=>[2,3].includes(i)?v*10:v)};
  const changed=stepLaunch(tuned,{throttle:1,boost:true});
  assert.deepEqual(normal.velocity,changed.velocity,'Powered total is independent of ordinary throttle/boost thrust');
  for(let i=0;i<1801;i++)s=stepLaunch(s,{throttle:1,boost:true});
  assert.equal(s.remaining,0);
  // Align with existing fast motion: no ordinary engine work above its speed limit.
  const speed=Math.hypot(...s.velocity),fast={...s,direction:s.velocity.map(v=>v/speed)};
  const coast=stepLaunch(fast,{throttle:0,boost:false}),held=stepLaunch(fast,{throttle:1,boost:true});
  assert(Math.hypot(...coast.velocity.map((v,i)=>v-held.velocity[i]))<1e-8);
  assert(speed>2000,'Already-earned momentum is not erased');
  const partial={...fast,remaining:LAUNCH.step/2};
  const first=stepLaunch(partial,{throttle:1,boost:true}),second=stepLaunch({...partial,tuning:partial.tuning.map((v,i)=>[2,3].includes(i)?v*10:v)},{throttle:1,boost:true});
  assert.equal(first.remaining,0);assert.deepEqual(first.velocity,second.velocity,'Final partial burn must not leak uncapped ordinary thrust');
  const backward={...fast,velocity:fast.velocity.map(v=>-v)},reverse=stepLaunch(backward,{throttle:-1,boost:false});
  const reverseCoast=stepLaunch(backward,{throttle:0,boost:false});
  assert.deepEqual(reverse.velocity,reverseCoast.velocity,'Reverse cannot add energy above the cap either');
  assert.notDeepEqual(stepLaunch(fast,{throttle:-1,boost:false}).velocity,coast.velocity,'Reverse braking remains available');
});
test('SOI telemetry carries the full physical orientation including roll',()=>{
  let s=beginRamp(ramp(90),150,15,720),crossed=false;
  for(let i=0;i<120*50;i++){
    const old=s;s=stepLaunch(s,{throttle:s.mode==='orbit'&&s.remaining>0?1:0,boost:s.mode==='orbit'&&s.remaining>0});
    if(s.parent!==old.parent){
      const p=launchTelemetry(s,new Array(18).fill(0)),q=basis(p.slice(18)),axes=chartAxes(bodyOf(s.parent),s.pose,s.time);
      for(const [a,b] of [[q.look,s.direction],[q.up,s.up]]){
        const inertial=[0,1,2].map(i=>axes.reduce((sum,axis,j)=>sum+axis[i]*a[j],0));
        assert(Math.hypot(...inertial.map((v,i)=>v-b[i]))<1e-8);
      }
      assert(Math.hypot(...s.up.map((v,i)=>v-old.up[i]))<.1);
      crossed=true;break;
    }
  }
  assert(crossed);
});
