// One-off: dumps one SWE1R pod (untextured triangles + per-mesh part ids) to runtime/crash-proto/pod.json for the crash prototype.
//   $env:SWE1R_DATA='...\data'; node tools/crash-proto-dump.mjs [skinIndex]
import fs from 'node:fs';
import path from 'node:path';
import { readBlock } from '../browser/swe1r/block.js';
import { parseModel, applyMat } from '../browser/swe1r/model.js';
import { decodeTriangles } from '../browser/swe1r/pod.js';
import { podSkinList } from '../browser/swe1r/skin.js';

const data = process.env.SWE1R_DATA;
const file = fs.readdirSync(data, { recursive: true }).find(f => /out_modelblock\.bin$/i.test(f));
const models = readBlock(new Uint8Array(fs.readFileSync(path.join(data, file))), 'model');
const skin = podSkinList().find(s => s.index === +(process.argv[2] ?? 0)) ?? podSkinList()[0];
const [mask, body] = models[skin.index];
const out = { name: skin.name, tris: [], part: [] };
parseModel(body, mask).meshes.forEach((mesh, pi) => {
  for (const tri of decodeTriangles(body, mesh)) {
    // model +y forward, +z up -> craft +x forward, +y left, +z up (as toCraft does)
    const P = tri.map(v => applyMat(mesh.matrix, v.x, v.y, v.z)).map(([x, y, z]) => [y, -x, z]);
    out.tris.push(P.flat().map(n => +n.toFixed(1)));
    out.part.push(pi);
  }
});
const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
for (const t of out.tris) for (let i = 0; i < 9; i++) { lo[i % 3] = Math.min(lo[i % 3], t[i]); hi[i % 3] = Math.max(hi[i % 3], t[i]); }
out.lo = lo; out.hi = hi; out.parts = new Set(out.part).size;
const dir = path.resolve('runtime', 'crash-proto');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'pod.json'), JSON.stringify(out));
console.log(skin.name, out.tris.length, 'tris', out.parts, 'meshes', lo, hi);
