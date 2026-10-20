import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({serviceWorkers:'block'});
const page=await context.newPage(),errors=[];
await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto('http://127.0.0.1:4183/?test');
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.waitForFunction(()=>worldEvidence.state.telemetry[7]===1
    && !worldEvidence.state.scene?.waitingCollision,null,{timeout:120000});
  const pose=await page.evaluate(()=>{
    const p=worldEvidence.state.telemetry;
    return [p[0],p[1]+100,p[2],p[3]];
  });
  const results=[];
  for(const boost of [false,true]){
    await page.locator('#world').focus();
    const start=await page.evaluate(pose=>worldTest.request('restore',{pose}),pose);
    assert.equal(start.telemetry[5],0,'Each fall starts at horizontal rest');
    await page.keyboard.down('KeyW');
    if(boost)await page.keyboard.down('ShiftLeft');
    await page.waitForTimeout(550);
    const end=await page.evaluate(()=>Array.from(worldEvidence.state.telemetry));
    await page.keyboard.up('KeyW');await page.keyboard.up('ShiftLeft');
    const drop=pose[1]-end[1];
    assert.equal(end[7],0,'The measured interval stays airborne');
    assert.equal(end[8],0,'Thrust must not hold the falling vehicle');
    assert(end[5]>5&&drop>1,'Forward motion and gravity must both continue');
    if(boost)assert(end[6]<.9,'Airborne boost consumes reserve');
    else assert.equal(end[6],1,'Ordinary air thrust does not consume boost');
    results.push({boost,speed:end[5],drop,reserve:end[6],rate:end[5]/Math.sqrt(drop)});
  }
  assert(results[1].rate>results[0].rate*1.6,'Boost adds thrust, not just reserve consumption');
  assert.deepEqual(errors,[]);
  await mkdir(new URL('./test-results/airborne/',import.meta.url),{recursive:true});
  await writeFile(new URL('./test-results/airborne/functional.json',import.meta.url),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
