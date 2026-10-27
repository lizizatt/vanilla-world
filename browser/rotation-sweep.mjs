// On-demand, real WoW data: sweep the camera round Azeroth in latitude (lon fixed) and compare each screenshot with the CPU-predicted land mask and Maelstrom position.
// node rotation-sweep.mjs <tag> ; env WOW_DATA, PORT, LON (deg, default 45), ALT (default 30000), STEP (deg, default 20), CLOUDS (1/0, default 0)
// Writes runtime/real-smoke/<tag>-<i>.png and <tag>-<i>.json (predicted grid, storm pixel, visibility); analyse with rotation-sweep-check.py.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';

const {WOW_DATA,PORT='4291',LON='45',ALT='30000',STEP='20',CLOUDS='0'}=process.env;
if(!WOW_DATA)throw new Error('WOW_DATA required');
const tag=process.argv[2]||'rotsweep',out=path.resolve('..','runtime','real-smoke');fs.mkdirSync(out,{recursive:true});
const ctx=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),'edge-rot-')),{channel:'msedge',headless:true,args:['--mute-audio'],viewport:{width:1280,height:720},serviceWorkers:'block'});
const page=ctx.pages()[0]||await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/?test&flight&planet`);
await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:300000});
await page.keyboard.press('Escape');if(await page.locator('[data-tab=options]').isVisible()){await page.locator('[data-tab=options]').click();await page.keyboard.press('Escape');}await page.evaluate(()=>document.getElementById('welcome')?.remove());await page.locator('#world').click();
await page.waitForTimeout(15000);
const lats=[];for(let l=-180;l<180;l+=+STEP)lats.push(l);
for(const [i,lat] of lats.entries()) {
  await page.evaluate(async ([lat,lon,alt,clouds])=>{
    const s=await import('./space.js'),p=s.globeToFlat(lat*Math.PI/180,lon*Math.PI/180,s.WORLD_CENTRE,s.PLANET_RADIUS),w=s.wrapFlat(p[0],p[1],s.WORLD_CENTRE,s.PLANET_RADIUS);
    worldTest.settings({planet:true,globeMesh:true,globeRegistry:true,clouds:!!clouds,timeScale:0});worldTest.timeLock(1813);worldTest.focus([w[0],alt,w[1],0,-1.45]);
  },[lat,+LON,+ALT,CLOUDS==='1']);
  await page.waitForTimeout(7000);
  await page.screenshot({path:path.join(out,`${tag}-${String(i).padStart(2,'0')}.png`)});
  const pred=await page.evaluate(async ()=>{
    const s=await import('./space.js'),pf=await import('./planet-frame.js'),cl=await import('./clouds.js'),r=worldTest.renderer(),v=r.view,R=s.PLANET_RADIUS,C=s.WORLD_CENTRE;
    const f=s.planetFrame(v.eye[0],v.eye[2],C,R),alt=Math.max(0,v.eye[1]),centre=[0,-(R+alt),0],W=1280,H=720,G=8;
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],rows=[];
    const toPl=n=>[0,1,2].map(k=>f.east[k]*n[0]+f.up[k]*n[1]+f.south[k]*n[2]);
    const project=pl=>{const n=[dot(pl,f.east),dot(pl,f.up),dot(pl,f.south)],P=[0,1,2].map(k=>centre[k]+R*n[k]),L=Math.hypot(...P),d=P.map(x=>x/L),front=dot(n,P.map(x=>-x))>0,z=dot(d,v.look);
      return {x:((dot(d,v.right)/z/(.55*v.aspect))+1)/2*W,y:(1-dot(d,v.up)/z/.55)/2*H,front,z};};
    for(let py=G/2;py<H;py+=G){const row=[];for(let px=G/2;px<W;px+=G){
      const nx=px/W*2-1,ny=1-py/H*2,d0=[0,1,2].map(k=>v.look[k]+v.right[k]*nx*.55*v.aspect+v.up[k]*ny*.55),L=Math.hypot(...d0),d=d0.map(x=>x/L);
      const oc=[0,1,2].map(k=>-centre[k]),b=dot(oc,d),q=dot(oc,oc)-R*R,disc=b*b-q;
      if(disc<=0){row.push(-1);continue;}
      const t=-b-Math.sqrt(disc);if(t<=0){row.push(-1);continue;}
      const n=[0,1,2].map(k=>(d[k]*t-centre[k])/R),pv=toPl(n),lat=Math.asin(Math.max(-1,Math.min(1,pv[1]))),lon=Math.atan2(pv[2],pv[0]);
      const u=Math.min(1023,Math.floor((lon/(2*Math.PI)+.5)*1024)),vv=Math.min(511,Math.max(0,Math.floor((.5-lat/Math.PI)*512)));
      row.push(vv*1024+u);
    }rows.push(row);}
    const mc=cl.maelstromCentre(worldTest.manifest()),mp=pf.toPlanet([mc[0],0,mc[1]],C,R),ml=Math.hypot(...mp),storm=project(mp.map(x=>x/ml));
    return {grid:rows,G,storm,aspect:v.aspect,look:v.look,eye:v.eye};
  });
  fs.writeFileSync(path.join(out,`${tag}-${String(i).padStart(2,'0')}.json`),JSON.stringify({lat,...pred}));
  console.log(tag,i,lat,JSON.stringify(pred.storm),'');
}
await ctx.close();
