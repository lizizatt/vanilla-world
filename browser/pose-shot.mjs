// Screenshot a ?pose= link against the real data. Usage: WOW_DATA=... PORT=n POSE_JSON=file SHOT=name node browser/pose-shot.mjs
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const out=new URL('./test-results/pose-shot/',import.meta.url);
await mkdir(out,{recursive:true});
const pose=(await readFile(process.env.POSE_JSON,'utf8')).trim();
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const errors=[];
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT}/?pose=${encodeURIComponent(pose)}${process.env.TEST?'&test':''}`);
  await page.waitForFunction(()=>!document.getElementById('select')?.disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  await page.waitForTimeout(Number(process.env.WAIT||20000));
  const info=await page.evaluate(()=>({errors:worldEvidence.errors,render:worldEvidence.render}));
  if(process.env.EVAL)console.log(JSON.stringify(await page.evaluate(process.env.EVAL)));
  await page.screenshot({path:fileURLToPath(new URL(`${process.env.SHOT||'shot'}.png`,out))});
  console.log(JSON.stringify({errors:[...errors,...info.errors],render:info.render}).slice(0,1500));
}finally{await browser.close();}
