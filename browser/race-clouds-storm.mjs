// On-demand storm-tower captures (clouds ON, timeLock, muted Edge): side view from distance and from above, Standard vs High,
// plus a later High frame to show the slow billow. node race-clouds-storm.mjs -> runtime/gate-preview/storm-<quality>-<scene>.png
import path from 'node:path';
import { openLab, out, camera } from './race-gate-lab.mjs';
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
const [cx, cz] = await page.evaluate(() => worldTest.maelstrom());
const at = [cx, 0, cz];
const scenes = {
  side: camera(at, 0, 13000, 900, .12),
  sideNear: camera(at, 2.2, 7500, 700, .2),
  above: camera(at, 0, 3500, 6500, -.9),
};
const frameMs = () => page.evaluate(() => new Promise(r => { let n = 0, t0; const tick = t => { t0 ??= t; if (++n === 120) r((t - t0) / 119); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
const shot = async (quality, name, pose, wait) => {
  await page.evaluate(([c, q]) => { worldTest.settings({ cloudQuality: q }); worldTest.timeLock(1440); worldTest.focus(c); }, [pose, quality]);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(out, `storm-${quality}-${name}.png`) });
  console.log(quality, name, 'frame ms', (await frameMs()).toFixed(2));
};
for (const quality of ['standard', 'high']) for (const [name, pose] of Object.entries(scenes)) await shot(quality, name, pose, quality === 'high' ? 7000 : 3500);
await page.waitForTimeout(25000);
await shot('high', 'side-later', scenes.side, 500);
await ctx.close();
