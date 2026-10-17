import init,{Voyage,world_manifest} from './pkg/flats_racer_web.js';
import * as wasmTypes from './pkg/flats_racer_web.js';
import {openDataSource} from './asset-source.js';
import {SceneStream,SCENE_LIMITS,transformedBounds,globalCollisionVertices,boundsWithin} from './scene-stream.js';
import {TerrainStream} from './terrain-stream.js';
import {loadCraft} from './craft-stream.js';

const TILE=1600/3,LIMIT=4;
let wasm;
const ready=init().then(exports=>(wasm=exports));
let world,source,manifest,placements,scene,terrain,accumulator=0,queue=Promise.resolve();
let poseTime;
const terrainErrors=new Map();
let terrainFocus='';
let craft={ready:false,pending:false};
function startCraft() {
  if(craft.ready || craft.pending || craft.error)return;
  craft.pending=true;
  void loadCraft(source,wasmTypes,(message,transfers)=>postMessage(message,transfers))
    .then(result=>{craft={...result,pending:false};})
    .catch(error=>{craft={ready:false,pending:false,error:`Authored craft: ${error.message || error}`};});
}
let resident=new Set(),failures=new Map(),loads=0,evictions=0,peak=0,horizon;
let terrainRead;
const terrainMaterials=new Set();
let materialFrameReady=false,materialTimer,materialTimerToken=0,materialGeneration=0;
let sentAssets=new Set(),sentTextures=new Set(),sceneState,sceneSignature='';
let sentInstances=new Map();
let sentSceneRegion;
let sceneInstanceDeltas=false;
let sceneInstanceUpdates=false;
let postFrameVisuals=false,sceneRegion,frameWorkMs=0;
let sceneFocus,sceneUpdated=0,sceneRevision=-1;
let sceneSubmissionPending=true;
let scenePumpError;
const collisionBounds=new Map();
let collisionCount=0;
let collisionSignature='';
let collisionToken=0,collisionParts=new Set();
let collisionFocus;
const collisionInstances=new Map();
const timings={frames:0,totalMs:0,maxMs:0,terrainMs:0,sceneMs:0,selectionMs:0,snapshotMs:0,
  physicsMs:0,cameraUnknownMs:0,postMs:0,postFrameMs:0,scenePostMs:0,scenePosts:0,sceneInstancePosts:0,collisionBuildMs:0,collisionBuilds:0};
let distantWanted=[],distantJob,distantLastStart=0,distantLoads=0,distantPeak=0;
const distantResident=new Set(),distantFailures=new Map();
let objectWait=[],cameraUnknown=[],lastHoldTime=0,lastHold='clear',holdRun=0;
const holds=Object.fromEntries(['terrain','objects','solid','unsupported'].map(key=>[key,{episodes:0,ms:0,maxMs:0}]));
function measureHold(kind,elapsed) {
  if(kind==='clear'){lastHold=kind;holdRun=0;return;}
  const counter=holds[kind];
  if(lastHold!==kind){counter.episodes++;holdRun=0;}
  counter.ms+=elapsed;holdRun+=elapsed;counter.maxMs=Math.max(counter.maxMs,holdRun);lastHold=kind;
}
const report=text=>postMessage({event:'progress',text});
const assetPath=t=>`World\\Maps\\${manifest.regions[t.region].map}\\${t.file}`;
function distance(index,p) {
  const a=placements[index];
  return Math.hypot(Math.max(a[0]-p[0],0,p[0]-a[0]-TILE),Math.max(a[1]-p[1],0,p[1]-a[1]-TILE));
}
function tileKey(index) {
  const t=manifest.tiles[index];
  return `${t.region===0?1:0}:${t.x}:${t.y}`;
}
function prepareDistant(focus,enabled) {
  const region=focusRegion(focus),p=[focus[0],focus[2]];
  const r=manifest.regions[region],x=Math.floor((p[0]-r.placement[0])/TILE)+r.tile_origin[0],
    y=Math.floor((p[1]-r.placement[1])/TILE)+r.tile_origin[1],key=`${region}:${x}:${y}`;
  if(key!==terrainFocus){terrain.prioritize(region,x,y);terrainFocus=key;}
  distantWanted=enabled?manifest.tiles.map((t,i)=>({t,i})).filter(({t,i})=>t.region===region && distance(i,p)<6000)
    .sort((a,b)=>distance(a.i,p)-distance(b.i,p)).slice(0,12).map(v=>v.i):[];
  for(const index of distantResident)if(!distantWanted.includes(index)) {
    scene.removeDistantTile(tileKey(index));distantResident.delete(index);
  }
  for(const index of distantWanted)if(resident.has(index) && !distantResident.has(index)) {
    // Reuse immutable parsed placements; no extra ADT read or terrain mesh residency.
    scene.distantTiles.set(tileKey(index),scene.tiles.get(tileKey(index)));
    scene.revision++;
    distantResident.add(index);
  }
  distantPeak=Math.max(distantPeak,distantResident.size);
}
function startDistantRead() {
  if(distantJob || objectWait.length || performance.now()-distantLastStart<500)return;
  const index=distantWanted.find(i=>!distantResident.has(i) && !distantFailures.has(i));
  if(index===undefined)return;
  distantLastStart=performance.now();
  distantJob=(async()=>{
    try {
      const bytes=await source.read(assetPath(manifest.tiles[index]));
      if(!distantWanted.includes(index) || distantResident.has(index))return;
      scene.setDistantTile(tileKey(index),bytes);distantResident.add(index);distantLoads++;
      distantPeak=Math.max(distantPeak,distantResident.size);
    } catch(error) {
      distantFailures.set(index,`Distant metadata ${manifest.tiles[index].file}: ${error.code || 'PARSE'} ${error.message || error}`);
    } finally {distantJob=undefined;}
  })();
}
async function stream(p,pin,fill=false) {
  const required=pin?Array.from(world.required_tiles()):[];
  if(required.length>LIMIT)throw new Error('Support footprint exceeds the four-tile collision budget.');
  const nearby=manifest.tiles.map((_,i)=>i).filter(i=>distance(i,p)<850).sort((a,b)=>distance(a,p)-distance(b,p));
  const wanted=[...required,...nearby.filter(i=>!required.includes(i))].slice(0,LIMIT);
  const tiles=[],removed=[];
  if(terrainRead?.ready && !wanted.includes(terrainRead.index)) {
    if('error' in terrainRead)recordTerrainFailure(terrainRead.index,terrainRead.error);
    terrainRead=undefined;
  }
  for(const index of resident) if(!wanted.includes(index)) {
    world.remove_tile(index);scene.removeTile(tileKey(index));terrain.removeTile(index);terrainErrors.delete(index);
    if(terrainMaterials.delete(index) && !terrainMaterials.size)cancelMaterialTimer();
    resident.delete(index);removed.push(index);evictions++;
  }
  let prefetches=0;
  for(const index of wanted) {
    if(resident.has(index)||failures.has(index))continue;
    const staged=terrainRead?.index===index && terrainRead.ready;
    if(!fill && !required.includes(index) && !staged && prefetches++>=1)continue;
    const entry=manifest.tiles[index];
    if(!fill && !required.includes(index)) {
      if(!terrainRead) {
        const read={index,ready:false};
        terrainRead=read;
        // Stage one raw ADT only; admission stays in this queue before collision readiness is checked.
        read.pending=(async()=>{
          try {read.bytes=await source.read(assetPath(entry));}
          catch(error) {read.error=error;}
          finally {read.ready=true;}
        })();
      }
      if(terrainRead.index!==index || !terrainRead.ready)continue;
    }
    report(`Loading ${entry.file}; required terrain stays blocked until ready.`);
    const started=performance.now();
    try {
      let bytes;
      if(terrainRead?.index===index) {
        const read=terrainRead;
        await read.pending;
        terrainRead=undefined;
        if('error' in read)throw read.error;
        bytes=read.bytes;
      } else bytes=await source.read(assetPath(entry));
      world.add_tile(index,bytes);
      scene.setTile(tileKey(index),bytes,world.tile_placements(index,bytes));
      sceneFocus=undefined;
      const vertices=world.geometry(index);
      resident.add(index);loads++;peak=Math.max(peak,resident.size);
      tiles.push({index,placement:placements[index],vertices});
      terrainMaterials.add(index);
    } catch(error) {
      world.remove_tile(index);scene.removeTile(tileKey(index));
      recordTerrainFailure(index,error);
    } finally {
      if(pin && required.includes(index)){
        measureHold('terrain',performance.now()-started);lastHoldTime=performance.now();
      }
    }
    function recordTerrainFailure(index,error) {
      failures.set(index,`${manifest.tiles[index].file}: ${error?.code || 'PARSE'} ${error?.message || String(error)}`);
    }
  }
  if(tiles.length || removed.length) {
    const seams=Array.from(resident,index=>({index,vertices:world.horizon_seams(index)}));
    postMessage({event:'detail',tiles,removed,seams},[...tiles,...seams].map(t=>t.vertices.buffer));
    report(failures.size?`${failures.size} unavailable terrain tiles; retry after correcting access/data.`:`Detailed terrain ready: ${resident.size}/4 tiles.`);
  }
}
async function buildHorizon(wdls) {
  horizon={patches:0,vertices:0,gpuBytes:0,cpuParsedBound:0,wasmPeakBytes:0,regions:[]};
  const start=performance.now();
  for(let region=0;region<2;region++)world.add_horizon(region,wdls[region]);
  for(let region=0;region<2;region++) {
    const water=world.exterior_geometry(region);
    postMessage({event:'exterior-water',region,placement:manifest.regions[region].placement,vertices:water},[water.buffer]);
    const patches=world.horizon_patches(region),indices=world.horizon_indices(region);
    horizon.gpuBytes+=indices.byteLength;
    postMessage({event:'horizon-index',region,indices},[indices.buffer]);
    horizon.regions.push({region,patches:patches.length/5});
    for(let i=0;i<patches.length;i+=5) {
      const vertices=world.horizon_vertices(region,i/5);
      horizon.patches++;horizon.vertices+=vertices.length/7;horizon.gpuBytes+=vertices.byteLength+112;
      terrain.addHorizon(region,patches[i],patches[i+1]);
      postMessage({event:'horizon',region,source:Array.from(patches.slice(i,i+2)),
        placement:Array.from(patches.slice(i+2,i+4)),near:patches[i+4],vertices},[vertices.buffer]);
      if(i%20===15) {report(`Preparing distant terrain: ${horizon.patches} authored tiles`);await new Promise(resolve=>setTimeout(resolve,0));}
    }
  }
  horizon.cpuParsedBound=world.horizon_cpu_bound();horizon.buildMs=performance.now()-start;
}
function focusRegion(p) {
  if(p[0]<manifest.ocean[0])return 0;
  if(p[0]>=manifest.ocean[2])return 1;
  return p[0]<(manifest.ocean[0]+manifest.ocean[2])/2?0:1;
}
function sourcePosition(region,p) {
  const r=manifest.regions[region];
  return [-(p[2]-r.placement[1]+(r.tile_origin[1]-32)*TILE),
    -(p[0]-r.placement[0]+(r.tile_origin[0]-32)*TILE),p[1]];
}
function updateCameraUnknown(body,region) {
  const p=sourcePosition(region,body);
  cameraUnknown=sceneState.unresolvedCollision.filter(i=>(i.kind==='wmo'&&!i.boundsKnown)
    || boundsWithin(i.bounds,p,84));
}
function sceneFault(error) {
  if(scenePumpError)return;
  scenePumpError=error;
  if(postFrameVisuals)postMessage({event:'world-error',error:`${error.code?`${error.code}: `:''}${error.message || error}`});
}
function startScenePump() {
  void scene.pump(true).catch(sceneFault);
}
function updateScene(focus,publish=true) {
  if(scenePumpError)throw scenePumpError;
  const region=focusRegion(focus);
  sceneRegion=region;
  const body=world.telemetry(),r=manifest.regions[region],signed=body[14] ?? body[5];
  const predicted=[focus[0]-Math.sin(body[3])*signed,focus[1],focus[2]-Math.cos(body[3])*signed];
  const moved=sceneFocus?Math.hypot(...focus.map((v,a)=>v-sceneFocus[a])):Infinity;
  // Static 850-yard candidates outlive this bounded visual refresh; readiness and the swept hull run every frame.
  const changed=moved>=16 || ((moved>0 || scene.selectionRevision!==scene.revision) && performance.now()-sceneUpdated>=250);
  if(changed) {
    const start=performance.now();
    scene.update(region===0?1:0,sourcePosition(region,focus),sourcePosition(region,predicted));
    timings.selectionMs+=performance.now()-start;
    sceneFocus=focus.slice();sceneUpdated=performance.now();
  }
  // Reads/texture decodes must never suspend the physics request queue.
  if(publish)startScenePump();
  if(changed || sceneRevision!==scene.revision || !sceneState) {
    const start=performance.now();sceneState=scene.snapshot();timings.snapshotMs+=performance.now()-start;
    sceneSubmissionPending=true;
  }
  sceneRevision=scene.revision;
  const sweep=world.frame_sweep_distance(),bodySource=sourcePosition(region,body),radius=4+sweep;
  if(radius>SCENE_LIMITS.radius)throw new Error('Frame sweep exceeds the streamed scene collision coverage');
  objectWait=sceneState.unresolvedCollision.filter(i=>{
    if(i.kind==='wmo' && !i.boundsKnown)return true;
    // shortcut: unknown M2 extents use a 32-yard proximity guard until their authored hull is decoded.
    return boundsWithin(i.bounds,bodySource,i.boundsKnown?radius:Math.max(32,radius));
  });
  const reach=Math.max(120,32+52+sweep);
  if(!collisionFocus || collisionFocus.region!==region || reach>collisionFocus.reach ||
    Math.hypot(body[0]-collisionFocus.x,body[2]-collisionFocus.z)>32) {
    collisionFocus={region,x:body[0],z:body[2],reach};
    sceneSubmissionPending=true;
  }
  // Readiness above is live every frame; unchanged snapshot/anchor inputs cannot change submission.
  if(!sceneSubmissionPending)return;
  for(const key of collisionBounds.keys())if(!sceneState.assets.has(key))collisionBounds.delete(key);
  const active=new Set(),nearby=[];
  const toGlobal=p=>[-p[1]+r.placement[0]+(32-r.tile_origin[0])*TILE,p[2],-p[0]+r.placement[1]+(32-r.tile_origin[1])*TILE];
  for(const instance of sceneState.collisionInstances) {
    const asset=sceneState.assets.get(instance.key);
    if(!asset?.collisionIndices?.length)continue;
    active.add(instance.id);
    let b=collisionBounds.get(instance.key);
    if(!b) {
      b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
      for(let i=0;i<asset.collisionVertices.length;i+=3)for(let a=0;a<3;a++) {
        b[a]=Math.min(b[a],asset.collisionVertices[i+a]);b[a+3]=Math.max(b[a+3],asset.collisionVertices[i+a]);
      }
      collisionBounds.set(instance.key,b);
    }
    let cached=collisionInstances.get(instance.id);
    if(!cached || cached.asset!==asset || cached.instance.matrix!==instance.matrix) {
      if(collisionToken===0xffffffff)throw new Error('Collision identifiers exhausted; reopen the local world');
      const source=transformedBounds([b.slice(0,3),b.slice(3)],instance.matrix);
      const corners=source.map(toGlobal);
      cached={asset,instance,token:++collisionToken,bounds:[...corners[0].map((v,a)=>Math.min(v,corners[1][a])),
        ...corners[0].map((v,a)=>Math.max(v,corners[1][a]))]};
      collisionInstances.set(instance.id,cached);
    }
    const global=cached.bounds;
    if(Math.hypot(Math.max(global[0]-collisionFocus.x,0,collisionFocus.x-global[3]),
      Math.max(global[2]-collisionFocus.z,0,collisionFocus.z-global[5]))<collisionFocus.reach)nearby.push(cached);
  }
  for(const id of collisionInstances.keys())if(!active.has(id))collisionInstances.delete(id);
  nearby.sort((a,b)=>a.instance.id.localeCompare(b.instance.id));
  const nextSignature=JSON.stringify(nearby.map(c=>c.token));
  if(nextSignature!==collisionSignature) {
    const start=performance.now();
    const count=nearby.reduce((n,c)=>n+c.asset.collisionIndices.length*3,0);
    if(count>200000*9)throw new Error('Nearby authored collision exceeds 200000 triangles; driving cannot proceed safely');
    const changed=nearby.filter(c=>!collisionParts.has(c.token));
    const vertices=new Float64Array(changed.reduce((n,c)=>n+c.asset.collisionIndices.length*3,0));let offset=0;
    for(const cached of changed) {
      const {asset,instance}=cached;
      cached.vertices ??= globalCollisionVertices(asset.collisionVertices,instance.matrix,r);
      for(const i of asset.collisionIndices) {
        vertices[offset++]=cached.vertices[i*3];
        vertices[offset++]=cached.vertices[i*3+1];
        vertices[offset++]=cached.vertices[i*3+2];
      }
    }
    world.set_scene_parts(new Uint32Array(nearby.map(c=>c.token)),
      new Uint32Array(nearby.map(c=>collisionParts.has(c.token)?0:c.asset.collisionIndices.length/3)),vertices);
    const ordered=world.collision_vertices(),nodes=world.collision_nodes();
    postMessage({event:'collision',vertices:ordered,nodes},[ordered.buffer,nodes.buffer]);
    collisionSignature=nextSignature;collisionCount=nearby.length;
    collisionParts=new Set(nearby.map(c=>c.token));
    timings.collisionBuildMs+=performance.now()-start;timings.collisionBuilds++;
  }
  if(publish)publishScene(region);
}
function publishScene(region) {
  if(!sceneSubmissionPending)return;
  const assets=[],textures=[],removedAssets=[],removedTextures=[],transfers=[];
  for(const key of sentAssets)if(!sceneState.assets.has(key))removedAssets.push(key);
  for(const key of sentTextures)if(!sceneState.textures.has(key))removedTextures.push(key);
  for(const [key,asset] of sceneState.assets)if(!sentAssets.has(key)) {
    const vertices=asset.vertices.slice(),indices=asset.indices.slice();
    assets.push({key,vertices,indices,batches:asset.batches});
    transfers.push(vertices.buffer,indices.buffer);
  }
  for(const [key,texture] of sceneState.textures)if(!sentTextures.has(key)) {
    const rgba=texture.rgba.slice();
    textures.push({key,width:texture.width,height:texture.height,rgba});
    transfers.push(rgba.buffer);
  }
  const signature=JSON.stringify(sceneState.instances.map(i=>[i.id,i.key,i.kind,i.distant]));
  const changed=sceneState.instances.filter(i=>{
    const previous=sentInstances.get(i.id);
    return sentSceneRegion!==region || !previous || previous.matrix!==i.matrix ||
      previous.key!==i.key || previous.kind!==i.kind || previous.distant!==i.distant;
  });
  const transformsChanged=changed.length>0;
  const instancesChanged=signature!==sceneSignature || transformsChanged || sentSceneRegion!==region;
  if(instancesChanged || assets.length || textures.length || removedAssets.length || removedTextures.length) {
    const sendInstances=instancesChanged || !sceneInstanceDeltas;
    const instancePayload=!sendInstances?{}:sceneInstanceUpdates?{
      instanceOrder:sceneState.instances.map(i=>i.id),
      instances:changed.map(({id,key,matrix,kind,distant})=>({id,key,matrix,kind,distant})),
    }:{instances:sceneState.instances};
    const start=performance.now();
    postMessage({event:'scene',region,...instancePayload,
      assets,textures,removedAssets,removedTextures},transfers);
    timings.scenePostMs+=performance.now()-start;timings.scenePosts++;
    if(sendInstances)timings.sceneInstancePosts++;
    for(const key of removedAssets)sentAssets.delete(key);
    for(const key of removedTextures)sentTextures.delete(key);
    for(const {key} of assets)sentAssets.add(key);
    for(const {key} of textures)sentTextures.add(key);
    sceneSignature=signature;
    sentSceneRegion=region;
    if(instancesChanged)sentInstances=new Map(sceneState.instances.map(({id,key,matrix,kind,distant})=>
      [id,{key,matrix,kind,distant}]));
  }
  sceneSubmissionPending=false;
}
function cancelMaterialTimer() {
  materialTimerToken++;
  if(materialTimer!==undefined)clearTimeout(materialTimer);
  materialTimer=undefined;
}
function prepareTerrainMaterial() {
  const index=terrainMaterials.values().next().value;
  if(index!==undefined) {
    terrainMaterials.delete(index);
    try {terrain.setTile(index,world.terrain_material(index));}
    catch(error) {terrainErrors.set(index,`Terrain material ${manifest.tiles[index].file}: ${error.message || error}`);}
  }
}
function pumpTerrainMaterials() {
  const generation=materialGeneration;
  void terrain.pump().then(pending=>{
    if(pending && generation===materialGeneration)scheduleTerrainMaterials(true);
  }).catch(sceneFault);
}
function scheduleTerrainMaterials(pending=false) {
  if(!postFrameVisuals || materialTimer!==undefined || (!terrainMaterials.size&&!pending))return;
  const token=materialTimerToken,index=terrainMaterials.values().next().value;
  // Give the next input reply priority, but finish bounded near-tile work even when input stops.
  materialTimer=setTimeout(()=>{
    queue=queue.then(()=>{
      if(token!==materialTimerToken)return;
      materialTimer=undefined;
      if(index!==undefined && terrainMaterials.values().next().value===index)prepareTerrainMaterial();
      pumpTerrainMaterials();
      scheduleTerrainMaterials();
    }).catch(sceneFault);
  },25);
}
function startOptionalWork(message) {
  if(!postFrameVisuals || materialFrameReady) {
    cancelMaterialTimer();
    prepareTerrainMaterial();
  }
  scheduleTerrainMaterials();
  if(message.focus || Array.from(world.required_tiles()).every(i=>resident.has(i)))startDistantRead();
  if(!objectWait.length) {
    pumpTerrainMaterials();
    if(Array.from(world.required_tiles()).every(i=>resident.has(i)))startCraft();
  }
}
function finishFrame(message) {
  const start=performance.now();
  try {
    if(scenePumpError)throw scenePumpError;
    publishScene(sceneRegion);
    startScenePump();
    startOptionalWork(message);
  } finally {
    const elapsed=performance.now()-start;
    timings.postFrameMs+=elapsed;timings.totalMs+=elapsed;
    timings.maxMs=Math.max(timings.maxMs,frameWorkMs+elapsed);
  }
}
function snapshot() {
  horizon.wasmPeakBytes=Math.max(horizon.wasmPeakBytes,wasm.memory.buffer.byteLength);
  const terrainState=terrain.snapshot();
  return {telemetry:Array.from(world.telemetry()),poseTime,resident:Array.from(resident),required:Array.from(world.required_tiles()),
    failures:Array.from(failures.values()),loads,evictions,peak,limit:LIMIT,horizon,source:source.stats,
    scene:sceneState?{instances:sceneState.instances.length,assets:sceneState.cachedAssets,bytes:sceneState.cachedBytes,
      pending:sceneState.pending,errors:sceneState.errors,population:sceneState.populationStatus,
      decoder:{...scene.timings},
      capacityBlocked:sceneState.capacityBlocked,collisionBounds:collisionCount,
      models:sceneState.cachedModels,textures:sceneState.cachedTextures,waitingCollision:objectWait.length,
      waitingCollisionDetails:objectWait.slice(0,5),
      unresolvedCollision:cameraUnknown}:undefined,
    holds,timings,craft,collision:Array.from(world.collision_stats()),
    collisionMappedBytes:[...collisionInstances.values()].reduce((n,c)=>n+(c.vertices?.byteLength||0),0),
    terrain:{...terrainState,errors:[...terrainState.errors,...terrainErrors.values()],
      prefetch:terrainRead?{index:terrainRead.index,pending:!terrainRead.ready,bytes:terrainRead.bytes?.byteLength||0}:null},
    distant:{resident:distantResident.size,peak:distantPeak,limit:12,loads:distantLoads,
      pending:distantWanted.filter(i=>!distantResident.has(i) && !distantFailures.has(i)).length,
      failures:Array.from(distantFailures.values())}};
}
async function handle(message) {
  await ready;
  if(message.action==='open') {
    sceneInstanceDeltas=message.sceneInstanceDeltas===true;
    sceneInstanceUpdates=message.sceneInstanceUpdates===true;
    postFrameVisuals=message.postFrameVisuals===true;
    materialGeneration++;cancelMaterialTimer();materialFrameReady=false;
    terrain?.clear();
    terrainRead=undefined;
    poseTime=undefined;
    terrainMaterials.clear();
    report('Opening local MPQ archives and patch chain');
    source=await openDataSource(message.folder);
    const wdts=[],wdls=[];
    for(const map of ['Kalimdor','Azeroth']) {
      report(`Reading ${map} authoritative topology and distant terrain`);
      wdts.push(await source.read(`World\\Maps\\${map}\\${map}.wdt`));
      wdls.push(await source.read(`World\\Maps\\${map}\\${map}.wdl`));
    }
    const json=world_manifest(wdts[0],wdls[0],wdts[1],wdls[1]);
    manifest=JSON.parse(json);
    world=new Voyage(json);
    placements=manifest.tiles.map(t=>{
      const r=manifest.regions[t.region];
      return [r.placement[0]+(t.x-r.tile_origin[0])*TILE,r.placement[1]+(t.y-r.tile_origin[1])*TILE];
    });
    scene=new SceneStream(source,wasmTypes);
    terrain=new TerrainStream(source,wasmTypes,(message,transfers)=>postMessage(message,transfers));
    void terrain.init(manifest);
    const population=await fetch('./local/npc-spawns.json');
    if(population.ok)scene.setPopulation(await population.json());
    else if(population.status!==404)throw new Error(`Private NPC companion failed: HTTP ${population.status}`);
    await buildHorizon(wdls);
    await stream([manifest.spawn[0],manifest.spawn[2]],true);
    world.initialize_spawn();
    await updateScene(Array.from(world.telemetry().slice(0,3)));
    updateCameraUnknown(world.telemetry(),focusRegion(world.telemetry()));
    return {info:{id:source.fingerprint,manifest,archiveCount:source.archives.length,tuning:Array.from(world.tuning())},state:snapshot()};
  }
  if(!world)throw new Error('Local world is not open');
  if(message.action==='frame') {
    if(message.sampleTime!==undefined && !Number.isFinite(message.sampleTime))throw new Error('Invalid input sample time');
    const started=performance.now();
    const p=world.telemetry(),focus=message.focus || Array.from(p.slice(0,3));
    if(!Array.isArray(focus)||focus.length!==3||!focus.every(v=>Number.isFinite(v)&&Math.abs(v)<1e12))throw new Error('Invalid world focus');
    prepareDistant(focus,message.distant!==false);
    const frameLoads=loads;
    const terrainStart=performance.now();await stream([focus[0],focus[2]],!message.focus);
    timings.terrainMs+=performance.now()-terrainStart;
    const sceneStart=performance.now();updateScene(focus,!postFrameVisuals);timings.sceneMs+=performance.now()-sceneStart;
    const physicsStart=performance.now();let advanced=false;
    if(!message.focus) {
      const now=performance.now(),elapsed=lastHoldTime?Math.min(now-lastHoldTime,1000):0;lastHoldTime=now;
      if(objectWait.length){accumulator=0;measureHold('objects',elapsed);}
      else {
        accumulator+=Math.min(Math.max(message.dt,0),.1);
        while(accumulator>=1/120){world.tick(message.throttle,message.steer,message.flags);advanced=true;accumulator-=1/120;}
        const hold=world.telemetry()[8];
        measureHold(hold===1?'terrain':hold===3?'solid':hold===2?'unsupported':'clear',elapsed);
      }
    } else {accumulator=0;lastHoldTime=0;lastHold='clear';}
    materialFrameReady=loads===frameLoads && (advanced || !!message.focus || objectWait.length>0);
    // Stamp the completed fixed tick in the input clock, not its variably delayed delivery time.
    if(message.sampleTime===undefined || message.focus)poseTime=undefined;
    else if(advanced || poseTime===undefined || objectWait.length)poseTime=message.sampleTime-accumulator*1000;
    timings.physicsMs+=performance.now()-physicsStart;
    const cameraStart=performance.now();
    updateCameraUnknown(world.telemetry(),focusRegion(focus));
    timings.cameraUnknownMs+=performance.now()-cameraStart;
    if(!postFrameVisuals)startOptionalWork(message);
    const elapsed=performance.now()-started;timings.frames++;timings.totalMs+=elapsed;timings.maxMs=Math.max(timings.maxMs,elapsed);
    frameWorkMs=elapsed;
  } else if(message.action==='restore') {
    if(!Array.isArray(message.pose)||message.pose.length!==4||!message.pose.every(Number.isFinite))throw new Error('Invalid parked pose');
    await stream([message.pose[0],message.pose[2]],false,true);
    world.restore(new Float64Array(message.pose));accumulator=0;poseTime=undefined;
  } else if(message.action==='reset') {
    await stream([manifest.spawn[0],manifest.spawn[2]],false,true);
    world.initialize_spawn();accumulator=0;poseTime=undefined;
  } else if(message.action==='retry') {
    scenePumpError=undefined;sceneSubmissionPending=true;
    failures.clear();distantFailures.clear();scene.retry();
    if(craft.error)craft={ready:false,pending:false};
    await terrain.retry();
    for(const index of terrainErrors.keys()) {
      try {terrain.setTile(index,world.terrain_material(index));terrainErrors.delete(index);}
      catch(error) {terrainErrors.set(index,`Terrain material retry: ${error.message || error}`);}
    }
  } else if(message.action==='population') {
    scene.setPopulation(message.pack);
  } else if(message.action==='tuning') {
    if(message.values!==undefined) {
      if(!Array.isArray(message.values)||message.values.length!==17||!message.values.every(Number.isFinite))throw new Error('Tuning requires exactly 17 finite numbers');
      const values=new Float32Array(message.values);
      world.validate_tuning(values);
      if(!message.validateOnly)world.set_tuning(values);
      return Array.from(values);
    }
    return Array.from(world.tuning());
  } else if(message.action==='probe') {
    return message.points.map(p=>Array.from(world.surface(p[0],p[1])));
  } else if(message.action!=='snapshot')throw new Error('Unknown world operation');
  if(message.action==='restore' || message.action==='reset' || message.action==='retry') {
    const body=world.telemetry();
    await updateScene(Array.from(body.slice(0,3)));
    updateCameraUnknown(body,focusRegion(body));
  }
  return snapshot();
}
onmessage=({data})=>{
  queue=queue.then(async()=>{
    let responded=false;
    try {
      const result=await handle(data),start=performance.now();
      postMessage({id:data.id,result});
      responded=true;
      if(data.action==='frame')timings.postMs+=performance.now()-start;
      // Finish this frame's visuals before the next queued request, but let the client draw its fresh pose first.
      if(data.action==='frame' && postFrameVisuals)finishFrame(data);
      else scheduleTerrainMaterials(data.action==='retry');
    }
    catch(error){
      if(responded)sceneFault(error);
      else postMessage({id:data.id,error:`${error.code?`${error.code}: `:''}${error.message || error}`});
    }
  });
};
