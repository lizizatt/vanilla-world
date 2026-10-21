import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planeKeys} from './plane-input.js';

const axes=(...codes)=>planeKeys(new Set(codes));
test('plane keys: W up, S down, Q left, E right, Shift/Ctrl throttle, Space boost',()=>{
  assert.deepEqual(axes(),{throttle:0,pitch:0,yaw:0,flags:0});
  assert.equal(axes('KeyW').pitch,1);
  assert.equal(axes('KeyS').pitch,-1);
  assert.equal(axes('ArrowUp').pitch,1);
  assert.equal(axes('ArrowDown').pitch,-1);
  assert.equal(axes('KeyW','ArrowUp').pitch,1,'alias keys do not double the stick');
  assert.equal(axes('KeyW','KeyS').pitch,0);
  assert.equal(axes('KeyQ').yaw,-1);
  assert.equal(axes('KeyE').yaw,1);
  assert.equal(axes('ShiftLeft').throttle,1);
  assert.equal(axes('ControlRight').throttle,-1);
  assert.equal(axes('ShiftLeft','ControlLeft').throttle,0);
  assert.equal(axes('Space').flags,2);
});