import assert from 'node:assert/strict';
// Long boosted drive (SOAK_MIN minutes, default 4) sampling memory counters; opt-in: needs WOW_DATA and Edge.
import {chromium} from 'playwright';
const minutes=Number(process.env.SOAK_MIN||4),every=Number(process.env.SOAK_EVERY||5000);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const ctx=await browser.newContext({viewport:{width:1100,height:700},serviceWorkers:'block'});
  const page=await ctx.newPage();
  page.on('pageerror',e=>console.log('PAGEERR',e.message));
  page.on('crash',()=>console.log('PAGE CRASH'));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))console.log('CONSOLE',m.type(),m.text().slice(0,200));});
  page.on('worker',w=>{console.log('WORKER up');w.on('close',()=>console.log('WORKER closed'));});
  await page.goto('http://127.0.0.1:4183/?test');
  await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  await page.waitForTimeout(1500);
  await page.evaluate(()=>document.getElementById('world').focus());
  await page.keyboard.down('Shift');await page.keyboard.down('Space');
  if(process.env.SOAK_TURN){const [k,ms]=process.env.SOAK_TURN.split(':');await page.keyboard.down(k);await page.waitForTimeout(Number(ms));await page.keyboard.up(k);}
  const start=Date.now();let n=0;const peak={heap:0,wasm:0,coast:0,errs:0};
  while(Date.now()-start<minutes*60000){
    await page.waitForTimeout(every);
    if(n++%6===5){await page.keyboard.up('Space');await page.waitForTimeout(300);await page.keyboard.down('Space');}
    const row=await page.evaluate(()=>{
      const s=worldEvidence.state||{},t=s.telemetry||[],r=worldEvidence.render||{};
      return {heapMB:+((performance.memory?.usedJSHeapSize||0)/1048576).toFixed(0),
        wasmMB:+((s.horizon?.wasmPeakBytes||0)/1048576).toFixed(0),
        pos:[Math.round(t[0]),Math.round(t[1]),Math.round(t[2])],spd:Math.round(t[5]),grounded:t[7],
        res:s.resident?.length,ev:s.evictions,loads:s.loads,
        sceneMB:+((s.scene?.bytes||0)/1048576).toFixed(0),scenePend:s.scene?.pending,
        terrMB:+((s.terrain?.bytes||0)/1048576).toFixed(0),waterMB:+((s.water?.bytes||0)/1048576).toFixed(0),
        dist:s.distant?.scene?+((s.distant.scene.bytes||0)/1048576).toFixed(0):null,
        gpuMesh:+((r.sceneGpuMeshBytes||0)/1048576).toFixed(0),gpuTerr:+((r.terrainGpuBytes||0)/1048576).toFixed(0),coast:+((r.coastalWaterGpuBytes||0)/1048576).toFixed(0),
        inst:r.sceneInstances,tiles:r.detailedTiles,horiz:r.horizonTiles,fps:Math.round(worldEvidence.fps||0),
        errs:(worldEvidence.errors||[]).length};});
    console.log(JSON.stringify(row));peak.heap=Math.max(peak.heap,row.heapMB);peak.wasm=Math.max(peak.wasm,row.wasmMB);peak.coast=Math.max(peak.coast,row.coast);peak.errs=Math.max(peak.errs,row.errs);
  }
  console.log('errors',JSON.stringify(await page.evaluate(()=>worldEvidence.errors)).slice(0,600));
  console.log('peak',JSON.stringify(peak));
  assert.ok(peak.heap<1500&&peak.wasm<1500&&peak.coast<300&&peak.errs===0,'soak memory/error ceiling exceeded: '+JSON.stringify(peak));
}finally{await browser.close();}
