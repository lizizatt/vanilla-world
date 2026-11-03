// Screenshots inland lakes in the real world. WOW_DATA required; PORT of a running server.mjs (never 4173).
// POSES='[{"name":"orgrimmar","map":"Kalimdor","wow":[1500,-4400,60],"yaw":0,"pitch":-.5}]' overrides the defaults (wow = [x north, y west, z height]).
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
assert(process.env.PORT&&process.env.PORT!=='4173','Set PORT to a free port that is not 4173');
const label=process.env.LABEL||'lake-shader';
assert(/^[\w-]+$/.test(label));
const out=new URL(`./test-results/${label}/`,import.meta.url);
await mkdir(out,{recursive:true});
const poses=process.env.POSES?JSON.parse(process.env.POSES):[
  {name:'orgrimmar',map:'Kalimdor',wow:[1500,-4400,60],yaw:0,pitch:-.5},
  {name:'crystal-lake',map:'Azeroth',wow:[-9470,-160,95],yaw:0,pitch:-.5},
];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const result={views:[],errors:[]};
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',error=>result.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  for(const p of poses){
    const pose=p.raw||await page.evaluate(({map,wow,yaw,pitch})=>{
      const r=worldEvidence.info.manifest.regions.find(r=>r.map===map);
      return [-wow[1]+r.placement[0]+(32-r.tile_origin[0])*1600/3,wow[2],
        -wow[0]+r.placement[1]+(32-r.tile_origin[1])*1600/3,yaw,pitch];
    },p);
    await page.evaluate(({pose,time,raw})=>{if(raw)worldTest.restore(pose);else worldTest.focus(pose);if(time!==undefined)worldTest.timeLock(time);},{pose,time:p.time,raw:!!p.raw});
    await page.waitForTimeout(Number(process.env.SETTLE_MS||15000));
    await page.screenshot({path:fileURLToPath(new URL(`${p.name}.png`,out))});
    result.views.push({name:p.name,pose,sky:await page.evaluate(()=>worldTest.sky()),errors:await page.evaluate(()=>worldEvidence.errors)});
  }
  assert.deepEqual(result.errors,[]);
  console.log(JSON.stringify(result.views));
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));}
