// On-demand: opens a pole frame as the Elune body-world (?body=elune&poleFrame=<body>:<N|S>), then measures the real engine:
// open-to-first-resident-tile, a teleport arrival at the cap rim, and the frame-handler time while driving across the pole.
// Needs browser/pkg and no game data. Usage: node pole-drive-smoke.mjs [frame=elune:N] [seconds=20]  -> test-results/pole-drive/<frame>/*.png + summary.json
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import assert from 'node:assert/strict';

const frame=process.argv[2]||'elune:N',seconds=Number(process.argv[3]||20),rimYd=Number(process.env.RIM||3200);
const root=new URL('./',import.meta.url),out=new URL(`./test-results/pole-drive/${frame.replace(':','-')}/`,import.meta.url);
await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css','.json':'application/json'};
const server=createServer(async(req,res)=>{
  let path=new URL(req.url,'http://x').pathname;if(path==='/')path='/index.html';
  try{const f=await readFile(new URL('.'+path,root));res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.end(f);}
  catch{res.statusCode=404;res.end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const port=server.address().port;assert.notEqual(port,4173);assert.notEqual(port,4183);
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const errors=[],dist=v=>{if(!v.length)return null;const a=v.toSorted((x,y)=>x-y),at=p=>a[Math.min(a.length-1,Math.floor(a.length*p))];return {count:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)};};
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  // Same worker-side stamp the driving smoke uses: handler time = begin..end of one frame request inside the worker.
  for(const file of ['world-worker.js','world-engine.js','world-worker-protocol.js'])await context.route('**/'+file,async route=>{
    const response=await route.fetch();let body=await response.text();
    body=body.replace('const result=await handle(data),start=performance.now();','const begin=performance.timeOrigin+performance.now();const result=await handle(data),start=performance.now();if(result.telemetry)result.transport={begin,end:performance.timeOrigin+start};');
    await route.fulfill({response,body});
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.addInitScript(()=>{window.__handler=[];window.__t0=performance.now();});
  const t0=Date.now();
  await page.goto(`http://127.0.0.1:${port}/?body=elune&poleFrame=${frame}&bodies=0&test`);
  await page.waitForFunction(()=>window.worldEvidence?.ready||window.worldEvidence?.errors?.length,null,{timeout:120000});
  const openMs=Date.now()-t0;
  await page.evaluate(async()=>{
    const {WorldClient}=await import('./world-client.js'),request=WorldClient.prototype.request;
    WorldClient.prototype.request=function(action,fields){const p=request.call(this,action,fields);return action==='frame'?p.then(r=>{if(r?.transport)__handler.push(r.transport.end-r.transport.begin);return r;}):p;};
  });
  const poll=(fn,arg)=>page.evaluate(async([src,a])=>{const f=eval(src),t=performance.now();for(;;){if(f(a))return performance.now()-t;if(performance.now()-t>60000)return -1;await new Promise(r=>setTimeout(r,16));}},[fn.toString(),arg]);
  const resident=await page.evaluate(()=>worldEvidence.state.resident?.length??0);
  await writeFile(new URL('pole.png',out),await page.screenshot());
  // Arrival: restore to the cap rim and time until the tiles under the pod are resident.
  const arrival=await page.evaluate(async rim=>{
    const t=performance.now();let tries=0;
    worldTest.focus([rim,400,0,0,-.3]);
    for(;;){
      tries++;
      try{await worldTest.request('restore',{pose:[rim,400,0,Math.PI/2]});return {ms:performance.now()-t,tries};}
      catch(e){if(performance.now()-t>60000)return {ms:-1,tries,error:e.message};await new Promise(r=>setTimeout(r,16));}
    }
  },rimYd);
  await page.evaluate(()=>{__handler.length=0;});
  if(await page.locator('#drive').evaluate(e=>!e.hidden))await page.locator('#drive').evaluate(e=>e.click());
  await page.locator('#world').focus();
  const start=await page.evaluate(()=>worldEvidence.state.telemetry.slice(0,4));
  await page.keyboard.down('w');
  const samples=[];let poleShot=false;
  for(let i=0;i<seconds*4;i++){
    await page.waitForTimeout(250);const t=await page.evaluate(()=>worldEvidence.state.telemetry.slice(0,4));
    if(i%4===3)samples.push(t);
    if(!poleShot&&Math.abs(t[0])<250){poleShot=true;await writeFile(new URL('pole-pass.png',out),await page.screenshot());}
    if(i===seconds*2)await writeFile(new URL('drive.png',out),await page.screenshot());
  }
  await page.keyboard.up('w');
  const handler=await page.evaluate(()=>__handler.slice());
  const end=samples.at(-1),travelled=Math.hypot(end[0]-start[0],end[2]-start[2]);
  const summary={frame,openMs,residentAtOpen:resident,arrival,travelled,samples:samples.filter((_,i)=>i%5===4).map(s=>s.map(v=>+v.toFixed(1))),handlerMs:dist(handler),errors:errors.length,pageErrors:errors.slice(0,5)};
  await writeFile(new URL('summary.json',out),JSON.stringify(summary,null,1));
  console.log(JSON.stringify(summary));
  const crossed=samples.some(s=>s[0]<-40);
  const verdict=[!crossed&&'did not cross the pole',summary.handlerMs.p99>20&&'handler p99 over 20 ms',errors.length&&'page errors',arrival.ms<0&&'arrival never resident'].filter(Boolean);
  if(verdict.length){console.log('FAIL: '+verdict.join('; '));errors.push(...verdict);}
}finally{await browser.close();server.close();}
process.exit(errors.length?1:0);
