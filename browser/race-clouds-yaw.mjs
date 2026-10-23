import path from 'node:path';
import { openLab, out, camera } from './race-gate-lab.mjs';
const tag = process.argv[2] || 'now';
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
const [cx, cz] = await page.evaluate(() => worldTest.maelstrom());
let i = 0;
for (const yaw of [0, 1.57, 3.14, 4.71]) {
  await page.evaluate(c => { worldTest.settings({ cloudQuality: 'high' }); worldTest.timeLock(1440); worldTest.focus(c); }, camera([cx + 30000, 0, cz], yaw, 100, 6000, -.05));
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(out, `sheet-${tag}-yaw${i++}.png`) });
}
await ctx.close();
