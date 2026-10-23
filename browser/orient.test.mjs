import test from 'node:test';
import assert from 'node:assert/strict';
import {basis,fromEuler,toEuler,stepOrient,spaceBlend} from './orient.js';
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],ang=(a,b)=>Math.acos(Math.max(-1,Math.min(1,dot(a,b))));
const rng=s=>()=>(s=(s*1664525+1013904223)>>>0)/4294967296;
const sound=q=>{const b=basis(q);assert.ok(q.every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...q)-1)<1e-9);
  assert.ok(Math.abs(dot(b.right,b.up))<1e-9&&Math.abs(dot(b.right,b.look))<1e-9&&Math.abs(dot(b.up,b.look))<1e-9);return b;};

test('euler round trip and level camera matches yaw/pitch control',()=>{
  for(const [y,p] of [[0,0],[1,.4],[-2.5,-1.2],[3,1.5]]) {
    const b=sound(fromEuler(y,p)),want=[-Math.sin(y)*Math.cos(p),Math.sin(p),-Math.cos(y)*Math.cos(p)];
    assert.ok(ang(b.look,want)<1e-9);assert.ok(Math.abs(b.right[1])<1e-9);
    const [y2,p2]=toEuler(fromEuler(y,p));assert.ok(Math.abs(p2-p)<1e-9&&Math.abs(Math.atan2(Math.sin(y2-y),Math.cos(y2-y)))<1e-6);
  }
});

test('straight down and up keep a defined basis, yaw still turns, no NaN',()=>{
  for(const alt of [100,20000]) for(const p of [-Math.PI/2,Math.PI/2]) {
    let q=fromEuler(.7,p);const b0=sound(q);
    for(let i=0;i<60;i++)q=stepOrient(q,{yaw:.05},alt,1/60);
    const b=sound(q);assert.ok(alt<1000?ang(b.look,b0.look)<1e-6:ang(b.look,b0.look)>.5,'ground yaw spins about the pole, space yaw turns the look');
    assert.ok(ang(b.right,b0.right)>.1,'yaw rotates the view');
  }
});

test('random inputs across altitudes: orthonormal, no jumps, roll bounded below the fade',()=>{
  const r=rng(7);let worst=0;
  for(let run=0;run<200;run++) {
    let q=fromEuler(r()*6-3,r()*3-1.5),alt=[300,2500,60000,900000][run%4],prev=basis(q),hold=[0,0,0];
    for(let i=0;i<400;i++) {
      if(i%80===0)hold=[r()*2-1,r()*2-1,r()*2-1];
      q=stepOrient(q,{yaw:hold[0]*1.2/60,pitch:hold[1]*1.2/60,roll:alt>1000?hold[2]*.6/60:0},alt,1/60);
      const b=sound(q);worst=Math.max(worst,ang(b.look,prev.look),ang(b.up,prev.up));prev=b;
      if(alt<1000&&i>200&&b.look[1]**2<.9)assert.ok(Math.abs(b.right[1])<.05,`roll drift ${b.right[1]}`);
    }
  }
  assert.ok(worst<.07,`per-frame jump ${worst}`);
});

test('pitch sweeps through the vertical: continuous in space, clamped on the ground',()=>{
  let q=fromEuler(0,0),prev=basis(q).look,max=0,top=0;
  for(let i=0;i<600;i++){q=stepOrient(q,{pitch:.02},50000,1/60);const b=sound(q);max=Math.max(max,ang(b.look,prev));prev=b.look;top=Math.max(top,b.look[1]);}
  assert.ok(max<.021&&top>.999,'sweeps over the top smoothly');
  let g=fromEuler(0,0);for(let i=0;i<600;i++)g=stepOrient(g,{pitch:.02},200,1/60);
  assert.ok(basis(g).up[1]>=-1e-9&&basis(g).look[1]<=1,'ground stays upright');assert.ok(toEuler(g)[1]<=1.5708);
});

test('descent levels an upside-down camera smoothly and the blend is continuous',()=>{
  let q=fromEuler(0,0);for(let i=0;i<200;i++)q=stepOrient(q,{pitch:.02,roll:.01},50000,1/60);
  let prev=basis(q).look,max=0;
  for(let i=0;i<300;i++){q=stepOrient(q,{},200,1/60);const b=sound(q);max=Math.max(max,ang(b.look,prev));prev=b.look;}
  assert.ok(max<.05&&basis(q).up[1]>.4&&Math.abs(basis(q).right[1])<.01,`levelled ${basis(q).up[1]} max ${max}`);
  let last=0;for(let a=0;a<=6000;a+=10){const s=spaceBlend(a);assert.ok(s>=last&&s-last<.01);last=s;}
});
