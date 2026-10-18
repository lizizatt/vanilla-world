import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to your local Classic Data folder');
const output=new URL('./test-results/viewport/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const evidence={sizes:[],errors:[]};
const url=process.env.BASE_URL||'http://127.0.0.1:4183';
async function open(viewport,deviceScaleFactor) {
  const context=await browser.newContext({viewport,deviceScaleFactor});
  const page=await context.newPage();
  page.on('pageerror',error=>evidence.errors.push(error.message));
  await page.goto(`${url}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.evaluate(async()=>{
    const {WorldRenderer}=await import('./world-renderer.js'),draw=WorldRenderer.prototype.draw;
    WorldRenderer.prototype.draw=function(...args) {
      const result=draw.apply(this,args);
      window.viewportDraw={width:this.canvas.width,height:this.canvas.height,aspect:this.uniformData[20]};
      return result;
    };
  });
  return {context,page};
}
async function size(page,width,height) {
  await page.setViewportSize({width,height});
  await page.waitForFunction(({width,height})=>{
    const d=window.viewportDraw,ratio=Math.min(devicePixelRatio,2);
    return d?.width===Math.round(width*ratio)&&d.height===Math.round(height*ratio);
  },{width,height});
  const result=await page.evaluate(()=>{
    const canvas=document.getElementById('world'),r=canvas.getBoundingClientRect(),root=document.documentElement;
    return {viewport:[innerWidth,innerHeight],bounds:[r.x,r.y,r.width,r.height],dpr:devicePixelRatio,
      backing:[canvas.width,canvas.height],aspect:viewportDraw.aspect,
      scroll:[root.scrollWidth,root.scrollHeight],fullscreen:!!document.fullscreenElement};
  });
  assert.deepEqual(result.bounds,[0,0,width,height]);
  assert.deepEqual(result.scroll,[width,height]);
  assert(Math.abs(result.aspect-width/height)<.000001);
  assert(!result.fullscreen);
  evidence.sizes.push(result);
}
try {
  const {context,page}=await open({width:676,height:1315},1);
  for(const [width,height] of [[676,1315],[1280,800],[360,640],[640,360]]) {
    await size(page,width,height);
    await page.locator('#preferences > summary').click();
    const distance=Number(await page.locator('#camera-distance').inputValue());
    await page.locator('#camera-distance').focus();await page.keyboard.press('ArrowRight');
    assert.equal(Number(await page.locator('#camera-distance').inputValue()),distance+.5);
    await page.locator('#cockpit').scrollIntoViewIfNeeded();
    assert(await page.locator('#cockpit').isVisible());
    assert.deepEqual(await page.evaluate(()=>[document.documentElement.scrollWidth,document.documentElement.scrollHeight]),[width,height]);
    await page.locator('#preferences > summary').click();
    const point={x:Math.floor(width/2),y:height-28};
    assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y).id,point),'world','HUD must pass pointer input through');
    await page.mouse.click(point.x,point.y);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'world');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'select','Overlay controls remain keyboard-accessible');
    await page.locator('#world').focus();
  }
  await size(page,676,1315);
  await page.waitForFunction(()=>worldEvidence.render.craftReady&&worldEvidence.render.texturedTerrainTiles===4,null,{timeout:120000});
  const view=await page.evaluate(()=>worldEvidence.view);
  await page.mouse.move(338,1287);await page.mouse.down({button:'right'});
  await page.mouse.move(438,1187,{steps:8});await page.mouse.up({button:'right'});
  await page.waitForFunction(previous=>worldEvidence.view.some((n,i)=>Math.abs(n-previous[i])>.05),view);
  evidence.pointerOrbit=true;
  await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Saved.');
  await page.locator('#fly').click();await page.waitForFunction(()=>worldEvidence.mode==='fly');
  await page.locator('#drive').click();
  await page.waitForFunction(()=>worldEvidence.mode==='drive'&&document.getElementById('drive').hidden
    &&document.getElementById('speed').textContent!=='FLY');
  const transparent=await page.evaluate(()=>[...document.querySelectorAll(
    '.interface,.menu-stack,.toolbar,.overlay,.meters,button,summary,details,.panel-content,dialog,select,input[type=number]'
  )].map(element=>({element:element.id||element.className||element.tagName,
    background:getComputedStyle(element).backgroundColor,image:getComputedStyle(element).backgroundImage})));
  for(const style of transparent){assert.equal(style.background,'rgba(0, 0, 0, 0)',style.element);assert.equal(style.image,'none');}
  evidence.transparentStyles=transparent;
  const points=await page.evaluate(()=>{
    const meter=document.querySelector('.meters').getBoundingClientRect(),button=document.getElementById('select').getBoundingClientRect();
    const summary=document.querySelector('#preferences > summary').getBoundingClientRect();
    return [{x:meter.left+4,y:meter.top+4},{x:button.left+4,y:button.top+4},
      {x:summary.right+20,y:summary.top+5}];
  });
  assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y).id,points[2]),'world','Unused menu width must not intercept clicks');
  await page.locator('#world').focus();
  // Stop only this test page's drawing so actual scene pixels stay identical across overlay screenshots.
  await page.evaluate(()=>{window.requestAnimationFrame=()=>0;});
  await page.waitForTimeout(150);
  const visible=await page.screenshot({path:fileURLToPath(new URL('full-viewport.png',output))});
  await page.evaluate(()=>{
    document.querySelector('.interface').style.visibility='hidden';
    document.querySelector('.meters').style.visibility='hidden';
    document.getElementById('welcome').style.visibility='hidden';
  });
  const bare=await page.screenshot();
  evidence.backgroundPixels=await page.evaluate(async({visible,bare,points})=>{
    const pixels=async encoded=>{
      const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
      const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');
      ctx.drawImage(image,0,0);image.close();
      return points.map(p=>Array.from(ctx.getImageData(Math.round(p.x),Math.round(p.y),3,3).data));
    };
    const a=await pixels(visible),b=await pixels(bare);
    return a.map((values,i)=>({point:points[i],maxDifference:Math.max(...values.map((n,j)=>Math.abs(n-b[i][j])))}));
  },{visible:visible.toString('base64'),bare:bare.toString('base64'),points});
  for(const patch of evidence.backgroundPixels)assert.equal(patch.maxDifference,0,'Overlay background must leave scene pixels unchanged');
  await context.close();
  const highDpr=await open({width:360,height:640},2.5);
  await size(highDpr.page,360,640);await size(highDpr.page,640,360);
  await highDpr.context.close();
  assert.deepEqual(evidence.errors,[]);
  await writeFile(new URL('evidence.json',output),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  await writeFile(new URL('failure.json',output),JSON.stringify({...evidence,message:error.message},null,2));
  throw error;
} finally {await browser.close();}
