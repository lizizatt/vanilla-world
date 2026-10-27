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
const flights=JSON.parse(process.env.FLIGHTS),time=+process.env.TIME;
for(const [n,flight] of flights.entries()){
  await page.evaluate(([f,t])=>{worldTest.settings({planet:true,globeMesh:true,globeRegistry:true,clouds:false,timeScale:0});worldTest.timeLock(t);worldTest.focus(f);},[flight,time]);
  await page.waitForTimeout(8000);
  await page.screenshot({path:path.join(out,`${tag}-${n}.png`)});
  const info=await page.evaluate(async()=>{
  const s=await import('./space.js'),pf=await import('./planet-frame.js'),cl=await import('./clouds.js'),r=worldTest.renderer(),v=r.view,R=s.PLANET_RADIUS,C=s.WORLD_CENTRE;
  const f=s.planetFrame(v.eye[0],v.eye[2],C,R),alt=Math.max(0,v.eye[1]),centre=[0,-(R+alt),0],W=1280,H=720;
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const project=pl=>{const n=[dot(pl,f.east),dot(pl,f.up),dot(pl,f.south)],P=[0,1,2].map(k=>centre[k]+R*n[k]),L=Math.hypot(...P),d=P.map(x=>x/L),front=dot(n,P.map(x=>-x))>0,z=dot(d,v.look);return {x:((dot(d,v.right)/z/(.55*v.aspect))+1)/2*W,y:(1-dot(d,v.up)/z/.55)/2*H,front};};
  const m=worldTest.manifest(),mc=cl.maelstromCentre(m),mp=pf.toPlanet([mc[0],0,mc[1]],C,R),ml=Math.hypot(...mp);
  const e=v.eye,rel=[mc[0]-e[0],0-e[1],mc[1]-e[2]],br=s.bendRel(rel,e,1),zz=dot(br,v.look),bp={x:((dot(br,v.right)/zz/(.55*v.aspect))+1)/2*W,y:(1-dot(br,v.up)/zz/.55)/2*H};const cam=r.camera,e2=[cam[0],cam[1],cam[2]],br2=s.bendRel(rel,e2,1),z2=dot(br2,v.look),bp2={x:((dot(br2,v.right)/z2/(.55*v.aspect))+1)/2*W,y:(1-dot(br2,v.up)/z2/.55)/2*H};return {cam,bp2,seabed:project(mp.map(x=>x/ml)),bp,k:r.planetFactors??null,eye:e,ry:r.eye};});
  console.log(n,JSON.stringify(info));
}
await ctx.close();