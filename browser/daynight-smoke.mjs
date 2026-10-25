import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Edge smoke: day and night (pinned via timeLock) render without GPU errors; the IST readout and fly-only speed slider exist.
assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const out=new URL('./test-results/daynight/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),result={errors:[]};
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',e=>result.errors.push(e.message));
  await page.goto(process.env.WORLD_URL||`http://127.0.0.1:${process.env.PORT||4183}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  const places={
    stormwind:r=>[-650+r.placement[0]+(32-r.tile_origin[0])*1600/3,130,8850+r.placement[1]+(32-r.tile_origin[1])*1600/3,0,-.3],
    coast:r=>[-(-5000)+r.placement[0]+(32-r.tile_origin[0])*1600/3,250,9800+r.placement[1]+(32-r.tile_origin[1])*1600/3,Math.PI/2,-.5]};
  assert.match(await page.evaluate(()=>document.getElementById('ist-clock').textContent),/^\d\d:\d\d IST$/);
  await page.evaluate(src=>{const r=worldEvidence.info.manifest.regions.find(r=>r.map==='Azeroth');
    worldTest.focus(eval(`(${src})`)(r));},places.stormwind.toString());
  await page.waitForTimeout(15000);
  for(const mode of ['day','night']){
    await page.evaluate(m=>worldTest.timeLock(m==='night'?0:1440),mode);
    await page.waitForTimeout(2500);
    await page.screenshot({path:fileURLToPath(new URL(`${mode}.png`,out))});
    result[mode]=await page.evaluate(()=>({errors:worldEvidence.errors,night:worldEvidence.music?.night}));
    assert.deepEqual(result[mode].errors,[]);
  }
  assert.equal(result.night.night,true);
  await page.evaluate(()=>document.getElementById('world')?.focus());
  assert.deepEqual(result.errors,[]);
  console.log(JSON.stringify(result,null,1));
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));}
