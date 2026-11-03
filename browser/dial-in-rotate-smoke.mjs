// Live check of the Dial in rotation ring on a shipped track: hover/drag the ring, numeric field, Shift snap, undo/redo, Done, screenshot.
// Usage (muted Edge; PORT + WOW_DATA required): node dial-in-rotate-smoke.mjs [track-id]   (default steamwheedle)
import path from 'node:path';
import { openLab, out } from './race-gate-lab.mjs';
const { ctx, page, errors } = await openLab({ swe1r: false });
const id = process.argv[2] || 'steamwheedle';
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };
await page.waitForTimeout(20000);
await page.locator('#world').focus();
await page.keyboard.press('KeyT');
await page.waitForFunction(() => !document.getElementById('track-editor').hidden, null, { timeout: 20000 });
await page.locator('#te-track').selectOption(id);
await page.waitForTimeout(3000);
await page.keyboard.press('KeyD');
await page.waitForFunction(() => !document.getElementById('te-dial').hidden, null, { timeout: 20000 });
await page.waitForTimeout(4000);
const heading = () => page.evaluate(() => +document.getElementById('te-dial-heading').value);
const cursor = () => page.evaluate(() => document.getElementById('te-canvas').style.cursor);
const box = await page.locator('#te-canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
// Find the ring by hover cursor along a few rays well away from the axis arrows.
let hit;
for (const deg of [25, 155, 205, 335, 60, 120]) {
  for (let r = 70; r < 220 && !hit; r += 4) {
    const x = cx + r * Math.cos(deg * Math.PI / 180), y = cy + r * Math.sin(deg * Math.PI / 180);
    await page.mouse.move(x, y);
    if (await cursor() === 'grab') hit = [x, y, deg];
  }
  if (hit) break;
}
ok(hit, 'ring found by hover');
const h0 = await heading();
await page.screenshot({ path: path.join(out, 'dial-ring-before.png') });
await page.mouse.move(hit[0], hit[1]);
await page.mouse.down();
for (let i = 1; i <= 10; i++) { await page.mouse.move(hit[0] + i * 8, hit[1] + i * 3); await page.waitForTimeout(30); }
await page.screenshot({ path: path.join(out, 'dial-ring-drag.png') });
await page.mouse.up();
const h1 = await heading();
ok(h1 !== h0, `drag rotated ${h0} -> ${h1}`);
await page.keyboard.press('Control+KeyZ');
await page.waitForTimeout(200);
ok(await heading() === h0, 'undo restores heading');
await page.keyboard.press('Control+KeyY');
await page.waitForTimeout(200);
ok(await heading() === h1, 'redo reapplies heading');
await page.locator('#te-dial-heading').fill('90');
await page.locator('#te-dial-heading').press('Enter');
await page.locator('#te-dial-heading').blur();
ok(await heading() === 90, 'numeric field sets 90');
// Shift-drag snaps to 15 degree multiples
await page.mouse.move(hit[0], hit[1]);
await page.mouse.down();
await page.keyboard.down('Shift');
for (let i = 1; i <= 8; i++) { await page.mouse.move(hit[0] + i * 20, hit[1] + i * 6); await page.waitForTimeout(30); }
await page.mouse.up();
await page.keyboard.up('Shift');
const h2 = await heading();
ok(h2 % 15 === 0 && h2 !== 90, `shift snap -> ${h2}`);
await page.screenshot({ path: path.join(out, 'dial-ring.png') });
await page.locator('#te-dial-done').click();
await page.waitForTimeout(500);
const dirty = await page.evaluate(() => !document.getElementById('te-dirty').hidden);
ok(dirty, 'draft marked unsaved after Done');
console.log('final heading', h2, 'errors', JSON.stringify(errors));
ok(errors.length === 0, 'no page errors');
await ctx.close();
