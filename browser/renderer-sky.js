import {MINIMAP_SIZE} from './terrain-stream.js';
import {sunDirection} from './clouds.js';
import {schematicRects} from './worldmap.js';
import {viewFrom} from './body-sky.js';
import {AZEROTH,ELUNE} from './bodies.js';
import {patchesAt,packPatches,PATCH_GRID} from './globe-patches.js';
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
  if(e.placement&&e.rgba){const b=r.manifest?.version===4?ELUNE:{centre:WORLD_CENTRE,radius:PLANET_RADIUS};splatMinimap(r.colourGrid,e.rgba,MINIMAP_SIZE,e.placement,b.centre,b.radius,r.colourDirty,r.heightGrid);r.horizonMini.delete(key);}
}
export function planetRects(r) {return r.manifest?.world_bounds?schematicRects(r.manifest):FALLBACK_RECTS;}
/** Shared-space view (design/elune.md D3): Elune is always the moon-slot sphere seen from Azeroth when enabled; v4 charts are Elune looking back at Azeroth. */
export function sharedFrame(r) {
  if(r.manifest?.version===4)return viewFrom(ELUNE,r.timeOfDay);
  return r.sharedSpace?viewFrom(AZEROTH,r.timeOfDay):undefined;
}
export function drawPlanet(r,pass,pf,near) {
  if(r.planetBody!==(r.manifest?.version===4?'elune':'azeroth'))return;
  const rects=r.planetRects(),key=JSON.stringify(rects);
  if(pf.registry&&r.surfaceKey!==key){
    r.surfaceRegistry=// With real data the minimap colours own the land: procedural fill would paint green over the unseen coast water.
    createRegistry([...defaultManifest(undefined,rects).map(c=>r.manifest?.world_bounds?{...c,provider:{sample:()=>({skip:true})}}:c),adtChunk(r.colourGrid)]);
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
  const uniform=spaceUniform(r.view,sunDirection(r.timeOfDay),pf,rects,r.timeOfDay,near,200000,undefined,r.sharedFrame());
  uniform[47]=performance.now()/1000%3600;// wall-clock seconds for light twinkle
  r.device.queue.writeBuffer(r.spaceBuffer,0,uniform);
  pass.setPipeline(r.spacePipeline);pass.setBindGroup(0,r.spaceGroup);pass.draw(3);
}
export function drawLights(r,pass,pf) {
  if(r.planetBody!==(r.manifest?.version===4?'elune':'azeroth'))return;
  if(r.view.eye[1]<2500||!r.lightsGroup)return;
  pass.setPipeline(r.lightsPipeline);pass.setBindGroup(0,r.lightsGroup);pass.draw(3);
}
export function drawPatches(r,pass) {
  if(r.planetBody!==(r.manifest?.version===4?'elune':'azeroth'))return;
  if(r.heightDirty&&performance.now()-(r.heightAt||0)>1000){
    r.device.queue.writeTexture({texture:r.heightTex},encodeHeights(r.heightGrid),{bytesPerRow:HEIGHT_W},[HEIGHT_W,HEIGHT_H]);
    r.heightDirty=false;r.heightAt=performance.now();
  }
  const eye=r.view.eye,patches=patchesAt(eye[0],eye[2],Math.max(0,eye[1]),r.manifest?.version===4?{radius:ELUNE.radius,centre:ELUNE.centre,maxLevel:ELUNE.maxLevel}:undefined);
  r.device.queue.writeBuffer(r.patchBuffer,0,packPatches(patches));
  r.patchCount=patches.length;
  pass.setPipeline(r.patchPipeline);pass.setBindGroup(0,r.patchGroup);pass.setVertexBuffer(0,r.patchBuffer);pass.draw(PATCH_GRID*PATCH_GRID*6,patches.length);
}
export function drawSkyDome(r,pass) {
  const alpha=nightAlpha(r.timeOfDay);
  if(!r.skyDome||alpha<.01)return;
  const k=new Float32Array(16),v=r.view;
  k.set(v.look,0);k[3]=v.aspect;k.set(v.right,4);k.set(v.up,8);k[12]=nightAngle(r.timeOfDay);k[13]=alpha;
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
  return r.skyCatalog.sample(map,x,z,r.timeOfDay);
}
/** Records a lit (emissive) model instance at render-space [x,z]; one spot per 160-yd cell, size grows with how many lit models share it. */
export function noteLitInstance(r,x,z) {
  if(!r.litCells)return;
  const k=Math.floor(x/160)+','+Math.floor(z/160),c=r.litCells.get(k);
  if(!c){const spot={n:1,s:litSpot(x,z,1)};r.litCells.set(k,spot);r.litQueue.push(spot.s);return;}
  c.n++;if(c.n===4||c.n===16||c.n===64){c.s=litSpot(x,z,c.n);r.litQueue.push(c.s);}
}
