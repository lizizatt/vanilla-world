// Real selected-Data -> MPQ -> Wasm -> bounded scene pipeline in an Edge module worker.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

if (!process.env.WOW_DATA) throw new Error('Set WOW_DATA to a read-only client Data folder');
const worker = `
import init,* as wasm from '/pkg/flats_racer_web.js';
import {openDataSource} from '/asset-source.js';
import {SceneStream} from '/scene-stream.js';
self.onmessage=async({data})=>{
  let source;
  try {
    await init(); source=await openDataSource(data.catalog);
    const reads=[];
    const stream=new SceneStream({read:async path=>{reads.push(path);return source.read(path);}},wasm), results=[];
    if(data.population)stream.setPopulation(data.population);
    for(const scenario of [
      {map:1,name:'Kalimdor',tiles:[[39,43]],position:[-6120,-3980,0]},
      {map:0,name:'Azeroth',tiles:[[30,48],[31,48],[30,49],[31,49]],position:[-8850,500,90]}
    ]){
      stream.clear();
      for(const [x,y]of scenario.tiles){
        const path='World\\\\Maps\\\\'+scenario.name+'\\\\'+scenario.name+'_'+x+'_'+y+'.adt';
        stream.setTile(scenario.map+':'+x+':'+y,await source.read(path));
      }
      stream.update(scenario.map,scenario.position);
      const start=performance.now(); let pumps=0,snapshot;
      do {
        await stream.pump(); pumps++;snapshot=stream.snapshot();
        if(pumps>160||performance.now()-start>90000)throw Error('Scene admission failed to settle '+JSON.stringify({
          map:scenario.map,pumps,ms:performance.now()-start,cache:snapshot.cachedAssets,bytes:snapshot.cachedBytes,
          pending:snapshot.pending,errors:snapshot.errors,lastReads:reads.slice(-12)}));
      }while(snapshot.pending&&!snapshot.capacityBlocked);
      const assets=[...snapshot.assets.values()];
      results.push({map:scenario.map,pumps,ms:performance.now()-start,
        instances:snapshot.instances.length,npcs:snapshot.instances.filter(i=>i.id.includes(':npc:')).length,
        models:assets.length,triangles:assets.reduce((n,a)=>n+a.indices.length/3,0),
        collisionTriangles:assets.reduce((n,a)=>n+a.collisionIndices.length/3,0),
        textures:snapshot.textures.size,cutouts:assets.flatMap(a=>a.batches).filter(b=>b.alphaCutoff>0).length,
        cachedAssets:snapshot.cachedAssets,cachedModels:snapshot.cachedModels,cachedTextures:snapshot.cachedTextures,
        cachedBytes:snapshot.cachedBytes,pending:snapshot.pending,
        capacityBlocked:snapshot.capacityBlocked,errors:snapshot.errors,
        coverage:[100,250,500].map(radius=>({radius,wanted:stream.instances.filter(i=>i.score<=radius).length,
          drawable:snapshot.instances.filter(i=>i.score<=radius).length,
          npcsWanted:stream.instances.filter(i=>i.score<=radius&&i.id.includes(':npc:')).length,
          npcsDrawable:snapshot.instances.filter(i=>i.score<=radius&&i.id.includes(':npc:')).length})),
        nearestPending:Math.min(...[...stream.requests.values()].filter(r=>!stream.cache.has(r.key)).map(r=>r.score))});
    }
    stream.clear();
    self.postMessage({results,clearedBytes:stream.bytes});
  }catch(error){self.postMessage({error:String(error.stack||error)});}
  finally{await source?.close();}
};`;
const modules = new Map();
for (const name of ['asset-source.js', 'scene-stream.js', 'pkg/flats_racer_web.js', 'pkg/flats_racer_web_bg.wasm']) {
  modules.set(`/${name}`, await readFile(new URL(`./${name}`, import.meta.url)));
}
modules.set('/worker.js', worker);
const html = `<input id="data" type="file" webkitdirectory><script>
window.run=population=>new Promise((resolve,reject)=>{
const worker=new Worker('/worker.js',{type:'module'});
worker.onmessage=e=>{worker.terminate();resolve(e.data);};worker.onerror=reject;
worker.postMessage({population,catalog:[...document.querySelector('input').files].map(file=>({path:file.webkitRelativePath,file}))});
});</script>`;
const server = createServer((request, response) => {
  const content = request.url === '/' ? html : modules.get(request.url);
  if (!content) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', request.url === '/' ? 'text/html' : request.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  response.end(content);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#data').setInputFiles(process.env.WOW_DATA);
  const pack = process.env.NPC_SPAWNS ? JSON.parse(await readFile(process.env.NPC_SPAWNS, 'utf8')) : null;
  const result = await page.evaluate(pack => window.run(pack), pack);
  assert(!result.error, JSON.stringify(result));
  for (const scene of result.results) {
    assert(scene.instances > 0 && scene.triangles > 0 && scene.collisionTriangles > 0, JSON.stringify(scene));
    assert(scene.textures > 0, JSON.stringify(scene));
    assert(scene.cachedModels <= 96 && scene.cachedTextures <= 192 && scene.cachedBytes <= 96 * 1024 * 1024, JSON.stringify(scene));
    if (pack) assert(scene.npcs > 0, JSON.stringify(scene));
    assert.equal(scene.coverage[0].drawable, scene.coverage[0].wanted, 'Every requested instance within 100 yards must be admitted');
    assert.equal(scene.coverage[0].npcsDrawable, scene.coverage[0].npcsWanted, 'Near NPCs must not starve behind distant geometry');
    assert.deepEqual(scene.errors, [], 'Real scene decode errors must not be hidden');
  }
  assert.equal(result.clearedBytes, 0);
  console.log(JSON.stringify({ browser: browser.version(), ...result,
    limits: 'Actual Edge asset worker and scene buffers; renderer/GPU and swept collision integration are checked separately' }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
