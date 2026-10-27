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
const flight=JSON.parse(process.env.FLIGHT),time=+process.env.TIME;
for(const [name,clouds,ts] of [['c',true,0],['n',false,0]]){
  await page.evaluate(([f,t,c,ts])=>{worldTest.settings({planet:true,globeMesh:true,globeRegistry:true,clouds:c,timeScale:ts});worldTest.timeLock(t);worldTest.focus(f);},[flight,time,clouds,ts]);
  await page.waitForTimeout(9000);
  await page.screenshot({path:path.join(out,`${tag}-${name}.png`)});
}
const info=await page.evaluate(async PIX=>{
  const s=await import('./space.js'),pf=await import('./planet-frame.js'),cl=await import('./clouds.js'),r=worldTest.renderer(),v=r.view,R=s.PLANET_RADIUS,C=s.WORLD_CENTRE;
  const f=s.planetFrame(v.eye[0],v.eye[2],C,R),alt=Math.max(0,v.eye[1]),centre=[0,-(R+alt),0],W=1280,H=720;
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const project=pl=>{const n=[dot(pl,f.east),dot(pl,f.up),dot(pl,f.south)],P=[0,1,2].map(k=>centre[k]+R*n[k]),L=Math.hypot(...P),d=P.map(x=>x/L),front=dot(n,P.map(x=>-x))>0,z=dot(d,v.look);return {x:((dot(d,v.right)/z/(.55*v.aspect))+1)/2*W,y:(1-dot(d,v.up)/z/.55)/2*H,front};};
  const m=worldTest.manifest(),mc=cl.maelstromCentre(m),mp=pf.toPlanet([mc[0],0,mc[1]],C,R),ml=Math.hypot(...mp);
  const hit=([px,py])=>{const nx=px/W*2-1,ny=1-py/H*2,d0=[0,1,2].map(k=>v.look[k]+v.right[k]*nx*.55*v.aspect+v.up[k]*ny*.55),L=Math.hypot(...d0),d=d0.map(x=>x/L),oc=[0,1,2].map(k=>-centre[k]),b=dot(oc,d),q=dot(oc,oc)-R*R,disc=b*b-q;if(disc<=0)return null;const t=-b-Math.sqrt(disc),n=[0,1,2].map(k=>(d[k]*t-centre[k])/R),pv=[0,1,2].map(k=>f.east[k]*n[0]+f.up[k]*n[1]+f.south[k]*n[2]);return {lat:Math.asin(pv[1])*180/Math.PI,lon:Math.atan2(pv[2],pv[0])*180/Math.PI};};const mn=mp.map(x=>x/ml);return {alt,mc,seabed:project(mn),mael:{lat:Math.asin(mn[1])*180/Math.PI,lon:Math.atan2(mn[2],mn[0])*180/Math.PI},hits:PIX.map(hit),eye:v.eye};
},JSON.parse(process.env.PIX||'[]'));
console.log(JSON.stringify(info));
await ctx.close();