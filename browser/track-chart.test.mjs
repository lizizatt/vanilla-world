import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FALLBACK_RECTS } from './space.js';

import { migrateOverride } from './track-chart.js';

const FILES = ['steamwheedle', 'track-to-sea', 'if-airport-track'];
const inside = ([x, , z]) => FALLBACK_RECTS.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);

for (const id of FILES) {
  test(`bundled track ${id} lies on the current continent chart`, async () => {
    const t = JSON.parse(await readFile(new URL(`./tracks/${id}.json`, import.meta.url), 'utf8'));
    assert.ok(inside(t.start.pos), 'start');
    t.gates.forEach((g, i) => assert.ok(inside(g.pos), `gate ${i + 1}`));
  });
}

test('The Thousand Needles race sits on the northern Kalimdor row (Orgrimmar level with the Maelstrom)', async () => {
  for (const id of ['steamwheedle', 'track-to-sea']) {
    const t = JSON.parse(await readFile(new URL(`./tracks/${id}.json`, import.meta.url), 'utf8'));
    assert.ok(t.start.pos[2] > 9000 && t.start.pos[2] < 12000, `${id} start z ${t.start.pos[2]}`);
    assert.equal(t.body ?? 'azeroth', 'azeroth');
  }
});

test('a stale pre-shift override of a bundled track is re-seated onto the current chart, once', async () => {
  const shipped = JSON.parse(await readFile(new URL('./tracks/track-to-sea.json', import.meta.url), 'utf8'));
  const stale = { ...shipped, start: { ...shipped.start, pos: [shipped.start.pos[0], shipped.start.pos[1], shipped.start.pos[2] - 5333.4] },
    gates: shipped.gates.map(g => ({ ...g, pos: [g.pos[0], g.pos[1], g.pos[2] - 5333.4] })) };
  const fixed = migrateOverride(stale, shipped);
  assert.ok(Math.abs(fixed.start.pos[2] - shipped.start.pos[2]) < 1e-6);
  assert.ok(Math.abs(fixed.gates.at(-1).pos[2] - shipped.gates.at(-1).pos[2]) < 1e-6);
  assert.equal(migrateOverride(fixed, shipped), fixed);
  const unrelated = { ...stale, start: { ...stale.start, pos: [5000, 0, -3000] } };
  assert.equal(migrateOverride(unrelated, shipped), unrelated);
});
