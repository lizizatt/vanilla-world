import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlumes } from './plume-check.js';
import { exhaustPoints } from './particles.js';

function craft(tether) {
  const vertices = [], indices = [];
  const box = (x0, x1, y0, y1, z0, z1) => {
    const b = vertices.length / 12;
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) vertices.push(x, y, z, 0, 0, 1, 0, 0, 1, 1, 1, 1);
    for (const [a, c, d] of [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]) indices.push(b + a, b + c, b + d);
  };
  box(-6, 2, -1, 1, 0, 1);
  for (const s of [1, -1]) {
    box(4, 8, s * 1.5 - .75, s * 1.5 + .75, 0, 1.5);
    if (tether) box(2, 4, s * 1.5 - .05, s * 1.5 + .05, .5, .6);
  }
  return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

test('a clean craft passes the plume audit', () => {
  const r = checkPlumes(craft(false));
  assert.deepEqual(r.flags.filter(f => !f.includes('hull-occluded')), []);
  assert.equal(r.points.length, 2);
});

test('thin tethers behind an engine do not pull the emitter off the nozzle', () => {
  for (const [x] of exhaustPoints(craft(true).vertices, craft(true).indices)) assert.ok(x >= 3.9 && x <= 4.1, `emitter x ${x}`);
});

test('missing engines and merged emitters are flagged', () => {
  const c = craft(false);
  assert.ok(checkPlumes({ ...c, indices: c.indices.slice(0, 36) }).flags.some(f => f.startsWith('engines:')));
  assert.ok(checkPlumes({ ...c, points: [[4, 0, .5], [4, .1, .5]] }).flags.includes('merged'));
});
