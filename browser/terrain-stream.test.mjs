import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TerrainStream,minimapCatalog,resizeRgba,terrainMips,TERRAIN_CACHE_LIMIT} from './terrain-stream.js';
import {WorldRenderer,terrainEdgeMask} from './world-renderer.js';

test('initial worker geometry waits for manifest and atlas configuration without dropping events',()=>{
  const renderer=Object.create(WorldRenderer.prototype);
  renderer.pendingEvents=[];
  const event={event:'detail',tiles:[{index:0}],removed:[],seams:[]};
  renderer.event(event);
  assert.equal(renderer.pendingEvents[0],event);
  const replayed=[];
  renderer.device={createTexture:()=>({})};renderer.water=[];renderer.drawable=()=>({});
  renderer.event=data=>replayed.push(data);
  const old=globalThis.GPUTextureUsage;globalThis.GPUTextureUsage={TEXTURE_BINDING:1,COPY_DST:2};
  try{renderer.configure({regions:[{}],ocean:[0,0,1,1],sea_level:0});}
  finally{if(old===undefined)delete globalThis.GPUTextureUsage;else globalThis.GPUTextureUsage=old;}
  assert.deepEqual(replayed,[event]);assert.equal(renderer.pendingEvents.length,0);
});

test('only exposed detail boundaries fade; adjacent terrain and other continents do not',()=>{
  const tile={region:0,x:20,y:30};
  assert.equal(terrainEdgeMask(tile,[tile]),15);
  assert.equal(terrainEdgeMask(tile,[tile,{region:0,x:21,y:30},{region:0,x:20,y:29}]),9);
  assert.equal(terrainEdgeMask(tile,[{region:1,x:21,y:30}]),15);
});

test('authored gamma bytes are averaged, not sRGB-decoded, and complete mips retain color',()=>{
  const rgba=new Uint8Array([0,40,200,255,100,60,100,255,200,80,0,255,100,20,100,255]);
  assert.deepEqual([...resizeRgba(2,2,rgba,1)],[100,50,100,255]);
  const mips=terrainMips({width:2,height:2,rgba});
  assert.deepEqual(mips.map(m=>m.length),[262144,65536,16384,4096,1024,256,64,16,4]);
  assert.deepEqual([...mips.at(-1)],[100,50,100,255]);
  assert.throws(()=>resizeRgba(2,2,new Uint8Array(3),1),/Invalid/);
});

test('real minimap naming preserves source x/y and rejects path injection',()=>{
  const bytes=new TextEncoder().encode('dir: Azeroth\r\nAzeroth\\map32_48.blp\tea283abc0bf9637c3fad5e840a65b38b.blp\r\n');
  assert.equal(minimapCatalog(bytes).get('azeroth\\map32_48.blp'),'textures\\Minimap\\ea283abc0bf9637c3fad5e840a65b38b.blp');
  assert.throws(()=>minimapCatalog(new TextEncoder().encode('Azeroth\\map1_2.blp\t..\\bad.blp')),/Invalid/);
});

function fixture(paths=['a.blp']) {
  let freed=false;
  return {paths:()=>JSON.stringify(paths),vertices:()=>new Float32Array(13*3),indices:()=>new Uint32Array([0,1,2]),
    masks:()=>new Uint8Array(16384),free(){freed=true;},get freed(){return freed;}};
}
class Texture {
  metadata(){return '{"width":1,"height":1}';}rgba(){return new Uint8Array([11,23,57,255]);}free(){}
}
test('one read per pump, shared cache, transferable copies, eviction and reload are bounded',async()=>{
  let reads=0;
  const messages=[],stream=new TerrainStream({read:async()=>{reads++;return new Uint8Array(1);}},
    {SceneTexture:Texture},(message,transfers)=>messages.push(structuredClone(message,{transfer:transfers})));
  const material=fixture(['a.blp','b.blp']);stream.setTile(1,material);
  assert(material.freed);
  await stream.pump();assert.equal(messages.length,0);assert.equal(reads,1);
  await stream.pump();assert.equal(messages.length,1);
  assert.deepEqual([...messages[0].layers[0].mips.at(-1)],[11,23,57,255]);
  stream.removeTile(1);stream.setTile(1,fixture(['a.blp','b.blp']));
  await stream.pump();await stream.pump();
  assert.equal(reads,2);assert.equal(messages.length,2);
  for(let i=0;i<TERRAIN_CACHE_LIMIT+3;i++){
    stream.removeTile(1);stream.setTile(1,fixture([`unique${i}.blp`]));await stream.pump();
  }
  assert.equal(stream.snapshot().cache,TERRAIN_CACHE_LIMIT);
  assert(stream.snapshot().bytes<=TERRAIN_CACHE_LIMIT*349524);
  stream.clear();assert.equal(stream.snapshot().bytes,0);
});
test('late reads cannot resurrect evicted tiles and errors stay explicit',async()=>{
  let resolve;
  const messages=[],stream=new TerrainStream({read:()=>new Promise(r=>resolve=r)},{SceneTexture:Texture},
    message=>messages.push(message));
  stream.setTile(2,fixture());const pending=stream.pump();
  stream.removeTile(2);resolve(new Uint8Array(1));await pending;
  assert.equal(messages.length,0);
  stream.source={read:async()=>{throw Error('missing local BLP');}};
  stream.setTile(3,fixture(['missing.blp']));await stream.pump();
  assert.match(stream.snapshot().errors[0],/missing.blp: missing local BLP/);
  assert.equal(messages.length,0);
});
