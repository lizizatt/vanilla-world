// On-demand real-data gate: drive or fly over a pole (or around the east-west wrap) on a real body world with the N/S frame regions loaded.
// Needs the dev server (WORLD_URL, default http://127.0.0.1:4185/?test; never 4173/4183) and WOW_DATA. Run through heavy-lock, muted.
//   BODY=azeroth|elune  MODE=drive|fly  LAT=<start deg>  LON=<start deg>  HEADING=north|south|east  SECONDS=40  SHOTS=<dir>
// Prints one JSON summary; exits non-zero on page errors, handler p99 > 20 ms, or a missing pole crossing/wrap.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const env=process.env,body=env.BODY||'azeroth',mode=env.MODE||'drive',lat=Number(env.LAT??(body==='azeroth'?66:54)),lon=Number(env.LON??0);
const heading=env.HEADING||'north',seconds=Number(env.SECONDS||40),url=env.WORLD_URL||'http://127.0.0.1:4185/?test';
const shots=env.SHOTS?new URL(`file:///${env.SHOTS.replaceAll('\\','/')}/`):undefined;
assert(env.WOW_DATA,'WOW_DATA required');assert(!/:(4173|4183)\b/.test(url),'never use 4173/4183');
if(shots)await mkdir(shots,{recursive:true});
const dist=v=>{if(!v.length)return null;const a=v.toSorted((x,y)=>x-y),at=p=>a[Math.min(a.length-1,Math.floor(a.length*p))];return {count:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)};};
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
for(const file of ['world-worker.js','world-engine.js','world-worker-protocol.js'])await context.route('**/'+file,async route=>{
  const response=await route.fetch();let text=await response.text();
  text=text.replace('const result=await handle(data),start=performance.now();','const begin=performance.timeOrigin+performance.now();const result=await handle(data),start=performance.now();if(result.telemetry)result.transport={begin,end:performance.timeOrigin+start};');
  await route.fulfill({response,body:text});
});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/world-map-art\.jpg/.test(m.location().url||''))errors.push(m.text()+(m.location().url?' '+m.location().url:''));});
const summary={body,mode,lat,lon,heading};
try{
  await page.goto(url);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,{},{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  if(body!=='azeroth') {
    await page.waitForTimeout(20000);
    await page.keyboard.press('KeyM');
    await page.locator(`.map-body[data-body=${body}]`).click();
    await page.waitForFunction(async b=>(await import('./body-shaders.js')).activeBody().id===b,body,{timeout:120000});
    await page.waitForTimeout(8000);
  }
  await page.evaluate(()=>{window.__handler=[];});
  await page.evaluate(async()=>{
    const {WorldClient}=await import('./world-client.js'),request=WorldClient.prototype.request;
    WorldClient.prototype.request=function(action,fields){const p=request.call(this,action,fields);return action==='frame'?p.then(r=>{if(r?.transport)__handler.push(r.transport.end-r.transport.begin);return r;}):p;};
  });
  // Start pose on the authored chart at (LAT, LON), heading by compass: yaw 0 = north (-z), +yaw turns left (west).
  const start=await page.evaluate(async([bodyId,latDeg,lonDeg,head])=>{
    const {bodyOf}=await import('./bodies.js'),{dirToChart}=await import('./frames.js'),b=bodyOf(bodyId),la=latDeg*Math.PI/180,lo=lonDeg*Math.PI/180;
    const [x,z]=dirToChart('E',[Math.cos(la)*Math.cos(lo),Math.sin(la),Math.cos(la)*Math.sin(lo)],b.centre,b.radius,lo);
    return {x,z,yaw:head==='north'?0:head==='south'?Math.PI:-Math.PI/2,radius:b.radius};
  },[body,lat,lon,heading]);
  if(env.POLEFRAME){const a=(90-lat)*Math.PI/180*start.radius;Object.assign(start,{x:0,z:(env.POLEFRAME==='N'?-200000:200000)-a,frame:env.POLEFRAME});}// start inside a pole frame (lat = degrees from the equator of the body, measured to the pole)
  summary.start=start;
  const height=body==='azeroth'?40:60;
  if(mode==='fly') {
    if(await page.locator('#drive').evaluate(e=>!e.hidden))await page.locator('#drive').evaluate(e=>e.click());
    await page.evaluate(s=>worldTest.focus([s.x,300,s.z,s.yaw,0],s.frame),start);
  } else {
    await page.evaluate(async([s,h])=>{
      const tries=[];for(let i=0;i<400;i++){try{await worldTest.request('restore',{pose:[s.x,h,s.z,s.yaw]});return;}catch(e){tries.push(e.message);await new Promise(r=>setTimeout(r,50));}}
      throw Error('restore never succeeded '+tries.at(-1));
    },[start,height]);
    if(await page.locator('#drive').evaluate(e=>!e.hidden))await page.locator('#drive').evaluate(e=>e.click());
  }
  await page.locator('#world').focus();
  await page.waitForTimeout(3000);
  await page.evaluate(()=>{__handler.length=0;});
  await page.keyboard.down('w');if(mode==='fly')await page.keyboard.down('Shift');
  const frames=[],samples=[];let lastFrame=-1,shot=0;
  for(let i=0;i<seconds*4;i++) {
    await page.waitForTimeout(250);
    const s=await page.evaluate(()=>({t:Array.from(worldEvidence.state.telemetry.slice(0,4)),f:worldEvidence.state.frame?Array.from(worldEvidence.state.frame):null,fl:worldTest.flightState?.().flight?.slice(0,4),fr:worldTest.flightState?.().frame}));
    samples.push(s);
    const f=mode==='fly'?['E','N','S'].indexOf(s.fr):s.f?.[0];
    if(f>=0&&f!==lastFrame){frames.push({sec:i/4,frame:f,hops:s.f?.[2],wraps:s.f?.[1]});lastFrame=f;if(shots)await writeFile(new URL(`${body}-${mode}-frame${f}-${shot++}.png`,shots),await page.screenshot());}
    if(shots&&i%20===19)await writeFile(new URL(`${body}-${mode}-t${i/4}.png`,shots),await page.screenshot());
  }
  await page.keyboard.up('w');if(mode==='fly')await page.keyboard.up('Shift');
  const last=samples.at(-1),handler=await page.evaluate(()=>__handler.slice());
  if(env.TRACE)console.log(samples.filter((_,i)=>i%8===0).map((s,i)=>[i*2,s.f?.[0],Math.round(s.t[0]),Math.round(s.t[2]),s.f?.[3]|0,s.f?.[4]|0].join(',')).join(' | '));
  Object.assign(summary,{frames,hops:last.f?.[2]??null,wraps:last.f?.[1]??null,endTelemetry:mode==='fly'?last.fl:last.t,handlerMs:dist(handler),errors:errors.length,errorText:errors.slice(0,5)});
  console.log(JSON.stringify(summary));
  const verdict=[errors.length&&'page errors',summary.handlerMs&&summary.handlerMs.p99>20&&'handler p99 over 20 ms',
    heading!=='east'&&!frames.some(f=>f.frame>0)&&'never entered a pole frame',
    mode==='drive'&&heading==='east'&&!(last.f?.[1])&&'no longitude wrap'].filter(Boolean);
  if(verdict.length){console.log('FAIL: '+verdict.join('; '));process.exitCode=1;}
}finally{await browser.close();}
