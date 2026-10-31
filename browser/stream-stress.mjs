// Streaming stall stress test: flies the real app at high speed along a long ocean route (full circumnavigation across the
// longitude wrap, a long-range hop) and stops near a coast, sampling streaming state once a second and asserting the
// terrain around the camera loads within STOP_TIMEOUT_S after the stop.
//   WOW_DATA=<read-only Data> node browser/stream-stress.mjs        (heavy: runs under browser/heavy-lock.mjs)
// Env: STREAM_ROUTE=default|quick  SPEED=8000 (yd/s)  ALT=300  STOP_TIMEOUT_S=45  RUN_LABEL=stream-stress  BASELINE_REF=<git ref> (serve that
// ref's browser/*.js instead of the working tree, for before/after comparison)
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {acquireHeavyLock} from './heavy-lock.mjs';
import {ROUTES,routeLegs} from './stream-route.mjs';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data folder');
const routeName=process.env.STREAM_ROUTE||'default',speed=Number(process.env.SPEED||8000),alt=Number(process.env.ALT||300);
const stopTimeout=Number(process.env.STOP_TIMEOUT_S||45),label=process.env.RUN_LABEL||'stream-stress';
assert(ROUTES[routeName],`Unknown route ${routeName}`);
assert(/^[a-z0-9-]+$/i.test(label));
const output=new URL(`./test-results/stream-stress/${label}/`,import.meta.url);
await mkdir(output,{recursive:true});

const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);
  s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
const release=await acquireHeavyLock('stream-stress');
const port=await freePort();
assert.notEqual(port,4173);
const server=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',()=>reject(new Error('server exited')));});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const errors=[];
let result;
try {
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
  if(process.env.BASELINE_REF)await context.route(/\/[\w-]+\.(?:js|mjs)(?:\?.*)?$/,async route=>{
    const name=new URL(route.request().url()).pathname.slice(1);
    if(name.includes('/'))return route.continue();
    let body;try{body=execFileSync('git',['show',`${process.env.BASELINE_REF}:browser/${name}`],{stdio:['ignore','pipe','ignore'],maxBuffer:1<<28});}catch{return route.continue();}
    await route.fulfill({contentType:'text/javascript',body});
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text());});
  await page.goto(`http://127.0.0.1:${port}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,{},{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[],'World failed to start');
  await page.locator('#world').click();
  await page.waitForTimeout(3000);
  const legs=routeLegs(routeName,{speed,alt});
  if(process.env.INPUT==='keys'){
    // Real Shift+W flight: the app's own flight state is unbounded (never re-wrapped by the harness), which is what exposed the circumnavigation stall.
    const laps=Number(process.env.LAPS||3),land=[-15000,0],landZ=[-8000,12000];
    const read=()=>page.evaluate(()=>{const st=worldEvidence.state,f=worldTest.flightState().flight;return {pose:f.slice(0,3).map(Math.round),near:st.nearTerrain,resident:st.resident?.length??0,failures:st.failures?.length??0,heapMB:Math.round(performance.memory.usedJSHeapSize/1048576)};});
    await page.evaluate(()=>worldTest.focus([-14000,300,-9000,Math.PI/2,0]));
    await page.waitForTimeout(2000);
    const samples=[],t0=Date.now(),circ=2*Math.PI*(await page.evaluate(async()=>(await import('./space.js')).PLANET_RADIUS));
    await page.keyboard.down('Shift');await page.keyboard.down('KeyW');
    let prev=null,travelled=0;
    for(;;){
      await page.waitForTimeout(1000);const s=await read();s.sec=(Date.now()-t0)/1000;s.phase='fly';samples.push(s);
      const wrapped=((s.pose[0]%circ)+circ*1.5)%circ-circ/2;
      if(prev!==null){let d=wrapped-prev;d-=Math.round(d/circ)*circ;travelled+=Math.abs(d);}
      prev=wrapped;
      if(travelled>laps*circ&&wrapped>land[0]&&wrapped<land[1]&&s.pose[2]>landZ[0]&&s.pose[2]<landZ[1])break;
      assert(s.sec<600,'Keyboard flight never reached land');
    }
    await page.keyboard.up('KeyW');await page.keyboard.up('Shift');
    const holdStart=Date.now();let ok=null;
    while((Date.now()-holdStart)/1000<stopTimeout){
      await page.waitForTimeout(500);const s=await read();s.sec=(Date.now()-t0)/1000;s.phase='stopped';samples.push(s);
      if(s.near?.total>0&&s.near.resident===s.near.total){ok=(Date.now()-holdStart)/1000;break;}
    }
    samples.push({phase:'stop-result',leg:0,recoveredAfterS:ok,sec:(Date.now()-t0)/1000});
    console.table(samples.filter((s,i)=>i%5===0||s.phase!=='fly').map(s=>({sec:+s.sec.toFixed(1),phase:s.phase,pose:s.pose,near:s.near&&`${s.near.resident}/${s.near.total}`,resident:s.resident,heap:s.heapMB})));
    result={samples,travelled:0,legs:[],errors:errors.slice(0,20)};
    await writeFile(new URL('samples.json',output),JSON.stringify(result));
  } else
  result=await page.evaluate(async ({legs,stopTimeout})=>{
    const {wrapFlat}=await import('./space.js');
    const snap=()=>{
      const st=worldEvidence.state,sc=st.scene||{},tr=st.terrain||{},w=st.water||{},d=st.distant||{},m=performance.memory;
      return {t:performance.now(),pose:(worldTest.flightState().flight||st.telemetry).slice(0,3).map(Math.round),
        resident:st.resident?.length??0,required:st.required?.length??0,requiredResident:st.required?.filter(i=>st.resident.includes(i)).length??0,
        near:st.nearTerrain,loads:st.loads,evictions:st.evictions,failures:st.failures?.length??0,prefetch:tr.prefetch,
        sceneInstances:sc.instances,scenePending:sc.pending,sceneAssets:sc.assets,sceneBytes:sc.bytes,sceneErrors:sc.errors?.length??0,
        waitingCollision:sc.waitingCollision,sceneEvictions:st.memory?.sceneEvictions,
        terrainPending:tr.pending,terrainCache:tr.cache,terrainEvictions:tr.evictions,terrainLoads:tr.loads,farPending:tr.farPending,terrainErrors:tr.errors?.length??0,
        waterResident:w.resident,waterPending:w.pending,waterDeferred:w.deferred,distantResident:d.resident,distantPending:d.pending,distantLoads:d.loads,distantFailures:d.failures?.length??0,
        hold:st.telemetry?.[8],frames:worldEvidence.frames,heapMB:m?Math.round(m.usedJSHeapSize/1048576):null,
        sourceReads:st.source?.readCalls,sourceDeferred:st.distant?.source?.deferred,workerErrors:worldEvidence.errors.length,
        drawnTiles:worldEvidence.render?.detailedTiles,rtiles:worldEvidence.render?.horizonTiles};
    };
    const samples=[],frameDts=[];
    let last=performance.now(),lastSample=0;
    const t0=performance.now();
    const sample=(phase,leg)=>{const s=snap();s.phase=phase;s.leg=leg;s.sec=(s.t-t0)/1000;s.frameP99=(()=>{const a=frameDts.splice(0).sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.floor(a.length*.99))]:0;})();samples.push(s);return s;};
    const frame=()=>new Promise(r=>requestAnimationFrame(r));
    const start=(worldTest.flightState().flight)||worldEvidence.state.telemetry;
    let pose=[legs[0].from[0],legs[0].alt,legs[0].from[1],legs[0].yaw??Math.PI/2,-.05];
    worldTest.focus(pose);
    await new Promise(r=>setTimeout(r,2000));
    let travelled=0;
    for(let li=0;li<legs.length;li++){
      const leg=legs[li];
      if(leg.hop){pose=[leg.to[0],leg.alt,leg.to[1],leg.yaw??pose[3],-.05];worldTest.focus(pose);sample('hop',li);continue;}
      if(leg.dir){ // fixed-heading leg (pole crossing): travel distance yd, reversing the northing when wrapFlat flips over a pole
        let left=leg.distance,dz=leg.dir[1],lastFlip=0;
        while(left>0){await frame();const now=performance.now(),dt=Math.min(.25,(now-last)/1000);frameDts.push(now-last);last=now;
          const step=Math.min(left,leg.speed*dt);let [x,z,flipped]=wrapFlat(pose[0]+leg.dir[0]*step,pose[2]+dz*step);
          if(flipped)dz=-dz;pose=[x,leg.alt,z,pose[3],-.05];left-=step;travelled+=step;worldTest.focus(pose);
          if(now-lastSample>=1000){lastSample=now;sample('fly',li);}}
        continue;
      }
      let remaining=Math.hypot(leg.to[0]-pose[0],leg.to[1]-pose[2]);
      const yaw=Math.atan2(-(leg.to[0]-pose[0]),-(leg.to[1]-pose[2]));
      while(remaining>1){
        await frame();
        const now=performance.now(),dt=Math.min(.25,(now-last)/1000);frameDts.push(now-last);last=now;
        const step=Math.min(remaining,leg.speed*dt),dx=(leg.to[0]-pose[0])/remaining,dz=(leg.to[1]-pose[2])/remaining;
        let x=pose[0]+dx*step,z=pose[2]+dz*step;
        [x,z]=wrapFlat(x,z);
        // legs are authored in unwrapped coordinates, so re-anchor the target by the wrap shift
        leg.to=[leg.to[0]+(x-(pose[0]+dx*step)),leg.to[1]+(z-(pose[2]+dz*step))];
        pose=[x,leg.alt,z,yaw,-.05];travelled+=step;
        worldTest.focus(pose);
        remaining=Math.hypot(leg.to[0]-pose[0],leg.to[1]-pose[2]);
        if(now-lastSample>=1000){lastSample=now;sample('fly',li);}
      }
      if(leg.stop){
        // hold position near land and watch the streaming recover
        const holdStart=performance.now();let ok=null;
        while((performance.now()-holdStart)/1000<stopTimeout){
          worldTest.focus(pose);
          await new Promise(r=>setTimeout(r,500));
          const s=sample('stopped',li);
          if(s.near&&s.near.total>0&&s.near.resident===s.near.total&&!s.terrainPending){ok=(performance.now()-holdStart)/1000;break;}
        }
        samples.push({phase:'stop-result',leg:li,recoveredAfterS:ok,sec:(performance.now()-t0)/1000});
      }
    }
    return {samples,travelled:Math.round(travelled),legs:legs.map(l=>({from:l.from,to:l.to,speed:l.speed,alt:l.alt,hop:!!l.hop,stop:!!l.stop}))};
  },{legs,stopTimeout});
  result.errors=errors.slice(0,20);
  await writeFile(new URL('samples.json',output),JSON.stringify(result));
} finally {
  await browser.close().catch(()=>{});server.kill();release();
}
const stops=result.samples.filter(s=>s.phase==='stop-result');
const pick=(s)=>({sec:+s.sec.toFixed(1),phase:s.phase,pose:s.pose,resident:s.resident,req:`${s.requiredResident}/${s.required}`,near:s.near&&`${s.near.resident}/${s.near.total}`,loads:s.loads,ev:s.evictions,prefetch:s.prefetch&&`${s.prefetch.index}${s.prefetch.pending?'p':''}`,scenePend:s.scenePending,inst:s.sceneInstances,terrP:s.terrainPending,terrC:s.terrainCache,farP:s.farPending,wP:s.waterPending,wR:s.waterResident,heap:s.heapMB,frameP99:Math.round(s.frameP99)});
console.table(result.samples.filter(s=>s.phase!=='stop-result').filter((s,i)=>i%2===0).map(pick));
console.log(JSON.stringify({travelledYd:result.travelled,errors:result.errors,stops}));
assert.deepEqual(result.errors,[],'Page errors during run');
for(const s of stops)assert(s.recoveredAfterS!==null,`Streaming did not recover within ${stopTimeout}s after stopping near land (leg ${s.leg})`);
console.log('stream-stress: ok');

