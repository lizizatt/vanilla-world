// Culling/visibility audit (muted Edge). Seeded random camera poses; flags void pixels where ground/sea is expected and popping across tiny moves.
// Usage: node audit-culling.mjs [count=40] [seed=1]   Output: runtime/gate-preview/audit-*.png for failures + JSON summary.
import path from 'node:path';
import {openLab, out} from './race-gate-lab.mjs';
import {PLANET_RADIUS} from './space.js';
const count=+process.argv[2]||40;let seed=+process.argv[3]||1;
const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
const {ctx,page}=await openLab({clouds:true});
await page.waitForFunction(()=>window.worldTest?.manifest&&worldTest.manifest(),null,{timeout:90000});
const spawn=await page.evaluate(()=>worldTest.manifest().spawn);
const maelstrom=await page.evaluate(async()=>(await import('./clouds.js')).maelstromCentre(worldTest.manifest()));
const analyse=(b64)=>page.evaluate(async b=>{
  const img=await createImageBitmap(new Blob([Uint8Array.from(atob(b),c=>c.charCodeAt(0))],{type:'image/png'}));
  const c=new OffscreenCanvas(img.width,img.height).getContext('2d');c.drawImage(img,0,0);
  const d=c.getImageData(0,0,img.width,img.height).data;let dark=0,n=0;
  const small=new Uint8Array(32*18);
  for(let y=0;y<img.height;y+=4)for(let x=0;x<img.width;x+=4){const i=(y*img.width+x)*4,l=(d[i]+d[i+1]+d[i+2])/3;n++;if(l<10)dark++;
    if(x%40===0&&y%40===0)small[(y/40|0)*32+(x/40|0)]=l;}
  return {dark:dark/n,small:[...small]};},b64);
const classes=[['ground',()=>[spawn[0]+(rnd()-.5)*4000,spawn[2]+(rnd()-.5)*4000]],
  ['maelstrom',()=>[maelstrom[0]+(rnd()-.5)*5000,maelstrom[1]+(rnd()-.5)*5000]],
  ['openSea',()=>[spawn[0]+PLANET_RADIUS*1.4*(rnd()<.5?-1:1)*rnd(),spawn[2]+(rnd()-.5)*PLANET_RADIUS*.5]],
  ['pole',()=>[spawn[0]+(rnd()-.5)*PLANET_RADIUS*6,-(rnd()<.5?-1:1)*PLANET_RADIUS*1.45+-267]]];
// altitudes in fractions of R (the old list was tuned for R=42,781: 20 kyd was 0.47 R)
const alts=[50,200,500,2000,5000,20000,100000].map((a,i)=>i<2?a:Math.round(a*PLANET_RADIUS/42781));
const VOID_ALT=Math.round(20000*PLANET_RADIUS/42781);
const results=[];
for(let i=0;i<count;i++){
  const [cls,pos]=classes[i%classes.length],[x,z]=pos(),alt=alts[Math.floor(rnd()*alts.length)],pitch=-(.3+rnd()*1.2),yaw=rnd()*6.28;
  const shot=async dx=>{await page.evaluate(([x,z,a,p,y])=>{worldTest.settings({planet:true,clouds:false});worldTest.timeLock(1440);worldTest.focus([x,a,z,y,p]);},[x+dx,z,alt,pitch,yaw]);
    await page.waitForTimeout(alt>.23*PLANET_RADIUS?2500:4000);return page.screenshot();};
  const a=await shot(0),ra=await analyse(a.toString('base64')),b=await shot(2),rb=await analyse(b.toString('base64'));
  const pop=ra.small.reduce((s,v,k)=>s+Math.abs(v-rb.small[k]),0)/ra.small.length;
  // Looking down below 20 kyd the frame should be ground/sea; near-black means void or culled geometry.
  const issues=[];if(alt<VOID_ALT&&ra.dark>.02)issues.push('void '+ra.dark.toFixed(3));if(pop>30)issues.push('pop '+pop.toFixed(1));
  const r={i,cls,x:Math.round(x),z:Math.round(z),alt,pitch:+pitch.toFixed(2),yaw:+yaw.toFixed(2),dark:+ra.dark.toFixed(3),pop:+pop.toFixed(1),issues};
  results.push(r);console.log(JSON.stringify(r));
  if(issues.length)await (await import('node:fs/promises')).writeFile(path.join(out,`audit-${i}-${cls}.png`),a);
}
console.log('FAILURES',results.filter(r=>r.issues.length).length,'/',results.length);
await ctx.close();
