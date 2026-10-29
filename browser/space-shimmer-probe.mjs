// On-demand repro for planet shimmer at speed in space. Needs the dev server (WORLD_URL, never 4173/4183) and WOW_DATA; run through heavy-lock, muted.
//   ALT=37500 PITCH=-1.2 STEP=<yd per frame> N=12 SHOTS=<dir> node space-shimmer-probe.mjs
// Teleports the fly camera along a straight line STEP yd/frame at ALT, screenshots each stop, and prints the mean abs diff between consecutive
// frames and against the same pose re-shot (baseline). A stable planet changes smoothly with STEP; shimmer shows as diff >> baseline at tiny STEP.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const env=process.env,alt=Number(env.ALT||37500),pitch=Number(env.PITCH??-1.2),step=Number(env.STEP||2),n=Number(env.N||10),url=env.WORLD_URL||'http://127.0.0.1:4198/?test';
const shots=env.SHOTS?new URL(`file:///${env.SHOTS.replaceAll('\\','/')}/`):undefined;
assert(env.WOW_DATA,'WOW_DATA required');assert(!/:(4173|4183)\b/.test(url),'never use 4173/4183');
if(shots)await mkdir(shots,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const context=await browser.newContext({viewport:{width:960,height:600},serviceWorkers:'block'});
await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
if(env.NEAR)await context.route('**/world-camera.js',async route=>{const response=await route.fetch(),text=(await response.text()).replace('near:Math.max(.1,Math.min(100,Math.abs(flight[1])*.01))','near:'+env.NEAR);await route.fulfill({response,body:text});});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.goto(url);
await page.waitForFunction(()=>!document.getElementById('select').disabled);
await page.locator('#files').setInputFiles(env.WOW_DATA);
await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,{},{timeout:180000});
if(await page.locator('#drive').evaluate(e=>!e.hidden))await page.locator('#drive').evaluate(e=>e.click());
const spawn=await page.evaluate(()=>worldTest.manifest().spawn);
const x0=Number(env.X??spawn[0]),z0=Number(env.Z??spawn[2]),yaw=Number(env.YAW||0);
await page.evaluate(([x,a,z,y,p,t,c])=>{worldTest.settings({planet:true,clouds:c});worldTest.timeLock(t);worldTest.focus([x,a,z,y,p]);},[x0,alt,z0,yaw,pitch,Number(env.TIME||1440),env.CLOUDS!=='0']);
await page.waitForTimeout(Number(env.SETTLE||12000));
const grab=async()=>(await page.screenshot({type:'png'})).toString('base64');
const diff=(a,b)=>page.evaluate(async([a,b])=>{const px=async s=>{const bm=await createImageBitmap(new Blob([Uint8Array.from(atob(s),c=>c.charCodeAt(0))],{type:'image/png'})),c=new OffscreenCanvas(bm.width,bm.height),g=c.getContext('2d');g.drawImage(bm,0,0);return g.getImageData(0,0,bm.width,bm.height).data;};const A=await px(a),B=await px(b),w=960,h=600;let s=0,hi=0;for(let i=0;i<A.length;i+=4){const d=(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]))/3;s+=d;if(d>24)hi++;}const o=new OffscreenCanvas(w,h),og=o.getContext('2d'),out=og.createImageData(w,h);for(let i=0;i<A.length;i+=4){const d=Math.min(255,(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]))*4);out.data[i]=out.data[i+1]=out.data[i+2]=d;out.data[i+3]=255;}og.putImageData(out,0,0);const png=await o.convertToBlob({type:'image/png'}),buf=new Uint8Array(await png.arrayBuffer());let bin='';for(const v of buf)bin+=String.fromCharCode(v);window.__lastDiff=btoa(bin);return {mean:+(s/(A.length/4)).toFixed(3),hiFrac:+(hi/(A.length/4)).toFixed(5)};},[a,b]);
const frames=[];
const base1=await grab();await page.evaluate(([x,a,z,y,p])=>worldTest.focus([x,a,z,y,p]),[x0,alt,z0,yaw,pitch]);await page.waitForTimeout(Number(env.WAIT||1200));const baseline=await diff(base1,await grab());
for(let i=0;i<n;i++){
  await page.evaluate(([x,a,z,y,p])=>worldTest.focus([x,a,z,y,p]),[x0,alt,z0+i*step,yaw,pitch]);
  await page.waitForTimeout(Number(env.WAIT||1200));
  const f=await grab();frames.push(f);
  if(shots)await writeFile(new URL(`shimmer-${i}.png`,shots),Buffer.from(f,'base64'));
}
await writeFile(new URL('baseline-diff.png',shots),Buffer.from(await page.evaluate(()=>window.__lastDiff),'base64'));const consecutive=[];for(let i=1;i<frames.length;i++)consecutive.push(await diff(frames[i-1],frames[i]));
if(shots)await writeFile(new URL('step-diff.png',shots),Buffer.from(await page.evaluate(()=>window.__lastDiff),'base64'));console.log(JSON.stringify({alt,pitch,step,baseline,consecutive,errors:errors.slice(0,5)},null,1));
await browser.close();
process.exit(errors.length?1:0);
