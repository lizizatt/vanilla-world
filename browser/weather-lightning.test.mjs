import test from 'node:test';
import assert from 'node:assert/strict';
import {LightningScheduler,hash01,flashEnvelope,thunderDelay,thunderGain} from './weather-lightning.js';
import {WEATHER as W} from './weather-config.js';

const grid=v=>new Float32Array(W.polar.azimuth*W.polar.rings).fill(v);
const run=(polar,seconds,enabled=true)=>{const s=new LightningScheduler(),thunder=[];let strikes=0;
  for(let t=0;t<seconds;t+=.1){const before=s.serial;thunder.push(...s.step(t,{eye:[0,0,0],polar,enabled}));strikes+=s.serial-before;}
  return {s,thunder,strikes};};

test('hash is deterministic and spread over [0,1)',()=>{
  assert.equal(hash01(5,3),hash01(5,3));assert.notEqual(hash01(5,3),hash01(5,4));
  let sum=0;for(let i=0;i<5000;i++){const h=hash01(i);assert(h>=0&&h<1);sum+=h;}assert(Math.abs(sum/5000-.5)<.03);
});
test('no lightning without heavy cells or when disabled',()=>{
  assert.equal(run(grid(.7),600).strikes,0);
  assert.equal(run(grid(1),600,false).strikes,0);
});
test('heavy cells strike at about the configured mean gap, deterministically',()=>{
  const a=run(grid(1),1400),b=run(grid(1),1400);
  assert.equal(a.strikes,b.strikes);
  const gap=1400/a.strikes;assert(gap>W.lightning.meanGap*.6&&gap<W.lightning.meanGap*1.6,`gap ${gap}`);
});
test('strikes only land in heavy cells',()=>{
  const polar=grid(0),R=W.polar.rings;for(let k=0;k<R;k++)polar[7*R+k]=1;
  const {s}=run(polar,1500);assert(s.serial>3);
  for(const b of s.bolts){const a=Math.floor((Math.atan2(b.z,b.x)/(2*Math.PI)+1)%1*W.polar.azimuth);assert.equal(a,7);}
});
test('thunder arrives after distance / speed of sound, fainter when far',()=>{
  assert.equal(thunderDelay(343),1);assert(thunderGain(14000)===0&&thunderGain(0)===1&&thunderGain(2000)>thunderGain(9000));
  const s=new LightningScheduler();s.strike(10,0,3430,3430);
  assert.deepEqual(s.step(19.9,{eye:[0,0,0],polar:grid(0)}),[]);
  assert.equal(s.step(20.1,{eye:[0,0,0],polar:grid(0)}).length,1);assert.equal(s.step(21,{eye:[0,0,0],polar:grid(0)}).length,0);
});
test('flash envelope is sharp, bounded and ends',()=>{
  assert.equal(flashEnvelope(-.1),0);assert(flashEnvelope(0)>.5);assert.equal(flashEnvelope(W.lightning.flash),0);
  for(let t=0;t<W.lightning.flash;t+=.005){const f=flashEnvelope(t);assert(f>=0&&f<=1);}
  const s=new LightningScheduler();s.strike(5,0,100,100);assert(s.flash(5.01)>.3);assert.equal(s.flash(6),0);
});
