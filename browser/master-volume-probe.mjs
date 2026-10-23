// Master volume probe in Edge: slider default 50%, v^2 gain on the shared output node, persisted across reload. Needs a server on PORT (default 4183); no game data.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-vol-')),
  { channel: 'msedge', headless: true, args: ['--mute-audio'], ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 1000, height: 600 }, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const url = `http://127.0.0.1:${process.env.PORT || 4183}/?test`;
await page.goto(url);
assert.equal(await page.locator('#master-volume').inputValue(), '50', 'default 50%');
await page.locator('#master-volume').evaluate(el => { el.value = '80'; el.dispatchEvent(new Event('input', { bubbles: true })); });
assert.equal(await page.evaluate(() => localStorage.getItem('racer.masterVolume')), '80');
await page.reload();
assert.equal(await page.locator('#master-volume').inputValue(), '80', 'restored after reload');
console.log('master volume probe ok');
await ctx.close();
