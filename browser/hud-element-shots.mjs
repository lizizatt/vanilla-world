// Isolated own-art bottom HUD snapshots (engine panels / speed dial) on a reference-like backdrop. Needs the server on PORT (default 4183).
// Shots go to the git-ignored runtime/hud-element-shots. No game data needed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const URL = `http://127.0.0.1:${process.env.PORT || 4183}/?test`, out = path.resolve('..', 'runtime', 'hud-element-shots');
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-hudel-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 596, height: 335 }, serviceWorkers: 'block', bypassCSP: true });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.ownHudTest);
await page.addStyleTag({ content: '#welcome,.interface,#menu-hint{display:none!important} #world{background:linear-gradient(#78a9d6,#c9b58f 55%,#9b8466)!important}' });
await page.evaluate(() => { const m = document.querySelector('.meters'); m.hidden = false; m.dataset.sprites = 'false'; m.dataset.held = 'false'; });
const shot = async (name, heat, speed, hl = 1, hr = 1) => {
  await page.evaluate(([h, s, l, r]) => { window.ownHudTest(h, l, r); document.getElementById('speed').textContent = String(s).padStart(3, '0'); document.getElementById('direction').textContent = 'FWD'; }, [heat, speed, hl, hr]);
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
for (const [name, heat] of [['green', 0.1], ['yellow', 0.6], ['red', 0.9], ['overheat', 1]]) await shot(`panel-${name}`, heat, 355);
for (const [name, l, r] of [['damaged', .45, 1], ['critical', .15, .6]]) await shot(`panel-${name}`, 0, 120, l, r);
for (const [speed, heat] of [[0, 0], [120, 0.25], [355, 0.55], [355, 0.85], [355, 1]]) await shot(`dial-s${speed}-h${Math.round(heat * 100)}`, heat, speed);
await ctx.close();
if (errors.length) { console.error(errors); process.exit(1); }
console.log('hud element shots ->', out);