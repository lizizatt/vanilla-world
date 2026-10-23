// On-demand spot check of the SWE1R energy-binder beam (NOT part of plume-audit). Needs WOW_DATA + SWE1R_DATA and a server on PORT.
//   node browser/beam-shots.mjs [skinId ...]   (default: swe1r-255 swe1r-260)  -> runtime/beam-shots/<skin>-<state>.png
// States: idle, boost, overheat, damaged (one engine at 15%), dead. Pods with no beam (260, 268) still render, for comparison.
import fs from 'node:fs';
import path from 'node:path';
import { openLab, track } from './race-gate-lab.mjs';
import { viewPose } from './pod-render-lib.mjs';

const skins = process.argv.length > 2 ? process.argv.slice(2) : ['swe1r-255', 'swe1r-260'];
const out = path.resolve('..', 'runtime', 'beam-shots');
fs.mkdirSync(out, { recursive: true });
const STATES = { idle: { throttle: 0 }, boost: { throttle: 1, boosting: true, heat: 0.5 }, overheat: { throttle: 1, boosting: true, heat: 1 },
  damaged: { throttle: 0.5, health: [1, 0.15] }, dead: { health: [0, 1] } };
const { ctx, page, errors } = await openLab();
await page.evaluate(() => { const s = new CSSStyleSheet(); s.replaceSync('*{visibility:hidden!important}canvas{visibility:visible!important}'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; worldTest.showCraft(true); });
for (const skin of skins) {
  await page.evaluate(s => worldTest.selectVehicle({ vehicle: 'podracer', skin: s }), skin);
  await page.waitForFunction(() => worldEvidence.render?.craftStatus === 'ready', null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(([p, y]) => worldTest.restore([p[0], p[1], p[2], y]), [track.start.pos, track.start.yaw]);
  await page.waitForTimeout(1500);
  const car = await page.evaluate(() => worldEvidence.state.telemetry.slice(0, 4));
  await page.evaluate(p => worldTest.focus(p), viewPose(car, 'three-quarter', 9));
  for (const [name, fx] of Object.entries(STATES)) {
    await page.evaluate(o => worldTest.beamFx(o), fx);
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(out, `${skin}-${name}.png`) });
  }
}
await page.evaluate(() => worldTest.beamFx(undefined));
console.log(`shots in ${out}; page errors: ${errors.length ? errors.join('; ') : 'none'}`);
await ctx.close();
