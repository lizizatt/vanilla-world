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
  for(const label of ['before','after']){
    const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
    try {
      await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
      if(label==='before')await context.route('**/flats_racer_web_bg.wasm',async route=>
        route.fulfill({contentType:'application/wasm',body:await readFile(new URL('before.wasm',output))}));
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
      const result={label,routes:[]};
      evidence.cases.push(result);
      result.defaults=await page.evaluate(()=>worldTest.request('tuning'));
      if(label==='after')assert.deepEqual(result.defaults,requested.map(Math.fround));
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
      if(label==='before')assert(result.fixture[0].stats[5]>0,'Old build must reproduce the false support-edge hold');
      else {assert.equal(result.fixture[0].pose[8],0);assert(result.fixture[0].pose[0]>715);}
      for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2]){
        await page.keyboard.up('KeyW');
        await page.evaluate(()=>worldTest.focus([-1055,120,6446,0,-.3]));
        await page.waitForTimeout(4500);
        const route=await page.evaluate(async ({yaw,knownHeight})=>{
          const points=[[-1055-.85,6446-.85],[-1055+.85,6446-.85],[-1055-.85,6446+.85],[-1055+.85,6446+.85]];
          const support=await worldTest.request('probe',{points});
          if(support.some(p=>p[0]!==0))throw Error(`Site support unavailable: ${JSON.stringify(support)}`);
          const ground=Math.max(...support.flatMap(p=>p.slice(1,3).filter(Number.isFinite)));
          const rejected=[];
          for(const y of knownHeight===undefined?[ground+3,ground+6,ground+12,ground+24]:[knownHeight]){
            const pose=[-1055,y,6446,yaw];
            try {
              const state=await worldTest.request('restore',{pose});
              return {yaw,pose,support,rejected,before:structuredClone(state)};
            } catch(error){
              if(!error.message.includes('overlaps authored collision'))throw error;
              rejected.push({pose,error:error.message});
            }
          }
          throw Error(`No clear isolated start at rounded reported coordinates: ${JSON.stringify(rejected)}`);
        },{yaw,knownHeight:evidence.siteHeight});
        evidence.siteHeight??=route.pose[1];
        await page.locator('#drive').click();await page.locator('#world').focus();
        await page.keyboard.down('KeyW');await page.waitForTimeout(3000);await page.keyboard.up('KeyW');
        route.after=await page.evaluate(()=>structuredClone(worldEvidence.state));
        route.distance=Math.hypot(route.after.telemetry[0]-route.pose[0],route.after.telemetry[2]-route.pose[2]);
        result.routes.push(route);
      }
      await page.screenshot({path:fileURLToPath(new URL(`${label}-gadgetzan.png`,output))});
      if(label==='after'){
        await page.evaluate(async()=>{
          const m=worldEvidence.info.manifest;
          await worldTest.request('restore',{pose:[(m.ocean[0]+m.ocean[2])/2,m.sea_level+3,(m.ocean[1]+m.ocean[3])/2,0]});
        });
        await page.locator('#world').focus();await page.keyboard.down('KeyW');await page.waitForTimeout(1000);
        await page.locator('#preferences').evaluate(e=>{e.open=true;});
        await page.locator('#tuning').click();await page.keyboard.up('KeyW');
        await page.waitForFunction(()=>document.getElementById('tuning-panel').open&&worldEvidence.input.flags===0);
        await page.locator('#tune-0').focus();await page.keyboard.press('KeyW');await page.keyboard.press('KeyX');
        result.panel=await page.evaluate(()=>({input:worldEvidence.input,speed:worldEvidence.state.telemetry[5],
          text:document.getElementById('tuning-panel').textContent}));
        assert.equal(result.panel.input.throttle,0);assert.equal(result.panel.input.flags,0);
        assert(result.panel.speed>1,'Opening Handling must not freeze the vehicle');
        assert(!result.panel.text.includes('Brakes held'));
        await page.locator('#tune-0').fill('42');await page.locator('#tuning-form button[type=submit]').click();
        await page.waitForFunction(()=>document.getElementById('tuning-status').textContent==='Saved.');
        await page.reload();await ready();
        assert.equal((await page.evaluate(()=>worldTest.request('tuning')))[0],42,'Saved override must survive new defaults');
        await page.locator('#preferences').evaluate(e=>{e.open=true;});await page.locator('#tuning').click();
        await page.locator('#tuning-defaults').click();
        await page.waitForFunction(()=>document.getElementById('tuning-status').textContent==='Saved.');
        result.restoredDefaults=await page.evaluate(()=>Array.from(document.querySelectorAll('#tuning-fields input'),e=>Number(e.value)));
        assert.deepEqual(result.restoredDefaults,[...requested.map(Math.fround),.5]);
        await page.locator('#tuning-close').click();await page.locator('#world').focus();
        await page.keyboard.down('KeyX');
        await page.waitForFunction(()=>(worldEvidence.input.flags&1)!==0);await page.keyboard.up('KeyX');
      }
    } finally {await context.close();}
  }
  const [before,after]=evidence.cases;
  const affected=before.routes.map((r,i)=>r.after.physicsStats[5]>r.before.physicsStats[5]?i:-1).filter(i=>i>=0);
  assert(affected.length,'Authored Gadgetzan terrain must reproduce at least one false support-edge hold');
  for(const i of affected){
    assert.equal(after.routes[i].after.physicsStats[5]-after.routes[i].before.physicsStats[5],0);
    assert(after.routes[i].distance>before.routes[i].distance+20);
  }
  assert.deepEqual(evidence.errors,[]);
  evidence.browser=browser.version();
} catch(error) {evidence.failure=error.stack;throw error;}
finally {
  await writeFile(new URL('evidence.json',output),JSON.stringify(evidence,null,2));
  await browser.close();
}
console.log(JSON.stringify(evidence.cases.map(c=>({label:c.label,fixture:c.fixture,
  routes:c.routes.map(r=>({yaw:r.yaw,distance:r.distance,hold:r.after.telemetry[8],wait:r.after.scene.waitingCollision,
    capacity:r.after.scene.capacityBlocked,pending:r.after.scene.pending,
    stats:r.after.physicsStats.map((n,i)=>n-r.before.physicsStats[i])}))})),null,2));
