import init,{Voyage,world_manifest} from './pkg/flats_racer_web.js';
import * as wasmTypes from './pkg/flats_racer_web.js';
import {openDataSource} from './asset-source.js';
import {SceneStream} from './scene-stream.js';

const TILE=1600/3,LIMIT=4;
let wasm;
const ready=init().then(exports=>(wasm=exports));
let world,source,manifest,placements,scene,accumulator=0,queue=Promise.resolve();
let resident=new Set(),failures=new Map(),loads=0,evictions=0,peak=0,horizon;
let sentAssets=new Set(),sentTextures=new Set(),sceneState,sceneSignature='';
const collisionBounds=new Map();
let collisionCount=0;
let objectWait=[],lastHoldTime=0,lastHold='clear',holdRun=0;
const holds=Object.fromEntries(['terrain','objects','solid'].map(key=>[key,{episodes:0,ms:0,maxMs:0}]));
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
async function stream(p,pin,fill=false) {
  const required=pin?Array.from(world.required_tiles()):[];
  if(required.length>LIMIT)throw new Error('Support footprint exceeds the four-tile collision budget.');
  const nearby=manifest.tiles.map((_,i)=>i).filter(i=>distance(i,p)<850).sort((a,b)=>distance(a,p)-distance(b,p));
  const wanted=[...required,...nearby.filter(i=>!required.includes(i))].slice(0,LIMIT);
  const tiles=[],removed=[];
  for(const index of resident) if(!wanted.includes(index)) {
    world.remove_tile(index);scene.removeTile(tileKey(index));
    resident.delete(index);removed.push(index);evictions++;
  }
  let prefetches=0;
  for(const index of wanted) {
    if(resident.has(index)||failures.has(index))continue;
    if(!fill && !required.includes(index) && prefetches++>=1)continue;
    const entry=manifest.tiles[index];
    report(`Loading ${entry.file}; required terrain stays blocked until ready.`);
    const started=performance.now();
    try {
      const bytes=await source.read(assetPath(entry));
      world.add_tile(index,bytes);
      scene.setTile(tileKey(index),bytes);
      const vertices=world.geometry(index);
      resident.add(index);loads++;peak=Math.max(peak,resident.size);
      tiles.push({index,placement:placements[index],vertices});
    } catch(error) {
      world.remove_tile(index);scene.removeTile(tileKey(index));
      failures.set(index,`${entry.file}: ${error.code || 'PARSE'} ${error.message || error}`);
    } finally {
      if(pin && required.includes(index)){
        measureHold('terrain',performance.now()-started);lastHoldTime=performance.now();
      }
    }
  }
  if(tiles.length || removed.length) {
    const seams=Array.from(resident,index=>({index,vertices:world.horizon_seams(index)}));
    postMessage({event:'detail',tiles,removed,seams},[...tiles,...seams].map(t=>t.vertices.buffer));
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
  return -1;
}
function sourcePosition(region,p) {
  const r=manifest.regions[region];
  return [-(p[2]-r.placement[1]+(r.tile_origin[1]-32)*TILE),
    -(p[0]-r.placement[0]+(r.tile_origin[0]-32)*TILE),p[1]];
}
async function updateScene(focus) {
  const region=focusRegion(focus);
  if(region<0) {
    if(sceneSignature!=='')postMessage({event:'scene',instances:[],assets:[],textures:[],removedAssets:[],removedTextures:[]});
    sceneSignature='';
    world.set_scene_bounds(new Float64Array());collisionCount=0;objectWait=[];
    return;
  }
  scene.update(region===0?1:0,sourcePosition(region,focus));
  await scene.pump();
  sceneState=scene.snapshot();
  const solids=[],body=world.telemetry(),r=manifest.regions[region];
  for(const key of collisionBounds.keys())if(!sceneState.assets.has(key))collisionBounds.delete(key);
  const bodySource=sourcePosition(region,body),radius=4+body[5]*.1;
  objectWait=sceneState.unresolvedCollision.filter(i=>{
    if(i.kind==='wmo' && !i.boundsKnown)return true;
    const distance=Math.hypot(...bodySource.map((v,a)=>Math.max(i.bounds[0][a]-v,0,v-i.bounds[1][a])));
    // shortcut: unknown M2 extents use a 32-yard proximity guard until their authored hull is decoded.
    return distance<(i.boundsKnown?radius:32);
  });
  for(const instance of sceneState.collisionInstances) {
    const asset=sceneState.assets.get(instance.key);
    if(!asset?.collisionVertices?.length)continue;
    let b=collisionBounds.get(instance.key);
    if(!b) {
      b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
      for(let i=0;i<asset.collisionVertices.length;i+=3)for(let a=0;a<3;a++) {
        b[a]=Math.min(b[a],asset.collisionVertices[i+a]);b[a+3]=Math.max(b[a+3],asset.collisionVertices[i+a]);
      }
      collisionBounds.set(instance.key,b);
    }
    const m=instance.matrix,global=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
    for(let corner=0;corner<8;corner++) {
      const p=[b[corner&1?3:0],b[corner&2?4:1],b[corner&4?5:2]];
      const source=[0,1,2].map(i=>m[i]*p[0]+m[4+i]*p[1]+m[8+i]*p[2]+m[12+i]);
      const v=[-source[1]+r.placement[0]+(32-r.tile_origin[0])*TILE,source[2],-source[0]+r.placement[1]+(32-r.tile_origin[1])*TILE];
      for(let a=0;a<3;a++){global[a]=Math.min(global[a],v[a]);global[a+3]=Math.max(global[a+3],v[a]);}
    }
    if(Math.hypot(Math.max(global[0]-body[0],0,body[0]-global[3]),Math.max(global[2]-body[2],0,body[2]-global[5]))<120)solids.push(...global);
  }
  world.set_scene_bounds(new Float64Array(solids));collisionCount=solids.length/6;
  const assets=[],textures=[],removedAssets=[],removedTextures=[],transfers=[];
  for(const key of sentAssets)if(!sceneState.assets.has(key)){removedAssets.push(key);sentAssets.delete(key);}
  for(const key of sentTextures)if(!sceneState.textures.has(key)){removedTextures.push(key);sentTextures.delete(key);}
  for(const [key,asset] of sceneState.assets)if(!sentAssets.has(key)) {
    const vertices=asset.vertices.slice(),indices=asset.indices.slice();
    assets.push({key,vertices,indices,batches:asset.batches});
    transfers.push(vertices.buffer,indices.buffer);sentAssets.add(key);
  }
  for(const [key,texture] of sceneState.textures)if(!sentTextures.has(key)) {
    const rgba=texture.rgba.slice();
    textures.push({key,width:texture.width,height:texture.height,rgba});
    transfers.push(rgba.buffer);sentTextures.add(key);
  }
  const signature=JSON.stringify(sceneState.instances);
  if(signature!==sceneSignature || assets.length || textures.length || removedAssets.length || removedTextures.length) {
    sceneSignature=signature;
    postMessage({event:'scene',region,instances:sceneState.instances,assets,textures,removedAssets,removedTextures},transfers);
  }
}
function snapshot() {
  horizon.wasmPeakBytes=Math.max(horizon.wasmPeakBytes,wasm.memory.buffer.byteLength);
  return {telemetry:Array.from(world.telemetry()),resident:Array.from(resident),required:Array.from(world.required_tiles()),
    failures:Array.from(failures.values()),loads,evictions,peak,limit:LIMIT,horizon,source:source.stats,
    scene:sceneState?{instances:sceneState.instances.length,assets:sceneState.cachedAssets,bytes:sceneState.cachedBytes,
      pending:sceneState.pending,errors:sceneState.errors,population:sceneState.populationStatus,
      capacityBlocked:sceneState.capacityBlocked,collisionBounds:collisionCount,
      models:sceneState.cachedModels,textures:sceneState.cachedTextures,waitingCollision:objectWait.length,
      waitingCollisionDetails:objectWait.slice(0,5)}:undefined,
    holds};
}
async function handle(message) {
  await ready;
  if(message.action==='open') {
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
    const population=await fetch('./local/npc-spawns.json');
    if(population.ok)scene.setPopulation(await population.json());
    else if(population.status!==404)throw new Error(`Private NPC companion failed: HTTP ${population.status}`);
    await buildHorizon(wdls);
    await stream([manifest.spawn[0],manifest.spawn[2]],true);
    world.initialize_spawn();
    await updateScene(Array.from(world.telemetry().slice(0,3)));
    return {info:{id:source.fingerprint,manifest,archiveCount:source.archives.length},state:snapshot()};
  }
  if(!world)throw new Error('Local world is not open');
  if(message.action==='frame') {
    const p=world.telemetry(),focus=message.focus || Array.from(p.slice(0,3));
    if(!Array.isArray(focus)||focus.length!==3||!focus.every(v=>Number.isFinite(v)&&Math.abs(v)<1e12))throw new Error('Invalid world focus');
    await stream([focus[0],focus[2]],!message.focus);
    await updateScene(focus);
    if(!message.focus) {
      const now=performance.now(),elapsed=lastHoldTime?Math.min(now-lastHoldTime,1000):0;lastHoldTime=now;
      if(objectWait.length){accumulator=0;measureHold('objects',elapsed);}
      else {
        accumulator+=Math.min(Math.max(message.dt,0),.1);
        while(accumulator>=1/120){world.tick(message.throttle,message.steer,message.flags);accumulator-=1/120;}
        const hold=world.telemetry()[8];
        measureHold(hold===1?'terrain':hold===3?'solid':'clear',elapsed);
      }
    } else {accumulator=0;lastHoldTime=0;lastHold='clear';}
  } else if(message.action==='restore') {
    if(!Array.isArray(message.pose)||message.pose.length!==4||!message.pose.every(Number.isFinite))throw new Error('Invalid parked pose');
    await stream([message.pose[0],message.pose[2]],false,true);
    world.restore(new Float64Array(message.pose));accumulator=0;
  } else if(message.action==='reset') {
    await stream([manifest.spawn[0],manifest.spawn[2]],false,true);
    world.initialize_spawn();accumulator=0;
  } else if(message.action==='retry') {
    failures.clear();scene.retry();
  } else if(message.action==='population') {
    scene.setPopulation(message.pack);
  } else if(message.action==='probe') {
    return message.points.map(p=>Array.from(world.surface(p[0],p[1])));
  } else if(message.action!=='snapshot')throw new Error('Unknown world operation');
  return snapshot();
}
onmessage=({data})=>{
  queue=queue.then(async()=>{
    try {postMessage({id:data.id,result:await handle(data)});}
    catch(error){postMessage({id:data.id,error:`${error.code?`${error.code}: `:''}${error.message || error}`});}
  });
};
