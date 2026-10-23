// Isolated SWE1R-sprite bottom HUD snapshots (real engine panels + dial pieces) on a 596x335 backdrop. Needs the server on PORT (default 4183)
// and SWE1R_DATA. Shots go to the git-ignored runtime/hud-real-shots; never commit them (Racer art).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const lev = ['lev01', 'LEV01'].map(d => path.join(process.env.SWE1R_DATA || '', d)).find(d => fs.existsSync(d));
if (!lev) { console.log('SWE1R_DATA not set, skipping'); process.exit(0); }
const bytes = fs.readFileSync(path.join(lev, 'out_spriteblock.bin')).toString('base64');
const out = path.resolve('..', 'runtime', 'hud-real-shots');
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-hudreal-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 596, height: 335 }, serviceWorkers: 'block', bypassCSP: true });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 4183}/?test`);
await page.evaluate(async b64 => {
  const { loadHudSprites, createRealDial, createRealEngines } = await import('/swe1r/hud.js');
  const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const s = await loadHudSprites({ read: async () => data });
  if (!s?.real) throw new Error('real HUD sprites missing');
  const o = document.createElement('div'); o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:linear-gradient(#78a9d6,#c9b58f 55%,#9b8466)'; document.body.append(o);
  o.innerHTML = '<style>#e,#d{position:absolute;bottom:14px;max-width:none}#e{width:144px;height:144px;left:20px}#d{width:200px;height:130px;right:20px}</style><canvas id=e width=144 height=144></canvas><canvas id=d width=200 height=130></canvas>';
  const e = createRealEngines(s.real, document.getElementById('e')), d = createRealDial(s.real, document.getElementById('d'));
  window.draw = (heat, speed, l, r) => { e(heat, 0, l, r); d(speed / 400, heat, String(speed).padStart(3, '0')); };
}, bytes);
const shot = async (name, heat, speed, hl = 1, hr = 1) => { await page.evaluate(([h, s, l, r]) => window.draw(h, s, l, r), [heat, speed, hl, hr]); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
for (const [name, heat] of [['green', 0.1], ['yellow', 0.6], ['red', 0.9], ['overheat', 1]]) await shot(`panel-${name}`, heat, 355);
for (const [name, l, r] of [['damaged', .45, 1], ['critical', .15, .6]]) await shot(`panel-${name}`, 0, 120, l, r);
for (const [speed, heat] of [[0, 0], [120, 0.25], [355, 0.55], [355, 0.85], [355, 1]]) await shot(`dial-s${speed}-h${Math.round(heat * 100)}`, heat, speed);
await ctx.close();
if (errors.length) { console.error(errors); process.exit(1); }
console.log('shots in', out);
