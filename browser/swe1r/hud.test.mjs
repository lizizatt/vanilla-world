import test from 'node:test';
import assert from 'node:assert/strict';
import { lapText } from './hud.js';

test('lap readout is 1-based and clamped to the total', () => {
  assert.equal(lapText(1, 3), 'Lap 1/3');
  assert.equal(lapText(3, 3), 'Lap 3/3');
  assert.equal(lapText(4, 3), 'Lap 3/3');
  assert.equal(lapText(0, 1), 'Lap 1/1');
});
