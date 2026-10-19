import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {transformedBounds,globalCollisionVertices,SCENE_LIMITS,placementMatrix,boundsWithin,boundsDistance} from './scene-stream.js';
import {FAR_LIMITS} from './far-stream.js';
import {prepareDetail} from './camera-collision.js';

// Exercise the actual worker queue with synthetic archive/Wasm boundaries, without starting WebGPU.
const worker=(await readFile(new URL('./world-worker.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?$/gm,'');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function boot(events=[],clock=performance) {
  const timers=new Map();let nextTimer=0;
  const context=createContext({init:async()=>({memory:{buffer:new ArrayBuffer(0)}}),performance:clock,postMessage:message=>events.push(message),
    setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>timers.delete(id),
    transformedBounds,globalCollisionVertices,SCENE_LIMITS,FAR_LIMITS,boundsWithin,boundsDistance});
  runInContext(worker,context);
  runInContext('far={active:true,close(){},retry(){},near(){},snapshot:()=>({resident:0,failures:[]})};',context);
  context.timers=timers;
  context.fireTimer=async()=>{
    const [id,timer]=timers.entries().next().value;
    timers.delete(id);timer.callback();await runInContext('queue',context);await settle();
  };
  return context;
}

test('cached unresolved broad phase preserves exact moving hull and camera predicates',()=>{
  const context=boot();
  const candidates=Array.from({length:6400},(_,i)=>{
    const p=[(i%80)*25-1000,Math.floor(i/80)*25-1000,i%11*9-45];
    return {kind:i%31?'m2':'wmo',boundsKnown:i%7!==0,bounds:[p,p.map(v=>v+3)]};
  });

  context.candidates=candidates;
  runInContext('sceneState={unresolvedCollision:candidates};globalThis.near=nearUnresolved;',context);
  for(let i=0;i<160;i++) {
    const p=[i*2-150,i-80,i%35-15],radius=i%17+32,vertical=i%19+32;
    const shortlist=context.near(p,i<80?0:1,radius,vertical);
    const exact=x=>(x.kind==='wmo'&&!x.boundsKnown)||boundsWithin(x.bounds,p,x.boundsKnown?radius:Math.max(32,radius),vertical);
    assert.deepEqual(shortlist.filter(exact).map(x=>candidates.indexOf(x)),
      candidates.filter(exact).map(x=>candidates.indexOf(x)));
    const camera=x=>(x.kind==='wmo'&&!x.boundsKnown)||boundsWithin(x.bounds,p,84);
    assert.deepEqual(context.near(p,i<80?0:1).filter(camera).map(x=>candidates.indexOf(x)),
      candidates.filter(camera).map(x=>candidates.indexOf(x)));
  }
  assert(context.near([0,0,0],1).length<640,'The cached filter must actually reduce live work');
  runInContext('sceneState={unresolvedCollision:[]};',context);
  assert.equal(context.near([0,0,0],1).length,0);
});
test('detail preprocessing never blocks physics and coalesces at most one pending tile set',async()=>{
  const events=[],context=boot(events),jobs=[];
  context.dependencies={prepareDetail:data=>new Promise((resolve,reject)=>jobs.push({data,resolve,reject}))};
  runInContext('source=dependencies;globalThis.send=sendDetail;',context);
  const tile=index=>({index,placement:[0,0],vertices:new Float32Array()});
  context.send({event:'detail',tiles:[tile(0)],removed:[],seams:[]});
  context.send({event:'detail',tiles:[tile(1)],removed:[],seams:[]});
  context.send({event:'detail',tiles:[tile(2)],removed:[1],seams:[]});
  assert.equal(jobs.length,1);assert.equal(events.length,0);
  jobs[0].resolve(prepareDetail(jobs[0].data));await settle();
  assert.equal(jobs.length,2);assert.deepEqual(Array.from(jobs[1].data.tiles,t=>t.index),[2]);
  assert.deepEqual([...jobs[1].data.removed],[1]);
  jobs[1].resolve(prepareDetail(jobs[1].data));await settle();
  assert.deepEqual(events.map(e=>Array.from(e.tiles,t=>t.index)),[[0],[2]]);
  context.send({event:'detail',tiles:[tile(3)],removed:[],seams:[]});
  runInContext('source={};detailBusy=false;detailPending=undefined;',context);
  jobs[2].resolve(prepareDetail(jobs[2].data));await settle();
  assert.equal(events.length,2,'A replaced source cannot publish its delayed geometry');
});
function fixture(xs=[0,1,20,21]) {
  const reads=[],added=[],materials=[],pending=new Map(),required=[0];
  const events=[],context=boot(events);
  context.dependencies={
    world:{required_tiles:()=>required,add_tile:i=>added.push(i),remove_tile(){},
      geometry:()=>new Float32Array(),horizon_seams:()=>new Float32Array(),terrain_material:i=>{materials.push(i);return {};},
      tile_placements:()=> '[]'},
    source:{read:path=>{
      const index=Number(path.match(/tile(\d+)\.adt$/)[1]);
      reads.push(index);
      return new Promise((resolve,reject)=>pending.set(index,{resolve,reject}));
    }},
    manifest:{regions:[{map:'test'}],tiles:xs.map((x,i)=>({region:0,x,y:0,file:`tile${i}.adt`}))},
    placements:xs.map(x=>[x*1600/3,0]),
    scene:{setTile(){},removeTile(){}},terrain:{setTile(){},removeTile(){},async pump(){}},
  };
  runInContext(`({world,source,manifest,placements,scene,terrain}=dependencies);
    resident=new Set([0]);
    craft.ready=true;
    globalThis.streamTerrain=stream;
    globalThis.visuals=()=>startOptionalWork({});
    globalThis.state=()=>({resident:[...resident],failures:[...failures.values()]});`,context);
  return {context,events,reads,added,materials,required,pending,stream:context.streamTerrain,visuals:context.visuals,
    state:()=>JSON.parse(JSON.stringify(context.state()))};
}

test('terrain collision admission completes before separately yielded render geometry and seams',async()=>{
  const f=fixture([0,1]),work=[];
  f.context.dependencies.world.geometry=i=>{work.push(`geometry:${i}`);return new Float32Array();};
  f.context.dependencies.world.horizon_seams=i=>{work.push(`seam:${i}`);return new Float32Array();};
  runInContext('postFrameVisuals=true;',f.context);
  await f.stream([0,0],true);f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await f.stream([0,0],true);
  assert.deepEqual(f.added,[1]);assert.deepEqual(f.state().resident,[0,1]);
  assert.deepEqual(work,[],'Visual extraction cannot extend synchronous terrain admission');
  for(let i=0;i<3;i++){
    await f.context.fireTimer();assert.equal(work.length,i+1);
    assert.equal(f.events.filter(e=>e.event==='detail').length,0,'Partial seam sets cannot publish');
  }
  await f.context.fireTimer();
  assert.deepEqual(work,['geometry:1','seam:0','seam:1']);
  const detail=f.events.find(e=>e.event==='detail');
  assert.deepEqual(Array.from(detail.tiles,t=>t.index),[1]);
  assert.deepEqual(Array.from(detail.seams,t=>t.index),[0,1]);
});

test('residency changes discard incomplete geometry and publish only a coherent replacement',async()=>{
  const f=fixture([0,1]);let version=1;
  f.context.dependencies.world.geometry=()=>new Float32Array([version]);
  runInContext('postFrameVisuals=true;',f.context);
  await f.stream([0,0],true);f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await f.stream([0,0],true);await f.context.fireTimer();
  version=2;
  runInContext('resident.delete(1);queueGeometry([],[1]);resident.add(1);queueGeometry([{index:1}],[]);',f.context);
  while(f.context.timers.size)await f.context.fireTimer();
  const details=f.events.filter(e=>e.event==='detail');assert.equal(details.length,1);
  assert.deepEqual(Array.from(details[0].tiles[0].vertices),[2]);
  assert.deepEqual(Array.from(details[0].removed),[1]);
  assert.deepEqual(Array.from(details[0].seams,t=>t.index),[0,1]);
});

test('deferred geometry errors are explicit and do not enter an automatic retry loop',async()=>{
  const f=fixture([0,1]);
  f.context.dependencies.world.geometry=()=>{throw Error('Broken render geometry');};
  runInContext('postFrameVisuals=true;',f.context);
  await f.stream([0,0],true);f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await f.stream([0,0],true);await f.context.fireTimer();
  assert.match(f.events.find(e=>e.event==='world-error').error,/Broken render geometry/);
  assert.equal(f.context.timers.size,0);
  f.context.dependencies.world.geometry=()=>new Float32Array();
  runInContext('scenePumpError=undefined;flushGeometry();',f.context);
  while(f.context.timers.size)await f.context.fireTimer();
  assert.equal(f.events.filter(e=>e.event==='detail').length,1);
});

test('source replacement discards an outstanding render geometry job',async()=>{
  const f=fixture([0,1]);
  f.context.dependencies.terrain.clear=()=>{};f.context.dependencies.source.close=()=>{};
  f.context.openAssetSource=async()=>{throw Error('Source replacement stopped');};
  runInContext('postFrameVisuals=true;',f.context);
  await f.stream([0,0],true);f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await f.stream([0,0],true);
  await assert.rejects(runInContext("handle({action:'open',postFrameVisuals:true})",f.context),/Source replacement stopped/);
  while(f.context.timers.size)await f.context.fireTimer();
  assert.equal(f.events.filter(e=>e.event==='detail').length,0);
});

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

test('terrain materials follow the physics reply and evicted pending work never returns',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await f.stream([0,0],true);
  assert.deepEqual(f.added,[1]);assert.deepEqual(f.materials,[]);
  f.visuals();assert.deepEqual(f.materials,[1]);
  f.visuals();assert.deepEqual(f.materials,[1]);
  const stale=fixture();
  await stale.stream([0,0],true);
  stale.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await stale.stream([0,0],true);
  await stale.stream([20*1600/3,0],false);
  stale.visuals();assert.deepEqual(stale.materials,[]);
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

test('failed stale prefetch is reported and cleared even after its tile leaves demand',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  f.pending.get(1).reject(Object.assign(new Error('stale missing tile'),{code:'NOT_FOUND'}));
  await settle();
  await f.stream([20*1600/3,0],false);
  assert.match(f.state().failures[0],/tile1.adt: NOT_FOUND stale missing tile/);
  await f.stream([20*1600/3,0],false);
  assert.equal(f.reads.filter(i=>i===1).length,1);
});

function collisionFixture(clock=performance,instanceDeltas=true) {
  const events=[],context=boot(events,clock),body=Array(15).fill(0),built=[],updates=[],parts=new Map();
  const state={instances:[],collisionInstances:[],unresolvedCollision:[],assets:new Map(),textures:new Map()};
  const f={body,built,updates,events,state,context,sweep:0,vertical:0,failNext:false,spawn:[0,0,0,0]};
  const scene={revision:0,selectionRevision:0,update(){this.selectionRevision=this.revision;},
    async pump(){},snapshot:()=>state,retry(){
      this.revision++;
      state.unresolvedCollision=state.unresolvedCollision.map(i=>({...i,status:'PENDING'}));
    }};
  context.dependencies={
    world:{telemetry:()=>body,frame_sweep_distance:()=>f.sweep,frame_vertical_sweep_distance:()=>f.vertical,set_scene_parts:(ids,counts,vertices)=>{
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
    horizon={wasmPeakBytes:0};source={stats:{},close(){},refresh(){}};
    terrain={snapshot:()=>({errors:[]}),retry:async()=>{},clear:()=>{}};
    stream=async()=>{};
    globalThis.request=handle;
    globalThis.updateCollision=async()=>updateScene(Array.from(world.telemetry().slice(0,3)));
    globalThis.refreshUnknown=()=>updateCameraUnknown(world.telemetry(),0);
    globalThis.unknown=()=>cameraUnknown.map(i=>i.id);
    globalThis.waiting=()=>objectWait.map(i=>i.id);`,context);
  if(instanceDeltas)runInContext('sceneInstanceDeltas=true;',context);
  f.update=context.updateCollision;
  f.invalidate=()=>scene.revision++;
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

test('asynchronous visuals leave collision selection unchanged until geometry or swept demand changes',async()=>{
  const f=collisionFixture(),scene=f.context.dependencies.scene;
  scene.asyncVisuals=true;scene.collisionRevision=0;scene.collisionSelectionRevision=-1;
  let selections=0;
  scene.update=function(){selections++;this.collisionSelectionRevision=this.collisionRevision;this.selectionRevision=this.revision;};
  await f.update();assert.equal(selections,1);
  scene.revision++;await f.update();assert.equal(selections,1,'Material/visual publication cannot require a collision rescan');
  scene.collisionRevision++;scene.revision++;await f.update();assert.equal(selections,2,'Geometry changes bypass the cadence');
  f.sweep=64;await f.update();assert.equal(selections,3,'An expanded swept hull cannot wait for visual work');
  f.body[0]=20;await f.update();assert.equal(selections,4,'Movement refreshes immediate collision demand');
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

test('readiness demand refreshes for acceleration and retains a bounded movement margin',async()=>{
  const f=collisionFixture({now:()=>0}),seen=[];
  const scene=f.context.dependencies.scene,update=scene.update;
  scene.update=function(...args){seen.push(args);return update.apply(this,args);};
  await f.update();assert.equal(seen.at(-1)[3],48);
  f.sweep=50;await f.update();assert.equal(seen.at(-1)[3],70);
  const count=seen.length;f.body[0]=10;await f.update();
  assert.equal(seen.length,count,'The selection margin covers this movement without reselecting every frame');
  f.sweep=65;await f.update();assert.equal(seen.at(-1)[3],85);
  f.sweep=840;await f.update();assert.equal(seen.at(-1)[3],SCENE_LIMITS.radius);
});

test('vertical collision demand holds a falling body without expanding horizontal tile reach',async()=>{
  const f=frameFixture(),seen=[];
  f.context.dependencies.scene.update=(...args)=>seen.push(args);
  f.body[1]=22.18466;f.sweep=.4;f.vertical=10;
  f.state.unresolvedCollision.push({id:'roof',kind:'group',boundsKnown:true,
    bounds:[[-2,-2,17],[2,2,17]],status:'PENDING'});
  f.invalidate();
  const result=await f.request({action:'frame',dt:.1,throttle:0,steer:0,flags:0});
  assert.deepEqual(f.waiting(),['roof']);
  assert.equal(result.scene.waitingCollision,1);
  assert.equal(f.events.filter(e=>e.event==='tick').length,0);
  assert.equal(seen.at(-1)[3],48);
  f.vertical=100;await f.update();
  assert.equal(seen.at(-1)[3],48,'Vertical growth does not enlarge horizontal demand');
  assert.equal(seen.at(-1)[4],120);
  f.vertical=900;await assert.rejects(f.update(),/collision coverage/);
  f.vertical=Infinity;await assert.rejects(f.update(),/collision coverage/);
  f.vertical=NaN;await assert.rejects(f.update(),/collision coverage/);
});

test('moving a nearly full collision cylinder refreshes its sphere-culling anchor',async()=>{
  const f=collisionFixture({now:()=>0}),seen=[];
  f.context.dependencies.scene.update=(...args)=>seen.push(args);
  f.sweep=246;f.vertical=806;await f.update();
  assert.equal(seen.length,1);assert.equal(seen[0][3],266);assert.equal(seen[0][4],826);
  f.body[1]=15;await f.update();
  assert.equal(seen.length,2,'Per-axis padding is insufficient at the selection sphere boundary');
  assert.equal(seen[1][1][2],15);
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

test('resource-only scene events omit unchanged instances while order and removal send full lists',async()=>{
  const f=collisionFixture();
  f.add(100);f.add(110);await f.update();
  f.state.textures.set('leaf.blp',{width:1,height:1,rgba:new Uint8Array(4)});
  f.invalidate();await f.update();
  let sent=f.events.filter(e=>e.event==='scene');
  assert.equal(Object.hasOwn(sent[1],'instances'),false);
  assert.deepEqual(Array.from(sent[1].textures,t=>t.key),['leaf.blp']);
  f.state.instances=f.state.instances.slice().reverse();f.invalidate();await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[2].instances,i=>i.id),['110','100']);
  f.state.instances=[];f.invalidate();await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[3].instances),[],'An empty list explicitly clears the scene');
});

test('failed resource-only scene post retries resources without marking them uploaded',async()=>{
  const f=collisionFixture();
  f.add(100);await f.update();
  const push=f.events.push.bind(f.events);let reject=true;
  f.events.push=message=>{
    if(message.event==='scene' && reject){reject=false;throw new Error('Rejected resource-only scene transfer');}
    return push(message);
  };
  f.state.textures.set('leaf.blp',{width:1,height:1,rgba:new Uint8Array(4)});
  f.invalidate();
  await assert.rejects(f.update(),/Rejected resource-only/);
  await f.update();
  const sent=f.events.filter(e=>e.event==='scene');
  assert.equal(sent.length,2);
  assert.equal(Object.hasOwn(sent[1],'instances'),false);
  assert.deepEqual(Array.from(sent[1].textures,t=>t.key),['leaf.blp']);
});

test('region changes always resend a full instance list even when both scenes are empty',async()=>{
  const f=collisionFixture();
  f.context.dependencies.manifest.regions.push({placement:[30000,0],tile_origin:[32,32]});
  await f.update();
  f.body[0]=30000;await f.update();
  const sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(sent.map(e=>e.region),[0,1]);
  assert(sent.every(e=>Array.isArray(e.instances)&&e.instances.length===0));
});

test('legacy clients receive full instance lists for resource-only scene updates by default',async()=>{
  const f=collisionFixture(performance,false);
  f.add(100);await f.update();
  f.state.textures.set('leaf.blp',{width:1,height:1,rgba:new Uint8Array(4)});
  f.invalidate();await f.update();
  const sent=f.events.filter(e=>e.event==='scene');
  assert.equal(sent.length,2);
  assert.deepEqual(Array.from(sent[1].instances,i=>i.id),['100']);
});

test('only explicit open capability true enables resource-only instance deltas',async()=>{
  for(const capability of [undefined,false,'true',1,true]) {
    const f=collisionFixture();
    f.context.openAssetSource=async()=>{throw new Error('Stop after capability negotiation');};
    await assert.rejects(f.request({action:'open',sceneInstanceDeltas:capability}),/Stop after capability/);
    assert.equal(runInContext('sceneInstanceDeltas',f.context),capability===true);
  }
});

test('post-response visuals require a separate explicit capability',async()=>{
  for(const capability of [undefined,false,'true',1,true]) {
    const f=collisionFixture();
    f.context.openAssetSource=async()=>{throw new Error('Stop after capability negotiation');};
    await assert.rejects(f.request({action:'open',sceneInstanceDeltas:true,postFrameVisuals:capability}),/Stop after capability/);
    assert.equal(runInContext('postFrameVisuals',f.context),capability===true);
  }
});

test('ordered instance updates require a separate explicit capability',async()=>{
  for(const capability of [undefined,false,'true',1,true]) {
    const f=collisionFixture();
    f.context.openAssetSource=async()=>{throw new Error('Stop after capability negotiation');};
    await assert.rejects(f.request({action:'open',sceneInstanceUpdates:capability}),/Stop after capability/);
    assert.equal(runInContext('sceneInstanceUpdates',f.context),capability===true);
  }
});

test('ordered scene updates send only changed render descriptors, retaining complete order and removals',async()=>{
  const f=collisionFixture();
  runInContext('sceneInstanceUpdates=true;',f.context);
  f.add(100);f.add(110);await f.update();
  let sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[0].instanceOrder),['100','110']);
  assert.deepEqual(Array.from(sent[0].instances,i=>i.id),['100','110']);
  assert.equal(Object.hasOwn(sent[0].instances[0],'bounds'),false,'Collision metadata stays in the worker');
  f.state.instances.reverse();f.invalidate();await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[1].instanceOrder),['110','100']);
  assert.equal(sent[1].instances.length,0,'Ordering changes do not retransmit matrices');
  f.move(100,111);await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[2].instances,i=>i.id),['100']);
  f.state.instances[0].distant=true;f.invalidate();await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[3].instances,i=>i.id),['110'],'Changed descriptor fields cannot reuse stale render state');
  f.state.instances=[];f.invalidate();await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.equal(sent[4].instanceOrder.length,0);
  assert.equal(sent[4].instances.length,0);
  f.add(100);await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[5].instances,i=>i.id),['100'],'Re-admission resends removed descriptors');
});

test('failed ordered scene posts retry transforms and region changes resend every descriptor',async()=>{
  const f=collisionFixture();
  runInContext('sceneInstanceUpdates=true;',f.context);
  f.context.dependencies.manifest.regions.push({placement:[30000,0],tile_origin:[32,32]});
  f.add(100);await f.update();f.move(100,110);
  const push=f.events.push.bind(f.events);let reject=true;
  f.events.push=message=>{
    if(message.event==='scene'&&reject){reject=false;throw new Error('Rejected instance update');}
    return push(message);
  };
  await assert.rejects(f.update(),/Rejected instance update/);
  await f.update();
  let sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[1].instances,i=>i.id),['100']);
  f.body[0]=30000;await f.update();
  sent=f.events.filter(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent[2].instances,i=>i.id),['100']);
  assert.equal(sent[2].region,1);
});

function frameFixture(deferred=true) {
  const f=collisionFixture();
  f.context.dependencies.world.tick=()=>{f.events.push({event:'tick'});};
  f.context.dependencies.scene.pump=async()=>{f.events.push({event:'pump'});};
  runInContext(`postFrameVisuals=${deferred};
    prepareDistant=()=>{};
    startCraft=()=>{};terrain.pump=async()=>{};
    globalThis.dispatch=async(data)=>{onmessage({data});await queue;};`,f.context);
  f.dispatch=f.context.dispatch;
  f.frame=id=>f.dispatch({id,action:'frame',dt:1/120,throttle:1,steer:0,flags:0});
  return f;
}

function materialFixture() {
  const f=frameFixture();
  f.context.admissions=[];
  f.context.dependencies.manifest.tiles=Array.from({length:4},(_,i)=>({file:`tile${i}.adt`}));
  f.context.dependencies.world.terrain_material=i=>({index:i});
  runInContext(`stream=async()=>{
    const index=admissions.shift();
    if(index!==undefined){resident.add(index);terrainMaterials.add(index);loads++;}
  };
  terrain.setTile=(index,material)=>postMessage({event:'material',index,material});
  globalThis.materialState=()=>({pending:[...terrainMaterials],errors:[...terrainErrors.values()]});`,f.context);
  f.state=()=>JSON.parse(JSON.stringify(f.context.materialState()));
  return f;
}

test('hop edges survive zero ticks, are examined once, and are not buffered until landing',async()=>{
  const f=frameFixture(),flags=[];
  f.context.dependencies.world.tick=(_throttle,_steer,value)=>flags.push(value);
  const send=(id,dt,hop,held=0)=>f.dispatch({id,action:'frame',dt,hop,throttle:0,steer:0,flags:held});
  const ack=id=>f.events.find(e=>e.id===id).result.hopConsumed;
  await send(1,.003,1);
  assert.deepEqual(flags,[]);assert.equal(ack(1),0);
  await send(2,.014,1);
  assert.deepEqual(flags,[8,0]);assert.equal(ack(2),1);
  assert.equal(f.body[7],0,'Even an airborne numerical attempt consumes the edge');
  f.body[7]=1;
  await send(3,1/120,1);
  assert.equal(flags.at(-1),0,'Landing cannot replay an acknowledged press');
  await send(4,.025,2,8);
  assert.deepEqual(flags.slice(-3),[8,8,8]);assert.equal(ack(4),2);
  await send(5,1/120,2);
  assert.equal(flags.at(-1),0);
  await send(6,.01,-1);
  assert.match(f.events.find(e=>e.id===6).error,/Invalid hop sequence/);
});

test('admission materials wait for the catch-up reply without skipping readiness pumps',async()=>{
  const f=materialFixture();f.context.admissions.push(0);
  await f.frame(1);
  assert.deepEqual(f.events.map(e=>e.event||`reply:${e.id}`),['collision','tick','reply:1','scene','pump']);
  assert.deepEqual(f.state().pending,[0]);assert.equal(f.context.timers.size,1);
  await f.dispatch({id:2,action:'frame',dt:0,throttle:0,steer:0,flags:0});
  assert.equal(f.events.some(e=>e.event==='material'),false,'A zero-step reply must not trigger catch-up material work');
  await f.dispatch({id:3,action:'frame',dt:.05,throttle:1,steer:0,flags:0});
  const reply=f.events.findIndex(e=>e.id===3),material=f.events.findIndex(e=>e.event==='material');
  assert(reply<material);assert.equal(f.events.filter(e=>e.event==='pump').length,3);
  assert.deepEqual(f.state().pending,[]);assert.equal(f.context.timers.size,0);
});

test('consecutive admissions stay bounded and idle timers complete every pending material once',async()=>{
  const f=materialFixture();f.context.admissions.push(0,1,2,3);
  for(let i=0;i<4;i++)await f.frame(i+1);
  assert.equal(f.events.some(e=>e.event==='material'),false);
  assert.deepEqual(f.state().pending,[0,1,2,3]);assert.equal(f.context.timers.size,1);
  assert.equal([...f.context.timers.values()][0].delay,25);
  for(let i=0;i<4;i++)await f.context.fireTimer();
  assert.deepEqual(f.events.filter(e=>e.event==='material').map(e=>e.index),[0,1,2,3]);
  assert.equal(f.context.timers.size,0);assert.deepEqual(f.state().errors,[]);
});

test('only one asynchronous material is active while frames and pending admissions continue',async()=>{
  const f=materialFixture(),started=[],pending=[];
  f.context.prepareAsync=index=>{started.push(index);return new Promise(resolve=>pending.push(resolve));};
  runInContext('terrain.prepareTile=prepareAsync;',f.context);
  f.context.admissions.push(0,1);await f.frame(1);await f.frame(2);await f.frame(3);await f.frame(4);
  assert.deepEqual(started,[0]);assert.deepEqual(f.state().pending,[1]);
  assert(f.events.some(e=>e.id===4),'Physics replies cannot wait for material copies');
  pending.shift()();await settle();await f.frame(5);assert.deepEqual(started,[0,1]);
  pending.shift()();await settle();
});

test('old asynchronous material completion cannot rearm work during source replacement',async()=>{
  const f=materialFixture();let resume;
  f.context.prepareAsync=()=>new Promise(resolve=>{resume=resolve;});
  runInContext('terrain.prepareTile=prepareAsync;',f.context);
  f.context.admissions.push(0);await f.frame(1);await f.frame(2);
  f.context.openAssetSource=async()=>{throw Error('Source replacement stopped');};
  await f.dispatch({id:3,action:'open',postFrameVisuals:true});
  resume();await settle();
  assert.equal(f.context.timers.size,0);assert.deepEqual(f.state().pending,[]);
});

test('idle material work runs behind an already queued catch-up and cancelled callbacks cannot repeat it',async()=>{
  const f=materialFixture();f.context.admissions.push(0);await f.frame(1);
  const timer=[...f.context.timers.values()][0];
  const frame=f.frame(2);timer.callback();await frame;await runInContext('queue',f.context);
  assert.equal(f.events.filter(e=>e.event==='material').length,1);
  assert(f.events.findIndex(e=>e.id===2)<f.events.findIndex(e=>e.event==='material'));
});

test('eviction and reimport cancel stale material callbacks, and source replacement cancels pending work',async()=>{
  const f=materialFixture();f.context.admissions.push(0);await f.frame(1);
  const stale=[...f.context.timers.values()][0];
  runInContext('terrainMaterials.delete(0);resident.delete(0);cancelMaterialTimer();',f.context);
  f.context.admissions.push(0);await f.frame(2);
  stale.callback();await runInContext('queue',f.context);
  assert.equal(f.events.some(e=>e.event==='material'),false);
  await f.context.fireTimer();assert.equal(f.events.filter(e=>e.event==='material').length,1);
  f.context.admissions.push(1);await f.frame(3);
  const oldSource=[...f.context.timers.values()][0];
  f.context.openAssetSource=async()=>{throw Error('Source replacement stopped');};
  await f.dispatch({id:4,action:'open',postFrameVisuals:true});
  oldSource.callback();await runInContext('queue',f.context);
  assert.match(f.events.find(e=>e.id===4).error,/Source replacement stopped/);
  assert.deepEqual(f.state().pending,[]);assert.equal(f.context.timers.size,0);
  assert.equal(f.events.filter(e=>e.event==='material').length,1);
});

test('failed deferred material is reported once and only an explicit retry prepares it again',async()=>{
  const f=materialFixture();f.context.admissions.push(0);await f.frame(1);
  f.context.dependencies.world.terrain_material=()=>{throw Error('Bad material');};
  await f.context.fireTimer();await f.frame(2);
  assert.deepEqual(f.state().pending,[]);assert.match(f.state().errors[0],/tile0.adt: Bad material/);
  assert.equal(f.context.timers.size,0);assert.equal(f.events.some(e=>e.event==='material'),false);
  f.context.dependencies.world.terrain_material=i=>({index:i});
  await f.dispatch({id:3,action:'retry'});
  assert.deepEqual(f.state().errors,[]);assert.equal(f.events.filter(e=>e.event==='material').length,1);
});

test('idle texture completion rearms only bounded unfinished near work',async()=>{
  const f=materialFixture();let pumps=0;
  f.context.terrainPump=async()=>++pumps<3;
  runInContext('terrain.pump=terrainPump;',f.context);
  f.context.admissions.push(0);await f.frame(1);await settle();
  await f.context.fireTimer();await f.context.fireTimer();
  assert.equal(pumps,3);assert.equal(f.context.timers.size,0);
  assert.equal(f.events.filter(e=>e.event==='material').length,1);
});

test('an older texture-only timer cannot prepare a newly admitted tile before its catch-up',async()=>{
  const f=materialFixture();
  runInContext('scheduleTerrainMaterials(true);',f.context);
  f.context.admissions.push(0);await f.frame(1);
  await f.context.fireTimer();
  assert.equal(f.events.some(e=>e.event==='material'),false);
  await f.context.fireTimer();
  assert.equal(f.events.filter(e=>e.event==='material').length,1);
});

test('late terrain pump completion cannot schedule work after source cancellation',async()=>{
  const f=materialFixture();let resolve;
  f.context.terrainPump=()=>new Promise(r=>{resolve=r;});
  runInContext('terrain.pump=terrainPump;',f.context);
  await f.frame(1);
  f.context.openAssetSource=async()=>{throw Error('Source replacement stopped');};
  await f.dispatch({id:2,action:'open',postFrameVisuals:true});
  resolve(true);await settle();
  assert.equal(f.context.timers.size,0);
});

test('negotiated frames publish collision then real physics response before visuals and decode work',async()=>{
  const f=frameFixture();
  f.add(100);
  await f.frame(1);
  assert.deepEqual(f.events.map(e=>e.event||`reply:${e.id}`),['collision','tick','reply:1','scene','pump']);
  assert.equal(f.events.find(e=>e.id===1).result.scene.waitingCollision,0);
});

test('pose timestamps describe fixed ticks in the input clock and do not advance on zero-step replies',async()=>{
  const f=frameFixture();
  const frame=async(id,dt,sampleTime)=>{
    await f.dispatch({id,action:'frame',dt,sampleTime,throttle:1,steer:0,flags:0});
    return f.events.find(e=>e.id===id);
  };
  assert.equal((await frame(1,.006,1006)).result.poseTime,1000);
  assert.equal((await frame(2,.001,1007.2)).result.poseTime,1000);
  assert(Math.abs((await frame(3,.003,1010)).result.poseTime-(1000+1000/120))<1e-9);
  assert(Math.abs((await frame(4,.006,1016.2)).result.poseTime-(1000+1000/120))<1e-9);
  assert.equal((await frame(5,.001,undefined)).result.poseTime,undefined,'Legacy frames do not claim a clock');
  assert.match((await frame(6,.001,NaN)).error,/Invalid input sample time/);
});

test('physics-first frames still block unknown collision and failed BVH admission before responding',async()=>{
  const f=frameFixture();
  f.add(100);f.unresolved(2);
  await f.frame(1);
  assert.equal(f.events.some(e=>e.event==='tick'),false);
  assert.equal(f.events.find(e=>e.id===1).result.scene.waitingCollision,1);
  const failed=frameFixture();
  failed.add(100);failed.failNext=true;
  await failed.frame(2);
  assert.match(failed.events.find(e=>e.id===2).error,/Rejected synthetic collision/);
  assert.equal(failed.events.some(e=>['tick','scene','pump'].includes(e.event)),false);
});

test('legacy frames publish visuals before physics and return synchronous publication failures',async()=>{
  const f=frameFixture(false);
  f.add(100);
  const push=f.events.push.bind(f.events);
  f.events.push=event=>{
    if(event.event==='scene')throw new Error('Legacy scene publication failed');
    return push(event);
  };
  await f.frame(1);
  assert.equal(f.events.some(e=>e.event==='tick'),false);
  assert.match(f.events.find(e=>e.id===1).error,/Legacy scene publication failed/);
  assert.equal(f.events.some(e=>e.event==='world-error'),false);
});

test('post-response failure surfaces once, blocks subsequent physics and retries only explicitly',async()=>{
  const f=frameFixture();
  f.add(100);
  const push=f.events.push.bind(f.events);let reject=true;
  f.events.push=event=>{
    if(event.event==='scene' && reject){reject=false;throw new Error('Deferred scene publication failed');}
    return push(event);
  };
  await f.frame(1);
  assert.equal(f.events.filter(e=>e.id===1).length,1);
  assert(f.events.find(e=>e.id===1).result);
  assert.match(f.events.find(e=>e.event==='world-error').error,/Deferred scene publication failed/);
  assert.equal(f.events.some(e=>e.event==='pump'),false);
  await f.frame(2);
  assert.match(f.events.find(e=>e.id===2).error,/Deferred scene publication failed/);
  assert.equal(f.events.filter(e=>e.event==='tick').length,1);
  assert.equal(f.events.filter(e=>e.event==='world-error').length,1);
  await f.dispatch({id:3,action:'retry'});
  const sent=f.events.find(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent.assets,a=>a.key),['100']);
  await f.frame(4);
  assert.equal(f.events.filter(e=>e.event==='tick').length,2);
});

test('visual tail finishes before the next queued physics request begins',async()=>{
  const f=frameFixture();
  f.add(100);
  await Promise.all([f.frame(1),f.frame(2)]);
  assert.deepEqual(f.events.map(e=>e.event||`reply:${e.id}`),
    ['collision','tick','reply:1','scene','pump','tick','reply:2','pump']);
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

test('restore waits for destination support collision before atomically committing the pose',async()=>{
  const f=collisionFixture(),order=[];
  f.state.pending=1;
  f.unresolved(2000);
  Object.assign(f.state.unresolvedCollision[0],{status:'PENDING',key:'deck'});
  let release;
  f.context.dependencies.scene.pump=async()=>{
    order.push('read');
    await new Promise(resolve=>{release=resolve;});
    f.state.unresolvedCollision=[];f.add(2000);
    order.push('collision-ready');
  };
  f.context.dependencies.world.restore=pose=>{
    assert.equal(f.built.at(-1).length,9,'Destination geometry is submitted before native validation');
    order.push('restore');f.body.splice(0,4,...pose);
  };
  const pending=f.request({action:'restore',pose:[2000,2000,0,0]});
  await settle();
  assert.equal(f.body[0],0);assert.deepEqual(order,['read']);
  release();const result=await pending;
  assert.deepEqual(order,['read','collision-ready','restore']);
  assert.equal(result.telemetry[0],2000);assert.equal(result.telemetry[1],2000);
});

test('failed destination collision or native occupancy keeps the old pose and restores old scene demand',async()=>{
  for(const collisionFailure of [false,true]){
    const f=collisionFixture(),streams=[];
    f.body[0]=50;f.body[1]=1.1;
    f.context.streams=streams;
    runInContext('stream=async(p)=>streams.push(Array.from(p));',f.context);
    if(collisionFailure){
      f.unresolved(2000);
      Object.assign(f.state.unresolvedCollision[0],{status:'CORRUPT',key:'deck'});
    } else {
      f.context.dependencies.world.restore=()=>{throw new Error('Saved vehicle overlaps authored collision');};
    }
    const previous=f.body.slice();
    await assert.rejects(f.request({action:'restore',pose:[2000,20,0,0]}),
      collisionFailure?/collision unavailable/:/overlaps authored collision/);
    assert.deepEqual(f.body,previous);
    assert.deepEqual(streams.map(p=>Array.from(p)),[[2000,0],[50,0]]);
    assert.deepEqual(f.waiting(),[]);
  }
});

test('restore reports unchanged-revision capacity failure instead of spinning the worker queue',async()=>{
  const f=collisionFixture();let pumps=0;
  f.unresolved(2000);f.state.pending=1;
  Object.assign(f.state.unresolvedCollision[0],{status:'PENDING',key:'deck'});
  f.context.dependencies.scene.snapshot=()=>({...f.state});
  f.context.dependencies.scene.pump=async()=>{
    if(++pumps>1)throw new Error('Repeated a capacity-blocked pump without progress');
    f.state.capacityBlocked=true;
  };
  await assert.rejects(f.request({action:'restore',pose:[2000,20,0,0]}),/scene budget/);
  assert.equal(pumps,1);assert.equal(f.body[0],0);
});

test('restore explicitly reports failure to reacquire previously available terrain',async()=>{
  const f=collisionFixture();
  f.context.dependencies.world.required_tiles=()=>[7];
  f.context.dependencies.world.restore=()=>{throw new Error('Rejected saved pose');};
  runInContext('resident.add(7);stream=async()=>{resident.clear();};',f.context);
  await assert.rejects(f.request({action:'restore',pose:[2000,20,0,0]}),
    /Rejected saved pose; previous pose retained but scene recovery failed: Previous location terrain is unavailable/);
  assert.equal(f.body[0],0);
});

test('frame timing separates post-tick camera scanning from physics queries',async()=>{
  let now=1000;
  const f=collisionFixture({now:()=>now});
  f.unresolved(50);
  f.context.boundsWithin=(...args)=>{now+=5;return boundsWithin(...args);};
  f.context.dependencies.world.tick=()=>{now+=2;};
  runInContext(`prepareDistant=()=>{};startCraft=()=>{};
    terrain.pump=async()=>{};`,f.context);
  const result=await f.request({action:'frame',dt:1/120,throttle:0,steer:0,flags:0});
  assert.equal(result.timings.physicsMs,2);
  assert.equal(result.timings.cameraUnknownMs,5);
  assert.equal(result.timings.sceneMs,10,'First query includes the conservative broad phase');
  const firstSceneMs=result.timings.sceneMs;
  const second=await f.request({action:'frame',dt:1/120,throttle:0,steer:0,flags:0});
  assert.equal(second.timings.sceneMs-firstSceneMs,5,'Stable coverage only runs the exact predicate');
});
