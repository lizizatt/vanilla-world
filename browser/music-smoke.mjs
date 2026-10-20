import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

// Actual-Edge smoke for runtime zone music: needs WOW_DATA and a server on 4183. Audio is never written to disk.
assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const label=process.env.LABEL||'music-smoke';
assert(/^[\w-]+$/.test(label));
const out=new URL(`./test-results/${label}/`,import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const result={steps:[],errors:[]};
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',error=>result.errors.push(error.message));
  page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});
  await page.goto('http://127.0.0.1:4183/?test');
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.locator('#sound').check();
  const snap=()=>page.evaluate(()=>({music:worldEvidence.music,area:worldEvidence.state?.area,audio:worldEvidence.audio?.state}));
  const wait=(fn,arg,timeout=60000)=>page.waitForFunction(fn,arg,{timeout,polling:250});
  await wait(()=>worldEvidence.music?.set>0&&worldEvidence.music.active&&worldEvidence.music.time>.5);
  const first=await snap();result.steps.push({step:'start zone',...first});
  assert.match(first.music.track,/^Sound\\Music\\/i);
  await page.evaluate(()=>{document.getElementById('preferences').open=true;});
  await page.locator('#music-volume').fill('0');
  await wait(()=>worldEvidence.music.volume===0&&!worldEvidence.music.active);
  result.steps.push({step:'volume 0 silences',...await snap()});
  await page.locator('#music-volume').fill('50');
  await page.evaluate(async()=>{
    const r=worldEvidence.info.manifest.regions.find(r=>r.map==='Azeroth'),p=[-9470,-160,95];
    await worldTest.request('restore',{pose:[-p[1]+r.placement[0]+(32-r.tile_origin[0])*1600/3,p[2]+30,
      -p[0]+r.placement[1]+(32-r.tile_origin[1])*1600/3,0]});
  });
  const before=first.music.set;
  await wait(b=>worldEvidence.music.set>0&&worldEvidence.music.set!==b&&worldEvidence.music.active&&worldEvidence.music.time>.3,before,90000);
  result.steps.push({step:'zone change crossfades to new set',...await snap()});  const m=await page.evaluate(()=>worldEvidence.music);
  assert.equal(m.errors,0,m.error);
  result.steps.push({step:'volume restored',music:m});
}finally{
  await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));
  await browser.close();
}
assert.deepEqual(result.errors,[]);
console.log(JSON.stringify(result,null,2));
