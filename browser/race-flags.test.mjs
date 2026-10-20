import test from 'node:test';
import assert from 'node:assert/strict';
import {flagPosition,flagMesh,nearestFlag,loadTracks,FLAG_RANGE} from './race-flags.js';

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
