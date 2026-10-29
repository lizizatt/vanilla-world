import test from 'node:test';
import assert from 'node:assert/strict';
import {orbitalNear} from './world-camera.js';

// 24-bit depth resolution (yd) at distance z for a near plane n: about 2^-24 * z^2 / n.
const resolution=(z,n)=>z*z/n/2**24;

test('pod camera near stays 0.1 at the ground (unchanged from the fixed value)',()=>{
  assert.equal(orbitalNear(3,false),.1);
  assert.equal(orbitalNear(-5,true),.1);
});
test('chase near grows with altitude but never reaches the pod',()=>{
  assert.equal(orbitalNear(37500,false,15),3);
  assert.ok(orbitalNear(37500,false,15)<15-5);
  assert.ok(orbitalNear(50,false,15)<.51&&orbitalNear(50,false,15)>.49);
});
test('cockpit near follows the fly camera (capped at 100)',()=>{
  assert.equal(orbitalNear(37500,true),100);
  assert.equal(orbitalNear(2000,true),20);
});
test('depth resolution at 37.5 kyd is bounded under 40 yd for the chase camera (was ~800 yd at near 0.1)',()=>{
  assert.ok(resolution(37500,.1)>500);
  assert.ok(resolution(37500,orbitalNear(37500,false))<40);
});
