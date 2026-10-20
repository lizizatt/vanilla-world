import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR,HYJAL_SUMMIT,cloudUniform} from './clouds.js';

test('cloud uniform centres on the mid-ocean gap at 0.8x Hyjal and tracks daylight',()=>{
  assert.equal(CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT);
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:2};
  const u=cloudUniform(view,5,.25,{ocean:[0,100,1000,300]},.5);
  assert.deepEqual([...u.slice(16,20)],[500,200,Math.fround(CLOUD_ALTITUDE),60000]);
  assert.equal(u[20],.5);assert.equal(u[15],.25);assert.equal(u[11],5);assert.equal(u[7],2);
});