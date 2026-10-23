// Top race banner check in the real page at 4:3, 16:9 and 360 px (own art, WOW_DATA only): LAP / TIME / POS cells, sub line, lap banner, no overlaps.
// Needs a server on PORT (default 4183). Shots go to the git-ignored runtime/hud-top.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const { WOW_DATA } = process.env;
if (!WOW_DATA) { console.log('WOW_DATA required, skipping'); process.exit(0); }
const out = path.resolve('..', 'runtime', 'hud-top');
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-hudtop-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 4183}/?test`);
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click();
await page.locator('#gib').uncheck(); await page.keyboard.press('Escape');
await page.locator('#world').click();
await page.evaluate(() => { worldTest.settings({ shadows: false, clouds: false, night: false, music: false }); worldTest.selectVehicle({ vehicle: 'podracer', skin: 'rocket' }); });
await page.evaluate(() => {
  const p = worldEvidence.state.telemetry;
  worldTest.startRace({ id: 'hud-top', name: 'HUD top', mode: 'lap', laps: 3, vehicle: 'podracer',
    start: { pos: [p[0], p[1], p[2]], yaw: p[3] }, gates: [{ pos: [p[0] + 4000, p[1], p[2] + 4000], yaw: 0, width: 50 }] });
});
await page.waitForFunction(() => worldTest.raceInfo()?.state === 'running', null, { timeout: 15000 });
await page.evaluate(() => { const r = worldTest.raceObj(); r.splits.push(40); r.lap = 2; });
await page.waitForTimeout(500);
assert.equal(await page.locator('#race-lap').textContent(), '2/3');
assert.match(await page.locator('#race-time').textContent(), /^\d:\d\d\.\d\d$/);
assert.equal(await page.locator('#race-pos').textContent(), '1/1');
assert.match(await page.locator('#race-laps').textContent(), /^Last 0:40\.00 {2}Best lap 0:40\.00$/);
assert.equal(await page.locator('#race-banner').textContent(), 'LAP 2', 'lap banner shows without the Racer folder');
for (const [name, w, h] of [['4x3', 1024, 768], ['16x9', 1280, 720], ['360', 360, 640]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(600);
  await page.evaluate(() => { const b = document.getElementById('race-banner'); b.hidden = false; });
  const box = await page.evaluate(() => {
    const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return { hud: r('#race-hud'), band: r('#race-hud .rh-band'), lap: r('.rh-lap'), time: r('.rh-time'), pos: r('.rh-pos'), hint: r('#menu-hint'), banner: r('#race-banner') };
  });
  console.log(name, JSON.stringify(box));
  assert.ok(box.hud.x >= 0 && box.hud.x + box.hud.w <= w + .5, `${name}: inside the viewport width`);
  assert.ok(box.lap.x + box.lap.w <= box.time.x + 1 && box.time.x + box.time.w <= box.pos.x + 1, `${name}: cells do not overlap`);
  assert.ok(box.hud.y + box.hud.h < box.banner.y, `${name}: top HUD clears the lap banner`);
  assert.ok(box.band.y + box.band.h <= box.hint.y || box.band.y >= box.hint.y + box.hint.h || box.band.x + box.band.w <= box.hint.x, `${name}: clears the Esc hint`);
  await page.screenshot({ path: path.join(out, `top-${name}.png`) });
}
await ctx.close();
if (errors.length) { console.error(errors); process.exit(1); }
console.log('top hud shots ->', out);
