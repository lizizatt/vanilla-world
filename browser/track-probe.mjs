// Probe real ground/water under each track's start+gates (muted Edge; PORT + WOW_DATA required).
// Usage: node track-probe.mjs <track.json>...   (default: all bundled tracks)
import fs from 'node:fs';
import { openLab } from './race-gate-lab.mjs';
const files = process.argv.slice(2);
const tracks = (files.length ? files : fs.readdirSync(new URL('./tracks/', import.meta.url)).map(f => new URL(`./tracks/${f}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1')))
  .map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const { ctx, page } = await openLab({ swe1r: false });
await page.waitForTimeout(15000);
for (const t of tracks) {
  const pts = [t.start.pos, ...t.gates.map(g => g.pos)];
  await page.evaluate(p => worldTest.restore([p[0], p[1] + 60, p[2], 0]), t.start.pos).catch(() => {});
  await page.waitForTimeout(12000);
  const r = await page.evaluate(p => worldTest.request('probe', { points: p.map(q => [q[0], q[2]]) }), pts);
  const bad = r.map((s, i) => ({ i, y: pts[i][1], ground: s[1], water: s[2] })).filter(s => Math.abs(s.y - s.ground) > 25 || s.water);
  console.log(t.id, 'pts', pts.length, 'off-ground/water', bad.length, JSON.stringify(bad.slice(0, 4)), 'start ground', r[0]);
}
await ctx.close();
process.exit(0);
