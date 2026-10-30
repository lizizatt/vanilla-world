// On-demand weather captures with real data (muted Edge): node race-weather.mjs [scene ...] -> runtime/gate-preview/weather-<scene>.png
// Scenes: distant, envelop, snow-dun-morogh, snow-winterspring, lightning, maelstrom. Needs WOW_DATA and a server on PORT (not 4173).
import path from 'node:path';
import { openLab, out, track } from './race-gate-lab.mjs';
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
const scenes = {
  async distant() {
    await put([START[0], 250, START[1], 0, 0]);await page.waitForTimeout(1500);
    const cell = await find([START[0], START[1]], { min: .9, range: 40000, edge: 3000 });
    const [x, z, , a] = cell;
    await put([x - Math.cos(a) * 9000, 250, z - Math.sin(a) * 9000, face(a), .05]);
    await shot('distant', 6000);
  },
  async envelop() {
    const cell = await find([START[0], START[1]], { min: .95, range: 40000 });
    const [x, z] = cell;
    await put([x, 120, z, 0, 0.02]); await shot('envelop', 9000);
  },
  async 'snow-dun-morogh'() {
    await page.evaluate(() => worldTest.weatherArea({ name: 'Dun Morogh', cold: true }));
    const cell = await find([START[0], START[1]], { min: .95, range: 40000 });
    const [x, z] = cell; await put([x, 120, z, 0, 0.02]); await shot('snow-dun-morogh', 9000);
  },
  async 'snow-winterspring'() {
    await page.evaluate(() => worldTest.weatherArea({ name: 'Winterspring', cold: true }));
    const cell = await find([START[0], START[1]], { min: .95, range: 40000 });
    const [x, z] = cell; await put([x, 120, z, 1.2, 0.02]); await shot('snow-winterspring', 9000);
  },
};
for (const name of want.length ? want : Object.keys(scenes)) { if (!scenes[name]) { console.log('skip', name); continue; } await scenes[name](); }
console.log('errors', errors.length, errors.slice(0, 3));
await ctx.close();
