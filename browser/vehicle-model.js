// Turns a shipped GLB (see glb.js) into the renderer's craft payload, plus the procedural exhaust flame.
// Only `decodeImages` touches browser APIs; everything else is pure so it can be tested in node.
import {parseGlb,buildVehicle,vehicleMetadata} from './glb.js';

// Cone opening toward model -x (behind the craft): hot base at the exhaust, fading tip 3 yd back, radius .5 yd.
export function flameAsset(segments=8,length=3,radius=.5) {
  const vertices=[],indices=[];
  const push=(x,y,z,rgba)=>vertices.push(x,y,z,0,0,1,0,0,...rgba);
  push(0,0,0,[1,.9,.5,.9]);
  push(-length,0,0,[1,.25,0,0]);
  for(let i=0;i<segments;i++){const a=i/segments*Math.PI*2;push(0,Math.cos(a)*radius,Math.sin(a)*radius,[1,.55,.1,.6]);}
  for(let i=0;i<segments;i++){const a=2+i,b=2+(i+1)%segments;indices.push(0,a,b,1,b,a);}
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),
    batches:[{firstIndex:0,indexCount:indices.length,texture:null,blend:'add',doubleSided:true,noDepthWrite:true,emissive:1}]};
}

export function vehiclePayload(buffer,images=[]) {
  const built=buildVehicle(parseGlb(buffer)),metadata=vehicleMetadata(built);
  return {asset:{vertices:built.vertices,indices:built.indices,batches:built.batches},textures:images,metadata,
    flame:metadata.exhausts.length?flameAsset():undefined,imageSources:built.images};
}

async function decodeImages(sources) {
  return Promise.all(sources.map(async({key,mime,bytes})=>{
    const bitmap=await createImageBitmap(new Blob([bytes],{type:mime})),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),g=canvas.getContext('2d');
    g.drawImage(bitmap,0,0);bitmap.close();
    const {data,width,height}=g.getImageData(0,0,canvas.width,canvas.height);
    return {key,width,height,rgba:new Uint8Array(data.buffer)};
  }));
}

// Throws on any failure (missing file, SPA HTML fallback, bad GLB); callers fall back to the default craft.
export async function loadVehicleModel(skin,fetcher=fetch) {
  const response=await fetcher(skin.model);
  if(!response.ok)throw new Error(`${skin.model}: HTTP ${response.status}`);
  const payload=vehiclePayload(await response.arrayBuffer());
  payload.textures=await decodeImages(payload.imageSources);
  delete payload.imageSources;payload.metadata.scale=skin.scale??1;payload.key=`glb:${skin.id}`;
  return payload;
}
