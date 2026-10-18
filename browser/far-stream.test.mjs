import test from 'node:test';
import assert from 'node:assert/strict';
import {FarStream,FAR_LIMITS} from './far-stream.js';
import {FarChannel} from './far-channel.js';
import {WorldRenderer} from './world-renderer.js';

const manifest={regions:[0,1].map(()=>({placement:[0,0],tile_origin:[32,32],map:'Map'})),
  tiles:Array.from({length:36},(_,i)=>({region:0,x:32+i%6,y:32+Math.floor(i/6),file:`Map_${i}.adt`}))};
const focus={epoch:1,region:0,position:[0,0,0],enabled:true};
const placements=[{id:1,kind:'m2',path:'tree.m2',position:[1200,0,0],rotation:[0,180,0],scale:1}];
function fixture(read=async()=>new Uint8Array([1]),entries=placements) {
  const messages=[];
  const wasm={scene_placements:()=>JSON.stringify(entries),SceneModel:{m2:()=>({
    metadata:()=>JSON.stringify({bounds:[[-1,-1,0],[1,1,3]],batches:[]}),
    vertices:()=>new Float32Array(36),indices:()=>new Uint32Array([0,1,2]),
    collision_vertices:()=>{throw Error('Visual worker must not export collision');},
    collision_indices:()=>{throw Error('Visual worker must not export collision');},free(){},
  })}};
  const stream=new FarStream({read},wasm,manifest,(message,transfers)=>messages.push({message,transfers}),()=>65536);
  stream.focus(focus);
  return {stream,messages};
}
test('far residency, decoding and transfers are bounded and cannot supply nearby collision',async()=>{
  const {stream,messages}=fixture();
  for(let i=0;i<30;i++)await stream.step();
  assert.equal(stream.resident.size,24);assert.equal(stream.loads,24);
  assert.equal(stream.scene.tiles.size,0);assert.equal(stream.scene.collisionCandidates.length,0);
  assert.deepEqual(stream.scene.snapshot().unresolvedCollision,[]);
  assert.equal(messages.length,1,'No second transfer until the renderer consumed the first');
  assert(stream.scene.bytes<=FAR_LIMITS.bytes);
  assert.equal(stream.scene.cache.values().next().value.value.collisionVertices.length,0);
  stream.ack(999);stream.publish();assert.equal(messages.length,1);
  stream.ack(messages[0].message.token);stream.publish();
  assert.equal(messages.length,2);assert.equal(messages[1].message.assets.length,0);
  assert.equal(messages[1].message.instances.length,0,'Unchanged transforms stay in the renderer');
  assert.deepEqual(messages[1].message.instanceOrder,['1:m2:1']);
  assert.equal(messages[1].message.stats.wasmPeakBytes,65536);
  stream.ack(messages[1].message.token);stream.publish();
  assert.equal(messages.length,2,'An idle child must not send repeated empty visual updates');
});
test('map cancellation discards an encoded tile before parsing and keeps no stale failure',async()=>{
  let finish;
  const {stream}=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const step=stream.step();
  stream.focus({...focus,epoch:2,region:1});finish(new Uint8Array([1]));await step;
  assert.equal(stream.resident.size,0);assert.equal(stream.scene.distantTiles.size,0);
  assert.equal(stream.failures.size,0);
});
test('ordinary focus and mode changes retain metadata; a new epoch resends rejected visual deltas',async()=>{
  const {stream,messages}=fixture();
  await stream.step();stream.ack(messages[0].message.token);
  const parsed=stream.scene.distantTiles.values().next().value;
  stream.focus({...focus,position:[1,0,1]});
  assert.equal(stream.scene.distantTiles.values().next().value,parsed);
  stream.focus({...focus,epoch:2,enabled:false});await stream.step();
  assert.equal(stream.loads,1);assert.equal(stream.scene.distantTiles.values().next().value,parsed);
  stream.focus({...focus,epoch:3});await stream.step();
  assert(messages.at(-1).message.reset);assert.equal(messages.at(-1).message.assets.length,1);
});
test('far corruption is explicit while DEFERRED reads remain retryable',async()=>{
  for(const code of ['CORRUPT','DEFERRED']){
    const {stream}=fixture(async()=>{throw Object.assign(Error('source test'),{code});});
    await stream.step();
    assert.equal(stream.failures.size,code==='CORRUPT'?1:0);
    stream.retry();assert.equal(stream.failures.size,0);
  }
});
test('a repeated decoded small model cannot starve discovery of larger authored far models',()=>{
  const {stream}=fixture(),scene=stream.scene;
  const fence={...placements[0],path:'fence.m2',position:[1000,0,0]};
  const entries=Array.from({length:300},(_,id)=>({...fence,id}));
  entries.push({...placements[0],id:400,path:'unknown-tree.m2',position:[2000,0,0]});
  scene.setDistantTile('1:32:32',new Uint8Array());
  scene.setDistantPlacements('1:32:32',scene.parsePlacements(null,JSON.stringify(entries)));
  scene.cache.set('m2:fence.m2:[]',{used:0,value:{bounds:[[-10,-1,0],[10,1,2]]}});
  scene.update(1,[0,0,0]);
  assert(scene.instances.some(i=>i.path==='unknown-tree.m2'));
  assert(scene.requests.has('m2:unknown-tree.m2:[]'));
  assert.equal(scene.collisionCandidates.length,0);
});
function channelFixture(read=async()=>new Uint8Array([1]),urgent=()=>false) {
  const sent=[],forwarded=[];
  const worker={postMessage:(data,transfers)=>sent.push({data,transfers}),terminate(){this.closed=true;}};
  const channel=new FarChannel(()=>worker,{read},manifest,(data,transfers)=>forwarded.push({data,transfers}),urgent);
  channel.focus(0,[0,0,0],true);
  return {channel,worker,sent,forwarded};
}
test('focus messages coalesce and stale results release the producer without reaching the renderer',async()=>{
  const {channel,sent,forwarded}=channelFixture();
  for(let x=1;x<100;x++)channel.focus(0,[x,0,0],true);
  assert.equal(sent.length,2);
  await channel.receive({event:'far-focus-ack'});
  assert.deepEqual(sent.at(-1).data.position,[99,0,0]);
  channel.focus(1,[0,0,0],true);
  await channel.receive({event:'far-scene',epoch:1,token:4});
  assert.equal(forwarded.length,0);assert.deepEqual(sent.at(-1).data,{action:'ack',token:4});
});
test('urgent nearby work preempts the single optional read, including after extraction',async()=>{
  let urgent=false,finish,options;
  const {channel,sent}=channelFixture((path,o)=>{options=o;return new Promise(resolve=>{finish=resolve;});},()=>urgent);
  const reading=channel.receive({event:'far-read',epoch:1,id:3,path:'tree.m2'});
  assert(options.background);assert.equal(options.shouldDefer(),false);
  urgent=true;assert.equal(options.shouldDefer(),true);
  finish(new Uint8Array([1]));await reading;
  assert.equal(sent.at(-1).data.code,'DEFERRED');assert.equal(sent.at(-1).data.bytes,undefined);
  await channel.receive({event:'far-read',epoch:1,id:4,path:'tree.m2'});
  assert.equal(sent.at(-1).data.code,'DEFERRED');
});
test('source replacement drops pending reads and transfer ownership waits for explicit consumer ack',async()=>{
  let finish;
  const {channel,sent,forwarded}=channelFixture(()=>new Promise(resolve=>{finish=resolve;}));
  const payload={event:'far-scene',epoch:1,token:2,stats:{},assets:[],textures:[]};
  await channel.receive(payload);assert.equal(forwarded.length,1);
  assert(!sent.some(s=>s.data.action==='ack'));
  channel.ack(2,channel.producer);assert.equal(sent.at(-1).data.action,'ack');
  const reading=channel.receive({event:'far-read',epoch:1,id:3,path:'tree.m2'});
  channel.close();const count=sent.length;finish(new Uint8Array([1]));await reading;
  assert.equal(sent.length,count);
});
test('render ownership favors near IDs and prevents far eviction or cross-map placement',()=>{
  const renderer=Object.create(WorldRenderer.prototype),near={id:'shared',key:'near'};
  Object.assign(renderer,{manifest:{},sceneRegion:0,instances:[near],nearInstances:[near],
    assets:new Map([['near',{}],['far:model',{}]]),textures:new Map(),items:new Map()});
  const delta={event:'far-scene',region:0,removedAssets:[],removedTextures:[],assets:[],textures:[],
    instances:[{id:'shared',key:'far:model'},{id:'distant',key:'far:model'}]};
  renderer.event(delta);assert.equal(renderer.instances[0],near);
  assert.deepEqual(renderer.instances.map(i=>i.id),['shared','distant']);
  assert.throws(()=>renderer.event({...delta,removedAssets:['near']}),/ownership/);
  assert(renderer.assets.has('near'));
  renderer.event({...delta,region:1});
  assert.deepEqual(renderer.instances,[near],'A delayed other-map visual cannot use the near map transform');
});
test('worker construction and all optional posts fail without escaping into near work',()=>{
  for(const phase of ['construct','init','near','focus','ack']) {
    let calls=0,closed=false;
    const worker={postMessage(){if(++calls===1&&phase==='init'||calls>1&&phase!=='init')throw Error(`failed ${phase}`);},
      terminate(){closed=true;}};
    const channel=new FarChannel(()=>{if(phase==='construct')throw Error('failed construct');return worker;},
      {},manifest,()=>{},()=>false);
    assert.doesNotThrow(()=>{
      if(phase==='near')channel.near(['id']);
      if(phase==='focus')channel.focus(0,[0,0,0],true);
      if(phase==='ack'){channel.uploadToken=1;channel.ack(1,channel.producer);}
    });
    assert.equal(channel.active,false);assert.match(channel.snapshot().failures[0],/failed/);
    assert.equal(closed,phase!=='construct');
  }
});
test('consumer rejection is producer-scoped and retries resend complete resources and transforms',async()=>{
  const {stream,messages}=fixture();
  await stream.step();stream.ack(messages[0].message.token);stream.retry();stream.publish();
  assert(messages.at(-1).message.reset);
  assert.equal(messages.at(-1).message.assets.length,1);assert.equal(messages.at(-1).message.instances.length,1);
  const old=channelFixture(),next=channelFixture();
  next.channel.uploadToken=1;
  next.channel.ack(1,old.channel.producer);assert.equal(next.channel.uploadToken,1);
  next.channel.reject(1,old.channel.producer);assert(next.channel.active);
  next.channel.reject(1,next.channel.producer);assert.equal(next.channel.active,false);
  assert.match(next.channel.snapshot().failures[0],/render upload failed/);
});
test('inspected bounds survive mesh eviction so a stationary over-capacity scene settles',async()=>{
  const entries=Array.from({length:100},(_,id)=>({...placements[0],id,path:`tree${id}.m2`,position:[1000+id,0,0]}));
  const {stream,messages}=fixture(undefined,entries);
  for(let i=0;i<220;i++){await stream.step();stream.ack(messages.at(-1).message.token);}
  const decodes=stream.scene.timings.loads;
  for(let i=0;i<200;i++){await stream.step();stream.ack(messages.at(-1).message.token);}
  assert.equal(stream.scene.timings.loads,decodes,'No rediscovery loop at a stationary focus');
  assert.equal(stream.scene.resourceCount('m2'),96);
  assert.equal(stream.scene.discovered.size,100);
  stream.focus({...focus,epoch:2,region:1});await stream.step();
  assert.equal(stream.scene.discovered.size,0);
});
test('near visual ownership is coalesced and never becomes a far collision demand',async()=>{
  const {stream}=fixture();await stream.step();
  stream.near(['1:m2:1']);stream.select();
  assert.equal(stream.scene.instances.length,0);assert.equal(stream.scene.collisionCandidates.length,0);
  stream.near([]);stream.select();assert.equal(stream.scene.instances.length,1);
  const {channel,sent}=channelFixture();
  for(let i=0;i<100;i++)channel.near([String(i)]);
  assert.equal(sent.filter(s=>s.data.action==='near').length,1);
  await channel.receive({event:'far-near-ack'});
  assert.deepEqual(sent.at(-1).data.ids,['99']);
});
test('failed far GPU installation releases partial buffers and retains near resources',()=>{
  const renderer=Object.create(WorldRenderer.prototype),near={id:'near',key:'near'},resource={destroyed:0,destroy(){this.destroyed++;}};
  Object.assign(renderer,{manifest:{},sceneRegion:0,instances:[near],nearInstances:[near],
    assets:new Map([['near',{}]]),textures:new Map(),items:new Map(),prepareBatches:()=>[],
    buffer:(data,usage)=>{if(usage===2)throw Error('index upload failed');return resource;}});
  const old=globalThis.GPUBufferUsage;globalThis.GPUBufferUsage={VERTEX:1,INDEX:2};
  try {
    assert.throws(()=>renderer.event({event:'far-scene',region:0,reset:true,instances:[],
      removedAssets:[],removedTextures:[],textures:[],
      assets:[{key:'far:model',batches:[],vertices:new Float32Array(3),indices:new Uint32Array([0])}]}),/index upload failed/);
    renderer.clearFar();
    assert.equal(resource.destroyed,1);assert(renderer.assets.has('near'));
    assert.deepEqual(renderer.instances,[near]);
  } finally {if(old===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=old;}
});
