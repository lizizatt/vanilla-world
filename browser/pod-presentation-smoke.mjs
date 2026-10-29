import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';
assert(process.env.WOW_DATA&&process.env.SWE1R_DATA,'Set WOW_DATA and SWE1R_DATA');
const release=await acquireHeavyLock('pod-presentation'),root=new URL('./',import.meta.url),out=new URL('./test-results/pod-presentation/',root);
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,file=new URL(name==='/'?'index.html':'.'+name,root);
  if(name==='/favicon.ico'){res.writeHead(204).end();return;}
  if(!file.href.startsWith(root.href)){res.writeHead(403).end();return;}
  try{
    const relative=file.href.slice(root.href.length);
    const bytes=process.env.SHOT_LABEL==='before'&&!relative.startsWith('pkg/')
      ?execFileSync('git',['show',`645d4891:browser/${relative}`],{maxBuffer:10*1024*1024,stdio:['ignore','pipe','ignore']}):await readFile(file);
    res.setHeader('content-type',mime[extname(file.pathname)]||'application/octet-stream');res.end(bytes);
  }
  catch{res.writeHead(404).end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),errors=[];
try{
  await mkdir(out,{recursive:true});
  const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#swe1r-files').setInputFiles(process.env.SWE1R_DATA);
  await page.waitForFunction(()=>document.getElementById('swe1r-status').dataset.ok==='1');
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.evaluate(async()=>{
    document.getElementById('welcome').hidden=true;
    const {VEHICLES}=await import('./vehicles.js');
    worldTest.selectVehicle({vehicle:'podracer',skin:VEHICLES.podracer.skins.find(s=>s.source==='swe1r').id});
    worldTest.settings({cameraDistance:16,cameraSeconds:.5,clouds:true,planet:true,globeMesh:true,globeRegistry:true});
    worldTest.timeLock(2013.1698666647944);
    worldTest.freezePresentation(true);
    await new Promise(resolve=>setTimeout(resolve,200));
    const pose=worldEvidence.state.telemetry.slice();
    pose.splice(0,4,-22293.523654828925,37466.550747019435,6897.77901955871,1.6022421936742066);
    pose[11]=Math.round(pose[0]);pose[12]=Math.round(pose[2]);pose[7]=0;pose[8]=0;
    worldEvidence.state.telemetry=pose;worldTest.renderer().camera=undefined;
  });
  await page.waitForTimeout(6000);
  const name=process.env.SHOT_LABEL||'after';
  await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,out))});
  const evidence=await page.evaluate(()=>({view:worldTest.renderer().view,rigid:worldTest.renderer().rigidCraftMatrix,errors:worldEvidence.errors}));
  assert.deepEqual([...errors,...evidence.errors],[]);
  assert(evidence.view.eye[1]>37000,'Capture must use the reported altitude, not the spawn');
  if(name!=='before'){
    assert.equal(evidence.rigid?.length,16);
    const sizes=[0,4,8].map(i=>Math.hypot(...evidence.rigid.slice(i,i+3)));
    assert(Math.max(...sizes)/Math.min(...sizes)<1.00001);
    assert(Math.hypot(...evidence.rigid.slice(12,15))<25,'Metric chase distance must not stretch with altitude');
  }
  await writeFile(new URL(`${name}.json`,out),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({name,errors:0,eye:evidence.view.eye}));
}finally{await browser.close();await new Promise(r=>server.close(r));release();}
