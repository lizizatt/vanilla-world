import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {transformedBounds,globalCollisionVertices,SCENE_LIMITS,placementMatrix,boundsDistance} from './scene-stream.js';

// Exercise the actual worker queue with synthetic archive/Wasm boundaries, without starting WebGPU.
const worker=(await readFile(new URL('./world-worker.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?$/gm,'');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function boot(events=[],clock=performance) {
  const context=createContext({init:async()=>({memory:{buffer:new ArrayBuffer(0)}}),performance:clock,postMessage:message=>events.push(message),
    transformedBounds,globalCollisionVertices,SCENE_LIMITS,boundsDistance});
  runInContext(worker,context);
  return context;
}
function fixture(xs=[0,1,20,21]) {
  const reads=[],added=[],pending=new Map(),required=[0];
  const context=boot();
  context.dependencies={
    world:{required_tiles:()=>required,add_tile:i=>added.push(i),remove_tile(){},
      geometry:()=>new Float32Array(),horizon_seams:()=>new Float32Array(),terrain_material:()=>({})},
    source:{read:path=>{
      const index=Number(path.match(/tile(\d+)\.adt$/)[1]);
      reads.push(index);
      return new Promise((resolve,reject)=>pending.set(index,{resolve,reject}));
    }},
    manifest:{regions:[{map:'test'}],tiles:xs.map((x,i)=>({region:0,x,y:0,file:`tile${i}.adt`}))},
    placements:xs.map(x=>[x*1600/3,0]),
    scene:{setTile(){},removeTile(){}},terrain:{setTile(){},removeTile(){}},
  };
  runInContext(`({world,source,manifest,placements,scene,terrain}=dependencies);
    resident=new Set([0]);
    globalThis.streamTerrain=stream;
    globalThis.state=()=>({resident:[...resident],failures:[...failures.values()]});`,context);
  return {reads,added,required,pending,stream:context.streamTerrain,
    state:()=>JSON.parse(JSON.stringify(context.state()))};
}

test('slow optional ADT read does not block frames, duplicate reads, or admit terrain asynchronously',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  await f.stream([0,0],true);
  assert.deepEqual(f.reads,[1]);
  assert.deepEqual(f.state().resident,[0]);
  f.pending.get(1).resolve(new Uint8Array([1]));
  await settle();
  assert.deepEqual(f.added,[],'Read completion alone must not change physics or scene metadata');
  await f.stream([0,0],true);
  assert.deepEqual(f.reads,[1]);
  assert.deepEqual(f.added,[1]);
  assert.deepEqual(f.state().resident,[0,1]);
});

test('prefetched ADT becoming required waits for the same read and keeps current support pinned',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  f.required.push(1);
  let done=false;
  const frame=f.stream([0,0],true).then(()=>{done=true;});
  await settle();
  assert.equal(done,false);
  assert.deepEqual(f.reads,[1]);
  assert.deepEqual(f.state().resident,[0]);
  f.pending.get(1).resolve(new Uint8Array([1]));
  await frame;
  assert.deepEqual(f.state().resident,[0,1]);
  assert.deepEqual(f.added,[1]);
});

test('stale optional ADT completion cannot resurrect terrain after flight changes demand',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  await f.stream([20*1600/3,0],false);
  assert.deepEqual(f.reads,[1],'Only one optional raw ADT may be in flight');
  f.pending.get(1).resolve(new Uint8Array([1]));
  await settle();
  await f.stream([20*1600/3,0],false);
  assert.deepEqual(f.reads,[1,2]);
  assert.deepEqual(f.added,[]);
  assert.deepEqual(f.state().resident,[]);
});

test('completed optional ADT is admitted even when a different wanted tile becomes closer',async()=>{
  const f=fixture([0,1,2,3]);
  await f.stream([0,0],true);
  f.pending.get(1).resolve(new Uint8Array([1]));
  await settle();
  await f.stream([1100,0],true);
  assert.deepEqual(f.added,[1]);
  assert.deepEqual(f.state().resident,[0,1]);
  await f.stream([1100,0],true);
  assert.deepEqual(f.reads,[1,2]);
});

test('failed prefetched terrain stays unavailable and exposes its error rather than empty ocean',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  f.pending.get(1).reject(Object.assign(new Error('missing authored tile'),{code:'NOT_FOUND'}));
  await settle();
  f.required.push(1);
  await f.stream([0,0],true);
  assert.deepEqual(f.added,[]);
  assert.deepEqual(f.state().resident,[0]);
  assert.match(f.state().failures[0],/tile1\.adt: NOT_FOUND missing authored tile/);
  await f.stream([0,0],true);
  assert.deepEqual(f.reads,[1],'Failed expected terrain requires explicit retry');
});

function collisionFixture(clock=performance) {
  const events=[],context=boot(events,clock),body=Array(15).fill(0),built=[],updates=[],parts=new Map();
  const state={instances:[],collisionInstances:[],unresolvedCollision:[],assets:new Map(),textures:new Map()};
  const f={body,built,updates,events,state,context,sweep:0,failNext:false,spawn:[0,0,0,0]};
  const scene={revision:0,selectionRevision:0,update(){this.selectionRevision=this.revision;},
    async pump(){},snapshot:()=>state,retry(){
      this.revision++;
      state.unresolvedCollision=state.unresolvedCollision.map(i=>({...i,status:'PENDING'}));
    }};
  context.dependencies={
    world:{telemetry:()=>body,frame_sweep_distance:()=>f.sweep,set_scene_parts:(ids,counts,vertices)=>{
      updates.push({ids:[...ids],counts:[...counts],supplied:vertices.length});
      if(f.failNext){f.failNext=false;throw new Error('Rejected synthetic collision payload');}
      let offset=0;
      ids.forEach((id,i)=>{
        if(counts[i]){const end=offset+counts[i]*9;parts.set(id,[...vertices.slice(offset,end)]);offset=end;}
        else assert(parts.has(id),'Reuse requires an existing cached tree');
      });
      const wanted=new Set(ids);
      for(const id of parts.keys())if(!wanted.has(id))parts.delete(id);
      built.push([...ids].flatMap(id=>parts.get(id)));
    },
      collision_vertices:()=>new Float64Array(),collision_nodes:()=>new Float64Array(),
      required_tiles:()=>[],collision_stats:()=>[0,0,0],
      restore:pose=>body.splice(0,4,...pose),initialize_spawn:()=>body.splice(0,4,...f.spawn)},
    manifest:{spawn:f.spawn,ocean:[10000,0,20000,0],regions:[{placement:[0,0],tile_origin:[32,32]}]},scene,
  };
  runInContext(`({world,manifest,scene}=dependencies);
    horizon={wasmPeakBytes:0};source={stats:{}};
    terrain={snapshot:()=>({errors:[]}),retry:async()=>{}};
    stream=async()=>{};
    globalThis.request=handle;
    globalThis.updateCollision=()=>updateScene(Array.from(world.telemetry().slice(0,3)));
    globalThis.refreshUnknown=()=>updateCameraUnknown(world.telemetry(),0);
    globalThis.unknown=()=>cameraUnknown.map(i=>i.id);
    globalThis.waiting=()=>objectWait.map(i=>i.id);`,context);
  f.update=context.updateCollision;
  f.request=context.request;
  f.refreshUnknown=context.refreshUnknown;
  f.unknown=()=>Array.from(context.unknown());
  f.waiting=()=>Array.from(context.waiting());
  f.add=x=>{
    const id=String(x),matrix=placementMatrix({position:[0,-x,0],rotation:[0,180,0],scale:1});
    const bounds=[[-1,-x-1,0],[1,-x+1,0]];
    const instance={id,key:id,matrix,bounds,boundsKnown:true,kind:'m2'};
    state.collisionInstances.push(instance);
    state.instances.push(instance);
    state.assets.set(id,{vertices:new Float32Array(),indices:new Uint32Array(),batches:[],
      collisionVertices:new Float32Array([-1,-1,0,1,-1,0,0,1,0]),collisionIndices:new Uint32Array([0,1,2])});
    scene.revision++;
    return instance;
  };
  f.move=(id,x)=>{
    const previous=state.collisionInstances.find(i=>i.id===String(id));
    const matrix=previous.matrix.slice();matrix[13]=-x;
    const next={...previous,matrix};
    state.collisionInstances=state.collisionInstances.map(i=>i===previous?next:i);
    state.instances=state.instances.map(i=>i===previous?next:i);
    scene.revision++;
  };
  f.unresolved=x=>{
    state.unresolvedCollision.push({id:String(x),kind:'m2',boundsKnown:true,
      bounds:[[-1,-x-1,0],[1,-x+1,0]]});
    scene.revision++;
  };
  return f;
}

test('stable collision anchor avoids edge rebuilds while retaining camera and hull coverage',async()=>{
  const f=collisionFixture();
  f.add(100);f.add(125);
  await f.update();
  assert.equal(f.built.length,1);
  assert.equal(f.built[0].length,9);
  f.body[0]=10;await f.update();
  assert.equal(f.built.length,1);
  f.body[0]=33;await f.update();
  assert.equal(f.built.length,2);
  assert.equal(f.built[1].length,18);
});

test('newly decoded colliders bypass anchor cadence immediately',async()=>{
  const f=collisionFixture();
  f.add(100);await f.update();
  f.add(10);await f.update();
  assert.equal(f.built.length,2);
  assert.equal(f.built[1].length,18);
  assert.equal(f.updates[1].supplied,9,'Only the new instance crosses the Wasm boundary');
  assert.deepEqual(f.updates[1].counts.toSorted(),[0,1]);
});

test('unchanged submissions skip asset traversal but readiness follows every body and sweep update',async()=>{
  const f=collisionFixture();
  f.add(100);f.unresolved(10);
  await f.update();
  let lookups=0;
  const get=f.state.assets.get.bind(f.state.assets);
  f.state.assets.get=key=>{lookups++;return get(key);};
  assert.deepEqual(f.waiting(),[]);
  f.body[0]=6;await f.update();
  assert.deepEqual(f.waiting(),['10']);
  f.body[0]=0;f.sweep=10;await f.update();
  assert.deepEqual(f.waiting(),['10']);
  f.sweep=0;await f.update();
  assert.deepEqual(f.waiting(),[]);
  assert.equal(lookups,0);
  assert.equal(f.built.length,1);
});

test('failed cached-part upload never marks new tokens reusable',async()=>{
  const f=collisionFixture();
  f.add(100);f.failNext=true;
  await assert.rejects(f.update(),/Rejected synthetic/);
  assert.equal(f.built.length,0);
  await f.update();
  assert.deepEqual(f.updates.map(u=>u.counts),[[1],[1]]);
  assert.deepEqual(f.updates.map(u=>u.supplied),[9,9]);
});

test('failed anchor-only submission remains dirty until the cached-part upload succeeds',async()=>{
  const f=collisionFixture();
  f.add(132);await f.update();
  f.sweep=50;f.failNext=true;
  await assert.rejects(f.update(),/Rejected synthetic/);
  await f.update();
  assert.equal(f.built.length,2);
  assert.deepEqual(f.updates.map(u=>u.supplied),[0,9,9]);
});

test('failed scene transfer retries its full assets and textures without treating them as uploaded',async()=>{
  const f=collisionFixture(),push=f.events.push.bind(f.events);
  let reject=true;
  f.events.push=message=>{
    if(message.event==='scene' && reject){reject=false;throw new Error('Rejected synthetic scene transfer');}
    return push(message);
  };
  f.add(100);
  f.state.textures.set('leaf.blp',{width:1,height:1,rgba:new Uint8Array(4)});
  await assert.rejects(f.update(),/Rejected synthetic scene transfer/);
  await f.update();
  const scene=f.events.find(e=>e.event==='scene');
  assert.deepEqual(Array.from(scene.assets,a=>a.key),['100']);
  assert.deepEqual(Array.from(scene.textures,t=>t.key),['leaf.blp']);
  assert.equal(f.built.length,1);
});

test('changed transforms replace cached collision and visual instances with the same scene ID',async()=>{
  const f=collisionFixture();
  f.add(100);await f.update();
  f.move(100,110);await f.update();
  assert.notDeepEqual(f.updates[0].ids,f.updates[1].ids);
  assert.deepEqual(f.updates[1].counts,[1]);
  assert.equal(f.events.filter(e=>e.event==='scene').length,2);
  await f.update();
  assert.equal(f.built.length,2);
  assert.equal(f.events.filter(e=>e.event==='scene').length,2);
});

test('fast post-step camera remains covered at the edge of the retained anchor',async()=>{
  const f=collisionFixture();
  f.add(132);await f.update();
  assert.equal(f.built[0].length,0);
  f.sweep=50;await f.update();
  assert.equal(f.built[1].length,9);
  f.body[0]=32;await f.update();
  assert.equal(f.built.length,2,'Anchor still covers 32yd drift + 50yd step + 50yd camera');
});

test('camera unknown bounds refresh around post-physics rather than stale pre-step position',async()=>{
  const f=collisionFixture();
  f.unresolved(100);await f.update();
  f.refreshUnknown();
  assert.deepEqual(f.unknown(),[]);
  f.body[0]=50;f.refreshUnknown();
  assert.deepEqual(f.unknown(),['100']);
});

test('restore, reset and retry return camera unknown bounds matching the immediately returned pose',async()=>{
  const f=collisionFixture();
  f.unresolved(100);await f.update();f.refreshUnknown();
  assert.deepEqual(f.unknown(),[]);
  const restored=await f.request({action:'restore',pose:[50,0,0,0]});
  assert.equal(restored.telemetry[0],50);
  assert.deepEqual(Array.from(restored.scene.unresolvedCollision,i=>i.id),['100']);
  const reset=await f.request({action:'reset'});
  assert.equal(reset.telemetry[0],0);
  assert.deepEqual(Array.from(reset.scene.unresolvedCollision),[]);
  f.body[0]=50;
  f.state.unresolvedCollision[0].status='NOT_FOUND';
  const retried=await f.request({action:'retry'});
  assert.equal(retried.telemetry[0],50);
  assert.deepEqual(Array.from(retried.scene.unresolvedCollision,i=>[i.id,i.status]),[['100','PENDING']]);
});

test('frame timing separates post-tick camera scanning from physics queries',async()=>{
  let now=1000;
  const f=collisionFixture({now:()=>now});
  f.unresolved(50);
  f.context.boundsDistance=(...args)=>{now+=5;return boundsDistance(...args);};
  f.context.dependencies.world.tick=()=>{now+=2;};
  runInContext(`prepareDistant=()=>{};startDistantRead=()=>{};startCraft=()=>{};
    terrain.pump=async()=>{};`,f.context);
  const result=await f.request({action:'frame',dt:1/120,throttle:0,steer:0,flags:0});
  assert.equal(result.timings.physicsMs,2);
  assert.equal(result.timings.cameraUnknownMs,5);
  assert.equal(result.timings.sceneMs,5);
});
