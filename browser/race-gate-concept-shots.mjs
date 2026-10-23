// Renders the procedural race-gate concept mock-ups (race-gate-concepts.js) at the Steamwheedle start in muted Edge.
// Needs WOW_DATA and a server on PORT (default 4183). Shots go to the git-ignored runtime/gate-concepts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { conceptMesh } from './race-gate-concepts.js';

const { WOW_DATA } = process.env;
if (!WOW_DATA) { console.log('WOW_DATA required, skipping'); process.exit(0); }
const out = path.resolve('..', 'runtime', 'gate-concepts');
fs.mkdirSync(out, { recursive: true });
const track = JSON.parse(fs.readFileSync('tracks/steamwheedle.json', 'utf8'));
const { pos, yaw } = track.start, fwd = [-Math.sin(yaw), -Math.cos(yaw)];
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-gates-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 4183}/?test`);
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
await page.keyboard.press('Escape'); await page.locator('[data-tab=options]').click(); await page.keyboard.press('Escape');
await page.locator('#world').click();
await page.evaluate(([p, y]) => { worldTest.settings({ shadows: false, clouds: false, night: false, music: false });
  worldTest.selectVehicle({ vehicle: 'podracer', skin: 'rocket' }); worldTest.restore({ pos: p, yaw: y }); }, [pos, yaw]).catch(() => {});
const gate = [pos[0] + fwd[0] * 40, pos[1], pos[2] + fwd[1] * 40];
const shots = [['near', 30, 5, 0.12], ['far', 170, 22, -0.02]];
for (const id of ['A', 'B', 'C', 'D']) {
  await page.evaluate(([v, g]) => worldTest.mockGates([{ vertices: new Float32Array(v), pos: [g[0], g[2]] }]),
    [[...conceptMesh(id, { width: 34, yaw, y: gate[1] })], gate]);
  for (const [name, d, h, pitch] of shots) {
    const cam = [gate[0] - fwd[0] * d, gate[1] + h, gate[2] - fwd[1] * d, yaw, pitch];
    await page.evaluate(c => worldTest.focus(c), cam);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(out, `${id}-${name}.png`) });
  }
}
console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'ok', out);
await ctx.close();
