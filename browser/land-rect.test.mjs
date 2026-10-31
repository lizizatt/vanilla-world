import test from 'node:test';
import assert from 'node:assert/strict';
import {dropOpenSeaWater,dropPlaceholderTriangles,isLandTile,trimRimSpikes} from './land-rect.js';

const tile=ys=>new Float32Array(ys.flatMap(y=>[0,y,0,0,1,0,0]));

test('deep ocean tile with a few sea-level spikes is not land',() => {
  assert.equal(isLandTile(tile([...Array(99).fill(-503),0])),false);
});

test('shallow or raised ground counts as land',() => {
  assert.equal(isLandTile(tile([...Array(50).fill(-503),...Array(50).fill(-200)])),true);
  assert.equal(isLandTile(tile([])),false);
});

test('rim-only sea-level spikes are flattened, interior land is untouched',() => {
  const v=(x,y,z)=>[x,y,z,0,1,0,0];
  const rimOnly=new Float32Array([...v(0,-503,0),...v(5,-503,5),...v(10,0,10),...v(10,-503,0),...v(0,0,10),...v(5,-503,0)]);
  trimRimSpikes(rimOnly);
  assert.equal(Math.max(...rimOnly.filter((_,i)=>i%7===1)),-503);
  const island=new Float32Array([...v(0,-503,0),...v(5,100,5),...v(10,0,10),...v(10,-503,0)]);
  trimRimSpikes(island);
  assert.equal(island[8],100);
});

import {isDeepOcean} from './tile-registry.js';
test('isDeepOcean flags only known deep ground',()=>{const g=new Float32Array(2048*1024).fill(-Infinity);g[512*2048+1024]=-503;g[512*2048+1025]=50;assert.equal(isDeepOcean(g,0,0),true);assert.equal(isDeepOcean(g,2*Math.PI/2048,0),false);assert.equal(isDeepOcean(g,1,1),false);});

test('open-sea tiles lose their liquid layer, tiles with land keep it',()=>{
  const v=(y,m)=>[0,y,0,0,1,0,m];
  const sea=Float32Array.from([...v(-503,0),...v(0,2)]),land=Float32Array.from([...v(50,0),...v(0,2)]);
  assert.equal(dropOpenSeaWater(sea).length,7);
  assert.equal(dropOpenSeaWater(land),land);
});
test('splat triangles on the -503 placeholder are dropped, real ones kept',()=>{
  const verts=new Float32Array(13*4);[-503,-503,-503,-59].forEach((y,i)=>{verts[i*13+1]=y;});
  assert.deepEqual([...dropPlaceholderTriangles(verts,Uint32Array.from([0,1,2,0,1,3]))],[0,1,3]);
  const keep=Uint32Array.from([0,1,3]);assert.equal(dropPlaceholderTriangles(verts,keep),keep);
});

test('dropOpenSeaWater keeps exactly the non-liquid vertices in order',()=>{
  const v=(y,m,x)=>[x,y,0,0,1,0,m];
  const out=dropOpenSeaWater(Float32Array.from([...v(-503,0,1),...v(0,2,2),...v(-503,1,3),...v(0,4,4)]));
  assert.deepEqual([...out],[...v(-503,0,1),...v(-503,1,3)]);
});
