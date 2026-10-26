import init,{Voyage,world_manifest} from './pkg/flats_racer_web.js';
import * as pkg from './pkg/flats_racer_web.js';
import * as wasmTypes from './pkg/flats_racer_web.js';
import {openAssetSource} from './asset-channel.js';
import {SceneStream,SCENE_LIMITS,transformedBounds,globalCollisionVertices,sceneReady} from './scene-stream.js';
import {TerrainStream} from './terrain-stream.js';
import {loadCraft} from './craft-stream.js';
import {loadPopulation} from './npc-pack.js';
import {WaterStream} from './water-stream.js';
import {FarChannel} from './far-channel.js';
import {splitBudget,effectiveBudget,residentTileCap,bodyTileCap,nearRadius} from './memory-budget.js';
import {FAR_LIMITS} from './far-stream.js';
import {BODIES} from './bodies.js';
import {viewChanged} from './world-view.js';
import {ActorService,ACTOR} from './actors.js';
import {maelstromCentre,WHIRLPOOL_DIP} from './clouds.js';
import {TILE,createTerrainIndex,terrainDistance,tileKeyOf,assetPathOf,focusRegionOf,sourcePositionOf,
  nextUnresolvedWindow,isCameraUnknown,isObjectWaiting} from './world-worker-logic.js';

let LIMIT=SCENE_LIMITS.nearTiles;
let wasm;
export const ready=init().then(exports=>(wasm=exports));
export let world,source,manifest,placements,scene,terrain,water,accumulator=0,queue=Promise.resolve();
// Every queued job runs strictly after the previous one; scheduled timers and message handlers share this chain.
export const enqueue=job=>{queue=queue.then(job);return queue;};
let poseTime,flightFocus,areaTime=-1e9,areaId=0,actors,actorFocus,actorRegion=0,actorsOn=true;
export const setActorsOn=on=>{actorsOn=on;if(actors)actors.enabled=on;};
// Total residency budget in bytes; each stream gets its share (memory-budget.js). Zero keeps the built-in defaults.
let memoryBudget=0;
let moonBody=false;
let rendererBytes=0;
export function setMemoryBudget(bytes,gpu=0) {
  if(!Number.isFinite(bytes)||bytes<=0)return;
  const next=Math.floor(bytes),measured=Number.isFinite(gpu)?Math.max(0,gpu):0;
  // Renderer feedback arrives about once a second; only re-split when it moved enough to matter.
  if(next===memoryBudget&&Math.abs(measured-rendererBytes)<next*.08)return;
  memoryBudget=next;rendererBytes=measured;applyMemoryBudget();
}
function applyMemoryBudget() {
  if(!memoryBudget)return;
  const shares=splitBudget(effectiveBudget(memoryBudget,rendererBytes));
  LIMIT=bodyTileCap(memoryBudget,moonBody);nearRadiusNow=nearRadius(LIMIT);
  if(scene)scene.limits.nearTiles=LIMIT;
  scene?.setBudget(shares.scene);terrain?.setBudget(shares.terrain);far?.budget(shares.far);
}
export const stopLoadingArt=()=>source?.stopLoadingArt();
const actorGround=(sx,sy)=>{const r=manifest?.regions[actorRegion];if(!r||!world)return NaN;
  const s=world.surface(-sy+r.placement[0]+(32-r.tile_origin[0])*1600/3,-sx+r.placement[1]+(32-r.tile_origin[1])*1600/3);return s[0]===0?s[1]:NaN;};
globalThis.setInterval?.(()=>{if(actors&&actorFocus&&sceneState){actors.update(sceneState.instances,actorFocus);actors.wander(sceneState.instances,actorFocus,actorGround);}},ACTOR.tickMs);
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
async function yieldTerrain() {
  if(globalThis.scheduler?.postTask)await scheduler.postTask(()=>{},{priority:'background'});
  else await new Promise(resolve=>setTimeout(resolve,0));
}
function discardTerrainRead() {
  if(terrainRead)world.cancel_tile();
  terrainRead=undefined;
}
function prepareTerrain(read, decode=true) {
  const owner=source,target=world,stream=scene;
  const current=()=>terrainRead===read&&source===owner&&world===target;
  read.ready=false;
  return (async()=>{
    try {
      if(decode)read.bytes=await owner.read(assetPath(manifest.tiles[read.index]));
      const steps=(function*(){
        if(decode){
          target.begin_tile(read.index,read.bytes);yield;
          while(!target.step_tile())yield;
          read.metadata=target.prepared_tile_placements(read.bytes);yield;
        }
        return yield* stream.prepareTile(tileKey(read.index),read.bytes,read.metadata);
      })();
      for(;;){
        await yieldTerrain();
        if(!current())return;
        const start=performance.now();
        let result;
        for(let i=0;i<16;i++){
          result=steps.next();
          if(result.done||performance.now()-start>=4)break;
        }
        const elapsed=performance.now()-start;
        timings.terrainSliceMs+=elapsed;timings.terrainSliceMax=Math.max(timings.terrainSliceMax,elapsed);
        if(result.done){read.scene=result.value;return;}
      }
    }catch(error){
      if(current()){target.cancel_tile();read.error=error;}
    }finally{read.ready=true;}
  })();
}
let detailPending,detailBusy=false;
const tileVersions=new Map(),detailReady=new Set();
let nextTileVersion=0;
const geometryPending=new Set(),geometryRemoved=new Set();
let geometryJob,geometryRevision=0,geometryDirty=false;
function queueGeometry(tiles,removed) {
  for(const index of removed){geometryPending.delete(index);geometryRemoved.add(index);}
  for(const tile of tiles)geometryPending.add(tile.index);
  geometryRevision++;geometryDirty=true;flushGeometry();
}
function flushGeometry() {
  if(geometryJob||!geometryDirty||scenePumpError)return;
  const job={},revision=geometryRevision,owner=source;
  geometryJob=job;
  const steps=(function*(){
    const tiles=[],seams=[];
    for(const index of geometryPending){
      tiles.push({index,version:tileVersions.get(index),placement:placements[index],vertices:world.geometry(index)});yield;
    }
    for(const index of resident){seams.push({index,vertices:world.horizon_seams(index)});yield;}
    return {event:'detail',tiles,removed:[...geometryRemoved],seams};
  })();
  void(async()=>{
    for(;;){
      if(globalThis.scheduler?.postTask)await scheduler.postTask(()=>{},{priority:'background'});
      else await new Promise(resolve=>setTimeout(resolve,0));
      if(geometryJob!==job||source!==owner||geometryRevision!==revision||scenePumpError)return;
      const start=performance.now(),result=steps.next(),elapsed=performance.now()-start;
      timings.geometrySliceMs+=elapsed;timings.geometrySliceMax=Math.max(timings.geometrySliceMax,elapsed);
      if(result.done){
        sendDetail(result.value);
        geometryPending.clear();geometryRemoved.clear();geometryDirty=false;
        return;
      }
    }
  })().catch(error=>{if(geometryJob===job&&source===owner)sceneFault(error);}).finally(()=>{
    if(geometryJob===job){geometryJob=undefined;flushGeometry();}
  });
}
function sendDetail(data) {
  if(!source.prepareDetail){publishDetail(data,[...data.tiles,...data.seams].map(t=>t.vertices.buffer));return;}
  detailPending??={tiles:new Map(),removed:new Set()};
  for(const index of data.removed){detailPending.tiles.delete(index);detailPending.removed.add(index);}
  for(const tile of data.tiles)detailPending.tiles.set(tile.index,tile);
  detailPending.seams=data.seams;
  flushDetail();
}
function publishDetail(data,transfers) {
  postMessage(data,transfers);
  for(const tile of data.tiles)if(resident.has(tile.index)&&tileVersions.get(tile.index)===tile.version)
    detailReady.add(tile.index);
  scheduleTerrainMaterials();
}
function flushDetail() {
  if(detailBusy||!detailPending)return;
  const pending=detailPending,owner=source;
  detailPending=undefined;detailBusy=true;
  void owner.prepareDetail({event:'detail',tiles:[...pending.tiles.values()],
    removed:[...pending.removed],seams:pending.seams}).then(data=>{
    if(source===owner)publishDetail(data,[...data.tiles.flatMap(t=>[t.vertices.buffer,t.liquid.buffer,
      t.camera.vertices.buffer,t.camera.offsets.buffer,t.camera.triangles.buffer]),...data.seams.map(t=>t.vertices.buffer)]);
  }).catch(error=>{if(source===owner)sceneFault(error);}).finally(()=>{
    if(source===owner){detailBusy=false;flushDetail();}
  });
}
const terrainMaterials=new Set();
let materialFrameReady=false,materialTimer,materialTimerToken=0,materialGeneration=0,materialBusy=false,hopConsumed=0;
let sentAssets=new Set(),sentTextures=new Set(),sceneState,sceneSignature='';
let sentInstances=new Map();
let sentSceneRegion;
let sceneInstanceDeltas=false;
let sceneInstanceUpdates=false;
export let postFrameVisuals=false,sceneRegion,frameWorkMs=0;
let sceneFocus,sceneUpdated=0,sceneRevision=-1;
let sceneReadinessRadius=0,sceneReadinessVertical=0;
let sceneSubmissionPending=true;
let scenePumpError,scenePump;
const collisionBounds=new Map();
let collisionCount=0;
let collisionSignature='',waterActive=false;
let collisionToken=0,collisionParts=new Set();
let collisionFocus;
const collisionInstances=new Map();
export const timings={frames:0,totalMs:0,maxMs:0,terrainMs:0,sceneMs:0,selectionMs:0,snapshotMs:0,
  geometrySliceMs:0,geometrySliceMax:0,
  terrainSliceMs:0,terrainSliceMax:0,
  physicsMs:0,cameraUnknownMs:0,postMs:0,postFrameMs:0,scenePostMs:0,scenePosts:0,sceneInstancePosts:0,collisionBuildMs:0,collisionBuilds:0};
let far,farFocus,farView,farUpdated=0,farFlight=false;
function startFarWorker() {
  far?.close();farFocus=undefined;farView=undefined;
  far=new FarChannel(()=>new Worker('./far-worker.js',{type:'module'}),source,manifest,
    (message,transfers)=>postMessage(message,transfers),
    ()=>!!objectWait.length ||
      (!farFlight&&!Array.from(world.required_tiles()).every(i=>resident.has(i))));
  if(sceneState)far.near(readyNearIds());
}
let objectWait=[],cameraUnknown=[],lastHoldTime=0,lastHold='clear',holdRun=0;
let unresolvedWindow;
const holds=Object.fromEntries(['terrain','objects','solid','unsupported'].map(key=>[key,{episodes:0,ms:0,maxMs:0}]));
function measureHold(kind,elapsed) {
  if(kind==='clear'){lastHold=kind;holdRun=0;return;}
  const counter=holds[kind];
  if(lastHold!==kind){counter.episodes++;holdRun=0;}
  counter.ms+=elapsed;holdRun+=elapsed;counter.maxMs=Math.max(counter.maxMs,holdRun);lastHold=kind;
}
const report=(text,progress={})=>postMessage({event:'progress',text,...progress});
const assetPath=t=>assetPathOf(manifest,t);
const terrainIndex=createTerrainIndex();
let nearRadiusNow=850;
const nearbyTerrain=p=>terrainIndex.nearby(placements,p,nearRadiusNow);
const tileKey=index=>tileKeyOf(manifest,index);
function prepareDistant(focus,enabled,flying=false,view) {
  farFlight=flying;
  water?.setFocus(focus);
  const region=focusRegion(focus),p=[focus[0],focus[2]];
  const r=manifest.regions[region],x=Math.floor((p[0]-r.placement[0])/TILE)+r.tile_origin[0],
    y=Math.floor((p[1]-r.placement[1])/TILE)+r.tile_origin[1],key=`${region}:${x}:${y}`;
  if(key!==terrainFocus){terrain.prioritize(region,x,y);terrainFocus=key;}
  const limit=SCENE_LIMITS.instances-(enabled&&far.active?FAR_LIMITS.instances:0);
  if(scene.limits.instances!==limit){scene.limits.instances=limit;sceneFocus=undefined;}
  if(!farFocus || region!==far.region || enabled!==far.enabled ||
    performance.now()-farUpdated>=100 &&
      (Math.hypot(...focus.map((v,a)=>v-farFocus[a]))>=16 || viewChanged(farView,view))) {
    far.focus(region,focus.slice(),enabled,view);farFocus=focus.slice();farView=view;farUpdated=performance.now();
  }
}
function recordTerrainFailure(index,error) {
  failures.set(index,`${manifest.tiles[index].file}: ${error?.code || 'PARSE'} ${error?.message || String(error)}`);
}
let lastNearby=[];
async function stream(p,pin,fill=false) {
  const required=pin?Array.from(world.required_tiles()):[];
  if(required.length>LIMIT)throw new Error('Support footprint exceeds the bounded terrain collision budget.');
  const nearby=nearbyTerrain(p);lastNearby=nearby;
  const wanted=[...required,...nearby.filter(i=>!required.includes(i))].slice(0,LIMIT);
  const tiles=[],removed=[];
  if(terrainRead?.ready && !wanted.includes(terrainRead.index)) {
    if('error' in terrainRead)recordTerrainFailure(terrainRead.index,terrainRead.error);
    discardTerrainRead();
  }
  for(const index of resident) if(!wanted.includes(index)) {
    world.remove_tile(index);scene.removeTile(tileKey(index));terrain.removeTile(index);terrainErrors.delete(index);
    if(terrainMaterials.delete(index) && !terrainMaterials.size)cancelMaterialTimer();
    resident.delete(index);tileVersions.delete(index);detailReady.delete(index);removed.push(index);evictions++;
  }
  if(fill&&terrainRead&&!wanted.includes(terrainRead.index)){
    await terrainRead.pending;
    if('error' in terrainRead)recordTerrainFailure(terrainRead.index,terrainRead.error);
    discardTerrainRead();
  }
  const order=fill&&terrainRead?[...new Set([terrainRead.index,...wanted])]:wanted;
  for(const index of order) {
    if(resident.has(index)||failures.has(index))continue;
    const entry=manifest.tiles[index];
    if(terrainRead&&terrainRead.index!==index){
      if(required.includes(index)&&terrainRead.bytes){
        if('error' in terrainRead)recordTerrainFailure(terrainRead.index,terrainRead.error);
        discardTerrainRead();
      }
      else continue;
    }
    if(!terrainRead){
      const read={index,ready:false};terrainRead=read;
      read.pending=prepareTerrain(read);
    }
    const read=terrainRead;
    if(fill)await read.pending;
    if(!read.ready)continue;
    if(!('error' in read)&&read.scene.revision!==scene.placementRevision){
      read.pending=prepareTerrain(read,false);
      if(fill)await read.pending;
      else continue;
    }
    report(`Loading ${entry.file}; required terrain stays blocked until ready.`);
    const started=performance.now();
    try {
      if('error' in read)throw read.error;
      world.commit_tile(index);
      scene.commitTile(tileKey(index),read.scene);
      terrainRead=undefined;
      sceneFocus=undefined;
      const vertices=postFrameVisuals?undefined:world.geometry(index);
      resident.add(index);loads++;peak=Math.max(peak,resident.size);
      const version=++nextTileVersion;tileVersions.set(index,version);detailReady.delete(index);
      tiles.push({index,version,placement:placements[index],vertices});
      terrainMaterials.add(index);
    } catch(error) {
      discardTerrainRead();
      world.remove_tile(index);scene.removeTile(tileKey(index));
      recordTerrainFailure(index,error);
    } finally {
      if(pin && required.includes(index)){
        measureHold('terrain',performance.now()-started);lastHoldTime=performance.now();
      }
    }
    if(!fill)break;
  }
  if(tiles.length || removed.length) {
    if(postFrameVisuals)queueGeometry(tiles,removed);
    else {
      const seams=Array.from(resident,index=>({index,vertices:world.horizon_seams(index)}));
      sendDetail({event:'detail',tiles,removed,seams});
    }
    report(failures.size?`${failures.size} unavailable terrain tiles; retry after correcting access/data.`:`Detailed terrain ready: ${resident.size}/${LIMIT} tiles.`);
  }
}
async function buildHorizon(wdls) {
  horizon={patches:0,vertices:0,gpuBytes:0,cpuParsedBound:0,wasmPeakBytes:0,regions:[]};
  const start=performance.now();
  const regionCount=manifest.regions.length;
  for(let region=0;region<regionCount;region++)world.add_horizon(region,wdls[region]);
  const patchesByRegion=wdls.map((_,region)=>world.horizon_patches(region));
  const total=patchesByRegion.reduce((n,p)=>n+p.length/5,0);
  for(let region=0;region<regionCount;region++) {
    if(manifest.version!==4){const exterior=world.exterior_geometry(region);
    water?.setExterior(region,exterior);
    postMessage({event:'exterior-water',region,placement:manifest.regions[region].placement,vertices:exterior},[exterior.buffer]);}
    const patches=patchesByRegion[region],indices=world.horizon_indices(region);
    horizon.gpuBytes+=indices.byteLength;
    postMessage({event:'horizon-index',region,indices},[indices.buffer]);
    horizon.regions.push({region,patches:patches.length/5});
    for(let i=0;i<patches.length;i+=5) {
      const vertices=world.horizon_vertices(region,i/5);
      if(vertices.some((v,index)=>index%7===1&&v<=manifest.sea_level))water?.coastalTile(patches[i+4]);
      horizon.patches++;horizon.vertices+=vertices.length/7;horizon.gpuBytes+=vertices.byteLength+112;
      terrain.addHorizon(region,patches[i],patches[i+1]);
      postMessage({event:'horizon',region,source:Array.from(patches.slice(i,i+2)),
        placement:Array.from(patches.slice(i+2,i+4)),near:patches[i+4],vertices},[vertices.buffer]);
      if(i%20===15) {
        report('Preparing distant terrain',{stage:'terrain',completed:horizon.patches,total});
        if(globalThis.scheduler?.postTask)await scheduler.postTask(()=>{},{priority:'background'});
        else await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
  }
  horizon.cpuParsedBound=world.horizon_cpu_bound();horizon.buildMs=performance.now()-start;
}
function focusRegion(p) {return focusRegionOf(manifest,p);}
/** Re-post the static horizon (index buffers and patch vertices) to a fresh consumer; the world already holds it, so this only reads. */
async function replayHorizon(token) {
  const regionCount=manifest.regions.length;
  for(let region=0;region<regionCount;region++) {
    if(token!==rebindToken)return;
    if(manifest.version!==4){const exterior=world.exterior_geometry(region);postMessage({event:'exterior-water',region,placement:manifest.regions[region].placement,vertices:exterior},[exterior.buffer]);}
    const patches=world.horizon_patches(region),indices=world.horizon_indices(region);
    postMessage({event:'horizon-index',region,indices},[indices.buffer]);
    for(let i=0;i<patches.length;i+=5) {
      if(token!==rebindToken)return;
      const vertices=world.horizon_vertices(region,i/5);
      terrain.addHorizon(region,patches[i],patches[i+1]);
      postMessage({event:'horizon',region,source:Array.from(patches.slice(i,i+2)),placement:Array.from(patches.slice(i+2,i+4)),near:patches[i+4],vertices},[vertices.buffer]);
      if(i%20===15){
        if(globalThis.scheduler?.postTask)await scheduler.postTask(()=>{},{priority:'background'});
        else await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
  }
}
let rebindToken=0;
/** The renderer consuming this engine changed (gravity-well swap): drop all near residency and everything "already sent" so streaming re-emits it in full, then (for the new near engine) replay the horizon in the background and restart the far channel. */
export async function rebindRenderer(replay=true) {
  const token=++rebindToken;
  cancelMaterialTimer();discardTerrainRead();
  for(const index of resident) {world.remove_tile(index);scene.removeTile(tileKey(index));terrain.removeTile(index);terrainErrors.delete(index);evictions++;}
  resident.clear();tileVersions.clear();detailReady.clear();terrainMaterials.clear();
  detailPending=undefined;detailBusy=false;geometryJob=undefined;geometryRevision++;geometryDirty=false;geometryPending.clear();geometryRemoved.clear();
  sentAssets=new Set();sentTextures=new Set();sentInstances=new Map();sentSceneRegion=undefined;sceneSignature='';
  sceneState=undefined;sceneFocus=undefined;sceneSubmissionPending=true;objectWait=[];unresolvedWindow=undefined;
  craft={ready:false,pending:false};
  terrain.clear();await terrain.init(manifest);
  if(replay){startFarWorker();void replayHorizon(token);}
}
function sourcePosition(region,p) {return sourcePositionOf(manifest,region,p);}
function nearUnresolved(p,region,radius=84,vertical=84) {
  radius=Math.max(84,radius);vertical=Math.max(84,vertical);
  unresolvedWindow=nextUnresolvedWindow(unresolvedWindow,sceneState,sceneRevision,p,region,radius,vertical);
  return unresolvedWindow.candidates;
}
function updateCameraUnknown(body,region) {
  const p=sourcePosition(region,body);
  cameraUnknown=nearUnresolved(p,region).filter(i=>isCameraUnknown(i,p));
}
export function sceneFault(error) {
  if(scenePumpError)return;
  scenePumpError=error;
  if(postFrameVisuals)postMessage({event:'world-error',error:`${error.code?`${error.code}: `:''}${error.message || error}`});
}
function startScenePump() {
  const owner=scene,visual=scene.prepareVisuals?.();
  if(visual)void visual.catch(error=>{if(scene===owner)sceneFault(error);});
  if(!scenePump) {
    const pump=scene.pump(true).catch(sceneFault);
    scenePump=pump;
    void pump.finally(()=>{if(scenePump===pump)scenePump=undefined;});
  }
  return scenePump;
}
function updateScene(focus,publish=true,restoring) {
  if(scenePumpError)throw scenePumpError;
  const region=focusRegion(focus);
  sceneRegion=region;
  const body=restoring||world.telemetry(),r=manifest.regions[region],signed=body[14] ?? body[5];
  const sweep=restoring?0:world.frame_sweep_distance(),radius=4+sweep;
  const verticalRadius=4+(restoring?0:world.frame_vertical_sweep_distance());
  const coverage=Math.hypot(Math.max(32,radius),Math.max(32,verticalRadius));
  if(!Number.isFinite(radius) || !Number.isFinite(verticalRadius) || radius<4 || verticalRadius<4 ||
    coverage>SCENE_LIMITS.radius)
    throw new Error('Frame sweep exceeds the streamed scene collision coverage');
  scene.collisionReach=Math.max(120,32+52+sweep)+32;
  const predicted=restoring?[focus[0],-Number.MAX_VALUE,focus[2]]:
    [focus[0]-Math.sin(body[3])*signed,focus[1],focus[2]-Math.cos(body[3])*signed];
  const moved=sceneFocus?Math.hypot(...focus.map((v,a)=>v-sceneFocus[a])):Infinity;
  // Geometry revisions are immediate; texture and visual publications cannot change collision demand.
  const changed=scene.asyncVisuals&&scene.collisionSelectionRevision!==scene.collisionRevision ||
    moved>=16 || Math.max(32,radius)+moved>sceneReadinessRadius ||
    Math.max(32,verticalRadius)+moved>sceneReadinessVertical ||
    coverage+moved>SCENE_LIMITS.radius ||
    ((moved>0 || !scene.asyncVisuals&&scene.selectionRevision!==scene.revision) && performance.now()-sceneUpdated>=250);
  if(changed) {
    const start=performance.now();
    const requestedRadius=Math.min(SCENE_LIMITS.radius,Math.max(32,radius)+16);
    const requestedVertical=Math.min(SCENE_LIMITS.radius,Math.max(32,verticalRadius)+16);
    scene.update(region===0?1:0,sourcePosition(region,focus),sourcePosition(region,predicted),requestedRadius,requestedVertical);
    actorFocus=sourcePosition(region,focus);actorRegion=region;
    sceneReadinessRadius=requestedRadius;
    sceneReadinessVertical=requestedVertical;
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
  const bodySource=sourcePosition(region,body);
  objectWait=(restoring?sceneState.unresolvedCollision:nearUnresolved(bodySource,region,radius,verticalRadius)).filter(i=>
    isObjectWaiting(i,{restoring,radius,verticalRadius,predicted:restoring?sourcePosition(region,predicted):undefined,bodySource}));
  const reach=Math.max(120,32+52+sweep);
  if(!collisionFocus || collisionFocus.region!==region || reach>collisionFocus.reach ||
    Math.hypot(body[0]-collisionFocus.x,body[2]-collisionFocus.z)>32) {
    collisionFocus={region,x:body[0],z:body[2],reach};
    sceneSubmissionPending=true;
  }
  // Readiness above is live every frame; unchanged snapshot/anchor inputs cannot change submission.
  if(!sceneSubmissionPending)return;
  for(const key of collisionBounds.keys())if(!sceneState.assets.has(key))collisionBounds.delete(key);
  const active=new Set(),nearby=[],waterNearby=[];
  const toGlobal=p=>[-p[1]+r.placement[0]+(32-r.tile_origin[0])*TILE,p[2],-p[0]+r.placement[1]+(32-r.tile_origin[1])*TILE];
  for(const instance of sceneState.collisionInstances) {
    const asset=sceneState.assets.get(instance.key);
    if(!asset?.collisionIndices?.length&&!asset?.waterIndices?.length)continue;
    active.add(instance.id);
    let b=collisionBounds.get(instance.key);
    if(!b) {
      b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
      for(const v of [asset.collisionVertices,asset.waterVertices||[]])for(let i=0;i<v.length;i+=3)for(let a=0;a<3;a++) {
        b[a]=Math.min(b[a],v[i+a]);b[a+3]=Math.max(b[a+3],v[i+a]);
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
      Math.max(global[2]-collisionFocus.z,0,collisionFocus.z-global[5]))<collisionFocus.reach) {
      if(asset.collisionIndices.length)nearby.push(cached);
      if(asset.waterIndices?.length)waterNearby.push(cached);
    }
  }
  for(const id of collisionInstances.keys())if(!active.has(id))collisionInstances.delete(id);
  nearby.sort((a,b)=>a.instance.id.localeCompare(b.instance.id));
  const nextSignature=JSON.stringify([nearby.map(c=>c.token),waterNearby.map(c=>c.token)]);
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
    const water=[];
    for(const cached of waterNearby) {
      const {asset,instance}=cached;
      cached.waterVertices??=globalCollisionVertices(asset.waterVertices,instance.matrix,r);
      for(const i of asset.waterIndices)water.push(cached.waterVertices[i*3],cached.waterVertices[i*3+1],cached.waterVertices[i*3+2]);
    }
    if(waterNearby.length||waterActive){world.set_scene_water(Float64Array.from(water));waterActive=waterNearby.length>0;}
    const ordered=world.collision_vertices(),nodes=world.collision_nodes();
    postMessage({event:'collision',vertices:ordered,nodes},[ordered.buffer,nodes.buffer]);
    collisionSignature=nextSignature;collisionCount=nearby.length;
    collisionParts=new Set(nearby.map(c=>c.token));
    timings.collisionBuildMs+=performance.now()-start;timings.collisionBuilds++;
  }
  if(publish)publishScene(region);
}
async function preparePoseScene(pose) {
  const body=Array(15).fill(0);body.splice(0,4,...pose);
  const focus=body.slice(0,3);
  sceneFocus=undefined;collisionFocus=undefined;
  updateScene(focus,false,body);
  while(objectWait.length) {
    const failed=objectWait.find(i=>i.status!=='PENDING');
    if(failed)throw new Error(`Saved location collision unavailable: ${failed.key} (${failed.status})`);
    if(sceneState.pending===0)
      throw new Error('Saved location collision cannot fit the available scene budget');
    await startScenePump();
    sceneFocus=undefined;
    updateScene(focus,false,body);
    if(objectWait.length&&sceneState.capacityBlocked)
      throw new Error('Saved location collision cannot fit the available scene budget');
  }
}
async function restorePose(pose) {
  const previous=Array.from(world.telemetry()).slice(0,4);
  const previousRequired=Array.from(world.required_tiles()).filter(i=>resident.has(i));
  try {
    await stream([pose[0],pose[2]],false,true);
    await preparePoseScene(pose);
    world.restore(new Float64Array(pose));
    accumulator=0;poseTime=undefined;
  } catch(error) {
    try {
      await stream([previous[0],previous[2]],false,true);
      if(previousRequired.some(i=>!resident.has(i)))throw new Error('Previous location terrain is unavailable');
      await preparePoseScene(previous);
    } catch(recovery) {
      throw new Error(`${error?.message??error}; previous pose retained but scene recovery failed: ${recovery?.message??recovery}`,{cause:error});
    }
    throw error;
  } finally {sceneFocus=undefined;collisionFocus=undefined;}
}
function readyNearIds() {
  return sceneState.instances.filter(i=>sceneReady(i,sceneState.assets,sceneState.textures)).map(i=>i.id);
}
function publishScene(region) {
  if(!sceneSubmissionPending)return;
  const assets=[],textures=[],removedAssets=[],removedTextures=[],transfers=[];
  for(const key of sentAssets)if(!sceneState.assets.has(key))removedAssets.push(key);
  for(const key of sentTextures)if(!sceneState.textures.has(key))removedTextures.push(key);
  for(const [key,asset] of sceneState.assets)if(!sentAssets.has(key)) {
    const vertices=asset.vertices.slice(),indices=asset.indices.slice();
    assets.push({key,vertices,indices,batches:asset.batches,bounds:asset.bounds});
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
    far.near(readyNearIds());
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
  if(materialBusy)return;
  const index=[...terrainMaterials].find(i=>detailReady.has(i));
  if(index!==undefined) {
    terrainMaterials.delete(index);
    try {
      if(postFrameVisuals&&terrain.prepareTile){
        const owner=terrain,generation=materialGeneration;materialBusy=true;
        const ownerWorld=world,staged=!!world.begin_terrain_material;
        const material=staged?world.begin_terrain_material(index):world.terrain_material(index);
        void terrain.prepareTile(index,material,staged?()=>ownerWorld.step_terrain_material(index,material):undefined).catch(error=>{
          if(terrain===owner&&generation===materialGeneration&&resident.has(index))
            terrainErrors.set(index,`Terrain material ${manifest.tiles[index].file}: ${error.message || error}`);
        }).finally(()=>{
          if(terrain===owner&&generation===materialGeneration){materialBusy=false;scheduleTerrainMaterials(true);}
        });
      }else terrain.setTile(index,world.terrain_material(index));
    }
    catch(error) {materialBusy=false;terrainErrors.set(index,`Terrain material ${manifest.tiles[index].file}: ${error.message || error}`);}
  }
}
function pumpTerrainMaterials() {
  const generation=materialGeneration;
  void terrain.pump().then(pending=>{
    if(pending && generation===materialGeneration)scheduleTerrainMaterials(true);
  }).catch(sceneFault);
}
export function scheduleTerrainMaterials(pending=false) {
  if(!postFrameVisuals || materialTimer!==undefined || (!terrainMaterials.size&&!pending))return;
  const token=materialTimerToken,index=[...terrainMaterials].find(i=>detailReady.has(i));
  if(index===undefined&&!pending)return;
  // Give the next input reply priority, but finish bounded near-tile work even when input stops.
  materialTimer=setTimeout(()=>{
    queue=queue.then(()=>{
      if(token!==materialTimerToken)return;
      materialTimer=undefined;
      if(index!==undefined && terrainMaterials.has(index)&&detailReady.has(index))prepareTerrainMaterial();
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
  if(!objectWait.length) {
    pumpTerrainMaterials();
    const terrainReady=Array.from(world.required_tiles()).every(i=>resident.has(i));
    if(terrainReady)startCraft();
    if(message.focus||terrainReady)water?.pump();
  }
}
export function finishFrame(message) {
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
export function snapshot() {
  horizon.wasmPeakBytes=Math.max(horizon.wasmPeakBytes,wasm.memory.buffer.byteLength);
  const terrainState=terrain.snapshot();
  const clock=performance.now();
  if(clock-areaTime>500){areaTime=clock;areaId=flightFocus&&world.area_at?world.area_at(flightFocus[0],flightFocus[1]):world.area();}
  return {telemetry:Array.from(world.telemetry()),area:areaId,poseTime,hopConsumed,resident:Array.from(resident),nearTerrain:{total:lastNearby.length,resident:lastNearby.filter(i=>resident.has(i)).length},required:Array.from(world.required_tiles()),
    failures:Array.from(failures.values()),loads,evictions,peak,limit:LIMIT,horizon,source:source.stats,
    scene:sceneState?{instances:sceneState.instances.length,assets:sceneState.cachedAssets,bytes:sceneState.cachedBytes,
      pending:sceneState.pending,errors:sceneState.errors,population:sceneState.populationStatus,
      decoder:{...scene.timings},
      capacityBlocked:sceneState.capacityBlocked,collisionBounds:collisionCount,
      models:sceneState.cachedModels,textures:sceneState.cachedTextures,waitingCollision:objectWait.length,
      waitingCollisionDetails:objectWait.slice(0,5),
      unresolvedCollision:cameraUnknown}:undefined,
    memory:{budget:memoryBudget,sceneLimit:scene?.limits?.bytes||0,sceneEvictions:scene?.evictions||0},
    holds,timings,craft,collision:Array.from(world.collision_stats()),
    collisionMappedBytes:[...collisionInstances.values()].reduce((n,c)=>n+(c.vertices?.byteLength||0),0),
    water:water?.snapshot(),
    terrain:{...terrainState,errors:[...terrainState.errors,...terrainErrors.values(),...(water?.errors.values()||[]),
      ...(water?.cacheError?[water.cacheError]:[])],
      prefetch:terrainRead?{index:terrainRead.index,pending:!terrainRead.ready,bytes:terrainRead.bytes?.byteLength||0}:null},
    distant:far.snapshot(),actors:actors?.snapshot()};
}
export async function openWorld(message) {
    sceneInstanceDeltas=message.sceneInstanceDeltas===true;
    sceneInstanceUpdates=message.sceneInstanceUpdates===true;
    postFrameVisuals=message.postFrameVisuals===true;
    materialGeneration++;cancelMaterialTimer();materialFrameReady=false;materialBusy=false;
    terrain?.clear();
    water?.clear();
    discardTerrainRead();
    detailPending=undefined;detailBusy=false;
    tileVersions.clear();detailReady.clear();nextTileVersion=0;
    geometryJob=undefined;geometryRevision++;geometryDirty=false;
    geometryPending.clear();geometryRemoved.clear();
    poseTime=undefined;
    hopConsumed=0;
    terrainMaterials.clear();
    report('Opening local MPQ archives and patch chain');
    far?.close();
    const previousSource=source;source=undefined;
    previousSource?.close();
    source=await openAssetSource(message.folder,undefined,data=>postMessage(data,data.rgba?[data.rgba.buffer]:[]),
      {loadingArt:true,map:message.loadingMap,graft:message.dataFolder});
    report('World and archive workers ready');
    const moon=typeof message.folder==='string'&&!!BODIES[message.folder]?.rail;
    moonBody=moon;if(moon){LIMIT=bodyTileCap(memoryBudget,true);nearRadiusNow=nearRadius(LIMIT);}
    const wdts=[],wdls=[];
    for(const map of moon?[message.folder[0].toUpperCase()+message.folder.slice(1)]:['Kalimdor','Azeroth']) {
      report(`Reading ${map} topology and terrain`,{stage:'topology',completed:wdts.length+wdls.length,total:moon?2:4});
      wdts.push(await source.read(`World\\Maps\\${map}\\${map}.wdt`));
      report(`Reading ${map} topology and terrain`,{stage:'topology',completed:wdts.length+wdls.length,total:moon?2:4});
      wdls.push(await source.read(`World\\Maps\\${map}\\${map}.wdl`));
    }
    const json=moon?pkg.moon_manifest(wdts[0],wdls[0]):world_manifest(wdts[0],wdls[0],wdts[1],wdls[1]);
    manifest=JSON.parse(json);
    world=new Voyage(json);
    if(manifest.world_bounds){const [x,z]=maelstromCentre(manifest);world.set_whirlpool(x,z,WHIRLPOOL_DIP.radius,WHIRLPOOL_DIP.depth);}
    placements=manifest.tiles.map(t=>{
      const r=manifest.regions[t.region];
      return [r.placement[0]+(t.x-r.tile_origin[0])*TILE,r.placement[1]+(t.y-r.tile_origin[1])*TILE];
    });
    scene=new SceneStream(source,wasmTypes);if(moon)scene.limits.nearTiles=LIMIT;
    actors?.close();actorFocus=undefined;
    actors=new ActorService(source,wasmTypes,(message,transfers)=>postMessage(message,transfers));actors.enabled=actorsOn;
    scene.asyncVisuals=true;
    startFarWorker();
    terrain=new TerrainStream(source,wasmTypes,(message,transfers)=>postMessage(message,transfers));actors.enabled=actorsOn;
    water=new WaterStream(source,wasmTypes,manifest,(message,transfers)=>postMessage(message,transfers));actors.enabled=actorsOn;
    applyMemoryBudget();
    void terrain.init(manifest);
    const loopback=/^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
    // Static hosts without a pack (404, or an HTML fallback with 200) simply get no creatures.
    const pack=await loadPopulation({loopback,source,wasm:wasmTypes});
    if(pack)scene.setPopulation(pack);
    // Horizon initialization is synchronous before its first yield; required near work can then overlap publication.
    const horizonReady=buildHorizon(wdls);
    await Promise.all([horizonReady,(async()=>{
      await stream([manifest.spawn[0],manifest.spawn[2]],true,true);
      if(failures.size)throw new Error([...failures.values()].slice(0,3).join('\n'));
      world.initialize_spawn();
      await preparePoseScene(Array.from(world.telemetry()).slice(0,4));
    })()]);
    updateCameraUnknown(world.telemetry(),focusRegion(world.telemetry()));
    return {info:{id:source.fingerprint,manifest,archiveCount:source.archives.length,tuning:Array.from(world.tuning())},state:snapshot()};
}
export function requireWorld() {
  if(!world)throw new Error('Local world is not open');
}
export async function runFrame(message) {
    {
    const started=performance.now();
    const p=world.telemetry(),focus=message.focus || Array.from(p.slice(0,3));flightFocus=message.focus?[message.focus[0],message.focus[2]]:undefined;
    if(!Array.isArray(focus)||focus.length!==3||!focus.every(v=>Number.isFinite(v)&&Math.abs(v)<1e12))throw new Error('Invalid world focus');
    prepareDistant(focus,message.distant!==false,!!message.focus,message.view);
    const frameLoads=loads;
    const terrainStart=performance.now();if(!message.farOnly)await stream([focus[0],focus[2]],!message.focus);
    timings.terrainMs+=performance.now()-terrainStart;
    const sceneStart=performance.now();if(!message.farOnly)updateScene(focus,!postFrameVisuals);timings.sceneMs+=performance.now()-sceneStart;
    source.refresh?.();
    const physicsStart=performance.now();let advanced=false;
    if(!message.focus) {
      const now=performance.now(),elapsed=lastHoldTime?Math.min(now-lastHoldTime,1000):0;lastHoldTime=now;
      if(objectWait.length){accumulator=0;measureHold('objects',elapsed);}
      else {
        accumulator+=Math.min(Math.max(message.dt,0),.1);
        while(accumulator>=1/120){
          const tickFlags=message.flags|((message.hop||0)>hopConsumed?8:0);
          world.tick(message.throttle,message.steer,tickFlags);
          if(message.hop)hopConsumed=Math.max(hopConsumed,message.hop);
          advanced=true;accumulator-=1/120;
        }
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
  }
}
export async function restoreWorld(message) {
  await restorePose(message.pose);
  if(message.repair)world.repair();
}
export async function resetWorld() {
  await stream([manifest.spawn[0],manifest.spawn[2]],false,true);
  world.initialize_spawn();accumulator=0;poseTime=undefined;
}
export async function retryWorld() {
  scenePumpError=undefined;sceneSubmissionPending=true;
  flushGeometry();
  failures.clear();scene.retry();water?.retry();
  if(far.active)far.retry();else startFarWorker();
  if(craft.error)craft={ready:false,pending:false};
  await terrain.retry();
  for(const index of terrainErrors.keys()) {
    try {terrain.setTile(index,world.terrain_material(index));terrainErrors.delete(index);}
    catch(error) {terrainErrors.set(index,`Terrain material retry: ${error.message || error}`);}
  }
}
export const setPopulation=pack=>scene.setPopulation(pack);
export const farAck=(token,producer)=>far?.ack(token,producer);
export const farReject=(token,producer)=>far?.reject(token,producer);
export function settleAfterAction(action) {
  if(action==='restore' || action==='reset' || action==='retry') {
    const body=world.telemetry();
    if(action!=='restore')updateScene(Array.from(body.slice(0,3)));
    updateCameraUnknown(body,focusRegion(body));
  }
}
