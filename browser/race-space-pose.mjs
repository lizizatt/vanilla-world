// Ad-hoc planet-view poses (muted Edge). Usage: node race-space-pose.mjs <tag> 'env SHOTS=<json [[name,alt,pitch,yaw,{settings}],...]>' [dx dz]
import path from 'node:path';
import { openLab, out } from './race-gate-lab.mjs';
const tag = process.argv[2] || 'pose', shots = JSON.parse(process.env.SHOTS || '[]'), [dx, dz] = [+process.argv[4] || 0, +process.argv[5] || 0];
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => window.worldTest?.manifest && worldTest.manifest(), null, { timeout: 90000 });
let spawn = await page.evaluate(() => worldTest.manifest().spawn);
if (process.env.MAEL) spawn = await page.evaluate(async () => { const c = (await import('./clouds.js')).maelstromCentre(worldTest.manifest()); return [c[0], 0, c[1]]; });
if (process.env.POSE) {
  const view = JSON.parse(decodeURIComponent((process.env.POSE.split('pose=')[1] ?? process.env.POSE)));
  await page.evaluate(v => { worldTest.settings({ planet: true, ...v.settings }); if (v.time !== undefined) worldTest.timeLock(v.time); if (v.flight) worldTest.focus(v.flight); }, view);
  await page.waitForTimeout(9000);
  await page.screenshot({ path: path.join(out, `pose-${tag}-link.png`) });
}
for (const [name, alt, pitch, yaw, settings = {}] of shots) {
  await page.evaluate(([s, x, z, a, p, y, t]) => { worldTest.settings({ planet: true, clouds: true, ...s }); worldTest.timeLock(t); worldTest.focus([x, a, z, y, p]); }, [settings, spawn[0] + dx, spawn[2] + dz, alt, pitch, yaw, +process.env.TIME || 1440]);
  await page.waitForTimeout(alt > 10000 ? 6000 : 9000);
  await page.screenshot({ path: path.join(out, `pose-${tag}-${name}.png`) });
}
await ctx.close();

