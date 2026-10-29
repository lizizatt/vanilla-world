// On-demand clean-checkout check of a built dist: DIST=<dir> WOW_DATA=<Data> [SWE1R_DATA=<data>] [PORT=0] node browser/dist-e2e.mjs
// Serves dist with the hosted _headers (CSP) and loads it in Edge against the user's own data via the real file-picker inputs. Fails on 404s or console errors.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import assert from 'node:assert/strict';

const {DIST,WOW_DATA,SWE1R_DATA,PORT='0'}=process.env;
assert(DIST&&WOW_DATA,'DIST and WOW_DATA required');
const root=resolve(DIST),out=resolve('test-results','dist-e2e');await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const csp=(await readFile(join(root,'_headers'),'utf8')).match(/Content-Security-Policy: (.*)/)[1];
const server=createServer(async(req,res)=>{
  let path=new URL(req.url,'http://x').pathname;if(path==='/')path='/index.html';
  try{const f=await readFile(join(root,path));res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.setHeader('Content-Security-Policy',csp);res.end(f);}
  catch{res.statusCode=404;res.end();}
}).listen(+PORT,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const HOST=process.env.HOST||'127.0.0.1',base=`http://${HOST}:${server.address().port}/`,problems=[],log=s=>console.log(s);
const browser=await chromium.launch({channel:'msedge',headless:true,args:[...(process.env.HOST?[`--host-resolver-rules=MAP ${HOST} 127.0.0.1`,`--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${PORT}`]:[]),'--mute-audio','--enable-unsafe-webgpu','--use-angle=default','--enable-features=Vulkan']});
try{
  const page=await(await browser.newContext({viewport:{width:1280,height:800}})).newPage();
  page.on('pageerror',e=>problems.push('pageerror '+e.message));
  page.on('console',m=>{if(m.type()==='error')problems.push('console '+m.text());});
  page.on('response',r=>{if(r.status()>=400)problems.push(`${r.status()} ${r.url()}`);});
  await page.goto(base);
  await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
  const sw=await page.evaluate(async()=>{await navigator.serviceWorker.ready;const keys=await caches.keys(),c=await caches.open(keys[0]);return {keys,cached:(await c.keys()).length};});
  log('service worker '+JSON.stringify(sw));
  if(SWE1R_DATA){await page.locator('#swe1r-files').setInputFiles(SWE1R_DATA);await page.waitForTimeout(8000);log('swe1r status: '+await page.locator('#swe1r-status').textContent());await page.reload();await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});await page.waitForTimeout(3000);log('swe1r status after reload: '+await page.locator('#swe1r-status').textContent());}
  await page.locator('#files').setInputFiles(WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:300000});
  log('ready '+await page.evaluate(()=>worldEvidence.ready)+' errors '+JSON.stringify(await page.evaluate(()=>worldEvidence.errors)));
  await page.evaluate(()=>document.getElementById('welcome')?.remove());
  await page.waitForTimeout(6000);
  const pos=()=>page.evaluate(()=>(worldEvidence.state?.telemetry||[]).slice(0,3).map(v=>Math.round(v)));
  const p0=await pos();await page.keyboard.down('w');await page.waitForTimeout(5000);await page.keyboard.up('w');const p1=await pos();
  log(`drive ${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`);if(JSON.stringify(p0)===JSON.stringify(p1))problems.push('vehicle did not move');
  await page.screenshot({path:join(out,'drive.png')});
  log('render npc '+await page.evaluate(()=>JSON.stringify([worldEvidence.render?.npcInstances,worldEvidence.render?.sceneInstances,worldEvidence.bodySwaps])));log('racer hud row hidden='+await page.evaluate(()=>document.getElementById('swe1r-hud-row').hidden)+' sfx row hidden='+await page.evaluate(()=>document.getElementById('swe1r-sfx-row').hidden));log('npc instances '+await page.evaluate(()=>worldEvidence.npcs??worldEvidence.info?.npcInstances??'n/a'));
  await page.keyboard.press('m');await page.waitForTimeout(4000);
  log('map status "'+await page.locator('#map-status').textContent()+'" icons '+await page.locator('.map-icon').count());
  await page.screenshot({path:join(out,'map.png')});
  const elune=page.locator('.map-icon[data-body=elune]');
  if(await elune.count()){await elune.click();await page.waitForTimeout(25000);log('after elune teleport '+JSON.stringify(await page.evaluate(()=>({errors:worldEvidence.errors,ready:worldEvidence.ready,swaps:worldEvidence.bodySwaps,pos:worldEvidence.state?.telemetry?.slice(0,3)}))));await page.screenshot({path:join(out,'elune.png')});}
  else problems.push('no Elune map button');
  log('error panel: '+await page.evaluate(()=>document.getElementById('error')?.hidden?'hidden':document.getElementById('error')?.textContent));
  await page.context().setOffline(true);await page.reload();
  await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:30000}).then(()=>log('offline reload OK'),()=>problems.push('offline reload failed'));
}finally{await browser.close();server.close();}
log('problems: '+JSON.stringify(problems,null,1));
process.exit(problems.length?1:0);
