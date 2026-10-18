import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

if(!process.env.WOW_DATA)throw new Error('Set WOW_DATA to your read-only Classic Data folder');
const base=process.env.BASE_URL||'http://127.0.0.1:4183';
assert(new URL(base).port!=='4173','Do not use the protected user preview');
const out=new URL('./test-results/distant/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try {
  await page.goto(`${base}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.evaluate(async()=>{
    const {WorldRenderer}=await import('./world-renderer.js'),draw=WorldRenderer.prototype.draw;
    WorldRenderer.prototype.draw=function(...args){
      window.distantProbe={rig:this,args};return draw.apply(this,args);
    };
  });
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready || worldEvidence.errors.length,{},{timeout:180000});
  await page.locator('#preferences > summary').click();
  const poses=await page.evaluate(()=>{
    const m=worldEvidence.info.manifest,p=m.spawn,r=m.regions[1],t=1600/3;
    return [['raceway',[p[0],1400,p[2],0,-1.5]],['elwynn',[100+r.placement[0]+32*t,1400,9450+r.placement[1]+32*t,0,-1.5]]];
  });
  const comparisons=[];
  for(const [name,pose] of poses) {
    const loads=await page.evaluate(()=>worldEvidence.state.distant.loads);
    await page.locator('#distant').check();
    await page.evaluate(p=>worldTest.focus(p),pose);
    await page.waitForFunction(loads=>worldEvidence.render?.distantAlphaDraws>0 && worldEvidence.state.distant.resident===24
      && worldEvidence.state.distant.loads>loads,loads,{timeout:120000});
    await page.waitForTimeout(7000);
    await page.evaluate(()=>worldTest.freezePresentation(true));
    await page.waitForTimeout(200);
    const enabled=await page.evaluate(()=>worldEvidence);
    await page.screenshot({path:fileURLToPath(new URL(`${name}-authored-models.png`,out))});
    assert(enabled.render.distantDraws>0 && enabled.render.distantAlphaDraws>0);
    assert(enabled.render.sceneTriangles<=2000000 && enabled.render.sceneDraws<=4096);
    assert(enabled.state.distant.peak<=24 && enabled.state.peak<=8);
    assert.equal(enabled.render.npcInstances,0,'Far metadata must not invent distant NPCs');
    assert.equal(enabled.state.scene.waitingCollision,0,'Visual-only metadata must not block the parked vehicle');
    assert.deepEqual(enabled.errors,[]);
    assert.deepEqual(enabled.state.scene.errors,[]);
    assert.deepEqual(enabled.state.distant.failures,[]);
    assert.deepEqual(enabled.state.distant.scene.errors,[]);
    assert(enabled.state.distant.scene.models<=96 && enabled.state.distant.scene.textures<=96
      && enabled.state.distant.scene.bytes<=32*1024*1024);
    assert(enabled.state.scene.models<=192 && enabled.state.scene.textures<=192 && enabled.state.scene.bytes<=96*1024*1024);
    // One synchronous renderer turn: asynchronous worker arrivals cannot alter the three captures.
    const comparison=await page.evaluate(()=>{
      const {rig,args}=distantProbe,canvas=document.getElementById('world');
      const target=new OffscreenCanvas(640,360),ctx=target.getContext('2d'),pixels=[];
      let disabled,off;
      for(const distant of [true,false,true]){
        const call=args.slice();call[2]=0;call[3]=0;call[4]={...args[4],distant};
        const stats=rig.draw(...call);
        ctx.drawImage(canvas,0,0,640,360);pixels.push(ctx.getImageData(5,70,630,170).data);
        if(!distant){disabled=stats;off=canvas.toDataURL('image/png').split(',')[1];}
      }
      const difference=(a,b)=>{
        let count=0;for(let i=0;i<a.length;i+=4)
          if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>40)count++;
        return count;
      };
      return {disabled,off,changedPixels:difference(pixels[0],pixels[1]),backgroundChange:difference(pixels[0],pixels[2])};
    });
    const {disabled,changedPixels,backgroundChange}=comparison;
    await writeFile(new URL(`${name}-terrain-only.png`,out),Buffer.from(comparison.off,'base64'));
    assert.equal(disabled.distantDraws,0);
    assert.equal(disabled.detailedTiles,enabled.render.detailedTiles);
    assert.equal(disabled.horizonTiles,enabled.render.horizonTiles);
    assert(changedPixels>backgroundChange+100,
      `Expected distant geometry above ongoing background changes: ${changedPixels} versus ${backgroundChange}`);
    assert.deepEqual(errors,[]);
    comparisons.push({name,changedPixels,backgroundChange,enabled:{render:enabled.render,state:enabled.state},disabled});
    await page.evaluate(()=>worldTest.freezePresentation(false));
    await page.locator('#distant').uncheck();
    await page.waitForFunction(()=>worldEvidence.state.distant.enabled===false);
    const retained=await page.evaluate(()=>worldEvidence.state.distant.loads);
    await page.locator('#distant').check();
    await page.waitForFunction(()=>worldEvidence.state.distant.enabled===true);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>worldEvidence.state.distant.loads),retained,
      'An ordinary mode toggle must reuse the retained metadata, not reread ADTs');
  }
  await page.locator('#distant').check();
  await page.locator('#drive').click();
  await page.waitForFunction(()=>worldEvidence.render?.npcInstances>0
    && worldEvidence.render.sceneDraws>worldEvidence.render.distantDraws
    && worldEvidence.state.scene.waitingCollision===0,{},{timeout:120000});
  const returned=await page.evaluate(()=>({render:worldEvidence.render,state:worldEvidence.state}));
  assert(returned.render.detailedTiles>0 && returned.state.peak<=8);
  assert.deepEqual(returned.state.scene.errors,[]);
  assert.deepEqual(returned.state.distant.failures,[]);
  await page.screenshot({path:fileURLToPath(new URL('returned-near-raceway.png',out))});
  assert.deepEqual(errors,[]);
  const result={browser:browser.version(),comparisons,returned,errors};
  await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
