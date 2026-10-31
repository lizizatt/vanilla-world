// On-demand draw-call bisect (needs WOW_DATA and a server on PORT, never 4173): skips each WebGPU draw of one frame in turn and reports the
// draws whose removal erases a marker colour in a screen region, so a stray sheet/blob in the sky or ground can be traced to a pass.
//   PORT=4561 node browser/heavy-lock.mjs -- node browser/sky-blob-bisect.mjs
// Env: POSE (json, default the Shimmering Flats pose), LOOK ([yaw,pitch]), TIME (timeLock), CLIP ({x,y,width,height}), MARK (js predicate body over r,g,b).
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const POSE=process.env.POSE?JSON.parse(process.env.POSE):{v:1,body:'azeroth',drive:[-1040.1285152435303,-55.74995803833008,11292.49234008789,2.994818925857544],time:1505.8686,settings:{waves:true,weather:true,clouds:true,planet:true,globeMesh:true}};
const LOOK=process.env.LOOK?JSON.parse(process.env.LOOK):[4.0,0.35];
const CLIP=process.env.CLIP?JSON.parse(process.env.CLIP):{x:0,y:620,width:1280,height:180};
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;
    const S=window.__bis={skip:-1,count:0,log:[],record:false,frame:0};
    const wrap=name=>{const o=GPURenderPassEncoder.prototype[name];GPURenderPassEncoder.prototype[name]=function(...a){
      const i=S.count++;if(S.record)S.log.push({i,name,label:name==='executeBundles'?(()=>{const r=window.worldTest&&window.worldTest.renderer&&window.worldTest.renderer();return r&&a[0][0]===(r.sceneBundle&&r.sceneBundle.bundle)?'scene':r&&a[0][0]===(r.terrainBundle&&r.terrainBundle.bundle)?'terrain':'other';})():(this.label||''),pipe:this.__p||'',a:a.slice(0,2).map(Number)});if(i===S.skip)return;return o.apply(this,a);};};
    for(const n of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect','executeBundles'])wrap(n);
    const sp=GPURenderPassEncoder.prototype.setPipeline;GPURenderPassEncoder.prototype.setPipeline=function(p){this.__p=p.label||'';return sp.call(this,p);};
    const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=cb=>raf(t=>{S.count=0;cb(t);});});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT||4561}/?test&pose=${encodeURIComponent(JSON.stringify(POSE))}`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  await page.waitForTimeout(12000);
  if(process.env.TIME)await page.evaluate(t=>worldTest.timeLock(+t),process.env.TIME);
  await page.evaluate(([l,d])=>worldTest.focus([d[0],d[1]+4,d[2],...l]),[LOOK,POSE.drive]);
  await page.waitForTimeout(4000);
  const count=async()=>{const b64=(await page.screenshot({clip:CLIP})).toString('base64');
    return page.evaluate(async b64=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),bmp=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const c=new OffscreenCanvas(bmp.width,bmp.height),x=c.getContext('2d');x.drawImage(bmp,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let n=0;
      for(let i=0;i<d.length;i+=4)if(d[i+2]>d[i]+15&&d[i+2]>120)n++;return n;},b64);};
  const base=await count();
  await page.evaluate(()=>{__bis.record=true;});await page.waitForTimeout(300);
  const log=await page.evaluate(()=>{__bis.record=false;return __bis.log;});
  const total=Math.max(...log.map(e=>e.i))+1;
  console.log('base marker px',base,'draws/frame',total);
  const hits=[];
  for(let i=0;i<total;i++){
    await page.evaluate(i=>{__bis.skip=i;},i);await page.waitForTimeout(250);
    const n=await count();
    if(n<base*.35)hits.push({i,n,...log.find(e=>e.i===i)});
  }
  await page.evaluate(()=>{__bis.skip=-1;});
  console.log(JSON.stringify({base,total,hits,errors},null,1));
  const scene=hits.find(h=>h.name==='executeBundles');
  if(scene&&!hits.some(h=>h.label==='terrain')){
    // The bundle is cached, so rebuild it each probe while skipping the j-th recorded opaque draw.
    await page.evaluate(()=>{const S=__bis,o=GPURenderBundleEncoder.prototype.drawIndexed;S.bj=-1;S.bc=0;
      GPURenderBundleEncoder.prototype.drawIndexed=function(...a){const j=S.bc++;if(j===S.bj)return;return o.apply(this,a);};
      const r=worldTest.renderer();S.rebuild=()=>{S.bc=0;r.sceneBundle=undefined;};});
    const probe=async j=>{await page.evaluate(j=>{__bis.bj=j;__bis.rebuild();},j);await page.waitForTimeout(200);let m=0;for(let k=0;k<3;k++){m=Math.max(m,await count());await page.waitForTimeout(80);}return m;};
    const n=await page.evaluate(async()=>{const r=worldTest.renderer();__bis.rebuild();await new Promise(x=>setTimeout(x,400));return r.sceneBundle.draws.length;});
    const found=[];
    for(let j=0;j<n;j++){const c=await probe(j);if(c<base*.35)found.push(j);}
    console.log('opaque scene draws',n,'culprits',found);
    for(const j of found)console.log(JSON.stringify(await page.evaluate(j=>{__bis.bj=-1;__bis.rebuild();return new Promise(res=>setTimeout(()=>{const r=worldTest.renderer(),d=r.sceneBundle.draws[j];
      const name=(m,v)=>[...m.entries()].find(([,x])=>x===v)?.[0];
      res({j,asset:name(r.assets,d.asset),item:name(r.items,d.item),batch:{blend:d.batch.blend,tex:d.batch.texture,idx:d.batch.indexCount,first:d.batch.firstIndex},
        inst:r.instances.filter(i=>i.id===d.item.id).slice(0,3).map(i=>({kind:i.kind,id:i.id,key:i.key,distant:i.distant,m:Array.from(i.matrix||[]).map(v=>Math.round(v*10)/10),b:r.assets.get(i.key)?.bounds}))});},500));},j)));
  }

  const terr=hits.find(h=>h.label==='terrain');
  if(terr){
    await page.evaluate(()=>{const S=__bis;S.bj=-1;S.bc=0;
      for(const n of ['draw','drawIndexed']){const o=GPURenderBundleEncoder.prototype[n];
        GPURenderBundleEncoder.prototype[n]=function(...a){const j=S.bc++;if(j===S.bj)return;return o.apply(this,a);};}
      const r=worldTest.renderer();S.rebuild=()=>{S.bc=0;r.terrainBundle=undefined;};});
    const probe=async j=>{await page.evaluate(j=>{__bis.bj=j;__bis.rebuild();},j);await page.waitForTimeout(200);let m=0;for(let k=0;k<3;k++){m=Math.max(m,await count());await page.waitForTimeout(80);}return m;};
    const n=await page.evaluate(async()=>{const r=worldTest.renderer();__bis.rebuild();await new Promise(x=>setTimeout(x,400));const t=r.terrainBundle.items;const L=[];t.forEach((i,k)=>{if(i.region===undefined)L.push(k);});t.filter(i=>i.material).forEach((_,k)=>L.push(t.length+k));return L;});
    const found=[];
    for(const j of n){const c=await probe(j);if(c<base*.35)found.push(j);}
    console.log('terrain draws',n.length,'culprits',found);
    for(const j of [-1,...found]){await page.evaluate(j=>{__bis.bj=j;__bis.rebuild();},j);await page.waitForTimeout(600);
      await page.screenshot({path:`../runtime/gate-preview/blob-skip/skip${j}.png`});}
    for(const j of found)console.log(JSON.stringify(await page.evaluate(j=>{__bis.bj=-1;__bis.rebuild();return new Promise(res=>setTimeout(()=>{const r=worldTest.renderer(),t=r.terrainBundle.items;
      const item=j<t.length?t[j]:t.filter(i=>i.material)[j-t.length];
      res({j,splat:j>=t.length,keys:Object.keys(item),region:item.region,count:item.count,first:item.first,mcount:item.material&&item.material.count,placement:item.placement,bounds:item.bounds,tile:item.tile&&item.tile.entry});},500));},j)));
  }
}finally{await browser.close();}
