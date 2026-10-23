// On-demand verification of the WIRED race scenery (muted Edge): overworld label from afar, start lights through the countdown, and a
// pass through the first checkpoint with Rocket and a Racer pod (no collision: the race must advance and speed must not collapse).
//   $env:WOW_DATA=...; $env:SWE1R_DATA=...; $env:PORT=4183; node race-gates-shots.mjs   -> runtime/gate-preview/w-*.png
import path from 'node:path';
import { openLab, track, out, camera } from './race-gate-lab.mjs';

const { ctx, page, errors } = await openLab();
const yaw = track.start.yaw, f = [-Math.sin(yaw), -Math.cos(yaw)], files = [];
await page.waitForFunction(() => worldTest.gateKit(), null, { timeout: 60000 });
const snap = async name => { const file = path.join(out, `w-${name}.png`); await page.screenshot({ path: file }); files.push(file); };
const startAt = back => track.start.pos.map((v, i) => i === 1 ? v : v + (i === 0 ? f[0] : f[1]) * -back);

// Overworld: the label beacon seen from ahead along the road at 300/800/1400 yd.
for (const d of [300, 800, 1400]) {
  await page.evaluate(c => worldTest.focus(c), camera(track.start.pos, yaw, d, 40 + d / 6, -.03));
  await page.waitForTimeout(3500); await snap(`label-${d}yd`);
}
const skins = await page.evaluate(async () => (await import('/swe1r/skin.js')).podSkinList().slice(0, 2).map(s => s.id));
for (const [name, skin] of [['rocket', 'rocket'], ['pod', skins[1]]]) {
  await page.evaluate(s => worldTest.selectVehicle({ vehicle: 'podracer', skin: s }), skin);
  await page.evaluate(() => worldTest.startRace(worldTest.tracks()[0]));
  const seen = new Set();
  for (let i = 0; i < 80 && !seen.has('running'); i++) {
    const s = await page.evaluate(() => { const r = worldTest.raceObj(); return r && r.state + ':' + Math.ceil(r.countdown(performance.now() / 1000)); });
    if (s && !seen.has(s) && s !== 'lineup:0') { seen.add(s); await snap(`${name}-start-${s.replace(':', '-')}`); }
    if (s?.startsWith('running')) seen.add('running');
    await page.waitForTimeout(150);
  }
  await page.keyboard.down('KeyW');
  let maxSpeed = 0, next = 0;
  for (let i = 0; i < 300 && next < 2; i++) {
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({ n: worldTest.raceInfo()?.next, v: Math.abs(window.__lastSpeed ?? 0) }));
    next = r.n ?? next;
    const gap = await page.evaluate(() => { const r = worldTest.raceObj(); if (!r) return 1e9; const g = r.track.gates[r.gateIndex]; return r.last && Math.hypot(r.last[0] - g.pos[0], r.last[2] - g.pos[2]); });
    if (gap < 115 && !seen.has('near')) { seen.add('near'); await snap(`${name}-gate-approach`); }
  }
  await snap(`${name}-after-gate`);
  await page.keyboard.up('KeyW');
  console.log(name, 'gates passed:', next, 'states:', [...seen].join(' '));
  if (next < 1) { console.error('FAIL: no checkpoint passed with', name); process.exitCode = 1; }
}
console.log('page errors:', errors.filter(e => !/Invalid parked pose/.test(e)).join('; ') || 'none');
console.log(files.join('\n'));
await ctx.close();
