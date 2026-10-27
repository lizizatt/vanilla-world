// Live Elune track-editor check: map-panel teleport to Elune, place gates, save, reload, confirm the track persists on Elune only.
// Usage (muted Edge; PORT + WOW_DATA required): node elune-track-editor.mjs
import path from 'node:path';
import { openLab, out } from './race-gate-lab.mjs';
const { ctx, page, errors } = await openLab({ swe1r: false });
const bodyId = () => page.evaluate(async () => (await import('./body-shaders.js')).activeBody().id);
async function toElune() {
  await page.waitForTimeout(20000);
  await page.keyboard.press('KeyM');
  await page.locator('.map-body[data-body=elune]').click();
  await page.waitForFunction(async () => (await import('./body-shaders.js')).activeBody().id === 'elune', null, { timeout: 120000 });
  await page.waitForTimeout(8000);
}
await toElune();
console.log('body', await bodyId());
await page.locator('#world').focus();
await page.keyboard.press('KeyT');
await page.waitForFunction(() => !document.getElementById('track-editor').hidden, null, { timeout: 20000 });
await page.waitForTimeout(3000);
const box = await page.locator('#te-canvas').boundingBox();
await page.keyboard.press('KeyG');
for (const [fx, fy] of [[.45, .5], [.55, .45], [.62, .55], [.5, .62]]) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(1500);
}
await page.locator('#te-name').fill('Elune check');
await page.screenshot({ path: path.join(out, 'elune-editor.png') });
await page.locator('#te-save').click();
await page.waitForTimeout(2500);
const status = () => page.evaluate(() => document.getElementById('te-status').textContent);
console.log('status', await status());
const names = () => page.evaluate(() => [...document.querySelectorAll('#te-track option')].map(o => o.textContent));
console.log('tracks on Elune', JSON.stringify(await names()));
await page.keyboard.press('Escape');
await page.reload();
await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
await page.locator('#files').setInputFiles(process.env.WOW_DATA);
await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
console.log('reloaded body', await bodyId());
await toElune();
await page.keyboard.press('KeyM');
await page.waitForTimeout(1500);
console.log('map pins on Elune', await page.evaluate(() => [...document.querySelectorAll('.map-track')].map(p => p.title)));
await page.keyboard.press('Escape');
await page.locator('#world').focus();
await page.keyboard.press('KeyT');
await page.waitForTimeout(2000);
console.log('editor tracks after reload', JSON.stringify(await names()));
console.log('errors', errors.slice(0, 5));
await ctx.close();
