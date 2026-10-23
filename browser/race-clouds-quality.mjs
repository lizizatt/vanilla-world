// On-demand Standard vs High cloud captures (clouds ON, timeLock, muted Edge) plus a rough frame-time comparison.
// node race-clouds-quality.mjs -> runtime/gate-preview/cq-<standard|high>-<scene>.png and a timing line per scene.
import path from 'node:path';
import { openLab, out, track, camera } from './race-gate-lab.mjs';
const { ctx, page } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.gateKit(), null, { timeout: 60000 });
const p = track.start.pos, y = track.start.yaw, f = [-Math.sin(y), -Math.cos(y)];
await page.evaluate(([at, y]) => import('/race-gate-preview.js').then(g => worldTest.props(g.gantry({ at, yaw: y }))), [[p[0] + f[0] * 40, p[1], p[2] + f[1] * 40], y]);
const scenes = {
  sky: [camera(p, y, 100, 2, .3), 1440],
  gate: [camera(p, y, 90, 2, .12), 1440],
  inside: [camera(p, y, 100, 1500, .05), 1440],
  above: [camera(p, y, 100, 2200, -.35), 1440],
  sunset: [camera(p, y, 90, 2, .12), 2000],
};
// Mean rAF interval over ~2 s: includes everything, so only the standard-vs-high difference is meaningful.
const frameMs = () => page.evaluate(() => new Promise(r => { let n = 0, t0; const tick = t => { t0 ??= t; if (++n === 120) r((t - t0) / 119); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
for (const quality of ['standard', 'high']) {
  await page.evaluate(q => worldTest.settings({ cloudQuality: q }), quality);
  for (const [name, [pose, time]] of Object.entries(scenes)) {
    await page.evaluate(([c, t]) => { worldTest.timeLock(t); worldTest.focus(c); }, [pose, time]);
    await page.waitForTimeout(quality === 'high' ? 6000 : 3500);
    await page.screenshot({ path: path.join(out, `cq-${quality}-${name}.png`) });
    console.log(quality, name, 'frame ms', (await frameMs()).toFixed(2));
  }
}
await ctx.close();
