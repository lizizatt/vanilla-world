// Real-data frame profile at representative poses (needs WOW_DATA, SWE1R_DATA optional, server on PORT; run via heavy-lock.mjs).
// node perf-pose.mjs <label> [pose ...] -> test-results/perf-pose/<label>.json. Uncapped frame rate (LAB_UNCAPPED=1) makes frame ms the true cost.
// Per pose: rAF interval, WorldRenderer.draw CPU, worker 'frame' round trip, long tasks, CDP script time.
import fs from 'node:fs';
import { openLab, track } from './race-gate-lab.mjs';

const label = process.argv[2] || 'run', want = process.argv.slice(3);
const SETTLE = Number(process.env.SETTLE || 9000), SAMPLE = Number(process.env.SAMPLE || 12000);
process.env.LAB_UNCAPPED ??= '1';
process.env.LAB_NO_RESTORE ??= '1';
const { ctx, page, errors } = await openLab({ clouds: true, width: 1280, height: 720 });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
const [cx, cz] = await page.evaluate(() => worldTest.maelstrom());
const START = [track.start.pos[0], track.start.pos[2]];
const coast = await page.evaluate(() => { const r = worldEvidence.info.manifest.regions[0], o = 32 * 1600 / 3, s = [-9800, -5000, 120];
  return [-s[1] + r.placement[0] + o, s[2], -s[0] + r.placement[1] + o]; });
await page.evaluate(() => {
  const mine = window.__prof = { on: false, draw: [], rt: [], tasks: [], frames: [] };
  import('./world-renderer.js').then(({ WorldRenderer }) => { const d = WorldRenderer.prototype.draw;
    WorldRenderer.prototype.draw = function (...a) { const t = performance.now(), r = d.apply(this, a); if (mine.on) mine.draw.push(performance.now() - t); return r; }; });
  import('./world-client.js').then(({ WorldClient }) => { const q = WorldClient.prototype.request;
    WorldClient.prototype.request = function (action, ...a) { const t = performance.now(); const p = q.call(this, action, ...a);
      return action === 'frame' ? p.then(r => { if (mine.on) mine.rt.push(performance.now() - t); return r; }) : p; }; });
  new PerformanceObserver(l => { if (mine.on) for (const e of l.getEntries()) mine.tasks.push(e.duration); }).observe({ type: 'longtask', buffered: false });
  let last = performance.now(); const tick = n => { if (mine.on) mine.frames.push(n - last); last = n; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
});
const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const dist = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), p = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), p50: +p(.5).toFixed(2), p95: +p(.95).toFixed(2), p99: +p(.99).toFixed(2), max: +s.at(-1).toFixed(1) }; };
const base = { cloudQuality: 'high', weather: true, weatherQuality: 'high', music: false, sound: false, shadows: false, clouds: true, night: false };
const poses = {
  ground: { s: { weather: false }, area: { name: 'Elwynn Forest', cold: false }, p: [START[0], 120, START[1], 0, .02] },
  'ground-weather': { area: { name: 'Elwynn Forest', cold: false }, p: [START[0], 120, START[1], 0, .02] },
  coast: { p: [coast[0], coast[1], coast[2], Math.PI / 2, -.2] },
  ocean: { p: [cx + 24000, 40, cz + 8000, Math.PI / 2, -.02] },
  'in-cloud': { p: [cx - 30000, 1437, cz + 20000, 0, .02] },
  'above-cloud': { p: [cx - 30000, 3337, cz + 20000, 0, -.25] },
  orbit: { p: [cx - 30000, 400000, cz + 20000, 0, -1.2] },
  storm: { storm: true },
  'wind-storm': { p: [cx + 6000, 60, cz, Math.PI / 2, -.02] },
};
const rows = {};
for (const [name, def] of Object.entries(poses)) {
  if (want.length && !want.includes(name)) continue;
  await page.evaluate(([s, area]) => { worldTest.settings(s); worldTest.weatherArea(area); }, [{ ...base, ...(def.s || {}) }, def.area]);
  await page.evaluate(() => worldTest.timeLock(720));
  let pose = def.p;
  if (def.storm) { await page.evaluate(p => worldTest.focus(p), [START[0], 250, START[1], 0, 0]); await page.waitForTimeout(1500);
    const c = await page.evaluate(([x, z]) => worldTest.weatherFind([x, z], { min: .9, range: 40000, edge: 3000 }), START);
    pose = c ? [c[0], 120, c[1], 0, .02] : [START[0], 120, START[1], 0, .02]; }
  await page.evaluate(p => worldTest.focus(p), pose);
  await page.waitForTimeout(SETTLE);
  await page.evaluate(() => Object.assign(__prof, { on: true, draw: [], rt: [], tasks: [], frames: [] }));
  if (process.env.PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  const m0 = await metric(); await page.waitForTimeout(SAMPLE); const m1 = await metric();
  if (process.env.PROFILE) {
    const { profile } = await cdp.send('Profiler.stop'), self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
    profile.samples.forEach((id, i) => { const n = byId.get(id), k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0)); });
    const tot = [...self.values()].reduce((a, b) => a + b, 0);
    console.log(`profile ${name}`); for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(v / tot * 100).toFixed(1)}%  ${k}`);
  }
  const d = await page.evaluate(() => { __prof.on = false; return { draw: __prof.draw, rt: __prof.rt, tasks: __prof.tasks, frames: __prof.frames }; });
  rows[name] = { frameMs: dist(d.frames), drawCpuMs: dist(d.draw), workerRtMs: dist(d.rt), longTasks: dist(d.tasks),
    scriptMsPerS: +((m1.ScriptDuration - m0.ScriptDuration) / (SAMPLE / 1000) * 1000).toFixed(1), render: await page.evaluate(() => { const r = worldEvidence.render ?? {}; return { worldDraws: r.worldDraws, coastalWaterTiles: r.coastalWaterTiles }; }) };
  console.log(name, JSON.stringify(rows[name]));
}
fs.mkdirSync('test-results/perf-pose', { recursive: true });
fs.writeFileSync(`test-results/perf-pose/${label}.json`, JSON.stringify({ label, W: 1280, H: 720, errors, rows }, null, 1));
console.log('errors', JSON.stringify(errors));
await ctx.close();
