// On-demand weather captures with real data (muted Edge): node race-weather.mjs [scene ...] -> runtime/gate-preview/weather-<scene>.png
// Scenes: distant, envelop, snow-dun-morogh, snow-winterspring, lightning, maelstrom. Needs WOW_DATA and a server on PORT (not 4173).
import path from 'node:path';
import { openLab, out, track, camera } from './race-gate-lab.mjs';
const want = process.argv.slice(2);
const { ctx, page, errors } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
await page.evaluate(() => worldTest.settings({ cloudQuality: 'high', weather: true, weatherQuality: 'high', music: false, sound: false }));
await page.evaluate(() => worldTest.weatherArea({ name: 'Elwynn Forest', cold: false }));
const START = [track.start.pos[0], track.start.pos[2]];
const face = a => Math.atan2(-Math.cos(a), -Math.sin(a));
const shot = async (name, wait = 3500) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(out, `weather-${name}.png`) }); console.log(name, JSON.stringify(await page.evaluate(() => worldTest.weather()))); };
page.on('console', m => { if (/error|warn/i.test(m.type())) console.log('console', m.text().slice(0, 300)); });
const find = (from, o) => page.evaluate(([f, o]) => worldTest.weatherFind(f, o), [from, o]);
const put = (pose) => page.evaluate(p => { worldTest.timeLock(720); worldTest.focus(p); }, pose);
// Cells drift with the cloud flow, so chase the nearest intense cell while the camera settles inside it.
const chase = async (x, z, yaw, y = 120, n = 8) => { for (let i = 0; i < n; i++) { await put([x, y, z, yaw, 0.02]); await page.waitForTimeout(1200); const c = await find([x, z], { min: .9, range: 2500 }); if (c) { x = c[0]; z = c[1]; } } return [x, z]; };
const scenes = {
  async spawn() {
    await page.evaluate(() => worldTest.weatherArea(undefined));
    await shot('spawn', 6000);
  },
  async distant() {
    await put([START[0], 250, START[1], 0, 0]);await page.waitForTimeout(1500);
    const cell = await find([START[0], START[1]], { min: .9, range: 40000, edge: 3000 });
    const [x, z, , a] = cell;
    await put([x - Math.cos(a) * 7000, 900, z - Math.sin(a) * 7000, face(a), -.03]);
    await shot('distant', 6000);
  },
  async envelop() {
    const cell = await find([START[0], START[1]], { min: .95, range: 40000 });
    const [x, z] = cell;
    await chase(x, z, 0); await shot('envelop', 600);
  },
  async 'snow-dun-morogh'() {
    await page.evaluate(() => worldTest.weatherArea({ name: 'Dun Morogh', cold: true }));
    const cell = await find([START[0], START[1]], { min: .95, range: 40000 });
    const [x, z] = cell; await chase(x, z, 0); await shot('snow-dun-morogh', 600);
  },
  async 'snow-winterspring'() {
    await page.evaluate(() => worldTest.weatherArea({ name: 'Winterspring', cold: true }));
    const cell = await find([START[0], START[1]], { min: .95, range: 40000 });
    const [x, z] = cell; await chase(x, z, 1.2); await shot('snow-winterspring', 600);
  },
  async lightning() {
    const cell = await find([START[0], START[1]], { min: .95, range: 40000 });
    const [x, z] = cell; await chase(x, z, 0, 120, 6);
    await page.evaluate(() => worldTest.strike(150, -2200, true)); await shot('lightning', 600);
    await page.evaluate(() => worldTest.strike(-60, -700, true)); await shot('lightning-near', 600);
    await page.evaluate(() => worldTest.strike(0, 0, false));
  },
  async maelstrom() {
    const [cx, cz] = await page.evaluate(() => worldTest.maelstrom());
    await put([START[0], 250, START[1], 0, 0]); await page.waitForTimeout(1500);
    await page.evaluate(p => worldTest.focus(p), camera([cx, 0, cz], 0, 7000, 500, .1));
    await shot('maelstrom', 9000);
    await page.evaluate(p => worldTest.focus(p), camera([cx, 0, cz], 0, 2600, 350, .1));
    await shot('maelstrom-wall', 6000);
    await page.evaluate(() => worldTest.timeLock(720));
    await page.evaluate(p => worldTest.focus(p), [cx, 120, cz, 0, .05]);
    await shot('maelstrom-eye', 6000);
  },};
for (const name of want.length ? want : Object.keys(scenes)) { if (!scenes[name]) { console.log('skip', name); continue; } await scenes[name](); }
console.log('errors', errors.length, errors.slice(0, 3));
await ctx.close();

