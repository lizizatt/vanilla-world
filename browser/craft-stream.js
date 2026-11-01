import {modelPath} from './scene-stream.js';

// Reads one creature model plus its skin textures through `read`, as the renderer's craft payload (stand-pose mesh, posed seat).
async function readCraftModel(read,wasm,display) {
  const path=modelPath(display.path);
  const encoded=await read(path),metadata={...display,...JSON.parse(wasm.scene_craft_metadata(encoded))};
  const model=wasm.SceneModel.craft(encoded,path,JSON.stringify(display.skins));
  let asset;
  try{
    const posed=JSON.parse(model.metadata());
    asset={vertices:model.vertices(),indices:model.indices(),batches:posed.batches};
    metadata.pose=posed.animation;
    metadata.posedAttachment0=posed.posedAttachment0;
  }finally{model.free();}
  let bytes=asset.vertices.byteLength+asset.indices.byteLength;
  if(bytes>2*1024*1024||asset.indices.length>60000)throw Error('Authored craft exceeds mesh budget');
  const paths=[...new Set(asset.batches.map(b=>b.texture&&modelPath(b.texture)).filter(Boolean))];
  if(paths.length>16)throw Error('Authored craft exceeds 16 textures');
  const textures=[];
  for(const key of paths){
    const handle=new wasm.SceneTexture(await read(key));
    let texture;
    try{texture={key,...JSON.parse(handle.metadata()),rgba:handle.rgba()};}
    finally{handle.free();}
    bytes+=texture.rgba.byteLength;
    if(bytes>32*1024*1024)throw Error('Authored craft exceeds 32 MiB decoded budget');
    textures.push(texture);
  }
  return {asset,textures,metadata,bytes};
}

export async function loadCraft(source,wasm,emit,shouldDefer=()=>false) {
 const read=async path=>{
   const bytes=await source.read(path,{shouldDefer});
   if(shouldDefer())throw Object.assign(Error('Obsolete craft load'),{code:'DEFERRED'});
   return bytes;
 };
 try {
  const models=await read('DBFilesClient\\CreatureModelData.dbc');
  const displays=await read('DBFilesClient\\CreatureDisplayInfo.dbc');
  const display=JSON.parse(wasm.scene_craft_display(models,displays));
  const {asset,textures,metadata,bytes}=await readCraftModel(read,wasm,display);
  const triangles=asset.indices.length/3;
  emit({event:'craft',asset,textures,metadata},[asset.vertices.buffer,asset.indices.buffer,...textures.map(t=>t.rgba.buffer)]);
  return {ready:true,metadata,bytes,textureCount:textures.length,triangles};
 }catch(error){
  if(error.code!=='DEFERRED')emit({event:'craft-error',error:`Authored craft: ${error.message||error}`});
  throw error;
 }
}

// Garage skin: any creature display id from the user's own Data as a craft payload (nothing is cached or shipped).
// `frames` are the model's own Stand (0) and Walk (4) clips sampled evenly over one loop: idle motion and rolling wheels.
const CLIP_SAMPLES=16,FRAME_BUDGET=4*1024*1024;
function sampleFrames(wasm,encoded,path,skins,vertexCount) {
  let actor;
  try{
    actor=wasm.SceneActor.create(encoded,path,JSON.stringify(skins));
    if(actor.vertex_count()!==vertexCount)return undefined;
    const n=Math.max(4,Math.min(CLIP_SAMPLES,Math.floor(FRAME_BUDGET/(2*vertexCount*48)))),frames={};
    for(const [name,clip] of [['idle',0],['drive',4]]){
      const duration=actor.duration(clip);
      if(duration>0)frames[name]={duration,poses:Array.from({length:n},(_,i)=>Float32Array.from(actor.pose(clip,duration*i/n)))};
    }
    return frames.idle?frames:undefined;
  }catch{return undefined;}
  finally{actor?.free();}
}
export async function loadCraftModel(source,wasm,displayId) {
  const id=Number(displayId);
  if(!Number.isInteger(id)||id<=0)throw Error('Invalid creature display id');
  const read=path=>source.read(path);
  const [models,displays,extra]=await Promise.all([read('DBFilesClient\\CreatureModelData.dbc'),read('DBFilesClient\\CreatureDisplayInfo.dbc'),read('DBFilesClient\\CreatureDisplayInfoExtra.dbc').catch(()=>new Uint8Array())]);
  const row=JSON.parse(wasm.scene_resolve_displays(models,displays,extra,Uint32Array.of(id)))[id];
  if(!row?.path)throw Error(`Creature display ${id} is unavailable in this Data`);
  const display={display:id,path:row.path,scale:row.scale,skins:row.skins.slice(0,3)};
  const {asset,textures,metadata}=await readCraftModel(read,wasm,display);
  const frames=sampleFrames(wasm,await read(modelPath(display.path)),modelPath(display.path),display.skins,asset.vertices.length/12);
  return {asset,textures,metadata,frames};
}
// Preview tooling: one BLP from the user's Data folder as a craft-payload texture (key is the renderer's model path).
export async function loadPropTexture(source,wasm,path) {
  const key=modelPath(path),tex=new wasm.SceneTexture(await source.read(key));
  try{return {key,...JSON.parse(tex.metadata()),rgba:tex.rgba()};}finally{tex.free();}
}

// Preview tooling: any M2 in the user's Data folder as a craft-style payload (vertices in scene space, textures decoded).
export async function loadProp(source,wasm,path) {
  const handle=wasm.SceneModel.m2(await source.read(path),path,'[]'),posed=JSON.parse(handle.metadata());
  let asset;
  try{asset={vertices:handle.vertices(),indices:handle.indices(),batches:posed.batches};}finally{handle.free();}
  const textures=[];
  for(const key of new Set(asset.batches.map(b=>b.texture&&modelPath(b.texture)).filter(Boolean))){
    const tex=new wasm.SceneTexture(await source.read(key));
    try{textures.push({key,...JSON.parse(tex.metadata()),rgba:tex.rgba()});}finally{tex.free();}
  }
  return {asset,textures,bounds:posed.bounds};
}
