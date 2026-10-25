import test from 'node:test';
import assert from 'node:assert/strict';
import { maelstromCentre } from './clouds.js';
import { subPoint, MAELSTROM_Z } from './space.js';

test('Maelstrom sits 20 degrees north of the equator', () => {
  const manifest = { ocean: [5333.333, -16000, 13525.333, 17066.667], world_bounds: [[0, 0, 51, 56], [24, 20, 45, 62]], regions: [{ placement: [-21866.667, -14400] }, { placement: [725.333, -16000] }] };
  const c = maelstromCentre(manifest);
  assert.ok(Math.abs(c[1] - MAELSTROM_Z) < 2, `maelstrom z ${c[1]}`);
  assert.ok(Math.abs(subPoint(c[0], c[1]).lat * 180 / Math.PI - 20) < .01);
});
