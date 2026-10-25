import test from 'node:test';
import assert from 'node:assert/strict';
import {isLandTile,trimRimSpikes} from './land-rect.js';

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
