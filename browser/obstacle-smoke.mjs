import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to the local Data directory');
const base=process.env.BASE_URL||'http://127.0.0.1:4183';
assert(!base.includes(':4173'),'Never use the live page for obstacle reproduction');
const output=new URL('./test-results/elevated-obstacles/',import.meta.url);
await mkdir(output,{recursive:true});
const requested=[150,300,50,50,30,.25,2.2,10,8,1.5,1.3,3,90,18,24,7,.9];
const evidence={requested,cases:[],errors:[]};
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
try {
  for(const label of ['after']){
    const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
    try {
      await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
      await context.route('**/world-engine.js',async route=>{
        const response=await route.fetch(),source=await response.text();
        const hook='return {telemetry:Array.from(world.telemetry()),';
        assert(source.includes(hook));
        await route.fulfill({response,body:source.replace(hook,
          'return {physicsStats:Array.from(world.physics_stats()),telemetry:Array.from(world.telemetry()),')});
      });
      const page=await context.newPage();
      page.on('pageerror',error=>evidence.errors.push(`${label}: ${error.message}`));
      const ready=async()=>{
        await page.waitForFunction(()=>!document.getElementById('select').disabled);
        await page.locator('#files').setInputFiles(process.env.WOW_DATA);
        await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
        assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
      };
      await page.goto(`${base}/?test`);await ready();
      const result={label};
      evidence.cases.push(result);
      result.defaults=await page.evaluate(()=>worldTest.request('tuning'));
      assert.equal(result.defaults.length,requested.length);
      await page.evaluate(values=>worldTest.request('tuning',{values}),requested);
      result.fixture=await page.evaluate(async values=>{
        const {default:init,Voyage}=await import('./pkg/flats_racer_web.js');await init();
        const tile=1600/3;
        const manifest={version:1,label:'isolated low platform',regions:[
          {id:'west',map:'Kalimdor',tile_origin:[41,33],tile_count:[1,1],placement:[0,0]},
          {id:'east',map:'Azeroth',tile_origin:[28,51],tile_count:[1,1],placement:[2000,0]}],
          tiles:[{region:0,x:41,y:33,file:'Kalimdor_41_33.adt',bytes:1,sha256:'a'.repeat(64)},
            {region:1,x:28,y:51,file:'Azeroth_28_51.adt',bytes:1,sha256:'a'.repeat(64)}],
          horizons:[],ocean:[tile,0,2000,tile],sea_level:0,spawn:[200,1.1,64,0],destination:[2200,64]};
        const runs=[];
        for(const wall of [false,true]){
          const w=new Voyage(JSON.stringify(manifest));
          try {
            w.set_tuning(values);w.restore([700,3,64,-Math.PI/2]);
            w.set_scene_mesh(new Float64Array(wall?
              [704,0,54,704,10,54,704,10,74,704,0,54,704,10,74,704,0,74]:
              [704,1,54,710,1,54,710,1,74,704,1,54,710,1,74,704,1,74]));
            for(let i=0;i<180;i++){w.tick(1,0,0);if(w.telemetry()[8])break;}
            runs.push({wall,pose:Array.from(w.telemetry()),stats:Array.from(w.physics_stats())});
          } finally {w.free();}
        }
        return runs;
      },requested);
      assert(result.fixture[1].stats[4]>0,'Real walls must still block');
      {assert.equal(result.fixture[0].pose[8],0);assert(result.fixture[0].pose[0]>715);}
    } finally {await context.close();}
  }
  assert.deepEqual(evidence.errors,[]);
  evidence.browser=browser.version();
} catch(error) {evidence.failure=error.stack;throw error;}
finally {
  await writeFile(new URL('evidence.json',output),JSON.stringify(evidence,null,2));
  await browser.close();
}
console.log(JSON.stringify(evidence.cases.map(c=>({label:c.label,fixture:c.fixture})),null,2));
