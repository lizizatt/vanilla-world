// God-ray prototype capture: yaw sweep screenshots + uncapped frame-time per tier at a low-sun pose.
// Needs WOW_DATA (+ SWE1R_DATA), a server on PORT; run via: node heavy-lock.mjs --label lighting -- node lighting-shots.mjs
// Output (git-ignored): test-results/lighting/*.png and summary.json. Env: TIME (sim minutes, default 800), YAWS (comma list).
import fs from 'node:fs';
import { openLab, track } from './race-gate-lab.mjs';

process.env.LAB_UNCAPPED ??= '1';
process.env.LAB_NO_RESTORE ??= '1';
const dir = 'test-results/lighting';
fs.mkdirSync(dir, { recursive: true });
const TIME = Number(process.env.TIME || 800);
const yaws = (process.env.YAWS || '0,1.571,3.142,4.712').split(',').map(Number);
const { page, errors } = await openLab({ clouds: true, width: 1280, height: 720 });
const START = [track.start.pos[0], track.start.pos[2]];
const base = { cloudQuality: 'standard', weather: false, music: false, sound: false, shadows: false, clouds: true, night: false };
const info = await page.evaluate(async () => { const a = await navigator.gpu.requestAdapter(); return { ...(a.info || {}) }; });
const frames = (ms) => page.evaluate((ms) => new Promise(res => { const t = []; let last = performance.now(), end = last + ms;
  const tick = n => { t.push(n - last); last = n; n < end ? requestAnimationFrame(tick) : res(t); }; requestAnimationFrame(tick); }), ms);
const mean = v => +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2);
const out = { adapter: info, time: TIME, shots: [], perf: {} };
await page.evaluate(() => worldTest.timeLock(0));
await page.evaluate(t => worldTest.timeLock(t), TIME);
for (const yaw of yaws) {
  await page.evaluate(([s, p]) => { worldTest.settings(s); worldTest.focus(p); }, [{ ...base, godrays: 'off' }, [START[0], 160, START[1], yaw, .12]]);
  await page.waitForTimeout(Number(process.env.SETTLE || 9000));
  for (const tier of ['off', 'low', 'high']) {
    await page.evaluate(g => worldTest.settings({ godrays: g }), tier);
    await page.waitForTimeout(1500);
    const file = `${dir}/yaw${yaw.toFixed(2)}-${tier}.png`;
    await page.screenshot({ path: file });
    const t = await frames(5000);
    out.perf[`yaw${yaw.toFixed(2)}-${tier}`] = { frames: t.length, meanMs: mean(t) };
    out.shots.push(file);
  }
}
out.errors = errors;
fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);
