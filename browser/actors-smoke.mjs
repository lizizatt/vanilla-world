import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Edge smoke: NPC stand animation reaches the GPU near Stormwind without errors.
assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const out=new URL('./test-results/actors/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio'],ignoreDefaultArgs:['--autoplay-policy=no-user-gesture-required']}),result={errors:[]};
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const page=await context.newPage();
  page.on('pageerror',e=>result.errors.push(e.message));
  await page.goto(process.env.WORLD_URL||`http://127.0.0.1:${process.env.PORT||4183}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
  await page.evaluate(async()=>{
    const {WorldRenderer}=await import('./world-renderer.js');
    const pose=WorldRenderer.prototype.pose,draw=WorldRenderer.prototype.draw;
    window.actorProbe={posts:0,poses:0,uploads:new Map()};
    WorldRenderer.prototype.pose=function(data){
      actorProbe.posts++;actorProbe.poses+=data.poses.length;
      for(const p of data.poses)actorProbe.uploads.set(`${p.key}#${p.phase}`,p.vertices.slice(0,12).join());
      return pose.call(this,data);
    };
    WorldRenderer.prototype.draw=function(...a){actorProbe.rig=this;return draw.apply(this,a);};
  });
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  await page.evaluate(()=>{
    const r=worldEvidence.info.manifest.regions.find(r=>r.map==='Azeroth');
    worldTest.focus([-650+r.placement[0]+(32-r.tile_origin[0])*1600/3,130,
      8850+r.placement[1]+(32-r.tile_origin[1])*1600/3,0,-.3]);
  });
  await page.waitForFunction(()=>actorProbe.poses>0,null,{timeout:120000});
  await page.waitForTimeout(4000);
  const at=()=>page.evaluate(()=>Object.fromEntries([...actorProbe.rig.moves].map(([id,m])=>[id,[m.x+m.vx*(Date.now()/1000-m.t),m.y+m.vy*(Date.now()/1000-m.t),m.yaw]])));
  const first=await at();await page.waitForTimeout(6000);const later=await at();
  const moved=Object.keys(later).filter(id=>first[id]&&Math.hypot(later[id][0]-first[id][0],later[id][1]-first[id][1])>.3).length;
  await page.screenshot({path:fileURLToPath(new URL('a.png',out))});
  const sample=await page.evaluate(()=>({probe:{posts:actorProbe.posts,poses:actorProbe.poses,
    groupsGpu:actorProbe.rig.poses.size,gpuBytes:[...actorProbe.rig.poses.values()].reduce((n,e)=>n+e.size,0),
    distinctFirstVerts:new Set(actorProbe.uploads.values()).size},
    actors:worldEvidence.state.actors,errors:worldEvidence.errors,npcs:worldEvidence.render.npcInstances,moves:actorProbe.rig.moves.size}));
  sample.moved=moved;
  Object.assign(result,sample);
  assert.deepEqual(sample.errors,[]);
  assert(sample.probe.poses>0&&sample.probe.groupsGpu>0);
  assert(sample.actors.wanderers>0&&sample.moves>0,'no wandering NPCs posted');
  assert(sample.moved>0,'wandering NPCs never moved');
  assert(sample.actors.maxMs<=ACTOR_BUDGET(),`tick max ${sample.actors.maxMs}`);
  assert.deepEqual(result.errors,[]);
  console.log(JSON.stringify(sample,null,1));
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));}
function ACTOR_BUDGET(){return 6;}
