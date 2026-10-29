import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';
assert(process.env.WOW_DATA&&process.env.SWE1R_DATA,'Set WOW_DATA and SWE1R_DATA');
const release=await acquireHeavyLock('pod-launch-real-data'),root=new URL('./',import.meta.url),out=new URL('./test-results/pod-launch/',root);
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,file=new URL(name==='/'?'index.html':'.'+name,root);
  if(name==='/favicon.ico'){res.writeHead(204).end();return;}
  if(!file.href.startsWith(root.href)){res.writeHead(403).end();return;}
  try{res.setHeader('content-type',mime[extname(file.pathname)]||'application/octet-stream');res.end(await readFile(file));}
  catch{res.writeHead(404).end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),errors=[];
let page;
try{
  await mkdir(out,{recursive:true});
  const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
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
  await page.evaluate(()=>{
    window.launchSamples=[];window.launchFrames=[];window.launchWork=[];let last,burnStart;
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
      if(last&&j)launchFrames.push({ms:t-last,body:j.parent,altitude:j.pose[1]});last=t;
      if(j?.mode==='orbit'&&burnStart===undefined)burnStart=j.time;
      const powered=j?.mode==='orbit'&&(j.time-burnStart)/2<16;
      pad.buttons[0]={pressed:powered,value:+powered};
      pad.buttons[7]={pressed:!j||powered,value:!j||powered?1:0};
      worldTest.gamepads([pad]);
      if(!launchSamples.length||t-launchSamples.at(-1).at>100)launchSamples.push({at:t,pod,p:worldEvidence.state.telemetry,mode:worldEvidence.mode,swaps:worldEvidence.bodySwaps||0,boost:powered,view:worldTest.renderer().view});
      requestAnimationFrame(record);
    };requestAnimationFrame(record);
  });
  await page.waitForFunction(()=>worldEvidence.state?.pod?.journey?.mode==='orbit'||worldEvidence.errors.length,null,{timeout:60000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  const cockpit=process.env.COCKPIT==='1';
  await page.evaluate(cockpit=>worldTest.settings({cockpit}),cockpit);
  if(cockpit)await page.waitForFunction(()=>worldEvidence.cockpit.active);
  await page.screenshot({path:fileURLToPath(new URL('launched.png',out))});
  await page.waitForFunction(()=>worldEvidence.state?.pod?.journey?.parent==='azeroth'||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.waitForFunction(()=>worldEvidence.bodySwaps>=2&&worldEvidence.state?.pod?.journey?.parent==='azeroth',null,{timeout:30000});
  await page.screenshot({path:fileURLToPath(new URL('handoff.png',out))});
  await page.waitForFunction(()=>!worldEvidence.state.pod.journey||worldEvidence.errors.length,null,{timeout:120000});
  const result=await page.evaluate(()=>{launchRecording=false;return {samples:launchSamples,frames:launchFrames,renderWork:launchWork,state:worldEvidence.state.pod,pose:worldEvidence.state.telemetry,errors:worldEvidence.errors,mode:worldEvidence.mode,swaps:worldEvidence.bodySwaps};});
  const p99=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length*.99)];
  result.p99=p99(result.frames.map(f=>f.ms));result.renderP99=p99(result.renderWork.map(f=>f.ms));result.placements=placements;
  await writeFile(new URL('results.json',out),JSON.stringify(result,null,2));
  await page.screenshot({path:fileURLToPath(new URL('azeroth.png',out))});
  assert.equal(result.mode,'drive');assert(result.swaps>=2);assert.equal(result.state.remaining,0);
  assert(result.samples.some(s=>s.pod.remaining===0&&s.pod.journey?.mode==='orbit'&&s.boost),'Held boost must downgrade without a release edge');
  assert(result.samples.some(s=>s.p[6]>.99&&s.pod.remaining>0),'Powered burn must fill ordinary heat gauge');
  assert(result.pose.slice(15,17).every(h=>h>0&&h<1),'Full powered burn plus held ordinary second and cooldown must survive with visible damage');
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
  assert.deepEqual([...errors,...result.errors],[]);assert(result.p99<=20,`p99=${result.p99}ms`);
  console.log(JSON.stringify({swaps:result.swaps,p99:result.p99,renderP99:result.renderP99,arrival:result.pose.slice(0,6),health:result.pose.slice(15,17),remaining:result.state.remaining,samples:result.samples.length}));
}catch(error){
  if(page)await writeFile(new URL('failure.json',out),JSON.stringify(await page.evaluate(()=>({state:worldEvidence.state,input:worldEvidence.input,errors:worldEvidence.errors,samples:window.launchSamples})),null,2));
  throw error;
}finally{await browser.close();await new Promise(r=>server.close(r));release();}
