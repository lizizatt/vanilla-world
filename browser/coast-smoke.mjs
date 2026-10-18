import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the local Classic Data folder');
const output=new URL(`./test-results/coast/${process.env.LABEL||'before'}/`,import.meta.url);
const after=process.env.LABEL==='after';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const evidence={views:[],errors:[]};
try {
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage();
  page.on('pageerror',error=>evidence.errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')evidence.errors.push(message.text());});
  const url=`${process.env.BASE_URL||'http://127.0.0.1:4183'}/?test`;
  await page.goto(url);
  const ready=async()=>{
  evidence.openStarted=Date.now();
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.evaluate(async()=>{
    const {WorldRenderer}=await import('./world-renderer.js');
    const event=WorldRenderer.prototype.event,draw=WorldRenderer.prototype.draw;
    const patches=new Map(),indices=new Map(),seams=new Map(),water=new Map();
    window.coastProbe={patches,indices,seams,water,frames:[],phase:'loading'};
    WorldRenderer.prototype.event=function(data){
      if(data.event==='horizon-index')indices.set(data.region,data.indices);
      if(data.event==='horizon')patches.set(`${data.region}:${data.source}`,data);
      if(data.event==='coast-water')water.set(data.index,{bytes:data.vertices.byteLength,
        first:Array.from(data.vertices.slice(0,7)),last:Array.from(data.vertices.slice(-7))});
      if(data.event==='detail'){
        seams.clear();
        for(const item of data.seams)seams.set(item.index,item.vertices);
      }
      return event.call(this,data);
    };
    WorldRenderer.prototype.draw=function(...args){
      const horizon=this.horizon,seams=this.seams,coast=this.coast;
      if(window.coastHide==='seams')this.seams=new Map();
      if(window.coastHide==='horizon')this.horizon=[];
      if(window.coastHide==='water')this.coast=new Map();
      try {
        const stats=draw.apply(this,args);
        if(!window.coastHide&&!window.coastDiagnostic)coastProbe.frames.push({
          t:performance.now(),phase:coastProbe.phase,focused:document.hasFocus(),hidden:document.hidden,
          bytes:this.coastBytes,resident:this.coast.size,draws:stats.worldDraws,
        });
        Object.assign(coastProbe,{rig:this,stats});return stats;
      } finally {this.horizon=horizon;this.seams=seams;this.coast=coast;}
    };
  });
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  };
  const focus=async(region,source,yaw)=>page.evaluate(({region,source,yaw})=>{
    const r=worldEvidence.info.manifest.regions[region],offset=32*1600/3;
    worldTest.focus([-source[1]+r.placement[0]+offset,source[2],-source[0]+r.placement[1]+offset,yaw,-.45]);
  },{region,source,yaw});
  const completeWater=async()=>{
    const start=Date.now();
    await page.waitForFunction(()=>{
      const w=worldEvidence.state.water;
      return w&&(w.pending===0||w.limited||w.errors.length);
    },null,{timeout:300000});
    const water=await page.evaluate(()=>worldEvidence.state.water);
    assert.deepEqual(water.errors,[]);assert(!water.limited);
    assert.equal(water.pending,0,'All authored water must fit, not just a nearby loading frontier');
    assert.equal(water.resident+water.dry,water.total);
    assert(water.bytes<=water.limit);assert(water.peakBytes<=water.limit);
    return {waitMs:Date.now()-start,openToCompleteMs:Date.now()-evidence.openStarted,
      source:await page.evaluate(()=>worldEvidence.state.source),
      memory:await page.evaluate(()=>({wasmPeakBytes:worldEvidence.state.horizon.wasmPeakBytes,
        mainJsHeapBytes:performance.memory?.usedJSHeapSize})),...water};
  };
  await ready();
  for(const [name,region,source,yaw] of [
    ['tanaris-far',0,[-9800,-5000,900],Math.PI/2],
    ['tanaris-near',0,[-9800,-5000,120],Math.PI/2],
    ['westfall-far',1,[-10500,2400,900],0],
    ['westfall-near',1,[-10500,2400,120],0],
  ]){
    await focus(region,source,yaw);
    await page.waitForTimeout(7000);
    if(after&&!evidence.complete)evidence.complete=await completeWater();
    await page.evaluate(()=>{worldTest.freezePresentation(true);window.coastDiagnostic=true;});
    const view=await page.evaluate(({name,region,source})=>{
      const {rig,patches,indices,seams,stats}=coastProbe,sea=worldEvidence.info.manifest.sea_level;
      const triangles=(vertices,index,stride)=>{
        let maximumDrop=0,vertical=0,steep=0,underwaterSteep=0,min=Infinity,max=-Infinity,example;
        for(let t=0;t<index.length;t+=3){
          const p=[0,1,2].map(i=>Array.from(vertices.subarray(index[t+i]*stride,index[t+i]*stride+3)));
          const lo=Math.min(...p.map(v=>v[1])),hi=Math.max(...p.map(v=>v[1])),drop=hi-lo;
          const area=Math.abs((p[1][0]-p[0][0])*(p[2][2]-p[0][2])-(p[1][2]-p[0][2])*(p[2][0]-p[0][0]));
          min=Math.min(min,lo);max=Math.max(max,hi);
          if(drop>maximumDrop){maximumDrop=drop;example=p;}
          if(area<.001&&drop>1)vertical++;
          if(drop>100){steep++;if(lo<sea)underwaterSteep++;}
        }
        return {triangles:index.length/3,min,max,maximumDrop,vertical,steep,underwaterSteep,example};
      };
      const nearby=[];
      for(const data of patches.values()){
        if(data.region!==region)continue;
        const distance=Math.hypot(data.placement[0]+1600/6-rig.camera[0]-rig.origin[0],
          data.placement[1]+1600/6-rig.camera[2]-rig.origin[1]);
        if(distance<6000)nearby.push({source:data.source,distance,...triangles(data.vertices,indices.get(region),7)});
      }
      return {name,region,source,stats,camera:rig.camera,origin:rig.origin,nearby,
        seams:[...seams].map(([index,v])=>({index,...triangles(v,Uint32Array.from({length:v.length/7},(_,i)=>i),7)})),
        worker:worldEvidence.state.horizon,water:worldEvidence.state.water,loads:worldEvidence.state.loads};
    },{name,region,source});
    evidence.views.push(view);
    if(after){
      assert.deepEqual(view.water.errors,[]);
      assert(!view.water.limited,'The tested coastal neighborhood must fit its bounded cache');
      assert(view.water.resident>0);
    }
    await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,output))});
    if(name.endsWith('far')){
      for(const layer of ['seams','horizon','water']){
        await page.evaluate(layer=>{window.coastHide=layer;},layer);
        await page.waitForTimeout(150);
        await page.screenshot({path:fileURLToPath(new URL(`${name}-without-${layer}.png`,output))});
      }
      await page.evaluate(()=>{window.coastHide=undefined;});
    }
    await page.evaluate(()=>{worldTest.freezePresentation(false);window.coastDiagnostic=false;});
  }
  if(after){
    evidence.transitions=[];
    await page.evaluate(()=>{coastProbe.phase='approach-retreat';});
    for(const shift of [0,650,1300,650,0]){
      await focus(0,[-9800,-5000-shift,120],Math.PI/2);
      await page.waitForTimeout(2500);
      const frame=await page.evaluate(()=>{
        const {rig,stats}=coastProbe;
        return {origin:rig.origin.slice(),camera:rig.camera.slice(),tiles:[...rig.tiles.keys()],
          suppressed:[...rig.coast.keys()].filter(i=>rig.tiles.has(i)),resident:rig.coast.size,
          drawn:stats.coastalWaterTiles,bytes:rig.coastBytes};
      });
      assert.equal(frame.drawn,frame.resident-frame.suppressed.length);
      assert.equal(frame.bytes,evidence.complete.bytes);
      evidence.transitions.push(frame);
    }
    assert(new Set(evidence.transitions.flatMap(f=>f.tiles)).size>4,'Approach/retreat must change detailed tiles');
    assert(evidence.transitions.some(f=>f.suppressed.length),'Detailed water must replace distant water');
    assert(new Set(evidence.transitions.map(f=>f.origin.join(','))).size>1,'Flight must cross a render-origin rebase');
    assert.equal(await page.evaluate(()=>worldEvidence.state.water.loads),evidence.complete.loads,
      'Ordinary focus changes must not reread completed water tiles');
    const onlineWater=await page.evaluate(()=>[...coastProbe.water]);
    evidence.frames=await page.evaluate(()=>coastProbe.frames);
    evidence.onlineTimings=await page.evaluate(()=>worldEvidence.state.timings);
    await page.waitForFunction(()=>navigator.serviceWorker.controller);
    await context.setOffline(true);await page.reload();await ready();
    await focus(0,[-9800,-5000,900],Math.PI/2);
    evidence.offline=await completeWater();
    const offlineWater=await page.evaluate(()=>[...coastProbe.water]);
    assert.deepEqual(offlineWater.sort((a,b)=>a[0]-b[0]),onlineWater.sort((a,b)=>a[0]-b[0]));
    assert.equal(evidence.offline.bytes,evidence.complete.bytes);
    await page.screenshot({path:fileURLToPath(new URL('tanaris-offline.png',output))});
    evidence.offlineFrames=await page.evaluate(()=>coastProbe.frames);
    evidence.offlineTimings=await page.evaluate(()=>worldEvidence.state.timings);
  }
  assert.deepEqual(evidence.errors,[]);
  evidence.browser=browser.version();
  await writeFile(new URL('geometry.json',output),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({browser:evidence.browser,views:evidence.views.map(v=>({
    name:v.name,patches:v.nearby.length,wdlVertical:v.nearby.reduce((n,p)=>n+p.vertical,0),
    maximumWdlDrop:Math.max(...v.nearby.map(p=>p.maximumDrop)),
    underwaterSteep:v.nearby.reduce((n,p)=>n+p.underwaterSteep,0),
    maximumSeamDrop:Math.max(0,...v.seams.map(p=>p.maximumDrop)),
    water:v.water,
  })),complete:evidence.complete,offline:evidence.offline,errors:evidence.errors}));
} catch(error) {
  evidence.failure=error.stack;
  await writeFile(new URL('geometry.json',output),JSON.stringify(evidence,null,2));
  throw error;
} finally {await browser.close();}
