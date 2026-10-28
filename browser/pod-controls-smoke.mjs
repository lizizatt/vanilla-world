// Real input -> worker -> Wasm -> confirmed camera smoke. Never connects to the user's live server.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data folder');
assert(process.env.SWE1R_DATA,'Set SWE1R_DATA for the Elune pod/cockpit smoke');
const release=await acquireHeavyLock('pod-controls-smoke');
const root=new URL('./',import.meta.url),out=new URL('./test-results/pod-controls/',root);
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  if(name==='/favicon.ico'){res.writeHead(204).end();return;}
  try{const file=new URL(name==='/'?'index.html':'.'+name,root);
    if(!file.href.startsWith(root.href)){res.writeHead(403).end();return;}
    res.setHeader('content-type',mime[extname(name)]|| (name==='/'?'text/html':'application/octet-stream'));
    res.end(await readFile(file));
  }catch{res.writeHead(404).end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const report=[];
const pad=({pitch=0,steer=0,rt=0,lt=0,boost=false,drift=false,hop=false,look=0}={})=>{
  const buttons=Array.from({length:17},()=>({pressed:false,value:0}));
  for(const [index,value] of [[7,rt],[6,lt],[0,+boost],[2,+drift],[5,+hop]])buttons[index]={pressed:value>.5,value};
  return {connected:true,mapping:'standard',index:0,axes:[steer,pitch,look,0],buttons};
};
try{
  await mkdir(out,{recursive:true});
  for(const body of ['azeroth','elune']){
    const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?test${body==='elune'?'&body=elune':''}`);
    if(body==='azeroth'){
      await page.waitForFunction(()=>!document.getElementById('select').disabled);
      await page.locator('#files').setInputFiles(process.env.WOW_DATA);
    }
    await page.waitForFunction(()=>window.worldEvidence?.ready||window.worldEvidence?.errors.length,null,{timeout:240000});
    assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
    if(body==='elune'){
      await page.locator('#swe1r-files').setInputFiles(process.env.SWE1R_DATA);
      await page.waitForFunction(()=>document.getElementById('swe1r-status').dataset.ok==='1',null,{timeout:60000});
      await page.evaluate(async()=>{
        const {VEHICLES}=await import('./vehicles.js');
        worldTest.selectVehicle({vehicle:'podracer',skin:VEHICLES.podracer.skins.find(s=>s.source==='swe1r').id});
      });
      await page.waitForFunction(()=>worldEvidence.render?.craftStatus==='ready');
    }
    await page.evaluate(()=>{document.getElementById('welcome').hidden=true;});
    await page.locator('#world').click();
    await page.waitForTimeout(3000);
    const spawn=await page.evaluate(()=>worldEvidence.state.telemetry.slice(0,4));
    const gamepad=async values=>page.evaluate(p=>worldTest.gamepads([p]),pad(values));
    const reset=async()=>{
      await gamepad({});
      await page.evaluate(p=>worldTest.restore(p),spawn);
      await page.locator('#world').click();
      await page.waitForTimeout(500);
    };
    await gamepad({pitch:1});
    await page.waitForFunction(()=>worldEvidence.input.pitch===1&&worldEvidence.state.telemetry[17]>.34);
    assert.equal(Math.abs(await page.evaluate(()=>worldEvidence.input.look[1])),0);
    await gamepad({pitch:-1});
    await page.waitForFunction(()=>worldEvidence.state.telemetry[17]<-.34);
    await gamepad({});
    await page.waitForFunction(()=>Math.abs(worldEvidence.state.telemetry[17])<.001);
    await reset();await gamepad({lt:.54});
    await page.waitForFunction(()=>worldEvidence.state.telemetry[14]<-1);
    assert(Math.abs(await page.evaluate(()=>worldEvidence.input.throttle)+.5)<1e-10);
    await reset();
    const paths={};
    for(const pitch of [1,-1]){
      await gamepad({pitch});
      await page.waitForFunction(p=>worldEvidence.state.telemetry[17]*p>.34,pitch);
      await page.evaluate(()=>{window.podSamples=[];window.podCapture=true;const record=()=>{
        if(!window.podCapture)return;podSamples.push({at:performance.now(),p:worldEvidence.state.telemetry.slice(),input:worldEvidence.input});
        requestAnimationFrame(record);
      };requestAnimationFrame(record);});
      await gamepad({pitch,rt:1,boost:true,hop:true});
      await page.waitForTimeout(150);
      await gamepad({pitch,rt:1,boost:true});
      await page.waitForTimeout(2400);
      const samples=await page.evaluate(()=>{podCapture=false;return podSamples;});
      assert(samples.some(s=>s.input.flags===2&&s.input.pitch===pitch));
      assert(samples.every(s=>s.p.every(Number.isFinite)&&Math.abs(s.p[17])<=20*Math.PI/180+1e-6));
      paths[pitch]={minY:Math.min(...samples.map(s=>s.p[1])),maxY:Math.max(...samples.map(s=>s.p[1])),
        traveled:Math.hypot(samples.at(-1).p[0]-spawn[0],samples.at(-1).p[2]-spawn[2]),samples};
      await reset();
    }
    assert(paths[1].maxY>paths[-1].maxY+.2,`${body}: nose-up boost must lift more than nose-down`);
    await gamepad({pitch:1,drift:true,steer:.6});
    await page.waitForFunction(()=>worldEvidence.input.flags===4&&worldEvidence.input.steer<0);
    await page.evaluate(()=>worldTest.settings({cockpit:true}));
    await page.waitForFunction(()=>worldEvidence.cockpit.active&&worldEvidence.state.telemetry[17]>.34&&worldTest.renderer().view.look[1]>.33);
    await page.screenshot({path:fileURLToPath(new URL(`${body}-cockpit.png`,out))});
    await reset();await page.evaluate(()=>worldTest.settings({cockpit:false}));
    await page.keyboard.down('ArrowDown');
    await page.waitForFunction(()=>worldEvidence.input.pitch===1&&worldEvidence.input.device==='keyboard');
    await page.keyboard.up('ArrowDown');
    await reset();
    // Same clear raceway heading as performance-smoke.mjs; the spawn heading faces a nearby obstacle.
    await page.evaluate(p=>worldTest.restore(p),[...spawn.slice(0,3),0]);
    await gamepad({rt:1,pitch:.3});
    await page.waitForFunction(()=>worldEvidence.input.throttle===1&&worldEvidence.input.device==='controller'&&worldEvidence.state.telemetry[5]>5);
    await page.evaluate(()=>{window.podFrames=[];let last;window.podPerf=true;const tick=t=>{
      if(!podPerf)return;if(last&&worldEvidence.state.telemetry[5]>5)podFrames.push(t-last);last=t;requestAnimationFrame(tick);
    };requestAnimationFrame(tick);});
    // Alternate signed thrust on the clear approach rather than eventually measuring a stationary wall hold.
    for(let i=0;i<20;i++){
      await gamepad({rt:i%2?0:1,lt:i%2?1:0,pitch:.3});
      await page.waitForTimeout(2000);
    }
    const frames=await page.evaluate(()=>{podPerf=false;return podFrames.sort((a,b)=>a-b);});
    assert(frames.length>300,`${body}: performance needs actual moving frames: ${JSON.stringify(await page.evaluate(()=>({input:worldEvidence.input,state:worldEvidence.state.telemetry,errors:worldEvidence.errors})))}`);
    const movingSeconds=frames.reduce((n,dt)=>n+dt,0)/1000;
    assert(movingSeconds>=30,`${body}: only ${movingSeconds.toFixed(1)}s of actual movement`);
    const p99=frames[Math.floor(frames.length*.99)],p95=frames[Math.floor(frames.length*.95)];
    await gamepad({});
    const result={body,spawn,gravity:(await page.evaluate(()=>worldTest.request('tuning')))[14],
      climb:paths[1],dive:paths[-1],cadence:{frames:frames.length,movingSeconds,p95,p99,max:frames.at(-1),budget:1000/30},errors};
    report.push(result);
    await context.close();
    console.log(JSON.stringify({...result,climb:{...result.climb,samples:undefined},dive:{...result.dive,samples:undefined}}));
    assert.deepEqual(errors,[]);
  }
  await writeFile(new URL('results.json',out),JSON.stringify(report,null,2));
  assert(report.every(r=>r.cadence.p99<=r.cadence.budget),'Moving-frame p99 exceeds 30 FPS budget (see results.json)');
}finally{
  if(report.length)await writeFile(new URL('results.json',out),JSON.stringify(report,null,2));
  await browser.close();await new Promise(r=>server.close(r));release();
}
