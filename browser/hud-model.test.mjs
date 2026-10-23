import test from 'node:test';
import assert from 'node:assert/strict';
import { hudModel } from './hud-model.js';
import { boostFx } from './swe1r/hud.js';

test('engine heat maps to the headroom arc with an 80% warning', () => {
  assert.deepEqual(hudModel(0), { heat: 0, arc: 100, warn: false, stage: 0 });
  assert.equal(hudModel(.75).warn, false);
  assert.equal(hudModel(.8).warn, true);
  assert.deepEqual(hudModel(3), { heat: 1, arc: 0, warn: true, stage: 2 });
  assert.equal(hudModel(NaN).arc, 100);
  assert.deepEqual([.49, .5, .79, .8].map(h => hudModel(h).stage), [0, 1, 1, 2]);
});
