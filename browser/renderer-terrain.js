import {bundleFormats} from './render-passes.js';
import {TERRAIN_TEXTURE_SIZE} from './terrain-stream.js';
import {oceanMeshCached} from './ocean-mesh.js';
import {dropPlaceholderTriangles} from './land-rect.js';
import {flagMesh,gateMesh} from './race-flags.js';

export function buffer(r,data,usage) {
  const buffer=r.device.createBuffer({size:Math.max(4,data.byteLength),usage,mappedAtCreation:true});
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));
  buffer.unmap();return buffer;
}
export function texture(r,width,height,rgba) {
  const texture=r.device.createTexture({size:[width,height],format:'rgba8unorm',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  r.device.queue.writeTexture({texture},rgba,{bytesPerRow:width*4},[width,height]);
  return texture;
}
export function drawable(r,vertices,placement,map=r.emptyMap) {
  const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<vertices.length;i+=7)for(let a=0;a<3;a++){
    low[a]=Math.min(low[a],vertices[i+a]);high[a]=Math.max(high[a],vertices[i+a]);
  }
  for(const b of [low,high]){b[0]+=placement[0];b[2]+=placement[1];}
  return {buffer:r.buffer(vertices,GPUBufferUsage.VERTEX),count:vertices.length/7,placement,
    bounds:vertices.length?[low,high]:undefined,
    group:r.device.createBindGroup({layout:r.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:r.frameUniforms,size:240}},{binding:1,resource:map.createView()},{binding:2,resource:r.mapSampler},
      {binding:3,resource:r.waterNormals.createView()},{binding:4,resource:r.waveSampler},
      {binding:5,resource:{buffer:r.waveUniforms}},{binding:6,resource:r.waveMaskTexture.createView()},
      {binding:7,resource:{buffer:r.beachUniforms}},{binding:8,resource:r.shoreTexture.createView()}]})};
}
export function setFlags(r,positions) {
  for(const item of r.flags)r.release(item);
  r.flags=positions.map(p=>r.drawable(flagMesh(p[1]),[p[0],p[2]]));
  r.terrainView=undefined;
}
export function setGates(r,items) {
  for(const item of r.gates)r.release(item);
  r.gates=items.map(({gate,next,finish})=>r.drawable(gateMesh(gate,gate.pos[1],next,finish),[gate.pos[0],gate.pos[2]]));
  r.terrainView=undefined;
}
export function releaseMaterial(r,item) {if(item)for(const resource of [item.vertices,item.indices,item.layers,item.masks])resource?.destroy();}
export function release(r,item) {item?.buffer.destroy();r.releaseMaterial(item?.material);}
export function uploadMaterials(r) {
  let uploaded=0;
  for(const [index,pending] of r.materialPending){
    const {data}=pending,tile=r.tiles.get(index);
    if(!tile){r.releaseMaterial(pending.gpu);r.materialPending.delete(index);continue;}
    if(!pending.gpu){
      if(!data.layers.length||data.layers.length>64||data.vertices.length%13||data.indices.length%3||
        !data.masks.length||data.masks.length%16384||data.masks.length>256*16384)throw Error('Invalid terrain GPU payload');
      const layers=r.device.createTexture({size:[TERRAIN_TEXTURE_SIZE,TERRAIN_TEXTURE_SIZE,data.layers.length],
        mipLevelCount:9,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      const masks=r.device.createTexture({size:[64,64,data.masks.length/16384],
        format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      pending.gpu={layers,masks};
    }
    // Stage at most three layer mip chains plus 1 MiB of masks per frame.
    while(pending.cursor<data.layers.length&&uploaded<1024*1024){
      const layer=pending.cursor++,mips=data.layers[layer].mips;
      if(mips.length!==9)throw Error('Terrain requires a complete mip chain');
      for(let level=0,size=TERRAIN_TEXTURE_SIZE;level<mips.length;level++,size/=2){
        if(mips[level].length!==size*size*4)throw Error('Invalid terrain mip size');
        r.device.queue.writeTexture({texture:pending.gpu.layers,mipLevel:level,origin:[0,0,layer]},
          mips[level],{bytesPerRow:size*4},[size,size]);
        uploaded+=mips[level].byteLength;
      }
    }
    if(pending.cursor<data.layers.length)return;
    const maskStart=pending.maskCursor||0,maskEnd=Math.min(data.masks.length,maskStart+1024*1024);
    r.device.queue.writeTexture({texture:pending.gpu.masks,origin:[0,0,maskStart/16384]},
      data.masks.subarray(maskStart,maskEnd),{bytesPerRow:256,rowsPerImage:64},[64,64,(maskEnd-maskStart)/16384]);
    pending.maskCursor=maskEnd;
    if(maskEnd<data.masks.length)return;
    const gpu=pending.gpu;
    const indices=dropPlaceholderTriangles(data.vertices,data.indices);
    gpu.vertices=r.buffer(data.vertices,GPUBufferUsage.VERTEX);gpu.indices=r.buffer(indices,GPUBufferUsage.INDEX);
    gpu.count=indices.length;gpu.bytes=data.vertices.byteLength+data.indices.byteLength+data.masks.byteLength+
      data.layers.reduce((n,l)=>n+l.mips.reduce((sum,m)=>sum+m.byteLength,0),0);
    gpu.group=r.device.createBindGroup({layout:r.splatPipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:r.frameUniforms,size:224}},{binding:1,resource:gpu.layers.createView({dimension:'2d-array'})},
      {binding:2,resource:gpu.masks.createView({dimension:'2d-array'})},{binding:3,resource:r.layerSampler},
      {binding:4,resource:r.minimapAtlases[tile.entry.region].createView()}]} );
    r.releaseMaterial(tile.material);tile.material=gpu;
    tile.buffer.destroy();tile.buffer=r.buffer(tile.liquid,GPUBufferUsage.VERTEX);tile.count=tile.liquid.length/7;
    r.materialPending.delete(index);return;
  }
}
export function drawTerrain(r,pass,terrain) {
  const cached=r.terrainBundle;
  if(!cached || cached.items.length!==terrain.length ||
    terrain.some((item,i)=>cached.items[i]!==item || cached.materials[i]!==item.material)) {
    const encoder=r.device.createRenderBundleEncoder(bundleFormats(r.format));
    encoder.setPipeline(r.pipeline);
    for(const item of terrain){
      encoder.setBindGroup(0,item.group,[item.offset]);encoder.setVertexBuffer(0,item.buffer);
      if(item.region!==undefined){encoder.setIndexBuffer(r.indices.get(item.region),'uint32');encoder.drawIndexed(3072);}
      else encoder.draw(item.count,1,item.first||0);
    }
    encoder.setPipeline(r.splatPipeline);
    for(const tile of terrain)if(tile.material){
      const material=tile.material;
      encoder.setBindGroup(0,material.group,[tile.offset]);encoder.setVertexBuffer(0,material.vertices);
      encoder.setIndexBuffer(material.indices,'uint32');encoder.drawIndexed(material.count);
    }
    r.terrainBundle={items:terrain.slice(),materials:terrain.map(item=>item.material),bundle:encoder.finish()};
    r.terrainBundleBuilds++;
  }
  // Uniform bytes and atlas pixels remain live; only membership/material changes replace commands.
  pass.executeBundles([r.terrainBundle.bundle]);
}
/** Rebuilds the sea fill with land tiles cut out, at most once a second while horizon tiles are still arriving. */
export function refreshOcean(r) {
  if(!r.oceanDirty||!r.oceanSpec||performance.now()-(r.oceanAt||0)<1000)return;
  r.oceanDirty=false;r.oceanAt=performance.now();
  const next=r.drawable(oceanMeshCached(r.oceanSpec.manifest,96,r.landRects),r.oceanSpec.origin),i=r.water.indexOf(r.oceanFill);
  r.release(r.oceanFill);if(i>=0)r.water[i]=next;else r.water.push(next);r.oceanFill=next;r.terrainBundle=undefined;
}
