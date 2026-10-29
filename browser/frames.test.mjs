import test from 'node:test';
import assert from 'node:assert/strict';
import {chartToDir,dirToChart,frameFor,hop,trueLength,dirToBody,dirToFrame,headingOf,bodyLat} from './frames.js';
import {PLANET_RADIUS as R,WORLD_CENTRE} from './space.js';

const deg=Math.PI/180,near=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<=e,`${a} vs ${b}`);

test('pole frame origin is the pole and Q is a rotation (round trip)',()=>{
  near(chartToDir('N',0,0,WORLD_CENTRE,R)[1],1);near(chartToDir('S',0,0,WORLD_CENTRE,R)[1],-1);
  const d=[.3,.5,Math.sqrt(1-.34)];for(const f of ['N','S'])dirToBody(f,dirToFrame(f,d)).forEach((v,i)=>near(v,d[i],1e-12));
});

test('chart -z at the pole heads away along the lon-0 meridian (both poles)',()=>{
  for(const f of ['N','S']){const d=chartToDir(f,0,-500,WORLD_CENTRE,R);near(d[2],0,1e-9);assert.ok(d[0]>0);}
});

test('stretch inside the cap rim stays small (rotated equirect)',()=>{
  const rim=13.5*deg*R;// Azeroth ice edge + berg belt
  let worst=1;for(let a=0;a<2*Math.PI;a+=.1){const x=rim*Math.cos(a),z=rim*Math.sin(a);worst=Math.max(worst,Math.hypot(1/trueLength('N',x,z,1,0,WORLD_CENTRE,R),1/trueLength('N',x,z,0,1,WORLD_CENTRE,R)));}
  assert.ok(Math.max(...[0,1].map(k=>1/trueLength('N',rim,0,k?0:1,k?1:0,WORLD_CENTRE,R)))<1.2);
  assert.ok(worst>=1);
});

test('frameFor has hysteresis and never jumps pole to pole',()=>{
  const p={handoff:72*deg,hysteresis:1*deg},at=lat=>[Math.cos(lat*deg),Math.sin(lat*deg),0];
  assert.equal(frameFor(at(71.5),'E',p),'E');assert.equal(frameFor(at(72.2),'E',p),'N');
  assert.equal(frameFor(at(71.5),'N',p),'N');assert.equal(frameFor(at(70.9),'N',p),'E');
  assert.equal(frameFor(at(-73),'E',p),'S');assert.equal(frameFor(at(80),'S',p),'S');
});

test('hop E -> N -> E round trips pose and conserves true speed',()=>{
  const lat=72.5*deg,lon=40*deg;
  const [x,z]=dirToChart('E',[Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)],WORLD_CENTRE,R);
  for(const yaw of [0,1,2.5,-2]){
    const s0={x,z,yaw,vx:-Math.sin(yaw)*30,vz:-Math.cos(yaw)*30};
    const n=hop(s0,'E','N',WORLD_CENTRE,R),back=hop(n,'N','E',WORLD_CENTRE,R);
    near(back.x,s0.x,1e-3);near(back.z,s0.z,1e-3);near(Math.sin(back.yaw),Math.sin(yaw),1e-4);near(back.vx,s0.vx,1e-3);near(back.vz,s0.vz,1e-3);
    near(trueLength('E',s0.x,s0.z,s0.vx,s0.vz,WORLD_CENTRE,R),trueLength('N',n.x,n.z,n.vx,n.vz,WORLD_CENTRE,R),1e-3);
  }
});

test('hop keeps the heading on the true ground track',()=>{
  const lat=72*deg,d=[Math.cos(lat),Math.sin(lat),0],[x,z]=dirToChart('E',d,WORLD_CENTRE,R),yaw=.7,[hx,hz]=headingOf(yaw);
  const n=hop({x,z,yaw,vx:0,vz:0},'E','N',WORLD_CENTRE,R),step=20;
  const before=chartToDir('E',x+hx*step/Math.cos(lat)*Math.cos(lat),z+hz*step,WORLD_CENTRE,R);// small step in E chart
  const [nh,nz]=headingOf(n.yaw),after=chartToDir('N',n.x+nh*step,n.z+nz*step,WORLD_CENTRE,R);
  // same direction of travel to first order: both steps leave the start by roughly the same bearing
  const d0=chartToDir('N',n.x,n.z,WORLD_CENTRE,R),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const t1=before.map((v,i)=>v-d[i]),t2=after.map((v,i)=>v-d0[i]),cr=cross(t1,t2);
  assert.ok(Math.hypot(...cr)/(Math.hypot(...t1)*Math.hypot(...t2))<.15);
  assert.ok(bodyLat(d0)>71.9*deg);
});
