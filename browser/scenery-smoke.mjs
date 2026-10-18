import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const base=process.env.BASE_URL||'http://127.0.0.1:4183';
assert(new URL(base).port!=='4173','Do not use the protected user preview');
assert(process.env.WOW_DATA,'Set WOW_DATA to the local read-only install');
const out=new URL(`./test-results/scenery/${process.env.LABEL||'before'}/`,import.meta.url);
const coast=process.env.SCENERY_CASE==='coast';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const result={browser:browser.version(),views:[],errors:[]};
async function workerHeaps() {
  const root=await browser.newBrowserCDPSession(),heaps=[];
  try {
    const {targetInfos}=await root.send('Target.getTargets');
    for(const target of targetInfos.filter(t=>t.type==='worker'&&/\/(?:world|far|asset)-worker\.js$/.test(t.url))) {
      const {sessionId}=await root.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
      const usage=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{root.off('Target.receivedMessageFromTarget',receive);reject(Error('Worker heap probe timed out'));},10000);
        const receive=event=>{
          if(event.sessionId!==sessionId)return;
          const message=JSON.parse(event.message);
          if(message.id!==1)return;
          clearTimeout(timer);root.off('Target.receivedMessageFromTarget',receive);
          if(message.error)reject(Error(message.error.message));else resolve(message.result);
        };
        root.on('Target.receivedMessageFromTarget',receive);
        root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:1,method:'Runtime.getHeapUsage'})})
          .catch(error=>{clearTimeout(timer);root.off('Target.receivedMessageFromTarget',receive);reject(error);});
      });
      heaps.push({url:target.url,...usage});
      await root.send('Target.detachFromTarget',{sessionId});
    }
    if(process.env.BASELINE!=='1')for(const name of ['far','asset'])
      assert(heaps.some(h=>h.url.endsWith(`/${name}-worker.js`)),'Measure every extra worker, not only the near heap');
    const {processInfo}=await root.send('SystemInfo.getProcessInfo');
    const ids=processInfo.map(p=>p.id);
    assert(ids.length&&ids.every(Number.isSafeInteger));
    const script=`$ids=@(${ids.join(',')}); @(
      Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory |
        Where-Object {$_.Name -match '^pid_(\\d+)_' -and $ids -contains [int]$matches[1]} |
        Select-Object Name,DedicatedUsage,SharedUsage,TotalCommitted
    ) | ConvertTo-Json -Compress`;
    const gpu=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8'}));
    const gpuResidency=Array.isArray(gpu)?gpu:[gpu];
    assert(gpuResidency.length&&gpuResidency.every(Boolean),'Measure the test browser GPU processes, not other applications');
    return {heaps,gpuResidency};
  } finally {await root.detach();}
}
try {
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.route(/\/[\w-]+\.js(?:\?.*)?$/,async route=>{
    const name=new URL(route.request().url()).pathname.slice(1);
    if(name.includes('/'))return route.continue();
    const baseline=process.env.BASELINE==='1';
    if(!baseline&&name!=='world-worker.js')return route.continue();
    let body=baseline?execFileSync('git',['show',`${process.env.BASELINE_REF||'07e1332'}:browser/${name}`],{encoding:'utf8'}):
      await (await route.fetch()).text();
    if(name==='world-worker.js')body=body.replace("if(message.action==='open')",`if(message.action==='scene-probe')
      return {missing:[...scene.requests.values()].filter(r=>!scene.cache.has(r.key)),capacity:scene.capacityBlocked,
        roots:[...scene.cache].filter(([k])=>k.startsWith('wmo:')).map(([k,e])=>({key:k,groups:e.value.groups.length}))};
    if(message.action==='open')`);
    await route.fulfill({contentType:'text/javascript',body});
  });
  await context.addInitScript(()=>{
    delete Navigator.prototype.serviceWorker;
    const memory=window.gpuMemory={buffers:0,textures:0,peak:0};
    const adapter=navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter=async(...args)=>{
      const a=await adapter(...args),request=a.requestDevice.bind(a);
      a.requestDevice=async(...args)=>{
        const d=await request(...args);
        memory.limits={maxBufferSize:d.limits.maxBufferSize,maxTextureDimension2D:d.limits.maxTextureDimension2D};
        for(const [method,kind] of [['createBuffer','buffers'],['createTexture','textures']]){
          const create=d[method].bind(d);
          d[method]=descriptor=>{
            const item=create(descriptor);
            const size=descriptor.size;
            const dimensions=Array.isArray(size)?size:[size.width,size.height||1,size.depthOrArrayLayers||1];
            let bytes=kind==='buffers'?size:0;
            if(kind==='textures')for(let level=0;level<(descriptor.mipLevelCount||1);level++)
              bytes+=Math.max(1,Math.floor(dimensions[0]/2**level))*Math.max(1,Math.floor((dimensions[1]||1)/2**level))
                *(dimensions[2]||1)*4*(descriptor.sampleCount||1);
            memory[kind]+=bytes;memory.peak=Math.max(memory.peak,memory.buffers+memory.textures);
            const destroy=item.destroy.bind(item);let live=true;
            item.destroy=()=>{if(live){memory[kind]-=bytes;live=false;}destroy();};
            return item;
          };
        }
        return d;
      };
      return a;
    };
  });
  const page=await context.newPage();
  page.on('pageerror',error=>result.errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')result.errors.push(message.text());});
  const open=async()=>{
  await page.goto(`${base}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.evaluate(async()=>{
    const {WorldRenderer}=await import('./world-renderer.js'),draw=WorldRenderer.prototype.draw,event=WorldRenderer.prototype.event;
    window.sceneryProbe={frames:[],geometry:new Map()};
    WorldRenderer.prototype.event=function(data){
      if(data.event==='detail') {
        for(const i of data.removed)sceneryProbe.geometry.delete(i);
        for(const item of data.seams)sceneryProbe.geometry.set(item.index,item.vertices);
      }
      return event.call(this,data);
    };
    WorldRenderer.prototype.draw=function(...args){
      const start=performance.now(),seams=this.seams,horizon=this.horizon,coast=this.coast,instances=this.instances;
      if(sceneryProbe.hide==='seams')this.seams=new Map();
      if(sceneryProbe.hide==='horizon')this.horizon=[];
      if(sceneryProbe.hide==='coast')this.coast=new Map();
      if(sceneryProbe.hide==='far')this.instances=instances.filter(i=>!i.distant);
      let stats;
      try {stats=draw.apply(this,args);}
      finally {this.seams=seams;this.horizon=horizon;this.coast=coast;this.instances=instances;}
      Object.assign(sceneryProbe,{rig:this,stats});
      sceneryProbe.frames.push({at:start,ms:performance.now()-start});
      return stats;
    };
  });
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  };
  const opened=Date.now();
  await open();
  for(const [name,source,yaw] of coast?[
    ['tanaris-far',[-9800,-5000,900],Math.PI/2],
    ['tanaris-sea',[-9800,-5000,8],Math.PI/2],
  ]:[
    ['forest',[-9600,-300,process.env.PANORAMA==='1'?350:120],0],
    ['city',[-9200,450,process.env.PANORAMA==='1'?350:180],0],
  ]){
    await page.evaluate(({source,yaw,coast})=>{
      const r=worldEvidence.info.manifest.regions[coast?0:1],tile=1600/3;
      worldTest.focus([-source[1]+r.placement[0]+32*tile,source[2],-source[0]+r.placement[1]+32*tile,yaw,coast?-.3:-.15]);
      sceneryProbe.frames=[];
    },{source,yaw,coast});
    const samples=[],focused=Date.now();let sampleAt=0;
    for(const wait of coast?[1000,3000,8000,18000]:[2000,6000,12000]){
      sampleAt+=wait;
      await page.waitForTimeout(Math.max(0,focused+sampleAt-Date.now()));
      samples.push(await page.evaluate(()=>{
        const {rig,stats}=sceneryProbe;
        return {state:worldEvidence.state,render:stats,memory:{...gpuMemory,mainJsHeap:performance.memory?.usedJSHeapSize},
          instances:rig.instances.map(i=>({id:i.id,key:i.key,distant:i.distant})),camera:rig.camera,origin:rig.origin};
      }));
      samples.at(-1).elapsedSeconds=(Date.now()-focused)/1000;
      const measured=await workerHeaps();
      samples.at(-1).workerHeaps=measured.heaps;samples.at(-1).gpuResidency=measured.gpuResidency;
      if(coast)await page.screenshot({path:fileURLToPath(new URL(`${name}-${samples.length}.png`,out))});
    }
    await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,out))});
    result.views.push({name,source,yaw,samples,frames:await page.evaluate(()=>sceneryProbe.frames)});
    result.views.at(-1).resources=await page.evaluate(()=>worldTest.request('scene-probe'));
    assert.deepEqual(samples.at(-1).state.terrain.errors,[],'Required/mapped terrain resources must not fail');
    assert.deepEqual(samples.at(-1).state.scene.errors,[]);
    assert.deepEqual(samples.at(-1).state.distant?.failures||[],[]);
    assert.deepEqual(samples.at(-1).state.distant?.scene?.errors||[],[]);
    if(coast){
      await page.evaluate(()=>worldTest.freezePresentation(true));
      for(const layer of ['seams','horizon','coast']){
        await page.evaluate(layer=>{sceneryProbe.hide=layer;},layer);
        await page.waitForTimeout(150);
        await page.screenshot({path:fileURLToPath(new URL(`${name}-without-${layer}.png`,out))});
      }
      await page.evaluate(()=>{sceneryProbe.hide=undefined;worldTest.freezePresentation(false);});
    } else {
      await page.evaluate(()=>worldTest.freezePresentation(true));
      const images=[];
      for(const hide of [undefined,'far',undefined]){
        await page.evaluate(hide=>{sceneryProbe.hide=hide;},hide);
        await page.waitForTimeout(40);
        images.push((await page.locator('#world').screenshot()).toString('base64'));
      }
      const differences=await page.evaluate(async images=>{
        const canvas=new OffscreenCanvas(640,400),ctx=canvas.getContext('2d'),pixels=[];
        for(const encoded of images){
          const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
          ctx.drawImage(image,0,0,640,400);image.close();pixels.push(ctx.getImageData(0,80,640,240).data);
        }
        const count=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)
          if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>40)n++;return n;};
        return {farPixels:count(pixels[0],pixels[1]),backgroundChange:count(pixels[0],pixels[2])};
      },images);
      result.views.at(-1).differences=differences;
      await writeFile(new URL(`${name}-without-far.png`,out),Buffer.from(images[1],'base64'));
      await page.evaluate(()=>{sceneryProbe.hide=undefined;worldTest.freezePresentation(false);});
      if(process.env.BASELINE!=='1'){
        assert.equal(samples.at(-1).state.resident.length,8);
        assert.equal(samples.at(-1).state.distant.resident,24);
        assert(samples.at(-1).render.distantDraws>0);
        assert(differences.farPixels>differences.backgroundChange+100,'Far scenery must change visible pixels, not only draw counters');
      }
    }
    assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  }
  if(coast&&process.env.BASELINE!=='1'){
    await page.waitForFunction(()=>worldEvidence.state.water.pending===0,null,{timeout:180000});
    result.complete=await page.evaluate(()=>({water:worldEvidence.state.water,source:worldEvidence.state.source,
      memory:{...gpuMemory,mainJsHeap:performance.memory?.usedJSHeapSize},wasm:worldEvidence.state.horizon.wasmPeakBytes}));
    result.complete.elapsedSeconds=(Date.now()-opened)/1000;
    assert.deepEqual(result.complete.water.errors,[]);
    assert.equal(result.complete.water.resident+result.complete.water.dry,result.complete.water.total);
    await page.screenshot({path:fileURLToPath(new URL('complete-sea.png',out))});
    await page.evaluate(()=>{
      const r=worldEvidence.info.manifest.regions[0],tile=1600/3;
      worldTest.focus([5000+r.placement[0]+32*tile,900,9800+r.placement[1]+32*tile,Math.PI/2,-.3]);
    });
    await page.waitForTimeout(250);
    await page.screenshot({path:fileURLToPath(new URL('complete-distant.png',out))});
    const reloaded=Date.now();
    await open();
    await page.evaluate(()=>{
      const r=worldEvidence.info.manifest.regions[0],tile=1600/3;
      worldTest.focus([5000+r.placement[0]+32*tile,900,9800+r.placement[1]+32*tile,Math.PI/2,-.3]);
    });
    result.cached=[];
    for(const wait of [1000,3000,8000]){
      await page.waitForTimeout(wait);
      result.cached.push(await page.evaluate(()=>({water:worldEvidence.state.water,source:worldEvidence.state.source,
        terrainErrors:worldEvidence.state.terrain.errors})));
      await page.screenshot({path:fileURLToPath(new URL(`cached-${result.cached.length}.png`,out))});
    }
    assert(result.cached.at(-1).water.cacheHits>0);
    assert.deepEqual(result.cached.at(-1).terrainErrors,[]);
    await page.waitForFunction(()=>worldEvidence.state.water.pending===0,null,{timeout:120000});
    result.cachedComplete=await page.evaluate(()=>({water:worldEvidence.state.water,source:worldEvidence.state.source}));
    result.cachedComplete.elapsedSeconds=(Date.now()-reloaded)/1000;
    assert.deepEqual(result.cachedComplete.water.errors,[]);
    assert.equal(result.cachedComplete.water.cacheHits,result.cachedComplete.water.total);
  }
  assert.deepEqual(result.errors,[]);
} catch(error){result.failure=error.stack;throw error;}
finally {
  await browser.close();
  await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result.views.map(v=>({name:v.name,...v.samples.at(-1),instances:v.samples.at(-1)?.instances.length}))));
}
