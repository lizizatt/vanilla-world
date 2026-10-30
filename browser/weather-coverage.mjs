// Real-data rain coverage over space and time (muted Edge): node weather-coverage.mjs. Needs WOW_DATA and a server on PORT (not 4173).
// Samples the CPU precipitation field at random points around the race start (real land mask) at fixed cloud-time steps, wet climate everywhere.
import { openLab, track } from './race-gate-lab.mjs';
const { page, errors } = await openLab({ clouds: true });
await page.waitForFunction(() => worldTest.maelstrom, null, { timeout: 60000 });
await page.evaluate(() => worldTest.settings({ cloudQuality: 'high', weather: true, weatherQuality: 'high', music: false, sound: false }));
await page.waitForTimeout(2000);
const S = [track.start.pos[0], track.start.pos[2]];
const r = await page.evaluate(S => worldTest.weatherStats(S, { radius: 90000, n: 3000, T: 90, dt: 120 }), S);
const f = g => `soft(>=.1) ${(g.soft / g.n).toFixed(3)} rain(>=on) ${(g.rain / g.n).toFixed(3)} dense(cov>=.42) ${(g.dense / g.n).toFixed(3)} rainOfDense ${(g.denseRain / Math.max(g.dense, 1)).toFixed(3)} wetSpell ${(g.rain * 2 / Math.max(g.wetEp, 1)).toFixed(1)}min drySpell ${((g.n - g.rain) * 2 / Math.max(g.dryEp, 1)).toFixed(1)}min`;
console.log('land', f(r.land)); console.log('sea ', f(r.sea)); console.log('errors', errors.length);
process.exit(0);
