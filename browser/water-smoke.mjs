import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const label=process.env.LABEL||'water-shader';
assert(/^[\w-]+$/.test(label));
const out=new URL(`./test-results/${label}/`,import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const result={views:[],errors:[]},baseline=process.env.WATER_BASELINE==='1';
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',error=>result.errors.push(error.message));
  await page.goto(process.env.WORLD_URL||`http://127.0.0.1:${process.env.PORT||4183}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.evaluate(async()=>{
    const {WorldRenderer}=await import('./world-renderer.js');
    const draw=WorldRenderer.prototype.draw,event=WorldRenderer.prototype.event;
    window.waterProbe={models:new Map()};
    const point=(vertices,indices,first,stride)=>{
      const p=[0,0,0];
      for(let i=0;i<3;i++)for(let a=0;a<3;a++)
        p[a]+=vertices[(indices?indices[first+i]:first+i)*stride+a]/3;
      return p;
    };
    WorldRenderer.prototype.draw=function(...args){
      waterProbe.rig=this;
      return draw.apply(this,args);
    };
    WorldRenderer.prototype.event=function(data){
      const answer=event.call(this,data);
      if(data.event==='scene')for(const asset of data.assets||[]){
        const batch=asset.batches.find(b=>b.water);
        if(batch)waterProbe.models.set(asset.key.toLowerCase(),{
          point:point(asset.vertices,asset.indices,batch.firstIndex,12),indices:batch.indexCount});
      }
      return answer;
    };
  });
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  const supplied=process.env.WATER_POSES?JSON.parse(await readFile(process.env.WATER_POSES,'utf8')).views:null;
  for(const name of ['lake','coast','canal','ocean']){
    let pose=supplied?.find(v=>v.name===name)?.pose;
    if(!pose&&['lake','coast'].includes(name)){
      pose=await page.evaluate(name=>{
        const r=worldEvidence.info.manifest.regions.find(r=>r.map===(name==='lake'?'Azeroth':'Kalimdor'));
        const p=name==='lake'?[-9470,-160,95]:[-9800,-5000,250];
        return [-p[1]+r.placement[0]+(32-r.tile_origin[0])*1600/3,p[2],
          -p[0]+r.placement[1]+(32-r.tile_origin[1])*1600/3,name==='lake'?0:Math.PI/2,-.5];
      },name);
    }else if(!pose&&name==='canal'){
      await page.evaluate(()=>{
        const r=worldEvidence.info.manifest.regions.find(r=>r.map==='Azeroth');
        worldTest.focus([-650+r.placement[0]+(32-r.tile_origin[0])*1600/3,130,
          8850+r.placement[1]+(32-r.tile_origin[1])*1600/3,0,-.4]);
      });
      await page.waitForFunction(()=>[...waterProbe.models.keys()].some(key=>
        key.includes('stormwind')&&waterProbe.rig.instances.some(i=>i.key===key)),null,{timeout:120000});
      pose=await page.evaluate(()=>{
        const rig=waterProbe.rig,[key,water]=[...waterProbe.models].find(([key])=>
          key.includes('stormwind')&&rig.instances.some(i=>i.key===key));
        const instance=rig.instances.find(i=>i.key===key);
        const m=rig.sceneMatrix(instance,rig.manifest.regions[rig.sceneRegion],[0,0]),p=water.point;
        const world=[0,1,2].map(a=>m[a]*p[0]+m[4+a]*p[1]+m[8+a]*p[2]+m[12+a]);
        return [world[0],world[1]+18,world[2]+25,0,-.62];
      });
    }else if(!pose){
      pose=await page.evaluate(()=>{
        const o=worldEvidence.info.manifest.ocean;
        return [(o[0]+o[2])/2,1800,(o[1]+o[3])/2,Math.PI/2,-.6];
      });
    }
    await page.evaluate(pose=>worldTest.focus(pose),pose);
    await page.waitForTimeout(12000);
    const sample=await page.evaluate(async()=>{
      const times=[];let last=performance.now();
      while(times.length<120){
        await new Promise(requestAnimationFrame);
        const now=performance.now();times.push(now-last);last=now;
      }
      times.sort((a,b)=>a-b);
      return {render:worldEvidence.render,frameP99:times[118],frameMax:times[119],
        errors:worldEvidence.errors,scene:worldEvidence.state.scene,
        terrainWater:[...waterProbe.rig.tiles.values()].filter(t=>t.liquid?.length).map(t=>({
          map:waterProbe.rig.manifest.regions[t.entry.region].map,x:t.entry.x,y:t.entry.y,authored:t.liquid[5]===1}))};
    });
    assert.deepEqual(sample.errors,[]);
    if(!baseline){
      assert.equal(sample.render.waterShaderGpuBytes,87380);
      if(name==='canal')assert(sample.render.wmoWaterDraws>0,'Authored canals reach the water shader');
      if(name==='lake')assert(sample.terrainWater.some(t=>t.map==='Azeroth'&&t.x===32&&t.y===49&&t.authored),
        'Crystal Lake carries its authored shoreline ramp');
    }
    const cdp=await browser.newBrowserCDPSession();
    try{
      const {processInfo}=await cdp.send('SystemInfo.getProcessInfo'),ids=processInfo.map(p=>p.id);
      assert(ids.every(Number.isSafeInteger));
      sample.gpu=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        `$ids=@(${ids.join(',')}); @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object {$_.Name -match '^pid_(\\d+)_' -and $ids -contains [int]$matches[1]} | Select-Object DedicatedUsage,SharedUsage,TotalCommitted) | ConvertTo-Json -Compress`],{encoding:'utf8'}));
    }finally{await cdp.detach();}
    result.views.push({name,pose,...sample});
    await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,out))});
    await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));
  }
  assert.deepEqual(result.errors,[]);
  console.log(JSON.stringify(result.views.map(v=>({name:v.name,frameP99:v.frameP99,
    wmoWaterDraws:v.render.wmoWaterDraws,gpu:v.gpu})),null,2));
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));}
