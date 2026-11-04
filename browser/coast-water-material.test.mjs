import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDetail} from './camera-collision.js';

const tri=(m,y)=>[0,y,0,0,1,0,m, 10,y,0,0,1,0,m, 0,y,10,0,1,0,m];

test('coast ocean (4) and inland (2) tile liquid both reach the liquid buffer and camera water',()=>{
  const vertices=new Float32Array([...tri(0,5),...tri(2,1),...tri(4,0)]);
  const {tiles:[tile]}=prepareDetail({tiles:[{vertices}]});
  assert.equal(tile.liquid.length,42);
  assert.deepEqual([...new Set(Array.from({length:tile.liquid.length/7},(_,i)=>tile.liquid[i*7+6]))].sort(),[2,4]);
  assert.ok(tile.camera.water.triangles.length>0);
});
