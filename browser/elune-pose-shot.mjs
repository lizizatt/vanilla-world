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
  page.on('console',m=>{const t=m.text();if(/swap|pose|error/i.test(t))console.log('C',t.slice(0,160));});
  await page.goto(`http://127.0.0.1:${PORT}/?test&flight&planet&pose=${encodeURIComponent(pose)}`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
  await page.locator('#files').setInputFiles(WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:300000});
  await page.keyboard.press('Escape');if(await page.locator('[data-tab=options]').isVisible()){await page.locator('[data-tab=options]').click();await page.keyboard.press('Escape');}await page.evaluate(()=>document.getElementById('welcome')?.remove());
  await page.waitForTimeout(+WAIT);
  if(process.env.SET){await page.evaluate(s=>worldTest.settings(JSON.parse(s)),process.env.SET);await page.waitForTimeout(4000);}
  if(process.env.FILT){await page.evaluate(k=>{const r=worldTest.renderer();const d=Object.getOwnPropertyDescriptor(r,'instances');let v=r.instances.filter(i=>i.kind!==k);Object.defineProperty(r,'instances',{get:()=>v,set:x=>{v=x.filter(i=>i.kind!==k);},configurable:true});},process.env.FILT);await page.waitForTimeout(3000);}
  await page.screenshot({path:path.join(out,`${tag}-${name}.png`)});
  console.log(name,JSON.stringify(await page.evaluate(()=>{const v=worldTest.renderer().view;const tl=[...worldTest.renderer().tiles.entries()].map(([i,t])=>({i,m:!!t.material,tile:t.tile??t.entry?.file,off:t.offset,ms:t.materialSince,edge:t.edgeMask,reg:t.entry?.region}));return {ft:worldTest.renderer().fadeTime,tiles:tl,eye:v.eye,hud:document.body.innerText.match(/WELL \w+/)?.[0]};})));
  if(process.env.U)console.log(JSON.stringify(await page.evaluate(()=>{const r=worldTest.renderer();return [...r.tiles.entries()].map(([i,x])=>({i,z:r.uniformData[x.offset/4+22],w:r.uniformData[x.offset/4+19],cell:r.uniformData[x.offset/4+27],k:Object.keys(x).join()}))})));
  if(process.env.EV)console.log('EV',JSON.stringify(await page.evaluate(()=>{const e=worldEvidence;return {state:e.state,info:e.info,bodySwaps:e.bodySwaps,errors:e.errors,source:e.source,fps:e.fps,txt:document.getElementById('details')?.textContent.slice(0,600)}})).slice(0,2500));
  if(process.env.DUMP)console.log(JSON.stringify(await page.evaluate(()=>{const r=worldTest.renderer();const e=r.view.eye;const c={};for(const i of r.instances){const k=(i.distant?'D':'N')+i.kind;c[k]=(c[k]||0)+1;}const L=r.instances.map(i=>({k:i.kind,id:i.id,m:[...i.matrix.slice(12,15)].map(Math.round),b:i.bounds&&JSON.stringify(i.bounds).slice(0,90)}));const T=[...r.tiles.entries()].map(([i,x])=>[i,x.entry?.file,x.entry?.placement||x.placement,x.bounds&&JSON.stringify(x.bounds).slice(0,80)]);return {wt:Object.keys(worldTest).join(),ev:Object.keys(worldEvidence).join(),T,c,horizon:r.horizon.length,seams:r.seams.size,hor:r.horizon.slice(0,8).map(h=>({near:h.near,keys:Object.keys(h).join()}))};})));
  await ctx.close();
}
