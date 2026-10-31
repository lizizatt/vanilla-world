import {MINIMAP_SIZE} from './terrain-stream.js';
import {sunDirection,cloudUniform,CloudMask} from './clouds.js';
import {eluneSkyAt} from './elune-sky.js';
import {wantsDisc} from './renderer-init.js';
import {schematicRects} from './worldmap.js';
import {viewFrom,otherView,dayDiscVisibility} from './body-sky.js';
import {AZEROTH,ELUNE,BODIES,planetFactorsFor,farDrawLevel} from './bodies.js';
import {activeBody,activeFramedBody} from './body-shaders.js';
import {patchesAt,packPatches,PATCH_GRID} from './globe-patches.js';
import {makeOtherSet} from './renderer-init.js';
import {createRegistry,defaultManifest,bakeSurface,surfaceTexel,splatMinimap,adtChunk} from './tile-registry.js';
import {HEIGHT_W,HEIGHT_H,encodeHeights} from './height-bake.js';
import {PLANET_RADIUS,WORLD_CENTRE,spaceUniform,FALLBACK_RECTS} from './space.js';
import {settlementPositions,createNightBake,litSpot,NIGHT_W,NIGHT_H} from './night-lights.js';
import {SkyCatalog,mapPosition,nightAlpha,nightAngle} from './sky.js';

/** Game light data arrives as raw DBC bytes, stays in memory, and falls back to the procedural sky on any problem. */
export function setSky(r,data) {
  try {if(data.error)console.warn('Game sky unavailable',data.error);r.skyCatalog=data.error?undefined:new SkyCatalog(data);}
  catch(error) {console.warn('Game sky unavailable',error);r.skyCatalog=undefined;}
}
export function setSkyDome(r,data) {
  if(data.error){console.warn('Sky dome unavailable',data.error);return;}
  const textures=new Map(data.textures.map(t=>[t.key,r.texture(t.width,t.height,t.rgba)]));
  const sampler=r.device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
  r.skyDome={vertices:r.buffer(data.asset.vertices,GPUBufferUsage.VERTEX),indices:r.buffer(data.asset.indices,GPUBufferUsage.INDEX),
    batches:data.asset.batches.map(b=>({first:b.firstIndex,count:b.indexCount,group:r.device.createBindGroup({
      layout:r.domePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.domeBuffer}},
        {binding:1,resource:(textures.get(b.texture)||r.white).createView()},{binding:2,resource:sampler}]})}))};
}
/** Feeds the globe colour grid: a tile needs both its WDL placement and its minimap, in either arrival order. */
export function horizonColour(r,key,part) {
  const e={...r.horizonMini.get(key),...part};r.horizonMini.set(key,e);
  if(e.placement&&e.rgba){const b=activeBody();splatMinimap(r.colourGrid,e.rgba,MINIMAP_SIZE,e.placement,b.centre,b.radius,r.colourDirty,r.heightGrid);r.horizonMini.delete(key);}
}
export function planetRects(r) {return r.manifest?.world_bounds?schematicRects(r.manifest):FALLBACK_RECTS;}
/** Shared-space view (design/elune.md D3): Elune is always the moon-slot sphere seen from Azeroth when enabled; v4 charts are Elune looking back at Azeroth. */
export function sharedFrame(r) {
  const frame=activeBody().id==='elune'?viewFrom(ELUNE,r.timeOfDay):r.sharedSpace?viewFrom(AZEROTH,r.timeOfDay):undefined;
  // The other body is drawn from its own resident far renderer (drawBodies), so its analytic stand-in disc is switched off.
  if(frame&&r.otherSets?.[frame.moons[0].other])frame.moons[0]={...frame.moons[0],radius:0};
  return frame;
}
const OTHER_MOONS=[{position:[0,0,0],radius:0,tint:[0,0,0]}];
/** Bodies other than the camera's chart that have their own pipelines and parked state, farthest first. */
export function otherBodies(r) {
  if(!r.sharedSpace||!r.bodyStates||!r.planetSets)return [];
  const a=activeBody();
  return Object.values(BODIES).filter(b=>b.id!==a.id&&r.planetSets[b.id]&&r.bodyStates.get(b.id));
}
/** Baked surface of a non-active body: its parked bake if it has one, else one built from the minimap colour its own engine has streamed so far (re-baked at most every 2 s as tiles arrive; with real data the minimaps own the land, so the procedural continents are skipped). */
export function otherSurface(r,body,state,now) {
  if(state.surfaceBytes&&!state.farVersion)return state.surfaceBytes;
  if(state.farBytes&&(state.farBakedVersion===state.farVersion||now-(state.farBakedAt||0)<2000))return state.farBytes;
  const real=!!r.bodyManifests?.[body.id]?.world_bounds||!body.sea,rects=r.bodyRects?.[body.id]??FALLBACK_RECTS;
  state.farBytes=bakeSurface(createRegistry([...defaultManifest(undefined,rects).map(c=>real?{...c,provider:{sample:()=>({skip:true})}}:c),adtChunk(state.farGrid??state.colourGrid)]));
  state.farBakedVersion=state.farVersion;state.farBakedAt=now;
  return state.farBytes;
}
/** Draws every other resident body from its own parked far data (height grid, baked surface, patch LOD) as if the camera hovered over it, after the active globe and before terrain. */
export function drawBodies(r,pass,pf,near) {
  const list=otherBodies(r);
  if(!list.length)return;
  const a=activeBody(),views=[],visible=dayDiscVisibility(a,(r.sunLocal??sunDirection(r.timeOfDay))[1],pf.space);
  for(const body of list) {
    const set=r.otherSets?.[body.id];
    if(!set){r.otherPending??={};r.otherPending[body.id]??=makeOtherSet(r,body).then(s=>{(r.otherSets??={})[body.id]=s;}).catch(e=>console.warn(body.id+' far renderer',e));continue;}
    const o=otherView(r.view,a,body,r.timeOfDay);
    if(o)views.push({body,set,o});
  }
  views.sort((x,y)=>y.o.altitude-x.o.altitude);
  for(const {body,set,o} of views) {
    const state=r.bodyStates.get(body.id),now=performance.now();
    const bytes=otherSurface(r,body,state,now);
    if(set.surfaceBytes!==bytes){r.device.queue.writeTexture({texture:set.surfaceTex},bytes,{bytesPerRow:4096},[1024,512]);set.surfaceBytes=bytes;}
    if(set.heightGrid!==state.heightGrid||(set.heightFilled!==state.heightFilled&&now-(set.heightAt||0)>1000)){
      r.device.queue.writeTexture({texture:set.heightTex},encodeHeights(state.heightGrid),{bytesPerRow:HEIGHT_W},[HEIGHT_W,HEIGHT_H]);
      set.heightGrid=state.heightGrid;set.heightFilled=state.heightFilled;set.heightAt=now;
    }
    const far=planetFactorsFor(body,o.altitude,true);
    const factors={...far,globe:far.globe*visible,space:0,mesh:pf.mesh,registry:pf.registry,fog:[0,0,0]};
    const level=farDrawLevel(body,o.altitude);
    if(!(factors.globe>0)||level==='skip')continue;
    const uniform=spaceUniform(o.view,o.sun,factors,r.bodyRects?.[body.id]??FALLBACK_RECTS,r.timeOfDay,near,200000,undefined,{radius:body.radius,centre:body.centre,moons:OTHER_MOONS});
    uniform[47]=now/1000%3600;
    r.device.queue.writeBuffer(set.spaceBuffer,0,uniform);
    pass.setPipeline(set.spacePipeline);pass.setBindGroup(0,set.spaceGroup);pass.draw(3);
    if(pf.mesh&&level==='full'){
      const eye=o.view.eye,patches=patchesAt(eye[0],eye[2],Math.max(0,eye[1]),body.id==='azeroth'?undefined:{radius:body.radius,centre:body.centre,maxLevel:body.maxLevel});
      r.device.queue.writeBuffer(set.patchBuffer,0,packPatches(patches));
      pass.setPipeline(set.patchPipeline);pass.setBindGroup(0,set.patchGroup);pass.setVertexBuffer(0,set.patchBuffer);pass.draw(PATCH_GRID*PATCH_GRID*6,patches.length);
    }
  }
}
/** Cloud shell of every other resident body that has one (body.clouds), seen from the camera as if it hovered over that body; one uniform, mask and bind group per body so several can share a pass. */
export function drawBodyClouds(r,pass,time,daylight,near) {
  const a=activeBody();
  for(const body of otherBodies(r)) {
    const set=r.otherSets?.[body.id],manifest=r.bodyManifests?.[body.id];
    if(!body.clouds||!set||!manifest?.world_bounds||!r.cloudPipeline||!r.depth)continue;
    const o=otherView(r.view,a,body,r.timeOfDay);
    if(!o||Math.asin(Math.min(1,body.radius/(body.radius+o.altitude)))<.002)continue;
    const space=planetFactorsFor(body,o.altitude,true).space;
    set.cloudMask??=new CloudMask(r.device);set.cloudMask.update(r.bodyRects?.[body.id]??FALLBACK_RECTS);
    set.cloudBuffer??=r.device.createBuffer({size:240,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    if(set.cloudDepth!==r.depth){
      set.cloudGroup=r.device.createBindGroup({layout:r.cloudPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:set.cloudBuffer}},
        {binding:1,resource:r.depth.createView()},{binding:4,resource:set.cloudMask.view},{binding:5,resource:set.cloudMask.sampler}]});
      set.cloudDepth=r.depth;
    }
    const dayHere=Math.min(1,Math.max(0,(o.sun[1]+.1)/.35)),cu=cloudUniform(o.view,time,dayHere,manifest,near,undefined,undefined,r.timeOfDay,{space,farBoost:space,flowScale:r.planet?.flowScale,flowCycles:r.planet?.flowCycles,tierMix:0});
    cu.set([...o.sun,o.sun[1]],32);
    r.device.queue.writeBuffer(set.cloudBuffer,0,cu);
    pass.setPipeline(r.cloudPipeline);pass.setBindGroup(0,set.cloudGroup);pass.draw(3);
  }
}
export function drawPlanet(r,pass,pf,near) {
  if(r.planetBody!==activeBody().id)return;
  const parent=activeBody().parent,parked=parent&&wantsDisc(activeBody())?r.bodyStates?.get(parent)?.surfaceBytes:undefined;
  if(parked&&r.discTex&&r.discBytes!==parked){r.device.queue.writeTexture({texture:r.discTex},parked,{bytesPerRow:4096},[1024,512]);r.discBytes=parked;}
  const rects=r.planetRects(),key=JSON.stringify(rects);
  (r.bodyRects??={})[activeBody().id]=rects;
  if(pf.registry&&r.surfaceKey!==key){
    r.surfaceRegistry=// With real data the minimap colours own the land: procedural fill would paint green over the unseen coast water.
    createRegistry([...defaultManifest(undefined,rects).map(c=>r.manifest?.world_bounds||!activeBody().sea?{...c,provider:{sample:()=>({skip:true})}}:c),adtChunk(r.colourGrid)]);
    r.surfaceBytes=bakeSurface(r.surfaceRegistry);r.colourDirty.clear();r.surfaceDirty=true;r.surfaceKey=key;
  }
  if(pf.registry&&r.colourDirty.size&&performance.now()-(r.colourAt||0)>1000){
    for(const k of r.colourDirty)r.surfaceBytes.set(surfaceTexel(r.surfaceRegistry,k%1024,Math.floor(k/1024),1024,512),k*4);
    r.colourDirty.clear();r.colourAt=performance.now();r.surfaceDirty=true;
  }
  if(r.lightsKey!==key){
    r.nightBake=createNightBake();for(const s of settlementPositions(r.manifest,rects))r.nightBake.add(s);r.litCells=new Map();r.litQueue=[];r.nightBake.rows=[0,NIGHT_H-1];r.lightsKey=key;
  }
  // Lit WMO/lamp spots seen by the ground renderer join the bake a few per frame; only touched rows are re-uploaded.
  for(let n=0;n<16&&r.litQueue?.length;n++)r.nightBake.add(r.litQueue.pop());
  if(r.nightBake.rows){const [y0,y1]=r.nightBake.rows;r.nightBake.rows=null;
    r.device.queue.writeTexture({texture:r.lightsTex,origin:[0,y0,0]},r.nightBake.out,{offset:y0*NIGHT_W*4,bytesPerRow:NIGHT_W*4},[NIGHT_W,y1-y0+1]);}
  if(r.surfaceDirty){r.device.queue.writeTexture({texture:r.surfaceTex},r.surfaceBytes,{bytesPerRow:4096},[1024,512]);r.surfaceDirty=false;}
  // On an Elune chart the sun is the true one in the pod's local frame, matching the moon-slot shading seen from Azeroth.
  const sun=r.sunLocal??sunDirection(r.timeOfDay);
  const uniform=spaceUniform(r.view,sun,pf,rects,r.timeOfDay,near,200000,undefined,r.sharedFrame());
  uniform[47]=performance.now()/1000%3600;// wall-clock seconds for light twinkle
  r.device.queue.writeBuffer(r.spaceBuffer,0,uniform);
  pass.setPipeline(r.spacePipeline);pass.setBindGroup(0,r.spaceGroup);pass.draw(3);
}
export function drawLights(r,pass,pf) {
  if(r.planetBody!==activeBody().id)return;
  if(r.view.eye[1]<2500||!r.lightsGroup)return;
  pass.setPipeline(r.lightsPipeline);pass.setBindGroup(0,r.lightsGroup);pass.draw(3);
}
export function drawPatches(r,pass) {
  if(r.planetBody!==activeBody().id)return;
  if(r.heightDirty&&performance.now()-(r.heightAt||0)>1000){
    r.device.queue.writeTexture({texture:r.heightTex},encodeHeights(r.heightGrid),{bytesPerRow:HEIGHT_W},[HEIGHT_W,HEIGHT_H]);
    r.heightDirty=false;r.heightAt=performance.now();
  }
  const eye=r.view.eye,patches=patchesAt(eye[0],eye[2],Math.max(0,eye[1]),activeBody().id==='elune'?{radius:ELUNE.radius,centre:activeFramedBody().centre,maxLevel:ELUNE.maxLevel}:activeFramedBody().centre!==activeBody().centre?{centre:activeFramedBody().centre}:undefined);
  r.device.queue.writeBuffer(r.patchBuffer,0,packPatches(patches));
  r.patchCount=patches.length;
  pass.setPipeline(r.patchPipeline);pass.setBindGroup(0,r.patchGroup);pass.setVertexBuffer(0,r.patchBuffer);pass.draw(PATCH_GRID*PATCH_GRID*6,patches.length);
}
export function drawSkyDome(r,pass) {
  const alpha=nightAlpha(r.localTime??r.timeOfDay);
  if(!r.skyDome||alpha<.01)return;
  const k=new Float32Array(16),v=r.view;
  k.set(v.look,0);k[3]=v.aspect;k.set(v.right,4);k.set(v.up,8);k[12]=nightAngle(r.localTime??r.timeOfDay);k[13]=alpha;
  r.device.queue.writeBuffer(r.domeBuffer,0,k);
  pass.setPipeline(r.domePipeline);pass.setVertexBuffer(0,r.skyDome.vertices);pass.setIndexBuffer(r.skyDome.indices,'uint32');
  for(const b of r.skyDome.batches){pass.setBindGroup(0,b.group);pass.drawIndexed(b.count,1,b.first);}
}
/** Fades a zone sky sample to the global look as weight (planet.zone) goes 1 -> 0; weight 0 is identical everywhere. */
export function zoneBlend(game,weight=1) {
  if(!game||weight>=1)return game;
  const g={fog:[.08,.15,.2],sun:[1,.96,.88],horizon:[.55,.7,.8],mid:[.3,.5,.75],cloud:[1,1,1],cloud2:[.55,.6,.7]},out={...game};
  for(const k in g)if(game[k])out[k]=game[k].map((v,i)=>i<3?g[k][i]+(v-g[k][i])*weight:v);
  return out;
}
export function sampleSky(r) {
  const region=r.manifest?.regions[r.sceneRegion],map={Azeroth:0,Kalimdor:1}[region?.map];
  if(!r.skyCatalog||map===undefined)return undefined;
  const [x,z]=mapPosition(region,r.view.eye[0],r.view.eye[2]);
  return r.skyCatalog.sample(map,x,z,r.localTime??r.timeOfDay);
}
/** Records a lit (emissive) model instance at render-space [x,z]; one spot per 160-yd cell, size grows with how many lit models share it. */
export function noteLitInstance(r,x,z) {
  if(!r.litCells)return;
  const k=Math.floor(x/160)+','+Math.floor(z/160),c=r.litCells.get(k);
  if(!c){const spot={n:1,s:litSpot(x,z,1)};r.litCells.set(k,spot);r.litQueue.push(spot.s);return;}
  c.n++;if(c.n===4||c.n===16||c.n===64){c.s=litSpot(x,z,c.n);r.litQueue.push(c.s);}
}
