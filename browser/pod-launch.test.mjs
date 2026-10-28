import test from 'node:test';
import assert from 'node:assert/strict';
import {LAUNCH,validateLaunchObjects,rampCrossing,rampPoint,pickupCrossing,spendCharge,beginRamp,stepLaunch,gravityVector} from './pod-launch.js';
import {bodyOf,altitudeAbove} from './bodies.js';
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
