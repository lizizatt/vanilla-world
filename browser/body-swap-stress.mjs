// Real local data, fresh saves, ephemeral loopback port, one machine-wide heavy-test lease.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';

assert(process.env.WOW_DATA&&process.env.SWE1R_DATA,'Set WOW_DATA and SWE1R_DATA');
const cycles=Number(process.env.SWAP_CYCLES||3),label=process.env.RUN_LABEL||'body-swap',nearby=process.env.NEARBY_LOADING==='1';
assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=10,'SWAP_CYCLES must be 1..10');
assert(/^[\w-]+$/.test(label),'RUN_LABEL must be a filename-safe label');
const root=new URL('./',import.meta.url),out=new URL(`./test-results/body-swap/${label}/`,root);
const sourceRef=process.env.SOURCE_REF&&execFileSync('git',['rev-parse','--verify',`${process.env.SOURCE_REF}^{commit}`],{encoding:'utf8'}).trim();
const sourceFiles=new Map();
const release=await acquireHeavyLock(`body-swap-${label}`);
let browser,server,page,deadline;
const activeRequests=new Set();
const result={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceRef,cycles,flight:process.env.SWAP_FLIGHT==='1',
  phases:[],errors:[],warnings:[],workers:[],network:{active:0,peak:0,failed:[]}};
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
// Instrument the exact served code without changing production scheduling or shipping test hooks.
function instrument(path,text) {
  if(path==='/world-app.js')return text+'\nglobalThis.swapStressApp=app;\n';
  if(path==='/world-client.js')return text.replace("if(data.event==='world-error')",
    "if(data.event==='stress-probe'){worker.stress=data.metrics;return;}if(data.event==='world-error')")
    .replace('const id=this.requests.open({resolve,reject,action});',
      'const id=this.requests.open({resolve,reject,action});this.worker.stressRpcPeak=Math.max(this.worker.stressRpcPeak||0,this.requests.size);');
  if(path==='/asset-channel.js')return text.replace("if(['progress'",
    "if(data.event==='asset-stress-probe'){this.stress=data.metrics;return;}if(['progress'");
  if(path==='/world-worker.js')return text+`
import {stressProbe} from './world-engine.js';
setInterval(()=>postMessage({event:'stress-probe',metrics:stressProbe()}),250);
`;
  if(path==='/world-engine.js')return text+`
export function stressProbe(){return {
 rebind:rebindToken,horizonPatches:horizon?.patches,wasmBytes:wasm?.memory.buffer.byteLength||0,sourcePending:source?.table?.size||0,source:{...source?.stats,...source?.stress},
 terrainRead:!!terrainRead,geometry:!!geometryJob,detailBusy,detailPending:detailPending?.tiles.size||0,
 materialBusy,materials:terrainMaterials.size,sceneBusy:!!scene?.busy,sceneRequests:scene?.requests.size||0,
 scenePending:scene?[...scene.requests.keys()].filter(k=>!scene.cache.has(k)&&!scene.failures.has(k)).length:0,
 sceneBytes:scene?.bytes||0,resident:resident.size,sceneInstances:sceneState?.instances.length||0,
 required:world?Array.from(world.required_tiles()):[],residentIds:[...resident],waiting:objectWait.length,
 terrain:terrain?.snapshot(),far:{...far?.snapshot(),active:far?.active,reading:!!far?.reading},craftPending:craft.pending,actors:actors?.snapshot(),population:scene?.populationStatus,timings,decoder:scene?.timings
};}
`;
  if(path==='/asset-worker.js')return text+`
setInterval(()=>postMessage({event:'asset-stress-probe',metrics:{queueDepth:jobs.length,activeLoads:Number(busy),awaitingReceipt:Number(receipt!==undefined),cancelled:cancelled.size,wasmBytes:wasm?.memory.buffer.byteLength||0}}),250);
`;
  return text;
}
const quantile=(values,q)=>values.length?values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]:0;
try {
  await mkdir(out,{recursive:true});
  server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname,file=new URL(path==='/'?'index.html':'.'+path,root);
    if(path==='/favicon.ico'){res.writeHead(204).end();return;}
    if(!file.href.startsWith(root.href)){res.writeHead(403).end();return;}
    try {
      let bytes;
      if(sourceRef&&!path.startsWith('/pkg/')&&/\.(js|html|css)$/.test(file.pathname)){
        const name=file.pathname.slice(root.pathname.length);
        if(!sourceFiles.has(name))sourceFiles.set(name,execFileSync('git',['show',`${sourceRef}:browser/${name}`],{maxBuffer:16*1024*1024}));
        bytes=sourceFiles.get(name);
      }else bytes=await readFile(path==='/local/npc-spawns.json'?(process.env.NPC_PACK||new URL('../runtime/browser/npc-spawns.json',root)):file);
      if(path.endsWith('.js'))bytes=instrument(path,bytes.toString());
      res.setHeader('content-type',mime[extname(file.pathname)]||'application/octet-stream');res.end(bytes);
    }catch{res.writeHead(404).end();}
  }).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const port=server.address().port;assert.notEqual(port,4173);result.port=port;
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio','--enable-precise-memory-info']});
  deadline=setTimeout(()=>{
    result.timeout='12 minute heavy-test budget exceeded';process.exitCode=1;
    void browser.close().catch(error=>{result.errors.push(error.message);});
  },12*60*1000);
  const targets=await browser.newBrowserCDPSession(),live=new Map();
  const found=({targetInfo:t})=>{
    if(t.type==='worker'&&t.url.startsWith(`http://127.0.0.1:${port}/`)&&!live.has(t.targetId)){
      live.set(t.targetId,t.url);result.workers.push({action:'created',id:t.targetId,url:t.url,at:Date.now()});
    }
  };
  targets.on('Target.targetCreated',found);targets.on('Target.targetInfoChanged',found);
  targets.on('Target.targetDestroyed',({targetId})=>{
    if(live.delete(targetId))result.workers.push({action:'destroyed',id:targetId,at:Date.now()});
  });
  await targets.send('Target.setDiscoverTargets',{discover:true});
  const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
  context.on('request',r=>{activeRequests.add(r);result.network.active=activeRequests.size;result.network.peak=Math.max(result.network.peak,activeRequests.size);});
  const complete=r=>{activeRequests.delete(r);result.network.active=activeRequests.size;};
  context.on('requestfinished',complete);
  context.on('requestfailed',r=>{complete(r);result.network.failed.push({url:r.url(),error:r.failure()?.errorText});});
  await context.addInitScript(()=>{
    delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];
    window.swapStress={longTasks:[],handlers:[],frames:[],phase:'startup',loadingFrames:0,controlViolations:[],modalViolations:[],flightLoadingFrames:0};
    const send=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(data,...rest){
      if(window.worldEvidence?.loading?.active){
        if(!document.getElementById('loading-screen').open)swapStress.modalViolations.push(data.action);
        if(data.action==='frame'){
          swapStress.loadingFrames++;
          if(swapStress.phase==='powered-flight-elune-azeroth')swapStress.flightLoadingFrames++;
          if(data.dt!==0||data.throttle||data.steer||data.flags||!data.loading)swapStress.controlViolations.push(data);
        }
      }
      return send.call(this,data,...rest);
    };
    new PerformanceObserver(list=>{for(const e of list.getEntries())swapStress.longTasks.push({phase:swapStress.phase,ms:e.duration});}).observe({type:'longtask',buffered:true});
    const descriptor=Object.getOwnPropertyDescriptor(Worker.prototype,'onmessage');
    Object.defineProperty(Worker.prototype,'onmessage',{...descriptor,set(fn){
      descriptor.set.call(this,fn&&function(event){const start=performance.now();try{return fn.call(this,event);}
        finally{swapStress.handlers.push({phase:swapStress.phase,ms:performance.now()-start,event:event.data?.event||'reply'});}});
    }});
    let previous;
    const frame=t=>{if(previous!==undefined)swapStress.frames.push({phase:swapStress.phase,ms:t-previous});previous=t;requestAnimationFrame(frame);};
    requestAnimationFrame(frame);
  });
  page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());else if(m.type()==='warning')result.warnings.push(m.text());});
  const sample=()=>page.evaluate(()=>{
    const app=swapStressApp,clients={[app.client.bodyId||'opening']:app.client,...app.engines},r=app.renderer;
    return {at:performance.now(),body:app.client.bodyId,busy:app.busy,running:app.running,heap:performance.memory?.usedJSHeapSize,
      engines:Object.fromEntries(Object.entries(clients).map(([id,c])=>[id,{rpc:c.requests.size,rpcPeak:c.worker?.stressRpcPeak||0,inFlight:c.inFlight,...c.worker?.stress}])),
      gpu:worldEvidence.gpuBytes,render:worldEvidence.render,tiles:r.tiles.size,textures:r.textures.size,assets:r.assets.size,
      horizonCount:r.horizon.length,pod:app.client.state?.pod,telemetry:app.client.state?.telemetry.slice(0,6),
      loading:worldEvidence.loading,modal:document.getElementById('loading-screen').open,
      duplicateHorizon:r.horizon.length-new Set(r.horizon.map(h=>`${h.region}:${h.cell}`)).size,
      groundReady:!app.flight&&!!app.client.state?.required.every(i=>app.client.state.resident.includes(i))&&!app.client.state?.scene?.waitingCollision&&r.tiles.size>0,
      errors:worldEvidence.errors.slice(),swaps:worldEvidence.bodySwaps||0};
  });
  async function phase(name,action,dwell=500) {
    await page.evaluate(name=>{
      swapStress.phase=name;
      for(const c of [swapStressApp.client,...Object.values(swapStressApp.engines)])c.worker.stressRpcPeak=c.requests.size;
    },name);
    const row={name,start:Date.now(),samples:[]};result.phases.push(row);
    console.log(`[body-swap] ${name}`);
    let sampling=true;
    const monitor=(async()=>{
      while(sampling){
        row.samples.push({...await sample(),workers:live.size,fetches:activeRequests.size});
        await page.waitForTimeout(250);
      }
    })();
    try {
      row.before=await sample();await action();row.release=await sample();
      await page.waitForTimeout(dwell);
    }catch(e){row.error=e.message;throw e;}finally{
      sampling=false;await monitor;row.ms=Date.now()-row.start;
      const ready=row.samples.find(s=>s.groundReady&&(name==='azeroth-start'||s.swaps>row.before.swaps));
      row.groundReadyMs=ready?Math.max(0,ready.at-row.before.at):null;
    }
  }
  await page.goto(`http://127.0.0.1:${port}/?test`);
  await page.waitForFunction(()=>window.worldTest&&!document.getElementById('select').disabled);
  await page.locator('#swe1r-files').setInputFiles(process.env.SWE1R_DATA);
  await page.waitForFunction(()=>document.getElementById('swe1r-status').dataset.ok==='1');
  const openedAt=Date.now();
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  result.initialMs=Date.now()-openedAt;
  result.initial=await sample();
  await page.evaluate(async()=>{
    await swapStressApp.prepareEngines;
    const {VEHICLES}=await import('./vehicles.js');
    worldTest.selectVehicle({vehicle:'podracer',skin:VEHICLES.podracer.skins.find(s=>s.source==='swe1r').id});
    worldTest.settings({sound:false});document.getElementById('welcome').hidden=true;
  });
  await page.locator('#world').click();
  await phase('azeroth-start',async()=>{},2000);
  if(nearby){
    await page.evaluate(()=>{
      const buttons=Array.from({length:17},()=>({pressed:false,value:0}));
      buttons[7]={pressed:true,value:1};
      worldTest.gamepads([{connected:true,mapping:'standard',index:0,axes:[.5,0,0,0],buttons}]);
    });
    for(const [name,icon] of [
      ['reset',{body:'azeroth',label:'Spawn',reset:true}],
      ['moon',{body:'elune',label:'Elune'}],
      ['moon-pole',{body:'elune',pole:'N',label:'Elune north pole'}],
      ['home',{body:'azeroth',label:'Azeroth',reset:true}],
    ])await phase(name,async()=>{
      const state=await page.evaluate(async icon=>{
        await swapStressApp.mapPanel.teleport(icon);
        return {loading:worldEvidence.loading,body:swapStressApp.client.bodyId};
      },icon);
      if(!sourceRef){
        assert(state.loading?.ready,`${name} released without destination readiness`);
        assert.equal(state.body,icon.body);
      }
    },1000);
    await page.evaluate(()=>worldTest.gamepads([]));
    if(!sourceRef)await phase('pose-link',async()=>{
      const state=await page.evaluate(async()=>{
        const pose={v:1,body:'elune',flight:swapStressApp.engines.elune.info.manifest.spawn.slice(0,3).concat([0,-.3])};
        const url=location.href;
        try{history.replaceState(null,'',`?test&pose=${encodeURIComponent(JSON.stringify(pose))}`);await swapStressApp.applyUrlPose();}
        finally{history.replaceState(null,'',url);}
        return {loading:worldEvidence.loading,body:swapStressApp.client.bodyId};
      });
      assert.equal(state.body,'elune');assert(state.loading.ready,'Pose-link restore must wait for nearby scenery');
    },1000);
  }else{
  for(let cycle=0;cycle<cycles;cycle++)for(const [leg,target] of ['elune','azeroth','elune','azeroth'].entries()) {
    await phase(`${cycle}-${leg}-${target}-loading`,async()=>{
      await page.evaluate(async({target,map})=>{
        if(map) {
          await swapStressApp.mapPanel.teleport({body:target,label:target,reset:target==='azeroth'});
          if(swapStressApp.client.bodyId!==target)throw Error(`Map teleport failed: ${target}`);
          return;
        }
        await worldTest.launch.swap(target);
        const p=swapStressApp.client.info.manifest.spawn;
        // Flight focus makes near terrain/model demand without waiting for collision, like a map jump.
        worldTest.focus([p[0]+(target==='elune'?1600:800),p[1]+120,p[2]+800,0,-.3]);
      },{target,map:cycle===0});
    },cycle===0?2500:250);
  }
  await phase('back-to-back-swaps',()=>page.evaluate(async()=>{
    for(const target of ['elune','azeroth','elune','azeroth']){
      // Unlike launch.swap, this does not wait behind rebind/launch-object RPC replies.
      if(!await swapStressApp.soiSwap(target))throw Error(`Immediate swap refused: ${target}`);
      const p=swapStressApp.client.info.manifest.spawn;
      worldTest.focus([p[0]+800,p[1]+120,p[2]+800,0,-.3]);
    }
    await worldEvidence.swapSettled;
  }),1500);
  }
  if(result.flight){
    await phase('flight-preparation',async()=>{
      await page.evaluate(async()=>{
        if(swapStressApp.client.bodyId!=='elune')await worldTest.launch.swap('elune');worldTest.focus([-300,300,120,0,-1]);
      });
      await page.waitForTimeout(6000);
      await page.evaluate(async()=>{
        await worldTest.launch.save([]);
        await worldTest.launch.place([-300,0,0],0,'ramp',90);
        await worldTest.launch.place([-300,0,60],0,'powerup');
        const [ground]=await worldTest.request('probe',{points:[[-300,220]]});
        await worldTest.restore([-300,Math.max(...ground.slice(1,3).filter(Number.isFinite))+3,220,0]);
      });
    });
    await phase('powered-flight-elune-azeroth',async()=>{
      await page.evaluate(()=>{
        swapStress.flying=true;
        const pad={connected:true,mapping:'standard',index:0,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
        const drive=()=>{
          if(!swapStress.flying)return;
          const pod=worldEvidence.state?.pod,j=pod?.journey,powered=j?.mode==='orbit'&&pod.remaining>0;
          pad.buttons[0]={pressed:!!powered,value:+!!powered};
          pad.buttons[7]={pressed:!j||!!powered,value:+(!j||!!powered)};
          worldTest.gamepads([pad]);requestAnimationFrame(drive);
        };drive();
      });
      try{
        await page.waitForFunction(()=>worldEvidence.state?.pod?.journey?.mode==='orbit',null,{timeout:60000});
        await page.waitForFunction(()=>swapStressApp.client.bodyId==='azeroth',null,{timeout:180000});
        await page.waitForFunction(()=>!worldEvidence.state?.pod?.journey,null,{timeout:120000});
      }finally{await page.evaluate(()=>{swapStress.flying=false;worldTest.gamepads([]);});}
      if(!sourceRef)assert.equal(await page.evaluate(()=>swapStress.flightLoadingFrames),0,'Automatic SOI handoff must not open the arrival gate');
    });
    await phase('map-return-elune',()=>page.evaluate(()=>swapStressApp.mapPanel.teleport({body:'elune',label:'Elune'})),2000);
  }
  await phase('final-ground',async()=>{
    await page.evaluate(async()=>{
      const start=performance.now();await worldTest.request('reset');
      swapStressApp.flight=undefined;swapStressApp.running=true;swapStressApp.groundStart=start;
    });
    await page.waitForFunction(()=>{
      const s=swapStressApp.client.state;
      return s.required.every(i=>s.resident.includes(i))&&!s.scene?.waitingCollision&&swapStressApp.renderer.tiles.size>0;
    },null,{timeout:60000});
    result.timeToGroundReadyMs=await page.evaluate(()=>performance.now()-swapStressApp.groundStart);
  },6000);
  result.final=await sample();
  result.targets=(await targets.send('Target.getTargets')).targetInfos.map(t=>({type:t.type,url:t.url,id:t.targetId}));
  assert.deepEqual(result.final.errors,[]);
  assert.deepEqual(result.errors,[],'No page, world or console errors during the workload');
  assert(result.final.running,'World stopped during repeated swaps');
  assert.equal(Object.keys(result.final.engines).length,2);
  if(nearby&&!sourceRef){
    const controls=await page.evaluate(()=>({frames:swapStress.loadingFrames,violations:swapStress.controlViolations,modal:swapStress.modalViolations}));
    assert(controls.frames>0);assert.deepEqual(controls.violations,[]);assert.deepEqual(controls.modal,[]);
    result.loadingControls=controls;
  }
  assert.equal(result.final.duplicateHorizon,0,'Obsolete horizon replay reached the final consumer');
  assert.equal(result.final.horizonCount,result.final.engines[result.final.body].horizonPatches,'Full horizon must arrive exactly once');
}catch(error){result.failure=error.stack;process.exitCode=1;console.error(error.message);}
finally{
  clearTimeout(deadline);
  if(page&&!page.isClosed()){
    const records=await page.evaluate(()=>window.swapStress).catch(()=>undefined);
    if(records)for(const row of result.phases){
      const handlers=records.handlers.filter(r=>r.phase===row.name).map(r=>r.ms);
      const frames=records.frames.filter(r=>r.phase===row.name).map(r=>r.ms);
      const tasks=records.longTasks.filter(r=>r.phase===row.name).map(r=>r.ms);
      row.performance={handlerP99:quantile(handlers,.99),handlerMax:Math.max(0,...handlers),
        frameP99:quantile(frames,.99),frameMax:Math.max(0,...frames),longTasks:tasks.length,longTaskMax:Math.max(0,...tasks)};
    }
    if(nearby&&records){
      result.startupHandlerP99=quantile(records.handlers.filter(r=>r.phase==='startup').map(r=>r.ms),.99);
      if(Math.max(result.startupHandlerP99,...result.phases.map(p=>p.performance?.handlerP99||0))>20){
        result.failure='Nearby loading handler p99 exceeded 20 ms';process.exitCode=1;
      }
    }
  }
  await browser?.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  // Worker teardown may omit Playwright's terminal request event; these are not live-fetch counts.
  result.network.unsettledRequestEventsAtClose=activeRequests.size;
  result.network.unsettledUrls=[...activeRequests].map(r=>r.url());
  result.workersRemainingAtClose=result.workers.filter(w=>w.action==='created').length-result.workers.filter(w=>w.action==='destroyed').length;
  await writeFile(new URL('results.json',out),JSON.stringify(result,null,2));
  release();
  console.log(JSON.stringify({head:result.head,phases:result.phases.length,failure:result.failure,errors:result.errors.length,
    groundMs:result.timeToGroundReadyMs,report:new URL('results.json',out).pathname}));
}
