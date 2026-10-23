// Bottom HUD sizing check in the real page at 4:3, 16:9 and 360 px: each group ~1/6 of the viewport width at the Racer ratios.
// MODE=real (SWE1R_DATA sprites) or own (WOW_DATA only). Needs WOW_DATA and a server on PORT (default 4183). Shots go to the git-ignored runtime/hud-size.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const { WOW_DATA, SWE1R_DATA, MODE = 'real' } = process.env;
if (!WOW_DATA || (MODE === 'real' && !SWE1R_DATA)) { console.log('WOW_DATA (and SWE1R_DATA for MODE=real) required, skipping'); process.exit(0); }
const out = path.resolve('..', 'runtime', 'hud-size');
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-hudsize-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 4183}/?test`);
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
if (MODE === 'real') {
  await page.locator('#swe1r-files').setInputFiles(SWE1R_DATA);
  await page.waitForFunction(() => document.getElementById('swe1r-status').dataset.ok === '1', null, { timeout: 60000 });
}
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click();
await page.locator('#gib').uncheck(); await page.keyboard.press('Escape');
await page.locator('#world').click();
await page.evaluate(() => { worldTest.settings({ shadows: false, clouds: false, night: false, music: false }); worldTest.selectVehicle({ vehicle: 'podracer', skin: 'rocket' }); });
await page.evaluate(() => {
  const p = worldEvidence.state.telemetry;
  worldTest.startRace({ id: 'hud-size', name: 'HUD size', mode: 'lap', laps: 3, vehicle: 'podracer',
    start: { pos: [p[0], p[1], p[2]], yaw: p[3] }, gates: [{ pos: [p[0] + 4000, p[1], p[2] + 4000], yaw: 0, width: 50 }] });
});
await page.waitForFunction(() => worldTest.raceInfo()?.state === 'running', null, { timeout: 15000 });
for (const [name, w, h] of [['4x3', 1024, 768], ['16x9', 1280, 720], ['360', 360, 640]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(700);
  const box = await page.evaluate(() => {
    const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const real = !document.getElementById('swe1r-hud').hidden;
    return real ? { dial: r('#swe1r-hud'), engines: r('#swe1r-heat') } : { dial: r('.speed-dial'), engines: r('.heat-twin') };
  });
  const want = Math.min(320, Math.max(96, w / 6));
  console.log(name, JSON.stringify(box));
  assert.ok(Math.abs(box.dial.w - want) <= 1 && Math.abs(box.engines.w - want) <= 1, `${name}: each group ~1/6 width (${want})`);
  assert.ok(Math.abs(box.dial.w / box.dial.h - 71 / 59) < .03, `${name}: dial ratio 71:59`);
  assert.ok(Math.abs(box.engines.w / box.engines.h - 67 / 62) < .05, `${name}: engine pair ratio 67:62`);
  assert.ok(box.engines.x + box.engines.w <= box.dial.x && box.dial.y + box.dial.h <= h && box.engines.y + box.engines.h <= h, `${name}: no overlap, on screen`);
  await page.screenshot({ path: path.join(out, `${MODE}-${name}.png`) });
}
await ctx.close();
if (errors.length) { console.error(errors); process.exit(1); }
console.log('hud size shots ->', out);
