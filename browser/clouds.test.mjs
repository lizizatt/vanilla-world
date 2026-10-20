import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR,HYJAL_SUMMIT,MAELSTROM,cloudShader,cloudUniform,maelstromCentre} from './clouds.js';

const manifest={ocean:[5333,-17600,13525,17066],world_bounds:[[0,0,51,56],[24,20,45,62]],
  regions:[{placement:[-21866,-17600]},{placement:[725,-16000]}]};
test('cloud uniform puts the maelstrom on the world-map eye at 0.8x Hyjal and tracks daylight',()=>{
  assert.equal(CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT);
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:2};
  const u=cloudUniform(view,5,.25,manifest,.5),[x,z]=maelstromCentre(manifest);
  assert.deepEqual([...u.slice(16,20)],[x,z,CLOUD_ALTITUDE,60000].map(Math.fround));
  assert.equal(u[20],.5);assert.equal(u[15],.25);assert.equal(u[11],5);assert.equal(u[7],2);
});
test('maelstrom centre is 43% across the gap, north of the old midpoint',()=>{
  const [x,z]=maelstromCentre(manifest);
  assert(Math.abs(x-(5333+.43*(13525-5333)))<1e-6);
  assert(z<-1000&&z>-2200,`z ${z}`);
});
test('shader carries the tunable eye/wall radii and counter-clockwise spiral',()=>{
  assert(cloudShader.includes(MAELSTROM.eyeRadius.toFixed(1)));assert(cloudShader.includes('atan2(-d.y,d.x)'));
});