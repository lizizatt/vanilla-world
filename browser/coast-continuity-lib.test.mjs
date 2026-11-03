import test from 'node:test';
import assert from 'node:assert/strict';
import {pathPoints,frameStats,stepBetween} from './coast-continuity-lib.js';

test('path samples start at the shore, stay on the line, grow geometrically and stop short of the end',()=>{
  const p=pathPoints([0,0],[30000,40000],20);
  assert.equal(p.length,20);assert.deepEqual([p[0].x,p[0].z,p[0].d],[0,0,0]);
  assert.ok(Math.abs(p[19].d-47500)<1e-6);
  for(const q of p)assert.ok(Math.abs(q.x*4-q.z*3)<1e-6);
  for(let i=2;i<20;i++)assert.ok(p[i].d>p[i-1].d);
  assert.ok(p[1].d<250);
});

test('frame stats report mean colour and the biggest vertical luma step',()=>{
  const w=30,h=100,data=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,v=y<60?40:100;data.set([v,v,v,255],i);}
  const flat=frameStats(new Uint8Array(w*h*4).fill(50),w,h,true);
  assert.equal(flat.rowStep,0);assert.deepEqual(flat.mean.map(Math.round),[50,50,50]);
  assert.equal(Math.round(frameStats(data,w,h,true).rowStep),60);
  assert.equal(stepBetween([10,20,30],[12,29,30]),9);
});
