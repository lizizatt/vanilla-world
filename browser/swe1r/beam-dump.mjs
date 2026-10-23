// On-demand ground-truth dump: per mesh of a Racer pod model, texture size/format, alpha class, bounds and material flags.
// usage: SWE1R_DATA=<data dir> node browser/swe1r/beam-dump.mjs [modelIndex ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBlock } from './block.js';
import { parseModel } from './model.js';
import { meshTexture, decodeTriangles, decodeTexture, alphaMode } from './pod.js';
import { applyMat } from './model.js';

const dir = join(process.env.SWE1R_DATA, 'lev01');
const models = readBlock(new Uint8Array(readFileSync(join(dir, 'out_modelblock.bin'))), 'model');
const textures = readBlock(new Uint8Array(readFileSync(join(dir, 'out_textureblock.bin'))), 'texture');
const ids = process.argv.slice(2).map(Number);
for (const id of ids) {
  const [mask, body] = models[id] ?? [];
  if (!body) { console.log(id, 'missing'); continue; }
  console.log(`# model ${id} tag ${String.fromCharCode(...body.subarray(0, 4))}`);
  parseModel(body, mask).meshes.forEach((m, i) => {
    const t = meshTexture(body, m);
    const tris = decodeTriangles(body, m);
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const tri of tris) for (const v of tri) { const p = applyMat(m.matrix, v.x, v.y, v.z); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); } }
    let mode = '-';
    if (t) { try { mode = alphaMode(decodeTexture(textures[t.index], t)).blend; } catch { mode = 'err'; } }
    console.log(i, 'tris', tris.length, t ? `tex ${t.index} ${t.width}x${t.height} fmt${t.format} flags ${t.flags.toString(16)} ${mode}` : 'untextured',
      'lo', lo.map(Math.round).join(','), 'hi', hi.map(Math.round).join(','));
  });
}
