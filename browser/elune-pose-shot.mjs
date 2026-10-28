// On-demand: replay ?pose= links (env POSES = JSON {name:poseQueryJson}) with real WoW data, one fresh page per pose; shots in runtime/real-smoke/<tag>-<name>.png.
// Env: WOW_DATA, PORT, WAIT (ms after ready, default 20000), TS (override timeScale, default pose's).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';

const {WOW_DATA,PORT='4291',WAIT='20000'}=process.env;
if(!WOW_DATA)throw new Error('WOW_DATA required');
const tag=process.argv[2]||'ep',out=path.resolve('..','runtime','real-smoke');fs.mkdirSync(out,{recursive:true});
const poses=JSON.parse(fs.readFileSync(process.env.POSES,'utf8'));
for(const [name,pose] of Object.entries(poses)) {
  const ctx=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),'edge-ep-')),{channel:'msedge',headless:true,args:['--mute-audio'],viewport:{width:1280,height:720},serviceWorkers:'block'});
  const page=ctx.pages()[0]||await ctx.newPage();
  page.on('console',m=>{const t=m.text();if(/swap|pose|error|wgsl|shader|pipeline|valid|engine|unavailable|moon/i.test(t))console.log('C',t.slice(0,600));});
  await page.goto(`http://127.0.0.1:${PORT}/?${process.env.QUERY||'test&flight&planet&bodies'}&pose=${encodeURIComponent(pose)}`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
  await page.locator('#files').setInputFiles(WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:300000});
  await page.keyboard.press('Escape');if(await page.locator('[data-tab=options]').isVisible()){await page.locator('[data-tab=options]').click();await page.keyboard.press('Escape');}await page.evaluate(()=>document.getElementById('welcome')?.remove());
  await page.waitForTimeout(+WAIT);
  if(process.env.SET){await page.evaluate(s=>worldTest.settings(JSON.parse(s)),process.env.SET);await page.waitForTimeout(4000);}
  if(process.env.FILT){await page.evaluate(k=>{const r=worldTest.renderer();const d=Object.getOwnPropertyDescriptor(r,'instances');let v=r.instances.filter(i=>i.kind!==k);Object.defineProperty(r,'instances',{get:()=>v,set:x=>{v=x.filter(i=>i.kind!==k);},configurable:true});},process.env.FILT);await page.waitForTimeout(3000);}
  if(process.env.HIDE){await page.evaluate(k=>{const r=worldTest.renderer();for(const n of k.split(',')){const v=r[n];if(v&&v.clear)v.clear();else if(Array.isArray(v))v.length=0;}},process.env.HIDE);await page.waitForTimeout(3000);}
  if(process.env.OCEAN){console.log('OC',JSON.stringify(await page.evaluate(async()=>{const r=worldTest.renderer();const om=await import('./ocean-mesh.js'),sp=await import('./space.js');const m=om.oceanMesh(r.oceanSpec.manifest,96,r.landRects);const o=r.oceanSpec.origin,e=r.view.eye;const bk=r.planetFactors?.bend;const out={eye:e,origin:o,ocean:r.oceanSpec.manifest.ocean,bk,keys:Object.keys(r).filter(k=>/plan|bend|pf/i.test(k)).join(),n:m.length/7};return out;})));}
  if(process.env.CHASE){await page.evaluate(c=>{worldTest.renderer().chase=[0,+c];},process.env.CHASE);await page.waitForTimeout(2500);console.log('CAM',JSON.stringify(await page.evaluate(()=>{const r=worldTest.renderer(),o=r.origin||[0,0],c=r.camera;return {cam:c,origin:o,floor:r.cameraFloor?.(c[0]+o[0],c[1],c[2]+o[1]),lift:r.chaseLift,tilt:r.chase,probe:[-30,-7.7,0,50].map(y=>[y,r.cameraFloor?.(c[0]+o[0],y,c[2]+o[1])])};})));}
  await page.screenshot({path:path.join(out,`${tag}-${name}.png`)});
  console.log(name,JSON.stringify(await page.evaluate(()=>{const v=worldTest.renderer().view;const tl=[...worldTest.renderer().tiles.entries()].map(([i,t])=>({i,m:!!t.material,tile:t.tile??t.entry?.file,off:t.offset,ms:t.materialSince,edge:t.edgeMask,reg:t.entry?.region}));return {ft:worldTest.renderer().fadeTime,tiles:tl,eye:v.eye,hud:document.body.innerText.match(/WELL \w+/)?.[0]};})));
  if(process.env.FIND)console.log('FIND',JSON.stringify(await page.evaluate(f=>{const r=worldTest.renderer(),re=new RegExp(f);return {a:[...(r.assets?.keys?.()||[])].filter(k=>re.test(k)||/world/i.test(k)).slice(0,5),inst:r.instances.filter(i=>re.test(String(i.id))).map(i=>({id:i.id,key:i.key,d:i.distant,m:[...i.matrix.slice(12,15)].map(Math.round),b:i.bounds&&JSON.stringify(i.bounds)}))};},process.env.FIND)));
  if(process.env.U)console.log(JSON.stringify(await page.evaluate(()=>{const r=worldTest.renderer();return [...r.tiles.entries()].map(([i,x])=>({i,z:r.uniformData[x.offset/4+22],w:r.uniformData[x.offset/4+19],cell:r.uniformData[x.offset/4+27],k:Object.keys(x).join()}))})));
  if(process.env.SWAPS)console.log('SWAPS',JSON.stringify(await page.evaluate(()=>(worldEvidence.swapProfiles||[]).map(p=>({to:p.to,total:p.total,phases:p.phases})))));
  if(process.env.EV)console.log('EV',JSON.stringify(await page.evaluate(()=>{const e=worldEvidence;return {state:e.state,info:e.info,bodySwaps:e.bodySwaps,errors:e.errors,source:e.source,fps:e.fps,txt:document.getElementById('details')?.textContent.slice(0,600)}})).slice(0,2500));
  if(process.env.DUMP)console.log(JSON.stringify(await page.evaluate(()=>{const r=worldTest.renderer();const e=r.view.eye;const c={};for(const i of r.instances){const k=(i.distant?'D':'N')+i.kind;c[k]=(c[k]||0)+1;}const L=r.instances.map(i=>({k:i.kind,id:i.id,m:[...i.matrix.slice(12,15)].map(Math.round),b:i.bounds&&JSON.stringify(i.bounds).slice(0,90)}));const T=[...r.tiles.entries()].map(([i,x])=>[i,x.entry?.file,x.entry?.placement||x.placement,x.bounds&&JSON.stringify(x.bounds).slice(0,80)]);return {wt:Object.keys(worldTest).join(),ev:Object.keys(worldEvidence).join(),T,c,horizon:r.horizon.length,seams:r.seams.size,hor:r.horizon.slice(0,8).map(h=>({near:h.near,keys:Object.keys(h).join()}))};})));
  await ctx.close();
}
