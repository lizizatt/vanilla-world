import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FALLBACK_RECTS } from './space.js';

const FILES = ['steamwheedle', 'track-to-sea', 'if-airport-track'];
const inside = ([x, , z]) => FALLBACK_RECTS.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);

for (const id of FILES) {
  test(`bundled track ${id} lies on the current continent chart`, async () => {
    const t = JSON.parse(await readFile(new URL(`./tracks/${id}.json`, import.meta.url), 'utf8'));
    assert.ok(inside(t.start.pos), 'start');
    t.gates.forEach((g, i) => assert.ok(inside(g.pos), `gate ${i + 1}`));
  });
}

test('Thousand Needles races sit on the northern Kalimdor row (Orgrimmar level with the Maelstrom)', async () => {
  for (const id of ['steamwheedle', 'track-to-sea']) {
    const t = JSON.parse(await readFile(new URL(`./tracks/${id}.json`, import.meta.url), 'utf8'));
    assert.ok(t.start.pos[2] > 9000 && t.start.pos[2] < 12000, `${id} start z ${t.start.pos[2]}`);
    assert.equal(t.body ?? 'azeroth', 'azeroth');
  }
});
