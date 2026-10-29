import {sceneReady} from './scene-stream.js';
import {MINIMAP_SIZE} from './terrain-stream.js';
import {COAST_GPU_LIMIT} from './water-stream.js';
import {maelstromCentre} from './clouds.js';
import {oceanMeshCached} from './ocean-mesh.js';
import {splatHeights} from './height-bake.js';
import {isLandTile,trimRimSpikes} from './land-rect.js';
import {PLANET_RADIUS,WORLD_CENTRE} from './space.js';
import {buildPlanetPipelines} from './renderer-init.js';
import {ELUNE} from './bodies.js';
import {activeBody} from './body-shaders.js';
import {createColourGrid,splatMinimap} from './tile-registry.js';
import {NIGHT_H} from './night-lights.js';
import {AdmissionFade,terrainEdgeMask,readySceneInstances} from './renderer-helpers.js';
// Ocean mesh padding: about half the planet circumference per side (3.04 R), so the fill never wraps over itself.
const OCEAN_FILL=Math.round(PLANET_RADIUS*3.04);
const PLANET_STATE=['heightGrid','colourGrid','colourDirty','horizonMini','surfaceRegistry','surfaceBytes','surfaceKey','nightBake','litCells','litQueue','lightsKey','landRects','farGrid','farMini','farVersion'];
/** Parks the departing body's globe state (height/colour grids, baked surface and night lights) and restores the arriving body's, so a repeat swap re-bakes nothing; a first visit starts from empty grids. */
export function swapPlanetState(r,from,to) {
  r.bodyStates??=new Map();(r.bodyManifests??={})[from]=r.manifest;
  r.bodyStates.set(from,Object.fromEntries(PLANET_STATE.map(k=>[k,r[k]])));
  Object.assign(r,r.bodyStates.get(to)??emptyPlanetState(r));
  r.heightDirty=true;r.heightAt=0;r.surfaceDirty=!!r.surfaceBytes;if(r.nightBake)r.nightBake.rows=[0,NIGHT_H-1];
}
const emptyPlanetState=r=>({heightGrid:new Float32Array(r.heightGrid.length).fill(-Infinity),colourGrid:createColourGrid(),colourDirty:new Set(),horizonMini:new Map(),
  surfaceRegistry:undefined,surfaceBytes:undefined,surfaceKey:undefined,nightBake:undefined,litCells:undefined,litQueue:undefined,lightsKey:undefined,landRects:[],farGrid:createColourGrid(),farMini:new Map(),farVersion:0});
/** Parked globe state of a body that is not the active chart, created on first use. */
export function bodyState(r,id) {
  r.bodyStates??=new Map();
  if(!r.bodyStates.has(id))r.bodyStates.set(id,emptyPlanetState(r));
  return r.bodyStates.get(id);
}
/** Feeds a non-active body's resident engine into its parked state: its far horizon relief lands in that body's own height grid (no GPU work), so its globe can be drawn from real data. Returns whether the event was consumed. */
/** Minimap colour for a body's far globe, kept apart from the active globe's own colour grid so it never changes what the active far renderer draws. A tile needs both its WDL placement and its minimap, in either order. */
export function farColour(s,body,key,part) {
  if(!s.farGrid)return;
  const e={...s.farMini.get(key),...part};s.farMini.set(key,e);
  if(e.placement&&e.rgba){splatMinimap(s.farGrid,e.rgba,MINIMAP_SIZE,e.placement,body.centre,body.radius,new Set(),s.heightGrid);s.farMini.delete(key);s.farVersion=(s.farVersion??0)+1;}
}
export function bodyEvent(r,body,data) {
  if(!r.heightGrid)return false;
  if(data.event==='horizon-material'){farColour(bodyState(r,body.id),body,data.region*4096+data.x+64*data.y,{rgba:data.rgba});return true;}
  if(data.event!=='horizon')return false;
  const state=bodyState(r,body.id);
  if(data.source)farColour(state,body,data.region*4096+data.source[0]+64*data.source[1],{placement:data.placement});
  trimRimSpikes(data.vertices);
  splatHeights(state.heightGrid,data.vertices,data.placement,body.centre,body.radius);
  state.heightFilled=(state.heightFilled??0)+1;
  return true;
}
export function reset(r,{keepPlanet=false}={}) {
  // The globe height/colour grids are chart-lon/lat baked: a body switch must not inherit the previous body's relief (Azeroth peaks became spikes on Elune).
  if(r.heightGrid&&!keepPlanet){r.heightGrid.fill(-Infinity);r.heightDirty=true;r.heightAt=0;r.colourGrid=createColourGrid();r.colourDirty=new Set();r.horizonMini=new Map();r.farGrid=createColourGrid();r.farMini=new Map();r.farVersion=0;}
  r.terrainBundle=undefined;r.terrainBundleBuilds=0;
  r.sceneBundle=undefined;r.sceneBundleBuilds=0;
  r.releaseCraft();
  if(r.particles){r.particles.data.fill(0);r.particles.physical.fill(0);r.particles.frame=undefined;}
  r.setLaunchProps?.([]);r.launchProps=undefined;
  r.craftError=undefined;
  for(const item of [...r.tiles.values(),...r.seams.values(),...r.horizon,...r.water,...r.flags,...r.gates,...r.coast.values()])r.release(item);
  r.tiles.clear();r.seams.clear();r.horizon=[];r.water=[];r.flags=[];r.gates=[];r.coast.clear();r.oceanSpec=undefined;r.oceanFill=undefined;if(!keepPlanet)r.landRects=[];r.coastBytes=0;
  for(const index of r.indices.values())index.destroy();r.indices.clear();
  for(const asset of r.assets.values()){asset.vertices.destroy();asset.indices.destroy();}r.assets.clear();
  for(const texture of r.textures.values())texture.destroy();r.textures.clear();
  r.items.clear();
  for(const e of r.poses.values())e.buffer.destroy();r.poses.clear();r.moves?.clear();
  r.instances=[];r.nearInstances=[];r.farInstances=[];r.farRegion=undefined;
  r.camera=undefined;r.origin=[0,0];
  r.view=undefined;r.terrainView=undefined;
  r.admissionFade?.entries.clear();
  r.admissionFade?.active.clear();
  for(const item of r.materialPending.values())r.releaseMaterial(item.gpu);
  r.materialPending.clear();
  for(const texture of r.minimapAtlases)texture.destroy();r.minimapAtlases=[];
  r.manifest=undefined;r.pendingEvents=[];
}
export function configure(r,manifest) {
  r.manifest=manifest;
  r.minimapAtlases=manifest.regions.map(()=>r.device.createTexture({
    size:[64*MINIMAP_SIZE,64*MINIMAP_SIZE],format:'rgba8unorm',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
  const [x,z]=manifest.ocean;
  // Open ocean beyond the authored rectangle: the same water mesh extended to roughly half the planet circumference.
  const pad=OCEAN_FILL,[,,right,bottom]=manifest.ocean;
  r.landRects=r.landRects||[];if(manifest.version!==4){r.oceanSpec={manifest:{...manifest,ocean:[x-pad,z-pad,right+pad,bottom+pad],whirlpool:manifest.world_bounds&&maelstromCentre(manifest)},origin:[x-pad,z-pad]};r.oceanFill=r.drawable(oceanMeshCached(r.oceanSpec.manifest,96,r.landRects),r.oceanSpec.origin);r.water.push(r.oceanFill);}
  if(activeBody().id==='elune')void buildPlanetPipelines(r,ELUNE).catch(e=>console.error(e));
  const pending=r.pendingEvents;r.pendingEvents=[];
  for(const data of pending)r.event(data);
}
export function event(r,data) {
  if(!r.manifest){
    if(r.pendingEvents.length>=16384)throw Error('World startup event budget exceeded');
    r.pendingEvents.push(data);return;
  }
  if(data.event==='pose'){r.pose(data);return;}
  if(data.event==='npc-moves'){r.npcMoves(data);return;}
  if(data.event==='craft'){
    const craft=r.buildCraft(data,10318,'10318');
    r.releaseCraft();
    r.craftError=undefined;
    r.dataCraft=craft;r.craft=r.override??craft;
  }
  else if(data.event==='craft-error')r.craftError=data.error;
  else if(data.event==='horizon-index'){
    const indices=r.buffer(data.indices,GPUBufferUsage.INDEX);
    r.indices.get(data.region)?.destroy();r.indices.set(data.region,indices);
    r.terrainBundle=undefined;
  }
  else if(data.event==='horizon'){trimRimSpikes(data.vertices);const chartBody=activeBody();splatHeights(r.heightGrid,data.vertices,data.placement,chartBody.centre,chartBody.radius);r.heightDirty=true;
    farColour(r,activeBody(),data.region*4096+data.source[0]+64*data.source[1],{placement:data.placement});r.horizonColour(data.region*4096+data.source[0]+64*data.source[1],{placement:data.placement});r.horizon.push({...r.drawable(data.vertices,data.placement,r.minimapAtlases[data.region]),
    region:data.region,near:data.near,cell:data.source[0]+64*data.source[1]});
    const hb=r.horizon[r.horizon.length-1].bounds;
    if(hb&&r.oceanSpec&&isLandTile(data.vertices)){const rect=[hb[0][0],hb[0][2],hb[1][0],hb[1][2]];if(!r.landRects.some(q=>q[0]===rect[0]&&q[1]===rect[1]&&q[2]===rect[2]&&q[3]===rect[3])){r.landRects.push(rect);r.oceanDirty=true;}}}
  else if(data.event==='horizon-material'){
    if(data.rgba.length!==MINIMAP_SIZE*MINIMAP_SIZE*4||!r.minimapAtlases[data.region]||
      !Number.isInteger(data.x)||!Number.isInteger(data.y)||data.x<0||data.x>=64||data.y<0||data.y>=64)
      throw Error('Invalid minimap upload');
    farColour(r,activeBody(),data.region*4096+data.x+64*data.y,{rgba:data.rgba});
    r.device.queue.writeTexture({texture:r.minimapAtlases[data.region],origin:[data.x*MINIMAP_SIZE,data.y*MINIMAP_SIZE]},
      data.rgba,{bytesPerRow:MINIMAP_SIZE*4},[MINIMAP_SIZE,MINIMAP_SIZE]);
  }
  else if(data.event==='terrain-material'){
    if(!r.tiles.has(data.index))return;
    r.releaseMaterial(r.materialPending.get(data.index)?.gpu);
    r.materialPending.set(data.index,{data,cursor:0});
  }
  else if(data.event==='exterior-water')r.water.push(r.drawable(data.vertices,data.placement));
  else if(data.event==='coast-water'){
    const entry=r.manifest.tiles[data.index],v=data.vertices;
    if(!Number.isInteger(data.index)||!entry||!(v instanceof Float32Array)||!v.length||v.length%21||
      v.byteLength>8*1024*1024||!Array.isArray(data.removed)||data.removed.includes(data.index)||
      new Set(data.removed).size!==data.removed.length)throw Error('Invalid distant water payload');
    const bytes=r.coastBytes+v.byteLength-(r.coast.get(data.index)?.buffer.size||0)
      -data.removed.reduce((n,index)=>n+(r.coast.get(index)?.buffer.size||0),0);
    if(bytes>COAST_GPU_LIMIT)throw Error('Distant water GPU budget exceeded');
    for(const index of data.removed){r.release(r.coast.get(index));r.coast.delete(index);}
    r.release(r.coast.get(data.index));
    const region=r.manifest.regions[entry.region];
    const item=r.drawable(v,[region.placement[0]+(entry.x-region.tile_origin[0])*1600/3,
      region.placement[1]+(entry.y-region.tile_origin[1])*1600/3]);
    let first=v.length/7;
    while(first>0&&v[(first-1)*7+6]===4)first--;
    if(first<v.length/7){
      item.backing={...item,first,count:v.length/7-first};
    }
    r.coast.set(data.index,item);
    r.coastBytes=bytes;
  }
  else if(data.event==='detail') {
    for(const index of data.removed){
      r.release(r.tiles.get(index));r.tiles.delete(index);
      r.releaseMaterial(r.materialPending.get(index)?.gpu);r.materialPending.delete(index);
    }
    for(const t of data.tiles){
      trimRimSpikes(t.vertices);
      r.release(r.tiles.get(t.index));
      r.releaseMaterial(r.materialPending.get(t.index)?.gpu);r.materialPending.delete(t.index);
      const entry=r.manifest.tiles[t.index];
      let liquid=t.liquid;
      if(liquid===undefined){
        const values=[];
        for(let i=0;i<t.vertices.length;i+=7)if(t.vertices[i+6]===2)values.push(...t.vertices.subarray(i,i+7));
        liquid=new Float32Array(values);
      }
      if(!(liquid instanceof Float32Array)||liquid.length%21||liquid.byteLength>t.vertices.byteLength)
        throw Error('Invalid prepared terrain liquid');
      r.tiles.set(t.index,{...r.drawable(t.vertices,t.placement,r.minimapAtlases[entry.region]),liquid,
        entry,cell:entry.x+64*entry.y});
    }
    const entries=[...r.tiles.values()].map(t=>t.entry);
    for(const tile of r.tiles.values())tile.edgeMask=terrainEdgeMask(tile.entry,entries);
    for(const item of r.seams.values())r.release(item);r.seams.clear();
    for(const s of data.seams)if(s.vertices.length){
      const entry=r.manifest.tiles[s.index];
      r.seams.set(s.index,{...r.drawable(s.vertices,r.tiles.get(s.index).placement,r.minimapAtlases[entry.region]),
        cell:entry.x+64*entry.y});
    }
  } else if(data.event==='scene'||data.event==='far-scene') {
    const far=data.event==='far-scene',ownerRegion=far?r.farRegion:r.sceneRegion;
    const previousInstances=far?(r.farInstances||[]):(r.nearInstances||r.instances);
    let instances=data.instances;
    if(data.instanceOrder!==undefined){
      if(!Array.isArray(instances)||!Array.isArray(data.instanceOrder))throw Error('Invalid scene instance updates');
      if(data.instanceOrder.some(id=>typeof id!=='string'||!id) ||
        instances.some(i=>!i||typeof i.id!=='string'||!i.id))throw Error('Invalid scene instance IDs');
      const order=new Set(data.instanceOrder),updates=new Map(instances.map(i=>[i.id,i]));
      if(order.size!==data.instanceOrder.length || updates.size!==instances.length ||
        instances.some(i=>!order.has(i.id)))throw Error('Invalid scene instance IDs');
      const previous=new Map((data.region===ownerRegion?previousInstances:[]).map(i=>[i.id,i]));
      instances=data.instanceOrder.map(id=>{
        const instance=updates.get(id)||previous.get(id);
        if(!instance)throw Error(`Missing scene instance ${id}`);
        return instance;
      });
    } else if(instances===undefined){
      if(data.region!==ownerRegion)throw Error('Scene region changed without instances');
    } else if(!Array.isArray(instances))throw Error('Invalid scene instances');
    if(far&&[...data.removedAssets,...data.removedTextures,...data.assets.map(a=>a.key),
      ...data.textures.map(t=>t.key),...(instances||[]).map(i=>i.key)]
      .some(key=>typeof key!=='string'||!key.startsWith('far:')))throw Error('Invalid distant resource ownership');
    if(far&&data.reset)r.clearFar();
    for(const key of data.removedAssets){const a=r.assets.get(key);a?.vertices.destroy();a?.indices.destroy();r.assets.delete(key);}
    for(const key of data.removedTextures){r.textures.get(key)?.destroy();r.textures.delete(key);}
    for(const a of data.assets){
      const batches=r.prepareBatches(a.batches);
      if(far)for(const batch of batches)if(batch.texture)batch.texture=`far:${batch.texture}`;
      const vertices=r.buffer(a.vertices,GPUBufferUsage.VERTEX);
      let indices;
      try {indices=r.buffer(a.indices,GPUBufferUsage.INDEX);}
      catch(error){vertices.destroy();throw error;}
      const asset={vertices,indices,batches,bounds:a.bounds,bytes:a.vertices.byteLength+a.indices.byteLength};
      const previous=r.assets.get(a.key);previous?.vertices.destroy();previous?.indices.destroy();
      r.assets.set(a.key,asset);
    }
    for(const t of data.textures){
      const texture=r.texture(t.width,t.height,t.rgba);
      r.textures.get(t.key)?.destroy();r.textures.set(t.key,texture);
    }
    if(instances!==undefined){
      if(far){r.farInstances=instances;r.farRegion=data.region;}
      else {r.nearInstances=instances;r.sceneRegion=data.region;}
    }
    const merged=readySceneInstances(r.nearInstances||(far?r.instances:previousInstances),
      r.farRegion===r.sceneRegion?r.farInstances||[]:[],r.assets,r.textures);
    if(merged.length!==r.instances.length||merged.some((i,n)=>i!==r.instances[n]))r.instances=merged;
    r.admissionFade??=new AdmissionFade();
    r.admissionFade.update(r.instances.filter(i=>r.assets.has(i.key)&&
      (!i.distant||sceneReady(i,r.assets,r.textures))).map(i=>i.id),performance.now()/1000);
    const wanted=new Set(r.instances.map(i=>i.id));
    for(const [key,item] of r.items)if((wanted&&!wanted.has(item.id)) || !r.assets.has(item.key)){
      r.items.delete(key);
    }
  }
}
export function clearFar(r) {
  for(const [key,a] of r.assets)if(key.startsWith('far:')){
    a.vertices.destroy();a.indices.destroy();r.assets.delete(key);
  }
  for(const [key,t] of r.textures)if(key.startsWith('far:')){t.destroy();r.textures.delete(key);}
  for(const [key,item] of r.items)if(item.key.startsWith('far:'))r.items.delete(key);
  r.farInstances=[];r.farRegion=undefined;
  r.instances=r.nearInstances||r.instances.filter(i=>!i.distant);
  r.sceneBundle=undefined;
}
