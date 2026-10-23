import test from 'node:test';
import assert from 'node:assert/strict';
import { beamState } from './beam.js';

test('beam brightens with boost and heat, arcs when hot or damaged, breaks when an engine is dead', () => {
  const idle = beamState(), boost = beamState({ throttle: 1, boosting: true, heat: 0.5 });
  assert.ok(boost[1] > idle[1] && idle[2] === 0 && idle[3] === 0);
  assert.ok(beamState({ heat: 1 })[2] > 0.99 && beamState({ health: [1, 0.2] })[2] > 0.6);
  assert.equal(beamState({ health: [0, 1] })[3], 1);
  assert.ok(beamState({ throttle: 1, boosting: true, heat: 1 })[1] <= 1.6);
});
