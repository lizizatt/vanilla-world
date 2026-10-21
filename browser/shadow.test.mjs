import test from 'node:test';
import assert from 'node:assert/strict';
import {shadowUniform,shadowHalf,SHADOW} from './shadow.js';

test('shadowHalf takes the longer horizontal axis as length and falls back when size is unknown',()=>{
  assert.deepEqual(shadowHalf([2,10,3]),[5,1]);
  assert.deepEqual(shadowHalf(undefined),SHADOW.fallbackHalf);
});
test('shadowUniform packs craft position, heading, footprint and a unit sun',()=>{
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,-1],aspect:1.5};
  const u=shadowUniform(view,[10,20,30,Math.PI,0],[4,2],.5);
  assert.equal(u.length,36);assert.deepEqual([...u.slice(20,23)],[10,20,30]);
  assert.ok(Math.abs(u[24])<1e-6&&Math.abs(u[25]-1)<1e-6,"yaw pi flies +z");
  assert.ok(Math.abs(Math.hypot(u[28],u[29],u[30])-1)<1e-5);
  assert.equal(u[31],SHADOW.maxHeight);
});

