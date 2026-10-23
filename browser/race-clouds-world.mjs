// On-demand: far-horizon clouds and same-hour sky in two distant zones (Steamwheedle vs Ironforge airport), timeLock, muted Edge.
// node race-clouds-world.mjs -> runtime/gate-preview/world-{horizon,steamwheedle,ironforge,ironforge-near}.png
import fs from 'node:fs';
import path from 'node:path';
import { openLab, out, track, camera } from './race-gate-lab.mjs';
const ifTrack = JSON.parse(fs.readFileSync(new URL('./tracks/if-airport-track.json', import.meta.url), 'utf8'));
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
const shot = async (name, pose, time = 1440, wait = 9000) => {
  await page.evaluate(([c, t]) => { worldTest.settings({ cloudQuality: 'high' }); worldTest.timeLock(t); worldTest.focus(c); }, [pose, time]);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(out, `world-${name}.png`) });
  console.log(name, JSON.stringify(await page.evaluate(() => worldTest.sky())));
};
const s = track.start, i = ifTrack.start;
await shot('horizon', camera(s.pos, s.yaw, 100, 3500, .02), 1440, 12000);
await shot('steamwheedle', camera(s.pos, s.yaw, 100, 40, .25));
await shot('ironforge', camera(i.pos, i.yaw, 100, 40, .25), 1440, 15000);
await shot('ironforge-near', camera(i.pos, i.yaw, 100, 40, .25), 2000, 5000);
await ctx.close();
