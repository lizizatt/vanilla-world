import {modelPath} from './scene-stream.js';

export async function loadCraft(source,wasm,emit) {
 try {
  const models=await source.read('DBFilesClient\\CreatureModelData.dbc');
  const displays=await source.read('DBFilesClient\\CreatureDisplayInfo.dbc');
  const display=JSON.parse(wasm.scene_craft_display(models,displays)),path=modelPath(display.path);
  const encoded=await source.read(path),metadata={...display,...JSON.parse(wasm.scene_craft_metadata(encoded))};
  const model=wasm.SceneModel.m2(encoded,path,JSON.stringify(display.skins));
  let asset;
  try{
    asset={vertices:model.vertices(),indices:model.indices(),batches:JSON.parse(model.metadata()).batches};
  }finally{model.free();}
  let bytes=asset.vertices.byteLength+asset.indices.byteLength;
  if(bytes>2*1024*1024||asset.indices.length>60000)throw Error('Authored craft exceeds mesh budget');
  const paths=[...new Set(asset.batches.map(b=>b.texture&&modelPath(b.texture)).filter(Boolean))];
  if(paths.length>16)throw Error('Authored craft exceeds 16 textures');
  const textures=[];
  for(const key of paths){
    const handle=new wasm.SceneTexture(await source.read(key));
    let texture;
    try{texture={key,...JSON.parse(handle.metadata()),rgba:handle.rgba()};}
    finally{handle.free();}
    bytes+=texture.rgba.byteLength;
    if(bytes>32*1024*1024)throw Error('Authored craft exceeds 32 MiB decoded budget');
    textures.push(texture);
  }
  const triangles=asset.indices.length/3;
  emit({event:'craft',asset,textures,metadata},[asset.vertices.buffer,asset.indices.buffer,...textures.map(t=>t.rgba.buffer)]);
  return {ready:true,metadata,bytes,textureCount:textures.length,triangles};
 }catch(error){
  emit({event:'craft-error',error:`Authored craft: ${error.message||error}`});
  throw error;
 }
}
