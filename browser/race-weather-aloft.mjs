// On-demand captures of rain seen from inside the cloud layer, above it and from orbit, plus a cloud-shader cost A/B (weather off / low / high).
// node race-weather-aloft.mjs [in-cloud|above|orbit|cost ...] -> runtime/gate-preview/aloft-<scene>.png. Needs WOW_DATA and a server on PORT (not 4173).
// Run it through heavy-lock.mjs. LAB_UNCAPPED=1 for meaningful cost numbers.
import path from 'node:path';
import { openLab, out } from './race-gate-lab.mjs';
const want = process.argv.slice(2);
const { ctx, page, errors } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
await page.evaluate(() => worldTest.settings({ cloudQuality: 'high', weather: true, weatherQuality: 'high', music: false, sound: false }));
await page.evaluate(() => worldTest.weatherArea({ name: 'Elwynn Forest', cold: false }));
const POSE = [-189.8158479474041, 1587.7071820711662, 13306.917954489765, -0.8049060565909739, -0.5064110510227503, -0.23049366367684282, -0.37918771111065946, -0.09811833570968197, 0.890764920136086];
const TIME = 1688.7266;
const put = (pose, frame) => page.evaluate(([p, f, t]) => {
  worldTest.timeLock(1440);
  const cc = worldTest.renderer().cloudClock; if (cc) { cc.time = t; cc.cycles = (t / cc.period) % 1; }
  worldTest.focus(p, f);
}, [pose, frame, TIME]);
const state = () => page.evaluate(() => { const r = worldTest.renderer(); return { fs: worldTest.flightState().flight?.slice(0, 3).map(Math.round), frame: worldTest.flightState().frame, eyeY: r.view&&Math.round(r.view.eye[1]), tier: r.weatherTier, look: r.weather.look, local: +r.weather.local.toFixed(2), anyWet: r.weather.anyWet, curtain: r.curtainDrawn, near: r.nearDrawn, fade: r.weatherFade }; });
const shot = async (name, wait = 4000) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(out, `aloft-${name}.png`) }); console.log(name, JSON.stringify(await state())); };
const at = (y, extra = {}) => [POSE[0], y, POSE[2], ...(extra.basis || POSE.slice(3))];
const ORBIT = [POSE[0], 30000, POSE[2] + 13500, 0, -1.15];
const put5 = pose => page.evaluate(p => { worldTest.timeLock(1440); worldTest.focus(p); }, pose);
const scenes = {
  async 'in-cloud'() { await page.waitForTimeout(8000); await put(POSE); await shot('in-cloud', 6000); },
  async 'below-base'() { await put(at(700)); await shot('below-base', 5000); },
  async above() { await put(at(4200)); await shot('above', 6000); },
  async orbit() {
    await put5(ORBIT); await shot('orbit', 5000);
    await page.evaluate(() => worldTest.settings({ weatherQuality: 'low' })); await shot('orbit-lowtier', 3000);
    await page.evaluate(() => worldTest.settings({ weatherQuality: 'high' }));
  },
  async cost() {
    const frames = () => page.evaluate(() => new Promise(res => { const d = []; let p = performance.now(); const f = t => { d.push(t - p); p = t; if (d.length < 240) requestAnimationFrame(f); else { d.sort((a, b) => a - b); res({ mean: d.reduce((a, b) => a + b) / d.length, p50: d[120], p99: d[237] }); } }; requestAnimationFrame(f); }));
    for (const [label, y] of [['in-cloud', POSE[1]], ['above', 4200], ['orbit', 120000]]) {
      if (label === 'orbit') await put5(ORBIT); else await put(at(y)); await page.waitForTimeout(3000);
      for (const q of ['off', 'low', 'high']) {
        await page.evaluate(q => worldTest.settings({ weatherQuality: q }), q); await page.waitForTimeout(2500);
        const r = await frames(); console.log('cost', label, q, JSON.stringify({ mean: +r.mean.toFixed(2), p50: +r.p50.toFixed(2), p99: +r.p99.toFixed(2) }));
      }
      await page.evaluate(() => worldTest.settings({ weatherQuality: 'high' }));
    }
  },
};
await page.waitForTimeout(8000);
for (const name of want.length ? want : Object.keys(scenes)) { if (!scenes[name]) { console.log('skip', name); continue; } await scenes[name](); }
console.log('errors', errors.length, errors.slice(0, 3));
await ctx.close();
