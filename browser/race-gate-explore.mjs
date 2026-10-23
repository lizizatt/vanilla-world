// Model explorer: renders each candidate prop alone at the Steamwheedle start (front/side) and prints its extents.
import { openLab, track, out, camera } from './race-gate-lab.mjs';
import path from 'node:path';

const swe = (process.env.SWE || '309,196,197,123,125,126,146,49').split(',').filter(Boolean).map(Number);
const wow = (process.env.WOW || '').split(';').filter(Boolean);
const { ctx, page, errors } = await openLab();
const { pos, yaw } = track.start, f = [-Math.sin(yaw), -Math.cos(yaw)];
const at = [pos[0] + f[0] * 40, pos[1], pos[2] + f[1] * 40];
const items = [...swe.map(i => ({ name: `swe${i}`, swe: i })), ...wow.map(p => ({ name: p.split('\\').pop().replace('.m2', ''), wow: p }))];
for (const it of items) {
  const info = await page.evaluate(async ([it, at, yaw]) => {
    let m, space, scale;
    if (it.swe !== undefined) { m = await worldTest.swe1rModel(it.swe, 1 / 600); space = 'craft'; scale = 1 / 600; m = { asset: m.asset, textures: m.textures }; }
    else { m = await worldTest.propModel(it.wow); space = 'craft'; scale = 1; }
    const v = m.asset.vertices, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < v.length; i += 12) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[i + a]); hi[a] = Math.max(hi[a], v[i + a]); }
    const ext = hi.map((h, a) => h - lo[a]), big = Math.max(...ext) * scale, k = big > 0 ? 14 / big : 1;
    worldTest.props([{ asset: m.asset, textures: m.textures, space, scale: scale * k, pos: at, yaw }]);
    return { lo, hi, ext, k, tris: m.asset.indices.length / 3, tex: m.textures.length, batches: m.asset.batches.map(b => b.blend) };
  }, [it, at, yaw]).catch(e => ({ error: String(e.message || e) }));
  console.log(it.name, JSON.stringify(info));
  if (info.error) continue;
  for (const [tag, cam] of [['front', camera(at, yaw, 32, 8, -0.1)], ['side', camera(at, yaw + Math.PI / 2, 32, 8, -0.1)]]) {
    await page.evaluate(c => worldTest.focus(c), cam);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(out, `x-${it.name}-${tag}.png`) });
  }
}
console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'ok');
await ctx.close();
