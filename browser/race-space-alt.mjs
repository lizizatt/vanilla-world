// Planet-view altitude series over the Steamwheedle spawn (muted Edge). Usage: node race-space-alt.mjs <tag> [planet:0|1]
import path from 'node:path';
import { openLab, out } from './race-gate-lab.mjs';
const tag = process.argv[2] || 'now', planet = process.argv[3] !== '0';
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => window.worldTest?.manifest && worldTest.manifest(), null, { timeout: 90000 });
const spawn = await page.evaluate(() => worldTest.manifest().spawn);
const shots = [[500, -.12, 0], [2000, -.2, 0], [5000, -.3, 0], [20000, -.45, 0], [100000, -1.35, 0], [500000, -1.45, 0], ...(process.argv[4] ? [[250000, .1, 0], [250000, .1, 1.57], [250000, .1, 3.14], [250000, .1, 4.71]] : [])];
for (const [alt, pitch, yaw] of shots) {
  await page.evaluate(([p, x, z, a, pitch, yaw]) => { worldTest.settings({ planet: p }); worldTest.timeLock(1440); worldTest.focus([x, a, z, yaw, pitch]); }, [planet, spawn[0], spawn[2], alt, pitch, yaw]);
  await page.waitForTimeout(alt > 10000 ? 6000 : 9000);
  await page.screenshot({ path: path.join(out, `space-${tag}-${alt}-${yaw}.png`) });
}
await ctx.close();
