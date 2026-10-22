// Particle layer check in Edge (muted): the billboard pass draws, quality 'off' draws nothing, and the setting persists.
// Needs WOW_DATA (SWE1R_DATA optional, adds a pod plume capture). Server: $env:PORT=4183; node server.mjs. Screenshots go to the git-ignored runtime/particle-shots.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { podSkinList } from './swe1r/skin.js';

const { SWE1R_DATA, WOW_DATA } = process.env, URL = `http://127.0.0.1:${process.env.PORT || 4183}/?test`;
if (!WOW_DATA) { console.log('SKIP: set WOW_DATA'); process.exit(0); }
const out = path.resolve('..', 'runtime', 'particle-shots');
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fx-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(URL);
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
if (SWE1R_DATA) {
  await page.locator('#swe1r-files').setInputFiles(SWE1R_DATA);
  await page.waitForFunction(() => document.getElementById('swe1r-status').dataset.ok === '1', null, { timeout: 60000 });
}
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
await page.evaluate(() => worldTest.settings({ shadows: false, clouds: false, music: false }));
await page.locator('#world').click();
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const live = () => page.evaluate(() => worldTest.particles().count);
const frames = n => page.evaluate(n => new Promise(r => { let i = 0; const f = () => ++i >= n ? r() : requestAnimationFrame(f); requestAnimationFrame(f); }), n);

await page.evaluate(() => { const p = worldTest.particles(), t = worldEvidence.state.telemetry; for (let i = 0; i < 300; i++) p.emit(['burst', 'fire', 'smoke', 'dust'][i % 4], t[0] + (i % 7) * .5, t[1] + 3 + (i % 5) * .5, t[2] + i % 3, 0, 0, 0, 3, 2); });
await frames(2);
assert.ok(await live() > 100, 'emitted particles are alive and drawn');
await shot('1-pool-smoke');

// Thrust plumes: idle vs boosting, Rocket (no folder needed) then SWE1R pods. Throttle sets thrust, so a stuck pod still shows them.
await page.evaluate(() => worldTest.particles().data.fill(0)); // all slots dead (age 0, life 0)
const skins = [{ id: 'rocket', name: 'rocket' }, ...(SWE1R_DATA ? podSkinList().slice(0, 2) : [])];
for (const skin of skins) {
  await page.evaluate(s => { worldTest.selectVehicle({ vehicle: 'podracer', skin: s }); worldTest.settings({ particles: 'high' }); }, skin.id);
  await page.waitForTimeout(2500);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1500);
  const cruise = await live(); await shot(`2-${skin.id}-thrust`);
  await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(1200);
  const boost = await live(); await shot(`3-${skin.id}-boost`);
  await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
  console.log(skin.name, 'live particles cruise/boost', cruise, boost);
  assert.ok(cruise > 20, `${skin.id}: thrust plume particles drawn`);
  assert.ok(boost > cruise, `${skin.id}: boost emits more than cruise`);
  await page.waitForTimeout(2500);
}

// Esc option: Off stops drawing, persists in the save.
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click();
assert.equal(await page.locator('#particles').inputValue(), 'medium');
await page.locator('#particles').selectOption('off');
assert.equal(await page.evaluate(() => worldTest.settings().particles), 'off');
await page.keyboard.press('Escape');

const ev = await page.evaluate(() => worldEvidence.errors.slice());
await ctx.close();
assert.deepEqual([...errors, ...ev], [], 'no console/page errors');
console.log(`particles smoke ok -> ${out}`);
