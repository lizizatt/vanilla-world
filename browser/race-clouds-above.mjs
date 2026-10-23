// On-demand: high-altitude look-down over the storm edge (the "harsh line" regression pose), High tier, timeLock, muted Edge.
// node race-clouds-above.mjs [tag] -> runtime/gate-preview/above-<tag>-<height>.png
import path from 'node:path';
import { openLab, out, camera } from './race-gate-lab.mjs';
const tag = process.argv[2] || 'now';
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
const [cx, cz] = await page.evaluate(() => worldTest.maelstrom());
for (const h of [9000, 16000, 30000]) {
  await page.evaluate(c => { worldTest.settings({ cloudQuality: 'high' }); worldTest.timeLock(1440); worldTest.focus(c); }, camera([cx, 0, cz], 0, 30000, h, -.44));
  await page.waitForTimeout(9000);
  await page.screenshot({ path: path.join(out, `above-${tag}-${h}.png`) });
}
await ctx.close();
