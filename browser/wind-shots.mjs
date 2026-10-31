// On-demand wind captures with real data (muted Edge): node wind-shots.mjs [scene ...] -> runtime/gate-preview/wind-[tag-]<scene>.png
// Scenes: spray, beach, desert, snow (WIND_TAG=before|after prefixes the file). Needs WOW_DATA and a server on PORT (not 4173).
import path from 'node:path';
import { openLab, out, track, camera } from './race-gate-lab.mjs';
const want = process.argv.slice(2);
const { ctx, page, errors } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.windMael && worldTest.wind, null, { timeout: 60000 });
await page.evaluate(() => worldTest.settings({ cloudQuality: 'high', weather: true, weatherQuality: 'high', music: false, sound: false }));
page.on('console', m => { if (/error|warn/i.test(m.type())) console.log('console', m.text().slice(0, 300)); });
const START = [track.start.pos[0], track.start.pos[2]];
let pose;
const hold = async ms => { for (let t = 0; t < ms; t += 1000) { if (pose) await page.evaluate(p => worldTest.focus(p), pose); await page.waitForTimeout(1000); } };
const shot = async (name, wait = 4000) => { await hold(wait); await page.screenshot({ path: path.join(out, `wind-${process.env.WIND_TAG ? process.env.WIND_TAG + '-' : ''}${name}.png`) }); console.log(name, JSON.stringify(await page.evaluate(() => worldTest.wind()))); };
// Lower the camera to h yd above the terrain the wind lattice knows under it (eye-height view, where the 1-2 ft layer is judged).
const lower = async (yaw, pitch, h) => { await page.evaluate(p => worldTest.focus(p), pose); await page.waitForTimeout(4000); const g = await page.evaluate(() => { const r = worldTest.renderer(), e = r.view.eye; return r.windGrid && r.windGrid.known ? r.windGrid.sample(e[0], e[2]) : null; }); if (g !== null) pose = [START[0], g + h, START[1], yaw, pitch]; console.log('ground', g); };
const scenes = {
  async spray() {
    let c; for (let i = 0; i < 60 && !c; i++) { c = await page.evaluate(() => worldTest.windMael()); if (!c) await page.waitForTimeout(1000); }
    const [cx, cz] = c;
    await page.evaluate(p => worldTest.focus(p), [START[0], 250, START[1], 0, 0]); await page.waitForTimeout(1500);
    await page.evaluate(() => { worldTest.weatherArea({ name: 'The Maelstrom', cold: false }); worldTest.windStorm(1); worldTest.timeLock(1080); });
    pose = camera([cx, 0, cz], 0, 5200, 5, -.02); await page.evaluate(p => worldTest.focus(p), pose);
    await shot('spray', 9000);
  },
  async beach() {
    await page.evaluate(() => { worldTest.weatherArea({ name: 'Tanaris', cold: false }); worldTest.windStorm(.9); worldTest.timeLock(1080); });
    pose = [START[0], -52, START[1], 0, -.05]; await page.evaluate(p => worldTest.focus(p), pose);
    await lower(0, -.03, 2);
    await shot('beach', 6000);
  },
  async desert() {
    await page.evaluate(() => { worldTest.weatherArea({ name: 'Tanaris', cold: false }); worldTest.windStorm(.9); worldTest.timeLock(1080); });
    pose = [START[0], -50, START[1], 2.2, .02]; await page.evaluate(p => worldTest.focus(p), pose);
    await lower(2.2, .0, 2);
    await shot('desert', 6000);
  },
  async snow() {
    await page.evaluate(() => { worldTest.weatherArea({ name: 'Winterspring', cold: true }); worldTest.windStorm(.9); worldTest.timeLock(1080); });
    pose = [START[0], -52, START[1], 0, -.05]; await page.evaluate(p => worldTest.focus(p), pose);
    await lower(0, -.03, 2);
    await shot('snow', 6000);
  },
};
for (const name of want.length ? want : Object.keys(scenes)) { if (!scenes[name]) { console.log('skip', name); continue; } await scenes[name](); }
console.log('errors', errors.length, errors.slice(0, 3));
await ctx.close();
