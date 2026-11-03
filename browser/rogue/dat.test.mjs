import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readDirectory, readSegments, parseHob, parseHmt, hobTriangles } from './dat.js';

const ROOT = new URL('../rogue-data/ROGUE/DATA/OUT/', import.meta.url);
const have = fs.existsSync(new URL('DATA.DAT', ROOT));
const skip = !have && 'rogue-data not present';
const load = () => {
  const buf = fs.readFileSync(new URL('DATA.DAT', ROOT));
  return { buf, dir: readDirectory(buf, readSegments(fs.readFileSync(new URL('DATA.HDR', ROOT)))) };
};

test('decodes Millennium Falcon HOB and HMT', { skip }, () => {
  const { buf, dir } = load();
  for (const n of ['falcon_HOB', 'xwing_HOB', 'awing_HOB', 'ywing_HOB']) assert.ok(dir.has(n), n);
  const e = dir.get('falcon_HOB');
  const hob = parseHob(buf, e.offset, e.size);
  assert.equal(hob.nodes.length, 5);
  const tris = hobTriangles(hob);
  assert.ok(tris.length > 400);
  for (const t of tris) for (const v of t.v) for (const c of v) assert.ok(Number.isFinite(c));
  const he = dir.get('falcon_HMT');
  const hmt = parseHmt(buf, he.offset, he.size);
  assert.equal(hmt.materials.length, 29);
  assert.equal(hmt.textures.length, 23);
  for (const m of hmt.materials) if (m.kind === 1) assert.ok(m.tex < hmt.textures.length);
  for (const t of tris) if (hmt.materials[t.material]?.kind === 1) assert.ok(t.uv);
});

test('every HOB/HMT in DATA.DAT decodes with in-range indices', { skip }, () => {
  const { buf, dir } = load();
  const hobs = [...dir].filter(([n]) => n.endsWith('_HOB'));
  assert.ok(hobs.length > 100);
  for (const [n, e] of dir) if (n.endsWith('_HMT')) parseHmt(buf, e.offset, e.size);
  for (const [n, e] of hobs) {
    const hob = parseHob(buf, e.offset, e.size);
    for (const node of hob.nodes) for (const m of node.meshes) for (const p of m.polys) {
      for (const i of p.idx) assert.ok(i < m.verts.length, `${n} vertex index`);
      for (const i of p.nidx ?? []) assert.ok(i < m.normals.length, `${n} normal index`);
    }
  }
});

test('second-segment assets (koelsch) resolve via DATA.HDR', { skip }, () => {
  const { buf, dir } = load();
  const e = dir.get('koelsch_HOB');
  assert.equal(parseHob(buf, e.offset, e.size).name, 'koelsch');
});
