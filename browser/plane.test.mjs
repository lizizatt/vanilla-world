import test from 'node:test';
import assert from 'node:assert/strict';
import {PLANE,newPlane,stepPlane,forward} from './plane.js';
const run=(p,input,s,ground=NaN)=>{for(let i=0;i<s*60;i++)stepPlane(p,input,1/60,ground);return p;};
test('forward points at -Z for yaw 0 and climbs with pitch',()=>{
  const f=forward({yaw:0,pitch:0});
  assert.ok(Math.abs(f[0])<1e-9&&f[1]===0&&f[2]===-1);
  assert.ok(forward({yaw:0,pitch:.5})[1]>0);
});
test('cruise holds altitude and speed with throttle',()=>{
  const p=newPlane([0,500,0]);run(p,{throttle:1,steer:0,pitch:0},10);
  assert.ok(Math.abs(p.speed-PLANE.cruise)<8,p.speed);assert.ok(Math.abs(p.pos[1]-500)<1);
});
test('banking right turns right (yaw decreases, drifts toward +X)',()=>{
  const p=newPlane([0,500,0]);run(p,{throttle:1,steer:1,pitch:0},4);
  assert.ok(p.yaw<0);assert.ok(p.pos[0]>10);
});
test('below stall speed the plane sinks and the nose drops',()=>{
  const p=newPlane([0,500,0]);p.speed=5;run(p,{throttle:0,steer:0,pitch:0},3);
  assert.ok(p.pos[1]<450,p.pos[1]);assert.ok(p.pitch<0);
});
test('boost exceeds cruise, drains the reserve and is capped',()=>{
  const p=newPlane([0,5000,0]);p.speed=PLANE.cruise;run(p,{throttle:1,steer:0,pitch:0,boost:true},3);
  assert.ok(p.speed>PLANE.cruise*1.5,p.speed);assert.ok(p.boost<1);
  run(p,{throttle:1,steer:0,pitch:0,boost:true},60);assert.ok(p.speed<=PLANE.boostSpeed);assert.ok(p.boost<.01);
});
test('ground is never penetrated and reports contact',()=>{
  const p=newPlane([0,10,0]);p.pitch=-.5;const c=[];
  for(let i=0;i<120;i++){stepPlane(p,{throttle:1,steer:0,pitch:-1},1/60,0);c.push(p.contact);assert.ok(p.pos[1]>=PLANE.clearance-1e-9);}
  assert.ok(c.includes('ground'));
});
test('deterministic',()=>{
  const a=run(newPlane([1,300,2],.3),{throttle:1,steer:.5,pitch:.2},5),b=run(newPlane([1,300,2],.3),{throttle:1,steer:.5,pitch:.2},5);
  assert.deepEqual(a,b);
});
