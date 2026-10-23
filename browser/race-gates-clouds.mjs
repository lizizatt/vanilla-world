// On-demand: overworld label beacon (free-roam) against the sky (clouds) from a low, upward-looking camera. node race-gates-clouds.mjs <tag> -> runtime/gate-preview/clouds-<tag>.png
import path from 'node:path';
import { openLab, out, track, camera } from './race-gate-lab.mjs';
const tag = process.argv[2] || 'after';
const { ctx, page } = await openLab();
await page.waitForFunction(() => worldTest.gateKit(), null, { timeout: 60000 });
const f = [-Math.sin(track.start.yaw), -Math.cos(track.start.yaw)], at = track.start.pos.map((v, i) => i === 1 ? v : v + f[i === 0 ? 0 : 1] * 14);
for (const [n, d, h, pitch] of [['a', 60, 4, .9], ['b', 400, 150, .75]]) {
  await page.evaluate(c => worldTest.focus(c), camera(track.start.pos, track.start.yaw, d, h, pitch));
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(out, `clouds-${tag}-${n}.png`) });
}
await ctx.close();
