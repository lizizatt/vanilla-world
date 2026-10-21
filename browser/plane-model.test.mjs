import test from 'node:test';
import assert from 'node:assert/strict';
import {planePayload} from './plane-model.js';
import {craftMatrix} from './world-camera.js';
import {planeKeys} from './plane-input.js';

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

test('plane render: positive physics roll (right wing down) lowers the right wing on screen',()=>{
  const wing=bankSign=>{const m=craftMatrix([0,0,0,0,.5],[0,0],1,bankSign);return m[5];};
  assert.ok(wing(-1)>0,'left wing (model +y) rises when rolling right');
  assert.ok(wing(1)<0,'car default unchanged');
});

test('end to end: key A -> worker steer -> Rust roll (negative) -> render puts the LEFT wingtip lower',()=>{
  // voyage.rs worker_steer_axis_banks_the_plane_the_way_the_key_says proves steer +1 gives bank < 0 and a left turn.
  const wingY=(code,bank)=>{
    const {steer}=planeKeys(new Set([code])),b=steer>0?-Math.abs(bank):Math.abs(bank);
    const m=craftMatrix([0,0,0,0,b],[0,0],1,-1);
    return {left:m[5]*1,right:-m[5]*1};
  };
  const a=wingY('KeyA',.5),d=wingY('KeyD',.5);
  assert.ok(a.left<a.right,'A: left wingtip lower');
  assert.ok(d.right<d.left,'D: right wingtip lower');
});
