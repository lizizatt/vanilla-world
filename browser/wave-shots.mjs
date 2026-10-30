// On-demand visual check of the rendered sea (needs WOW_DATA and a server on PORT or WORLD_URL; never port 4173).
//   LABEL=name PORT=4391 node browser/heavy-lock.mjs -- node browser/wave-shots.mjs      -> runtime/gate-preview/<label>/<view>.png
// VIEWS (optional env) = JSON array [{name, drive|flight, time, storm?:true, waves?:bool, marker?:true}]; default is the two user repros plus a storm view.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const label=process.env.LABEL||'waves';
assert(/^[\w-]+$/.test(label));
const out=new URL(`../runtime/gate-preview/${label}/`,import.meta.url);
await mkdir(out,{recursive:true});
const DEFAULT_VIEWS=[
  {name:'A-drive',drive:[2112.1214141845703,3.0000016689300537,8801.476272583008,0.006065424997359514],time:1549.1954},
  {name:'B-flight',flight:[2309.5663639726404,195.53125412777445,9058.633737185071,0.7288904793838261,-0.5388812038766129,-0.24870919176369657,0.34357097723871255,0.09487918123931015,0.900611271581054],time:1755.4716},
];
const views=process.env.VIEWS?JSON.parse(process.env.VIEWS):DEFAULT_VIEWS;
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const result={views:[],errors:[]};
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',error=>result.errors.push(error.message));
  page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});
  await page.goto(process.env.WORLD_URL||`http://127.0.0.1:${process.env.PORT||4391}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  for(const view of views){
    await page.evaluate(async view=>{
      const {SimClock}=await import('./sim-clock.js');
      let drive=view.drive,flight=view.flight;
      if(view.storm){
        const [mx,mz]=await worldTest.maelstrom();
        const {MAELSTROM}=await import('./cloud-config.js');
        flight=[mx-MAELSTROM.radius,view.height??6,mz,view.yaw??0,view.pitch??-.05];
      }
      if(view.coast){const r=worldEvidence.info.manifest.regions[view.coast[0]],o=32*1600/3;
        flight=[-view.coast[2]+r.placement[0]+o,view.coast[3],-view.coast[1]+r.placement[1]+o,view.yaw??0,view.pitch??-.3];}
      worldTest.settings({waves:view.waves!==false,...view.settings});
      const box=document.getElementById('ocean-waves');if(box&&box.checked!==(view.waves!==false)){box.checked=view.waves!==false;box.dispatchEvent(new Event('change'));}
      if(view.probe)window.probe=view.probe;
      const r=worldTest.renderer();
      if(view.time!==undefined){r.clock=new SimClock(view.time,1);r.timeLock=view.time;}
      if(drive)await worldTest.restore(drive);else worldTest.focus(flight);
    },view);
    await page.waitForTimeout(view.settle??9000);
    const info=await page.evaluate(()=>({render:worldEvidence.render,errors:worldEvidence.errors,
      waves:worldTest.renderer().waveStats?.()}));
    if(view.eval){info.eval=await page.evaluate(view.eval);await page.waitForTimeout(view.evalSettle??0);}
    await page.screenshot({path:fileURLToPath(new URL(`${view.name}.png`,out))});
    result.views.push({name:view.name,info});
  }
  assert.deepEqual(result.errors,[]);
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));}
console.log(JSON.stringify(result.views.map(v=>({name:v.name,waves:v.info.waves,eval:v.info.eval})),null,2));
