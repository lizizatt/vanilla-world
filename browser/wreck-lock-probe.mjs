// Wreck lock probe in Edge: while a wreck plays, held throttle/boost/hop/drift and right-mouse drive must not move the craft; afterwards the pod respawns repaired and cool.
// Triggers: Ctrl+Alt+K, and overheating to engine death (Durability on). Needs WOW_DATA and a server on PORT (default 4183).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const { WOW_DATA } = process.env;
if (!WOW_DATA) { console.log('WOW_DATA required, skipping'); process.exit(0); }
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-wreck-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1000, height: 600 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 4183}/?test`);
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click();
assert.equal(await page.locator('#durability').isChecked(), true, 'durability on by default');
await page.keyboard.press('Escape');
await page.locator('#world').click();
await page.evaluate(() => { worldTest.settings({ shadows: false, clouds: false, night: false, music: false }); worldTest.selectVehicle({ vehicle: 'podracer', skin: 'rocket' }); });
await page.waitForTimeout(1500);

const tel = () => page.evaluate(() => Array.from(worldEvidence.state.telemetry));
const wrecking = () => page.evaluate(() => !!worldTest.wreck());
const hold = async keys => { for (const k of keys) await page.keyboard.down(k); await page.mouse.down({ button: 'right' }); };
const release = async keys => { await page.mouse.up({ button: 'right' }); for (const k of keys.slice().reverse()) await page.keyboard.up(k); };
const keys = ['KeyW', 'ShiftLeft', 'KeyJ', 'KeyC'];

async function probe(name, trigger) {
  await page.evaluate(() => worldTest.restore([worldEvidence.state.telemetry[0], worldEvidence.state.telemetry[1] + 1, worldEvidence.state.telemetry[2], worldEvidence.state.telemetry[3]]));
  await page.waitForTimeout(1500);
  await hold(keys);
  await trigger();
  await page.waitForFunction(() => worldTest.wreck(), null, { timeout: 60000, polling: 50 });
  const at = await tel();
  let worst = 0, samples = 0;
  while (await wrecking()) {
    const p = await tel();
    worst = Math.max(worst, Math.hypot(p[0] - at[0], p[2] - at[2]));
    samples++;
    await page.waitForTimeout(100);
  }
  await release(keys);
  await page.waitForTimeout(800);
  const after = await tel();
  console.log(name, JSON.stringify({ samples, drift_yd: +worst.toFixed(3), respawn_dy: +(after[1] - at[1]).toFixed(2), heat: +after[6].toFixed(2), health: [after[15], after[16]] }));
  assert.ok(samples >= 5, `${name}: wreck lasted`);
  assert.ok(worst < 1, `${name}: craft frozen during the wreck (moved ${worst} yd)`);
  assert.ok(after[15] === 1 && after[16] === 1 && after[6] < .2, `${name}: respawn repairs and cools`);
}

await probe('ctrl+alt+k', async () => { await page.keyboard.press('Control+Alt+KeyK'); });
await probe('overheat->engine death', async () => { await page.waitForTimeout(100); });
await ctx.close();
if (errors.length) { console.error(errors); process.exit(1); }
console.log('wreck lock probe ok');
