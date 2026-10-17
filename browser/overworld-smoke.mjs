import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

if(!process.env.WOW_DATA)throw new Error('Set WOW_DATA to your read-only Classic Data folder');
const out=new URL('./test-results/overworld/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];
const checkpoints=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try {
  await page.goto('http://127.0.0.1:4173/?test');
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>window.worldEvidence.ready || window.worldEvidence.errors.length,{},{timeout:180000});
  let state=await page.evaluate(()=>window.worldEvidence);
  assert.deepEqual(state.errors,[]);
  assert(state.ready,'World did not open');
  await page.waitForFunction(()=>window.worldEvidence.state?.scene?.instances>0,{},{timeout:120000});
  await page.waitForTimeout(12000);
  state=await page.evaluate(()=>window.worldEvidence);
  const capture=async name=>{
    const current=await page.evaluate(()=>window.worldEvidence);
    assert.deepEqual(current.errors,[],name);assert(current.state.peak<=4);
    checkpoints.push({name,state:current.state,render:current.render,camera:current.camera});
    await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,out))});
    return current;
  };
  await capture('raceway');
  assert.equal(state.state.horizon.patches,1705);
  assert(state.render.npcInstances>0,'Static NPC meshes must actually reach the renderer');
  assert.equal(state.state.failures.length,0);
  assert(state.state.source.maxReadBytes<=1048576);
  await page.waitForFunction(()=>window.worldEvidence.state.scene.waitingCollision===0,{},{timeout:30000});
  const start=state.state.telemetry;
  await page.locator('#world').focus();await page.keyboard.down('KeyW');await page.waitForTimeout(2600);await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyX');await page.waitForTimeout(500);await page.keyboard.up('KeyX');
  state=await page.evaluate(()=>window.worldEvidence);
  assert(Math.hypot(state.state.telemetry[0]-start[0],state.state.telemetry[2]-start[2])>20,
    `Actual keyboard drive must move on real raceway ground: ${JSON.stringify(state.state)}`);
  await capture('driven-raceway');
  await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Saved'));
  await page.locator('#preferences > summary').click();
  await page.locator('#overview').click();await page.waitForTimeout(1500);
  state=await capture('complete-continents');
  assert.equal(state.render.horizonTiles,1705);
  const m=state.info.manifest,tile=1600/3;
  assert(Math.abs(m.regions[1].placement[1]-(-51*tile+11200))<.001);
  await page.keyboard.down('KeyE');await page.waitForTimeout(500);await page.keyboard.up('KeyE');
  const flown=await page.evaluate(()=>window.worldEvidence.camera);
  assert(flown[1]>state.camera[1]+300,'Actual keyboard flight must move');
  await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Saved'));
  const savedCamera=await page.evaluate(()=>window.worldEvidence.camera);
  const parked=await page.evaluate(async()=>{
    const {worldSave}=await import('./world-store.js');
    return (await worldSave(window.worldEvidence.info.id)).vehicle;
  });
  const focus=async(region,source,yaw=0,pitch=-.3)=>{
    const r=m.regions[region],p=[-source[1]+r.placement[0]+32*tile,source[2],-source[0]+r.placement[1]+32*tile,yaw,pitch];
    await page.evaluate(p=>window.worldTest.focus(p),p);
    await page.waitForTimeout(12000);
  };
  await focus(1,[-9450,-100,100],0,-.4);state=await capture('elwynn');
  assert(state.render.alphaDraws>0,'Authored foliage must reach the alpha-tested GPU pipeline');
  await focus(1,[-8833,628,160],0,-.55);state=await capture('stormwind');
  assert(state.render.wmoInstances>0 && state.render.texturedDraws>0,'City must render actual textured WMO groups');
  await focus(0,[1600,-4400,120],0,-.4);await capture('durotar');
  await page.evaluate(()=>window.worldTest.focus([288,60,160,-Math.PI/2,-.25]));await page.waitForTimeout(6000);
  const surface=await page.evaluate(()=>worldTest.request('probe',{points:[[288,160]]}));
  const floor=Math.max(...surface[0].slice(1,3).filter(Number.isFinite));
  assert(Number.isFinite(floor));
  await page.evaluate(pose=>worldTest.request('restore',{pose}),[288,floor+1.1,160,-Math.PI/2]);
  await page.locator('#drive').click();
  await page.waitForFunction(()=>worldEvidence.state.scene.waitingCollision===0,{},{timeout:30000});
  const beforeDrive=await page.evaluate(()=>structuredClone(worldEvidence.state));
  await page.keyboard.down('KeyW');await page.waitForTimeout(24000);await page.keyboard.up('KeyW');
  state=await capture('coastal-stream-drive');
  assert(state.state.telemetry[0]>600,'Drive must cross a real ADT boundary');
  checkpoints.at(-1).drive={seconds:24,distance:state.state.telemetry[0]-beforeDrive.telemetry[0],
    holds:Object.fromEntries(Object.entries(state.state.holds).map(([k,v])=>[k,{
      episodes:v.episodes-beforeDrive.holds[k].episodes,ms:v.ms-beforeDrive.holds[k].ms,
    }]))};
  await page.locator('#load').click();await page.waitForTimeout(1500);
  state=await page.evaluate(()=>window.worldEvidence);
  assert.deepEqual(state.camera,savedCamera);
  assert(Math.hypot(state.state.telemetry[0]-parked[0],state.state.telemetry[2]-parked[2])<1);
  await page.context().setOffline(true);await page.reload();
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>window.worldEvidence.ready || window.worldEvidence.errors.length,{},{timeout:180000});
  state=await page.evaluate(()=>window.worldEvidence);
  assert.deepEqual(state.errors,[]);
  await page.waitForFunction(()=>window.worldEvidence.camera?.length===5);
  state=await capture('offline-reloaded');
  assert.deepEqual(state.camera,savedCamera);
  await writeFile(new URL('evidence.json',out),JSON.stringify({browser:browser.version(),checkpoints,consoleErrors:errors},null,2));
  console.log(JSON.stringify({browser:browser.version(),checkpoints:checkpoints.map(c=>({name:c.name,scene:c.state.scene,
    failures:c.state.failures,render:c.render})),consoleErrors:errors},null,2));
  assert.deepEqual(errors,[]);
} finally {await browser.close();}
