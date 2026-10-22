// SWE1R in-race HUD check in Edge (lap counter, lap times, banners, heat gauge, klaxon/coolant loops, overheat blast).
// Needs SWE1R_DATA and WOW_DATA; skips without them. Server: $env:PORT=4183; node server.mjs. Screenshots go to the git-ignored runtime/hud-shots.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const { SWE1R_DATA, WOW_DATA } = process.env, URL = `http://127.0.0.1:${process.env.PORT || 4183}/?test`;
if (!SWE1R_DATA || !WOW_DATA) { console.log('SKIP: set SWE1R_DATA and WOW_DATA'); process.exit(0); }
const out = path.resolve('..', 'runtime', 'hud-shots');
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-hud-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
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
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click();
await page.locator('#sound').check(); await page.locator('#gib').uncheck();
assert.equal(await page.locator('#overheat').isChecked(), true, 'overheat option is on by default');
await page.keyboard.press('Escape'); await page.locator('#world').focus();
await page.locator('#world').click(); await page.waitForFunction(() => worldEvidence.audio.state === 'running', null, { timeout: 15000 });
await page.evaluate(() => { worldTest.settings({ shadows: false, clouds: false, night: false, music: false }); worldTest.selectVehicle({ vehicle: 'podracer', skin: 'rocket' }); });
await page.waitForTimeout(1500);

const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const heat = () => page.evaluate(() => 1 - worldEvidence.state.telemetry[6]);

// A 3-lap race on a one-gate track just ahead of the spawn point; the gate is far behind the lineup so it never triggers here.
await page.evaluate(() => {
  const p = worldEvidence.state.telemetry, yaw = p[3];
  worldTest.startRace({ id: 'hud-smoke', name: 'HUD smoke', mode: 'lap', laps: 3, vehicle: 'podracer',
    start: { pos: [p[0], p[1], p[2]], yaw }, gates: [{ pos: [p[0] + 4000, p[1], p[2] + 4000], yaw: 0, width: 50 }] });
});
await page.waitForFunction(() => worldTest.raceInfo()?.state === 'running', null, { timeout: 15000 });
await page.waitForTimeout(500);
assert.equal(await page.locator('#race-lap').textContent(), 'Lap 1/3');
assert.equal(await page.locator('#race-laps').textContent(), '', 'no lap times before a lap is done');
await shot('1-lap-counter');

// Complete lap 1 in 40 s, then lap 2 in 35 s: counter, last/best and banner follow.
await page.evaluate(() => { const r = worldTest.raceObj(); r.splits.push(40); r.lap = 2; });
await page.waitForTimeout(400);
assert.equal(await page.locator('#race-lap').textContent(), 'Lap 2/3');
assert.match(await page.locator('#race-laps').textContent(), /^Last 0:40\.00 {2}Best lap 0:40\.00$/);
assert.equal(await page.locator('#race-banner').textContent(), 'LAP 2');
await shot('2-lap-2-banner');
await page.evaluate(() => { const r = worldTest.raceObj(); r.splits.push(75); r.lap = 3; });
await page.waitForTimeout(400);
assert.equal(await page.locator('#race-banner').textContent(), 'LAP RECORD - FINAL LAP');
assert.match(await page.locator('#race-laps').textContent(), /Last 0:35\.00 {2}Best lap 0:35\.00/);
await shot('3-lap-record-final-lap');

// Heat: boost on the ground until the pod blows up; gauge, klaxon stages and blast are sampled on the way.
await page.locator('#world').focus();
await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
const seen = { klaxon: new Set(), shots: new Set(), exploded: false };
for (let i = 0; i < 200 && !seen.exploded; i++) {
  await page.waitForTimeout(100);
  const h = await heat();
  // Terrain/obstacles stop the pod; hop it clear in a new direction and keep boosting.
  if (i > 5 && i % 10 === 0) await page.evaluate(() => { const t = worldEvidence.state.telemetry; if (t[5] < 20) worldTest.request('restore', { pose: [t[0], t[1] + 12, t[2], t[3] + 1.3] }); });
  for (const n of await page.evaluate(() => worldTest.heldLoops())) seen.klaxon.add(n);
  if (h > .45 && !seen.shots.has('a')) { seen.shots.add('a'); await shot('4-heat-half'); }
  if (h > .85 && !seen.shots.has('b')) { seen.shots.add('b'); await shot('5-heat-warning'); }
  seen.exploded = !!(await page.evaluate(() => worldTest.wreck()));
}
await shot('6-overheat-wreck');
await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
assert.ok(seen.exploded, 'boosting into max heat blows the pod up');
assert.ok([...seen.klaxon].some(n => n.startsWith('sfx_klaxon')), `klaxon loop played (saw ${[...seen.klaxon]})`);

// Cooldown: coolant spray loops while the engine vents, silent once cold.
await page.waitForTimeout(3500);
const cooling = await page.evaluate(() => ({ heat: 1 - worldEvidence.state.telemetry[6], loops: worldTest.heldLoops() }));
console.log('cooldown', JSON.stringify(cooling));
await shot('7-cooldown');
assert.ok(cooling.loops.includes('sfx_pod_coolant_spray_loop'), 'coolant loop while venting');
await page.waitForFunction(() => !worldTest.heldLoops().length, null, { timeout: 30000 }).catch(async e => { console.log(await page.evaluate(() => [1 - worldEvidence.state.telemetry[6], worldTest.heldLoops(), worldEvidence.state.telemetry[5]])); throw e; });

// Option off: boosting to max heat does not explode.
await page.waitForTimeout(6000);
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click();
await page.locator('#overheat').uncheck();
await page.keyboard.press('Escape'); await page.locator('#world').focus();
await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
await page.waitForFunction(() => worldEvidence.state.telemetry[6] <= 0, null, { timeout: 15000 });
await page.waitForTimeout(800);
const calm = await page.evaluate(() => !!worldTest.wreck());
await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
assert.equal(calm, false, 'no explosion with the option off');

const ev = await page.evaluate(() => worldEvidence.errors.slice());
await ctx.close();
assert.deepEqual([...errors, ...ev], [], 'no console/page errors');
console.log(`HUD smoke ok -> ${out}`);
