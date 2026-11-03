import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readDirectory, parseHob, parseHmt, hobTriangles } from './dat.js';

const DAT = new URL('../rogue-data/ROGUE/DATA/OUT/DATA.DAT', import.meta.url);
const have = fs.existsSync(DAT);

test('decodes Millennium Falcon HOB', { skip: !have && 'rogue-data not present' }, () => {
  const buf = fs.readFileSync(DAT);
  const dir = readDirectory(buf);
  for (const n of ['falcon_HOB', 'xwing_HOB', 'awing_HOB', 'ywing_HOB']) assert.ok(dir.has(n), n);
  const e = dir.get('falcon_HOB');
  const hob = parseHob(buf, e.offset, e.size);
  assert.equal(hob.nodes.length, 5);
  const tris = hobTriangles(hob);
  assert.ok(tris.length > 400);
  for (const t of tris) for (const v of (t.v || t)) if (Array.isArray(v)) for (const c of v) assert.ok(Number.isFinite(c));
  const he = dir.get('falcon_HMT');
  const hmt = parseHmt(buf, he.offset, he.size);
  assert.equal(hmt.materials.length, 29);
  assert.equal(hmt.textures.length, 23);
  for (const m of hmt.materials) if (m.kind === 1) assert.ok(m.tex < hmt.textures.length);
  for (const t of tris) if (hmt.materials[t.material]?.kind === 1) assert.ok(t.uv);
});
