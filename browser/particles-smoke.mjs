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
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click(); await page.locator('#gib').uncheck(); await page.keyboard.press('Escape');
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

// Wreck: burst + fire at the start, smoke trails on the debris afterwards.
const kind = k => page.evaluate(k => { const p = worldTest.particles(), d = p.data, names = ['plume', 'fire', 'smoke', 'dust', 'burst']; let n = 0; for (let i = 0; i < p.capacity; i++) if (d[i * 12 + 6] < d[i * 12 + 7] && names[d[i * 12 + 10]] === k) n++; return n; }, k);
await page.evaluate(() => { worldTest.selectVehicle({ vehicle: 'podracer', skin: 'rocket' }); worldTest.particles().data.fill(0); });
await page.waitForTimeout(2000);
await page.evaluate(() => worldTest.testCrash(true, 120));
await page.waitForTimeout(120); await shot('4-wreck-start');
const start = { burst: await kind('burst'), fire: await kind('fire') };
await page.waitForTimeout(1000); await shot('5-wreck-debris');
const later = { fire: await kind('fire'), smoke: await kind('smoke') };
console.log('wreck', JSON.stringify({ start, later }));
assert.ok(start.burst > 0 && start.fire > 0 && later.smoke > 0, 'explosion burst, fire and debris smoke');
await page.waitForFunction(() => !worldTest.wreck(), null, { timeout: 15000 });

// Overheat warning smoke (heat >= 80%, SWE1R folder): boost until just before the blast and count smoke from the engines.
if (SWE1R_DATA) {
  await page.evaluate(() => worldTest.particles().data.fill(0));
  await page.waitForTimeout(6000); await page.locator('#world').focus();
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
  let smoke = 0;
  for (let i = 0; i < 300 && !smoke; i++) {
    await page.waitForTimeout(100);
    const heat = await page.evaluate(() => 1 - worldEvidence.state.telemetry[6]);
    if (i > 5 && i % 10 === 0) await page.evaluate(() => { const t = worldEvidence.state.telemetry; if (t[5] < 20) worldTest.request('restore', { pose: [t[0], t[1] + 12, t[2], t[3] + 1.3] }); });
    if (heat > .85) { await page.waitForTimeout(150); smoke = await kind('smoke'); await shot('6-overheat-smoke'); }
  }
  await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
  console.log('overheat smoke particles', smoke);
  assert.ok(smoke > 0, 'smoke curls off the engines near max heat');
  await page.waitForFunction(() => !worldTest.wreck(), null, { timeout: 15000 });
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
