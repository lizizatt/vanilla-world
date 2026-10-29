import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';
assert(process.env.WOW_DATA&&process.env.SWE1R_DATA,'Set WOW_DATA and SWE1R_DATA');
const orient=process.env.ORIENT==='1';
const release=await acquireHeavyLock('pod-launch-real-data'),root=new URL('./',import.meta.url),out=new URL(orient?'./test-results/pod-camera-aim/':'./test-results/pod-launch/',root);
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,file=new URL(name==='/'?'index.html':'.'+name,root);
  if(name==='/favicon.ico'){res.writeHead(204).end();return;}
  if(!file.href.startsWith(root.href)){res.writeHead(403).end();return;}
  try{
    let bytes=await readFile(file);
    if(orient&&name==='/world-worker-protocol.js')bytes=bytes.toString().replace('const result=await handle(data),start=performance.now();',
      "const began=performance.now(),result=await handle(data),start=performance.now();if(data.action==='frame')result.testHandlerMs=start-began;");
    res.setHeader('content-type',mime[extname(file.pathname)]||'application/octet-stream');res.end(bytes);
  }
  catch{res.writeHead(404).end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),errors=[],httpErrors=[];
let page;
try{
  await mkdir(out,{recursive:true});
  const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('response',response=>{if(response.status()>=400)httpErrors.push({url:response.url(),status:response.status()});});
  page.on('console',message=>{if(['warning','error'].includes(message.type()))console.log(message.type(),message.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#swe1r-files').setInputFiles(process.env.SWE1R_DATA);
  await page.waitForFunction(()=>document.getElementById('swe1r-status').dataset.ok==='1');
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.evaluate(()=>{document.getElementById('welcome').hidden=true;});
  await page.locator('#world').click();
  await page.waitForTimeout(6000);
  await page.evaluate(()=>worldTest.launch.swap('elune'));
  await page.evaluate(async()=>{
    const {VEHICLES}=await import('./vehicles.js');
    worldTest.selectVehicle({vehicle:'podracer',skin:VEHICLES.podracer.skins.find(s=>s.source==='swe1r').id});
    worldTest.focus([-300,300,120,0,-1]);
  });
  await page.waitForTimeout(6000);
  await page.evaluate(()=>worldTest.launch.save([]));
  await page.locator('#world').click();await page.keyboard.press('KeyT');
  await page.locator('#te-launch-kind').selectOption('25');
  await page.locator('#te-launch-add').click();
  await page.locator('#te-canvas').click({position:{x:640,y:360}});
  await page.waitForFunction(()=>worldTest.launch.list().length===1);
  await page.locator('#te-launch-yaw').fill('45');await page.locator('#te-launch-turn').click();
  await page.waitForFunction(()=>worldTest.launch.list()[0]?.yaw===Math.PI/4);
  await page.screenshot({path:fileURLToPath(new URL('editor.png',out))});
  await page.locator('#te-launch-remove').click();await page.waitForFunction(()=>worldTest.launch.list().length===0);
  await page.locator('#te-close').click();
  const placements=await page.evaluate(async()=>{
    await worldTest.launch.save([]);
    const ramp=await worldTest.launch.place([-300,0,0],0,'ramp',90);
    const pickup=await worldTest.launch.place([-300,0,60],0,'powerup');
    const [ground]=await worldTest.request('probe',{points:[[-300,220]]});
    await worldTest.restore([-300,Math.max(...ground.slice(1,3).filter(Number.isFinite))+3,220,0]);
    return {ramp,pickup};
  });
  await page.locator('#world').click();
  await page.evaluate(orient=>{
    window.launchSamples=[];window.launchFrames=[];window.launchWork=[];window.launchHandlers=[];let last,burnStart,lastState;
    const renderer=worldTest.renderer(),draw=renderer.draw;
    renderer.draw=function(...args){
      const start=performance.now(),result=draw.apply(this,args),j=worldEvidence.state?.pod?.journey;
      if(window.launchRecording&&j)launchWork.push({ms:performance.now()-start,body:j.parent,altitude:j.pose[1]});
      return result;
    };
    const pad={connected:true,mapping:'standard',index:0,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
    pad.buttons[7]={pressed:true,value:1};worldTest.gamepads([pad]);
    window.launchRecording=true;
    const record=t=>{
      if(!launchRecording)return;
      const pod=worldEvidence.state?.pod,j=pod?.journey;
      if(j&&worldEvidence.state!==lastState&&Number.isFinite(worldEvidence.state.testHandlerMs))launchHandlers.push(worldEvidence.state.testHandlerMs);
      lastState=worldEvidence.state;
      if(last&&j)launchFrames.push({ms:t-last,body:j.parent,altitude:j.pose[1]});last=t;
      if(j?.mode==='orbit'&&burnStart===undefined)burnStart=j.time;
      const powered=window.launchOverride?.boost??(j?.mode==='orbit'&&(orient?pod.remaining>0:(j.time-burnStart)/2<16));
      const throttle=window.launchOverride?.throttle??(!j||powered?1:0);
      pad.buttons[0]={pressed:powered,value:+powered};
      pad.buttons[7]={pressed:throttle>0,value:throttle};
      worldTest.gamepads([pad]);
      if(!launchSamples.length||t-launchSamples.at(-1).at>100)launchSamples.push({at:t,pod,p:worldEvidence.state.telemetry,mode:worldEvidence.mode,swaps:worldEvidence.bodySwaps||0,boost:powered,view:worldTest.renderer().view});
      requestAnimationFrame(record);
    };requestAnimationFrame(record);
  },orient);
  await page.waitForFunction(()=>worldEvidence.state?.pod?.journey?.mode==='orbit'||worldEvidence.errors.length,null,{timeout:60000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  const cockpit=process.env.COCKPIT==='1';
  await page.evaluate(cockpit=>worldTest.settings({cockpit}),cockpit);
  if(cockpit)await page.waitForFunction(()=>worldEvidence.cockpit.active);
  await page.screenshot({path:fileURLToPath(new URL('launched.png',out))});
  let attitude;
  if(orient){
    await page.waitForFunction(()=>worldEvidence.state.pod.journey?.pose[1]>1000);
    await page.evaluate(()=>{window.launchOverride={throttle:0,boost:false};});
    await page.waitForFunction(()=>worldEvidence.input.throttle===0&&!(worldEvidence.input.flags&2));
    const original=await page.evaluate(async()=>{
      const {inertialDir}=await import('./shared-flight.js'),{bodyOf}=await import('./bodies.js');
      window.cameraCentre=()=>{
        const j=worldEvidence.state.pod.journey,v=worldTest.renderer().view;
        return inertialDir(bodyOf(j.parent),v.eye,v.look,j.time);
      };
      const direction=worldEvidence.state.pod.journey.direction;
      return {direction,camera:cameraCentre()};
    });
    await page.mouse.move(300,300);await page.mouse.down({button:'right'});
    await page.waitForTimeout(300);
    const engage=await page.evaluate(original=>({
      cameraError:Math.hypot(...cameraCentre().map((v,i)=>v-original.camera[i])),
      attitudeError:Math.hypot(...worldEvidence.state.pod.journey.direction.map((v,i)=>v-original.direction[i])),
    }),original);
    assert(engage.cameraError<1e-5,`Engage must preserve displayed camera offset: ${engage.cameraError}`);
    assert(engage.attitudeError<1e-8,`Engage without movement must not turn the pod: ${engage.attitudeError}`);
    await page.mouse.move(693,300,{steps:24});
    await page.waitForFunction(()=>worldEvidence.state.pod.journey.freeAttitude&&Math.hypot(...cameraCentre().map((v,i)=>v-worldEvidence.state.pod.journey.direction[i]))<1e-5);
    const turned=await page.evaluate(()=>worldEvidence.state.pod.journey.direction);
    const angle=Math.acos(Math.max(-1,Math.min(1,original.camera.reduce((sum,v,i)=>sum+v*turned[i],0))));
    assert(Math.abs(angle-393*.004)<.03,`RMB drag angle ${angle}`);
    await page.screenshot({path:fileURLToPath(new URL('turned.png',out))});
    const before=await page.evaluate(()=>{window.launchOverride={throttle:1,boost:true};return worldEvidence.state.pod.journey;});
    await page.waitForFunction(remaining=>worldEvidence.state.pod.remaining<remaining-.5,before.remaining);
    await page.evaluate(()=>{window.launchOverride={throttle:0,boost:false};});
    await page.waitForFunction(()=>worldEvidence.input.throttle===0&&!(worldEvidence.input.flags&2));
    await page.waitForTimeout(100);
    attitude=await page.evaluate(async before=>{
      const after=worldEvidence.state.pod.journey,{stepLaunch}=await import('./pod-launch.js'),camera=cameraCentre();
      let coast=before;
      const ticks=Math.round((after.time-before.time)*60);
      for(let i=0;i<ticks;i++)coast=stepLaunch(coast,{throttle:0});
      const delta=after.velocity.map((v,i)=>v-coast.velocity[i]),along=delta.reduce((sum,v,i)=>sum+v*camera[i],0);
      return {before,after,camera,ticks,used:before.remaining-after.remaining,along,offAxis:Math.hypot(...delta.map((v,i)=>v-along*camera[i])),
        aimError:Math.hypot(...camera.map((v,i)=>v-after.direction[i]))};
    },before);
    attitude.angle=angle;
    attitude.engage=engage;
    assert(Math.abs(attitude.along/attitude.used-172)<.1,'Powered impulse must follow the new nose at 172 yd/s²');
    assert(attitude.offAxis<.05,`Off-axis engine impulse ${attitude.offAxis}`);
    assert(attitude.aimError<1e-5,`Camera-centre/engine misalignment ${attitude.aimError}`);
    // Undo the yaw and the normal chase-camera depression so the nose regains the ramp launch axis.
    await page.mouse.move(300,300+(cockpit?0:Math.round(Math.atan(.3)/.004)),{steps:24});
    await page.waitForFunction(direction=>Math.hypot(...worldEvidence.state.pod.journey.direction.map((v,i)=>v-direction[i]))<.003,original.direction);
    const restored=await page.evaluate(()=>worldEvidence.state.pod.journey.direction);
    assert(Math.hypot(...restored.map((v,i)=>v-original.direction[i]))<.003,'Camera aim restores the launch heading');
    await page.mouse.up({button:'right'});await page.waitForTimeout(100);
    const releaseDirection=await page.evaluate(()=>worldEvidence.state.pod.journey.direction);
    await page.waitForTimeout(300);
    const stable=await page.evaluate(()=>worldEvidence.state.pod.journey.direction);
    assert(Math.hypot(...stable.map((v,i)=>v-releaseDirection[i]))<1e-8,'Releasing RMB must retain attitude');
    Object.assign(attitude,await page.evaluate(()=>({cursor:document.getElementById('world').style.cursor,locked:!!document.pointerLockElement})));
    assert.equal(attitude.cursor,'');assert.equal(attitude.locked,false);
    await page.evaluate(()=>{window.launchOverride=undefined;});
  }
  await page.waitForFunction(()=>worldEvidence.state?.pod?.journey?.parent==='azeroth'||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.waitForFunction(()=>worldEvidence.bodySwaps>=2&&worldEvidence.state?.pod?.journey?.parent==='azeroth',null,{timeout:30000});
  await page.screenshot({path:fileURLToPath(new URL('handoff.png',out))});
  await page.waitForFunction(()=>!worldEvidence.state.pod.journey||worldEvidence.errors.length,null,{timeout:120000});
  const result=await page.evaluate(()=>{launchRecording=false;return {samples:launchSamples,frames:launchFrames,renderWork:launchWork,handlers:launchHandlers,state:worldEvidence.state.pod,pose:worldEvidence.state.telemetry,errors:worldEvidence.errors,mode:worldEvidence.mode,swaps:worldEvidence.bodySwaps};});
  const p99=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length*.99)];
  result.p99=p99(result.frames.map(f=>f.ms));result.renderP99=p99(result.renderWork.map(f=>f.ms));result.placements=placements;
  if(orient){result.attitude=attitude;result.handlerP99=p99(result.handlers);}
  // loadPopulation explicitly treats these two optional companion-pack 404s as "no creatures".
  result.optionalPackMisses=httpErrors.filter(e=>e.status===404&&['/local/npc-spawns.json','/npc-pack.json'].includes(new URL(e.url).pathname));
  result.httpErrors=httpErrors.filter(e=>!result.optionalPackMisses.includes(e));
  await writeFile(new URL('results.json',out),JSON.stringify(result,null,2));
  await page.screenshot({path:fileURLToPath(new URL('azeroth.png',out))});
  assert.equal(result.mode,'drive');assert(result.swaps>=2);assert.equal(result.state.remaining,0);
  if(!orient)assert(result.samples.some(s=>s.pod.remaining===0&&s.pod.journey?.mode==='orbit'&&s.boost),'Held boost must downgrade without a release edge');
  assert(result.samples.some(s=>s.p[6]>.99&&s.pod.remaining>0),'Powered burn must fill ordinary heat gauge');
  assert(result.pose.slice(15,17).every(h=>h>0&&h<1),'Full powered burn plus held ordinary second and cooldown must survive with visible damage');
  if(!orient){
  await page.evaluate(async()=>{worldTest.gamepads([]);window.launchActiveBody=(await import('./body-shaders.js')).activeBody;});
  await page.locator('#world').click();await page.keyboard.press('KeyM');
  await page.locator('.map-body[data-body="elune"]').click();
  await page.waitForFunction(()=>launchActiveBody().id==='elune'&&worldEvidence.mode==='drive'&&!worldEvidence.state.pod.journey,null,{timeout:60000});
  await page.waitForTimeout(2000);
  result.manualReturn=await page.evaluate(()=>({body:launchActiveBody().id,swaps:worldEvidence.bodySwaps,mode:worldEvidence.mode,pod:worldEvidence.state.pod,errors:worldEvidence.errors}));
  await writeFile(new URL('results.json',out),JSON.stringify(result,null,2));
  assert.equal(result.manualReturn.body,'elune');assert.equal(result.manualReturn.swaps,result.swaps+1);
  assert.equal(result.manualReturn.mode,'drive');assert.equal(result.manualReturn.pod.remaining,0);assert.equal(result.manualReturn.pod.journey,null);
  assert.deepEqual(result.manualReturn.errors,[]);
  }
  assert.deepEqual([...errors,...result.errors],[]);
  if(orient)assert(result.handlers.length>100&&result.handlerP99<=20,`handler p99=${result.handlerP99}ms`);
  else assert(result.p99<=20,`p99=${result.p99}ms`);
  if(orient)assert.deepEqual(result.httpErrors,[]);
  console.log(JSON.stringify({swaps:result.swaps,p99:result.p99,handlerP99:result.handlerP99,renderP99:result.renderP99,attitude:attitude&&{degrees:attitude.angle*180/Math.PI,used:attitude.used,along:attitude.along,offAxis:attitude.offAxis,aimError:attitude.aimError},arrival:result.pose.slice(0,6),health:result.pose.slice(15,17),remaining:result.state.remaining,samples:result.samples.length}));
}catch(error){
  if(page)await writeFile(new URL('failure.json',out),JSON.stringify(await page.evaluate(()=>({state:worldEvidence.state,input:worldEvidence.input,errors:worldEvidence.errors,samples:window.launchSamples})),null,2));
  throw error;
}finally{await browser.close();await new Promise(r=>server.close(r));release();}
