// Torture-case perf harness (pass 3): repeated map-panel teleports (Elune <-> Azeroth, distant Azeroth points) and fast flying laps, real data.
//   node heavy-lock.mjs --label perf-torture -- node perf-torture.mjs <label> [scenario ...]      -> test-results/perf-torture/<label>.json
// Scenarios: tp-bodies-drive tp-bodies-fly tp-azeroth-drive tp-azeroth-fly tp-mixed-drive lap-800 lap-2000 lap-4000 lap-2000/<variant> lap-low  (default: all)
// Env: TP_CYCLES (6) teleport round trips, LAP_S (30) seconds per lap sample, DETAIL_MAX (20000) ms cap waiting for full detail, PROFILE=0 disables the CDP CPU profile.
// Needs WOW_DATA + SWE1R_DATA (read-only) and browser/pkg; NPC pack in ../runtime/browser (git-ignored) enables creatures. Own server on a free port (never 4173). Muted, uncapped frame rate.
// Measures per teleport / lap: rAF frame mean/p95/p99/max + frames >25/>50 ms, long tasks, main-thread worker message handler times (the ~20 ms p99 gate), worker round trips
// by action, worker-side handler run time and queue wait by action (instrumented copy of the worker served over the wire; no source change), time to arrival gate release and to
// "full detail" (worker detail/material/scene/far queues idle for 1 s), slow synchronous WebGPU calls, JS heap / GPU bytes / wasm memory per teleport and after a forced GC.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] || 'run', want = process.argv.slice(3);
const num = (k, d) => Number(process.env[k] ?? d);
const CYCLES = num('TP_CYCLES', 6), LAP_S = num('LAP_S', 30), DETAIL_MAX = num('DETAIL_MAX', 20000), PROFILE = process.env.PROFILE !== '0';
const port = await new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
if (port === 4173) throw new Error('refusing port 4173');
process.env.PORT = String(port); process.env.LAB_UNCAPPED ??= '1'; process.env.LAB_NO_RESTORE ??= '1';
const server = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('exit', () => rej(new Error('server exited'))); });
const { openLab } = await import('./race-gate-lab.mjs');

// Served-code instrumentation (same idea as body-swap-stress.mjs): worker per-action timing + engine probe, world-app exposes `app`.
const instrument = (path, text) => {
  if (path === '/world-app.js') return text + '\nglobalThis.__app=app;\n';
  if (path === '/world-client.js') return text.replace("if(data.event==='world-error')",
    "if(data.event==='perf-probe'){const id=(worker.__id??=(window.__wid=(window.__wid||0)+1));const o=performance.timeOrigin;window.__rec?.wp.push({id,t:performance.now(),rows:data.rows.map(r=>({...r,t:r.t-o})),m:data.metrics});window.__rec&&(window.__rec.last[id]=data.metrics);return;}if(data.event==='world-error')");
  if (path === '/world-worker.js') return text.replace('enqueue(()=>process(data));',
    "{const q=performance.now();enqueue(async()=>{const s=performance.now();try{return await process(data);}finally{const e=performance.now();(self.__pf??=[]).push({a:data.action,q:+(s-q).toFixed(1),run:+(e-s).toFixed(1),t:performance.timeOrigin+e});}});}")
    + "\nimport {stressProbe} from './world-engine.js';\nsetInterval(()=>postMessage({event:'perf-probe',rows:(self.__pf??=[]).splice(0),metrics:stressProbe()}),250);\n";
  if (path === '/world-engine.js') return text + `
export function stressProbe(){return {wasmBytes:wasm?.memory.buffer.byteLength||0,detailBusy,detailPending:detailPending?.tiles.size||0,terrainRead:!!terrainRead,geometry:!!geometryJob,
 materialBusy,materials:terrainMaterials.size,sceneBusy:!!scene?.busy,scenePending:scene?[...scene.requests.keys()].filter(k=>!scene.cache.has(k)&&!scene.failures.has(k)).length:0,
 sceneBytes:scene?.bytes||0,resident:resident.size,required:world?world.required_tiles().length:0,sceneInstances:sceneState?.instances.length||0,waiting:objectWait.length,
 far:{active:far?.active,reading:!!far?.reading},craftPending:craft.pending,population:scene?.populationStatus,timings:{...timings}};}
`;
  return text;
};
const setup = async ctx => {
  await ctx.route(u => /\/(world-client|world-worker|world-engine|world-app)\.js$/.test(u.pathname), async route => {
    const r = await route.fetch(); await route.fulfill({ response: r, body: instrument(new URL(route.request().url()).pathname, await r.text()), headers: { ...r.headers(), 'cache-control': 'no-store' } });
  });
  await ctx.addInitScript(() => {
    const rec = window.__rec = { frames: [], tasks: [], handlers: [], gpu: [], draw: [], rt: [], wp: [], samples: [], marks: [], last: {}, cnt: {} };
    new PerformanceObserver(l => { for (const e of l.getEntries()) rec.tasks.push({ t: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
    const d = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage');
    Object.defineProperty(Worker.prototype, 'onmessage', { ...d, set(fn) { d.set.call(this, fn && function (ev) { const s = performance.now(); try { return fn.call(this, ev); } finally { rec.handlers.push({ t: s, ms: performance.now() - s, ev: ev.data?.event || 'reply' }); } }); } });
    let last = performance.now(); const tick = n => { rec.frames.push({ t: n, dt: n - last }); last = n; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    for (const [proto, names] of [[GPUDevice.prototype, ['createRenderPipeline', 'createComputePipeline', 'createShaderModule', 'createTexture', 'createBuffer', 'createBindGroup', 'createCommandEncoder']], [GPUQueue.prototype, ['writeBuffer', 'writeTexture', 'submit', 'copyExternalImageToTexture']], [GPUCommandEncoder.prototype, ['finish']], [GPUCanvasContext.prototype, ['getCurrentTexture']]])
      for (const n of names) { const o = proto[n]; if (!o) continue; proto[n] = function (...a) { const t = performance.now(), r = o.apply(this, a), ms = performance.now() - t; if (ms > 8) rec.gpu.push({ n, t, ms: +ms.toFixed(1) });
        const c = rec.cnt[n] ??= { calls: 0, ms: 0, bytes: 0 }; c.calls++; c.ms += ms; if (n === 'writeBuffer') c.bytes += a[4] ?? (a[2]?.byteLength ?? 0); return r; }; }
  });
};
const { ctx, page, errors } = await openLab({ clouds: true, width: 1280, height: 720, setup, args: ['--enable-precise-memory-info'] });
const tLoad = performance.now();
await page.waitForFunction(() => worldTest.maelstrom && window.__app, null, { timeout: 60000 });
const loadMs = Math.round(performance.now() - tLoad);
await page.evaluate(async () => {
  await __app.prepareEngines;
  const rec = __rec;
  const { WorldRenderer } = await import('./world-renderer.js'), dr = WorldRenderer.prototype.draw;
  WorldRenderer.prototype.draw = function (...a) { const t = performance.now(), r = dr.apply(this, a); rec.draw.push({ t, ms: performance.now() - t }); return r; };
  const { WorldClient } = await import('./world-client.js'), rq = WorldClient.prototype.request;
  WorldClient.prototype.request = function (action, ...a) { const t = performance.now(), p = rq.call(this, action, ...a), done = r => { rec.rt.push({ action, t, ms: performance.now() - t }); return r; }; return p.then(done, e => { done(); throw e; }); };
  const quiet = p => !!p && !p.detailBusy && !(p.detailPending > 0) && !p.materialBusy && !p.sceneBusy && !(p.scenePending > 0) && !(p.waiting > 0) && !p.craftPending;
  rec.quiet = quiet;
  setInterval(() => {
    const a = __app, c = a.client, r = a.renderer, p = rec.last[c.worker?.__id], st = c.state;
    rec.samples.push({ t: performance.now(), body: c.bodyId, heap: performance.memory?.usedJSHeapSize, gpu: worldEvidence.gpuBytes, tiles: r?.tiles.size, textures: r?.textures.size, assets: r?.assets.size, inst: r?.instances.length, horizon: r?.horizon.length,
      busy: a.busy, loading: !!worldEvidence.loading?.active, quiet: quiet(p), rq: !!st?.required && st.required.every(i => st.resident.includes(i)) && !st.scene?.waitingCollision, nt: st?.nearTerrain && `${st.nearTerrain.resident}/${st.nearTerrain.total}`,
      wasm: p?.wasmBytes, sceneBytes: p?.sceneBytes, resident: p?.resident, pend: p ? [p.detailPending, p.scenePending, p.waiting, +p.materialBusy, +p.sceneBusy, +p.detailBusy, +!!p.far?.reading] : null, pop: p?.population, fly: !!a.flight });
  }, 100);
});

const dist = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), p = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), p50: +p(.5).toFixed(2), p95: +p(.95).toFixed(2), p99: +p(.99).toFixed(2), max: +s.at(-1).toFixed(1) }; };
const inWin = (arr, t0, t1, k = 't') => arr.filter(e => e[k] >= t0 && e[k] <= t1);
const get = () => page.evaluate(() => { const r = __rec; return { frames: r.frames, tasks: r.tasks, handlers: r.handlers, gpu: r.gpu, draw: r.draw, rt: r.rt, wp: r.wp.map(w => ({ id: w.id, rows: w.rows })), samples: r.samples, marks: r.marks }; });
const clear = () => page.evaluate(() => { const r = __rec; r.cnt = {}; for (const k of ['frames', 'tasks', 'handlers', 'gpu', 'draw', 'rt', 'wp', 'samples', 'marks']) r[k].length = 0; });
const heapNow = () => page.evaluate(() => performance.memory.usedJSHeapSize);

// Stats for one window [t0,t1] of the recorder data.
function stats(d, t0, t1) {
  const fr = inWin(d.frames, t0, t1), tasks = inWin(d.tasks, t0, t1), hs = inWin(d.handlers, t0, t1), gpu = inWin(d.gpu, t0, t1), dr = inWin(d.draw, t0, t1), rt = inWin(d.rt, t0, t1);
  const by = (arr, k, f) => { const m = {}; for (const e of arr) (m[e[k]] ??= []).push(f(e)); return m; };
  const rtBy = Object.fromEntries(Object.entries(by(rt, 'action', e => e.ms)).map(([a, v]) => [a, { total: Math.round(v.reduce((x, y) => x + y, 0)), ...dist(v) }]));
  const rows = d.wp.flatMap(w => w.rows.filter(r => r.t >= t0 && r.t <= t1).map(r => ({ ...r, w: w.id })));
  const wk = Object.fromEntries(Object.entries(by(rows, 'a', e => e)).map(([a, v]) => [a, { n: v.length, runTotal: Math.round(v.reduce((x, y) => x + y.run, 0)), runMax: Math.max(...v.map(x => x.run)), qMax: Math.max(...v.map(x => x.q)), run: dist(v.map(x => x.run)) }]));
  const dts = fr.map(f => f.dt);
  return { ms: Math.round(t1 - t0), frameMs: dist(dts), over25: dts.filter(x => x > 25).length, over50: dts.filter(x => x > 50).length, over100: dts.filter(x => x > 100).length, worstFrame: dts.length ? +Math.max(...dts).toFixed(0) : 0,
    tasks: { n: tasks.length, total: Math.round(tasks.reduce((a, b) => a + b.ms, 0)), max: Math.round(Math.max(0, ...tasks.map(x => x.ms))), over100: tasks.filter(x => x.ms > 100).length },
    handlerMs: dist(hs.map(h => h.ms)), handlerTop: hs.sort((a, b) => b.ms - a.ms).slice(0, 4).map(h => `${h.ev}:${h.ms.toFixed(0)}`), drawCpuMs: dist(dr.map(x => x.ms)), rtByAction: rtBy, workerByAction: wk,
    gpuSlow: gpu.slice(0, 12).map(g => `${g.n}:${g.ms}`) };
}
const topK = (m, k, tot) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, v]) => [n, +(v / tot * 100).toFixed(1)]);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
const profStart = async () => { if (PROFILE) await cdp.send('Profiler.start'); };
const profStop = async () => {
  if (!PROFILE) return;
  const { profile } = await cdp.send('Profiler.stop'), self = new Map(), byFile = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
  profile.samples.forEach((id, i) => { const n = byId.get(id), f = n.callFrame.url.split('/').pop() || '(native)', k = `${n.callFrame.functionName || '(anon)'} ${f}:${n.callFrame.lineNumber + 1}`, dt = profile.timeDeltas[i] || 0;
    self.set(k, (self.get(k) || 0) + dt); byFile.set(f, (byFile.get(f) || 0) + dt); });
  const tot = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  // Longest uninterrupted busy run (no idle/program samples): the worst main-thread task, attributed by self and inclusive time.
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const name = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop() || '(native)'}:${n.callFrame.lineNumber + 1}`;
  let best = { len: 0, a: 0, b: 0 }, a = 0, len = 0;
  profile.samples.forEach((id, i) => { const fn = byId.get(id).callFrame.functionName; const idle = fn === '(idle)' || fn === '(program)';
    if (idle) { len = 0; a = i + 1; } else { len += profile.timeDeltas[i] || 0; if (len > best.len) best = { len, a, b: i }; } });
  const sSelf = new Map(), sIncl = new Map();
  for (let i = best.a; i <= best.b; i++) { const dt = profile.timeDeltas[i] || 0; let id = profile.samples[i]; const k = name(byId.get(id)); sSelf.set(k, (sSelf.get(k) || 0) + dt);
    const seen = new Set(); for (; id; id = parent.get(id)) { const kk = name(byId.get(id)); if (!seen.has(kk)) { seen.add(kk); sIncl.set(kk, (sIncl.get(kk) || 0) + dt); } } }
  // Inclusive ms per function over every sample under a worker message handler (the work the ~20 ms p99 gate times).
  const hIncl = new Map(); let hTot = 0;
  profile.samples.forEach((id, i) => { const chain = []; for (let x = id; x; x = parent.get(x)) chain.push(name(byId.get(x))); if (!chain.some(n => n.startsWith('worker.onmessage'))) return;
    const dt = profile.timeDeltas[i] || 0; hTot += dt; for (const k of new Set(chain)) hIncl.set(k, (hIncl.get(k) || 0) + dt); });
  return { hot: topK(self, 16, tot), files: topK(byFile, 10, tot), spikeMs: +(best.len / 1000).toFixed(1), spikeSelf: topK(sSelf, 12, best.len || 1), spikeIncl: topK(sIncl, 18, best.len || 1),
    handlerMs: +(hTot / 1000).toFixed(1), handlerIncl: [...hIncl].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([n, v]) => [n, +(v / 1000).toFixed(1)]) };
};

const base = { cloudQuality: 'high', weather: true, weatherQuality: 'high', music: false, sound: false, shadows: false, clouds: true, night: false, particles: 'medium', waves: true, scenery: true, distant: true, horizon: true, planet: true, animateNpcs: true };
const applySettings = (s, cc = true) => page.evaluate(([s, cc]) => { worldTest.settings(s); __app.client.creatureCollision(cc); __app.client.animate(s.animateNpcs); worldTest.timeLock(720); }, [s, cc]);
const icons = await page.evaluate(async () => { const { mapIcons } = await import('./worldmap.js'); return mapIcons(__app.client.info.manifest, await worldTest.maelstrom()); });
console.log('map icons:', icons.map(i => i.id).join(', '), '| load ms', loadMs);
const azIcons = () => { const by = id => icons.find(i => i.id === id), gates = icons.filter(i => /^gate/.test(i.id));
  return [by('raceway'), by('airport'), by('maelstrom'), ...gates.sort((a, b) => b.position[0] - a.position[0]).filter((_, i, a) => i === 0 || i === a.length - 1)].filter(Boolean); };

async function teleportRun(name, seq, { fly = false } = {}) {
  await clear(); await applySettings(base);
  await page.evaluate(() => { __app.client.creatureCollision(true); });
  if (fly) await page.evaluate(() => worldTest.focus([-9800 + 20000, 300, 5000, 0, -.2]));
  else await page.evaluate(async () => { await worldTest.request('reset'); __app.flight = undefined; __app.running = true; });
  await page.waitForTimeout(4000);
  const heapBefore = await heapNow(), rows = [];
  await clear(); await profStart();
  const tStart = await page.evaluate(() => performance.now());
  for (const [i, icon] of seq.entries()) {
    const t0 = await page.evaluate(() => performance.now());
    const call = await page.evaluate(async icon => { const t = performance.now(); await __app.mapPanel.teleport(icon); return { gate: performance.now() - t, body: __app.client.bodyId, fly: !!__app.flight }; }, icon);
    // Wait for the worker queues of the active body to go idle for 1 s (or the cap), then dwell 1 s of steady state.
    const q = await page.evaluate(async ([t0, cap]) => { const r = __rec; let since = null;
      for (;;) { await new Promise(x => setTimeout(x, 100)); const s = r.samples.at(-1), now = performance.now();
        if (s && s.t >= t0 && s.quiet && s.rq) { since ??= s.t; if (now - since >= 1000) return { quietAt: since, capped: false }; } else since = null;
        if (now - t0 > cap) return { quietAt: null, capped: true }; } }, [t0, DETAIL_MAX]);
    const swapProf = await page.evaluate(() => __app.evidence.swapProfiles?.at(-1) || null);
    const t1 = await page.evaluate(() => performance.now()), d = await get();
    const sm = inWin(d.samples, t0, t1), firstRq = sm.find(s => s.rq && s.body === call.body), last = sm.at(-1) || {};
    const row = { i, to: icon.label, body: call.body, fly: call.fly, gateMs: Math.round(call.gate), rqMs: firstRq ? Math.round(firstRq.t - t0) : null, fullDetailMs: q.quietAt ? Math.round(q.quietAt - t0) : null,     capped: q.capped, swapProf,
      heapMB: +(last.heap / 1048576).toFixed(1), gpuMB: +(last.gpu / 1048576).toFixed(1), wasmMB: +((last.wasm || 0) / 1048576).toFixed(1), pend: last.pend, nt: last.nt, tiles: last.tiles, textures: last.textures, assets: last.assets, inst: last.inst, horizon: last.horizon,
      ...stats(d, t0, t1), series: sm.filter((_, i) => i % 5 === 0).map(s => [Math.round(s.t - t0), +s.rq, +s.quiet, s.nt, s.tiles, s.pend?.join('')]) };
    rows.push(row);
    { const pp = await profStop(); if (pp) { row.spikeMs = pp.spikeMs; row.spikeIncl = pp.spikeIncl.slice(0, 14); row.hProfMs = pp.handlerMs; row.hProf = pp.handlerIncl; } await profStart(); }
    console.log(`${name} #${i} ${String(row.to).slice(0, 22).padEnd(22)} gate ${row.gateMs} rq ${row.rqMs} detail ${row.fullDetailMs}${q.capped ? '(cap)' : ''} | frame mean ${row.frameMs?.mean} p99 ${row.frameMs?.p99} max ${row.worstFrame} >25:${row.over25} >100:${row.over100} | task max ${row.tasks.max} handler p99 ${row.handlerMs?.p99} max ${row.handlerMs?.max} | heap ${row.heapMB} gpu ${row.gpuMB} wasm ${row.wasmMB}`);
    // per-teleport rows are captured; keep the recorder arrays small between teleports
    await page.evaluate(() => { const r = __rec; for (const k of ['frames', 'tasks', 'handlers', 'gpu', 'draw', 'rt', 'wp', 'samples']) r[k].length = 0; });
  }
  const prof = await profStop();
  const tEnd = await page.evaluate(() => performance.now());
  await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(300); await cdp.send('HeapProfiler.collectGarbage');
  const heapAfterGc = await heapNow();
  const h = rows.map(r => r.heapMB), xs = rows.map((_, i) => i), mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = h.reduce((a, b) => a + b, 0) / h.length;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (h[i] - my), 0) / (xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1);
  const gp = rows.map(r => r.gpuMB), gslope = gp.at(-1) - gp[0];
  return { seq: seq.map(s => s.label), runMs: Math.round(tEnd - tStart), heapBeforeMB: +(heapBefore / 1048576).toFixed(1), heapAfterGcMB: +(heapAfterGc / 1048576).toFixed(1), heapSlopeMBPerTeleport: +slope.toFixed(2), gpuDeltaMB: +gslope.toFixed(1),
    fullDetailMs: dist(rows.map(r => r.fullDetailMs).filter(x => x != null)), gateMs: dist(rows.map(r => r.gateMs)), worstFrameMs: Math.max(...rows.map(r => r.worstFrame)), over25: rows.reduce((a, r) => a + r.over25, 0), over100: rows.reduce((a, r) => a + r.over100, 0),
    maxTaskMs: Math.max(...rows.map(r => r.tasks.max)), handlerP99: Math.max(...rows.map(r => r.handlerMs?.p99 ?? 0)), handlerMax: Math.max(...rows.map(r => r.handlerMs?.max ?? 0)), prof, rows };
}

// Laps: polyline circuit around Azeroth (land + sea), flown at `speed` yd/s via the same focus() poses perf-matrix uses; then stop and time recovery.
const CIRCUIT = [[-24000, -14000], [27000, -14000], [27000, 20000], [-24000, 20000]];
async function lapRun(name, { speed, alt = 300, s = {}, cc = true, circuit = CIRCUIT, craft = false }) {
  await clear(); await applySettings({ ...base, ...s }, cc);
  await page.evaluate(c => { worldTest.showCraft(!!c); worldTest.focus([-24000, 300, -14000, 0, -.1]); }, craft);
  await page.waitForTimeout(6000);
  const heapBefore = await heapNow();
  await clear(); await profStart();
  const t0 = await page.evaluate(([circuit, speed, alt]) => { const t0 = performance.now(); window.__lapStop = false;
    const seg = circuit.map((p, i) => { const q = circuit[(i + 1) % circuit.length]; return { p, q, len: Math.hypot(q[0] - p[0], q[1] - p[1]) }; }), total = seg.reduce((a, b) => a + b.len, 0);
    window.__lapPose = null; clearInterval(window.__mv);
    window.__mv = setInterval(() => { let d = ((performance.now() - t0) / 1000 * speed) % total; for (const g of seg) { if (d <= g.len) { const f = d / g.len, x = g.p[0] + (g.q[0] - g.p[0]) * f, z = g.p[1] + (g.q[1] - g.p[1]) * f, dx = g.q[0] - g.p[0], dz = g.q[1] - g.p[1];
      window.__lapPose = [x, alt, z, Math.atan2(-dx, -dz), -.05]; worldTest.focus(window.__lapPose); return; } d -= g.len; } }, 16); return t0; }, [circuit, speed, alt]);
  await page.waitForTimeout(LAP_S * 1000);
  const tStop = await page.evaluate(() => { clearInterval(window.__mv); return performance.now(); });
  const dMoving = await get(), gcnt = await page.evaluate(() => __rec.cnt);
  const nFrames = dMoving.frames.filter(f => f.t >= t0 && f.t <= tStop).length || 1;
  const perFrame = Object.fromEntries(Object.entries(gcnt).map(([k, v]) => [k, { calls: +(v.calls / nFrames).toFixed(1), ms: +(v.ms / nFrames).toFixed(2), ...(v.bytes ? { KB: +(v.bytes / nFrames / 1024).toFixed(0) } : {}) }]));
  // Stop and time how long until the worker queues are idle with near terrain resident.
  const q = await page.evaluate(async ([t0, cap]) => { const r = __rec; let since = null;
    for (;;) { await new Promise(x => setTimeout(x, 100)); const s = r.samples.at(-1), now = performance.now();
      if (s && s.t >= t0 && s.quiet && s.rq) { since ??= s.t; if (now - since >= 1000) return { quietAt: since, capped: false }; } else since = null;
      if (now - t0 > cap) return { quietAt: null, capped: true }; } }, [tStop, 30000]);
  const prof = await profStop(), tEnd = await page.evaluate(() => performance.now());
  const sm = inWin(dMoving.samples, t0, tStop), heaps = sm.map(x => x.heap), drops = heaps.filter((h, i) => i && heaps[i - 1] - h > 5 * 1048576).length;
  const perSec = []; for (let a = t0; a < tStop; a += 1000) { const f = inWin(dMoving.frames, a, a + 1000).map(x => x.dt); if (f.length) perSec.push({ s: Math.round((a - t0) / 1000), n: f.length, max: Math.round(Math.max(...f)), over25: f.filter(x => x > 25).length }); }
  const hitches = dMoving.frames.filter(f => f.t >= t0 && f.t <= tStop && f.dt > 50).map(f => ({ at: +((f.t - t0) / 1000).toFixed(1), ms: Math.round(f.dt), task: Math.round(Math.max(0, ...dMoving.tasks.filter(t => t.t + t.ms > f.t - f.dt - 20 && t.t < f.t + 20).map(t => t.ms))) })).slice(0, 25);
  const row = { speed, alt, perFrame, ...stats(dMoving, t0, tStop), hitches, heapMinMB: +(Math.min(...heaps) / 1048576).toFixed(1), heapMaxMB: +(Math.max(...heaps) / 1048576).toFixed(1), gcDrops5MB: drops,
    gpuMB: +((sm.at(-1)?.gpu || 0) / 1048576).toFixed(1), tiles: sm.at(-1)?.tiles, recoveryMs: q.quietAt ? Math.round(q.quietAt - tStop) : null, recoveryCapped: q.capped, pop: sm.at(-1)?.pop, prof };
  console.log(`${name.padEnd(22)} frame mean ${row.frameMs?.mean} p95 ${row.frameMs?.p95} p99 ${row.frameMs?.p99} max ${row.worstFrame} >25:${row.over25} >50:${row.over50} >100:${row.over100} | task max ${row.tasks.max} handler p99 ${row.handlerMs?.p99} max ${row.handlerMs?.max} | heap ${row.heapMinMB}-${row.heapMaxMB} gcDrops ${drops} recovery ${row.recoveryMs}${q.capped ? '(cap)' : ''}`);
  return row;
}

const seqBodies = n => Array.from({ length: n * 2 }, (_, i) => i % 2 === 0 ? { body: 'elune', label: 'Elune' } : { body: 'azeroth', label: 'Azeroth', reset: true });
const seqAz = () => { const a = azIcons(), out = []; for (let i = 0; i < Math.max(8, CYCLES * 2); i++) out.push(a[i % a.length]); return out; };
const seqMixed = () => { const a = azIcons(), out = []; for (let i = 0; i < Math.max(4, CYCLES); i++) out.push({ body: 'elune', label: 'Elune' }, a[i % a.length]); return out; };
const lapCells = {
  'lap-800': { speed: 800 }, 'lap-2000': { speed: 2000 }, 'lap-4000': { speed: 4000 },
  'lap-2000/cc-off': { speed: 2000, cc: false }, 'lap-2000/waves-off': { speed: 2000, s: { waves: false } }, 'lap-2000/weather-off': { speed: 2000, s: { weather: false } }, 'lap-2000/clouds-off': { speed: 2000, s: { clouds: false } },
  'lap-low': { speed: 400, alt: 25, craft: true }, 'lap-low/cc-off': { speed: 400, alt: 25, craft: true, cc: false },
};
const scenarios = {
  'tp-bodies-drive': () => teleportRun('tp-bodies-drive', seqBodies(CYCLES)), 'tp-bodies-fly': () => teleportRun('tp-bodies-fly', seqBodies(CYCLES), { fly: true }),
  'tp-azeroth-drive': () => teleportRun('tp-azeroth-drive', seqAz()), 'tp-azeroth-fly': () => teleportRun('tp-azeroth-fly', seqAz(), { fly: true }),
  'tp-mixed-drive': () => teleportRun('tp-mixed-drive', seqMixed()),
  ...Object.fromEntries(Object.entries(lapCells).map(([k, v]) => [k, () => lapRun(k, v)])),
};
const out = {};
fs.mkdirSync('test-results/perf-torture', { recursive: true });
for (const [name, run] of Object.entries(scenarios)) {
  if (want.length && !want.some(w => name === w || (w.endsWith('*') && name.startsWith(w.slice(0, -1))))) continue;
  try { out[name] = await run(); } catch (e) { out[name] = { error: String(e.stack || e) }; console.log(name, 'ERROR', e.message); }
  fs.writeFileSync(`test-results/perf-torture/${label}.json`, JSON.stringify({ label, loadMs, errors, out }, null, 1));
}
console.log('loadMs', loadMs, 'errors', JSON.stringify(errors));
await ctx.close(); server.kill();
process.exit(errors.length ? 1 : 0);
