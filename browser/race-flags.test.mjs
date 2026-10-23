import test from 'node:test';
import assert from 'node:assert/strict';
import {beaconScale,gateMesh,flagPosition,flagMesh,nearestFlag,loadTracks,FLAG_RANGE} from './race-flags.js';

const track={id:'a',start:{pos:[100,10,100],yaw:0},gates:[{pos:[100,10,0],yaw:0,width:30}]};

test('flag mesh has terrain-pipeline vertex layout and distinct materials',()=>{
  const m=flagMesh(10);
  assert.equal(m.length%7,0);assert.equal(m.length/7,(1+6+1)*36);
  const mats=new Set();let top=-Infinity;
  for(let i=0;i<m.length;i+=7){mats.add(m[i+6]);top=Math.max(top,m[i+1]);}
  assert.deepEqual([...mats].sort(),[5,6,7,8]);
  assert.equal(top,10+24+260);
});
test('flag stands beside the start line',()=>{
  const [x,y,z]=flagPosition(track);
  assert.equal(y,10);assert.ok(Math.abs(x-112)<1e-9&&Math.abs(z-100)<1e-9);
});
test('nearestFlag respects range and height',()=>{
  assert.equal(nearestFlag([track],[100+FLAG_RANGE-1,10,100]),track);
  assert.equal(nearestFlag([track],[100+FLAG_RANGE+1,10,100]),undefined);
  assert.equal(nearestFlag([track],[100,10+FLAG_RANGE+1,100]),undefined);
});
test('loadTracks skips missing or invalid files',async()=>{
  const files={'./ok.json':track,'./bad.json':{id:'x'}};
  const fetcher=async f=>f in files?{ok:true,json:async()=>files[f]}:{ok:false};
  const tracks=await loadTracks(fetcher,['./ok.json','./bad.json','./none.json']);
  assert.deepEqual(tracks.map(t=>t.id),['a']);
});

test('gateMesh spans the gate width along its heading and the next gate has a taller beam',async()=>{
  const {gateMesh}=await import('./race-flags.js');
  const top=m=>{let h=-1e9;for(let i=1;i<m.length;i+=7)h=Math.max(h,m[i]);return h;};
  const g={pos:[0,0,0],yaw:Math.PI/2,width:60};
  const m=gateMesh(g,0,false);let zs=[];
  for(let i=2;i<m.length;i+=7)zs.push(m[i]);
  assert.ok(Math.max(...zs)>=29&&Math.min(...zs)<=-29);
  assert.ok(top(gateMesh(g,0,true))>top(m));
  assert.ok(gateMesh(g,0,true,true).length>gateMesh(g,0,true).length,'finish banner is checkered');
});
test('race markers grow with altitude so they stay visible until the globe takes over', () => {
  assert.equal(beaconScale(0), 1);
  assert.equal(beaconScale(800), 1);
  let last = 1;
  for (let a = 0; a <= 20000; a += 50) { const k = beaconScale(a); assert.ok(k >= last && k <= 32); last = k; }
  assert.equal(beaconScale(1e6), 32);
  // projected beam width (yd * scale / distance) stays above 1/1000 of the distance out to 10k yd
  for (let a = 800; a <= 20000; a += 100) assert.ok(1.5 * beaconScale(a) / a >= 1.5 / 1700, String(a));
  const span = mesh => { let hi = 0; for (let i = 1; i < mesh.length; i += 7) hi = Math.max(hi, mesh[i]); return hi; };
  assert.ok(span(flagMesh(0, 8)) > span(flagMesh(0, 1)));
  assert.ok(gateMesh({ width: 30, yaw: 0 }, 0, true, false, 8).length === gateMesh({ width: 30, yaw: 0 }, 0, true, false, 1).length);
});