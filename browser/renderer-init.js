import {DEPTH_STATE} from './render-passes.js';
import {WATER_NORMAL_SIZE,waterNormalMips} from './water-shader.js';
import {shadowShader} from './shadow.js';
import {cloudShader,CloudMask} from './clouds.js';
import {ParticlePool,INSTANCE_FLOATS,CAPACITY,particleShader} from './particles.js';
import {MAX_PATCHES} from './globe-patches.js';
import {NIGHT_W,NIGHT_H} from './night-lights-wgsl.js';
import {createColourGrid} from './tile-registry.js';
import {HEIGHT_W,HEIGHT_H} from './height-bake.js';
import {shaderSetFor} from './body-shaders.js';
import {activeBody} from './body-shaders.js';
import {atmosphericDisc} from './body-sky.js';
import {BODIES} from './bodies.js';
/** Bodies that see an atmospheric parent get a texture holding the parent's own baked surface registry (bound as discTex, filled from the parked body state). */
export const wantsDisc=body=>!!body.parent&&atmosphericDisc(BODIES[body.parent]);
const discEntries=(r,body)=>{if(!wantsDisc(body))return [];r.discTex??=r.device.createTexture({size:[1024,512],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});return [{binding:6,resource:r.discTex.createView()}];};
import {spaceShaderFor} from './space.js';
import {bakeMoonSurface,MOON_TEX_W,MOON_TEX_H} from './moon-surface.js';
import {skyShader,skyDomeShader} from './sky.js';
import {sub,cross,unit} from './renderer-helpers.js';
import {terrainShader,splatShader,sceneShader,surfaceShadersFor} from './renderer-shaders.js';
export async function initialize(r) {
  const shader=async code=>{
    const module=r.device.createShaderModule({code});
    const info=await module.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');
    if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
    return module;
  };
  const terrain=await shader(terrainShader),splat=await shader(splatShader);r.sceneModule=await shader(sceneShader);
  const uniformEntry=size=>({binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,
    buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:size}});
  const waveEntries=[
    {binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
    {binding:4,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}];
  r.terrainLayout=r.device.createBindGroupLayout({entries:[uniformEntry(224),
    {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},...waveEntries]});
  r.splatLayout=r.device.createBindGroupLayout({entries:[uniformEntry(224),
    {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d-array'}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d-array'}},
    {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
    {binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}}]});
  r.sceneLayout=r.device.createBindGroupLayout({entries:[
    uniformEntry(256),
    {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
    ...waveEntries,
  ]});
  r.scenePipelineLayout=r.device.createPipelineLayout({bindGroupLayouts:[r.sceneLayout]});
  Object.assign(r,await buildTerrainPipelines(r,terrain,splat));
  r.surfaceBody=activeBody().id;
  r.cloudBuffer=r.device.createBuffer({size:240,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  r.cloudMask=new CloudMask(r.device);
  const cloudModule=await shader(cloudShader);
  r.cloudPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:cloudModule,entryPoint:'vs'},
    fragment:{module:cloudModule,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
    primitive:{topology:'triangle-list',cullMode:'none'}});
  r.shader=shader;
  r.particles=new ParticlePool();
  r.particleInstances=new Float32Array(CAPACITY*INSTANCE_FLOATS);
  r.particleBuffer=r.device.createBuffer({size:r.particleInstances.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  r.particleUniformBuffer=r.device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const particleModule=await shader(particleShader);
  r.particlePipeline=await r.device.createRenderPipelineAsync({layout:'auto',
    vertex:{module:particleModule,entryPoint:'vs',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},
    fragment:{module:particleModule,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:DEPTH_STATE.particles});
  r.particleGroup=r.device.createBindGroup({layout:r.particlePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.particleUniformBuffer}}]});
  r.shadowBuffer=r.device.createBuffer({size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const shadowModule=await shader(shadowShader);
  r.shadowPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:shadowModule,entryPoint:'vs'},
    fragment:{module:shadowModule,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]},
    primitive:{topology:'triangle-list',cullMode:'none'}});
  r.skyBuffer=r.device.createBuffer({size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const skyModule=await shader(skyShader);
  r.skyPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:skyModule,entryPoint:'vs'},
    fragment:{module:skyModule,entryPoint:'fs',targets:[{format:r.format}]},primitive:{topology:'triangle-list'},
    depthStencil:DEPTH_STATE.sky});
  r.skyGroup=r.device.createBindGroup({layout:r.skyPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.skyBuffer}}]});
  r.spaceBuffer=r.device.createBuffer({size:512,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  r.surfaceTex=r.device.createTexture({size:[1024,512],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  r.lightsTex=r.device.createTexture({size:[NIGHT_W,NIGHT_H],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  r.heightTex=r.device.createTexture({size:[HEIGHT_W,HEIGHT_H],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  r.heightGrid=new Float32Array(HEIGHT_W*HEIGHT_H).fill(-Infinity);r.heightDirty=false;
  r.colourGrid=createColourGrid();r.colourDirty=new Set();r.horizonMini=new Map();
  r.surfaceSamp=r.device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'clamp-to-edge'});
  // Shared space (?bodies) on Azeroth: Elune's slot samples a baked procedural moon surface instead of stylised noise.
  const moonSurface=!!r.sharedSpace&&activeBody().id==='azeroth';
  const spaceModule=await shader(moonSurface?spaceShaderFor(activeBody().radius,{moonTex:true}):shaderSetFor(activeBody()).space);
  if(moonSurface){
    r.moonTex=r.device.createTexture({size:[MOON_TEX_W,MOON_TEX_H],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    r.device.queue.writeTexture({texture:r.moonTex},bakeMoonSurface(),{bytesPerRow:MOON_TEX_W*4},[MOON_TEX_W,MOON_TEX_H]);
  }
  r.spacePipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:spaceModule,entryPoint:'vs'},
    fragment:{module:spaceModule,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},
    depthStencil:DEPTH_STATE.space});
  r.spaceGroup=r.device.createBindGroup({layout:r.spacePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.spaceBuffer}},{binding:1,resource:r.surfaceTex.createView()},{binding:2,resource:r.surfaceSamp},...(moonSurface?[{binding:5,resource:r.moonTex.createView()}]:[]),...discEntries(r,activeBody())]});
  r.lightsPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:spaceModule,entryPoint:'vs'},
    fragment:{module:spaceModule,entryPoint:'lfs',targets:[{format:r.format,blend:{color:{srcFactor:'one',dstFactor:'one'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]},primitive:{topology:'triangle-list'},depthStencil:DEPTH_STATE.sky});
  r.lightsGroup=r.device.createBindGroup({layout:r.lightsPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.spaceBuffer}},{binding:2,resource:r.surfaceSamp},{binding:4,resource:r.lightsTex.createView()}]});
  const patchModule=await shader(shaderSetFor(activeBody()).patch);
  r.patchBuffer=r.device.createBuffer({size:MAX_PATCHES*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  r.patchPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:patchModule,entryPoint:'pvs',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},
    fragment:{module:patchModule,entryPoint:'pfs',targets:[{format:r.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},
    depthStencil:DEPTH_STATE.patch});
  r.patchGroup=r.device.createBindGroup({layout:r.patchPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.spaceBuffer}},{binding:1,resource:r.surfaceTex.createView()},{binding:2,resource:r.surfaceSamp},{binding:3,resource:r.heightTex.createView()}]});
  const domeModule=await shader(skyDomeShader);
  r.domeBuffer=r.device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  r.domePipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:domeModule,entryPoint:'vs',buffers:[{arrayStride:48,attributes:[
    {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
    {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x4'}]}]},
    fragment:{module:domeModule,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:DEPTH_STATE.dome});
  r.mapSampler=r.device.createSampler({minFilter:'linear',magFilter:'linear'});
  r.layerSampler=r.device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',
    addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:4});
  r.emptyMap=r.texture(1,1,new Uint8Array(4));
  r.white=r.texture(1,1,new Uint8Array([255,255,255,255]));
  const normals=waterNormalMips();
  r.waterNormalBytes=normals.reduce((n,m)=>n+m.byteLength,0);
  r.waterNormals=r.device.createTexture({size:[WATER_NORMAL_SIZE,WATER_NORMAL_SIZE],format:'rgba8unorm',
    mipLevelCount:normals.length,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  for(let level=0;level<normals.length;level++){
    const size=WATER_NORMAL_SIZE>>level;
    r.device.queue.writeTexture({texture:r.waterNormals,mipLevel:level},normals[level],{bytesPerRow:size*4},[size,size]);
  }
  r.waveSampler=r.device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',
    addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:4});
  const points=[[0,.25,-2.7],[-1.2,0,1.3],[1.2,0,1.3],[0,.65,.8],[0,-.35,.6]],vertices=[];
  for(const face of [[0,1,3],[0,3,2],[1,2,3],[0,4,1],[0,2,4],[1,4,2]]) {
    const [a,b,c]=face.map(i=>points[i]),n=unit(cross(sub(b,a),sub(c,a)));
    for(const p of [a,b,c])vertices.push(...p,...n,1);
  }
  r.body=r.drawable(new Float32Array(vertices),[0,0]);
  r.planetBody=activeBody().id;
}

/** Terrain + splat pipelines (and the scene module) from one shader trio; rebuilt per body because each bakes its radius. */
async function buildTerrainPipelines(r,terrain,splat) {
  const pipeline=await r.device.createRenderPipelineAsync({
    layout:r.device.createPipelineLayout({bindGroupLayouts:[r.terrainLayout]}),
    vertex:{module:terrain,entryPoint:'vs',buffers:[{arrayStride:28,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32'}]}]},
    fragment:{module:terrain,entryPoint:'fs',targets:[{format:r.format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:DEPTH_STATE.terrain,
  });
  const splatPipeline=await r.device.createRenderPipelineAsync({
    layout:r.device.createPipelineLayout({bindGroupLayouts:[r.splatLayout]}),
    vertex:{module:splat,entryPoint:'vs',buffers:[{arrayStride:52,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x4'},
      {shaderLocation:4,offset:48,format:'float32'}]}]},
    fragment:{module:splat,entryPoint:'fs',targets:[{format:r.format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:DEPTH_STATE.splat,
  });
  return {pipeline,splatPipeline};
}

const gpuShader=r=>async code=>{
  const module=r.device.createShaderModule({code});
  const info=await module.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');
  if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
  return module;
};
const makeSurfaceSet=async(r,body)=>{
  const shader=gpuShader(r),set=surfaceShadersFor(body);
  return {...await buildTerrainPipelines(r,await shader(set.terrainShader),await shader(set.splatShader)),sceneModule:await shader(set.sceneShader),pipelines:new Map()};
};
const SURFACE_KEYS=['pipeline','splatPipeline','sceneModule','pipelines'];

/** Build (but do not activate) a body's pipelines so a later useBody is an instant pointer switch. */
export async function prepareBody(r,body) {
  r.surfaceSets??={};r.surfaceSets[r.surfaceBody]??=Object.fromEntries(SURFACE_KEYS.map(k=>[k,r[k]]));
  if(!r.surfaceSets[body.id])r.surfaceSets[body.id]=await makeSurfaceSet(r,body);
  r.planetSets??={};r.planetSets[r.planetBody]??=Object.fromEntries(PLANET_KEYS.map(k=>[k,r[k]]));
  if(!r.planetSets[body.id])r.planetSets[body.id]=await makePlanetSet(r,body);
}

/** In-page body switch (no reload): activate the body's radius-baked surface and planet pipelines (built once, cached). Callers reset()/configure() the renderer around it. */
export async function useBody(r,body) {
  if(r.surfaceBody===body.id)return;
  await prepareBody(r,body);
  Object.assign(r,r.surfaceSets[body.id],r.planetSets[body.id]);
  r.surfaceBody=r.planetBody=body.id;
}

/** Draw set for a body that is not the camera's chart: its own space/patch pipelines (depth tested, never writing) and private uniform/patch/height/surface resources, so one frame can hold two planets from their own data. */
export async function makeOtherSet(r,body) {
  const shader=gpuShader(r),moon=!!r.sharedSpace&&body.id==='azeroth',set=shaderSetFor(body);
  const space=await shader(moon?spaceShaderFor(body.radius,{moonTex:true}):set.space),patch=await shader(set.patch);
  if(moon&&!r.moonTex){
    r.moonTex=r.device.createTexture({size:[MOON_TEX_W,MOON_TEX_H],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    r.device.queue.writeTexture({texture:r.moonTex},bakeMoonSurface(),{bytesPerRow:MOON_TEX_W*4},[MOON_TEX_W,MOON_TEX_H]);
  }
  const add={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  const spacePipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:space,entryPoint:'vs'},
    fragment:{module:space,entryPoint:'fs',targets:[{format:r.format,blend:add}]},primitive:{topology:'triangle-list'},depthStencil:DEPTH_STATE.other});
  const patchPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:patch,entryPoint:'pvs',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},
    fragment:{module:patch,entryPoint:'pfs',targets:[{format:r.format,blend:add}]},primitive:{topology:'triangle-list'},depthStencil:DEPTH_STATE.other});
  const spaceBuffer=r.device.createBuffer({size:512,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),
    patchBuffer=r.device.createBuffer({size:MAX_PATCHES*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),
    surfaceTex=r.device.createTexture({size:[1024,512],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),
    heightTex=r.device.createTexture({size:[HEIGHT_W,HEIGHT_H],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  return {body,spacePipeline,patchPipeline,spaceBuffer,patchBuffer,surfaceTex,heightTex,
    spaceGroup:r.device.createBindGroup({layout:spacePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:spaceBuffer}},{binding:1,resource:surfaceTex.createView()},{binding:2,resource:r.surfaceSamp},...(moon?[{binding:5,resource:r.moonTex.createView()}]:[]),...discEntries(r,body)]}),
    patchGroup:r.device.createBindGroup({layout:patchPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:spaceBuffer}},{binding:1,resource:surfaceTex.createView()},{binding:2,resource:r.surfaceSamp},{binding:3,resource:heightTex.createView()}]})};
}
const PLANET_KEYS=['spacePipeline','lightsPipeline','patchPipeline','spaceGroup','lightsGroup','patchGroup'];
/** Space/lights/patch pipelines for the body the chart is on (design/elune.md D3): same shaders, that body's radius baked in. */
export async function buildPlanetPipelines(r,body) {
  if(r.planetBody===body.id)return;
  r.planetSets??={};r.planetSets[r.planetBody]??=Object.fromEntries(PLANET_KEYS.map(k=>[k,r[k]]));
  if(!r.planetSets[body.id])r.planetSets[body.id]=await makePlanetSet(r,body);
  if(r.planetBody===body.id)return;
  Object.assign(r,r.planetSets[body.id]);r.planetBody=body.id;
}
async function makePlanetSet(r,body) {
  const shader=gpuShader(r);
  const moon=!!r.sharedSpace&&body.id==='azeroth',set=shaderSetFor(body),space=await shader(moon?spaceShaderFor(body.radius,{moonTex:true}):set.space),patch=await shader(set.patch);
  if(moon&&!r.moonTex){
    r.moonTex=r.device.createTexture({size:[MOON_TEX_W,MOON_TEX_H],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    r.device.queue.writeTexture({texture:r.moonTex},bakeMoonSurface(),{bytesPerRow:MOON_TEX_W*4},[MOON_TEX_W,MOON_TEX_H]);
  }
  const add={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  const spacePipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:space,entryPoint:'vs'},
    fragment:{module:space,entryPoint:'fs',targets:[{format:r.format,blend:add}]},primitive:{topology:'triangle-list'},depthStencil:DEPTH_STATE.space});
  const lightsPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:space,entryPoint:'vs'},
    fragment:{module:space,entryPoint:'lfs',targets:[{format:r.format,blend:{color:{srcFactor:'one',dstFactor:'one'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]},primitive:{topology:'triangle-list'},depthStencil:DEPTH_STATE.sky});
  const patchPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module:patch,entryPoint:'pvs',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},
    fragment:{module:patch,entryPoint:'pfs',targets:[{format:r.format,blend:add}]},primitive:{topology:'triangle-list'},depthStencil:DEPTH_STATE.patch});
  return {spacePipeline,lightsPipeline,patchPipeline,spaceGroup:r.device.createBindGroup({layout:spacePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.spaceBuffer}},{binding:1,resource:r.surfaceTex.createView()},{binding:2,resource:r.surfaceSamp},...(moon?[{binding:5,resource:r.moonTex.createView()}]:[]),...discEntries(r,body)]}),
    lightsGroup:r.device.createBindGroup({layout:lightsPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.spaceBuffer}},{binding:2,resource:r.surfaceSamp},{binding:4,resource:r.lightsTex.createView()}]}),
    patchGroup:r.device.createBindGroup({layout:patchPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.spaceBuffer}},{binding:1,resource:r.surfaceTex.createView()},{binding:2,resource:r.surfaceSamp},{binding:3,resource:r.heightTex.createView()}]})};
}