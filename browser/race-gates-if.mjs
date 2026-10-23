// On-demand: wired gates on the hilly Ironforge airport track. Starts the race, drives with W and snapshots every few seconds.
//   $env:WOW_DATA=...; $env:PORT=4183; node race-gates-if.mjs   -> runtime/gate-preview/if-*.png
import path from 'node:path';
import { openLab, out } from './race-gate-lab.mjs';

const { ctx, page, errors } = await openLab();
await page.waitForFunction(() => worldTest.gateKit(), null, { timeout: 60000 });
await page.evaluate(() => worldTest.startRace(worldTest.tracks().find(t => t.id.includes('airport'))));
const files = [];
const snap = async n => { const f = path.join(out, `if-${n}.png`); await page.screenshot({ path: f }); files.push(f); };
await page.waitForTimeout(5000); await snap('start');
await page.keyboard.down('KeyW');
for (let i = 1; i <= 8; i++) {
  await page.waitForTimeout(3500);
  const n = await page.evaluate(() => worldTest.raceInfo()?.next);
  await snap(`drive-${i}-gate${n}`);
}
await page.keyboard.up('KeyW');
console.log('page errors:', errors.filter(e => !/Invalid parked pose/.test(e)).join('; ') || 'none');
console.log(files.join('\n'));
await ctx.close();
