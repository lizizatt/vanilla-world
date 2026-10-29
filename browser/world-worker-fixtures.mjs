import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {transformedBounds,globalCollisionVertices,SCENE_LIMITS,placementMatrix,boundsWithin,boundsDistance,sceneReady} from './scene-stream.js';
import {FAR_LIMITS} from './far-stream.js';
import {validateView,viewChanged} from './world-view.js';
import {PodRuntime} from './pod-driver.js';
import {validatePodControl} from './pod-attitude.js';
import {ARRIVAL,arrivalResources} from './loading-gate.js';

export {runInContext};

// Exercise the actual worker layers (entry, protocol, runtime, logic) in one script scope, with synthetic
// archive/Wasm boundaries and no WebGPU. Modules are concatenated in dependency order with their
// import/export syntax removed, so tests can reach and replace runtime state exactly as the worker shares it.
const layers=['./world-worker-logic.js','./world-engine.js','./world-worker-protocol.js','./world-worker.js'];
const worker=(await Promise.all(layers.map(file=>readFile(new URL(file,import.meta.url),'utf8'))))
  .map(source=>source.replace(/^import [^;]*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
export const settle=()=>new Promise(resolve=>setImmediate(resolve));
export function boot(events=[],clock=performance) {
  const timers=new Map();let nextTimer=0;
  const context=createContext({init:async()=>({memory:{buffer:new ArrayBuffer(0)}}),performance:clock,postMessage:message=>events.push(message),
    setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>timers.delete(id),
    ARRIVAL,arrivalResources,PodRuntime,validatePodControl,transformedBounds,globalCollisionVertices,SCENE_LIMITS,FAR_LIMITS,boundsWithin,boundsDistance,validateView,viewChanged,sceneReady});
  runInContext(worker,context);
  runInContext('far={active:true,close(){},retry(){},near(){},snapshot:()=>({resident:0,failures:[]})};',context);
  context.timers=timers;
  context.fireTimer=async()=>{
    const [id,timer]=timers.entries().next().value;
    timers.delete(id);timer.callback();await runInContext('queue',context);await settle();
  };
  return context;
}
export function fixture(xs=[0,1,20,21]) {
  const reads=[],added=[],materials=[],pending=new Map(),required=[0],prepared=[];
  const events=[],context=boot(events);
  context.dependencies={
    world:{required_tiles:()=>required,begin_tile:i=>prepared.push(i),step_tile:()=>true,
      commit_tile:i=>added.push(i),cancel_tile(){},remove_tile(){},
      geometry:()=>new Float32Array(),horizon_seams:()=>new Float32Array(),terrain_material:i=>{materials.push(i);return {};},
      prepared_tile_placements:()=> '[]'},
    source:{read:path=>{
      const index=Number(path.match(/tile(\d+)\.adt$/)[1]);
      reads.push(index);
      return new Promise((resolve,reject)=>pending.set(index,{resolve,reject}));
    }},
    manifest:{regions:[{map:'test'}],tiles:xs.map((x,i)=>({region:0,x,y:0,file:`tile${i}.adt`}))},
    placements:xs.map(x=>[x*1600/3,0]),
    scene:{placementRevision:0,*prepareTile(){yield;return {revision:this.placementRevision};},
      commitTile(){this.placementRevision++;},removeTile(){}},terrain:{setTile(){},removeTile(){},async pump(){}},
  };
  runInContext(`({world,source,manifest,placements,scene,terrain}=dependencies);
    resident=new Set([0]);
    yieldTerrain=async()=>{};
    craft.ready=true;
    globalThis.streamTerrain=stream;
    globalThis.visuals=()=>startOptionalWork({});
    globalThis.state=()=>({resident:[...resident],failures:[...failures.values()]});`,context);
  return {context,events,reads,added,prepared,materials,required,pending,stream:context.streamTerrain,visuals:context.visuals,
    state:()=>JSON.parse(JSON.stringify(context.state()))};
}

export function collisionFixture(clock=performance,instanceDeltas=true) {
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
      required_tiles:()=>[],area:()=>0,collision_stats:()=>[0,0,0],
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

export function frameFixture(deferred=true) {
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

export function materialFixture() {
  const f=frameFixture();
  f.context.admissions=[];
  f.context.dependencies.manifest.tiles=Array.from({length:4},(_,i)=>({file:`tile${i}.adt`}));
  f.context.dependencies.world.terrain_material=i=>({index:i});
  runInContext(`stream=async()=>{
    const index=admissions.shift();
    if(index!==undefined){resident.add(index);detailReady.add(index);terrainMaterials.add(index);loads++;}
  };
  terrain.setTile=(index,material)=>postMessage({event:'material',index,material});
  globalThis.materialState=()=>({pending:[...terrainMaterials],errors:[...terrainErrors.values()]});`,f.context);
  f.state=()=>JSON.parse(JSON.stringify(f.context.materialState()));
  return f;
}
