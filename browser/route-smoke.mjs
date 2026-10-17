import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (!process.env.ROUTE_PACK) throw new Error('Set ROUTE_PACK to the private exported corridor folder.');
const folder = path.resolve(process.env.ROUTE_PACK);
const json = await readFile(path.join(folder,'route.json'),'utf8');
const manifest = JSON.parse(json);
const files = [path.join(folder,'route.json'),...[...manifest.tiles,...manifest.horizons || []].map(t => path.join(folder,t.file))];
const output = new URL('./test-results/route/',import.meta.url);
await mkdir(output,{recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:process.env.HEADED !== '1'});
const context = await browser.newContext({viewport:{width:1280,height:900}});
const page = await context.newPage();
const errors = [];
page.on('pageerror',e => errors.push(e.message));
const evidence = {browser:browser.version(),coverage:manifest.label,waypoints:[],probes:[]};
const state = () => page.evaluate(() => structuredClone(window.racerEvidence));
const waitReady = () => page.waitForFunction(() => window.racerEvidence?.ready && window.racerEvidence.source === 'route',null,{timeout:45000});

async function dbRecord(store,key,value,database='vanilla-world-voyage') {
  return page.evaluate(({store,key,value,database}) => new Promise((resolve,reject) => {
    const open = indexedDB.open(database,1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store,value === undefined ? 'readonly' : 'readwrite');
      const request = value === undefined ? tx.objectStore(store).get(key) : tx.objectStore(store).put(value,key);
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }),{store,key,value,database});
}
async function pixels(name,kind) {
  const image = await page.locator('#world').screenshot({path:fileURLToPath(new URL(`${name}.png`,output))});
  const result = await page.evaluate(async encoded => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c => c.charCodeAt(0))],{type:'image/png'}));
    const canvas = new OffscreenCanvas(image.width,image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image,0,0);
    const {data} = ctx.getImageData(0,0,image.width,image.height);
    let ground=0,water=0,body=0;
    for (let y=image.height*.25|0;y<image.height*.75;y++) for (let x=image.width*.25|0;x<image.width*.75;x++) {
      const i=(y*image.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
      if (r>60 && r>b*1.2 && g>b*1.15) ground++;
      if (b>40 && b>g*1.1 && g>r*2) water++;
      if (g>100 && b>100 && g>b*1.03 && g>r*2) body++;
    }
    return {ground,water,body};
  },image.toString('base64'));
  assert(result.body>20,`No racer pixels: ${JSON.stringify(result)}`);
  if (kind) assert(result[kind]>1000,`No ${kind} pixels: ${JSON.stringify(result)}`);
  return result;
}
async function stop() {
  await page.keyboard.up('w'); await page.keyboard.up('s');
  await page.keyboard.down('Space');
  await page.waitForFunction(() => window.racerEvidence.telemetry[5]<.001,null,{timeout:10000});
  await page.keyboard.up('Space');
  await page.waitForTimeout(180);
}
async function drive(target,direction) {
  await page.locator('#world').focus();
  await page.keyboard.down(direction>0 ? 'w' : 's');
  await page.waitForFunction(({target,direction}) => {
    const s=window.racerEvidence;
    if (s.route.failures.length) throw new Error(s.route.failures.join(';'));
    return direction>0 ? s.telemetry[0]>=target : s.telemetry[0]<=target;
  },{target,direction},{timeout:90000});
  await stop();
}
async function checkpoint(name,region) {
  const before = await state();
  assert.equal(before.telemetry[10],region,`${name} region`);
  assert.equal(before.telemetry[8],0,`${name} must not be in a hold`);
  assert(before.route.peak<=3,'Resident cache exceeded cap');
  assert.deepEqual(before.route.failures,[]);
  assert.deepEqual(before.errors,[]);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Saved route v2'));
  const save = await dbRecord('meta','save');
  assert.equal(save.version,2);
  assert.equal(save.vehicle.type,'hovercraft');
  await context.setOffline(true);
  await page.reload(); await waitReady();
  const after = await state();
  for (const i of [0,2,3]) assert(Math.abs(after.telemetry[i]-save.vehicle.pose[i])<.001,`${name}: global pose drift`);
  assert(after.telemetry[5]<.01);
  assert.equal(after.telemetry[10],region);
  const screenshot = await pixels(name,region === -1 ? 'water' : undefined);
  await context.setOffline(false);
  evidence.waypoints.push({name,before:before.telemetry,restored:after.telemetry,save,screenshot,cache:before.route});
  return save;
}
async function boundaryProbe(x) {
  const p=(await state()).telemetry;
  const values = await page.evaluate(({x,z}) => window.routeProbe([[x-.01,z],[x+.01,z]]),{x,z:p[2]});
  for (const v of values) { assert.equal(v[0],0,'Boundary surface must be loaded/ready'); assert(Math.abs(v[2])<.001,'Ocean height seam'); assert.equal(v[3],0); }
  evidence.probes.push({x,values});
}
try {
  await page.goto('http://127.0.0.1:4173');
  await page.waitForFunction(() => window.racerEvidence?.ready);
  await page.locator('#world').focus(); await page.keyboard.down('w');
  await page.waitForFunction(() => window.racerEvidence.telemetry[2]<-5);
  await stop();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Saved locally:'));
  const legacySave=await dbRecord('save','current',undefined,'vanilla-world-racer');
  await page.locator('#pack').setInputFiles(files);
  await waitReady();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  evidence.startPixels = await pixels('departure','ground');
  await checkpoint('kalimdor-coast',0);
  await drive(manifest.ocean[0]-85,1);
  await checkpoint('kalimdor-before-boundary',0);
  await boundaryProbe(manifest.ocean[0]);
  await drive(manifest.ocean[0]+12,1);
  await checkpoint('ocean-after-kalimdor',-1);
  await drive((manifest.ocean[0]+manifest.ocean[2])/2-20,1);
  await checkpoint('mid-ocean',-1);
  await drive(manifest.ocean[2]-85,1);
  const oceanSave = await checkpoint('ocean-before-eastern-kingdoms',-1);
  await boundaryProbe(manifest.ocean[2]);
  await drive(manifest.ocean[2]+12,1);
  await checkpoint('eastern-kingdoms-after-boundary',1);
  await drive(manifest.destination[0]-23,1);
  const arrival = await state();
  assert.equal(arrival.telemetry[9],0,'Must reach actual Eastern Kingdoms land, not just water');
  evidence.arrival = arrival;
  await checkpoint('westfall-coast',1);

  // Same real input in reverse; no tile switch or teleport between continents.
  await drive(manifest.ocean[2]-20,-1);
  await checkpoint('reverse-ocean-from-westfall',-1);
  await drive(manifest.ocean[0]-20,-1);
  await checkpoint('reverse-kalimdor-entry',0);
  await drive(manifest.spawn[0]+8,-1);
  const returned = await state();
  assert.equal(returned.telemetry[9],0,'Reverse trip must reach Kalimdor land');
  evidence.returned = returned;
  await checkpoint('returned-kalimdor-coast',0);
  evidence.totalEvictions = evidence.waypoints.reduce((n,p) => n+p.cache.evictions,0);
  assert(evidence.totalEvictions>0,'Traversal must actually evict streamed tiles');

  // Reuse a genuinely visited save to prove a missing arrival tile cannot become safe ocean.
  await dbRecord('meta','save',oceanSave);
  await page.evaluate(file => new Promise((resolve,reject) => {
    const open=indexedDB.open('vanilla-world-voyage',1);
    open.onsuccess=() => { const db=open.result,tx=db.transaction('tiles','readwrite');tx.objectStore('tiles').delete(file);tx.oncomplete=() => {db.close();resolve();};tx.onerror=() => reject(tx.error); };
    open.onerror=() => reject(open.error);
  }),manifest.tiles.find(t => t.region===1).file);
  await context.setOffline(true);
  await page.reload(); await waitReady();
  await page.locator('#world').focus(); await page.keyboard.down('w');
  await page.waitForFunction(() => window.racerEvidence.telemetry[8]===1,null,{timeout:15000});
  await page.keyboard.up('w');
  const missing = await state();
  assert(missing.telemetry[0]<manifest.ocean[2],'Missing continent must stop entry');
  assert(missing.route.failures.some(s => s.includes('missing')));
  evidence.missingTileHold = missing;
  await context.setOffline(false);
  await page.locator('#pack').setInputFiles(files); await waitReady();

  // A far translated placement tests real GPU/worker floating-origin behavior with unchanged source ADTs.
  const shifted = structuredClone(manifest), shift=1e9;
  shifted.regions.forEach(r => r.placement[0]+=shift);
  shifted.ocean[0]+=shift; shifted.ocean[2]+=shift; shifted.spawn[0]+=shift; shifted.destination[0]+=shift;
  const shiftedFolder=new URL('./shifted/',output); await mkdir(shiftedFolder,{recursive:true});
  await writeFile(new URL('route.json',shiftedFolder),JSON.stringify(shifted));
  await page.locator('#pack').setInputFiles([fileURLToPath(new URL('route.json',shiftedFolder)),...files.slice(1)]);
  await page.waitForFunction(() => window.racerEvidence.telemetry[0]>1e9);
  await drive(shift+730,1);
  const far = await state();
  assert(far.telemetry[13]>=1,'Expected actual worker origin rebasing');
  assert(Math.abs(far.telemetry[0]-far.telemetry[11])<256);
  assert(Math.abs(far.telemetry[2]-manifest.spawn[2])<.05,'Source transform drift at large placement');
  evidence.floatingOrigin = {state:far,pixels:await pixels('billion-yard-origin','ground')};
  await checkpoint('far-origin-offline',0);

  // Unsupported save versions stay intact, expose an error and recover only by explicit reset/save.
  const valid=await dbRecord('meta','save');
  await dbRecord('meta','save',{...valid,version:999});
  await page.reload();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('incompatible or damaged'));
  assert.equal((await dbRecord('meta','save')).version,999);
  await page.locator('#reset').click(); await waitReady();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Saved route v2'));
  assert.equal((await dbRecord('meta','save')).version,2);
  const beforeInvalidPack=await dbRecord('meta','pack');
  const invalid=structuredClone(shifted),badBytes=Buffer.from('not an ADT');
  invalid.tiles[0].bytes=badBytes.length;
  invalid.tiles[0].sha256=createHash('sha256').update(badBytes).digest('hex');
  const invalidFolder=new URL('./invalid/',output); await mkdir(invalidFolder,{recursive:true});
  await writeFile(new URL('route.json',invalidFolder),JSON.stringify(invalid));
  await writeFile(new URL(invalid.tiles[0].file,invalidFolder),badBytes);
  await page.locator('#pack').setInputFiles([
    fileURLToPath(new URL('route.json',invalidFolder)),fileURLToPath(new URL(invalid.tiles[0].file,invalidFolder)),...files.slice(2),
  ]);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('ADT'));
  assert.equal((await dbRecord('meta','pack')).id,beforeInvalidPack.id,'Malformed tile must not replace the pack');
  await page.locator('#lab').click();
  await page.waitForFunction(pose => {
    const s=window.racerEvidence;
    return s.source==='synthetic' && [0,2,3].every(i => Math.abs(s.telemetry[i]-pose[i])<.001);
  },legacySave.pose);
  const legacyRestored=(await state()).telemetry;
  for (const i of [0,2,3]) assert(Math.abs(legacyRestored[i]-legacySave.pose[i])<.001,'Legacy parked pose must survive route saves');
  assert.deepEqual((await dbRecord('save','current',undefined,'vanilla-world-racer')).pose,legacySave.pose);
  assert.deepEqual(errors,[],'Uncaught browser errors');
  evidence.saveRecovery='v999 retained until explicit Reset + Save; original v1 lab save preserved';
  await writeFile(new URL('evidence.json',output),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({browser:evidence.browser,waypoints:evidence.waypoints.map(w => ({name:w.name,pose:w.save.vehicle.pose})),
    evictions:evidence.totalEvictions,missingTileHold:missing.telemetry,floatingOrigin:far.telemetry,saveRecovery:evidence.saveRecovery},null,2));
} catch (error) {
  console.error(error);
  console.error(await state().catch(() => null));
  console.error(await page.locator('body').innerText().catch(() => 'no page'));
  await writeFile(new URL('partial-evidence.json',output),JSON.stringify(evidence,null,2));
  await page.screenshot({path:fileURLToPath(new URL('failure.png',output))}).catch(() => {});
  process.exitCode=1;
} finally { await browser.close(); }
