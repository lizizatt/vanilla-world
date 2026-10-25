// On-demand: orbit night-side screenshots of the settlement lights (demo world, server on 4183, muted headless Edge).
// Usage: node browser/night-lights-shots.mjs  -> browser/test-results/night-lights/*.png
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const out=new URL('./test-results/night-lights/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio','--use-angle=default']});
try{
  const page=await (await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'})).newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('http://127.0.0.1:4183/?test');
  await page.waitForFunction(()=>!document.getElementById('demo')?.disabled,null,{timeout:60000});
  await page.waitForTimeout(8000);await page.click('#demo');
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  const shots=JSON.parse(process.env.SHOTS||'null')||[
    ['orbit-night',-800,5600,70000,-1.1,0],['orbit-night-east',10050,1600,60000,-1.1,0],
    ['orbit-terminator',-800,5600,70000,-1.1,240],['orbit-day',-800,5600,70000,-1.1,1440],['low-night',-800,5600,6000,-.9,0]];
  for(const [name,x,z,alt,pitch,time] of shots){
    await page.evaluate(([x,z,a,p,t])=>{worldTest.settings({planet:true,clouds:false,globeMesh:true,globeRegistry:true});worldTest.timeLock(t);worldTest.focus([x,a,z,0,p]);},[x,z,alt,pitch,time]);
    await page.waitForTimeout(6000);
    await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,out))});
  }
  console.log(JSON.stringify({errors,evidence:await page.evaluate(()=>worldEvidence.errors)}));
}finally{await browser.close();}
