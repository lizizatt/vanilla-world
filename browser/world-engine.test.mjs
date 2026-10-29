import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SCENE_LIMITS,boundsWithin} from './scene-stream.js';
import {prepareDetail} from './camera-collision.js';
import {settle,boot,fixture,collisionFixture,frameFixture,materialFixture,runInContext} from './world-worker-fixtures.mjs';

test('optional visual reads never gate an already collision-ready pose',async()=>{
  const context=boot();
  runInContext(`
    scenePump=new Promise(()=>{});
    updateScene=()=>{objectWait=[];};
    globalThis.prepare=preparePoseScene;
  `,context);
  let complete=false;
  const ready=context.prepare([0,0,0,0]).then(()=>{complete=true;});
  await settle();
  assert(complete,'A pending NPC/visual read cannot delay pose readiness');
  await ready;
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
test('rebind cancels old detail ownership even when the asset source is unchanged',async()=>{
  const events=[],context=boot(events),jobs=[];
  context.dependencies={prepareDetail:data=>new Promise((resolve,reject)=>jobs.push({data,resolve,reject})),refresh(){}};
  runInContext(`
    source=dependencies;world={set_scene_parts(){}};
    scene={clear(){},removeTile(){}};
    terrain={clear(){},async init(){}};
    globalThis.send=sendDetail;globalThis.rebind=rebindRenderer;
  `,context);
  const tile=index=>({index,placement:[0,0],vertices:new Float32Array()});
  context.send({event:'detail',tiles:[tile(0)],removed:[],seams:[]});
  await context.rebind(false);
  context.send({event:'detail',tiles:[tile(1)],removed:[],seams:[]});
  context.send({event:'detail',tiles:[tile(2)],removed:[],seams:[]});
  jobs[0].resolve(prepareDetail(jobs[0].data));await settle();
  assert.equal(events.length,0,'Old consumer must never publish to the new renderer');
  assert.equal(jobs.length,2,'Old finally must not release the current detail guard');
  jobs[1].resolve(prepareDetail(jobs[1].data));await settle();
  assert.equal(jobs.length,3);
  jobs[2].resolve(prepareDetail(jobs[2].data));await settle();
  assert.deepEqual(events.filter(e=>e.event==='detail').map(e=>Array.from(e.tiles,t=>t.index)),[[1],[2]]);
});
test('demotion closes far work and invalidates scene demand before refreshing source cancellation',async()=>{
  const context=boot(),steps=[];
  context.steps=steps;
  runInContext(`
    source={refresh(){steps.push('refresh');}};world={set_scene_parts(){}};
    far={active:true,close(){this.active=false;steps.push('far');}};
    scene={clear(){steps.push('scene');},removeTile(){}};
    terrain={clear(){steps.push('terrain');},async init(){steps.push('init');}};
    globalThis.rebind=rebindRenderer;globalThis.farActive=()=>far.active;
  `,context);
  await context.rebind(false);
  assert.equal(context.farActive(),false);
  assert(steps.indexOf('scene')>=0&&steps.indexOf('scene')<steps.indexOf('refresh'));
  assert(!steps.includes('init'),'A parked engine must not restart optional terrain IO');
});
test('late material completion cannot rearm work after demotion',async()=>{
  const f=materialFixture();let complete;
  f.context.finishMaterial=()=>new Promise(resolve=>complete=resolve);
  runInContext(`
    source.refresh=()=>{};world.remove_tile=()=>{};
    scene.removeTile=()=>{};scene.clear=()=>{};
    terrain.init=async()=>{};terrain.removeTile=()=>{};
    terrain.prepareTile=finishMaterial;
    globalThis.rebind=rebindRenderer;
  `,f.context);
  f.context.admissions.push(1);
  await f.frame(1);await f.frame(2);
  assert(complete);
  await f.context.rebind(false);
  complete();await settle();
  assert.equal(f.context.timers.size,0,'Old material must not enqueue new timers on the parked engine');
});
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

test('terrain materials wait for published detail, not just completed collision admission',async()=>{
  const f=fixture([0,1]),jobs=[];
  f.context.dependencies.source.prepareDetail=data=>new Promise(resolve=>jobs.push({data,resolve}));
  runInContext('postFrameVisuals=true;',f.context);
  await f.stream([0,0],true);f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await f.stream([0,0],true);
  f.visuals();assert.deepEqual(f.materials,[]);
  for(let i=0;i<4;i++)await f.context.fireTimer();
  assert.equal(jobs.length,1);
  f.visuals();assert.deepEqual(f.materials,[],'Source-worker preprocessing must finish before material extraction');
  jobs[0].resolve(prepareDetail(jobs[0].data));await settle();
  assert(f.events.some(e=>e.event==='detail'));
  await f.context.fireTimer();
  assert.deepEqual(f.materials,[1]);
});

test('an old detail reply cannot authorize materials for a readmitted tile index',async()=>{
  const f=fixture([0,1]),jobs=[];
  f.context.dependencies.source.prepareDetail=data=>new Promise(resolve=>jobs.push({data,resolve}));
  await f.stream([0,0],true);f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  await f.stream([0,0],true);
  runInContext('tileVersions.set(1,++nextTileVersion);detailReady.delete(1);',f.context);
  jobs[0].resolve(prepareDetail(jobs[0].data));await settle();
  f.visuals();assert.deepEqual(f.materials,[]);
  runInContext(`sendDetail({event:'detail',removed:[],seams:[],
    tiles:[{index:1,version:tileVersions.get(1),placement:[0,0],vertices:new Float32Array()}]});`,f.context);
  jobs[1].resolve(prepareDetail(jobs[1].data));await settle();
  f.visuals();assert.deepEqual(f.materials,[1]);
});

test('prefetched ADT becoming required keeps support pinned without blocking the frame',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  f.required.push(1);
  let done=false;
  const frame=f.stream([0,0],true).then(()=>{done=true;});
  await settle();
  assert.equal(done,true);
  assert.deepEqual(f.reads,[1]);
  assert.deepEqual(f.state().resident,[0]);
  f.pending.get(1).resolve(new Uint8Array([1]));
  await frame;await settle();
  assert.deepEqual(f.state().resident,[0],'Required support remains unavailable until atomic publication');
  await f.stream([0,0],true);
  assert.deepEqual(f.state().resident,[0,1]);
  assert.deepEqual(f.added,[1]);
});

test('terrain preparation yields outside frames and publishes no partial collision metadata',async()=>{
  const f=fixture([0,1]),turns=[];
  f.context.yieldStep=()=>new Promise(resolve=>turns.push(resolve));
  runInContext('yieldTerrain=yieldStep;',f.context);
  let steps=0,publications=0;
  f.context.dependencies.world.step_tile=()=>++steps===40;
  f.context.dependencies.scene.commitTile=()=>publications++;
  await f.stream([0,0],true);
  f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  assert.deepEqual(f.prepared,[]);
  while(steps<40){
    turns.shift()();await settle();
    await f.stream([0,0],true);
    if(steps<40){
      assert.deepEqual(f.state().resident,[0]);assert.equal(publications,0);
      assert(steps<=40);
    }
  }
  assert.deepEqual(f.added,[1]);assert.equal(publications,1);
});

test('changed placement metadata is re-prepared before terrain becomes resident',async()=>{
  const f=fixture([0,1]);
  await f.stream([0,0],true);
  f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  f.context.dependencies.scene.placementRevision++;
  await f.stream([0,0],true);
  assert.deepEqual(f.added,[]);
  await settle();await f.stream([0,0],true);
  assert.deepEqual(f.added,[1]);assert.deepEqual(f.prepared,[1],'No duplicate Rust decoding');
});

test('source replacement cancels a yielded tile before any stale Wasm calls or publication',async()=>{
  const f=fixture([0,1]),turns=[];
  f.context.yieldStep=()=>new Promise(resolve=>turns.push(resolve));
  runInContext('yieldTerrain=yieldStep;',f.context);
  await f.stream([0,0],true);
  f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  runInContext('discardTerrainRead();source={};world={};',f.context);
  turns.shift()();await settle();
  assert.deepEqual(f.prepared,[]);assert.deepEqual(f.added,[]);
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

test('required demand preempts failed optional preparation without losing its error',async()=>{
  const f=fixture([0,1,2]);
  f.context.dependencies.world.begin_tile=()=>{throw Error('Invalid staged terrain');};
  await f.stream([0,0],true);
  f.pending.get(1).resolve(new Uint8Array([1]));await settle();
  f.required.push(2);
  await f.stream([0,0],true);
  assert.deepEqual(f.reads,[1,2]);
  assert.match(f.state().failures[0],/Invalid staged terrain/);
  assert.deepEqual(f.added,[]);
});

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
test('far fallback is suppressed only after near textures arrive, including resource-only updates',async()=>{
  const f=collisionFixture(),seen=[];
  f.context.readyNear=ids=>seen.push([...ids]);
  runInContext('far.near=readyNear;',f.context);
  f.add(100);f.state.assets.get('100').batches=[{texture:'leaf.blp'}];
  await f.update();assert.deepEqual(seen.at(-1),[]);
  f.state.textures.set('leaf.blp',{width:1,height:1,rgba:new Uint8Array(4)});
  f.invalidate();await f.update();
  assert.deepEqual(seen.at(-1),['100']);
  assert.equal(Object.hasOwn(f.events.filter(e=>e.event==='scene').at(-1),'instances'),false);
  f.state.textures.delete('leaf.blp');f.invalidate();await f.update();
  assert.deepEqual(seen.at(-1),[]);
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
test('staged material construction passes the original world and handle to yielded work',async()=>{
  const f=materialFixture(),material={};let resume,steps=0;
  f.context.dependencies.world.begin_terrain_material=index=>{assert.equal(index,0);return material;};
  f.context.dependencies.world.step_terrain_material=(index,value)=>{
    assert.equal(index,0);assert.equal(value,material);steps++;return true;
  };
  f.context.prepareAsync=(index,value,step)=>{
    assert.equal(index,0);assert.equal(value,material);
    return new Promise(resolve=>{resume=()=>{assert(step());resolve();};});
  };
  runInContext('terrain.prepareTile=prepareAsync;',f.context);
  f.context.admissions.push(0);await f.frame(1);await f.frame(2);
  assert.equal(steps,0);assert(f.events.some(e=>e.id===2));
  resume();await settle();assert.equal(steps,1);
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
