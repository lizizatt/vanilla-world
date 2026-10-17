import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = 'http://127.0.0.1:4173';
const caseName = process.env.ADT_FILE ? path.parse(process.env.ADT_FILE).name.replace(/[^A-Za-z0-9_-]/g, '_') : 'synthetic';
const output = new URL(`./test-results/${caseName}/`, import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: 'msedge',
  headless: process.env.HEADED !== '1',
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const state = () => page.evaluate(() => structuredClone(window.racerEvidence));
const waitTicks = async count => {
  const start = (await state()).ticks;
  await page.waitForFunction(target => window.racerEvidence.ticks >= target, start+count, { timeout: 30000 });
};
async function pixels(name) {
  const shot = await page.locator('#world').screenshot({ path: fileURLToPath(new URL(name, output)) });
  const colors = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    let terrain = 0, body = 0;
    // Ignore overlay text and HUD; measure the middle half of actual rendered pixels.
    for (let y = Math.floor(image.height*.25); y < image.height*.75; y++) {
      for (let x = Math.floor(image.width*.25); x < image.width*.75; x++) {
        const i = (y*image.width+x)*4;
        const [r,g,b] = data.slice(i,i+3);
        if (r > 60 && g > 60 && r > b*1.2 && g > b*1.15) terrain++;
        if (g > 100 && b > 100 && g > r*2 && b > r*2) body++;
      }
    }
    return { terrain, body };
  }, shot.toString('base64'));
  assert(colors.terrain > 1000, `Missing rendered terrain: ${JSON.stringify(colors)}`);
  assert(colors.body > 20, `Missing rendered racer: ${JSON.stringify(colors)}`);
  return colors;
}
async function drive() {
  await page.locator('#world').focus();
  const before = (await state()).telemetry;
  await page.keyboard.down('w');
  await waitTicks(180);
  const forward = (await state()).telemetry;
  assert(forward[5] > 5, 'Throttle must produce actual speed in Wasm');
  assert(Math.hypot(forward[0]-before[0],forward[2]-before[2]) > 2, 'Throttle must move the racer');
  await page.keyboard.down('a');
  await waitTicks(60);
  await page.keyboard.up('a');
  const turned = (await state()).telemetry;
  assert(Math.abs(turned[3]-forward[3]) > .15, 'Keyboard steering must change yaw');
  await page.keyboard.down('Shift');
  await waitTicks(45);
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  assert((await state()).telemetry[6] < 1, 'Boost must consume the shared physics reserve');
  await page.keyboard.down('Space');
  await waitTicks(240);
  await page.keyboard.up('Space');
  assert((await state()).telemetry[5] < 1, 'Brake must stop the racer');
  const stopped = (await state()).telemetry;
  await page.keyboard.down('j');
  await waitTicks(15);
  const airborne = (await state()).telemetry;
  assert(airborne[1] > stopped[1]+.3, 'Hop key must lift the racer');
  assert.equal(airborne[7], 0, 'Hop must be airborne');
  await waitTicks(180);
  await page.keyboard.up('j');
  assert.equal((await state()).telemetry[7], 1, 'Held hop must land without retriggering');
  return { before, forward, turned, stopped, airborne };
}
async function saveReload(offline = false) {
  assert.deepEqual((await state()).errors, [], 'No application errors before reload');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Saved locally:'));
  const saved = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('vanilla-world-racer', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('save').objectStore('save').get('current');
      request.onsuccess = () => { db.close(); resolve({ pose: request.result.pose, size: request.result.bytes.length }); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }));
  if (offline) await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.racerEvidence?.ready);
  const restored = (await state()).telemetry;
  assert(Math.abs(restored[0]-saved.pose[0]) < .001);
  assert(Math.abs(restored[1]-saved.pose[1]) < .02);
  assert(Math.abs(restored[2]-saved.pose[2]) < .001);
  assert(Math.abs(restored[3]-saved.pose[3]) < .001);
  assert(restored[5] < .01, 'Reload must park momentum');
  if (offline) await context.setOffline(false);
  return { saved, restored, offline };
}
try {
  assert.equal((await context.request.get(`${url}/package.json`)).status(), 404);
  assert.equal((await context.request.get(`${url}/runtime/browser/anything.adt`)).status(), 404);
  await page.goto(url);
  await page.waitForFunction(() => window.racerEvidence?.ready, null, { timeout: 30000 });
  const fixturePixels = await pixels('synthetic.png');
  const fixtureDrive = await drive();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const fixtureSave = await saveReload(true);
  const results = { browser: browser.version(), fixturePixels, fixtureDrive, fixtureSave };
  if (process.env.ADT_FILE) {
    const bytes = await readFile(process.env.ADT_FILE);
    results.importedFile = { name: path.basename(process.env.ADT_FILE), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await page.locator('#import').setInputFiles(path.resolve(process.env.ADT_FILE));
    await page.waitForFunction(() => window.racerEvidence.source === 'imported-adt', null, { timeout: 30000 });
    assert((await state()).terrainVertices > 100000);
    results.importedPixels = await pixels('imported.png');
    results.importedDrive = await drive();
    results.importedSave = await saveReload(true);
    assert.equal(results.importedSave.saved.size, bytes.length, 'Save must retain the entire imported ADT');
    assert.equal((await state()).source, 'imported-adt');
    results.importedReloadPixels = await pixels('imported-reloaded.png');
  } else {
    results.imported = 'NOT TESTED: set ADT_FILE to a privately extracted vanilla ADT';
  }
  const beforeBadImport = await state();
  await page.locator('#import').setInputFiles({ name: 'invalid.adt', mimeType: 'application/octet-stream', buffer: Buffer.from('not an ADT') });
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Error:'));
  assert.equal((await state()).source, beforeBadImport.source, 'Invalid import must preserve current world');
  assert.equal((await state()).terrainVertices, beforeBadImport.terrainVertices);
  await waitTicks(30);
  const final = await state();
  assert.equal(final.errors.length, 1, `Only the deliberate invalid import should fail: ${final.errors}`);
  assert.deepEqual(pageErrors, [], 'No uncaught browser errors');
  results.final = final;
  await writeFile(new URL('evidence.json', output), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('Browser failure:', error);
  console.error('Page:', await page.locator('body').innerText().catch(() => 'unavailable'));
  console.error('Telemetry:', await state().catch(() => 'unavailable'));
  console.error('Uncaught errors:', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
