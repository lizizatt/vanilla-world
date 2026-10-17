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

test('scene and craft batches validate paths and prepare invariant draw state once',()=>{
  const renderer=Object.create(WorldRenderer.prototype),pipelines=[];
  renderer.scenePipeline=batch=>{const pipeline={blend:batch.blend};pipelines.push(pipeline);return pipeline;};
  const input=[{texture:'Textures/Test.BLP',blend:'opaque',indexCount:3},
    {texture:null,blend:'alpha',indexCount:6},{texture:'leaf.blp',blend:'cutout',indexCount:9}];
  const prepared=renderer.prepareBatches(input);
  assert.deepEqual(prepared.map(b=>b.texture),['textures\\test.blp',null,'leaf.blp']);
  assert.deepEqual(prepared.map(b=>b.transparent),[false,true,false]);
  assert.deepEqual(prepared.map(b=>b.indexCount),[3,6,9]);
  assert.equal(prepared[0].pipeline,pipelines[0]);
  assert.equal(input[0].texture,'Textures/Test.BLP');
  assert.throws(()=>renderer.prepareBatches([{texture:'..\\outside.blp'}]));
  assert.equal(pipelines.length,3);
});

test('terrain bundles preserve draws and refresh on residency, order and material changes',()=>{
  const renderer=Object.create(WorldRenderer.prototype),executed=[];
  Object.assign(renderer,{format:'bgra8unorm',pipeline:'terrain',splatPipeline:'splat',
    indices:new Map([[0,'horizon-indices']]),terrainBundleBuilds:0});
  renderer.device={createRenderBundleEncoder:descriptor=>{
    assert.deepEqual(descriptor,{colorFormats:['bgra8unorm'],depthStencilFormat:'depth24plus'});
    const calls=[],encoder={finish:()=>calls};
    for(const name of ['setPipeline','setBindGroup','setVertexBuffer','setIndexBuffer','draw','drawIndexed'])
      encoder[name]=(...args)=>calls.push([name,...args]);
    return encoder;
  }};
  const pass={executeBundles:bundles=>executed.push(bundles[0])};
  const horizon={region:0,group:'far',buffer:'far-vertices',offset:0};
  const detail={group:'near',buffer:'near-vertices',offset:256,count:6};
  renderer.drawTerrain(pass,[horizon,detail]);
  assert.deepEqual(executed[0],[
    ['setPipeline','terrain'],['setBindGroup',0,'far',[0]],['setVertexBuffer',0,'far-vertices'],
    ['setIndexBuffer','horizon-indices','uint32'],['drawIndexed',3072],
    ['setBindGroup',0,'near',[256]],['setVertexBuffer',0,'near-vertices'],['draw',6],['setPipeline','splat'],
  ]);
  renderer.drawTerrain(pass,[horizon,detail]);
  assert.equal(executed[1],executed[0]);assert.equal(renderer.terrainBundleBuilds,1);
  detail.material={group:'layers',vertices:'layer-vertices',indices:'layer-indices',count:12};
  renderer.drawTerrain(pass,[horizon,detail]);
  assert.deepEqual(executed[2].slice(-4),[
    ['setBindGroup',0,'layers',[256]],['setVertexBuffer',0,'layer-vertices'],
    ['setIndexBuffer','layer-indices','uint32'],['drawIndexed',12],
  ]);
  detail.offset=0;horizon.offset=256;
  renderer.drawTerrain(pass,[detail,horizon]);
  assert.equal(renderer.terrainBundleBuilds,3);
  assert.deepEqual(executed[3][1],['setBindGroup',0,'near',[0]]);
  renderer.drawTerrain(pass,[detail]);
  assert.equal(renderer.terrainBundleBuilds,4);
  assert(!executed[4].some(call=>call[0]==='drawIndexed'&&call[1]===3072));
});

test('opaque bundles track live resources and offsets without freezing transparent order',()=>{
  const renderer=Object.create(WorldRenderer.prototype);
  const encoder=()=>{
    const calls=[],value={calls,finish:()=>calls,executeBundles:bundles=>calls.push(...bundles.flat())};
    for(const name of ['setPipeline','setBindGroup','setVertexBuffer','setIndexBuffer','drawIndexed'])
      value[name]=(...args)=>calls.push([name,...args]);
    return value;
  };
  Object.assign(renderer,{format:'bgra8unorm',sceneBundleBuilds:0,device:{createRenderBundleEncoder:encoder}});
  const draw=(id,transparent=false)=>({asset:{vertices:`v${id}`,indices:`i${id}`},
    batch:{transparent,indexCount:3,firstIndex:id},item:{group:`g${id}`,offset:id*256},pipeline:`p${id}`});
  const a=draw(0),b=draw(1),near=draw(2,true),far=draw(3,true);
  const render=draws=>{const pass=encoder();renderer.drawScene(pass,draws);return pass.calls.filter(c=>c[0]==='drawIndexed').map(c=>c[3]);};
  assert.deepEqual(render([a,b,far,near]),[0,1,3,2]);
  assert.deepEqual(render([{...a},{...b},near,far]),[0,1,2,3]);
  assert.equal(renderer.sceneBundleBuilds,1);
  a.item.offset=1024;render([a,b,near,far]);
  assert.equal(renderer.sceneBundleBuilds,2);
  a.asset={vertices:'replacement',indices:'replacement-indices'};render([a,b,near,far]);
  assert.equal(renderer.sceneBundleBuilds,3);
  a.item={group:'new-texture',offset:1024};render([a,b,near,far]);
  assert.equal(renderer.sceneBundleBuilds,4);
  assert.deepEqual(render([b,a,near,far]),[1,0,2,3]);
  assert.equal(renderer.sceneBundleBuilds,5);
  assert.deepEqual(render([near,far]),[2,3]);
  assert.equal(renderer.sceneBundleBuilds,6);
  assert.deepEqual(render([]),[]);
  assert.equal(renderer.sceneBundleBuilds,6);
});

test('resource-only scene updates preserve instance caches, replace resources and require full region transitions',()=>{
  const renderer=Object.create(WorldRenderer.prototype);
  const resource=()=>({destroyed:0,destroy(){this.destroyed++;}});
  const vertices=resource(),indices=resource(),skin=resource(),instance={id:'actor',key:'model',rendered:{matrix:[]},drawItems:[]};
  Object.assign(renderer,{manifest:{},sceneRegion:0,instances:[instance],
    assets:new Map([['model',{vertices,indices}]]),textures:new Map([['skin',skin]]),
    items:new Map([['batch',{id:'actor',key:'model'}]]),
    buffer:resource,texture:resource,prepareBatches:batches=>batches});
  const delta={event:'scene',region:0,removedAssets:[],removedTextures:[],assets:[],textures:[]};
  const list=renderer.instances,cached=instance.rendered;
  const old=globalThis.GPUBufferUsage;globalThis.GPUBufferUsage={VERTEX:1,INDEX:2};
  try{
    renderer.event({...delta,assets:[{key:'model',vertices:new Float32Array(12),indices:new Uint32Array([0]),batches:[]}],
      textures:[{key:'skin',width:1,height:1,rgba:new Uint8Array(4)}]});
    assert.equal(renderer.instances,list);assert.equal(renderer.instances[0],instance);
    assert.equal(instance.rendered,cached);assert.equal(renderer.items.size,1);
    assert.equal(vertices.destroyed,1);assert.equal(indices.destroyed,1);assert.equal(skin.destroyed,1);
    const replacement=renderer.assets.get('model');
    assert.throws(()=>renderer.event({...delta,region:1,removedAssets:['model']}),/region changed without instances/);
    assert.equal(renderer.assets.get('model'),replacement);assert.equal(replacement.vertices.destroyed,0);
    assert.throws(()=>renderer.event({...delta,instances:null}),/Invalid scene instances/);
    renderer.event({...delta,removedAssets:['model']});
    assert.equal(renderer.instances,list);assert.equal(renderer.items.size,0);
    assert.equal(replacement.vertices.destroyed,1);
    renderer.event({...delta,region:1,instances:[]});
    assert.deepEqual(renderer.instances,[]);assert.equal(renderer.sceneRegion,1);
  } finally{if(old===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=old;}
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
