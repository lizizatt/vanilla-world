import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { worldBounds,overview,moveFlight } from './flight.js';

if (!process.env.WORLD_PACK) throw new Error('Set WORLD_PACK to the private full-world export.');
const folder=path.resolve(process.env.WORLD_PACK);
const manifest=JSON.parse(await readFile(path.join(folder,'route.json'),'utf8'));
assert.equal(manifest.version,2);
const files=[path.join(folder,'route.json'),...[...manifest.tiles,...manifest.horizons].map(f=>path.join(folder,f.file))];
const output=new URL('./test-results/world/',import.meta.url);
await mkdir(output,{recursive:true});
const bounds=worldBounds(manifest);
assert(Math.abs(bounds[1][0]-bounds[0][2]-8192)<.001);
assert(moveFlight([0,0,0,0,0],new Set(['KeyW']),1)[2]<-1000);
assert.equal(overview(manifest).length,5);
const browser=await chromium.launch({channel:'msedge',headless:process.env.HEADED!=='1'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const state=()=>page.evaluate(()=>structuredClone(window.racerEvidence));
const ready=()=>page.waitForFunction(()=>window.racerEvidence?.ready && window.racerEvidence.source==='route' && window.racerEvidence.flight,null,{timeout:90000});
const evidence={browser:browser.version(),bounds,views:[]};
async function record(key,value) {
  return page.evaluate(({key,value})=>new Promise((resolve,reject)=>{
    const open=indexedDB.open('vanilla-world-voyage',1);
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result,tx=db.transaction('meta',value===undefined?'readonly':'readwrite');
      const request=value===undefined ? tx.objectStore('meta').get(key) : tx.objectStore('meta').put(value,key);
      tx.oncomplete=()=>{db.close();resolve(request.result);};tx.onerror=()=>{db.close();reject(tx.error);};
    };
  }),{key,value});
}
async function pixels(name) {
  const bytes=await page.locator('#world').screenshot({path:fileURLToPath(new URL(`${name}.png`,output))});
  return page.evaluate(async encoded=>{
    const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
    const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const {data}=ctx.getImageData(0,0,image.width,image.height);
    let left=0,right=0;
    for(let y=0;y<image.height;y++) for(let x=0;x<image.width;x++) {
      const i=(y*image.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
      if(g>r*1.08 && g>b*1.1 && r>30) { if(x<image.width/2) left++;else right++; }
    }
    return {left,right,total:left+right};
  },bytes.toString('base64'));
}
async function capture(name,minimum=100) {
  await page.waitForTimeout(200);
  const s=await state(),p=await pixels(name);
  assert(p.total>minimum,`${name}: no authored distant land pixels ${JSON.stringify(p)}`);
  assert.deepEqual(s.errors,[]);
  assert(s.route.resident.length<=3);
  evidence.views.push({name,pixels:p,flight:s.flight,draw:s.horizonDraw});
  return p;
}
async function keyUntil(key,predicate,arg,timeout=15000) {
  await page.locator('#world').focus();await page.keyboard.down(key);
  try { await page.waitForFunction(predicate,arg,{timeout}); }
  finally { await page.keyboard.up(key); }
}
async function saveReload(name) {
  const before=(await state()).flight;
  await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Saved free-flight'));
  await context.setOffline(true);await page.reload();await ready();
  const after=(await state()).flight;
  before.forEach((n,i)=>assert(Math.abs(n-after[i])<.001,`${name}: camera save drift`));
  await context.setOffline(false);
}
try {
  await page.goto('http://127.0.0.1:4173');
  await page.waitForFunction(()=>window.racerEvidence?.ready);
  const legacy=structuredClone(manifest);
  legacy.version=1;delete legacy.horizons;
  legacy.regions[1].placement[0]=2*1600/3+512;
  legacy.ocean=[2*1600/3,0,2*1600/3+512,1600/3];
  legacy.destination[0]=legacy.regions[1].placement[0]+1600/3+96;
  const legacyFolder=new URL('./legacy/',output);await mkdir(legacyFolder,{recursive:true});
  await writeFile(new URL('route.json',legacyFolder),JSON.stringify(legacy));
  const legacyFiles=[fileURLToPath(new URL('route.json',legacyFolder)),...manifest.tiles.map(t=>path.join(folder,t.file))];
  await page.locator('#pack').setInputFiles(legacyFiles);
  await page.waitForFunction(()=>window.racerEvidence.ready && window.racerEvidence.source==='route');
  await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Saved route v2'));
  const drivingSave=await record('save');
  await page.locator('#pack').setInputFiles(files);await ready();
  const initial=await state();
  evidence.horizon=initial.route.horizon;evidence.adapter=initial.adapter;
  assert.deepEqual(initial.route.horizon.regions.map(r=>r.patches),[1018,687],'Both entire authored maps must be meshed');
  assert.equal(initial.route.horizon.vertices,1705*545);
  initial.route.horizon.regions.forEach((r,i)=>{
    assert.deepEqual(r.sourceBounds,manifest.horizons[i].source_bounds);
    r.globalBounds.forEach((n,j)=>assert(Math.abs(n-bounds[i][j])<.001,'Source placement drift'));
  });
  assert.equal(initial.horizonDraw.patches,1705-initial.route.resident.length,'Only detailed replacement tiles may be hidden');
  const both=await capture('both-continents-overview',1000);
  assert(both.left>500 && both.right>500,'Both continent silhouettes must be visible together');
  await page.locator('#horizon').uncheck();await page.waitForTimeout(100);
  const hidden=await pixels('overview-without-wdl');
  assert(both.total-hidden.total>1000,'Overview terrain must originate from WDL, not ADTs or ocean');
  await page.locator('#horizon').check();
  await saveReload('overview');
  const start=await state(),time=performance.now();await page.waitForTimeout(3000);const end=await state();
  evidence.overviewFps=(end.frames-start.frames)/((performance.now()-time)/1000);
  assert(evidence.overviewFps>15,'Full-world overview too slow on this host');
  await page.locator('#fly').click();
  await keyUntil('KeyE',()=>window.racerEvidence.flight[1]>900);
  await capture('kalimdor-facing-east');
  await page.keyboard.down('ShiftLeft');
  await keyUntil('KeyW',x=>window.racerEvidence.flight[0]>x,(manifest.ocean[0]+manifest.ocean[2])/2);
  await page.keyboard.up('ShiftLeft');
  await capture('mid-ocean-facing-east');await saveReload('mid-ocean');
  await keyUntil('ArrowLeft',()=>window.racerEvidence.flight[3]>Math.PI/2);
  await capture('mid-ocean-facing-west');
  await keyUntil('ArrowRight',()=>window.racerEvidence.flight[3]<-Math.PI/2);
  await page.keyboard.down('ShiftLeft');
  await keyUntil('KeyW',x=>window.racerEvidence.flight[0]>x,manifest.destination[0]);
  await page.keyboard.up('ShiftLeft');
  await keyUntil('ArrowLeft',()=>window.racerEvidence.flight[3]>Math.PI/2);
  await capture('eastern-kingdoms-facing-west');await saveReload('eastern-kingdoms');
  await page.waitForFunction(()=>window.racerEvidence.route.resident.some(i=>i>=2));
  const eastDetail=await state();
  assert.equal(eastDetail.horizonDraw.patches,1705-eastDetail.route.resident.length,'Near ADT replaces, not overlaps, its WDL tile');
  await page.keyboard.down('ShiftLeft');
  await keyUntil('KeyW',x=>window.racerEvidence.flight[0]<x,manifest.spawn[0]+300);
  await page.keyboard.up('ShiftLeft');
  await capture('returned-kalimdor-free-flight');
  const support=await page.evaluate(()=>window.routeProbe([[500,2000]]));
  assert.equal(support[0][0],2,'Visible non-corridor WDL must not create collision');
  await page.locator('#drive').click();
  await page.waitForFunction(()=>!window.racerEvidence.flight);
  await page.waitForFunction(()=>window.racerEvidence.route.resident.includes(0));
  const parked=await state();
  assert(Math.abs(parked.telemetry[0]-manifest.spawn[0])<.001,'Free flight must not move racer');
  assert.equal(parked.horizonDraw.patches,1705-parked.route.resident.length);
  evidence.driving=parked;
  await page.locator('#overview').click();
  await capture('final-overview',1000);
  assert.deepEqual(await record('save'),drivingSave,'Full-world camera saves must preserve legacy driving record');
  const viewSave=await record('view');
  await record('view',{...viewSave,version:999});
  await page.locator('#load').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Free-flight save incompatible'));
  assert.equal((await record('view')).version,999);
  await page.locator('#overview').click();await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Saved free-flight'));
  assert.equal((await record('view')).version,1);
  const malformed=structuredClone(manifest),bad=Buffer.from('invalid WDL');
  malformed.horizons[0].bytes=bad.length;
  malformed.horizons[0].sha256=createHash('sha256').update(bad).digest('hex');
  const badFolder=new URL('./invalid/',output);await mkdir(badFolder,{recursive:true});
  await writeFile(new URL('route.json',badFolder),JSON.stringify(malformed));
  await writeFile(new URL(malformed.horizons[0].file,badFolder),bad);
  const packId=(await record('pack')).id;
  await page.locator('#pack').setInputFiles([
    fileURLToPath(new URL('route.json',badFolder)),...manifest.tiles.map(t=>path.join(folder,t.file)),
    fileURLToPath(new URL(malformed.horizons[0].file,badFolder)),path.join(folder,manifest.horizons[1].file),
  ]);
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('WDL:'));
  assert.equal((await record('pack')).id,packId);
  await page.locator('#pack').setInputFiles(legacyFiles);
  await page.waitForFunction(()=>window.racerEvidence.ready && !window.racerEvidence.flight);
  await page.locator('#load').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Loaded local save.');
  const restored=(await state()).telemetry;
  for(const i of [0,2,3]) assert(Math.abs(restored[i]-drivingSave.vehicle.pose[i])<.001);
  evidence.compatibility='Legacy pack + driving pose restored unchanged; invalid WDL and v999 camera retained until explicit recovery';
  assert.deepEqual(errors,[]);
  await writeFile(new URL('evidence.json',output),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({browser:evidence.browser,horizon:evidence.horizon,overviewFps:evidence.overviewFps,views:evidence.views},null,2));
} catch(error) {
  console.error(error);console.error(await state().catch(()=>null));
  await page.screenshot({path:fileURLToPath(new URL('failure.png',output))}).catch(()=>{});
  process.exitCode=1;
} finally {await browser.close();}
