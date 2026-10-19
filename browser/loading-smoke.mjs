import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the local Classic Data folder');
const base=process.env.WORLD_URL||'http://127.0.0.1:4183/?test';
assert.equal(new URL(base).port,'4183','Startup probes use the isolated server only');
const output=new URL(`./test-results/loading/${process.env.LABEL||'current'}/`,import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
try {
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;window.loadingTrace=[];});
  // Nested worker requests bypass Playwright routing; permit only this probe's instrumented blob worker.
  for(const url of [base,'**/world-worker.js'])await context.route(url,async route=>{
    const response=await route.fetch(),headers=response.headers();
    headers['content-security-policy']+="; worker-src 'self' blob:";
    await route.fulfill({response,headers});
  });
  const assetUrl=new URL('./asset-worker.js',base);
  let assetBody=await (await fetch(assetUrl)).text();
    for(const [before,after] of [
      ['jobs.push(data);','data.queuedAt=performance.now();jobs.push(data);'],
      ['active=job.id;','active=job.id;job.startedAt=performance.now();'],
      ['function reply(job,result,error) {',`function reply(job,result,error) {
        postMessage({event:'load-trace',kind:'asset',action:job.action,path:job.path,background:!!job.background,
          queuedAt:job.queuedAt+performance.timeOrigin,start:job.startedAt+performance.timeOrigin,
          end:performance.now()+performance.timeOrigin,error:error?.code||error?.message,
          bytes:result?.byteLength,stats:{...source?.stats,...work}});
      `],
    ]){
      assert(assetBody.includes(before),`Missing asset timeline hook: ${before}`);
      assetBody=assetBody.replace(before,after);
    }
  assetBody=assetBody.replaceAll("'./",`'${assetUrl.origin}/`);
  await context.route('**/asset-channel.js',async route=>{
    const body=(await (await route.fetch()).text()).replace('worker.onmessage=({data})=>{',
      "worker.onmessage=({data})=>{if(data.event==='load-trace'){postMessage(data);return;}")
      .replace("new Worker('./asset-worker.js',{type:'module'})",
        `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(assetBody)}],{type:'text/javascript'})),{type:'module'})`);
    await route.fulfill({contentType:'text/javascript',body});
  });
  await context.route('**/world-store.js',async route=>{
    const body=await (await route.fetch()).text();
    await route.fulfill({contentType:'text/javascript',body:body+`
      const originalStored=stored;
      stored=async(...args)=>{
        const start=performance.now()+performance.timeOrigin;
        try{return await originalStored(...args);}
        finally{
          const event={event:'load-trace',kind:'idb',key:args[0],write:args.length>1&&args[1]!==undefined,
            start,end:performance.now()+performance.timeOrigin};
          if(globalThis.document)loadingTrace.push(event);else postMessage(event);
        }
      };
    `});
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  for(const label of ['cold','warm']){
    await page.goto(base);
    await page.waitForFunction(()=>!document.getElementById('select').disabled);
    await page.evaluate(async()=>{
      const {WorldClient}=await import('./world-client.js'),{WorldRenderer}=await import('./world-renderer.js');
      const open=WorldClient.prototype.open,draw=WorldRenderer.prototype.draw;
      WorldClient.prototype.open=function(...args){
        window.loadingClient=this;
        const event=this.onEvent;
        this.onEvent=data=>{
          if(data.event==='load-trace')loadingTrace.push(data);
          if(data.event==='progress')loadingTrace.push({kind:'progress',...data,end:performance.timeOrigin+performance.now()});
          return event(data);
        };
        return open.apply(this,args);
      };
      WorldRenderer.prototype.draw=function(...args){
        const result=draw.apply(this,args);
        window.loadingRenderer=this;window.loadingDraw=result;return result;
      };
      window.loadingStarted=performance.timeOrigin+performance.now();
    });
    await page.locator('#files').setInputFiles(process.env.WOW_DATA);
    if(process.env.CHECK_SCREEN==='1'){
      await page.locator('#loading-screen').waitFor({state:'visible'});
      assert.equal(await page.locator('#loading-progress').getAttribute('role'),'progressbar');
      await page.keyboard.press('Escape');
      assert(await page.locator('#loading-screen').isVisible(),'Escape must not expose a blocked world');
      await page.screenshot({path:fileURLToPath(new URL(`${label}-loading.png`,output))});
    }
    await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
    assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
    const readyMs=await page.evaluate(()=>performance.timeOrigin+performance.now()-loadingStarted);
    if(process.env.CHECK_SCREEN==='1')assert(await page.locator('#loading-screen').isHidden());
    await page.keyboard.down('w');
    await page.waitForFunction(()=>worldEvidence.state?.telemetry[5]>2&&!worldEvidence.state.scene.waitingCollision
      &&!worldEvidence.state.telemetry[8],null,{timeout:60000});
    const firstDriveMs=await page.evaluate(()=>performance.timeOrigin+performance.now()-loadingStarted);
    await page.keyboard.up('w');
    await page.waitForTimeout(12000);
    const trace=await page.evaluate(()=>({start:loadingStarted,events:loadingTrace,
      state:worldEvidence.state,draw:loadingDraw,errors:worldEvidence.errors,
      heap:performance.memory?.usedJSHeapSize}));
    assert.deepEqual(trace.errors,[]);
    if(process.env.CHECK_SCREEN==='1'){
      const counts=trace.events.filter(e=>e.kind==='progress'&&Number.isFinite(e.total));
      assert(counts.length>0,'Progress must contain actual work counts');
      assert(counts.every(e=>e.completed>=0&&e.completed<=e.total));
      assert(counts.some(e=>e.stage==='archives'&&e.completed===e.total));
    }
    await writeFile(new URL(`${label}.json`,output),JSON.stringify(trace));
    await page.screenshot({path:fileURLToPath(new URL(`${label}-ready.png`,output))});
    const assets=trace.events.filter(e=>e.kind==='asset'),categories={};
    assert(assets.length>0,'Nested source-worker operations must be measured');
    for(const item of assets){
      const kind=item.action==='read'?(item.path?.split('.').at(-1).toLowerCase()||'read'):item.action;
      const c=categories[kind]??={count:0,ms:0,queueMs:0};
      c.count++;c.ms+=item.end-item.start;c.queueMs+=item.start-item.queuedAt;
    }
    if(process.env.CHECK_SCREEN==='1'){
      const invalid=new URL('invalid-data/',output);
      await mkdir(invalid,{recursive:true});await writeFile(new URL('not-an-archive.txt',invalid),'Invalid Data test fixture');
      await page.locator('#files').setInputFiles(fileURLToPath(invalid));
      await page.locator('#error').waitFor({state:'visible'});
      assert(await page.locator('#loading-screen').isHidden(),'Errors must release the loading screen');
      assert.match(await page.locator('#error').innerText(),/No known WoW 1.12 MPQs/);
    }
    results.push({label,readyMs,firstDriveMs,categories,source:trace.state.source,
      water:trace.state.water,scene:trace.state.scene,far:trace.state.distant,heap:trace.heap});
  }
  assert.deepEqual(errors,[]);
  await writeFile(new URL('summary.json',output),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.map(({label,readyMs,firstDriveMs,categories})=>({label,readyMs,firstDriveMs,categories})),null,2));
} finally {await browser.close();}
