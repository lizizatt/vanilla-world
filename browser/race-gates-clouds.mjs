// On-demand cloud captures (clouds ON, muted Edge): open sky, gate against clouds, inside/above the layer, sunset.
// node race-gates-clouds.mjs <tag> -> runtime/gate-preview/clouds-<tag>-<scene>.png
import path from 'node:path';
import { openLab, out, track, camera } from './race-gate-lab.mjs';
const tag = process.argv[2] || 'after';
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.gateKit(), null, { timeout: 60000 });
const p = track.start.pos, y = track.start.yaw, f = [-Math.sin(y), -Math.cos(y)];
// Hosted (procedural) gantry plus the overworld beacon, so props with no depth sit in front of the cloud layer.
await page.evaluate(([at, y, la]) => import('/race-gate-preview.js').then(g => worldTest.props([...g.gantry({ at, yaw: y }), ...g.beacon({ at: la, yaw: y })])), [[p[0] + f[0] * 40, p[1], p[2] + f[1] * 40], y, [p[0] + f[0] * 120, p[1], p[2] + f[1] * 120]]);
const shot = async (name, pose, time = 1440, wait = 3500) => {
  await page.evaluate(([c, t]) => { worldTest.timeLock(t); worldTest.focus(c); }, [pose, time]);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(out, `clouds-${tag}-${name}.png`) });
};
await shot('sky', camera(p, y, 100, 2, .3));
await shot('gate', camera(p, y, 90, 2, .12));
await shot('inside', camera(p, y, 100, 1500, .05));
await shot('above', camera(p, y, 100, 2200, -.35));
await shot('sunward', [p[0], p[1] + 2200, p[2], Math.PI / 2, .08], 1900);
await shot('sunset', camera(p, y, 90, 2, .12), 2000);
await ctx.close();
