// Data-free Elune moon frame profile (?body=elune, needs browser/pkg). Run: node heavy-lock.mjs --label perf-elune -- node perf-elune.mjs [label]
// -> test-results/perf-elune/<label>.json. Uncapped rAF frame ms, WorldRenderer.draw CPU and V8 heap per pose. Own server on a free port.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const label = process.argv[2] || 'run', SETTLE = Number(process.env.SETTLE || 5000), SAMPLE = Number(process.env.SAMPLE || 8000);
const port = await new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
if (port === 4173) throw new Error('refusing port 4173');
const server = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('exit', () => rej(new Error('server exited'))); });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
const errors = [];
const dist = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), p = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), p95: +p(.95).toFixed(2), p99: +p(.99).toFixed(2), max: +s.at(-1).toFixed(1) }; };
const rows = {};
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?body=elune&test`);
  await page.waitForFunction(() => window.worldTest, null, { timeout: 60000 });
  await page.waitForTimeout(6000);
  const loadMs = Date.now() - t0;
  await page.evaluate(() => {
    const m = window.__prof = { on: false, draw: [], frames: [] };
    import('./world-renderer.js').then(({ WorldRenderer }) => { const d = WorldRenderer.prototype.draw;
      WorldRenderer.prototype.draw = function (...a) { const t = performance.now(), r = d.apply(this, a); if (m.on) m.draw.push(performance.now() - t); return r; }; });
    let last = performance.now(); const tick = n => { if (m.on) m.frames.push(n - last); last = n; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const poses = { 'orbit-down': [{}, [0, 40000, 0, 0, -1.45]], 'orbit-limb': [{}, [0, 40000, 0, 0, -.35]], 'low-up': [{}, [0, 600, 0, 0, 1.2]],
    'low-up/planet-off': [{ planet: false, globeMesh: false }, [0, 600, 0, 0, 1.2]], 'orbit-down/planet-off': [{ planet: false, globeMesh: false }, [0, 40000, 0, 0, -1.45]] };
  for (const [name, [s, pose]] of Object.entries(poses)) {
    await page.evaluate(([s, p]) => { worldTest.settings({ planet: true, globeMesh: true, music: false, sound: false, ...s }); worldTest.timeLock(720); worldTest.focus(p); }, [s, pose]);
    await page.waitForTimeout(SETTLE);
    await page.evaluate(() => Object.assign(__prof, { on: true, draw: [], frames: [] })); await page.waitForTimeout(SAMPLE);
    const d = await page.evaluate(() => { __prof.on = false; return { draw: __prof.draw, frames: __prof.frames }; });
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    rows[name] = { frameMs: dist(d.frames), over25: d.frames.filter(x => x > 25).length, drawCpuMs: dist(d.draw), heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1) };
    console.log(name.padEnd(24), JSON.stringify(rows[name]));
  }
  fs.mkdirSync('test-results/perf-elune', { recursive: true });
  fs.writeFileSync(`test-results/perf-elune/${label}.json`, JSON.stringify({ label, loadMs, errors, rows }, null, 1));
  console.log('loadMs', loadMs, 'errors', JSON.stringify(errors));
} finally { await browser.close(); server.kill(); }
process.exit(errors.length ? 1 : 0);
