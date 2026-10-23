// Plume placement audit in muted Edge (see README "Plume audit"). For the Rocket and every SWE1R pod skin it loads the craft, grabs the
// renderer's real emitter points, runs the plume-check.js heuristics, takes a rear boost screenshot, and writes into the git-ignored runtime/plume-audit:
//   report.json (machine readable), shots/<id>.png, schematic-N.png (side/top/rear wireframes, emitters in red, 6 pods per sheet) and game-N.png (3x3 labelled shots).
// Env: WOW_DATA, SWE1R_DATA, PORT (default 4183; start server.mjs first). Optional ONLY=id,id to rerun a few skins.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { podSkinList } from './swe1r/skin.js';
import { checkPlumes } from './plume-check.js';
import { classifyTriangles } from './wreck.js';

const { SWE1R_DATA, WOW_DATA } = process.env, URL = `http://127.0.0.1:${process.env.PORT || 4183}/?test`;
if (!WOW_DATA) { console.log('SKIP: set WOW_DATA'); process.exit(0); }
const out = path.resolve(import.meta.dirname, '..', 'runtime', 'plume-audit'), shots = path.join(out, 'shots');
fs.mkdirSync(shots, { recursive: true });
const only = process.env.ONLY?.split(',');
const skins = [{ id: 'rocket', name: 'Rocket' }, ...(SWE1R_DATA ? podSkinList() : [])].filter(s => !only || only.includes(s.id));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-plume-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
await page.evaluate(async () => {
  const { WorldRenderer } = await import('./world-renderer.js'), draw = WorldRenderer.prototype.draw;
  WorldRenderer.prototype.draw = function (...a) { window.rig = this; return draw.apply(this, a); };
});
if (SWE1R_DATA) {
  await page.locator('#swe1r-files').setInputFiles(SWE1R_DATA);
  await page.waitForFunction(() => document.getElementById('swe1r-status').dataset.ok === '1', null, { timeout: 60000 });
}
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
await page.evaluate(() => worldTest.settings({ shadows: false, clouds: false, music: false, particles: 'high' }));
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click(); await page.locator('#gib').uncheck(); await page.keyboard.press('Escape');
await page.locator('#world').click();

const report = [];
for (const skin of skins) {
  await page.evaluate(s => worldTest.selectVehicle({ vehicle: 'podracer', skin: s }), skin.id);
  await page.waitForFunction(id => window.rig?.craft?.fx && window.rig.craft.key !== undefined, skin.id, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const data = await page.evaluate(() => { const c = rig.craft; return c?.source && c.fx ? { key: c.key, scale: c.metadata.scale, vertices: Array.from(c.source.vertices), indices: Array.from(c.source.indices), points: c.fx.points } : null; });
  if (!data) { report.push({ id: skin.id, name: skin.name, error: 'craft not loaded' }); continue; }
  const vertices = Float32Array.from(data.vertices), indices = Uint32Array.from(data.indices), result = checkPlumes({ vertices, indices, points: data.points });
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(shots, `${skin.id}.png`) });
  await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW'); await page.waitForTimeout(1200);
  const { part } = classifyTriangles(vertices, indices), vp = new Uint8Array(vertices.length / 12);
  for (let t = 0; t < part.length; t++) for (let k = 0; k < 3; k++) vp[indices[t * 3 + k]] = part[t];
  report.push({ id: skin.id, name: skin.name, scale: data.scale, ...result, _draw: { v: Array.from(vertices.filter((_, i) => i % 12 < 3)).map(n => +n.toFixed(3)), p: Array.from(vp) } });
  console.log(skin.id.padEnd(10), skin.name.padEnd(22), result.flags.length ? 'FLAG ' + result.flags.join('; ') : 'ok');
}
const light = report.map(({ _draw, ...r }) => r);
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(light, null, 1));

// Contact sheets: schematic wireframes (side/top/rear) and the labelled game shots.
const sheet = await ctx.newPage();
const draw = items => sheet.evaluate(items => {
  document.body.innerHTML = ''; document.body.style.cssText = 'margin:0;background:#111';
  const c = document.createElement('canvas'); c.width = 1200; c.height = 600; document.body.append(c);
  const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, 1200, 600); g.font = '14px sans-serif';
  items.forEach((it, n) => {
    const ox = (n % 2) * 600, oy = Math.floor(n / 2) * 200, V = it.v, P = it.p, xs = [], ys = [], zs = [];
    for (let i = 0; i < V.length; i += 3) { xs.push(V[i]); ys.push(V[i + 1]); zs.push(V[i + 2]); }
    const lo = a => a.reduce((m, v) => Math.min(m, v), 1e9), hi = a => a.reduce((m, v) => Math.max(m, v), -1e9);
    const L = hi(xs) - lo(xs), W = hi(ys) - lo(ys), H = hi(zs) - lo(zs), k = 170 / Math.max(L, W + H);
    const views = [[0, 2, 'side', 0, ox + 8, oy + 190 - 0], [0, 1, 'top', 0, ox + 8 + 0, oy + 100], [1, 2, 'rear', 0, ox + 470, oy + 190]];
    // side: x right, z up (bottom at oy+190). top: x right, y up. rear: y right, z up.
    const sx = x => ox + 10 + (x - lo(xs)) * k, sz = z => oy + 190 - (z - lo(zs)) * k;
    const ty = y => oy + 100 - (y - (lo(ys) + hi(ys)) / 2) * k, ry = y => ox + 500 + (y - (lo(ys) + hi(ys)) / 2) * k;
    const tx = x => ox + 205 + (x - lo(xs)) * k * .0 + 0;
    const sideX = x => ox + 10 + (x - lo(xs)) * k * 1, topX = x => ox + 215 + (x - lo(xs)) * k;
    for (let i = 0; i < P.length; i++) {
      g.fillStyle = P[i] === 0 ? '#667' : P[i] === 1 ? '#4af' : '#4d8';
      g.fillRect(sideX(xs[i]) - 1, sz(zs[i]) - 1, 2, 2); g.fillRect(topX(xs[i]) - 1, ty(ys[i]) - 1, 2, 2); g.fillRect(ry(ys[i]) - 1, sz(zs[i]) - 1, 2, 2);
    }
    g.strokeStyle = '#f33'; g.fillStyle = '#f33';
    for (const p of it.points) {
      for (const [px, py, qx, qy] of [[sideX(p[0]), sz(p[2]), sideX(p[0] - L * .25), sz(p[2])], [topX(p[0]), ty(p[1]), topX(p[0] - L * .25), ty(p[1])]]) {
        g.beginPath(); g.arc(px, py, 4, 0, 7); g.fill(); g.beginPath(); g.moveTo(px, py); g.lineTo(qx, qy); g.stroke();
      }
      g.beginPath(); g.arc(ry(p[1]), sz(p[2]), 4, 0, 7); g.fill();
    }
    g.fillStyle = '#fff'; g.fillText(`${it.label}${it.flags.length ? '  FLAG: ' + it.flags.join('; ') : ''}`, ox + 8, oy + 16);
    g.strokeStyle = '#333'; g.strokeRect(ox, oy, 600, 200);
  });
}, items);
let n = 0;
for (let i = 0; i < report.length; i += 6, n++) {
  await draw(report.slice(i, i + 6).filter(r => r._draw).map(r => ({ label: `${r.id} ${r.name}`, flags: r.flags, points: r.points, v: r._draw.v, p: r._draw.p })));
  await sheet.locator('canvas').screenshot({ path: path.join(out, `schematic-${n}.png`) });
}
n = 0;
for (let i = 0; i < report.length; i += 9, n++) {
  const group = report.slice(i, i + 9).filter(r => fs.existsSync(path.join(shots, `${r.id}.png`)));
  await sheet.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(3,426px);font:13px sans-serif;color:#fff">${group.map(r =>
    `<div style="position:relative;height:240px"><img width=426 height=240 src="data:image/png;base64,${fs.readFileSync(path.join(shots, `${r.id}.png`)).toString('base64')}"><b style="position:absolute;left:4px;top:2px;text-shadow:0 0 3px #000">${r.id} ${r.name}${r.flags?.length ? ' ⚠' : ''}</b></div>`).join('')}</body>`);
  await sheet.screenshot({ path: path.join(out, `game-${n}.png`), clip: { x: 0, y: 0, width: 1278, height: 720 } });
}
const flagged = light.filter(r => r.error || r.flags?.length);
console.log(`audited ${light.length}, flagged ${flagged.length}; output ${out}`, errors.length ? errors : '');
await ctx.close();
