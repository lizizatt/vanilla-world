// On-demand: teleport to a pole through the map panel buttons (drive or fly) and shoot the arrival view. Same env as pole-real-smoke.mjs.
//   POLE=N|S  BODY=azeroth|elune  MODE=drive|fly  SHOTS=<dir>  WORLD_URL (never 4173/4183)
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const env=process.env,pole=env.POLE||'N',body=env.BODY||'azeroth',mode=env.MODE||'drive',url=env.WORLD_URL||'http://127.0.0.1:4185/?test';
assert(env.WOW_DATA,'WOW_DATA required');assert(!/:(4173|4183)\b/.test(url),'never use 4173/4183');
const dir=env.SHOTS||'test-results/pole-teleport';await mkdir(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(url);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,{},{timeout:180000});
  await page.waitForTimeout(15000);
  if(mode==='fly'&&await page.locator('#drive').evaluate(e=>!e.hidden))await page.locator('#drive').evaluate(e=>e.click());
  await page.keyboard.press('KeyM');
  await page.locator(`.map-pole[data-pole=${pole}][data-pole-body=${body}]`).click();
  await page.waitForTimeout(Number(env.WAIT||25)*1000);
  await page.locator('#world').focus();
  await writeFile(`${dir}/teleport-${body}-${mode}-${pole}.png`,await page.screenshot());
  console.log(JSON.stringify({errors:errors.slice(0,5),frame:await page.evaluate(()=>worldTest.flightState?.().frame)}));
}finally{await browser.close();}
