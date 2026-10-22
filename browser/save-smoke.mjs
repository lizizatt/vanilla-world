import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

assert(process.env.WOW_DATA,'Set WOW_DATA to your local Classic Data folder');
const output=new URL('./test-results/save-contract/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const context=await browser.newContext({viewport:{width:1280,height:800}});
await context.addInitScript(()=>{
  window.saveRequests=[];
  const post=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message,...args){
    if(['tuning','restore'].includes(message.action))
      saveRequests.push({action:message.action,pose:message.pose,values:message.values});
    if(message.action==='restore'){
      const receive=event=>{
        if(event.data.id!==message.id)return;
        window.savedRestoreReply=event.data;
        this.removeEventListener('message',receive);
      };
      this.addEventListener('message',receive);
    }
    return post.call(this,message,...args);
  };
});
const page=await context.newPage(),evidence={errors:[]};
page.on('pageerror',error=>evidence.errors.push(error.message));
const ready=async()=>{
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
};
const saved=()=>page.evaluate(async()=>{
  const {worldSave}=await import('./world-store.js');return worldSave(worldEvidence.info.id);
});
try {
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:4183/');
  await ready();
  await page.waitForFunction(()=>worldEvidence.state.telemetry[7]===1&&worldEvidence.state.scene.waitingCollision===0);
  const before=await page.evaluate(()=>worldEvidence.state.telemetry.slice());
  evidence.before=before;
  await page.locator('#preferences > summary').click();await page.locator('#tuning').click();
  await page.waitForFunction(()=>document.getElementById('tuning-panel').open);
  await page.locator('#tune-11').fill('30');
  await page.locator('#tuning-form button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('tuning-status').textContent==='Saved.');
  await page.locator('#tuning-close').click();await page.locator('#preferences > summary').click();
  await page.waitForFunction(y=>worldEvidence.state.telemetry[1]>y+25
    &&worldEvidence.state.telemetry[7]===1,before[1],{timeout:30000});
  await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Saved.');
  evidence.highHover=await saved();
  assert(evidence.highHover.vehicle[1]>before[1]+24,'The saved pose must exceed the old 20-yard ceiling');
  await context.setOffline(true);await page.reload();await ready();
  evidence.restoreOrder=await page.evaluate(()=>saveRequests);
  const tune=evidence.restoreOrder.findIndex(r=>r.action==='tuning'&&r.values?.[11]===30);
  const pose=evidence.restoreOrder.findIndex(r=>r.action==='restore');
  assert(tune>=0&&pose>tune,'Persisted handling must be applied before pose validation');
  evidence.restored=await page.evaluate(()=>savedRestoreReply.result.telemetry);
  assert.equal(evidence.restored[1],evidence.highHover.vehicle[1]);
  await page.locator('#preferences > summary').click();await page.locator('#tuning').click();
  await page.waitForFunction(()=>document.getElementById('tuning-panel').open);
  assert.equal(await page.locator('#tune-11').inputValue(),'30');
  await page.locator('#tuning-close').click();await page.locator('#preferences > summary').click();
  const retained=await saved();
  await page.evaluate(async()=>{
    const {WorldClient}=await import('./world-client.js'),request=WorldClient.prototype.request;
    WorldClient.prototype.request=async function(action,...args){
      const state=await request.call(this,action,...args);
      if(action==='snapshot'){
        WorldClient.prototype.request=request;
        return {...state,telemetry:state.telemetry.map((v,i)=>i===1?NaN:v)};
      }
      return state;
    };
  });
  await page.locator('#save').click();
  await page.waitForFunction(()=>!document.getElementById('error').hidden);
  assert.match(await page.locator('#error').innerText(),/incompatible or damaged/);
  assert.deepEqual(await saved(),retained,'An invalid outgoing pose cannot overwrite a valid save');
  evidence.invalidSnapshotRetainedSave=true;
  assert.deepEqual(evidence.errors,[]);
  evidence.browser=browser.version();
  await writeFile(new URL('evidence.json',output),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  evidence.failure=error.stack;
  await writeFile(new URL('failure.json',output),JSON.stringify(evidence,null,2));
  throw error;
} finally {await browser.close();}
