import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh, fadeGround, gantry, checkpoint, beacon, place } from './race-gate-preview.js';

const valid = ({ asset }) => asset.indices.every(i => i < asset.vertices.length / 12) && asset.batches.every(b => b.firstIndex + b.indexCount <= asset.indices.length);

test('fadeGround ramps alpha below the fade height and leaves the rest untouched', () => {
  const m = new Mesh().box('opaque', [0, 0, 0], [1, 1, 10], [1, 1, 1, 1]).build();
  const f = fadeGround(m.asset, { h: 3.5, floor: .1 });
  assert.ok(valid({ asset: f }));
  let low = 1, high = 0;
  for (let i = 0; i < f.vertices.length; i += 12) { const z = f.vertices[i + 2], a = f.vertices[i + 11]; if (z <= 0) low = Math.min(low, a); if (z >= 3.5) high = Math.max(high, a); }
  assert.ok(Math.abs(low - .1) < 1e-6 && high === 1);
  assert.ok(f.batches.every(b => b.blend === 'alpha'));
});

test('A / C / beacon build valid payloads in hosted mode', () => {
  for (const list of [gantry({ at: [0, 0, 0], yaw: 0 }), checkpoint({ at: [0, 0, 0], yaw: 0 }), beacon({ at: [0, 0, 0], yaw: 0 })]) {
    assert.ok(list.length > 0 && list.every(valid));
  }
});

test('place follows the craft basis (forward is -z at yaw 0)', () => {
  assert.deepEqual(place([0, 0, 0], 0, [1, 0, 2]).map(v => v + 0), [0, 2, -1]);
});
