// Before/after zoomed HUD edge comparison at 1x and 2x DPR. "Before" is hud.js from BASE (default origin/main) drawn the old way
// (backing = CSS size, nearest-neighbour); "after" is the working tree at DPR backing. Needs SWE1R_DATA; runs its own static server on a free port.
// Output goes to ../runtime/hud-edge-shots (git-ignored; Racer art, never commit).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const lev = ['lev01', 'LEV01'].map(d => path.join(process.env.SWE1R_DATA || '', d)).find(d => fs.existsSync(d));
if (!lev) { console.log('SWE1R_DATA not set, skipping'); process.exit(0); }
const root = path.resolve(import.meta.dirname), out = path.resolve(root, '..', 'runtime', 'hud-edge-shots');
fs.mkdirSync(out, { recursive: true });
const oldSrc = execSync(`git show ${process.env.BASE || 'origin/main'}:browser/swe1r/hud.js`, { cwd: root, maxBuffer: 1 << 24 }).toString();
const sprites = fs.readFileSync(path.join(lev, 'out_spriteblock.bin'));
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  if (u === '/favicon.ico') { res.statusCode = 204; return res.end(); }
  if (u === '/sprites.bin') return res.end(sprites);
  if (u === '/swe1r/hud-old.js') { res.setHeader('content-type', 'text/javascript'); return res.end(oldSrc); }
  if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end('<body style="margin:0">'); }
  const f = path.join(root, path.normalize(u));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });
const errors = [], W = 214, ZOOM = 6;
const cases = { dial: { heat: .55, speed: '355' }, 'dial-hot': { heat: 1, speed: '000' }, engines: { heat: .1, l: 1, r: 1 }, 'engines-damaged': { heat: .6, l: .45, r: .15 } };

async function render(dpr, mode) {
  const ctx = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 520, height: 260 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base);
  const r = await page.evaluate(async ([mode, dpr, W, cases]) => {
    const { loadHudSprites, createRealDial, createRealEngines } = await import(mode === 'old' ? '/swe1r/hud-old.js' : '/swe1r/hud.js');
    const data = new Uint8Array(await (await fetch('/sprites.bin')).arrayBuffer());
    const s = await loadHudSprites({ read: async () => data });
    document.body.style.background = 'linear-gradient(#78a9d6,#c9b58f)';
    const dh = Math.round(W * 59 / 71), eh = Math.round(W * 62 / 67), res = {};
    for (const [name, c] of Object.entries(cases)) {
      const dial = name.startsWith('dial'), h = dial ? dh : eh, k = mode === 'old' ? 1 : dpr, cv = document.createElement('canvas');
      cv.width = Math.round(W * k); cv.height = Math.round(h * k); cv.style.cssText = `display:block;width:${W}px;height:${h}px;margin:8px;${mode === 'old' ? 'image-rendering:pixelated' : ''}`;
      document.body.append(cv);
      const draw = dial ? createRealDial(s.real, cv) : createRealEngines(s.real, cv);
      dial ? draw(0, c.heat, c.speed, 0) : draw(c.heat, 0, c.l, c.r);
      cv.id = name;
    }
    return Object.keys(cases);
  }, [mode, dpr, W, cases]);
  const shots = {};
  for (const name of r) shots[name] = (await page.locator('#' + name).screenshot()).toString('base64');
  await ctx.close();
  return shots;
}

for (const dpr of [1, 2]) {
  const before = await render(dpr, 'old'), after = await render(dpr, 'new');
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }), page = await ctx.newPage();
  for (const name of Object.keys(cases)) {
    const dial = name.startsWith('dial');
    await page.setContent(`<body style="margin:0;background:#222;color:#fff;font:14px sans-serif"><div style="display:flex;gap:16px;padding:8px"><div>before ${dpr}x<br><img id=a style="image-rendering:pixelated"></div><div>after ${dpr}x<br><img id=b style="image-rendering:pixelated"></div></div>`);
    await page.evaluate(([a, b, z]) => new Promise(res => { let n = 0; for (const [id, src] of [['a', a], ['b', b]]) { const i = document.getElementById(id); i.onload = () => { i.style.width = i.naturalWidth * z + 'px'; if (++n === 2) res(); }; i.src = 'data:image/png;base64,' + src; } }), [before[name], after[name], ZOOM / dpr]);
    // Zoom is in device pixels so both sides show the same physical area per screen pixel.
    await page.screenshot({ path: path.join(out, `${name}-${dpr}x.png`), fullPage: true });
  }
  await ctx.close();
}
await browser.close(); server.close();
if (errors.length) { console.error(errors); process.exit(1); }
console.log('shots in', out);
