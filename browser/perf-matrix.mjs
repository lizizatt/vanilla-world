// Broad real-data profiling matrix: poses x quality settings. Data-free harness (needs WOW_DATA/SWE1R_DATA env, read-only). Run via heavy-lock:
//   node heavy-lock.mjs --label perf-matrix -- node perf-matrix.mjs <label> [cell ...]      -> test-results/perf-matrix/<label>.json
// Env: SETTLE (ms, 6000) SAMPLE (ms, 10000) PROFILE=0 disables the CDP CPU profile. Spawns its own server on a free port (never 4173).
// Per cell: rAF frame mean/p95/p99/max, frames >25 ms with what overlapped them (long tasks, worker requests), WorldRenderer.draw CPU,
// worker round trips grouped by action, CPU-profile self time by function and file, V8 heap, scriptMsPerS. Uncapped frame rate.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] || 'run', want = process.argv.slice(3);
const SETTLE = Number(process.env.SETTLE || 6000), SAMPLE = Number(process.env.SAMPLE || 10000), PROFILE = process.env.PROFILE !== '0';
const port = await new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
if (port === 4173) throw new Error('refusing port 4173');
process.env.PORT = String(port); process.env.LAB_UNCAPPED ??= '1'; process.env.LAB_NO_RESTORE ??= '1';
const server = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('exit', () => rej(new Error('server exited'))); });
const { openLab, track } = await import('./race-gate-lab.mjs');
const tLoad = performance.now();
const { ctx, page, errors } = await openLab({ clouds: true, width: 1280, height: 720 });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
const loadMs = Math.round(performance.now() - tLoad);
const [cx, cz] = await page.evaluate(() => worldTest.maelstrom());
const START = [track.start.pos[0], track.start.pos[2]];
const coast = await page.evaluate(() => { const r = worldEvidence.info.manifest.regions[0], o = 32 * 1600 / 3, s = [-9800, -5000, 120];
  return [-s[1] + r.placement[0] + o, s[2], -s[0] + r.placement[1] + o]; });
await page.evaluate(() => {
  const mine = window.__prof = { on: false, t0: 0, draw: [], rt: [], tasks: [], frames: [] };
  const now = () => performance.now() - mine.t0;
  import('./world-renderer.js').then(({ WorldRenderer }) => { const d = WorldRenderer.prototype.draw;
    WorldRenderer.prototype.draw = function (...a) { const t = performance.now(), r = d.apply(this, a); if (mine.on) mine.draw.push(performance.now() - t); return r; }; });
  import('./world-client.js').then(({ WorldClient }) => { const q = WorldClient.prototype.request;
    WorldClient.prototype.request = function (action, ...a) { const t = performance.now(); const p = q.call(this, action, ...a);
      const done = r => { if (mine.on) mine.rt.push({ action, t: t - mine.t0, ms: performance.now() - t }); return r; };
      return p.then(done, e => { done(); throw e; }); }; });
  new PerformanceObserver(l => { if (mine.on) for (const e of l.getEntries()) mine.tasks.push({ t: e.startTime - mine.t0, ms: e.duration }); }).observe({ type: 'longtask', buffered: false });
  let last = performance.now(); const tick = n => { if (mine.on) mine.frames.push({ t: n - mine.t0, dt: n - last }); last = n; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
});
const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const dist = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), p = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), p50: +p(.5).toFixed(2), p95: +p(.95).toFixed(2), p99: +p(.99).toFixed(2), max: +s.at(-1).toFixed(1) }; };
const base = { cloudQuality: 'high', weather: true, weatherQuality: 'high', music: false, sound: false, shadows: false, clouds: true, night: false,
  particles: 'medium', waves: true, scenery: true, distant: true, horizon: true, planet: true };
const P = {
  ground: { area: { name: 'Elwynn Forest', cold: false }, s: { weather: false }, p: [START[0], 120, START[1], 0, .02] },
  'ground-weather': { area: { name: 'Elwynn Forest', cold: false }, p: [START[0], 120, START[1], 0, .02] },
  coast: { p: [coast[0], coast[1], coast[2], Math.PI / 2, -.2] },
  shoal: { p: [coast[0], 14, coast[2], Math.PI / 2, -.08] },
  ocean: { p: [cx + 24000, 40, cz + 8000, Math.PI / 2, -.02] },
  'in-cloud': { p: [cx - 30000, 1437, cz + 20000, 0, .02] },
  'above-cloud': { p: [cx - 30000, 3337, cz + 20000, 0, -.25] },
  orbit: { p: [cx - 30000, 400000, cz + 20000, 0, -1.2] },
  storm: { storm: true },
  'wind-storm': { p: [cx + 6000, 60, cz, Math.PI / 2, -.02] },
  'coast-fly': { move: [260, 0], p: [coast[0], coast[1], coast[2], Math.PI / 2, -.2] },
  'ocean-fly': { move: [0, -400], p: [cx + 24000, 40, cz + 8000, Math.PI / 2, -.02] },
  'hispeed-fly': { move: [3000, 0], p: [coast[0], 300, coast[2], Math.PI / 2, -.05] },
  'pod-ground': { craft: true, move: [-300, 0], s: { weather: false }, p: [START[0], 20, START[1], Math.PI / 2, -.05] },
};
// Cell = pose + settings overrides. Tier sweeps run on a dense moving coast flight, plus the heavy sky settings on their own poses.
const cells = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v]));
const sweep = (pose, name, s) => { cells[`${pose}/${name}`] = { ...P[pose], s: { ...(P[pose].s || {}), ...s } }; };
for (const [n, s] of Object.entries({ 'cloud-standard': { cloudQuality: 'standard' }, 'clouds-off': { clouds: false }, 'weather-off': { weather: false }, 'weather-standard': { weatherQuality: 'standard' },
  'weather-low': { weatherQuality: 'low' }, 'particles-off': { particles: 'off' }, 'particles-low': { particles: 'low' }, 'particles-high': { particles: 'high' }, 'waves-off': { waves: false },
  'scenery-off': { scenery: false }, 'distant-off': { distant: false }, 'horizon-off': { horizon: false }, 'planet-off': { planet: false },
  'lean': { cloudQuality: 'standard', weatherQuality: 'low', particles: 'low', waves: false }, 'bare': { clouds: false, weather: false, particles: 'off', waves: false, scenery: false, distant: false, horizon: false, planet: false } })) sweep('coast-fly', n, s);
for (const [n, s] of Object.entries({ 'cloud-standard': { cloudQuality: 'standard' }, 'clouds-off': { clouds: false } })) { sweep('in-cloud', n, s); sweep('above-cloud', n, s); }
for (const [n, s] of Object.entries({ 'weather-standard': { weatherQuality: 'standard' }, 'weather-low': { weatherQuality: 'low' }, 'particles-off': { particles: 'off' }, 'particles-high': { particles: 'high' }, 'cloud-standard': { cloudQuality: 'standard' } })) sweep('storm', n, s);
for (const [n, s] of Object.entries({ 'waves-off': { waves: false }, 'particles-off': { particles: 'off' } })) { sweep('ocean-fly', n, s); sweep('shoal', n, s); }
for (const [n, s] of Object.entries({ 'scenery-off': { scenery: false }, 'distant-off': { distant: false }, 'horizon-off': { horizon: false }, 'bare': { clouds: false, weather: false, particles: 'off', waves: false, scenery: false, distant: false, horizon: false } })) sweep('hispeed-fly', n, s);
for (const [n, s] of Object.entries({ 'scenery-off': { scenery: false }, 'clouds-off': { clouds: false }, 'weather-off': { weather: false } })) sweep('ground', n, s);

const rows = {};
for (const [name, def] of Object.entries(cells)) {
  if (want.length && !want.some(w => name === w || (w.endsWith('*') && name.startsWith(w.slice(0, -1))))) continue;
  await page.evaluate(([s, area, craft]) => { worldTest.settings(s); worldTest.weatherArea(area); worldTest.showCraft(!!craft); }, [{ ...base, ...(def.s || {}) }, def.area, def.craft]);
  await page.evaluate(() => worldTest.timeLock(720));
  let pose = def.p;
  if (def.storm) { await page.evaluate(p => worldTest.focus(p), [START[0], 250, START[1], 0, 0]); await page.waitForTimeout(1500);
    const c = await page.evaluate(([x, z]) => worldTest.weatherFind([x, z], { min: .9, range: 40000, edge: 3000 }), START);
    pose = c ? [c[0], 120, c[1], 0, .02] : [START[0], 120, START[1], 0, .02]; }
  await page.evaluate(p => worldTest.focus(p), pose);
  await page.waitForTimeout(SETTLE);
  if (def.move) await page.evaluate(([p, v]) => { const t0 = performance.now(); clearInterval(window.__mv); window.__mv = setInterval(() => { const s = (performance.now() - t0) / 1000; worldTest.focus([p[0] + v[0] * s, p[1], p[2] + v[1] * s, p[3], p[4]]); }, 16); }, [pose, def.move]);
  await page.evaluate(() => Object.assign(__prof, { on: true, t0: performance.now(), draw: [], rt: [], tasks: [], frames: [] }));
  if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  const pnow0 = PROFILE ? await page.evaluate(() => performance.now()) : 0, m0 = await metric(); await page.waitForTimeout(SAMPLE); const m1 = await metric();
  const d0 = await page.evaluate(() => ({ tasks: __prof.tasks.map(t => ({ t0: t.t + __prof.t0, ms: t.ms })) }));
  let hot, files, ltHot;
  if (PROFILE) {
    const { profile } = await cdp.send('Profiler.stop'), self = new Map(), byFile = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
    profile.samples.forEach((id, i) => { const n = byId.get(id), f = n.callFrame.url.split('/').pop() || '(native)', k = `${n.callFrame.functionName || '(anon)'} ${f}:${n.callFrame.lineNumber + 1}`, dt = profile.timeDeltas[i] || 0;
      self.set(k, (self.get(k) || 0) + dt); byFile.set(f, (byFile.get(f) || 0) + dt); });
    const tot = [...self.values()].reduce((a, b) => a + b, 0), top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +(v / tot * 100).toFixed(1)]);
    hot = top(self, 14); files = top(byFile, 8);
    // Samples inside >40 ms main-thread tasks: align the profiler clock (us) to performance.now() with a probe taken at start.
    const off = profile.startTime / 1000 - pnow0, lt = new Map(); let at = profile.startTime / 1000, ltTot = 0;
    profile.samples.forEach((id, i) => { at += (profile.timeDeltas[i] || 0) / 1000; const pt = at - off;
      if (!d0.tasks.some(t => t.ms > 40 && pt >= t.t0 && pt <= t.t0 + t.ms)) return; const n = byId.get(id), k = ` :`;
      lt.set(k, (lt.get(k) || 0) + (profile.timeDeltas[i] || 0)); ltTot += profile.timeDeltas[i] || 0; });
    ltHot = [...lt].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => [k, +(v / (ltTot || 1) * 100).toFixed(1)]);
  }
  await page.evaluate(() => clearInterval(window.__mv));
  const d = await page.evaluate(() => { __prof.on = false; return { draw: __prof.draw, rt: __prof.rt, tasks: __prof.tasks, frames: __prof.frames }; });
  const dts = d.frames.map(f => f.dt), byAction = {};
  for (const r of d.rt) (byAction[r.action] ??= []).push(r.ms);
  const worker = Object.fromEntries(Object.entries(byAction).map(([a, v]) => [a, { n: v.length, totalMs: Math.round(v.reduce((x, y) => x + y, 0)), ...dist(v) }]));
  const slow = d.frames.filter(f => f.dt > 25).map(f => ({ at: +(f.t / 1000).toFixed(2), ms: +f.dt.toFixed(1),
    longTask: Math.round(Math.max(0, ...d.tasks.filter(t => t.t + t.ms > f.t - f.dt - 20 && t.t < f.t + 20).map(t => t.ms))),
    worker: d.rt.filter(r => r.t < f.t && r.t + r.ms > f.t - f.dt - 20).map(r => `${r.action}:${Math.round(r.ms)}`).slice(0, 4) }));
  rows[name] = { frameMs: dist(dts), over25: slow.length, slow: slow.slice(0, 12), drawCpuMs: dist(d.draw), workerMs: worker, longTasks: dist(d.tasks.map(t => t.ms)),
    scriptMsPerS: +((m1.ScriptDuration - m0.ScriptDuration) / (SAMPLE / 1000) * 1000).toFixed(1), taskMsPerS: +((m1.TaskDuration - m0.TaskDuration) / (SAMPLE / 1000) * 1000).toFixed(1),
    heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1), hot, files, ltHot,
    render: await page.evaluate(() => { const r = worldEvidence.render ?? {}; return { worldDraws: r.worldDraws, coastalWaterTiles: r.coastalWaterTiles }; }) };
  const r = rows[name];
  console.log(`${name.padEnd(28)} mean ${r.frameMs?.mean} p95 ${r.frameMs?.p95} p99 ${r.frameMs?.p99} >25:${r.over25} draw ${r.drawCpuMs?.mean} script/s ${r.scriptMsPerS} heap ${r.heapMB}`);
  fs.mkdirSync('test-results/perf-matrix', { recursive: true });
  fs.writeFileSync(`test-results/perf-matrix/${label}.json`, JSON.stringify({ label, W: 1280, H: 720, SETTLE, SAMPLE, loadMs, errors, rows }, null, 1));
}
console.log('loadMs', loadMs, 'errors', JSON.stringify(errors));
await ctx.close(); server.kill();
