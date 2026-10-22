// Repeatable podracer render check. Needs SWE1R_DATA (SWE1R data dir) and WOW_DATA (WoW Data dir); skips without them.
//   $env:SWE1R_DATA=...; $env:WOW_DATA=...; $env:PORT=4183; node server.mjs   (separate shell), then: node render-smoke-pod.mjs
// For every pod skin (Rocket, dug-racer GLBs, all SWE1R pods) it screenshots five fixed views of the parked craft, checks the model
// and pixels, and writes runtime/pod-renders/{report.json,index.html,*.png}. Output is git-ignored; never commit or share it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { VEHICLES } from './vehicles.js';
import { podSkinList, loadPodModel } from './swe1r/skin.js';
import { findLev } from './swe1r/cli.mjs';
import { readBlock } from './swe1r/block.js';
import { parseModel } from './swe1r/model.js';
import { meshTexture } from './swe1r/pod.js';
import { VIEWS, viewPose, pixelStats, modelChecks } from './pod-render-lib.mjs';

const { SWE1R_DATA, WOW_DATA } = process.env, URL = `http://127.0.0.1:${process.env.PORT || 4183}/?test`;
if (!SWE1R_DATA || !WOW_DATA) { console.log('SKIP: set SWE1R_DATA and WOW_DATA'); process.exit(0); }
const out = path.resolve('..', 'runtime', 'pod-renders');
fs.mkdirSync(out, { recursive: true });

// Model-side checks run in node on the same loader the page uses.
const lev = findLev(SWE1R_DATA), reader = { read: async n => new Uint8Array(fs.readFileSync(path.join(lev, n))) };
const modelBlock = readBlock(await reader.read('out_modelblock.bin'), 'model');
const swe = podSkinList(), report = {};
for (const skin of swe) {
  const r = report[skin.id] = { name: skin.name, defects: [], views: {} };
  try {
    const pod = await loadPodModel(reader, skin), m = modelChecks(pod.asset, skin.scale);
    Object.assign(r, { tris: m.tris, size: m.size.map(s => +s.toFixed(2)), textures: pod.textures.length });
    r.defects.push(...m.defects); r.warnings = m.warnings;
    const [mask, body] = modelBlock[skin.index], meshes = parseModel(body, mask).meshes;
    const keys = new Set(meshes.map(x => meshTexture(body, x)?.index).filter(i => i !== undefined));
    r.texturesReferenced = keys.size;
    r.texturesCapped = Math.max(0, keys.size - pod.textures.length);
    r.untexturedMeshes = meshes.filter(x => !meshTexture(body, x)).length;
    if (r.texturesCapped) r.defects.push(`${r.texturesCapped} of ${keys.size} textures dropped by the 16-texture cap`);
  } catch (e) { r.defects.push(`load failed: ${e.message}`); }
}

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pods-')),
  { channel: 'msedge', headless: true, viewport: { width: 640, height: 400 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(URL);
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
await page.locator('#swe1r-files').setInputFiles(SWE1R_DATA);
await page.waitForFunction(() => document.getElementById('swe1r-status').dataset.ok === '1', null, { timeout: 60000 });
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
await page.waitForTimeout(2500);
// Neutral scene: no HUD/overlays, no shadows, clouds or night. Ground is the spawn terrain (not synthetic flat ground).
await page.evaluate(() => { const s = new CSSStyleSheet(); s.replaceSync('*{visibility:hidden!important}canvas{visibility:visible!important}'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; });
await page.evaluate(() => { worldTest.showCraft(true); worldTest.settings({ shadows: false, clouds: false, night: false, cockpit: false, music: false, sound: false }); });

const skins = [...VEHICLES.podracer.skins.filter(s => s.source !== 'swe1r' && s.source !== 'none'), ...swe];
for (const skin of skins) {
  const r = report[skin.id] ??= { name: skin.name, defects: [], views: {} };
  const before = errors.length;
  await page.evaluate(s => worldTest.selectVehicle({ vehicle: 'podracer', skin: s }), skin.id);
  await page.waitForFunction(() => worldEvidence.render?.craftStatus === 'ready' || worldEvidence.errors.length, null, { timeout: 30000 }).catch(() => {});
  const size = await page.evaluate(() => worldEvidence.render?.craftSize);
  if (size) r.craftSize = size.map?.(s => +s.toFixed(2)) ?? size;
  const car = await page.evaluate(() => worldEvidence.state.telemetry.slice(0, 4));
  const dist = Math.max(8, ...(r.size ?? [0])) * 1.6;
  for (const v of VIEWS) {
    await page.evaluate(p => worldTest.focus(p), viewPose(car, v, dist));
    await page.waitForTimeout(700);
    const file = `${skin.id}-${v}.png`;
    const png = await page.screenshot({ path: path.join(out, file) });
    const px = await page.evaluate(async b64 => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))], { type: 'image/png' })), c = new OffscreenCanvas(bmp.width / 2, bmp.height / 2), g = c.getContext('2d');
      g.drawImage(bmp, bmp.width / 4, bmp.height / 4, bmp.width / 2, bmp.height / 2, 0, 0, c.width, c.height);
      return Array.from(g.getImageData(0, 0, c.width, c.height).data);
    }, png.toString('base64'));
    const s = r.views[v] = { file, ...pixelStats(Uint8ClampedArray.from(px)) };
    if (s.flat) r.defects.push(`${v}: blank frame`);
    if (s.magentaFraction > .02) r.defects.push(`${v}: ${(s.magentaFraction * 100).toFixed(1)}% magenta`);
  }
  const ev = await page.evaluate(() => worldEvidence.errors.slice());
  if (errors.length > before || ev.length) r.defects.push(`console/page errors: ${[...errors.slice(before), ...ev].join(' | ').slice(0, 200)}`);
}
await ctx.close();

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ at: new Date().toISOString(), skins: report }, null, 1));
const cell = (id, v) => `<td><img loading=lazy src="${report[id].views[v]?.file ?? ''}" width=200></td>`;
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset=utf-8><title>Pod renders</title><body style="background:#111;color:#ddd;font:12px sans-serif"><table>` +
  `<tr><th>skin<th>${VIEWS.join('<th>')}<th>defects` + skins.map(s => `<tr><td>${s.name}</td>${VIEWS.map(v => cell(s.id, v)).join('')}<td>${report[s.id].defects.join('<br>') || 'ok'}</td>`).join('') + '</table>');
const bad = skins.filter(s => report[s.id].defects.length);
console.log(`${skins.length} skins, ${bad.length} with defects -> ${out}`);
for (const s of bad) console.log(`- ${s.name}: ${report[s.id].defects.join('; ')}`);
process.exit(bad.some(s => report[s.id].defects.some(d => /blank|load failed|non-finite|no triangles|errors/.test(d))) ? 1 : 0);
