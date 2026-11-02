// On-demand: load a pose 600 yd short of a pole (the map has no pole teleports; poles are a secret reached by flying/driving) and shoot the arrival view. Same env as pole-real-smoke.mjs.
//   POLE=N|S  BODY=azeroth|elune  SHOTS=<dir>  WORLD_URL (never 4173/4183)
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const env=process.env,pole=env.POLE||'N',body=env.BODY||'azeroth',url=env.WORLD_URL||'http://127.0.0.1:4185/?test';
assert(env.WOW_DATA,'WOW_DATA required');assert(!/:(4173|4183)\b/.test(url),'never use 4173/4183');
const dir=env.SHOTS||'test-results/pole-teleport';await mkdir(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  const pose=encodeURIComponent(JSON.stringify({v:1,body,days:0,drive:[0,0,-600,Math.PI,pole==='N'?1:2],time:2000,settings:{}}));
  await page.goto(url+(url.includes('?')?'&':'?')+'pose='+pose);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,{},{timeout:180000});
  await page.waitForTimeout(15000);
  await page.waitForTimeout(Number(env.WAIT||25)*1000);
  await page.locator('#world').focus();
  await writeFile(`${dir}/teleport-${body}-${pole}.png`,await page.screenshot());
  console.log(JSON.stringify({errors:errors.slice(0,5),frame:await page.evaluate(()=>worldTest.flightState?.().frame)}));
}finally{await browser.close();}
