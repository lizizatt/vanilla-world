// Ascent continuity over open generated ocean: log-spaced altitude 10 -> 500k yd, mean-luma/colour step between frames.
// Usage: node ascent-continuity.mjs [sites=open,mael] [pitches=-1.5708,-0.785]   Fails (exit 1) if an open-sea step exceeds MAX_STEP.
import path from 'node:path';
import fs from 'node:fs/promises';
import {openLab, out} from './race-gate-lab.mjs';
const N=40,MAX_STEP=+process.env.MAX_STEP||30;
const {ctx,page}=await openLab({clouds:true});
await page.waitForFunction(()=>window.worldTest?.manifest&&worldTest.manifest(),null,{timeout:90000});
const spawn=await page.evaluate(()=>worldTest.manifest().spawn);
const maelstrom=await page.evaluate(async()=>(await import('./clouds.js')).maelstromCentre(worldTest.manifest()));
const stats=b64=>page.evaluate(async b=>{
  const img=await createImageBitmap(new Blob([Uint8Array.from(atob(b),c=>c.charCodeAt(0))],{type:'image/png'}));
  const c=new OffscreenCanvas(img.width,img.height).getContext('2d');c.drawImage(img,0,0);
  const d=c.getImageData(0,0,img.width,img.height).data;let r=0,g=0,bl=0,n=0;
  for(let i=0;i<d.length;i+=64){r+=d[i];g+=d[i+1];bl+=d[i+2];n++;}
  return [r/n,g/n,bl/n];},b64);
const sites={open:[spawn[0]-200000,spawn[2]+20000],mael:maelstrom};
let fail=0;const report=[];
for(const [name,[x,z]] of Object.entries(sites))for(const pitch of [-1.5708,-.785]){
  let prev=null;const row=[];
  for(let i=0;i<N;i++){
    const alt=10*Math.pow(50000,i/(N-1));
    await page.evaluate(([x,z,a,p])=>{worldTest.settings({planet:true,clouds:true});worldTest.timeLock(1440);worldTest.focus([x,a,z,0,p]);},[x,z,alt,pitch]);
    await page.waitForTimeout(alt>20000?2500:3500);
    const png=await page.screenshot(),s=await stats(png.toString('base64'));
    const step=prev?Math.max(...s.map((v,k)=>Math.abs(v-prev[k]))):0;prev=s;
    row.push({alt:Math.round(alt),rgb:s.map(Math.round),step:+step.toFixed(1)});
    // The Maelstrom storm wall is real bright cloud content, so only the open-sea site gates; its steps are reported.
    if(step>MAX_STEP){if(name==='open')fail++;await fs.writeFile(path.join(out,`ascent-${name}-${pitch}-${i}.png`),png);}
  }
  report.push({site:name,pitch,max:Math.max(...row.map(r=>r.step)),row});
  console.log(name,pitch,'maxStep',report.at(-1).max,row.filter(r=>r.step>MAX_STEP/2).map(r=>`${r.alt}:${r.step}`).join(' '));
}
await fs.writeFile(path.join(out,'ascent-continuity.json'),JSON.stringify(report));
console.log('POPS',fail);await ctx.close();process.exit(fail?1:0);
