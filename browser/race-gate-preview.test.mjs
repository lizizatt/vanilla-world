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

test('beacon in real mode draws the pole and ground flag only (no Horde banner model)', () => {
  const m = new Mesh().box('opaque', [0, 0, 0], [1, 1, 1], [1, 1, 1, 1]).build();
  const part = { asset: m.asset, textures: m.textures };
  const list = beacon({ at: [0, 0, 0], yaw: 0, real: { tex: {}, pole: part, bannerBig: part } });
  assert.equal(list.length, 2);
  assert.ok(list.every(valid));
});

test('place follows the craft basis (forward is -z at yaw 0)', () => {
  assert.deepEqual(place([0, 0, 0], 0, [1, 0, 2]).map(v => v + 0), [0, 2, -1]);
});

test('textured parts use the supplied textures, blend as alpha and tile UVs; no textures means flat colour', () => {
  const tex = { wood: { key: 'w\\\\wood.blp', width: 4, height: 4, rgba: new Uint8Array(64) } };
  const m = new Mesh(tex).box('opaque', [0, 0, 0], [6, 1, 1], [1, 1, 1, 1], 'wood').build();
  assert.ok(m.textures.some(t => t.key === 'w\\\\wood.blp') && m.asset.batches.every(b => b.blend === 'alpha' && b.texture === 'w\\\\wood.blp'));
  assert.ok(Math.max(...m.asset.vertices.filter((_, i) => i % 12 === 6)) >= 2);
  const flat = new Mesh().box('opaque', [0, 0, 0], [1, 1, 1], [1, 1, 1, 1], 'wood').build();
  assert.ok(flat.asset.batches.every(b => b.texture === 'white' && b.blend === 'opaque'));
  for (const list of [gantry({ at: [0, 0, 0], yaw: 0, real: { tex, pole: { asset: m.asset, textures: m.textures }, banner: { asset: m.asset, textures: m.textures }, lens: { asset: m.asset, textures: m.textures } } })]) assert.ok(list.every(valid));
});
