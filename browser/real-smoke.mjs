// On-demand, real WoW data: node real-smoke.mjs <tag> ; env WOW_DATA (Data folder), PORT (dev server), QUERY (default 'bodies&test'), STEPS (json [[name,{pose:[x,y,z,yaw,pitch],time,wait}]]).
// Screenshots go to runtime/real-smoke/. Prints page errors; exit 1 on any.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';

const {WOW_DATA,PORT='4291',QUERY='bodies&test'}=process.env;
if(!WOW_DATA)throw new Error('WOW_DATA required');
const tag=process.argv[2]||'real',out=path.resolve('..','runtime','real-smoke');fs.mkdirSync(out,{recursive:true});
const ctx=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),'edge-real-')),{channel:'msedge',headless:!process.env.LAB_HEADED,args:['--mute-audio'],ignoreDefaultArgs:['--autoplay-policy=no-user-gesture-required'],viewport:{width:1280,height:720},serviceWorkers:'block'});
const page=ctx.pages()[0]||await ctx.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}`);
await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:300000});
console.log('ready',await page.evaluate(()=>worldEvidence.ready),'errors',await page.evaluate(()=>worldEvidence.errors));
await page.keyboard.press('Escape');await page.locator('[data-tab=options]').click();await page.keyboard.press('Escape');await page.locator('#world').click();
const shot=async name=>page.screenshot({path:path.join(out,`${tag}-${name}.png`)});
await page.waitForTimeout(3000);await shot('spawn');
for(const [name,step] of JSON.parse(process.env.STEPS||'[]')) {
  if(step.key)await page.keyboard.press(step.key);else await page.evaluate(s=>{window.worldTest.settings({planet:true,...s.settings});if(s.time!==undefined)window.worldTest.timeLock(s.time);window.worldTest.focus(s.pose);},step);
  await page.waitForTimeout(step.wait??6000);await shot(name);
  if(step.eval)console.log(name,JSON.stringify(await page.evaluate(step.eval)));
}
console.log('url',page.url(),'errors',errors);
await ctx.close();process.exit(errors.length?1:0);
