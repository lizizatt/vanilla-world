import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SceneStream, selectionPrefix, multiply, placementMatrix, transformPoint, transformedBounds, globalCollisionVertices, validatePopulation, modelPath, boundsDistance, boundsWithin } from './scene-stream.js';

const p = (id, path = 'tree.mdx', x = 0) => ({ kind: 'm2', id, path, position: [x, 0, 0], rotation: [0, 180, 0], scale: 1 });
const fixture = ({ cutout = false, texture = 'leaves.blp' } = {}) => {
  let reads = 0, freed = 0;
  const model = () => ({
    metadata: () => JSON.stringify({ bounds: [[-1, -1, 0], [1, 1, 2]], batches: [{
      texture: cutout ? texture : null, alphaCutoff: cutout ? 224 / 255 : 0,
    }] }),
    vertices: () => new Float32Array(36), indices: () => new Uint32Array([0, 1, 2]),
    collision_vertices: () => new Float32Array(9), collision_indices: () => new Uint32Array([0, 1, 2]),
    free: () => freed++,
  });
  return {
    source: { read: async () => { reads++; return new Uint8Array([1]); } },
    wasm: { scene_placements: data => JSON.stringify(data), SceneModel: { m2: model },
      SceneTexture: class {
        metadata() { return '{"width":1,"height":1}'; }
        rgba() { return new Uint8Array([20, 80, 30, 0]); }
        free() { freed++; }
      } },
    reads: () => reads, freed: () => freed,
  };
};

test('bounded visual selection exactly matches full sorting without sorting the rejected tail',()=>{
  const items=Array.from({length:12000},(_,id)=>({id,score:(id*7919)%997}));
  const compare=(a,b)=>a.score-b.score||a.id-b.id,sorted=items.toSorted(compare);
  for(const count of [0,1,2,128,256,1024,12001])
    assert.deepEqual(selectionPrefix(items,count,compare),sorted.slice(0,count));
  let comparisons=0;
  assert.deepEqual(selectionPrefix(sorted,128,(a,b)=>{comparisons++;return compare(a,b);}),sorted.slice(0,128));
  assert(comparisons<items.length*2,'Rejected far candidates need only a comparison against the retained tail');
});

test('visual selection yields, commits the same ranking, and never owns immediate collision demand',async()=>{
  const f=fixture(),sync=new SceneStream(f.source,f.wasm),stream=new SceneStream(f.source,f.wasm);
  stream.asyncVisuals=true;stream.collisionReach=152;
  const placements=Array.from({length:6400},(_,id)=>p(id,`tree${id%12}.m2`,id%800));
  for(const s of [sync,stream]){s.setTile('1:0:0',placements.map(p=>({...p})));s.update(1,[0,0,0]);}
  let yields=0;stream.yieldVisual=async()=>{yields++;};
  const collision=stream.collisionCandidates,requests=stream.requests;
  const work=stream.prepareVisuals();
  assert.equal(stream.instances.length,0);
  assert([...requests.values()].some(r=>r.required),'Required demand exists before any visual slice');
  await work;
  assert(yields>=100,'Candidate enumeration must yield repeatedly, not wrap one synchronous selection');
  assert.deepEqual(stream.instances.map(i=>i.id),sync.instances.map(i=>i.id));
  assert.equal(stream.collisionCandidates,collision,'Visual commit cannot replace authoritative collision candidates');
  assert.deepEqual([...stream.requests.keys()].sort(),[...sync.requests.keys()].sort());
  assert.equal(stream.prepareVisuals(),undefined,'An unchanged scene must not select again');
});

test('sliced collision demand matches full demand across motion, support columns and loaded broad hulls',()=>{
  const f=fixture(),sync=new SceneStream(f.source,f.wasm),stream=new SceneStream(f.source,f.wasm);
  stream.asyncVisuals=true;stream.collisionReach=152;
  const placements=Array.from({length:1200},(_,id)=>({...p(id,`tree${id}.m2`,id%300-150),
    position:[id%300-150,id%127-63,id%200-100]}));
  placements.push(p(2000,'wide.m2',700));
  for(const s of [sync,stream]){
    s.setTile('1:0:0',placements.map(p=>({...p})));
    s.cache.set('m2:wide.m2:[]',{value:{vertices:new Float32Array(),indices:new Uint32Array(),batches:[],
      bounds:[[-1,-1,-1],[1,1,1]],collisionBounds:[[-800,-100,-100],[800,100,100]]},bytes:0,used:0});
  }
  for(let step=0;step<40;step++){
    const position=[step*3,20,step*2],predicted=[step*3+150,20,step%2?step*2:-Number.MAX_VALUE];
    for(const s of [sync,stream])s.update(1,position,predicted,54,84);
    const required=s=>[...s.requests.values()].filter(r=>r.required).map(r=>r.key).sort();
    assert.deepEqual(required(stream),required(sync));
    assert(stream.collisionCandidates.some(i=>i.id==='1:m2:2000'),
      'Collision bounds, not just render bounds, determine whether decoded geometry enters the shortlist');
    const nearby=s=>s.snapshot().unresolvedCollision.filter(i=>boundsWithin(i.bounds,position,84,84)).map(i=>i.id);
    assert.deepEqual(nearby(stream),nearby(sync));
  }
});

test('required loading preempts pending visuals and invalidates their stale resource revision',async()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm,{jobs:1});
  stream.asyncVisuals=true;stream.setTile('1:0:0',[p(1)]);
  stream.update(1,[0,0,0]);
  let resume;stream.yieldVisual=()=>new Promise(resolve=>{resume=resolve;});
  const work=stream.prepareVisuals();
  await stream.pump(true);
  assert.equal(f.reads(),1,'Required geometry must load without waiting for a visual draft');
  resume();await work;
  assert.equal(stream.instances.length,0,'Changed resource bounds invalidate the old visual draft');
  stream.yieldVisual=async()=>{};
  await stream.prepareVisuals();
  assert.equal(stream.instances.length,1);
  assert.equal(stream.instances[0].boundsKnown,true);
});

test('map replacement and clear reject queued visual results',async()=>{
  for(const clear of [false,true]){
    const f=fixture(),stream=new SceneStream(f.source,f.wasm);
    stream.asyncVisuals=true;stream.setTile('1:0:0',[p(1)]);
    stream.setTile('0:0:0',[p(2)]);
    stream.update(1,[0,0,0]);
    let resume;stream.yieldVisual=()=>new Promise(resolve=>{resume=resolve;});
    const work=stream.prepareVisuals();
    if(clear)stream.clear();else stream.update(0,[0,0,0]);
    resume();await work;
    assert.equal(stream.instances.length,0);
    if(!clear){
      stream.yieldVisual=async()=>{};await stream.prepareVisuals();
      assert.deepEqual(stream.instances.map(i=>i.id),['0:m2:2']);
    }
  }
});

test('collision bounds enclose hull vertices without changing authored visual bounds',async()=>{
  const f=fixture(),makeModel=f.wasm.SceneModel.m2;
  f.wasm.SceneModel.m2=()=>{
    const model=makeModel();
    model.collision_vertices=()=>new Float32Array([-300,0,-20,500,0,0,0,700,2]);
    return model;
  };
  const stream=new SceneStream(f.source,f.wasm);
  const {value}=await stream.load({kind:'m2',path:'wide.m2',skins:[],score:0});
  assert.deepEqual(value.bounds,[[-1,-1,0],[1,1,2]]);
  assert.deepEqual(value.collisionBounds,[[-300,-1,-20],[500,700,2]]);
});

test('visual commits and material changes do not invalidate authoritative candidate selection',async()=>{
  const f=fixture({cutout:true}),stream=new SceneStream(f.source,f.wasm,{jobs:1});
  stream.asyncVisuals=true;stream.yieldVisual=async()=>{};
  stream.setTile('1:0:0',[p(1)]);stream.update(1,[0,0,0]);
  const before=stream.collisionRevision;
  await stream.pump(true);
  assert(stream.collisionRevision>before,'New geometry must invalidate collision immediately');
  stream.update(1,[0,0,0]);
  const geometry=stream.collisionRevision;
  await stream.prepareVisuals();
  assert.equal(stream.collisionRevision,geometry);
  assert.equal(stream.collisionSelectionRevision,geometry);
  await stream.pump(true);
  assert(stream.cache.has('texture:leaves.blp'));
  assert.equal(stream.collisionRevision,geometry);
  stream.evict('texture:leaves.blp');assert.equal(stream.collisionRevision,geometry);
  stream.evict('m2:tree.m2:[]');assert(stream.collisionRevision>geometry);
});

test('current required demand overrides a stale higher-ranked visual request',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm),key='m2:tree.m2:[]';
  stream.visualRequests=new Map([[key,{key,kind:'m2',score:0,collisionScore:0,distant:false}]]);
  stream.collisionRequests=new Map([[key,{key,kind:'m2',score:30,collisionScore:30,required:true,distant:false}]]);
  stream.mergeRequests();
  assert.equal(stream.requests.get(key).required,true);
  assert.equal(stream.foregroundKey,key);
});

test('a stationary near/far budget transition refreshes visual selection',async()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm,{instances:1});
  stream.asyncVisuals=true;stream.yieldVisual=async()=>{};
  stream.setTile('1:0:0',[p(1),p(2)]);stream.update(1,[0,0,0]);
  await stream.prepareVisuals();assert.equal(stream.instances.length,1);
  stream.limits.instances=2;await stream.prepareVisuals();assert.equal(stream.instances.length,2);
  assert.equal(stream.prepareVisuals(),undefined);
});

test('new distant placements do not build exact transforms on the collision path',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm);
  stream.asyncVisuals=true;stream.collisionReach=152;
  stream.setTile('1:0:0',Array.from({length:6400},(_,id)=>p(id,'tree.m2',600+id%100)));
  stream.cache.set('m2:tree.m2:[]',{value:{bounds:[[-1,-1,0],[1,1,2]]},bytes:0,used:0});
  let transforms=0;const original=stream.instanceBounds.bind(stream);
  stream.instanceBounds=(...args)=>{transforms++;return original(...args);};
  stream.update(1,[0,0,0]);
  assert.equal(transforms,0);
  assert.equal(stream.collisionCandidates.length,0);
});

test('indexed collision demand matches brute enumeration across scaled hulls, motion and support columns',()=>{
  const f=fixture(),indexed=new SceneStream(f.source,f.wasm),brute=new SceneStream(f.source,f.wasm);
  brute.collisionPlacements=function(map){
    return this.placementList(this.tiles,map).map(p=>({p,id:p.sceneId,matrix:p.matrix,kind:p.kind}));
  };
  const placements=Array.from({length:1200},(_,id)=>({...p(id,`tree${id%6}.m2`),
    position:[id%60*20-600,Math.floor(id/60)*40-400,id%71-35],rotation:[id%37,180,id%43],scale:1+id%4}));
  placements.push({...p(2000,'unknown.wmo',5000),kind:'wmo'});
  for(const s of [indexed,brute]){
    s.asyncVisuals=true;s.collisionReach=152;s.setTile('1:0:0',structuredClone(placements));
    for(let i=0;i<3;i++)s.cache.set(`m2:tree${i}.m2:[]`,{value:{
      bounds:[[-2,-2,0],[2,2,4]],collisionBounds:[[-20-i*250,-30,-50],[30,40+i*80,50]],
    },bytes:0,used:0});
  }
  for(let step=0;step<80;step++){
    const position=[step*13%900-450,step*71%700-350,20],predicted=[position[0]+180,position[1]-100,step%2?20:-Number.MAX_VALUE];
    for(const s of [indexed,brute])s.update(1,position,predicted,54,84);
    assert.deepEqual(indexed.collisionCandidates.map(i=>i.id),brute.collisionCandidates.map(i=>i.id));
    const required=s=>[...s.requests.values()].filter(r=>r.required).map(r=>r.key);
    assert.deepEqual(required(indexed),required(brute));
  }
  indexed.update(1,[0,0,0],[1e18,0,0]);
  brute.update(1,[0,0,0],[1e18,0,0]);
  assert.deepEqual(indexed.collisionCandidates.map(i=>i.id),brute.collisionCandidates.map(i=>i.id),
    'Unbounded cell ranges fall back to enumeration, not an unsafe grid loop');
});

test('collision index updates only changed placements and resources, including duplicate tile ownership',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm),key='m2:tree.m2:[]';
  stream.asyncVisuals=true;stream.collisionReach=152;
  stream.setTile('1:0:0',[p(1,'tree.m2',600),p(2,'other.m2',-600)]);
  stream.update(1,[0,0,0]);
  const index=stream.collisionIndex,first=index.rows.get('1:m2:1'),second=index.rows.get('1:m2:2');
  const cells=second.cells,stamp=index.stamp;
  stream.update(1,[1,0,0]);
  assert.equal(index.stamp,stamp,'Movement reuses metadata membership');
  assert.equal(index.rows.get('1:m2:1'),first);
  assert.equal(index.query([1,0,0],[1,0,0],152,32).length,0,'Distant M2s are not enumerated');
  stream.cache.set(key,{value:{bounds:[[-1,-1,0],[1,1,2]],collisionBounds:[[-1000,-1000,-20],[1000,1000,20]]},bytes:0,used:0});
  stream.collisionRevision++;
  stream.update(1,[1,0,0]);
  assert(stream.collisionCandidates.some(i=>i.id==='1:m2:1'),'Newly admitted large hull is considered immediately');
  assert(index.always.has(first),'Oversized bounds have bounded memberships');
  assert.equal(second.cells,cells,'Unchanged resources retain their existing cell memberships');
  stream.evict(key);stream.update(1,[1,0,0]);
  assert(!index.always.has(first));
  assert.equal(stream.collisionCandidates.length,0);
  stream.setTile('1:0:1',[p(1,'tree.m2',600)]);stream.update(1,[1,0,0]);
  assert.equal(index.rows.size,2,'Shared tile placements are indexed once');
  assert.equal(index.rows.get('1:m2:1'),first);
  stream.removeTile('1:0:0');stream.update(1,[1,0,0]);
  assert.equal(index.rows.size,1,'Remaining tile owns the duplicate');
  stream.removeTile('1:0:1');stream.update(1,[1,0,0]);
  assert.equal(index.rows.size,0);assert.equal(index.cells.size,0);assert.equal(index.resources.size,0);
  stream.setTile('0:0:0',[p(3)]);stream.update(0,[0,0,0]);
  assert.notEqual(stream.collisionIndex,index);
  assert.deepEqual(stream.collisionCandidates.map(i=>i.id),['0:m2:3']);
  stream.clear();assert.equal(stream.collisionIndex,undefined);
});

test('collision index never retains NPCs across population and neighborhood changes',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm);
  const pack={version:1,provenance:{source:'test',redistribution:'private-local-only'},
    models:{7:{path:'creature.m2',scale:1,skins:[]}},
    spawns:[{id:9,map:1,displayId:7,position:[0,0,0],orientation:0,scale:1}]};
  stream.asyncVisuals=true;stream.collisionReach=152;
  stream.setPopulation(pack);stream.update(1,[0,0,0]);
  assert.deepEqual(stream.collisionCandidates,[]);
  pack.models[7].skins=['replacement.blp'];
  stream.setPopulation(pack);stream.update(1,[0,0,0]);
  assert.deepEqual(stream.collisionCandidates,[]);
  stream.update(1,[9000,9000,0]);assert.equal(stream.collisionIndex.rows.size,0);
  stream.update(1,[0,0,0]);assert.equal(stream.collisionIndex.rows.size,0);
  stream.update(0,[0,0,0]);assert.equal(stream.collisionIndex.rows.size,0);
});

test('NPC visuals never create hulls, readiness waits or required requests, even with a shared static model',async()=>{
  for(const asyncVisuals of [false,true]){
    const f=fixture(),stream=new SceneStream(f.source,f.wasm);
    stream.asyncVisuals=asyncVisuals;
    stream.setPopulation({version:1,provenance:{source:'test',redistribution:'private-local-only'},
      models:{7:{path:'creature.m2',scale:1,skins:[]}},
      spawns:[{id:9,map:1,displayId:7,position:[0,0,0],orientation:0,scale:1}]});
    const update=async()=>{
      stream.update(1,[0,0,100],[0,0,-100],152,200);
      if(asyncVisuals)await stream.prepareVisuals();
    };
    await update();
    assert.deepEqual(stream.collisionCandidates,[]);
    assert.deepEqual(stream.snapshot().unresolvedCollision,[],'An unloaded NPC cannot block a support sweep');
    assert([...stream.requests.values()].every(r=>!r.required));
    await stream.pump();
    assert.equal(stream.snapshot().instances[0].id,'1:npc:9','The NPC still renders');
    assert.deepEqual(stream.snapshot().collisionInstances,[],'Loaded authored creature hulls are not submitted');
    stream.setTile('1:0:0',[p(1,'creature.m2')]);await update();await stream.pump();
    assert.deepEqual(stream.snapshot().collisionInstances.map(i=>i.id),['1:m2:1'],
      'An authored solid using the same model keeps collision');
    assert(stream.snapshot().instances.some(i=>i.id==='1:npc:9'));
  }
});

test('indexed WMO roots keep immediate groups without rebuilding distant doodad bounds',async()=>{
  const f=fixture();
  f.wasm.SceneRoot=class {
    metadata(){return JSON.stringify({groups:[{bounds:[[-2,-2,0],[2,2,5]]}],groupCount:1,
      doodads:Array.from({length:200},(_,i)=>({path:'chair.m2',position:[600+i,0,0],orientation:[0,0,0,1],scale:1})),
      sets:[{start:0,count:200}]});}
    group(){return f.wasm.SceneModel.m2();}
    free(){}
  };
  const stream=new SceneStream(f.source,f.wasm,{jobs:1});
  stream.asyncVisuals=true;stream.collisionReach=152;
  stream.setTile('1:0:0',[{...p(1,'inn.wmo'),kind:'wmo'}]);
  stream.update(1,[0,0,0]);await stream.pump(true);
  let points=0;const set=stream.pointBounds.set.bind(stream.pointBounds);
  stream.pointBounds.set=(...args)=>{points++;return set(...args);};
  stream.update(1,[0,0,0]);
  assert.equal(points,0,'Doodads bypass the raw-placement index, so retain their early broad rejection');
  assert(stream.requests.get('group:inn.wmo:0').required);
  assert(!stream.requests.has('m2:chair.m2:[]'));
  await stream.pump(true);stream.update(1,[0,0,0]);
  assert(stream.cache.has('group:inn.wmo:0'));
});

test('unknown placement bounds are reused without hiding later authored model bounds',async()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm);
  stream.setDistantTile('1:0:0',[p(1,'tree.m2',1400)]);
  stream.update(1,[0,0,0]);const point=stream.instances[0].bounds;
  stream.update(1,[1,0,0]);assert.equal(stream.instances[0].bounds,point);
  assert.equal(stream.instances[0].boundsKnown,false);
  await stream.pump();
  assert.notEqual(stream.instances[0].bounds,point);
  assert.equal(stream.instances[0].boundsKnown,true);
});
test('far model discovery leaves loading turns for the materials of already decoded scenery',async()=>{
  const f=fixture({cutout:true}),reads=[],stream=new SceneStream({
    read:async path=>{reads.push(path);return new Uint8Array([1]);},
  },f.wasm,{jobs:1});
  stream.visualOnly=true;
  const known=await stream.load({kind:'m2',path:'known.m2',skins:[],score:1200,distant:true});
  stream.cache.set('m2:known.m2:[]',{...known,used:0});stream.bytes=known.bytes;
  stream.setDistantTile('1:0:0',[p(1,'known.m2',1200),p(2,'new.m2',1000)]);
  stream.update(1,[0,0,0]);
  assert(stream.requests.get('texture:leaves.blp').visualRank<stream.requests.get('m2:new.m2:[]').visualRank,
    'Unknown model discovery must not push known foliage materials behind many structural instances');
  await stream.pump();
  assert.equal(reads.at(-1),'leaves.blp','Repeated unknown discovery must not starve visible alpha materials');
});
test('static instance reuse preserves near/far ownership and never duplicates collision',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm);
  stream.setTile('1:0:0',[p(1)]);
  stream.setDistantPlacements('1:0:0',stream.tiles.get('1:0:0'));
  stream.update(1,[0,0,0]);const instance=stream.instances[0];
  stream.update(1,[10,0,0]);
  assert.equal(stream.instances[0],instance);
  assert.equal(instance.distant,false);assert.equal(stream.instances.length,1);
  assert.equal(stream.collisionCandidates.length,1);
  stream.removeTile('1:0:0');stream.update(1,[10,0,0]);
  assert.equal(stream.instances[0],instance);
  assert.equal(instance.distant,true);assert.equal(stream.collisionCandidates.length,0);
});

test('placement indexing is reused while moving and invalidates on residency and map changes',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm);
  stream.setTile('1:0:0',[p(1),p(2)]);
  stream.setTile('1:1:0',[p(2),p(3)]);
  stream.update(1,[0,0,0]);
  const indexed=stream.placementList(stream.tiles,1);
  assert.deepEqual(indexed.map(p=>p.id),[1,2,3]);
  stream.update(1,[10,0,0]);assert.equal(stream.placementList(stream.tiles,1),indexed);
  stream.removeTile('1:0:0');stream.update(1,[10,0,0]);
  assert.deepEqual(stream.collisionCandidates.map(i=>i.id),['1:m2:2','1:m2:3']);
  stream.setTile('1:1:0',[{...p(4),identityMap:1,identityId:4,sceneId:'spoofed'}]);stream.update(1,[10,0,0]);
  assert.deepEqual(stream.collisionCandidates.map(i=>i.id),['1:m2:4']);
  stream.setTile('0:0:0',[p(5)]);stream.update(0,[0,0,0]);
  assert.deepEqual(stream.collisionCandidates.map(i=>i.id),['0:m2:5']);
  stream.setDistantTile('0:1:0',[]);stream.update(0,[0,0,0]);
  stream.setDistantPlacements('0:0:0',stream.tiles.get('0:0:0'));
  stream.removeTile('0:0:0');stream.update(0,[0,0,0]);
  assert.deepEqual(stream.instances.map(i=>[i.id,i.distant]),[['0:m2:5',true]]);
  assert.equal(stream.collisionCandidates.length,0);
  stream.clear();assert.equal(stream.placementLists.size,0);
});

test('resident ADT metadata reuses the parsed tile but retains placement validation',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm);
  f.wasm.scene_placements=()=>{throw Error('Unexpected second ADT parse');};
  stream.setTile('1:0:0',new Uint8Array(),JSON.stringify([p(1)]));
  assert.equal(stream.tiles.get('1:0:0')[0].path,'tree.m2');
  assert.throws(()=>stream.setTile('1:0:0',new Uint8Array(),JSON.stringify([{...p(2),scale:NaN}])),/Invalid scene placement/);
  assert.equal(stream.tiles.get('1:0:0')[0].id,1,'Invalid metadata cannot replace the resident placements');
});

test('live readiness demand survives the visual cap behind and across the predicted direction',async()=>{
  for(const [position,predicted,vertical=54] of [[[-40,0,0],[500,0,0]],[[0,40,0],[500,0,0]],
    [[10,0,100],[500,0,0],120]]) {
    const f=fixture(),stream=new SceneStream(f.source,f.wasm);
    const placements=Array.from({length:1024},(_,id)=>p(id,'near.m2',1));
    placements.push({...p(2000,'needed.m2'),position});
    placements.push({...p(2001,'outside.m2'),position:[100,0,200]});
    stream.setTile('1:0:0',placements);
    const key=stream.tiles.get('1:0:0')[0].key;
    stream.cache.set(key,{value:{vertices:new Float32Array(),indices:new Uint32Array(),batches:[],
      bounds:[[-1,-1,-1],[1,1,1]]},bytes:0,used:0});
    stream.update(1,[0,0,0],predicted,54,vertical);
    assert.equal(stream.instances.length,1024);
    assert(stream.snapshot().unresolvedCollision.some(i=>i.id==='1:m2:2000'));
    assert([...stream.requests.values()].some(r=>r.path==='needed.m2'));
    assert(![...stream.requests.values()].some(r=>r.path==='outside.m2'));
    await stream.pump();
    assert.equal(stream.collisionRadius,54);
    assert.equal(stream.collisionVerticalRadius,vertical);
    assert.equal(stream.snapshot().unresolvedCollision.some(i=>i.id==='1:m2:2000'),false);
    assert(f.reads()>0);
  }
});

test('ADT rotations preserve source axes, tilted scale, bounds and translation', () => {
  const identity = placementMatrix(p(1));
  assert.deepEqual(transformPoint(identity, [1, 2, 3]).map(v => Math.round(v)), [1, 2, 3]);
  const heading = placementMatrix({ ...p(1), rotation: [0, 270, 0] });
  const point = transformPoint(heading, [1, 0, 0]);
  assert.ok(Math.abs(point[0]) < 1e-10 && Math.abs(point[1] - 1) < 1e-10);
  const tilted = placementMatrix({ ...p(1), rotation: [32, 73, -24], scale: 2, position: [20, -9, 7] });
  const delta = transformPoint(tilted, [1, 2, 3]).map((v, i) => v - [20, -9, 7][i]);
  assert.ok(Math.abs(Math.hypot(...delta) - Math.sqrt(14) * 2) < 1e-9);
  assert.deepEqual(transformedBounds([[-1, -2, -3], [1, 2, 3]], identity), [[-1, -2, -3], [1, 2, 3]]);
  assert.throws(() => placementMatrix({ ...p(1), scale: NaN }));
  assert.throws(() => modelPath('..\\secret'));
  assert.equal(modelPath('WORLD/Tree.MDX'), 'world\\tree.m2');
});

test('scalar transforms retain exact matrix products and every AABB corner',()=>{
  const referenceProduct=(a,b)=>Array.from({length:16},(_,k)=>{
    const row=k%4,col=Math.floor(k/4);
    return a[row]*b[col*4]+a[row+4]*b[col*4+1]+a[row+8]*b[col*4+2]+a[row+12]*b[col*4+3];
  });
  for(let i=0;i<128;i++){
    const a=placementMatrix({...p(i),rotation:[i*13,i*37,-i*19],scale:.1+i*.7,
      position:[Math.sin(i)*100000,Math.cos(i)*100000,i]}),
      b=placementMatrix({...p(i),rotation:[-i*11,i*29,i*7],scale:1+i*.1});
    assert.deepEqual(multiply(a,b),referenceProduct(a,b));
    for(const bounds of [[[-1,-2,-3],[4,5,6]],[[0,0,0],[0,0,0]],[[-1e100,-1,0],[1e100,1,0]]]){
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      for(let corner=0;corner<8;corner++){
        const point=transformPoint(a,[0,1,2].map(k=>bounds[(corner>>k)&1][k]));
        point.forEach((v,k)=>{min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v);});
      }
      assert.deepEqual(transformedBounds(bounds,a),[min,max]);
    }
  }
});

test('restore support columns retain lower collision beyond the visual radius without loading unrelated scenery',async()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm);
  stream.setTile('1:0:0',[p(1,'deck.m2'),p(2,'outside.m2',100)]);
  stream.update(1,[0,0,2000],[0,0,-Number.MAX_VALUE],32);
  assert([...stream.requests.values()].some(r=>r.path==='deck.m2'));
  assert(![...stream.requests.values()].some(r=>r.path==='outside.m2'));
  await stream.pump();
  assert.equal(stream.snapshot().unresolvedCollision.length,0);
  assert(stream.snapshot().collisionInstances.some(i=>i.id==='1:m2:1'));
  stream.setTile('1:0:0',[p(3,'far-ahead.m2',2000)]);
  stream.update(1,[0,0,0],[2000,0,0],32);
  assert(![...stream.requests.values()].some(r=>r.path==='far-ahead.m2'),'Ordinary forward prediction keeps its visual coverage cap');
});

test('scalar bounds distance preserves point and swept-box distances on every axis', () => {
  const bounds = [[-2, -3, -4], [5, 6, 7]];
  const points = [[0, 0, 0], [-2, -3, -4], [5, 6, 7], [9, -8, 12], [-9, 8, -12], [1e200, -1e200, 1e200]];
  for (const start of points) {
    assert.equal(boundsDistance(bounds, start),
      Math.hypot(...start.map((v, a) => Math.max(bounds[0][a] - v, 0, v - bounds[1][a]))));
    for (const end of points) {
      const low = start.map((v, a) => Math.min(v, end[a])), high = start.map((v, a) => Math.max(v, end[a]));
      assert.equal(boundsDistance(bounds, low, high), Math.hypot(...start.map((v, a) =>
        Math.max(bounds[0][a] - Math.max(v, end[a]), 0, Math.min(v, end[a]) - bounds[1][a]))));
    }
  }
});

test('axis rejection preserves exact spherical bounds thresholds, including corners and large coordinates', () => {
  const bounds = [[-2, -3, -4], [5, 6, 7]];
  const points = [[0,0,0], [8,10,7], [-5,-7,-4], [89,6,7], [5,90,7], [5,6,91], [1e200,-1e200,1e200]];
  for (let i=0;i<1000;i++) points.push([Math.sin(i)*100,Math.cos(i*3)*100,Math.sin(i*7)*100]);
  for (const p of points) {
    const d = boundsDistance(bounds,p);
    for (const radius of [0,4,5,32,84,850,d,d*(1-Number.EPSILON),d*(1+Number.EPSILON),1e201])
      assert.equal(boundsWithin(bounds,p,radius),d<radius,`${p} at radius ${radius}`);
  }
});

test('indexed collision vertices retain transformed tilt, scale and translated world precision', () => {
  const region = {placement: [1e6, -2e6], tile_origin: [12, 23]};
  const matrix = placementMatrix({...p(1), rotation: [24,73,-31], scale: 2.5, position: [4321,-987,12]});
  const local = new Float32Array([1,2,3,-4,7,11]);
  const actual = globalCollisionVertices(local,matrix,region);
  for(let i=0;i<local.length;i+=3) {
    const source = transformPoint(matrix,Array.from(local.slice(i,i+3)));
    const expected = [-source[1]+region.placement[0]+(32-12)*1600/3,source[2],
      -source[0]+region.placement[1]+(32-23)*1600/3];
    expected.forEach((v,a)=>assert(Math.abs(actual[i+a]-v)<1e-8));
  }
  assert(actual instanceof Float64Array);
});

test('adjacent ADT duplicates share geometry, bounded jobs and caches evict old demand', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, { assets: 2, jobs: 1 });
  stream.setTile('1:0:0', [p(1), p(2)]);
  stream.setTile('1:1:0', [p(1)]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(f.reads(), 1); assert.equal(f.freed(), 1);
  assert.equal(stream.snapshot().instances.length, 2);
  assert.equal(stream.snapshot().assets.size, 1);
  stream.removeTile('1:0:0'); stream.removeTile('1:1:0');
  stream.setTile('1:3:0', [p(3, 'other.m2'), p(4, 'third.m2')]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(f.reads(), 2);
  await stream.pump();
  assert.equal(stream.snapshot().cachedAssets, 2);
  assert.ok(stream.snapshot().cachedBytes < stream.limits.bytes);
  assert.ok(!stream.cache.has('m2:tree.m2:[]'));
  stream.update(0, [0, 0, 0]);
  assert.equal(stream.snapshot().instances.length, 0);
  stream.clear(); assert.equal(stream.bytes, 0);
});

test('actual alpha texture gates leaf cards and missing/corrupt are distinct', async () => {
  const f = fixture({ cutout: true }), stream = new SceneStream(f.source, f.wasm, { jobs: 1 });
  stream.setTile('1:0:0', [p(1)]); stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances.length, 0);
  assert.equal(stream.snapshot().collisionInstances.length, 1);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
  assert.equal(stream.snapshot().assets.size, 1);
  await stream.pump();
  assert.equal(stream.snapshot().instances.length, 1);
  assert.equal(stream.snapshot().textures.get('leaves.blp').rgba[3], 0);
  for (const code of ['NOT_FOUND', 'CORRUPT']) {
    const broken = new SceneStream({ read: async () => { throw Object.assign(new Error('asset failed'), { code }); } }, f.wasm);
    broken.setTile('1:0:0', [p(1)]); broken.update(1, [0, 0, 0]); await broken.pump();
    assert.equal(broken.snapshot().errors[0].code, code);
    assert.equal(broken.snapshot().instances.length, 0);
    assert.equal(broken.snapshot().unresolvedCollision[0].status, code);
    assert.equal(broken.snapshot().unresolvedCollision[0].boundsKnown, false);
  }
});

test('shared near/far metadata does not rebuild admitted near models or omit far-only models', () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm);
  const placements = [p(1, 'near.m2'), p(2, 'far.m2', 1000)];
  stream.setTile('1:0:0', placements);
  stream.setDistantTile('1:0:0', placements);
  const lookups = new Map(), get = stream.cache.get.bind(stream.cache);
  stream.cache.get = key => {
    lookups.set(key, (lookups.get(key) || 0) + 1);
    return get(key);
  };
  stream.update(1, [0, 0, 0]);
  assert.deepEqual(stream.instances.map(i => [i.id, i.distant]), [['1:m2:1', false], ['1:m2:2', true]]);
  assert.deepEqual(stream.collisionCandidates.map(i => i.id), ['1:m2:1']);
  assert.equal(lookups.get('m2:near.m2:[]'), 2, 'One admission and one material dependency lookup');
  assert.equal(stream.requests.get('m2:near.m2:[]').distant, false);
  assert.equal(stream.requests.get('m2:far.m2:[]').distant, true);
});

test('material paths normalize at decode and invalid paths remain explicit failed collision resources', async () => {
  const f = fixture({cutout: true, texture: 'World/Leaves.BLP'});
  const stream = new SceneStream(f.source, f.wasm, {jobs: 1});
  stream.setTile('1:0:0', [p(1)]); stream.update(1, [0, 0, 0]);
  await stream.pump();
  assert.equal(stream.snapshot().assets.get('m2:tree.m2:[]').batches[0].texture, 'world\\leaves.blp');
  await stream.pump();
  assert.equal(stream.snapshot().instances.length, 1);
  assert(stream.snapshot().textures.has('world\\leaves.blp'));
  const broken = fixture({cutout: true, texture: '..\\secret.blp'});
  const invalid = new SceneStream(broken.source, broken.wasm, {jobs: 1});
  invalid.setTile('1:0:0', [p(1)]); invalid.update(1, [0, 0, 0]);
  await invalid.pump();
  assert.match(invalid.snapshot().errors[0].message, /Invalid scene path/);
  assert.equal(invalid.snapshot().unresolvedCollision[0].status, 'CORRUPT');
  assert.equal(broken.freed(), 1);
});

test('full visual selection reserves far silhouettes without reordering or capping collision candidates', () => {
  for (const nearCount of [1, 3, 5]) {
    const f = fixture(), all = new SceneStream(f.source, f.wasm);
    const bounded = new SceneStream(f.source, f.wasm, {instances: 3});
    const near = Array.from({length: nearCount}, (_, i) => p(10 - i, 'near.m2', (i % 2) * 20));
    const far = Array.from({length: 20}, (_, i) => p(100 - i, 'far.m2', 1000 + (i % 3) * 10));
    for (const stream of [all, bounded]) {
      stream.setTile('1:0:0', near);
      stream.setDistantTile('1:1:0', far);
      stream.update(1, [0, 0, 0]);
    }
    const nearVisible=Math.min(nearCount,2);
    assert.deepEqual(bounded.instances,[...all.instances.filter(i=>!i.distant).slice(0,nearVisible),
      ...all.instances.filter(i=>i.distant).slice(0,3-nearVisible)]);
    assert.deepEqual(bounded.collisionCandidates, all.collisionCandidates);
    assert.deepEqual(bounded.collisionCandidates.map(i => i.id), near.map(i => `1:m2:${i.id}`));
  }
});

test('large authored silhouettes outrank smaller middle-distance clutter without losing collision demand',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm,{instances:3});
  stream.setTile('1:0:0',[p(1,'close.m2',20),p(2,'chair.m2',200),p(3,'building.m2',600)]);
  for(const entry of stream.tiles.get('1:0:0')){
    const size=entry.id===3?100:1;
    stream.cache.set(entry.key,{value:{bounds:[[-size,-size,0],[size,size,size]],batches:[]},bytes:0,used:0});
  }
  stream.setDistantTile('1:1:0',[p(4,'far.m2',1400)]);
  stream.update(1,[0,0,0]);
  assert.deepEqual(stream.instances.map(i=>i.id),['1:m2:1','1:m2:3','1:m2:4']);
  assert.deepEqual(stream.collisionCandidates.map(i=>i.id),['1:m2:1','1:m2:2','1:m2:3']);
});

test('distant trees and building structures share visual slots and admission order',()=>{
  const f=fixture(),stream=new SceneStream(f.source,f.wasm,{instances:8});
  stream.setTile('1:0:0',[p(1)]);
  stream.setDistantTile('1:1:0',Array.from({length:8},(_,i)=>[
    p(10+i,`tree${i}.m2`,1400+i*10),
    {...p(30+i,`building${i}.wmo`,2000+i*10),kind:'wmo',bounds:[[1800,-100,0],[2200,100,200]]},
  ]).flat());
  stream.update(1,[0,0,0]);
  assert.deepEqual(stream.instances.filter(i=>i.distant).map(i=>i.kind),
    ['wmo','m2','wmo','m2','wmo','m2','wmo']);
  stream.instances.forEach((i,rank)=>assert.equal(stream.requests.get(i.key).visualRank,rank));
  assert.equal(stream.collisionCandidates.length,1);
});

test('predicted swept-path solids precede current textures without waiting for their I/O', async () => {
  const f = fixture({cutout: true}), reads = [];
  let finishTexture;
  const source = {read: async path => {
    reads.push(path);
    if(path === 'leaves.blp') return new Promise(resolve => { finishTexture = resolve; });
    return new Uint8Array([1]);
  }};
  const stream = new SceneStream(source, f.wasm, {jobs: 1});
  stream.setTile('1:0:0', [p(1), p(2, 'ahead.m2', 80)]);
  stream.update(1, [0,0,0], [90,0,0]);
  await stream.pump();
  await stream.pump();
  assert.deepEqual(reads, ['tree.m2', 'ahead.m2']);
  const pending = stream.pump();
  stream.update(1, [5,0,0], [95,0,0]);
  assert.equal(stream.snapshot().collisionInstances.length, 2);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
  assert.equal(stream.snapshot().instances.length, 0);
  finishTexture(new Uint8Array([1])); await pending;
  assert.equal(stream.snapshot().instances.length, 2);
});

test('visual instance cap cannot hide missing nearby collision', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, {instances: 1, jobs: 1});
  stream.setTile('1:0:0', [p(1), p(2, 'wall.m2', 1)]);
  stream.update(1, [0,0,0]);
  await stream.pump();
  assert.equal(stream.snapshot().instances.length, 1);
  assert.equal(stream.snapshot().unresolvedCollision.length, 1);
  await stream.pump();
  assert.equal(stream.snapshot().collisionInstances.length, 2);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
  assert.equal(stream.snapshot().instances.length, 1);
});

test('completed model jobs rebuild selection once, retaining a fresh revision', async () => {
  const f = fixture(), stream = new SceneStream(f.source,f.wasm);
  stream.setTile('1:0:0',[p(1),p(2,'other.m2',2)]);
  stream.update(1,[0,0,0]);
  let updates = 0;
  const update = stream.update.bind(stream);
  stream.update = (...args) => {updates++; return update(...args);};
  await stream.pump();
  assert.equal(updates,1);
  assert.equal(stream.snapshot().collisionInstances.length,2);
  assert.equal(stream.selectionRevision,stream.revision);
});

test('deferred visual dependency refresh never delays a decoded collision mesh', async () => {
  const f = fixture({cutout:true}), stream = new SceneStream(f.source,f.wasm,{jobs:1});
  stream.setTile('1:0:0',[p(1)]);stream.update(1,[0,0,0]);
  await stream.pump(true);
  assert.equal(stream.snapshot().collisionInstances.length,1);
  assert.equal(stream.snapshot().unresolvedCollision.length,0);
  assert.equal(stream.snapshot().instances.length,0);
  assert.notEqual(stream.selectionRevision,stream.revision);
  stream.update(1,[0,0,0]);await stream.pump(true);
  assert.equal(stream.snapshot().instances.length,1);
});

test('late asynchronous completion cannot repopulate a cleared world', async () => {
  const f = fixture(); let resolve;
  const stream = new SceneStream({ read: () => new Promise(r => { resolve = r; }) }, f.wasm);
  stream.setTile('1:0:0', [p(1)]); stream.update(1, [0, 0, 0]);
  const pump = stream.pump(); stream.clear(); resolve(new Uint8Array([1])); await pump;
  assert.equal(stream.snapshot().cachedAssets, 0);
});

test('private NPC provenance, corruption and bounded local residency', async () => {
  assert.throws(() => validatePopulation(null));
  const pack = { version: 1, provenance: { source: 'synthetic-test-only', redistribution: 'private-local-only' },
    models: { 7: { path: 'creature.m2', scale: 1, skins: [] } },
    spawns: [{ id: 9, map: 1, displayId: 7, position: [0, 0, 0], orientation: 0, scale: 1 }] };
  const f = fixture(), stream = new SceneStream(f.source, f.wasm);
  stream.setPopulation(pack); stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances[0].id, '1:npc:9');
  const matrix=stream.snapshot().instances[0].matrix;
  stream.update(1,[1,0,0]);
  assert.equal(stream.snapshot().instances[0].matrix,matrix,'Static spawn transforms retain the bounds cache');
  stream.setPopulation({...pack,spawns:[{...pack.spawns[0],position:[2,0,0]}]});
  stream.update(1,[1,0,0]);
  assert.notEqual(stream.snapshot().instances[0].matrix,matrix);
  assert.deepEqual(stream.snapshot().instances[0].matrix.slice(12,15),[2,0,0]);
  pack.models[7].skins=['replacement.blp'];
  stream.setPopulation(pack);stream.update(1,[0,0,0]);
  assert.equal(stream.instances[0].key,'m2:creature.m2:["replacement.blp"]');
  await stream.pump();
  assert.equal(stream.snapshot().instances[0].key,'m2:creature.m2:["replacement.blp"]');
  stream.update(1, [9000, 9000, 0]);
  assert.equal(stream.snapshot().instances.length, 0);
  assert.throws(() => validatePopulation({ ...pack, spawns: [...pack.spawns, ...pack.spawns] }));
  assert.throws(() => validatePopulation({ ...pack, provenance: {} }));
});

test('WMO groups and selected child doodads load as separate jobs', async () => {
  const f = fixture();
  const rootMetadata = { groupCount: 1, groups: [{ bounds: [[-2, -2, 0], [2, 2, 5]] }],
    doodads: [{ path: 'chair.mdx', position: [1, 0, 0], orientation: [0, 0, 0, 1], scale: 1 }],
    sets: [{ start: 0, count: 1 }] };
  f.wasm.SceneRoot = class {
    metadata() { return JSON.stringify(rootMetadata); }
    group() { return f.wasm.SceneModel.m2(); }
    free() {}
  };
  const stream = new SceneStream(f.source, f.wasm, { jobs: 1 });
  stream.setTile('0:0:0', [{ ...p(7, 'inn.wmo'), kind: 'wmo' }]);
  stream.update(0, [0, 0, 0]); await stream.pump();
  assert.equal(f.reads(), 1);
  assert.equal(stream.snapshot().instances.length, 0);
  const unresolvedGroup = stream.snapshot().unresolvedCollision.find(i => i.kind === 'group');
  assert.equal(unresolvedGroup.boundsKnown, true);
  assert.deepEqual(unresolvedGroup.bounds, [[-2, -2, 0], [2, 2, 5]]);
  await stream.pump(); await stream.pump();
  assert.equal(f.reads(), 3);
  const snapshot = stream.snapshot();
  assert.equal(snapshot.instances.length, 2);
  assert.ok(snapshot.instances.some(i => i.id === '0:wmo:7:group:0'));
  const chair = snapshot.instances.find(i => i.id === '0:wmo:7:doodad:0');
  assert.deepEqual(chair.matrix.slice(12, 15), [1, 0, 0]);
  stream.update(0, [1,0,0]);
  assert.equal(stream.snapshot().instances.find(i=>i.id===chair.id).matrix,chair.matrix,
    'Static WMO child transform should be reused while the observer moves');
  stream.tiles.get('0:0:0')[0].id=8;
  stream.update(0,[1,0,0]);
  assert.deepEqual(stream.snapshot().instances.map(i=>i.id).sort(),['0:wmo:8:doodad:0','0:wmo:8:group:0'],
    'A reused matrix must not retain child IDs from a different WMO instance');
  stream.setDistantTile('0:0:0',[{...p(8,'inn.wmo'),kind:'wmo'}]);
  stream.removeTile('0:0:0');stream.update(0,[0,0,0]);
  assert.deepEqual(stream.snapshot().instances.map(i=>i.id),['0:wmo:8:group:0']);
  assert.equal(stream.snapshot().collisionInstances.length,0);
  stream.setTile('0:0:0',[{...p(8,'inn.wmo'),kind:'wmo'}]);stream.update(0,[0,0,0]);
  assert.deepEqual(stream.snapshot().instances.map(i=>i.id).sort(),['0:wmo:8:doodad:0','0:wmo:8:group:0'],
    'Approaching retains the same structural asset and restores detailed props and collision');
});

test('pinned cache limit does not reread resources endlessly and ninth tile is rejected', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, { assets: 1 });
  for (let i = 0; i < 8; i++) stream.setTile(`1:${i}:0`, [p(i, `tree${i}.m2`)]);
  assert.throws(() => stream.setTile('1:8:0', []), /near-tile budget/);
  stream.update(1, [0, 0, 0]); await stream.pump(); await stream.pump();
  assert.equal(f.reads(), 1);
  assert.equal(stream.snapshot().capacityBlocked, true);
  assert.equal(stream.snapshot().cachedAssets, 1);
});

test('nearer moving demand displaces a still-visible distant cached model', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, { assets: 1 });
  stream.setTile('1:0:0', [p(1, 'near.m2', 0), p(2, 'far.m2', 500)]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances[0].id, '1:m2:1');
  stream.update(1, [500, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances[0].id, '1:m2:2');
  assert.equal(stream.snapshot().cachedAssets, 1);
  assert.equal(f.reads(), 2);
});

test('texture dependencies have separate bounded slots and cannot evict their geometry owner', async () => {
  const f = fixture({ cutout: true }), stream = new SceneStream(f.source, f.wasm, { assets: 1, textures: 1 });
  stream.setTile('1:0:0', [p(1)]); stream.update(1, [0, 0, 0]);
  await stream.pump(); await stream.pump();
  const snapshot = stream.snapshot();
  assert.equal(snapshot.instances.length, 1);
  assert.equal(snapshot.cachedModels, 1);
  assert.equal(snapshot.cachedTextures, 1);
  assert.equal(f.reads(), 2);
  assert.equal(snapshot.pending, 0);
});

test('unresolved solids inside 32 yards precede texture jobs without prioritizing far solids', async () => {
  const f = fixture({ cutout: true }), reads = [];
  const stream = new SceneStream({ read: async path => { reads.push(path); return f.source.read(path); } }, f.wasm, { jobs: 1 });
  stream.setTile('1:0:0', [p(1, 'a.m2'), p(2, 'b.m2', 20), p(3, 'c.m2', 100)]);
  stream.update(1, [0, 0, 0]);
  await stream.pump(); await stream.pump();
  assert.deepEqual(reads, ['a.m2', 'b.m2']);
  assert.equal(stream.snapshot().collisionInstances.length, 2);
  assert.equal(stream.snapshot().instances.length, 0);
  await stream.pump();
  assert.equal(reads[2], 'leaves.blp');
  assert.equal(stream.snapshot().instances.length, 2);
  await stream.pump();
  assert.equal(reads[3], 'c.m2');
});

test('unloaded WMO roots retain authored world bounds even with distant placement origins', () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm);
  const bounds = [[200, -10, -5], [250, 10, 20]];
  stream.setTile('1:0:0', [{ ...p(1, 'hut.wmo', 550), kind: 'wmo', bounds }]);
  stream.update(1, [0, 0, 0]);
  const root = stream.snapshot().unresolvedCollision[0];
  assert.equal(root.boundsKnown, true);
  assert.deepEqual(root.bounds, bounds);
  assert.equal(stream.instances[0].score, 200);
});

test('distant metadata shares assets, preserves near copies and never claims collision residency', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm);
  stream.setTile('1:0:0', [p(1)]);
  stream.setDistantTile('1:0:0', [p(1), p(2, 'tree.mdx', 1400)]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  const snapshot = stream.snapshot();
  assert.equal(snapshot.instances.length, 2);
  assert.equal(snapshot.assets.size, 1);
  assert.equal(snapshot.instances.find(i => i.id === '1:m2:1').distant, false);
  assert.equal(snapshot.instances.find(i => i.id === '1:m2:2').distant, true);
  assert.deepEqual(snapshot.collisionInstances.map(i => i.id), ['1:m2:1']);
  assert.equal(snapshot.unresolvedCollision.length, 0);
  stream.removeTile('1:0:0'); stream.update(1, [0, 0, 0]);
  assert.equal(stream.snapshot().collisionInstances.length, 0);
  for (let i = 1; i < 24; i++) stream.setDistantTile(`1:${i}:0`, []);
  assert.throws(() => stream.setDistantTile('1:24:0', []), /distant-tile budget/);
  assert.equal(stream.tiles.size, 0);
  stream.clear(); assert.equal(stream.distantTiles.size, 0);
});

test('far visual requests never delay nearer collision or texture work', async () => {
  const f = fixture({ cutout: true }), reads = [];
  const stream = new SceneStream({ read: async path => { reads.push(path); return f.source.read(path); } }, f.wasm, { jobs: 1 });
  stream.setTile('1:0:0', [p(1, 'near.m2', 40)]);
  stream.setDistantTile('1:1:0', [p(2, 'far.m2', 1400)]);
  stream.update(1, [0, 0, 0]); await stream.pump(); await stream.pump(); await stream.pump();
  assert.deepEqual(reads, ['near.m2', 'leaves.blp', 'far.m2']);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
});

test('far silhouettes load before noncritical middle-distance props, but never required collision',async()=>{
  const f=fixture(),reads=[];
  const stream=new SceneStream({read:async(path,options)=>{
    reads.push({path,background:options.background});return f.source.read(path);
  }},f.wasm,{jobs:1});
  stream.setTile('1:0:0',[p(1,'required.m2',80),p(2,'middle.m2',600)]);
  stream.setDistantTile('1:1:0',[p(3,'far.m2',1400)]);
  stream.update(1,[0,0,0],[0,0,0],100,100);
  for(let i=0;i<3;i++)await stream.pump();
  assert.deepEqual(reads,[{path:'required.m2',background:false},{path:'far.m2',background:true},
    {path:'middle.m2',background:true}]);
  assert.equal(stream.snapshot().unresolvedCollision.length,0);
});

test('silhouette material admission follows visual prominence rather than filling slots with closer clutter',async()=>{
  const f=fixture({cutout:true}),reads=[];
  const stream=new SceneStream({read:async(path)=>{reads.push(path);return f.source.read(path);}},f.wasm,{jobs:1});
  stream.setDistantTile('1:0:0',[p(1,'clutter.m2',1000),
    {...p(2,'building.m2',1600),bounds:[[1400,-100,0],[1800,100,200]]}]);
  stream.update(1,[0,0,0]);
  for(let i=0;i<3;i++)await stream.pump();
  assert.deepEqual(reads,['building.m2','leaves.blp','clutter.m2']);
});

test('near building metadata is discovered before distant visual assets, without preloading its groups',async()=>{
  const f=fixture(),reads=[];
  f.wasm.SceneRoot=class{
    metadata(){return JSON.stringify({groupCount:1,groups:[{bounds:[[-5,-5,0],[5,5,10]]}],sets:[],doodads:[]});}
    free(){}
  };
  const stream=new SceneStream({read:async path=>{reads.push(path);return new Uint8Array(1);}},f.wasm,{jobs:1});
  stream.setTile('1:0:0',[{...p(1,'hut.wmo',450),kind:'wmo'}]);
  stream.setDistantTile('1:1:0',[p(2,'far-tree.m2',1400)]);
  stream.update(1,[0,0,0]);await stream.pump();await stream.pump();
  assert.deepEqual(reads,['hut.wmo','far-tree.m2']);
  assert(!stream.cache.has('group:hut.wmo:0'));
});

test('new required collision preempts an already-started optional model extraction',async()=>{
  const f=fixture(),reads=[];let resume,optional;
  const stream=new SceneStream({read:async(path,options)=>{
    reads.push(path);
    if(reads.length===1){
      optional=options;await new Promise(resolve=>{resume=resolve;});
      if(options.shouldDefer())throw Object.assign(Error('urgent scene demand'),{code:'DEFERRED'});
    }
    return new Uint8Array(1);
  }},f.wasm);
  stream.setDistantTile('1:1:0',[p(1,'far.m2',1400)]);stream.update(1,[0,0,0]);
  const pending=stream.pump();
  assert.equal(optional.shouldDefer(),false);
  stream.setTile('1:0:0',[p(2,'fence.m2',10)]);stream.update(1,[0,0,0]);
  assert.equal(optional.shouldDefer(),true);
  resume();await pending;await stream.pump();
  assert.deepEqual(reads,['far.m2','fence.m2','far.m2']);
  assert.equal(stream.snapshot().unresolvedCollision.length,0);
  assert.deepEqual(stream.snapshot().errors,[]);
});

test('optional scene extraction deferral is retryable rather than a corrupt resource',async()=>{
  const f=fixture();let defer=true;
  const stream=new SceneStream({read:async()=>{
    if(defer)throw Object.assign(Error('foreground queued'),{code:'DEFERRED'});
    return new Uint8Array(1);
  }},f.wasm);
  stream.setDistantTile('1:0:0',[p(1,'far.m2',1400)]);
  stream.update(1,[0,0,0]);await stream.pump();
  assert.deepEqual(stream.snapshot().errors,[]);assert.equal(stream.snapshot().pending,1);
  defer=false;await stream.pump();assert.equal(stream.snapshot().instances.length,1);
});
