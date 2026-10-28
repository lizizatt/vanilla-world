// Re-seat a track after a chart shift: add dz to every z, then ground-snap with the real probe (muted Edge; PORT + WOW_DATA required).
// Points with no tile (open sea) keep their authored height.
// Usage: node track-reseat.mjs <in.json> <dz> <out.json> [id] [name]
import fs from 'node:fs';
import { openLab } from './race-gate-lab.mjs';
import { normalizeTrack, formatTrack } from './track-normalize.js';
const [inFile, dzArg, outFile, id, name] = process.argv.slice(2);
const dz = Number(dzArg);
const src = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const track = { ...src, id: id || src.id, name: name || src.name, body: 'azeroth' };
track.start = { ...track.start, pos: [track.start.pos[0], track.start.pos[1], track.start.pos[2] + dz] };
track.gates = track.gates.map(g => ({ ...g, pos: [g.pos[0], g.pos[1], g.pos[2] + dz] }));
const { ctx, page } = await openLab({ swe1r: false });
await page.waitForTimeout(15000);
const cache = new Map();
const probe = async p => {
  const k = `${Math.round(p[0])},${Math.round(p[2])}`;
  if (!cache.has(k)) {
    const r = await page.evaluate(q => worldTest.request('probe', { points: [[q[0], q[2]]] }), p);
    cache.set(k, { ground: r[0][1], water: r[0][2] });
  }
  return cache.get(k);
};
const all = [track.start.pos, ...track.gates.map(g => g.pos)];
const resolved = new Map();
for (const p of all) {
  const s = await probe(p);
  if (!Number.isFinite(s.ground)) console.log('unprobed', p.map(Math.round).join(','), JSON.stringify(s));
  resolved.set(p, s);
}
// normalizeTrack deep-copies, so resolve by coordinates
const byKey = new Map(all.map(p => [`${p[0]},${p[2]}`, resolved.get(p)]));
const { track: out, report, unresolved } = normalizeTrack(track, p => byKey.get(`${p[0]},${p[2]}`));
for (const r of report) console.log(r.label, r.old, '->', r.new, 'base', r.base, r.status);
console.log('unresolved', JSON.stringify(unresolved));
fs.writeFileSync(outFile, formatTrack(out));
await ctx.close();
process.exit(0);
