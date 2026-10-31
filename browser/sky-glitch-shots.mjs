// On-demand sky bisect at the user's "glitchy crystal in the sky" pose (needs WOW_DATA and a server on PORT, never 4173).
//   LABEL=name PORT=4561 node browser/heavy-lock.mjs -- node browser/sky-glitch-shots.mjs  -> runtime/gate-preview/<label>/<view>.png
// VIEWS (optional env) = JSON array [{name, yaw, pitch, settings, eval}] looked at from the repro position.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const label=process.env.LABEL||'sky-glitch';
assert(/^[\w-]+$/.test(label));
const out=new URL(`../runtime/gate-preview/${label}/`,import.meta.url);
await mkdir(out,{recursive:true});
const POSE={v:1,body:'azeroth',drive:[-1040.1285152435303,-55.74995803833008,11292.49234008789,2.994818925857544],time:1505.8686,
  settings:{waves:true,weather:true,clouds:true,planet:true,globeMesh:true}};
const views=process.env.VIEWS?JSON.parse(process.env.VIEWS):[{name:'default'}];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const result={views:[],errors:[]};
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',error=>result.errors.push(error.message));
  page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${process.env.PORT||4561}/?test&pose=${encodeURIComponent(JSON.stringify(POSE))}`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.waitForTimeout(12000);
  for(const view of views){
    if(view.settings)await page.evaluate(s=>worldTest.settings(s),view.settings);
    if(view.look){
      await page.evaluate(p=>worldTest.focus(p),[POSE.drive[0],POSE.drive[1]+4,POSE.drive[2],...view.look]);
    }
    if(view.eval)view.evalResult=await page.evaluate(view.eval);
    await page.waitForTimeout(view.settle??4000);
    await page.screenshot({path:fileURLToPath(new URL(`${view.name}.png`,out))});
    result.views.push({name:view.name,evalResult:view.evalResult});
  }
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));}
console.log(JSON.stringify(result,null,2));

