import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

if(!process.env.WOW_DATA)throw new Error('Set WOW_DATA to your read-only Classic Data folder');
const out=new URL('./test-results/distant/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const pixels=async()=>{
  const bytes=await page.locator('#world').screenshot();
  return page.evaluate(async encoded=>{
    const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
    const canvas=new OffscreenCanvas(640,360),ctx=canvas.getContext('2d');
    ctx.drawImage(image,0,0,640,360);image.close();
    return [...ctx.getImageData(5,70,630,220).data];
  },bytes.toString('base64'));
};
try {
  await page.goto('http://127.0.0.1:4173/?test');
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready || worldEvidence.errors.length,{},{timeout:180000});
  const poses=await page.evaluate(()=>{
    const m=worldEvidence.info.manifest,p=m.spawn,r=m.regions[1],t=1600/3;
    return [['raceway',[p[0],1400,p[2],0,-1.5]],['elwynn',[100+r.placement[0]+32*t,1400,9450+r.placement[1]+32*t,0,-1.5]]];
  });
  const comparisons=[];
  for(const [name,pose] of poses) {
    const loads=await page.evaluate(()=>worldEvidence.state.distant.loads);
    await page.locator('#distant').check();
    await page.evaluate(p=>worldTest.focus(p),pose);
    await page.waitForFunction(loads=>worldEvidence.render?.distantAlphaDraws>0 && worldEvidence.state.distant.resident===12
      && worldEvidence.state.distant.loads>loads,loads,{timeout:120000});
    await page.waitForTimeout(7000);
    const enabled=await page.evaluate(()=>worldEvidence);
    const on=await pixels();
    await page.screenshot({path:fileURLToPath(new URL(`${name}-authored-models.png`,out))});
    assert(enabled.render.distantDraws>0 && enabled.render.distantAlphaDraws>0);
    assert(enabled.render.sceneTriangles<=2000000 && enabled.render.sceneDraws<=4096);
    assert(enabled.state.distant.peak<=12 && enabled.state.peak<=4);
    assert.equal(enabled.render.npcInstances,0,'Far metadata must not invent distant NPCs');
    assert.equal(enabled.state.scene.waitingCollision,0,'Visual-only metadata must not block the parked vehicle');
    assert.deepEqual(enabled.errors,[]);
    assert.deepEqual(enabled.state.scene.errors,[]);
    assert.deepEqual(enabled.state.distant.failures,[]);
    assert(enabled.state.scene.models<=96 && enabled.state.scene.textures<=192 && enabled.state.scene.bytes<=96*1024*1024);
    await page.locator('#distant').uncheck();await page.waitForTimeout(500);
    const disabled=await page.evaluate(()=>worldEvidence.render),off=await pixels();
    await page.screenshot({path:fileURLToPath(new URL(`${name}-terrain-only.png`,out))});
    assert.equal(disabled.distantDraws,0);
    assert.equal(disabled.detailedTiles,enabled.render.detailedTiles);
    assert.equal(disabled.horizonTiles,enabled.render.horizonTiles);
    let changedPixels=0;
    for(let i=0;i<on.length;i+=4)if(Math.abs(on[i]-off[i])+Math.abs(on[i+1]-off[i+1])+Math.abs(on[i+2]-off[i+2])>40)changedPixels++;
    assert(changedPixels>100,`Expected visible distant geometry, found ${changedPixels} changed pixels`);
    assert.deepEqual(errors,[]);
    comparisons.push({name,changedPixels,enabled:{render:enabled.render,state:enabled.state},disabled});
  }
  await page.locator('#distant').check();
  await page.locator('#drive').click();
  await page.waitForFunction(()=>worldEvidence.render?.npcInstances>0
    && worldEvidence.render.sceneDraws>worldEvidence.render.distantDraws
    && worldEvidence.state.scene.waitingCollision===0,{},{timeout:120000});
  const returned=await page.evaluate(()=>({render:worldEvidence.render,state:worldEvidence.state}));
  assert(returned.render.detailedTiles>0 && returned.state.peak<=4);
  assert.deepEqual(returned.state.scene.errors,[]);
  assert.deepEqual(returned.state.distant.failures,[]);
  await page.screenshot({path:fileURLToPath(new URL('returned-near-raceway.png',out))});
  assert.deepEqual(errors,[]);
  const result={browser:browser.version(),comparisons,returned,errors};
  await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
