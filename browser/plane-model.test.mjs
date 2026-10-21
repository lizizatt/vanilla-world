import test from 'node:test';
import assert from 'node:assert/strict';
import {planePayload} from './plane-model.js';
import {craftMatrix} from './world-camera.js';

test('procedural plane payload is a valid indexed craft with no flame',()=>{
  const {asset,metadata}=planePayload();
  assert.equal(asset.vertices.length%12,0);
  assert.ok(asset.indices.every(i=>i<asset.vertices.length/12));
  assert.equal(asset.batches[0].indexCount,asset.indices.length);
  assert.deepEqual(metadata.exhausts,[]);
});

test('craft pitch tilts the nose up and leaves a pitch-less state unchanged',()=>{
  const flat=craftMatrix([0,0,0,0,0],[0,0],1),zero=craftMatrix([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0],1);
  assert.deepEqual(Array.from(flat),Array.from(zero));
  const up=craftMatrix([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,.5],[0,0],1);
  assert.ok(up[1]>0.4&&up[1]<0.5&&up[2]<0,`nose y ${up[1]}`);
});
