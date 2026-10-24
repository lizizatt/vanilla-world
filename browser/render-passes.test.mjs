import test from 'node:test';
import assert from 'node:assert/strict';
import {DEPTH_STATE,depthState,depthAttachment,bundleFormats,DEPTH_FORMAT} from './render-passes.js';

test('depth state table matches the descriptors the pipelines used before', () => {
  const d=(depthWriteEnabled,depthCompare)=>({format:'depth24plus',depthWriteEnabled,depthCompare});
  assert.deepEqual(DEPTH_STATE.terrain,d(true,'less'));
  assert.deepEqual(DEPTH_STATE.splat,d(true,'less'));
  assert.deepEqual(DEPTH_STATE.scene,d(true,'less'));
  assert.deepEqual(DEPTH_STATE.particles,d(false,'less'));
  assert.deepEqual(DEPTH_STATE.sky,d(false,'always'));
  assert.deepEqual(DEPTH_STATE.dome,d(false,'always'));
  assert.deepEqual(DEPTH_STATE.space,d(true,'always'));
  assert.deepEqual(DEPTH_STATE.patch,d(true,'less-equal'));
});

test('scene depth write can be overridden without mutating the table', () => {
  assert.equal(depthState('scene',false).depthWriteEnabled,false);
  assert.equal(depthState('scene',true).depthWriteEnabled,true);
  assert.equal(DEPTH_STATE.scene.depthWriteEnabled,true);
  assert.equal(depthState('terrain'),DEPTH_STATE.terrain);
});

test('pass attachments keep the clear/load/read-only policy', () => {
  assert.deepEqual(depthAttachment('main','v'),{view:'v',depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'});
  assert.deepEqual(depthAttachment('props','v'),{view:'v',depthLoadOp:'load',depthStoreOp:'store'});
  assert.deepEqual(depthAttachment('fx','v'),{view:'v',depthReadOnly:true});
  assert.deepEqual(bundleFormats('bgra8unorm'),{colorFormats:['bgra8unorm'],depthStencilFormat:DEPTH_FORMAT});
});
