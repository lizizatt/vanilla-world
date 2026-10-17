// Private local assets never leave this ephemeral loopback server/browser.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';

if(!process.env.WOW_DATA)throw Error('Set WOW_DATA to the read-only local client Data folder');
const worker=`
import init,* as wasm from '/pkg/flats_racer_web.js';
import {openDataSource} from '/asset-source.js';
import {TerrainStream} from '/terrain-stream.js';
import {SceneStream} from '/scene-stream.js';
import {loadCraft} from '/craft-stream.js';
let source,world,manifest,materials,scene,resident=[],sceneAssets=[],sceneTextures=[];
const send=(message,transfers=[])=>postMessage(message,transfers);
self.onmessage=async({data})=>{
 try{
  if(data.action==='open'){
   await init();source=await openDataSource(data.catalog);
   const wdts=[],wdls=[];
   for(const map of ['Kalimdor','Azeroth']){
    wdts.push(await source.read('World\\\\Maps\\\\'+map+'\\\\'+map+'.wdt'));
    wdls.push(await source.read('World\\\\Maps\\\\'+map+'\\\\'+map+'.wdl'));
   }
   manifest=JSON.parse(wasm.world_manifest(wdts[0],wdls[0],wdts[1],wdls[1]));
   world=new wasm.Voyage(JSON.stringify(manifest));send({event:'configure',manifest});
   materials=new TerrainStream(source,wasm,send);await materials.init(manifest);
   scene=new SceneStream(source,wasm);
   for(let region=0;region<2;region++){
    world.add_horizon(region,wdls[region]);
    const water=world.exterior_geometry(region);
    send({event:'exterior-water',region,placement:manifest.regions[region].placement,vertices:water},[water.buffer]);
    const indices=world.horizon_indices(region);send({event:'horizon-index',region,indices},[indices.buffer]);
    const patches=world.horizon_patches(region);
    for(let i=0;i<patches.length;i+=5){
     const vertices=world.horizon_vertices(region,i/5),x=patches[i],y=patches[i+1];
     send({event:'horizon',region,source:[x,y],placement:[patches[i+2],patches[i+3]],near:patches[i+4],vertices},[vertices.buffer]);
     materials.addHorizon(region,x,y);
    }
   }
  }else if(data.action==='site'){
   for(const index of resident){world.remove_tile(index);materials.removeTile(index);}
   scene.clear();
   const removed=resident;resident=[];
   const {region,x,y}=data,tiles=[];
   for(const [tx,ty]of [[x,y],[x+1,y],[x,y+1],[x+1,y+1]]){
    const index=manifest.tiles.findIndex(t=>t.region===region&&t.x===tx&&t.y===ty);
    if(index<0)continue;
    const entry=manifest.tiles[index],map=manifest.regions[region].map;
    const bytes=await source.read('World\\\\Maps\\\\'+map+'\\\\'+entry.file);
    world.add_tile(index,bytes);resident.push(index);
    scene.setTile((region===0?1:0)+':'+tx+':'+ty,bytes);
    const vertices=world.geometry(index),r=manifest.regions[region];
    tiles.push({index,placement:[r.placement[0]+tx*1600/3,r.placement[1]+ty*1600/3],vertices});
    materials.setTile(index,world.terrain_material(index));
   }
   const seams=resident.map(index=>({index,vertices:world.horizon_seams(index)}));
   send({event:'detail',tiles,removed,seams},[...tiles,...seams].map(t=>t.vertices.buffer));
   materials.prioritize(region,x,y);
   while(materials.snapshot().pending&&!materials.snapshot().errors.some(e=>e.startsWith('Terrain texture')))await materials.pump();
   for(let i=0;i<32;i++)await materials.pump();
   scene.update(region===0?1:0,[(32-y-.5)*1600/3,(32-x-.5)*1600/3,0]);
   let snapshot;
   for(let i=0;i<200;i++){
    await scene.pump();snapshot=scene.snapshot();
    if(!snapshot.pending||snapshot.capacityBlocked)break;
   }
   const assets=[...snapshot.assets].map(([key,a])=>({key,vertices:a.vertices.slice(),indices:a.indices.slice(),batches:a.batches}));
   const textures=[...snapshot.textures].map(([key,t])=>({key,width:t.width,height:t.height,rgba:t.rgba.slice()}));
   send({event:'scene',region,assets,textures,instances:snapshot.instances,removedAssets:sceneAssets,removedTextures:sceneTextures},
    [...assets.flatMap(a=>[a.vertices.buffer,a.indices.buffer]),...textures.map(t=>t.rgba.buffer)]);
   sceneAssets=assets.map(a=>a.key);sceneTextures=textures.map(t=>t.key);
   send({event:'site-ready',region,x,y,resident,snapshot:materials.snapshot(),sceneErrors:snapshot.errors});
  }else if(data.action==='craft'){
   world.initialize_spawn();
   send({event:'craft-state',telemetry:Array.from(world.telemetry())});
   await loadCraft(source,wasm,send);
  }else if(data.action==='overview'){
   while(materials.snapshot().farPending)await materials.pump();
  }
  send({event:'done',id:data.id,snapshot:materials.snapshot()});
 }catch(error){send({event:'failed',id:data.id,error:String(error.stack||error)});}
};`;
const html=`<!doctype html><style>body{margin:0}canvas{width:1280px;height:720px}input{display:none}</style>
<input id="data" type="file" webkitdirectory><canvas></canvas><script type="module">
import {WorldRenderer} from '/world-renderer.js';
import {terrainMips} from '/terrain-stream.js';
window.errors=[];window.renderer=await WorldRenderer.create(document.querySelector('canvas'),e=>errors.push(String(e)));
let next=0,pending=new Map(),manifest,site,worker=new Worker('/worker.js',{type:'module'});
worker.onmessage=({data})=>{
 if(data.event==='configure')window.pendingManifest=data.manifest;
 else if(data.event==='done'||data.event==='failed'){const callback=pending.get(data.id);pending.delete(data.id);callback(data);}
 else if(data.event==='site-ready'){site=data;window.site=data;}
 else if(data.event==='craft-state')window.vehicle=data.telemetry;
 else {if(data.event==='terrain-material')window.lastMaterial=data;renderer.event(data);}
};
window.request=message=>new Promise(resolve=>{message.id=++next;pending.set(next,resolve);worker.postMessage(message);});
window.openData=async()=>{
 const result=await request({action:'open',catalog:[...document.querySelector('input').files].map(file=>({path:file.webkitRelativePath,file}))});
 manifest=window.pendingManifest;window.manifest=manifest;renderer.configure(manifest);return result;
};
window.flight=[0,1000,0,0,-.3];window.frames=[];window.stats={};let last=0;
function frame(time){
 if(manifest){
  const dt=last?(time-last)/1000:1/60;
  const state=window.vehicle||[manifest.spawn[0],manifest.spawn[1],manifest.spawn[2],0,0,0,0,0,0,0,0,0,0];
  stats=renderer.draw(state,flight,dt,0,{horizon:true,scenery:window.showScenery!==false,distant:false});
  if(last)frames.push(time-last);
 }last=time;requestAnimationFrame(frame);
}requestAnimationFrame(frame);
window.pixels=async url=>{
 const image=await createImageBitmap(await(await fetch(url)).blob()),c=document.createElement('canvas');c.width=image.width;c.height=image.height;
 const ctx=c.getContext('2d');ctx.drawImage(image,0,0);image.close();
 const bytes=ctx.getImageData(0,0,c.width,c.height).data;
 let different=0;const colors=new Set();
 for(let i=0;i<bytes.length;i+=16){colors.add(bytes[i]+256*bytes[i+1]+65536*bytes[i+2]);
  if(Math.abs(bytes[i]-20)+Math.abs(bytes[i+1]-38)+Math.abs(bytes[i+2]-51)>20)different++;}
 return {different,colors:colors.size,center:[...ctx.getImageData(640,360,1,1).data]};
};
window.oracle=async()=>{
 const colors=Array.from({length:4},(_,i)=>[...lastMaterial.layers[i%lastMaterial.layers.length].mips.at(-1)]);
 renderer.reset();renderer.configure({...manifest,ocean:[10000,10000,10001,10001],sea_level:-1000});
 const vertices=new Float32Array([-1000,0,-1000,1000,0,-1000,0,0,1000].flatMap((_,i,a)=>
  i%3===0?[a[i],a[i+1],a[i+2],0,1,0,.25,.25,0,1,2,3,0]:[]));
 renderer.event({event:'detail',removed:[],seams:[],tiles:[{index:0,placement:[0,0],vertices:new Float32Array(0)}]});
 const masks=new Uint8Array(16384);for(let i=0;i<masks.length;i+=4)masks.set([128,64,192,255],i);
 renderer.event({event:'terrain-material',index:0,vertices,indices:new Uint32Array([0,1,2]),masks,
  layers:colors.map(color=>({mips:terrainMips({width:1,height:1,rgba:new Uint8Array(color)})}))});
 flight=[0,100,0,0,-Math.PI/2+.00001];
 await new Promise(resolve=>setTimeout(resolve,500));
 const weights=[128/255,64/255,192/255],light=(.4+.6/Math.sqrt(1.25))*.7;
 const expected=[0,1,2].map(c=>{
  let value=colors[0][c];for(let i=0;i<3;i++)value=value*(1-weights[i])+colors[i+1][c]*weights[i];
  return Math.round(value*light*(1-100/150000)+[.08,.15,.2][c]*255*100/150000);
 });
 return {colors,weights,expected};
};
window.ready=true;
</script>`;
const modules=new Map([['/worker.js',worker]]);
for(const name of ['world-renderer.js','world-camera.js','terrain-stream.js','craft-stream.js','scene-stream.js','asset-source.js','pkg/flats_racer_web.js','pkg/flats_racer_web_bg.wasm']){
  modules.set('/'+name,await readFile(new URL('./'+name,import.meta.url)));
}
const server=createServer((req,res)=>{
  const body=req.url==='/'?html:modules.get(req.url);
  if(!body){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',req.url==='/'?'text/html':req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(body);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
  const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e)));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>window.ready,{},{timeout:30000});
  await page.locator('#data').setInputFiles(process.env.WOW_DATA);
  assert(!(await page.evaluate(()=>openData())).error);
  const artifact=resolve(process.env.TERRAIN_ARTIFACTS||'terrain-evidence');
  await mkdir(artifact,{recursive:true});
  const results=[];
  for(const site of [
    {name:'raceway',region:0,x:39,y:43},{name:'elwynn',region:1,x:32,y:49},
    {name:'stormwind',region:1,x:30,y:48},{name:'durotar',region:0,x:40,y:30},
    {name:'raceway-reload',region:0,x:39,y:43},
  ]){
    const result=await page.evaluate(s=>request({action:'site',...s}),site);
    assert(!result.error,JSON.stringify(result));
    assert.deepEqual(result.snapshot.errors.filter(e=>e.startsWith('Terrain texture')),[]);
    await page.waitForFunction(()=>stats.texturedTerrainTiles===window.site.resident.length&&stats.terrainUploadPending===0,{},{timeout:60000});
    await page.evaluate(()=>{
      const r=manifest.regions[site.region],tile=renderer.tiles.get(site.resident[0]);
      let height=0; // Probe the retained authored liquid stream only for water; the view remains safely above terrain.
      for(const t of renderer.tiles.values())if(t.liquid.length)height=Math.max(height,t.liquid[1]);
      flight=[r.placement[0]+(site.x+.5)*1600/3,height+180,r.placement[1]+(site.y+1.05)*1600/3,0,-.48];frames=[];
    });
    await page.waitForTimeout(2500);
    const png=await page.screenshot({path:resolve(artifact,site.name+'.png')});
    const pixels=await page.evaluate(url=>window.pixels(url),'data:image/png;base64,'+png.toString('base64'));
    assert(pixels.different>10000&&pixels.colors>100,JSON.stringify({site,pixels,errors:await page.evaluate(()=>errors)}));
    const evidence=await page.evaluate(()=>({stats,adapter:renderer.adapter,errors,frames}));
    assert.deepEqual(evidence.errors,[]);assert(evidence.stats.terrainGpuBytes<4*32*1024*1024);
    assert(evidence.stats.sceneDraws>0&&evidence.stats.texturedDraws>0);
    assert.deepEqual(await page.evaluate(()=>site.sceneErrors),[]);
    const frames=evidence.frames.sort((a,b)=>a-b);
    results.push({site:site.name,pixels,...evidence,frames:undefined,p50Ms:frames[Math.floor(frames.length*.5)],
      p95Ms:frames[Math.floor(frames.length*.95)],stream:result.snapshot});
    if(site.name==='raceway'){
      const craft=await page.evaluate(()=>request({action:'craft'}));
      assert(!craft.error,JSON.stringify(craft));
      await page.evaluate(()=>{window.previousFlight=flight;flight=null;window.showScenery=false;renderer.camera=undefined;});
      await page.waitForTimeout(600);
      const craftEvidence=await page.evaluate(()=>({stats,metadata:renderer.craft.metadata,errors}));
      assert.equal(craftEvidence.stats.craftDraws,6);
      assert.equal(craftEvidence.stats.sceneDraws,6,'Craft renders with scenery off, in its own residency namespace');
      assert.equal(craftEvidence.metadata.attachment0.bone,74);
      assert.equal(craftEvidence.metadata.cockpitAvailable,false);
      assert.deepEqual(craftEvidence.errors,[]);
      await page.screenshot({path:resolve(artifact,'authored-craft-scenery-off.png')});
      results.push({site:'authored-craft-scenery-off',...craftEvidence});
      await page.evaluate(()=>{flight=window.previousFlight;window.showScenery=true;});
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>stats.craftDraws),0,'Flight hides the vehicle');
    }
  }
  const far=await page.evaluate(()=>request({action:'overview'}));
  assert(!far.error,JSON.stringify(far));assert(far.snapshot.minimaps>1000);
  await page.evaluate(()=>{
    const r=manifest.regions[1];flight=[manifest.ocean[0]+4096,55000,r.placement[1]+32*1600/3,0,-Math.PI/2+.001];frames=[];
  });
  await page.waitForTimeout(1500);
  await page.screenshot({path:resolve(artifact,'two-continent-overview.png')});
  const oracle=await page.evaluate(()=>window.oracle());
  const oraclePng=await page.screenshot({path:resolve(artifact,'layer-blend-oracle.png')});
  oracle.pixel=(await page.evaluate(url=>window.pixels(url),'data:image/png;base64,'+oraclePng.toString('base64'))).center;
  assert(oracle.expected.every((value,i)=>Math.abs(value-oracle.pixel[i])<=2),JSON.stringify(oracle));
  assert.deepEqual(await page.evaluate(()=>errors),[]);
  assert.deepEqual(pageErrors,[]);
  const summary={browser:browser.version(),resolution:[1280,720],results,overview:far.snapshot,oracle,
    limits:'Isolated terrain + authored scene hardware renderer; no NPC pack. Physics/streaming driving FPS measured by integrated performance harness.'};
  await writeFile(resolve(artifact,'results.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
