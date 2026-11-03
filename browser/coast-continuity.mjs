// Colour continuity of the sea from the western coast out to the Maelstrom: frames along a flight line, mean water colour between
// successive frames and the largest in-frame step down the screen. WOW_DATA and PORT (a running server.mjs, never 4173) required.
// START='[x,z]' (default the saved coast pose), TIMES='[1607,1000]', N=samples, PITCHES='[-0.9,-0.25]', LABEL=output folder, MAX_STEP.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {pathPoints,frameStats,stepBetween} from './coast-continuity-lib.js';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
assert(process.env.PORT&&process.env.PORT!=='4173','Set PORT to a free port that is not 4173');
const label=process.env.LABEL||'coast-continuity';
assert(/^[\w-]+$/.test(label));
const out=new URL(`./test-results/${label}/`,import.meta.url);
await mkdir(out,{recursive:true});
const start=process.env.START?JSON.parse(process.env.START):[131.07,11542.83];
const times=process.env.TIMES?JSON.parse(process.env.TIMES):[1607.3,1000];
const pitches=process.env.PITCHES?JSON.parse(process.env.PITCHES):[-.9,-.25];
const N=+process.env.N||30,MAX_STEP=+process.env.MAX_STEP||14;
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const report=[];let fail=0;
try{
  const context=await browser.newContext({viewport:{width:960,height:600},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  const centre=await page.evaluate(async()=>(await import('./clouds.js')).maelstromCentre(worldTest.manifest()));
  const points=pathPoints(start,centre,N);
  const yaw=Math.atan2(-(centre[0]-start[0]),-(centre[1]-start[1]));
  for(const time of times)for(const pitch of pitches){
    const rows=[];let prev=null;
    for(const [i,p] of points.entries()){
      await page.evaluate(([x,z,yaw,pitch,time])=>{worldTest.timeLock(time);worldTest.focus([x,15,z,yaw,pitch]);},[p.x,p.z,yaw,pitch,time]);
      await page.waitForTimeout(Number(process.env.SETTLE_MS||5000));
      const png=await page.screenshot();
      const raw=await page.evaluate(async b=>{
        const img=await createImageBitmap(new Blob([Uint8Array.from(atob(b),c=>c.charCodeAt(0))],{type:'image/png'}));
        const c=new OffscreenCanvas(img.width,img.height).getContext('2d');c.drawImage(img,0,0);
        return {width:img.width,height:img.height,data:Array.from(c.getImageData(0,0,img.width,img.height).data)};
      },png.toString('base64'));
      const s=frameStats(raw.data,raw.width,raw.height,pitch<-.5);
      const step=prev?stepBetween(prev.mean,s.mean):0;prev=s;
      rows.push({i,dist:Math.round(p.d),mean:s.mean.map(Math.round),rowStep:+s.rowStep.toFixed(1),step:+step.toFixed(1)});
      if(step>MAX_STEP||s.rowStep>MAX_STEP*2)await writeFile(fileURLToPath(new URL(`step-${time}-${pitch}-${i}.png`,out)),png);
      if(i%5===0)await writeFile(fileURLToPath(new URL(`s-${time}-${pitch}-${String(i).padStart(2,'0')}.png`,out)),png);
    }
    const worst=Math.max(...rows.map(r=>r.step));
    if(pitch<-.5&&worst>MAX_STEP)fail++;
    report.push({time,pitch,worst,rows});
    console.log(time,pitch,'worst frame step',worst,rows.filter(r=>r.step>MAX_STEP/2).map(r=>`${r.dist}:${r.step}`).join(' '));
  }
  assert.deepEqual(errors,[]);
}finally{await browser.close();await writeFile(new URL('report.json',out),JSON.stringify(report,null,1));}
process.exit(fail?1:0);
