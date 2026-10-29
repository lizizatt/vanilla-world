// Shared launcher for the race-gate preview scripts: muted Edge, WoW Data folder, optional SWE1R folder, Steamwheedle start pose.
// LAB_NO_RESTORE=1 leaves the craft at the world spawn (free-camera poses/audits need tiles resident near it, not at the track start).
// Needs WOW_DATA (+ SWE1R_DATA for the local-asset versions) and a server on PORT (default 4183).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

export const track = JSON.parse(fs.readFileSync(new URL('./tracks/steamwheedle.json', import.meta.url), 'utf8'));
export const out = path.resolve('..', 'runtime', 'gate-preview');
fs.mkdirSync(out, { recursive: true });

export async function openLab({ swe1r = true, width = 1280, height = 720, clouds = false } = {}) {
  const { WOW_DATA, SWE1R_DATA } = process.env;
  if (!WOW_DATA) throw new Error('WOW_DATA required');
  const ctx = await chromium.launchPersistentContext(process.env.LAB_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'edge-gatelab-')),
    { channel: process.env.LAB_CHANNEL || 'msedge', headless: !process.env.LAB_HEADED, args: ['--mute-audio', ...(process.env.LAB_UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width, height }, serviceWorkers: 'block' });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT || 4183}/?test`);
  await page.waitForFunction(() => !document.getElementById('select').disabled, null, { timeout: 60000 });
  if (swe1r && SWE1R_DATA) {
    await page.locator('#swe1r-files').setInputFiles(SWE1R_DATA);
    await page.waitForFunction(() => document.getElementById('swe1r-status').dataset.ok === '1', null, { timeout: 60000 });
  }
  await page.locator('#files').setInputFiles(WOW_DATA);
  await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, null, { timeout: 180000 });
  await page.keyboard.press('Escape');
  if (await page.locator('[data-tab=options]').isVisible()) { await page.locator('[data-tab=options]').click(); await page.keyboard.press('Escape'); }
  await page.evaluate(() => document.getElementById('welcome')?.remove());
  await page.locator('#world').click();
  await page.evaluate(([p, y, clouds, noRestore]) => { worldTest.settings({ shadows: false, clouds, night: false, music: false });
    worldTest.selectVehicle({ vehicle: 'podracer', skin: 'rocket' }); if (!noRestore) worldTest.restore([p[0], p[1] + 2, p[2], y]); }, [track.start.pos, track.start.yaw, clouds, !!process.env.LAB_NO_RESTORE]).catch(() => {});
  return { ctx, page, errors };
}

// Camera pose [x,y,z,yaw,pitch] `d` yd in front of (and `h` above) a point looking back along the craft heading.
export function camera(at, yaw, d, h, pitch = 0) {
  const f = [-Math.sin(yaw), -Math.cos(yaw)];
  return [at[0] + f[0] * d, at[1] + h, at[2] + f[1] * d, yaw + Math.PI, pitch];
}
