import test from 'node:test';
import assert from 'node:assert/strict';
import { hudModel } from './hud-model.js';

test('boost reserve maps to arc and inverted heat with an 80% warning', () => {
  assert.deepEqual(hudModel(1), { heat: 0, arc: 100, warn: false });
  assert.equal(hudModel(.25).warn, false);
  assert.equal(hudModel(.2).warn, true);
  assert.deepEqual(hudModel(-3), { heat: 1, arc: 0, warn: true });
  assert.equal(hudModel(NaN).arc, 100);
});
