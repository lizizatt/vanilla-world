// On-demand: Azeroth demo world with ?bodies, camera aimed at Elune from orbit; screenshots to test-results/shared/.
// Usage: node browser/shared-smoke.mjs   (needs no WoW data; Elune's far bake is a procedural texture)
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {AZEROTH,ELUNE,centreAt,toInertial,fromInertial} from './bodies.js';

const root=new URL('./',import.meta.url),out=new URL('./test-results/shared/',import.meta.url);
await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css','.json':'application/json'};
const server=createServer(async(req,res)=>{
  let path=new URL(req.url,'http://x').pathname;if(path==='/')path='/index.html';
  try{const f=await readFile(new URL('.'+path,root));res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.end(f);}
  catch{res.statusCode=404;res.end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const port=server.address().port,T=720;
// Pose [x,y,z,yaw,pitch] at `alt` over the chart centre, aimed at Elune's centre `standoff` yd short of it.
function aimAtElune(alt,standoff=0) {
  const from=toInertial(AZEROTH,[0,alt,0],T),c=centreAt(ELUNE,T),d=c.map((v,i)=>v-from[i]),n=Math.hypot(...d),u=d.map(v=>v/n);
  const p0=fromInertial(AZEROTH,from,T),p1=fromInertial(AZEROTH,from.map((v,i)=>v+u[i]*100),T,p0[0]);
  const l=p1.map((v,i)=>v-p0[i]),m=Math.hypot(...l),L=l.map(v=>v/m);
  return [p0[0],p0[1],p0[2],Math.atan2(-L[0],-L[2]),Math.asin(L[1])-0.083];
}
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio','--enable-unsafe-webgpu','--use-angle=default','--enable-features=Vulkan']});
const errors=[];
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?bodies&test`);
  await page.waitForFunction(()=>window.worldTest,null,{timeout:60000}).catch(()=>{});
  console.log('worldTest',await page.evaluate(()=>!!window.worldTest),errors.slice(0,3),await page.evaluate(()=>document.getElementById('error')?.textContent));
  await page.click('#demo');
  await page.waitForFunction(()=>window.worldTest?.ready?.()??document.getElementById('welcome')?.hidden,null,{timeout:90000}).catch(()=>{});
  await page.waitForTimeout(6000);
  await page.evaluate(()=>{window.worldTest.settings({planet:true,globeMesh:true});window.worldTest.timeLock(720);});
  for(const [name,alt] of [['from-orbit',120000],['from-high',290000]]) {
    const pose=aimAtElune(alt);
    await page.evaluate(p=>window.worldTest.focus(p),pose);await page.waitForTimeout(3000);
    await writeFile(new URL(name+'.png',out),await page.screenshot());
  }
  // Fly into Elune's well: the shared stepper should hand off to the ?body=elune entry with the pose restored.
  const c=centreAt(ELUNE,T),a=centreAt(AZEROTH,T),dir=a.map((v,i)=>v-c[i]),dn=Math.hypot(...dir);
  const into=c.map((v,i)=>v+dir[i]/dn*(ELUNE.radius+15000)),chart=fromInertial(AZEROTH,into,T,0);
  await page.evaluate(p=>window.worldTest.focus(p),[chart[0],chart[1],chart[2],0,0]);
  await page.waitForURL(/body=elune/,{timeout:20000}).then(()=>console.log('handoff: navigated'),()=>console.log('handoff: NO navigation'));
  await page.waitForFunction(()=>window.worldTest,null,{timeout:60000}).catch(()=>{});
  await page.waitForTimeout(8000);
  await writeFile(new URL('landed.png',out),await page.screenshot());
  for(const [name,pose] of [['landed-down',[-32000,15000,0,0,-1.4]],['landed-low',[-32000,500,0,0,-.35]]]){
    await page.evaluate(p=>{window.worldTest.settings({planet:true,globeMesh:true});window.worldTest.focus(p);},pose);await page.waitForTimeout(4000);
    await writeFile(new URL(name+'.png',out),await page.screenshot());
  }
  console.log('url',page.url(),'landing flight',await page.evaluate(()=>window.worldTest?.sky?.()?1:0));
  console.log('error panel:',await page.evaluate(()=>document.getElementById('error').textContent));
}finally{await browser.close();server.close();}
console.log('errors:',errors);
process.exit(errors.length?1:0);
