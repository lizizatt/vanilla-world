import * as wasmTypes from './pkg/flats_racer_web.js';
import {loadProp,loadPropTexture} from './craft-stream.js';
import {validateView} from './world-view.js';
import {MusicService} from './music.js';
import {SkyService} from './sky.js';
import {WorldMapService} from './worldmap.js';
import {HudArtService} from './hud-art.js';
import {ready,source,world,timings,postFrameVisuals,openWorld,runFrame,restoreWorld,resetWorld,retryWorld,
  requireWorld,setPopulation,setActorsOn,setMemoryBudget,stopLoadingArt,farAck,farReject,snapshot,settleAfterAction,rebindRenderer,
  finishFrame,scheduleTerrainMaterials,sceneFault} from './world-engine.js';
import {formatError,validateHop,validateSampleTime,validateParkedPose,validateTuning} from './world-worker-logic.js';
import {pod} from './world-engine.js';
import {validatePodControl} from './pod-attitude.js';

let music,sky,worldMap,hudArt;

// Messages that must never wait behind the serialized world queue; returns true when consumed.
export function routeImmediate(data) {
  if(data.action==='stop-loading-art'){stopLoadingArt();return true;}
  if(data.action==='animate'){setActorsOn(data.on!==false);return true;}
  if(data.action==='budget'){setMemoryBudget(data.bytes,data.gpu);return true;}
  if(data.action==='music'){
    if(!source)return true;
    const owner=source;
    if(music?.source!==owner)music=new MusicService(owner,data=>postMessage(data));
    void music.request(data,()=>source!==owner);
    return true;
  }
  if(data.action==='sky'){
    if(!source)return true;
    const owner=source;
    if(sky?.source!==owner)sky=new SkyService(owner,(data,transfers)=>postMessage(data,transfers),wasmTypes);
    void sky.request(()=>source!==owner);
    return true;
  }
  if(data.action==='worldmap'){
    if(!source||!Array.isArray(data.names))return true;
    const owner=source;
    if(worldMap?.source!==owner)worldMap=new WorldMapService(owner,(data,transfers)=>postMessage(data,transfers),wasmTypes);
    void worldMap.request(data.names.filter(n=>typeof n==='string'),()=>source!==owner);
    return true;
  }
  if(data.action==='hud-art'){
    if(!source)return true;
    const owner=source;
    if(hudArt?.source!==owner)hudArt=new HudArtService(owner,(data,transfers)=>postMessage(data,transfers),wasmTypes);
    void hudArt.request(()=>source!==owner);
    return true;
  }
  if(data.action==='far-ack'){farAck(data.token,data.producer);return true;}
  if(data.action==='far-reject'){farReject(data.token,data.producer);return true;}
  return false;
}
export async function handle(message) {
  await ready;
  if(message.action==='prop-texture')return loadPropTexture(source,wasmTypes,String(message.path));
  if(message.action==='prop-model')return loadProp(source,wasmTypes,String(message.path));
  if(message.action==='open')return openWorld(message);
  requireWorld();
  if(message.action==='launch-objects'){pod.setObjects(message.objects);return true;}
  if(message.action==='pod-adopt'){pod.adopt(message.pod,world);return snapshot();}
  if(message.action==='pod-release'){pod.journey=null;pod.remaining=0;pod.hold=0;return snapshot();}
  if(message.action==='frame') {
    validatePodControl(message.podControl);
    validateHop(message.hop);
    validateSampleTime(message.sampleTime);
    if(message.pitch!==undefined&&!Number.isFinite(message.pitch))throw new Error('Pitch must be finite');
    if(message.simTime!==undefined&&!Number.isFinite(message.simTime))throw new Error('Pod time must be finite');
    if(message.podEnabled!==undefined&&typeof message.podEnabled!=='boolean')throw new Error('Invalid pod mode');
    if(message.view!==undefined)validateView(message.view);
    await runFrame(message);
  } else if(message.action==='restore') {
    validateParkedPose(message.pose);
    await restoreWorld(message);
  } else if(message.action==='reset') {
    await resetWorld();
  } else if(message.action==='rebind') {
    postMessage({event:'renderer-bound',id:message.id});
    await rebindRenderer(message.replay!==false);
  } else if(message.action==='retry') {
    await retryWorld();
  } else if(message.action==='population') {
    setPopulation(message.pack);
  } else if(message.action==='tuning') {
    if(message.values!==undefined) {
      validateTuning(message.values);
      const values=new Float32Array(message.values);
      world.validate_tuning(values);
      if(!message.validateOnly)world.set_tuning(values);
      return Array.from(values);
    }
    return Array.from(world.tuning());
  } else if(message.action==='durability') {
    world.set_durability(!!message.on,Number(message.lethal)||100);
    return true;
  } else if(message.action==='probe') {
    return message.points.map(p=>Array.from(world.surface(p[0],p[1])));
  } else if(message.action==='wreck-start') {
    const {pos,rot,scale,vel,parts,seed}=message;
    world.wreck_start(Float64Array.from(pos),Float32Array.from(rot),scale,Float32Array.from(vel),Float32Array.from(parts),seed>>>0);
    return true;
  } else if(message.action==='wreck-run') {
    return world.wreck_run(Math.min(240,message.steps|0));
  } else if(message.action!=='snapshot')throw new Error('Unknown world operation');
  settleAfterAction(message.action);
  return snapshot();
}
// One queued job: reply first, then publish deferred visuals so physics replies are never delayed.
export async function process(data) {
  let responded=false;
  try {
    const result=await handle(data),start=performance.now();
    postMessage({id:data.id,result});
    responded=true;
    if(data.action==='frame')timings.postMs+=performance.now()-start;
    // Publish visuals after replying; newly admitted materials wait for catch-up.
    if(data.action==='frame' && postFrameVisuals)finishFrame(data);
    else scheduleTerrainMaterials(data.action==='retry');
  }
  catch(error){
    if(responded)sceneFault(error);
    else postMessage({id:data.id,error:formatError(error)});
  }
}
