import test from 'node:test';
import assert from 'node:assert/strict';
import {spaceShaderFor} from './space.js';

test('airless far surface fades its grain with altitude, reads the baked grey surface and keeps earthshine', () => {
  const src=spaceShaderFor(5093,{airless:true});
  assert.match(src,/fn pits\(/);
  assert.match(src,/smoothstep\(400\.0,5000\.0,alt\)/,'grain fades out before it aliases into streaks');
  assert.match(src,/reg=mix\(reg,bake\.rgb/,'baked colour owns covered land');
  assert.match(src,/vec3f\(\.02,\.03,\.05\)\*\(1\.0-lit\)/,'night side is not pure black');
  assert.doesNotMatch(spaceShaderFor(14260),/fn pits\(/,'Azeroth keeps its own surface');
});
