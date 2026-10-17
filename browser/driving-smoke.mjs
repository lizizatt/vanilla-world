import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data folder');
const seconds=Number(process.env.DRIVE_SECONDS || 180);
assert(Number.isFinite(seconds)&&seconds>=30);
const label=process.env.RUN_LABEL || 'continuity';
assert(/^[a-z0-9-]+$/i.test(label));
const video=process.env.VIDEO==='1',sound=process.env.SOUND==='1',cpuProfile=process.env.PROFILE==='1';
const warmSeconds=Number(process.env.WARM_SECONDS || 0);
assert(Number.isFinite(warmSeconds)&&warmSeconds>=0,'WARM_SECONDS must be nonnegative');
const output=new URL(`./test-results/driving/${label}/`,import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block',
  ...(video?{recordVideo:{dir:fileURLToPath(output),size:{width:960,height:600}}}:{})});
const page=await context.newPage(),errors=[];
// Service-worker-owned fetches bypass route instrumentation; offline behavior has a separate smoke test.
await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
page.on('pageerror',e=>errors.push(e.message));
const distribution=values=>{
  if(!values.length)return null;
  const a=values.toSorted((a,b)=>a-b),at=p=>a[Math.min(a.length-1,Math.floor(a.length*p))];
  return {count:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)};
};
async function startProfiles(){
  const root=await browser.newBrowserCDPSession();
  const {targetInfos}=await root.send('Target.getTargets');
  const target=targetInfos.find(t=>t.type==='worker'&&t.url.includes('world-worker.js'));
  assert(target,'Dedicated world worker target is required for CPU attribution');
  const {sessionId}=await root.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
  let next=0;
  const pending=new Map();
  root.on('Target.receivedMessageFromTarget',event=>{
    if(event.sessionId!==sessionId)return;
    const message=JSON.parse(event.message),request=pending.get(message.id);
    if(!request)return;
    pending.delete(message.id);
    if(message.error)request.reject(new Error(message.error.message));else request.resolve(message.result);
  });
  const worker={send:(method,params={})=>new Promise((resolve,reject)=>{
    const id=++next;pending.set(id,{resolve,reject});
    root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);
  })};
  const main=await context.newCDPSession(page);
  for(const session of [main,worker]){
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
  }
  return async ()=>{
    for(const [name,session] of [['main',main],['worker',worker]]){
      const {profile}=await session.send('Profiler.stop');
      await writeFile(new URL(`${name}.cpuprofile`,output),JSON.stringify(profile));
    }
    await root.detach();await main.detach();
  };
}
try{
  const metadataSession=await browser.newBrowserCDPSession();
  const {arguments:launchArguments}=await metadataSession.send('Browser.getBrowserCommandLine');
  const version=await metadataSession.send('Browser.getVersion');
  await metadataSession.detach();
  const environment={browser:version.product,headless:true,
    osForegroundWindow:'Not applicable to this headless browser; document state is sampled separately',
    schedulingFlags:launchArguments.filter(arg=>/background|occluded|headless|throttl|frame-rate|vsync/.test(arg)),
    caches:{browserContext:'new',worker:'new',osFileCache:'uncontrolled; prior test reads may be cached',warmSeconds}};
  const startup=Date.now();
  // Instrument the original simulation time path, without changing scheduling or adding per-tick queries.
  await context.route('**/world-worker.js',async route=>{
    const response=await route.fetch();
    let body=await response.text();
    body=body.replace('let world,source,manifest,','const drivingClock={input:0,steps:0,dropped:0,objects:0,batch:0};globalThis.drivingWork=[];\nlet world,source,manifest,');
    body=body.replace(/const started=performance.now\(\);\r?\n    const p=world.telemetry\(\)/, 'drivingClock.input+=message.dt;drivingClock.batch=0;\n    const started=performance.now();\n    const p=world.telemetry()');
    body=body.replace("if(objectWait.length){accumulator=0;",'if(objectWait.length){drivingClock.objects+=message.dt+accumulator;accumulator=0;');
    body=body.replace('accumulator+=Math.min(Math.max(message.dt,0),.1);','drivingClock.dropped+=Math.max(0,message.dt-.1);accumulator+=Math.min(Math.max(message.dt,0),.1);');
    body=body.replace('world.tick(message.throttle,message.steer,message.flags);','world.tick(message.throttle,message.steer,message.flags);drivingClock.steps++;drivingClock.batch++;');
    body=body.replace('return {telemetry:Array.from(world.telemetry()),','return {drivingClock:{...drivingClock,remainder:accumulator},drivingWork:globalThis.drivingWork.splice(0),telemetry:Array.from(world.telemetry()),');
    body=body.replace('const result=await handle(data),start=performance.now();','const begin=performance.timeOrigin+performance.now();const result=await handle(data),start=performance.now();if(result.telemetry)result.transport={begin,end:performance.timeOrigin+start};');
    for(const call of ['world.add_tile(index,bytes)','scene.setTile(tileKey(index),bytes,world.tile_placements(index,bytes))','world.geometry(index)',
      'terrain.setTile(index,world.terrain_material(index))','world.horizon_seams(index)']){
      body=body.replaceAll(call,`(()=>{const started=performance.now();try{return ${call};}finally{drivingWork.push({kind:${JSON.stringify(call)},ms:performance.now()-started});}})()`);
    }
    await route.fulfill({response,body});
  });
  await page.goto(process.env.WORLD_URL || 'http://127.0.0.1:4185/?test');
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready || worldEvidence.errors.length,{},{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  assert(await page.evaluate(()=>!!worldEvidence.state.drivingClock),'Worker timing instrumentation was not installed');
  const source=process.env.SOURCE_POSE?.split(',').map(Number);
  if(source){
    assert.equal(source.length,5,'SOURCE_POSE is region,sourceX,sourceY,height,yaw');
    await page.evaluate(async ([region,x,y,height,yaw])=>{
      const r=worldEvidence.info.manifest.regions[region],tile=1600/3;
      const pose=[-y+r.placement[0]+(32-r.tile_origin[0])*tile,height,
        -x+r.placement[1]+(32-r.tile_origin[1])*tile,yaw];
      worldTest.focus([...pose.slice(0,3),0,-.3]);
      window.startPose=pose;
    },source);
    await page.waitForTimeout(6000);
    await page.evaluate(async ()=>{
      const p=startPose,s=await worldTest.request('probe',{points:[[p[0],p[2]]]});
      assertReady(s[0]);
      p[1]=Math.max(...s[0].slice(1,3).filter(Number.isFinite))+1.1;
      await worldTest.request('restore',{pose:p});
      function assertReady(s){if(s[0]!==0)throw Error(`Unavailable start surface ${s}`);}
    });
  }else if(process.env.YAW){
    await page.evaluate(async yaw=>{
      const p=worldEvidence.state.telemetry;
      await worldTest.request('restore',{pose:[...p.slice(0,3),yaw]});
    },Number(process.env.YAW));
  }
  await page.locator('#drive').click();
  if(warmSeconds)await page.waitForTimeout(warmSeconds*1000);
  if(sound){
    await page.locator('#preferences').evaluate(e=>e.open=true);
    await page.locator('#sound').check();
    await page.waitForFunction(()=>worldEvidence.audio.state==='running');
    await page.locator('#preferences').evaluate(e=>e.open=false);
  }
  const stopProfiles=cpuProfile?await startProfiles():undefined;
  await page.evaluate(async ()=>{
    const {WorldClient}=await import('./world-client.js');
    const {WorldRenderer}=await import('./world-renderer.js');
    const request=WorldClient.prototype.request,frame=WorldClient.prototype.frame,draw=WorldRenderer.prototype.draw;
    const pageState=()=>({visibility:document.visibilityState,hidden:document.hidden,
      hasFocus:document.hasFocus(),activeElement:document.activeElement?.id || document.activeElement?.tagName});
    window.driveProfile={responses:[],draws:[],samples:[],environmentEvents:[],inputs:0,clientDropped:0,start:performance.now()};
    const record=type=>driveProfile.environmentEvents.push({t:performance.now(),type,...pageState()});
    record('capture-start');
    for(const type of ['focus','blur','pagehide','pageshow'])window.addEventListener(type,()=>record(type));
    for(const type of ['visibilitychange','freeze','resume'])document.addEventListener(type,()=>record(type));
    WorldClient.prototype.frame=function(dt,...args){
      driveProfile.inputs+=dt;driveProfile.clientDropped+=Math.max(0,this.elapsed+dt-.1);
      return frame.call(this,dt,...args);
    };
    WorldClient.prototype.request=function(action,fields){
      const start=performance.now();
      return request.call(this,action,fields).then(result=>{
        if(action==='frame')driveProfile.responses.push({t:performance.now(),rtt:performance.now()-start,dt:fields.dt,
          p:result.telemetry,wait:result.scene.waitingCollision,clock:result.drivingClock,
          loads:result.loads,builds:result.timings.collisionBuilds,timings:result.timings,decoder:result.scene.decoder,
          work:result.drivingWork,transport:result.transport,sent:performance.timeOrigin+start,received:performance.timeOrigin+performance.now()});
        return result;
      });
    };
    WorldRenderer.prototype.draw=function(p,...args){
      driveProfile.draws.push([performance.now(),p[0],p[1],p[2],p[3],p[5],p[8],worldEvidence.state.scene.waitingCollision]);
      return draw.call(this,p,...args);
    };
    driveProfile.timer=setInterval(()=>driveProfile.samples.push({t:performance.now(),
      environment:pageState(),state:structuredClone(worldEvidence.state),render:structuredClone(worldEvidence.render)}),1000);
  });
  environment.startupAndWarmMs=Date.now()-startup;
  await page.locator('#world').focus();
  await page.keyboard.down('KeyW');
  if(process.env.STEER)await page.keyboard.down(process.env.STEER);
  if(process.env.WAYPOINTS)await page.evaluate(points=>{
    const p=worldEvidence.state.telemetry;
    driveProfile.waypoints=points.map(([x,z])=>[p[0]+x,p[2]+z]);
    driveProfile.waypoint=0;
    driveProfile.recoveries=[];
    driveProfile.navigation=setInterval(()=>{
      const p=worldEvidence.state.telemetry,points=driveProfile.waypoints;
      const t=(performance.now()-driveProfile.start)/1000;
      if(p[8]===3&&p[5]<1&&t>=(driveProfile.reverseUntil||0)){
        driveProfile.reverseUntil=t+1.2;
        driveProfile.waypoint++;
        driveProfile.recoveries.push({t,pose:p.slice(0,4)});
      }
      const reversing=t<(driveProfile.reverseUntil||0);
      let target=points[driveProfile.waypoint%points.length];
      if(Math.hypot(target[0]-p[0],target[1]-p[2])<30){driveProfile.waypoint++;target=points[driveProfile.waypoint%points.length];}
      const yaw=Math.atan2(p[0]-target[0],p[2]-target[1]);
      const error=Math.atan2(Math.sin(yaw-p[3]),Math.cos(yaw-p[3]));
      const steer=reversing?0:Math.max(-1,Math.min(1,error*1.5));
      const buttons=Array.from({length:17},()=>({pressed:false,value:0}));
      buttons[reversing?6:7].value=1;
      const boost=!reversing&&t%30>=10 && t%30<20;
      buttons[5]={pressed:boost,value:boost?1:0};
      worldTest.gamepads([{connected:true,mapping:'standard',index:0,
        axes:[-(Math.sign(steer)*.18+steer*.82),0,t%40>=10&&t%40<20?.5:0,0],buttons}]);
    },50);
  },JSON.parse(process.env.WAYPOINTS));
  const before=await page.evaluate(()=>structuredClone(worldEvidence.state));
  let stopped=0;
  for(let elapsed=0;elapsed<seconds;elapsed+=10){
    if(!process.env.WAYPOINTS){
      if(elapsed%30===10)await page.keyboard.down('ShiftLeft');
      if(elapsed%30===20)await page.keyboard.up('ShiftLeft');
      if(elapsed%40===10)await page.keyboard.down('ArrowRight');
      if(elapsed%40===20)await page.keyboard.up('ArrowRight');
    }
    await page.waitForTimeout(Math.min(10,seconds-elapsed)*1000);
    const progress=await page.evaluate(()=>({t:Math.round((performance.now()-driveProfile.start)/1000),
      p:worldEvidence.state.telemetry,wait:worldEvidence.state.scene.waitingCollision,clock:worldEvidence.state.drivingClock}));
    console.log(JSON.stringify(progress));
    stopped=progress.p[5]<.01&&progress.p[8]===3?stopped+1:0;
    if(process.env.WAYPOINTS && stopped>=2)break;
  }
  await page.keyboard.up('KeyW');await page.keyboard.up('ShiftLeft');await page.keyboard.up('ArrowRight');
  if(process.env.STEER)await page.keyboard.up(process.env.STEER);
  const data=await page.evaluate(()=>{clearInterval(driveProfile.timer);clearInterval(driveProfile.navigation);worldTest.gamepads([]);
    return {...driveProfile,timer:undefined,navigation:undefined,
    end:performance.now(),after:structuredClone(worldEvidence.state),errors:worldEvidence.errors,
    audio:worldEvidence.audio,adapter:worldEvidence.adapter,
    environmentEnd:{visibility:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus()}};});
  data.before=before;data.environment=environment;
  await writeFile(new URL('raw.json',output),JSON.stringify(data));
  if(stopProfiles)await stopProfiles();
  const settings={video,sound,profile:cpuProfile,...await page.evaluate(()=>{
    const canvas=document.getElementById('world'),rect=canvas.getBoundingClientRect();
    return {canvasWidth:canvas.width,canvasHeight:canvas.height,cssWidth:rect.width,cssHeight:rect.height,
      devicePixelRatio};
  })};
  const intervals=rows=>rows.slice(1).map((r,i)=>r.t-rows[i].t);
  const poseGaps=[],freezes=[],resets=[];
  let lastChange=data.draws[0],frozen;
  for(const d of data.draws.slice(1)){
    const same=d.slice(1,5).every((v,i)=>v===lastChange[i+1]);
    if(same){frozen??=lastChange;continue;}
    poseGaps.push(d[0]-lastChange[0]);
    if(frozen&&d[0]-frozen[0]>=25)freezes.push({at:frozen[0]-data.start,ms:d[0]-frozen[0],speed:frozen[5],hold:frozen[6],wait:frozen[7]});
    frozen=undefined;lastChange=d;
  }
  if(frozen)freezes.push({at:frozen[0]-data.start,ms:data.end-frozen[0],speed:frozen[5],hold:frozen[6],wait:frozen[7]});
  for(let i=1;i<data.responses.length;i++){
    const a=data.responses[i-1],b=data.responses[i];
    if(a.p[5]>2 && b.p[5]<a.p[5]*.5)resets.push({at:b.t-data.start,before:a.p,after:b.p,wait:b.wait});
  }
  const poses=[before.telemetry,...data.responses.map(r=>r.p)];
  const distance=poses.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-poses[i][0],p[2]-poses[i][2]),0);
  const movingSeconds=data.responses.slice(1).reduce((n,r,i)=>{
    const a=data.responses[i];
    return n+(r.p[5]>1&&!r.p[8]&&!r.wait&&a.p[5]>1&&!a.p[8]&&!a.wait?(r.t-a.t)/1000:0);
  },0);
  const movingFreezes=freezes.filter(f=>f.speed>1&&!f.hold&&!f.wait);
  const summary={settings,environment:{...environment,final:data.environmentEnd,
    sampleCount:data.samples.length,focusedSamples:data.samples.filter(s=>s.environment.hasFocus).length,
    hiddenSamples:data.samples.filter(s=>s.environment.hidden).length,events:data.environmentEvents},
    seconds:(data.end-data.start)/1000,distance,inputs:data.inputs,clientDropped:data.clientDropped,
    movingSeconds,waypointsReached:data.waypoint,recoveries:data.recoveries?.length,
    movingFreezes:distribution(movingFreezes.map(f=>f.ms)),
    movingFreezesOver50:movingFreezes.filter(f=>f.ms>50).length,
    renderMs:distribution(data.draws.slice(1).map((d,i)=>d[0]-data.draws[i][0])),
    stepsPerResponse:distribution(data.responses.map(r=>r.clock.batch)),
    simulationSeconds:(data.after.drivingClock.steps-before.drivingClock.steps)/120,
    clockBefore:before.drivingClock,clockAfter:data.after.drivingClock,
    responseMs:distribution(intervals(data.responses)),rttMs:distribution(data.responses.map(r=>r.rtt)),
    drawnPoseMs:distribution(poseGaps),freezes:distribution(freezes.map(f=>f.ms)),
    freezesOver50:freezes.filter(f=>f.ms>50).length,velocityResets:resets.length,
    holdsBefore:before.holds,holdsAfter:data.after.holds,before:before.telemetry,after:data.after.telemetry,errors:[...errors,...data.errors]};
  await page.screenshot({path:fileURLToPath(new URL('end.png',output))});
  await writeFile(new URL('trace.json',output),JSON.stringify({summary,freezes,resets,...data},null,2));
  console.log(JSON.stringify(summary,null,2));
  assert.deepEqual(summary.errors,[]);
  assert(distance>20,'Held throttle must actually move the vehicle');
  if(process.env.WAYPOINTS && seconds>=120)assert(movingSeconds>seconds*.9,'A stopped vehicle is not sustained driving');
  if(process.env.MAX_MOVING_FREEZE_MS)assert((summary.movingFreezes?.max || 0)<=Number(process.env.MAX_MOVING_FREEZE_MS),
    'Longest moving pose freeze exceeds requested limit');
}finally{await context.close();await browser.close();}
