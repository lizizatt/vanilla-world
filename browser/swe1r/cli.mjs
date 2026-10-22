// Debug CLI: node swe1r/cli.mjs <SWE1R data dir> [list|sprites|models] [outDir]
// Lists models by magic tag/name and dumps sprite PNG previews. Output goes to runtime/swe1r (git-ignored); never commit it.
import fs from 'node:fs';
import path from 'node:path';
import { readBlock } from './block.js';
import { decompress } from './comp.js';
import { decodeSprite } from './image.js';
import { encodePng } from './png.js';
import { MODEL_NAMES, SPRITE_NAMES } from './names.js';

export function findLev(dir) {
  for (const d of [dir, path.join(dir, 'lev01'), path.join(dir, 'data', 'lev01')]) if (fs.existsSync(path.join(d, 'out_modelblock.bin'))) return d;
  throw new Error(`out_modelblock.bin not found under ${dir}`);
}

export function modelTag(body) {
  return String.fromCharCode(...body.subarray(0, 4));
}

export function listModels(lev) {
  const items = readBlock(fs.readFileSync(path.join(lev, 'out_modelblock.bin')), 'model');
  return items.map(([mask, body], i) => {
    const data = decompress(body);
    const tag = modelTag(data);
    const hint = MODEL_NAMES[i];
    return { index: i, tag, name: hint && hint.startsWith(tag) ? hint : `${tag}_${i}`, nameVerified: !!hint && hint.startsWith(tag), size: data.length, compressed: data.length !== body.length };
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('swe1r\\cli.mjs')) {
  const [dir, cmd = 'list', out = 'runtime/swe1r'] = process.argv.slice(2);
  if (!dir) { console.error('usage: node swe1r/cli.mjs <data dir> [list|sprites] [outDir]'); process.exit(2); }
  const lev = findLev(dir);
  if (cmd === 'list') for (const m of listModels(lev)) console.log(`${String(m.index).padStart(3)} ${m.tag} ${String(m.size).padStart(8)}${m.compressed ? ' comp' : ''} ${m.name}${m.nameVerified ? '' : ' (name unverified)'}`);
  else if (cmd === 'sprites') {
    fs.mkdirSync(out, { recursive: true });
    const items = readBlock(fs.readFileSync(path.join(lev, 'out_spriteblock.bin')), 'sprite');
    items.forEach(([b], i) => {
      try { const s = decodeSprite(b); fs.writeFileSync(path.join(out, `sprite_${String(i).padStart(3, '0')}_${SPRITE_NAMES[i] ?? ''}.png`), encodePng(s.w, s.h, s.rgba)); }
      catch (e) { console.log(`sprite ${i}: ${e.message}`); }
    });
    console.log(`wrote ${items.length} sprites to ${out}`);
  }
}
