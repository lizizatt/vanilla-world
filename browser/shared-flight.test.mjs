import test from 'node:test';
import assert from 'node:assert/strict';
import {AZEROTH,centreAt,altitudeAbove,bodyOf,fromInertial} from './bodies.js';
import {stepShared} from './shared-flight.js';
const aimUp={look:[0,1,0],right:[1,0,0],up:[0,0,-1]};
test('a stationary camera keeps its chart pose', () => {
  const pose=[100,5000,200,0,0],r=stepShared(undefined,pose,aimUp,{forward:0},.016,1000);
  assert.equal(r.swapped,false);
  for(let i=0;i<3;i++)assert.ok(Math.abs(r.pose[i]-pose[i])<1,`axis ${i}`);
});
test('climbing straight up raises altitude without swapping near Azeroth', () => {
  let space,pose=[0,5000,0,0,0],t=1000;
  for(let i=0;i<60;i++){const r=stepShared(space,pose,aimUp,{forward:1,fast:true},1/60,t);space=r.space;pose=r.pose;assert.ok(!r.swapped);}
  assert.ok(altitudeAbove(AZEROTH,space.pos,t)>5000);
});
test('flying toward Elune with the look vector crosses into its well', () => {
  const t=1000;
  let space,pose=[0,20000,0,0,0],swapped=false,aim=aimUp;
  for(let i=0;i<4000&&!swapped;i++){
    const r=stepShared(space,pose,aim,{forward:1,fast:true},1/30,t);space=r.space;pose=r.pose;swapped=r.swapped;
    if(!swapped)aim=chartAim(space,t);
  }
  assert.ok(swapped||space.parent==='elune');
});
function chartAim(space,t) {
  const body=bodyOf(space.parent),c=centreAt(bodyOf('elune'),t),d=c.map((v,i)=>v-space.pos[i]),n=Math.hypot(...d),u=d.map(v=>v/n);
  const p=fromInertial(body,space.pos,t),q=fromInertial(body,space.pos.map((v,i)=>v+u[i]),t,p[0]);
  const l=q.map((v,i)=>v-p[i]),m=Math.hypot(...l);
  return {look:l.map(v=>v/m),right:[1,0,0],up:[0,1,0]};
}


test('a page booted on another body steps in that body chart (home parent)',()=>{const A={look:[0,0,-1],right:[1,0,0],up:[0,1,0]},r=stepShared(undefined,[-32000,15000,0,0,0],A,{forward:0,strafe:0,lift:0,fast:false},.016,720,2,'elune');assert.equal(r.parent,'elune');assert.ok(r.pose.every(Number.isFinite));});


