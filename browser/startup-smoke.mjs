import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

assert(process.env.WOW_DATA,'Set WOW_DATA to the local Classic Data folder');
const output=new URL(`./test-results/startup/${process.env.LABEL||'cold-baseline'}/`,import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:false,args:['--mute-audio']});
const evidence={source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  diffSha256:createHash('sha256').update(execFileSync('git',['diff','--binary','HEAD'])).digest('hex'),cases:[],errors:[]};
const base=process.env.WORLD_URL||'http://127.0.0.1:4185/?test';
async function instrument(page,label) {
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.evaluate(async label=>{
    const {WorldClient}=await import('./world-client.js');
    const {WorldRenderer}=await import('./world-renderer.js');
    const {CameraCollision}=await import('./camera-collision.js');
    const trace=window.coldTrace={label,start:performance.now(),requests:[],inputs:[],draws:[],clips:[]};
    const state=s=>s&&({p:s.telemetry?.slice(),poseTime:s.poseTime,clock:s.coldClock,
      waiting:s.scene?.waitingCollision,loads:s.loads,work:s.timings});
    const request=WorldClient.prototype.request,frame=WorldClient.prototype.frame,draw=WorldRenderer.prototype.draw;
    const clip=CameraCollision.prototype.clip;
    WorldClient.prototype.request=async function(action,fields={}){
      trace.client=this;
      const item={action,t:performance.now(),dt:fields.dt,focus:fields.focus,throttle:fields.throttle,values:fields.values};
      trace.requests.push(item);
      const result=await request.call(this,action,fields);
      item.end=performance.now();item.state=state(result.state||result);return result;
    };
    WorldClient.prototype.frame=function(...args){
      const before=this.elapsed,mode=this.poseFlying;
      frame.apply(this,args);
      trace.inputs.push({t:performance.now(),dt:args[0],flight:!!args[4],previousFlight:mode,
        pendingBefore:before,pendingAfter:this.elapsed,inFlight:this.inFlight});
    };
    CameraCollision.prototype.clip=function(...args){
      const result=clip.apply(this,args);
      trace.collision=this;
      trace.clips.push({t:performance.now(),pivot:args[0],desired:args[1],result,ready:this.ready,pending:this.pending.length});
      return result;
    };
    WorldRenderer.prototype.draw=function(p,flight,...args){
      const before=this.camera?.map((v,i)=>v+(i===0?this.origin[0]:i===2?this.origin[1]:0));
      const t=performance.now(),stats=draw.call(this,p,flight,...args),client=trace.client;
      trace.draws.push({t,ms:performance.now()-t,p:p.slice(),raw:state(client?.state),dt:args[0],flight,
        before,camera:this.camera?.map((v,i)=>v+(i===0?this.origin[0]:i===2?this.origin[1]:0)),
        cameraMode:this.cameraMode,ready:trace.collision?.ready,pending:trace.collision?.pending.length,
        history:client?.poseSamples.map(s=>({time:s.time,p:s.p.slice(0,3)})),lastPoseTime:client?.lastPoseTime,
        craftReady:stats.craftReady,focus:document.hasFocus(),hidden:document.hidden});
      return stats;
    };
  },label);
}
async function open(page) {
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:60000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
}
// Controls moved into the Game Menu dialog, which opens on Escape.
async function menuClick(page,selector) {
  if(!await page.evaluate(()=>document.getElementById('race-menu').open))await page.keyboard.press('Escape');
  if(selector==='#save')await page.locator('[data-tab=data]').click();
  await page.locator(selector).click();
}
async function retain(page,label) {
  const data=await page.evaluate(()=>{
    const {client,collision,...trace}=coldTrace;
    return {...trace,errors:worldEvidence.errors,info:worldEvidence.info,
      viewport:[innerWidth,innerHeight,devicePixelRatio]};
  });
  assert(data.draws.length>30,'Capture must include actual drawn startup poses');
  assert.deepEqual(data.errors,[]);
  await writeFile(new URL(`${label}.json`,output),JSON.stringify(data));
  await page.screenshot({path:fileURLToPath(new URL(`${label}.png`,output))});
  evidence.cases.push({label,draws:data.draws.length,first:data.draws[0],last:data.draws.at(-1),
    focused:data.draws.filter(d=>d.focus).length,hidden:data.draws.filter(d=>d.hidden).length});
  return data;
}
try {
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block',
    recordVideo:{dir:fileURLToPath(new URL('video/',output)),size:{width:1280,height:800}}});
  // Worker hooks live in different modules; the clock is shared through globalThis.
  const coldHooks=new Set();
  for(const [file,hooks] of [
    ['world-engine.js',[
      ['export let world,source,manifest,','const coldClock=globalThis.coldClock={input:0,steps:0};export let world,source,manifest,'],
      ['world.tick(message.throttle,message.steer,tickFlags);','world.tick(message.throttle,message.steer,tickFlags);coldClock.steps++;'],
      ['return {telemetry:Array.from(world.telemetry()),','return {coldClock:{...coldClock,remainder:accumulator},telemetry:Array.from(world.telemetry()),'],
    ]],
    ['world-worker-protocol.js',[
      ["if(message.action==='frame') {","if(message.action==='frame') {globalThis.coldClock.input+=message.dt;"],
    ]],
  ])await context.route('**/'+file,async route=>{
    const response=await route.fetch();let body=await response.text();
    for(const [before,after] of hooks){assert(body.includes(before),`Missing cold trace hook in ${file}: ${before}`);body=body.replace(before,after);coldHooks.add(before);}
    await route.fulfill({response,body});
  });
  const page=await context.newPage();
  page.on('pageerror',error=>evidence.errors.push(error.message));
  await page.goto(base);await instrument(page,'fresh');await open(page);
  await page.waitForTimeout(2000);
  await page.keyboard.down('w');await page.waitForTimeout(2000);
  await menuClick(page,'#fly');await page.waitForTimeout(1500);
  await menuClick(page,'#drive');await page.waitForTimeout(2500);await page.keyboard.up('w');
  const fresh=await retain(page,'fresh');
  const idle=fresh.draws.filter(d=>d.t<fresh.draws[0].t+1800);
  assert(Math.max(...idle.map(d=>d.p[1]))-Math.min(...idle.map(d=>d.p[1]))<.001,'Default spawn must not settle from an unrelated height');
  for(const input of fresh.inputs.filter(i=>i.flight!==i.previousFlight)){
    assert(input.pendingAfter<=input.dt+1e-9,'Mode transition must discard old-mode pending time');
  }
  await menuClick(page,'#save');
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Saved.');
  await page.reload();await instrument(page,'saved-reload');await open(page);await page.waitForTimeout(4000);
  const reload=await retain(page,'saved-reload');
  assert(reload.draws.every(d=>d.p[1]===reload.draws[0].p[1]),'A stationary saved pose must not be reseeded');
  // A new isolated origin database distinguishes tuned first spawn from a restored parked pose.
  await page.evaluate(async id=>{
    await new Promise((resolve,reject)=>{
      const request=indexedDB.deleteDatabase('vanilla-world-local-overworld');
      request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Blocked fixture reset'));
    });
    const {worldTuning}=await import('./world-store.js'),values=worldEvidence.info.tuning.slice();
    values[11]=30;await worldTuning(id,{version:1,values,cameraSeconds:.5});
  },fresh.info.id);
  await page.reload();await instrument(page,'tuned-fresh');await open(page);await page.waitForTimeout(4000);
  const tuned=await retain(page,'tuned-fresh');
  assert(Math.abs(tuned.draws[0].p[1]-fresh.draws[0].p[1]-(30-fresh.info.tuning[11]))<.001,
    'Persisted hover must determine the first visible unsaved pose');
  assert(Math.max(...tuned.draws.map(d=>d.p[1]))-Math.min(...tuned.draws.map(d=>d.p[1]))<.001,
    'Persisted hover must not launch the stationary vehicle');
  const reset=tuned.requests.find(r=>r.action==='reset'),tune=tuned.requests.find(r=>r.action==='tuning');
  assert(reset&&reset.t>=tune.end&&reset.end<=tuned.draws[0].t,'Reinitialize after tuning and before camera reveal');
  await menuClick(page,'#save');
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Saved.');
  await page.reload();await instrument(page,'tuned-saved-reload');await open(page);await page.waitForTimeout(4000);
  const restored=await retain(page,'tuned-saved-reload');
  assert(restored.draws.every(d=>d.p[1]===tuned.draws.at(-1).p[1]),'A tuned saved pose must remain exact');
  assert(!restored.requests.some(r=>r.action==='reset'),'A valid saved pose must not be replaced by a spawn reset');
  assert(restored.requests.find(r=>r.action==='tuning').end<=restored.requests.find(r=>r.action==='restore').t,
    'Tuning must still precede saved-pose validation');
  assert.deepEqual(evidence.errors,[]);
  await context.close();
} catch(error) {evidence.failure=error.stack;throw error;}
finally {
  await browser.close();
  await writeFile(new URL('summary.json',output),JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify({source:evidence.source,cases:evidence.cases.map(({label,draws,focused,hidden})=>({label,draws,focused,hidden}))}));
