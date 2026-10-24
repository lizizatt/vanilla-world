import {modelPath,sceneReady} from './scene-stream.js';
export {sceneReady} from './scene-stream.js';
import {MINIMAP_SIZE,TERRAIN_TEXTURE_SIZE} from './terrain-stream.js';
import {cameraView,craftMatrix,cockpitAnchor} from './world-camera.js';
import {splitParts,crumple,craftFrame,partMatrix,appendWreckChunk,wreckFrame,WRECK_SECONDS} from './wreck.js';
import {COAST_GPU_LIMIT} from './water-stream.js';
import {WATER_NORMAL_SIZE,waterNormalMips,waterShading,dayShading} from './water-shader.js';
import {shadowShader,shadowUniform,shadowHalf} from './shadow.js';
import {cloudShader,cloudShaderHigh,cloudUniform,maelstromCentre,sunDirection,bakeCloudNoise,CloudMask,CLOUD_NOISE_SIZE,resolveCloudQuality,SlowFrameGuard} from './clouds.js';
import {oceanMesh} from './ocean-mesh.js';
const OCEAN_FILL=130000;
import {ParticlePool,exhaustPoints,emitPlumes,emitBurst,emitDebris,emitHeatSmoke,emitGroundDust,QUALITY,INSTANCE_FLOATS,CAPACITY,particleShader,particleUniform} from './particles.js';
import {flagMesh,gateMesh} from './race-flags.js';
import {beamState} from './beam.js';
import {schematicRects} from './worldmap.js';
import {patchesAt,packPatches,PATCH_GRID,MAX_PATCHES} from './globe-patches.js';
import {createRegistry,defaultManifest,bakeSurface,surfaceTexel,createColourGrid,splatMinimap,adtChunk} from './tile-registry.js';
import {HEIGHT_W,HEIGHT_H,splatHeights,encodeHeights} from './height-bake.js';
import {PLANET_RADIUS,WORLD_CENTRE,planetFactors,horizonDip,spaceUniform,spaceShader,patchShader,bendShader,FALLBACK_RECTS} from './space.js';
import {SkyCatalog,mapPosition,skyShader,skyDomeShader,skyUniform,advanceTime,nightAlpha,nightAngle,DAY} from './sky.js';
import {ACTOR,actorPhase,poseKey} from './actors.js';
import {sceneVisible,boundsVisible,viewChanged} from './world-view.js';
export {sceneVisible} from './world-view.js';
export {craftMatrix} from './world-camera.js';
const DAY_SKY=[.08,.15,.20],NIGHT_SKY=[.008,.016,.045];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};
export function cameraAxes(look,preferredUp=[0,1,0]) {
  let right=cross(look,preferredUp);
  // Clipping onto the chase pivot can leave only the vertical suspension offset.
  if(Math.hypot(...right)<1e-6)right=cross(look,Math.abs(look[2])<.9?[0,0,1]:[1,0,0]);
  right=unit(right);
  return {right,up:unit(cross(right,look))};
}
export function renderMatrix(source,region,origin) {
  const m=new Float32Array(16);
  for(let col=0;col<4;col++){
    m[col*4]=-source[col*4+1];m[col*4+1]=source[col*4+2];m[col*4+2]=-source[col*4];m[col*4+3]=col===3?1:0;
  }
  m[12]=-source[13]+region.placement[0]+(32-region.tile_origin[0])*1600/3-origin[0];
  m[13]=source[14];
  m[14]=-source[12]+region.placement[1]+(32-region.tile_origin[1])*1600/3-origin[1];
  return m;
}
export function sceneSelection(instances,assets,visible=()=>true) {
  const selected=[];
  let triangles=0,draws=0,culled=0;
  for(const instance of instances) {
    const asset=assets.get(instance.key);
    if(!asset)continue;
    if(!visible(instance,asset)){culled++;continue;}
    const cost=asset.batches.reduce((n,b)=>n+b.indexCount/3,0);
    if(selected.length>=1024 || triangles+cost>2000000 || draws+asset.batches.length>4096)continue;
    selected.push(instance);triangles+=cost;draws+=asset.batches.length;
  }
  return {selected,triangles,culled,omitted:instances.length-selected.length-culled};
}
export function terrainEdgeMask(entry,neighbors) {
  return [[-1,0],[1,0],[0,-1],[0,1]].reduce((mask,[dx,dy],edge)=>
    neighbors.some(t=>t.region===entry.region&&t.x===entry.x+dx&&t.y===entry.y+dy)?mask:mask|(1<<edge),0);
}
export function readySceneInstances(near,far,assets,textures) {
  const fallback=new Map(far.map(i=>[i.id,i])),ids=new Set(near.map(i=>i.id));
  return [...near.map(i=>{
    const other=fallback.get(i.id);
    return other&&!sceneReady(i,assets,textures)&&sceneReady(other,assets,textures)?other:i;
  }),...far.filter(i=>!ids.has(i.id))];
}
export class AdmissionFade {
  constructor(){this.entries=new Map();this.active=new Set();}
  update(ids,time) {
    if(ids.length>1024)throw Error('Admission fade exceeds the scene instance budget');
    const active=new Set(ids);
    for(const id of this.active)if(!active.has(id))this.entries.get(id).removed=time;
    for(const id of active)if(!this.active.has(id)){
      const old=this.entries.get(id),entry=old&&time-old.removed<=.25?old:{start:time};
      this.entries.delete(id);this.entries.set(id,entry);
    }
    this.active=active;
    for(const id of this.entries.keys()){
      if(this.entries.size<=2048)break;
      if(!active.has(id))this.entries.delete(id);
    }
  }
  opacity(id,time) {
    const entry=this.entries.get(id);
    if(!entry)return 1;
    const t=Math.min(1,Math.max(0,(time-entry.start)/.35));
    return t*t*(3-2*t);
  }
}
const terrainShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,body:vec4f,settings:vec4f,tile:vec4f,pad:array<vec4f,3>,sky:array<vec4f,4>};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var minimap:texture_2d<f32>;
@group(0) @binding(2) var mapSampler:sampler;
${dayShading}${waterShading}${bendShader}
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) @interpolate(flat) material:f32,@location(3) uv:vec2f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) material:f32)->V {
  var position=p+u.tile.xyz;var normal=n;
  if(material==1.0) {
    let s=sin(u.body.w);let c=cos(u.body.w);
    let sb=sin(u.settings.z);let cb=cos(u.settings.z);
    let q=vec3f(p.x*cb-p.y*sb,p.x*sb+p.y*cb,p.z);
    position=vec3f(q.x*c+q.z*s,q.y,-q.x*s+q.z*c)+u.body.xyz;
    normal=vec3f(n.x*c+n.z*s,n.y,-n.x*s+n.z*c);
  }
  let relative=bend(position-u.eye.xyz,u.eye.y,u.pad[0].x);let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.n=normal;v.material=material;v.uv=p.xz/(1600.0/3.0);return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let dx=dpdx(v.p.xz);let dy=dpdy(v.p.xz);let rampWidth=fwidth(v.n.x);
  let light=.35+.65*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0);
  var color=vec3f(.63,.59,.40)*light;
  let cell=vec2f(u.tile.w%64.0,floor(u.tile.w/64.0));
  let mapUv=(cell+clamp(v.uv,vec2f(.5/32.0),vec2f(1.0-.5/32.0)))/64.0;
  let mapColor=textureSample(minimap,mapSampler,mapUv);
  if((v.material==0.0 || v.material==3.0) && u.tile.w>=0.0){color=mix(color,mapColor.rgb,mapColor.a);}
  if(v.material==1.0){color=vec3f(.1,.89,.82)*light;}
  color=grade(color);
  if(v.material>=5.0 && v.material<9.0){
    let kind=v.material-5.0;
    color=select(select(select(vec3f(1.0,.72,.1),vec3f(.95),kind==2.0),vec3f(.85,.08,.06),kind==1.0),vec3f(.22,.22,.24),kind==0.0)*select(max(light,.8),1.0,kind==3.0);
  }
  if(v.material==2.0 || v.material==4.0){
    color=waterColor(v.p,select(1.0,v.n.x,v.n.z>.5),rampWidth,dx,dy);
  }
  let fog=max(clamp(length(v.p-u.eye.xyz)/150000.0,0.0,.93),valleyHaze(v.p))*(1.0-u.pad[0].y);
  return vec4f(mix(color,fogTint(),fog),1);
}`;
const splatShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,body:vec4f,settings:vec4f,tile:vec4f,pad:array<vec4f,3>,sky:array<vec4f,4>};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var layers:texture_2d_array<f32>;
@group(0) @binding(2) var masks:texture_2d_array<f32>;
@group(0) @binding(3) var layerSampler:sampler;
@group(0) @binding(4) var minimap:texture_2d<f32>;
${dayShading}${bendShader}
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) uv:vec2f,
  @location(2) @interpolate(flat) layers:vec4u,@location(3) @interpolate(flat) chunk:u32,@location(4) light:f32,
  @location(5) tileUv:vec2f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,
  @location(3) ids:vec4f,@location(4) chunk:f32)->V {
  let position=p+u.tile.xyz;let relative=bend(position-u.eye.xyz,u.eye.y,u.pad[0].x);let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.uv=uv;v.layers=vec4u(ids);v.chunk=u32(chunk);
  v.tileUv=p.xz/(1600.0/3.0);
  v.light=clamp(.4+.6*max(dot(normalize(n),normalize(vec3f(-.3,1.0,.4))),0.0),0.0,1.0);
  return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let uv=v.uv*8.0;
  let a=textureSample(masks,layerSampler,clamp(v.uv,vec2f(.5/64.0),vec2f(1.0-.5/64.0)),i32(v.chunk));
  var color=textureSample(layers,layerSampler,uv,i32(v.layers.x)).rgb;
  color=mix(color,textureSample(layers,layerSampler,uv,i32(v.layers.y)).rgb,a.r);
  color=mix(color,textureSample(layers,layerSampler,uv,i32(v.layers.z)).rgb,a.g);
  color=mix(color,textureSample(layers,layerSampler,uv,i32(v.layers.w)).rgb,a.b);
  color*=v.light*(1.0-.3*a.a);
  let mapCell=vec2f(u.tile.w%64.0,floor(u.tile.w/64.0));
  let mapColor=textureSample(minimap,layerSampler,
    (mapCell+clamp(v.tileUv,vec2f(.5/32.0),vec2f(1.0-.5/32.0)))/64.0);
  let edges=u32(u.body.w);
  var edgeDistance=1600.0/3.0;
  if((edges&1u)!=0u){edgeDistance=min(edgeDistance,v.tileUv.x*(1600.0/3.0));}
  if((edges&2u)!=0u){edgeDistance=min(edgeDistance,(1.0-v.tileUv.x)*(1600.0/3.0));}
  if((edges&4u)!=0u){edgeDistance=min(edgeDistance,v.tileUv.y*(1600.0/3.0));}
  if((edges&8u)!=0u){edgeDistance=min(edgeDistance,(1.0-v.tileUv.y)*(1600.0/3.0));}
  color=mix(color,mapColor.rgb,(1.0-smoothstep(0.0,100.0/3.0,edgeDistance))*mapColor.a);
  let base=mix(vec3f(.63,.59,.40)*v.light,mapColor.rgb,mapColor.a);
  color=grade(mix(base,color,u.settings.z));
  let fog=max(clamp(length(v.p-u.eye.xyz)/150000.0,0.0,.93),valleyHaze(v.p))*(1.0-u.pad[0].y);
  return vec4f(mix(color,fogTint(),fog),1);
}`;
const sceneShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,settings:vec4f,model:mat4x4f,material:vec4f,sky:array<vec4f,4>,beam:vec4f,bend:vec4f};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var imageSampler:sampler;
${dayShading}${waterShading}${bendShader}
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) color:vec4f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) color:vec4f)->V {
  let position=(u.model*vec4f(p,1)).xyz;let relative=bend(position-u.eye.xyz,u.eye.y,u.bend.x);let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.n=(u.model*vec4f(n,0)).xyz;v.uv=uv;v.color=color;return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let dx=dpdx(v.p.xz);let dy=dpdy(v.p.xz);let rampWidth=fwidth(v.uv.x);
  var uv=v.uv;var tint=1.0;
  if(u.beam.x>.5){let t=u.settings.y;uv.x+=t*.9;uv.y+=u.beam.z*.2*sin(uv.x*25.0+t*50.0);
    tint=u.beam.y*(.75+.25*sin(t*37.0)*sin(t*23.0+uv.x*3.0));
    if(u.beam.w>.5){tint=max(0.0,sin(t*31.0)*sin(t*17.0)-.85)*6.0;}}
  let texel=textureSample(image,imageSampler,uv)*v.color*vec4f(vec3f(tint),min(1.0,tint));
  if(texel.a<u.material.x){discard;}
  let distance=length(v.p-u.eye.xyz);
  let coverage=u.material.w*select(1.0,1.0-smoothstep(3500.0,6000.0,distance),u.material.z>0.0);
  if(fract(dot(floor(v.clip.xy),vec2f(.754877666,.569840296)))>=coverage){discard;}
  let light=mix(.4+.6*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0),1.0,u.material.y);
  let fog=max(max(clamp(distance/150000.0,0.0,.93),valleyHaze(v.p))*(1.0-u.bend.y),u.material.z*.8*smoothstep(3500.0,6000.0,distance));
  var color=grade(texel.rgb*light);
  if(u.settings.z>.5){color=waterColor(v.p,v.uv.x,rampWidth,dx,dy);}
  return vec4f(mix(color,fogTint(),fog),texel.a);
}`;

export class WorldRenderer {
  static async create(canvas,onError) {
    if(!navigator.gpu)throw new Error('WebGPU is unavailable. Use current Edge/Chrome with hardware acceleration.');
    const adapter=await navigator.gpu.requestAdapter();
    if(!adapter)throw new Error('No WebGPU adapter. Enable hardware acceleration.');
    const device=await adapter.requestDevice();
    device.addEventListener('uncapturederror',event=>onError(event.error));
    device.lost.then(info=>onError(new Error(`WebGPU device lost: ${info.message}`)));
    const result=new WorldRenderer(canvas,device);
    result.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter};
    await result.initialize();
    return result;
  }
  constructor(canvas,device) {
    this.canvas=canvas;this.device=device;this.format=navigator.gpu.getPreferredCanvasFormat();
    this.context=canvas.getContext('webgpu');this.context.configure({device,format:this.format,alphaMode:'opaque'});
    this.tiles=new Map();this.seams=new Map();this.horizon=[];this.water=[];this.flags=[];this.gates=[];this.coast=new Map();this.indices=new Map();
    this.coastBytes=0;
    this.admissionFade=new AdmissionFade();
    this.assets=new Map();this.textures=new Map();this.items=new Map();this.instances=[];this.pipelines=new Map();
    this.materialPending=new Map();this.minimapAtlases=[];
    this.pendingEvents=[];this.poses=new Map();this.moves=new Map();
    this.terrainBundleBuilds=0;this.sceneBundleBuilds=0;
    this.uniformData=new Float32Array(16384*64);
    this.frameUniforms=device.createBuffer({size:this.uniformData.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  }
  // Animated NPC poses replace the vertex buffer only when it matches the bind mesh; the wrapper stays stable per base asset.
  posedAsset(instance,base) {
    if(!base||instance.distant||!this.poses?.size||!instance.id.includes(':npc:'))return base;
    const ph=actorPhase(instance.id),mv=this.moves?.get(instance.id);
    const entry=(mv&&(mv.vx||mv.vy)&&this.poses.get(poseKey(instance.key,ph+ACTOR.phases)))||this.poses.get(poseKey(instance.key,ph));
    if(!entry||entry.size!==base.vertices.size)return base;
    if(!entry.asset||entry.asset.base!==base)entry.asset={...base,vertices:entry.buffer,base};
    return entry.asset;
  }
  npcMoves(data) {
    for(const id of data.removed)this.moves.delete(id);
    for(const [id,x,y,z,yaw,vx,vy] of data.moves)this.moves.set(id,{x,y,z,yaw,vx,vy,t:data.t});
  }
  // Wandering NPC: authored matrix with the worker's position (extrapolated by velocity) and facing swapped in.
  moveMatrix(instance,mv,region,origin) {
    const b=instance.matrix,dt=Math.min(.5,Math.max(0,Date.now()/1000-mv.t)),d=mv.yaw-Math.atan2(b[1],b[0]);
    const c=Math.cos(d),s=Math.sin(d),m=Array.from(b);
    for(let k=0;k<3;k++){const x=b[k*4],y=b[k*4+1];m[k*4]=c*x-s*y;m[k*4+1]=s*x+c*y;}
    m[12]=mv.x+mv.vx*dt;m[13]=mv.y+mv.vy*dt;m[14]=mv.z;
    return renderMatrix(m,region,origin);
  }
  pose(data) {
    for(const id of data.removed){this.poses.get(id)?.buffer.destroy();this.poses.delete(id);}
    for(const p of data.poses){
      const id=poseKey(p.key,p.phase);let entry=this.poses.get(id);
      if(!entry||entry.size!==p.vertices.byteLength){
        const bytes=[...this.poses.values()].reduce((n,e)=>n+(e===entry?0:e.size),0)+p.vertices.byteLength;
        if(bytes>ACTOR.maxBytes)continue;
        entry?.buffer.destroy();
        entry={size:p.vertices.byteLength,buffer:this.device.createBuffer({size:p.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})};
        this.poses.set(id,entry);
      }
      this.device.queue.writeBuffer(entry.buffer,0,p.vertices.buffer,p.vertices.byteOffset,p.vertices.byteLength);
    }
  }
  buffer(data,usage) {
    const buffer=this.device.createBuffer({size:Math.max(4,data.byteLength),usage,mappedAtCreation:true});
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));
    buffer.unmap();return buffer;
  }
  async initialize() {
    const shader=async code=>{
      const module=this.device.createShaderModule({code});
      const info=await module.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');
      if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
      return module;
    };
    const terrain=await shader(terrainShader),splat=await shader(splatShader);this.sceneModule=await shader(sceneShader);
    const uniformEntry=size=>({binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,
      buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:size}});
    const waveEntries=[
      {binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
      {binding:4,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}];
    this.terrainLayout=this.device.createBindGroupLayout({entries:[uniformEntry(224),
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},...waveEntries]});
    this.splatLayout=this.device.createBindGroupLayout({entries:[uniformEntry(224),
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d-array'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d-array'}},
      {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
      {binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}}]});
    this.pipeline=await this.device.createRenderPipelineAsync({
      layout:this.device.createPipelineLayout({bindGroupLayouts:[this.terrainLayout]}),
      vertex:{module:terrain,entryPoint:'vs',buffers:[{arrayStride:28,attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32'}]}]},
      fragment:{module:terrain,entryPoint:'fs',targets:[{format:this.format}]},
      primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'},
    });
    this.sceneLayout=this.device.createBindGroupLayout({entries:[
      uniformEntry(256),
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
      ...waveEntries,
    ]});
    this.scenePipelineLayout=this.device.createPipelineLayout({bindGroupLayouts:[this.sceneLayout]});
    this.splatPipeline=await this.device.createRenderPipelineAsync({
      layout:this.device.createPipelineLayout({bindGroupLayouts:[this.splatLayout]}),
      vertex:{module:splat,entryPoint:'vs',buffers:[{arrayStride:52,attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
        {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x4'},
        {shaderLocation:4,offset:48,format:'float32'}]}]},
      fragment:{module:splat,entryPoint:'fs',targets:[{format:this.format}]},
      primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'},
    });
    this.cloudBuffer=this.device.createBuffer({size:240,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.cloudMask=new CloudMask(this.device);
    const cloudModule=await shader(cloudShader);
    this.cloudPipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module:cloudModule,entryPoint:'vs'},
      fragment:{module:cloudModule,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
      primitive:{topology:'triangle-list',cullMode:'none'}});
    this.shader=shader;
    this.particles=new ParticlePool();
    this.particleInstances=new Float32Array(CAPACITY*INSTANCE_FLOATS);
    this.particleBuffer=this.device.createBuffer({size:this.particleInstances.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    this.particleUniformBuffer=this.device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const particleModule=await shader(particleShader);
    this.particlePipeline=await this.device.createRenderPipelineAsync({layout:'auto',
      vertex:{module:particleModule,entryPoint:'vs',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},
      fragment:{module:particleModule,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
      primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less'}});
    this.particleGroup=this.device.createBindGroup({layout:this.particlePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.particleUniformBuffer}}]});
    this.shadowBuffer=this.device.createBuffer({size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const shadowModule=await shader(shadowShader);
    this.shadowPipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module:shadowModule,entryPoint:'vs'},
      fragment:{module:shadowModule,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]},
      primitive:{topology:'triangle-list',cullMode:'none'}});
    this.skyBuffer=this.device.createBuffer({size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const skyModule=await shader(skyShader);
    this.skyPipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module:skyModule,entryPoint:'vs'},
      fragment:{module:skyModule,entryPoint:'fs',targets:[{format:this.format}]},primitive:{topology:'triangle-list'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'always'}});
    this.skyGroup=this.device.createBindGroup({layout:this.skyPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.skyBuffer}}]});
    this.spaceBuffer=this.device.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.surfaceTex=this.device.createTexture({size:[1024,512],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    this.heightTex=this.device.createTexture({size:[HEIGHT_W,HEIGHT_H],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    this.heightGrid=new Float32Array(HEIGHT_W*HEIGHT_H).fill(-Infinity);this.heightDirty=false;
    this.colourGrid=createColourGrid();this.colourDirty=new Set();this.horizonMini=new Map();
    this.surfaceSamp=this.device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'clamp-to-edge'});
    const spaceModule=await shader(spaceShader);
    this.spacePipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module:spaceModule,entryPoint:'vs'},
      fragment:{module:spaceModule,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'always'}});
    this.spaceGroup=this.device.createBindGroup({layout:this.spacePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.spaceBuffer}},{binding:1,resource:this.surfaceTex.createView()},{binding:2,resource:this.surfaceSamp}]});
    const patchModule=await shader(patchShader);
    this.patchBuffer=this.device.createBuffer({size:MAX_PATCHES*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    this.patchPipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module:patchModule,entryPoint:'pvs',buffers:[{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},
      fragment:{module:patchModule,entryPoint:'pfs',targets:[{format:this.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less-equal'}});
    this.patchGroup=this.device.createBindGroup({layout:this.patchPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.spaceBuffer}},{binding:1,resource:this.surfaceTex.createView()},{binding:2,resource:this.surfaceSamp},{binding:3,resource:this.heightTex.createView()}]});
    const domeModule=await shader(skyDomeShader);
    this.domeBuffer=this.device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.domePipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module:domeModule,entryPoint:'vs',buffers:[{arrayStride:48,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x4'}]}]},
      fragment:{module:domeModule,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
      primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'always'}});
    this.mapSampler=this.device.createSampler({minFilter:'linear',magFilter:'linear'});
    this.layerSampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',
      addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:4});
    this.emptyMap=this.texture(1,1,new Uint8Array(4));
    this.white=this.texture(1,1,new Uint8Array([255,255,255,255]));
    const normals=waterNormalMips();
    this.waterNormalBytes=normals.reduce((n,m)=>n+m.byteLength,0);
    this.waterNormals=this.device.createTexture({size:[WATER_NORMAL_SIZE,WATER_NORMAL_SIZE],format:'rgba8unorm',
      mipLevelCount:normals.length,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    for(let level=0;level<normals.length;level++){
      const size=WATER_NORMAL_SIZE>>level;
      this.device.queue.writeTexture({texture:this.waterNormals,mipLevel:level},normals[level],{bytesPerRow:size*4},[size,size]);
    }
    this.waveSampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',
      addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:4});
    const points=[[0,.25,-2.7],[-1.2,0,1.3],[1.2,0,1.3],[0,.65,.8],[0,-.35,.6]],vertices=[];
    for(const face of [[0,1,3],[0,3,2],[1,2,3],[0,4,1],[0,2,4],[1,4,2]]) {
      const [a,b,c]=face.map(i=>points[i]),n=unit(cross(sub(b,a),sub(c,a)));
      for(const p of [a,b,c])vertices.push(...p,...n,1);
    }
    this.body=this.drawable(new Float32Array(vertices),[0,0]);
  }
  texture(width,height,rgba) {
    const texture=this.device.createTexture({size:[width,height],format:'rgba8unorm',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    this.device.queue.writeTexture({texture},rgba,{bytesPerRow:width*4},[width,height]);
    return texture;
  }
  drawable(vertices,placement,map=this.emptyMap) {
    const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<vertices.length;i+=7)for(let a=0;a<3;a++){
      low[a]=Math.min(low[a],vertices[i+a]);high[a]=Math.max(high[a],vertices[i+a]);
    }
    for(const b of [low,high]){b[0]+=placement[0];b[2]+=placement[1];}
    return {buffer:this.buffer(vertices,GPUBufferUsage.VERTEX),count:vertices.length/7,placement,
      bounds:vertices.length?[low,high]:undefined,
      group:this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.frameUniforms,size:224}},{binding:1,resource:map.createView()},{binding:2,resource:this.mapSampler},
        {binding:3,resource:this.waterNormals.createView()},{binding:4,resource:this.waveSampler}]})};
  }
  setFlags(positions) {
    for(const item of this.flags)this.release(item);
    this.flags=positions.map(p=>this.drawable(flagMesh(p[1]),[p[0],p[2]]));
    this.terrainView=undefined;
  }
  setGates(items) {
    for(const item of this.gates)this.release(item);
    this.gates=items.map(({gate,next,finish})=>this.drawable(gateMesh(gate,gate.pos[1],next,finish),[gate.pos[0],gate.pos[2]]));
    this.terrainView=undefined;
  }
  releaseMaterial(item){if(item)for(const resource of [item.vertices,item.indices,item.layers,item.masks])resource?.destroy();}
  release(item){item?.buffer.destroy();this.releaseMaterial(item?.material);}
  destroyCraft(craft){
    if(!craft)return;
    for(const asset of [craft.asset,craft.flame?.asset])if(asset){asset.vertices.destroy();asset.indices.destroy();}
    for(const texture of craft.textures.values())texture.destroy();
  }
  // Only the Data rocket is released with the world; a shipped/procedural override survives world reloads.
  releaseCraft(){this.destroyCraft(this.dataCraft);this.dataCraft=undefined;this.craft=this.override;}
  buildCraft(data,display,key,maxIndices=60000) {
    if(data.metadata.display!==display||!Number.isFinite(data.metadata.scale)||data.metadata.scale<=0||
      data.asset.indices.length>maxIndices||data.textures.length>64)throw Error('Invalid craft payload');
    const bytes=data.asset.vertices.byteLength+data.asset.indices.byteLength+data.textures.reduce((n,t)=>n+t.rgba.byteLength,0);
    if(bytes>32*1024*1024)throw Error('Craft exceeds GPU budget');
    const build=asset=>({vertices:this.buffer(asset.vertices,GPUBufferUsage.VERTEX),
      indices:this.buffer(asset.indices,GPUBufferUsage.INDEX),batches:this.prepareBatches(asset.batches),count:asset.indices.length});
    const anchor=cockpitAnchor(data.metadata),asset=build(data.asset),lo=[1e9,1e9,1e9],hi=[-1e9,-1e9,-1e9];
    for(let i=0;i<data.asset.vertices.length;i+=12)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],data.asset.vertices[i+a]);hi[a]=Math.max(hi[a],data.asset.vertices[i+a]);}
    return {asset,textures:new Map(data.textures.map(t=>[t.key,this.texture(t.width,t.height,t.rgba)])),
      metadata:data.metadata,anchor,source:data.asset,items:new Map(),instance:{id:'player-craft',key,craft:true},bytes,size:hi.map((v,a)=>(v-lo[a])*data.metadata.scale),
      flame:data.flame&&data.metadata.exhausts?.length?{asset:build(data.flame),
        parts:data.metadata.exhausts.map((at,i)=>({at,instance:{id:`player-craft-flame:${i}`,key:'flame',craft:true}}))}:undefined};
  }
  // Debug crash: returns the Rust wreck_start inputs and, once frames arrive, replaces the craft with its pod/engine parts.
  startWreck(state,seed=1,speed=state[5]) {
    const c=this.craft,src=c?.source;
    if(!src)return undefined;
    this.endWreck();
    const scale=c.metadata.scale,m0=craftMatrix(state,[state[11],state[12]],scale),{rot}=craftFrame(m0,scale),split=splitParts(src.vertices,src.indices,src.batches);
    if(split[0].empty)return undefined;
    const vertices=this.buffer(crumple(src.vertices,seed),GPUBufferUsage.VERTEX),parts=[];
    split.forEach((p,i)=>{if(!p.empty)parts.push({...p,asset:{vertices,indices:this.buffer(p.indices,GPUBufferUsage.INDEX),
      batches:this.prepareBatches(p.batches),count:p.indices.length},instance:{id:`player-craft-wreck:${i}`,key:'wreck',craft:true}});});
    this.wreck={parts,vertices,frames:[],connected:[],scale,t0:performance.now()/1000};
    if(this.particles?.quality>0)emitBurst(this.particles,[state[0],state[1]+c.size[2]*.4,state[2]],(c.fx?.length||c.size[0])/3.5);
    return {pos:[state[0],state[1],state[2]],rot:Array.from(rot),scale,vel:[m0[0]/scale*speed,m0[1]/scale*speed,m0[2]/scale*speed],
      parts:parts.flatMap(p=>[...p.center,...p.half]),seed,count:parts.length};
  }
  wreckChunk(chunk) {if(this.wreck)appendWreckChunk(this.wreck,chunk,this.wreck.parts.length);}
  endWreck() {
    const w=this.wreck;this.wreck=undefined;
    if(!w)return;
    w.vertices.destroy();for(const p of w.parts)p.asset.indices.destroy();
  }
  // Preview tooling (race-gate-preview.js): static scenery drawn through the craft path; not used by gameplay.
  setProps(list) {
    for(const p of this.props||[])this.destroyCraft(p.craft);
    this.props=list.map((p,i)=>{
      const craft=this.buildCraft({asset:p.asset,textures:p.textures,metadata:{display:0,scale:p.scale||1,pose:'prop',exhausts:[],
        posedAttachment0:{space:'model-local',pose:'stand-frame-0',position:[0,0,0]}}},0,`prop:${i}`,2000000);
      craft.instance={id:`prop:${i}`,key:`prop:${i}`,craft:true};
      return {craft,pos:p.pos,yaw:p.yaw||0,scale:p.scale||1,space:p.space||'world'};
    });
  }
  setCraftOverride(model) {
    const next=model?this.buildCraft(model,0,model.key,120000):undefined;
    this.destroyCraft(this.override);this.override=next;this.craft=next??this.dataCraft;
  }
  reset() {
    this.terrainBundle=undefined;this.terrainBundleBuilds=0;
    this.sceneBundle=undefined;this.sceneBundleBuilds=0;
    this.releaseCraft();
    this.craftError=undefined;
    for(const item of [...this.tiles.values(),...this.seams.values(),...this.horizon,...this.water,...this.flags,...this.gates,...this.coast.values()])this.release(item);
    this.tiles.clear();this.seams.clear();this.horizon=[];this.water=[];this.flags=[];this.gates=[];this.coast.clear();this.oceanSpec=undefined;this.oceanFill=undefined;this.landRects=[];this.coastBytes=0;
    for(const index of this.indices.values())index.destroy();this.indices.clear();
    for(const asset of this.assets.values()){asset.vertices.destroy();asset.indices.destroy();}this.assets.clear();
    for(const texture of this.textures.values())texture.destroy();this.textures.clear();
    this.items.clear();
    for(const e of this.poses.values())e.buffer.destroy();this.poses.clear();this.moves?.clear();
    this.instances=[];this.nearInstances=[];this.farInstances=[];this.farRegion=undefined;
    this.camera=undefined;this.origin=[0,0];
    this.view=undefined;this.terrainView=undefined;
    this.admissionFade?.entries.clear();
    this.admissionFade?.active.clear();
    for(const item of this.materialPending.values())this.releaseMaterial(item.gpu);
    this.materialPending.clear();
    for(const texture of this.minimapAtlases)texture.destroy();this.minimapAtlases=[];
    this.manifest=undefined;this.pendingEvents=[];
  }
  configure(manifest) {
    this.manifest=manifest;
    this.minimapAtlases=manifest.regions.map(()=>this.device.createTexture({
      size:[64*MINIMAP_SIZE,64*MINIMAP_SIZE],format:'rgba8unorm',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
    const [x,z]=manifest.ocean;
    // Open ocean beyond the authored rectangle: the same water mesh extended to roughly half the planet circumference.
    const pad=OCEAN_FILL,[,,right,bottom]=manifest.ocean;
    this.oceanSpec={manifest:{...manifest,ocean:[x-pad,z-pad,right+pad,bottom+pad]},origin:[x-pad,z-pad]};this.landRects=[];this.oceanFill=this.drawable(oceanMesh(this.oceanSpec.manifest),this.oceanSpec.origin);this.water.push(this.oceanFill);
    const pending=this.pendingEvents;this.pendingEvents=[];
    for(const data of pending)this.event(data);
  }
  event(data) {
    if(!this.manifest){
      if(this.pendingEvents.length>=16384)throw Error('World startup event budget exceeded');
      this.pendingEvents.push(data);return;
    }
    if(data.event==='pose'){this.pose(data);return;}
    if(data.event==='npc-moves'){this.npcMoves(data);return;}
    if(data.event==='craft'){
      const craft=this.buildCraft(data,10318,'10318');
      this.releaseCraft();
      this.craftError=undefined;
      this.dataCraft=craft;this.craft=this.override??craft;
    }
    else if(data.event==='craft-error')this.craftError=data.error;
    else if(data.event==='horizon-index'){
      this.indices.set(data.region,this.buffer(data.indices,GPUBufferUsage.INDEX));
      this.terrainBundle=undefined;
    }
    else if(data.event==='horizon'){splatHeights(this.heightGrid,data.vertices,data.placement,WORLD_CENTRE,PLANET_RADIUS);this.heightDirty=true;
      this.horizonColour(data.region*4096+data.source[0]+64*data.source[1],{placement:data.placement});this.horizon.push({...this.drawable(data.vertices,data.placement,this.minimapAtlases[data.region]),
      region:data.region,near:data.near,cell:data.source[0]+64*data.source[1]});
      const hb=this.horizon[this.horizon.length-1].bounds;
      // WDL ocean tiles sit near -503 yd; anything higher is land that must not be flooded by the sea-level fill.
      if(hb&&hb[1][1]>-450&&this.oceanSpec){this.landRects.push([hb[0][0],hb[0][2],hb[1][0],hb[1][2]]);this.oceanDirty=true;}}
    else if(data.event==='horizon-material'){
      if(data.rgba.length!==MINIMAP_SIZE*MINIMAP_SIZE*4||!this.minimapAtlases[data.region]||
        !Number.isInteger(data.x)||!Number.isInteger(data.y)||data.x<0||data.x>=64||data.y<0||data.y>=64)
        throw Error('Invalid minimap upload');
      this.device.queue.writeTexture({texture:this.minimapAtlases[data.region],origin:[data.x*MINIMAP_SIZE,data.y*MINIMAP_SIZE]},
        data.rgba,{bytesPerRow:MINIMAP_SIZE*4},[MINIMAP_SIZE,MINIMAP_SIZE]);
    }
    else if(data.event==='terrain-material'){
      if(!this.tiles.has(data.index))return;
      this.releaseMaterial(this.materialPending.get(data.index)?.gpu);
      this.materialPending.set(data.index,{data,cursor:0});
    }
    else if(data.event==='exterior-water')this.water.push(this.drawable(data.vertices,data.placement));
    else if(data.event==='coast-water'){
      const entry=this.manifest.tiles[data.index],v=data.vertices;
      if(!Number.isInteger(data.index)||!entry||!(v instanceof Float32Array)||!v.length||v.length%21||
        v.byteLength>8*1024*1024||!Array.isArray(data.removed)||data.removed.includes(data.index)||
        new Set(data.removed).size!==data.removed.length)throw Error('Invalid distant water payload');
      const bytes=this.coastBytes+v.byteLength-(this.coast.get(data.index)?.buffer.size||0)
        -data.removed.reduce((n,index)=>n+(this.coast.get(index)?.buffer.size||0),0);
      if(bytes>COAST_GPU_LIMIT)throw Error('Distant water GPU budget exceeded');
      for(const index of data.removed){this.release(this.coast.get(index));this.coast.delete(index);}
      this.release(this.coast.get(data.index));
      const region=this.manifest.regions[entry.region];
      const item=this.drawable(v,[region.placement[0]+(entry.x-region.tile_origin[0])*1600/3,
        region.placement[1]+(entry.y-region.tile_origin[1])*1600/3]);
      let first=v.length/7;
      while(first>0&&v[(first-1)*7+6]===4)first--;
      if(first<v.length/7){
        item.backing={...item,first,count:v.length/7-first};
      }
      this.coast.set(data.index,item);
      this.coastBytes=bytes;
    }
    else if(data.event==='detail') {
      for(const index of data.removed){
        this.release(this.tiles.get(index));this.tiles.delete(index);
        this.releaseMaterial(this.materialPending.get(index)?.gpu);this.materialPending.delete(index);
      }
      for(const t of data.tiles){
        this.release(this.tiles.get(t.index));
        this.releaseMaterial(this.materialPending.get(t.index)?.gpu);this.materialPending.delete(t.index);
        const entry=this.manifest.tiles[t.index];
        let liquid=t.liquid;
        if(liquid===undefined){
          const values=[];
          for(let i=0;i<t.vertices.length;i+=7)if(t.vertices[i+6]===2)values.push(...t.vertices.subarray(i,i+7));
          liquid=new Float32Array(values);
        }
        if(!(liquid instanceof Float32Array)||liquid.length%21||liquid.byteLength>t.vertices.byteLength)
          throw Error('Invalid prepared terrain liquid');
        this.tiles.set(t.index,{...this.drawable(t.vertices,t.placement,this.minimapAtlases[entry.region]),liquid,
          entry,cell:entry.x+64*entry.y});
      }
      const entries=[...this.tiles.values()].map(t=>t.entry);
      for(const tile of this.tiles.values())tile.edgeMask=terrainEdgeMask(tile.entry,entries);
      for(const item of this.seams.values())this.release(item);this.seams.clear();
      for(const s of data.seams)if(s.vertices.length){
        const entry=this.manifest.tiles[s.index];
        this.seams.set(s.index,{...this.drawable(s.vertices,this.tiles.get(s.index).placement,this.minimapAtlases[entry.region]),
          cell:entry.x+64*entry.y});
      }
    } else if(data.event==='scene'||data.event==='far-scene') {
      const far=data.event==='far-scene',ownerRegion=far?this.farRegion:this.sceneRegion;
      const previousInstances=far?(this.farInstances||[]):(this.nearInstances||this.instances);
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
      if(far&&data.reset)this.clearFar();
      for(const key of data.removedAssets){const a=this.assets.get(key);a?.vertices.destroy();a?.indices.destroy();this.assets.delete(key);}
      for(const key of data.removedTextures){this.textures.get(key)?.destroy();this.textures.delete(key);}
      for(const a of data.assets){
        const batches=this.prepareBatches(a.batches);
        if(far)for(const batch of batches)if(batch.texture)batch.texture=`far:${batch.texture}`;
        const vertices=this.buffer(a.vertices,GPUBufferUsage.VERTEX);
        let indices;
        try {indices=this.buffer(a.indices,GPUBufferUsage.INDEX);}
        catch(error){vertices.destroy();throw error;}
        const asset={vertices,indices,batches,bounds:a.bounds,bytes:a.vertices.byteLength+a.indices.byteLength};
        const previous=this.assets.get(a.key);previous?.vertices.destroy();previous?.indices.destroy();
        this.assets.set(a.key,asset);
      }
      for(const t of data.textures){
        const texture=this.texture(t.width,t.height,t.rgba);
        this.textures.get(t.key)?.destroy();this.textures.set(t.key,texture);
      }
      if(instances!==undefined){
        if(far){this.farInstances=instances;this.farRegion=data.region;}
        else {this.nearInstances=instances;this.sceneRegion=data.region;}
      }
      const merged=readySceneInstances(this.nearInstances||(far?this.instances:previousInstances),
        this.farRegion===this.sceneRegion?this.farInstances||[]:[],this.assets,this.textures);
      if(merged.length!==this.instances.length||merged.some((i,n)=>i!==this.instances[n]))this.instances=merged;
      this.admissionFade??=new AdmissionFade();
      this.admissionFade.update(this.instances.filter(i=>this.assets.has(i.key)&&
        (!i.distant||sceneReady(i,this.assets,this.textures))).map(i=>i.id),performance.now()/1000);
      const wanted=new Set(this.instances.map(i=>i.id));
      for(const [key,item] of this.items)if((wanted&&!wanted.has(item.id)) || !this.assets.has(item.key)){
        this.items.delete(key);
      }
    }
  }
  clearFar() {
    for(const [key,a] of this.assets)if(key.startsWith('far:')){
      a.vertices.destroy();a.indices.destroy();this.assets.delete(key);
    }
    for(const [key,t] of this.textures)if(key.startsWith('far:')){t.destroy();this.textures.delete(key);}
    for(const [key,item] of this.items)if(item.key.startsWith('far:'))this.items.delete(key);
    this.farInstances=[];this.farRegion=undefined;
    this.instances=this.nearInstances||this.instances.filter(i=>!i.distant);
    this.sceneBundle=undefined;
  }
  uploadMaterials() {
    let uploaded=0;
    for(const [index,pending] of this.materialPending){
      const {data}=pending,tile=this.tiles.get(index);
      if(!tile){this.releaseMaterial(pending.gpu);this.materialPending.delete(index);continue;}
      if(!pending.gpu){
        if(!data.layers.length||data.layers.length>64||data.vertices.length%13||data.indices.length%3||
          !data.masks.length||data.masks.length%16384||data.masks.length>256*16384)throw Error('Invalid terrain GPU payload');
        const layers=this.device.createTexture({size:[TERRAIN_TEXTURE_SIZE,TERRAIN_TEXTURE_SIZE,data.layers.length],
          mipLevelCount:9,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
        const masks=this.device.createTexture({size:[64,64,data.masks.length/16384],
          format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
        pending.gpu={layers,masks};
      }
      // Stage at most three layer mip chains plus 1 MiB of masks per frame.
      while(pending.cursor<data.layers.length&&uploaded<1024*1024){
        const layer=pending.cursor++,mips=data.layers[layer].mips;
        if(mips.length!==9)throw Error('Terrain requires a complete mip chain');
        for(let level=0,size=TERRAIN_TEXTURE_SIZE;level<mips.length;level++,size/=2){
          if(mips[level].length!==size*size*4)throw Error('Invalid terrain mip size');
          this.device.queue.writeTexture({texture:pending.gpu.layers,mipLevel:level,origin:[0,0,layer]},
            mips[level],{bytesPerRow:size*4},[size,size]);
          uploaded+=mips[level].byteLength;
        }
      }
      if(pending.cursor<data.layers.length)return;
      const maskStart=pending.maskCursor||0,maskEnd=Math.min(data.masks.length,maskStart+1024*1024);
      this.device.queue.writeTexture({texture:pending.gpu.masks,origin:[0,0,maskStart/16384]},
        data.masks.subarray(maskStart,maskEnd),{bytesPerRow:256,rowsPerImage:64},[64,64,(maskEnd-maskStart)/16384]);
      pending.maskCursor=maskEnd;
      if(maskEnd<data.masks.length)return;
      const gpu=pending.gpu;
      gpu.vertices=this.buffer(data.vertices,GPUBufferUsage.VERTEX);gpu.indices=this.buffer(data.indices,GPUBufferUsage.INDEX);
      gpu.count=data.indices.length;gpu.bytes=data.vertices.byteLength+data.indices.byteLength+data.masks.byteLength+
        data.layers.reduce((n,l)=>n+l.mips.reduce((sum,m)=>sum+m.byteLength,0),0);
      gpu.group=this.device.createBindGroup({layout:this.splatPipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.frameUniforms,size:224}},{binding:1,resource:gpu.layers.createView({dimension:'2d-array'})},
        {binding:2,resource:gpu.masks.createView({dimension:'2d-array'})},{binding:3,resource:this.layerSampler},
        {binding:4,resource:this.minimapAtlases[tile.entry.region].createView()}]} );
      this.releaseMaterial(tile.material);tile.material=gpu;
      tile.buffer.destroy();tile.buffer=this.buffer(tile.liquid,GPUBufferUsage.VERTEX);tile.count=tile.liquid.length/7;
      this.materialPending.delete(index);return;
    }
  }
  scenePipeline(batch) {
    const blend=batch.blend,key=`${blend}:${!!batch.doubleSided}:${!!batch.noDepthWrite}`;
    if(this.pipelines.has(key))return this.pipelines.get(key);
    let colorBlend;
    if(blend==='alpha')colorBlend={color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
    if(blend==='add')colorBlend={color:{srcFactor:'src-alpha',dstFactor:'one'},alpha:{srcFactor:'one',dstFactor:'one'}};
    if(blend==='mod')colorBlend={color:{srcFactor:'dst',dstFactor:'zero'},alpha:{srcFactor:'zero',dstFactor:'one'}};
    if(blend==='mod2x')colorBlend={color:{srcFactor:'dst',dstFactor:'src'},alpha:{srcFactor:'zero',dstFactor:'one'}};
    const pipeline=this.device.createRenderPipeline({
      layout:this.scenePipelineLayout,vertex:{module:this.sceneModule,entryPoint:'vs',buffers:[{arrayStride:48,attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
        {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x4'}]}]},
      fragment:{module:this.sceneModule,entryPoint:'fs',targets:[{format:this.format,...(colorBlend?{blend:colorBlend}:{})}]},
      primitive:{topology:'triangle-list',cullMode:batch.doubleSided?'none':'back'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:!batch.noDepthWrite && !colorBlend,depthCompare:'less'},
    });
    this.pipelines.set(key,pipeline);return pipeline;
  }
  prepareBatches(batches) {
    return batches.map(batch=>{
      if(batch.water!==undefined&&typeof batch.water!=='boolean')throw Error('Invalid scene water flag');
      return {...batch,texture:batch.texture?modelPath(batch.texture):null,
        transparent:['alpha','add','mod','mod2x'].includes(batch.blend),pipeline:this.scenePipeline(batch)};
    });
  }
  sceneMatrix(instance,region,origin) {
    const cached=instance.rendered;
    if(!cached || cached.source!==instance.matrix || cached.region!==region ||
      cached.x!==origin[0] || cached.z!==origin[1])
      instance.rendered={source:instance.matrix,region,x:origin[0],z:origin[1],matrix:renderMatrix(instance.matrix,region,origin)};
    return instance.rendered.matrix;
  }
  drawTerrain(pass,terrain) {
    const cached=this.terrainBundle;
    if(!cached || cached.items.length!==terrain.length ||
      terrain.some((item,i)=>cached.items[i]!==item || cached.materials[i]!==item.material)) {
      const encoder=this.device.createRenderBundleEncoder({colorFormats:[this.format],depthStencilFormat:'depth24plus'});
      encoder.setPipeline(this.pipeline);
      for(const item of terrain){
        encoder.setBindGroup(0,item.group,[item.offset]);encoder.setVertexBuffer(0,item.buffer);
        if(item.region!==undefined){encoder.setIndexBuffer(this.indices.get(item.region),'uint32');encoder.drawIndexed(3072);}
        else encoder.draw(item.count,1,item.first||0);
      }
      encoder.setPipeline(this.splatPipeline);
      for(const tile of terrain)if(tile.material){
        const material=tile.material;
        encoder.setBindGroup(0,material.group,[tile.offset]);encoder.setVertexBuffer(0,material.vertices);
        encoder.setIndexBuffer(material.indices,'uint32');encoder.drawIndexed(material.count);
      }
      this.terrainBundle={items:terrain.slice(),materials:terrain.map(item=>item.material),bundle:encoder.finish()};
      this.terrainBundleBuilds++;
    }
    // Uniform bytes and atlas pixels remain live; only membership/material changes replace commands.
    pass.executeBundles([this.terrainBundle.bundle]);
  }
  /** Game light data arrives as raw DBC bytes, stays in memory, and falls back to the procedural sky on any problem. */
  setSky(data) {
    try {if(data.error)console.warn('Game sky unavailable',data.error);this.skyCatalog=data.error?undefined:new SkyCatalog(data);}
    catch(error) {console.warn('Game sky unavailable',error);this.skyCatalog=undefined;}
  }
  setSkyDome(data) {
    if(data.error){console.warn('Sky dome unavailable',data.error);return;}
    const textures=new Map(data.textures.map(t=>[t.key,this.texture(t.width,t.height,t.rgba)]));
    const sampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
    this.skyDome={vertices:this.buffer(data.asset.vertices,GPUBufferUsage.VERTEX),indices:this.buffer(data.asset.indices,GPUBufferUsage.INDEX),
      batches:data.asset.batches.map(b=>({first:b.firstIndex,count:b.indexCount,group:this.device.createBindGroup({
        layout:this.domePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.domeBuffer}},
          {binding:1,resource:(textures.get(b.texture)||this.white).createView()},{binding:2,resource:sampler}]})}))};
  }
  /** Feeds the globe colour grid: a tile needs both its WDL placement and its minimap, in either arrival order. */
  horizonColour(key,part) {
    const e={...this.horizonMini.get(key),...part};this.horizonMini.set(key,e);
    if(e.placement&&e.rgba){splatMinimap(this.colourGrid,e.rgba,MINIMAP_SIZE,e.placement,WORLD_CENTRE,PLANET_RADIUS,this.colourDirty);this.horizonMini.delete(key);}
  }
  /** Rebuilds the sea fill with land tiles cut out, at most once a second while horizon tiles are still arriving. */
  refreshOcean() {
    if(!this.oceanDirty||!this.oceanSpec||performance.now()-(this.oceanAt||0)<1000)return;
    this.oceanDirty=false;this.oceanAt=performance.now();
    const next=this.drawable(oceanMesh(this.oceanSpec.manifest,96,this.landRects),this.oceanSpec.origin),i=this.water.indexOf(this.oceanFill);
    this.release(this.oceanFill);if(i>=0)this.water[i]=next;else this.water.push(next);this.oceanFill=next;this.terrainBundle=undefined;
  }
  planetRects() {return this.manifest?.world_bounds?schematicRects(this.manifest):FALLBACK_RECTS;}
  drawPlanet(pass,pf,near) {
    const rects=this.planetRects(),key=JSON.stringify(rects);
    if(pf.registry&&this.surfaceKey!==key){
      this.surfaceRegistry=createRegistry([...defaultManifest(undefined,rects),adtChunk(this.colourGrid)]);
      this.surfaceBytes=bakeSurface(this.surfaceRegistry);this.colourDirty.clear();this.surfaceDirty=true;this.surfaceKey=key;
    }
    if(pf.registry&&this.colourDirty.size&&performance.now()-(this.colourAt||0)>1000){
      for(const k of this.colourDirty)this.surfaceBytes.set(surfaceTexel(this.surfaceRegistry,k%1024,Math.floor(k/1024),1024,512),k*4);
      this.colourDirty.clear();this.colourAt=performance.now();this.surfaceDirty=true;
    }
    if(this.surfaceDirty){this.device.queue.writeTexture({texture:this.surfaceTex},this.surfaceBytes,{bytesPerRow:4096},[1024,512]);this.surfaceDirty=false;}
    this.device.queue.writeBuffer(this.spaceBuffer,0,spaceUniform(this.view,sunDirection(this.timeOfDay),pf,rects,this.timeOfDay,near,200000));
    pass.setPipeline(this.spacePipeline);pass.setBindGroup(0,this.spaceGroup);pass.draw(3);
  }
  drawPatches(pass) {
    if(this.heightDirty&&performance.now()-(this.heightAt||0)>1000){
      this.device.queue.writeTexture({texture:this.heightTex},encodeHeights(this.heightGrid),{bytesPerRow:HEIGHT_W},[HEIGHT_W,HEIGHT_H]);
      this.heightDirty=false;this.heightAt=performance.now();
    }
    const eye=this.view.eye,patches=patchesAt(eye[0],eye[2],Math.max(0,eye[1]));
    this.device.queue.writeBuffer(this.patchBuffer,0,packPatches(patches));
    this.patchCount=patches.length;
    pass.setPipeline(this.patchPipeline);pass.setBindGroup(0,this.patchGroup);pass.setVertexBuffer(0,this.patchBuffer);pass.draw(PATCH_GRID*PATCH_GRID*6,patches.length);
  }
  drawSkyDome(pass) {
    const alpha=nightAlpha(this.timeOfDay);
    if(!this.skyDome||alpha<.01)return;
    const k=new Float32Array(16),v=this.view;
    k.set(v.look,0);k[3]=v.aspect;k.set(v.right,4);k.set(v.up,8);k[12]=nightAngle(this.timeOfDay);k[13]=alpha;
    this.device.queue.writeBuffer(this.domeBuffer,0,k);
    pass.setPipeline(this.domePipeline);pass.setVertexBuffer(0,this.skyDome.vertices);pass.setIndexBuffer(this.skyDome.indices,'uint32');
    for(const b of this.skyDome.batches){pass.setBindGroup(0,b.group);pass.drawIndexed(b.count,1,b.first);}
  }
  sampleSky() {
    const region=this.manifest?.regions[this.sceneRegion],map={Azeroth:0,Kalimdor:1}[region?.map];
    if(!this.skyCatalog||map===undefined)return undefined;
    const [x,z]=mapPosition(region,this.view.eye[0],this.view.eye[2]);
    return this.skyCatalog.sample(map,x,z,this.timeOfDay);
  }
  drawShadow(pass,state,near) {
    this.device.queue.writeBuffer(this.shadowBuffer,0,shadowUniform(this.view,state,shadowHalf(this.craft?.size),near));
    pass.setPipeline(this.shadowPipeline);pass.setBindGroup(0,this.shadowGroup);pass.draw(3);
  }
  // High tier (opt-in): built on first use so the noise bake and shader compile cost nothing for Standard.
  async enableHighClouds() {
    if(this.cloudHigh||this.cloudHighPending)return;
    this.cloudHighPending=true;
    try {
      const noise=this.device.createTexture({size:[CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE],dimension:'3d',format:'rg8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      this.device.queue.writeTexture({texture:noise},bakeCloudNoise(),{bytesPerRow:CLOUD_NOISE_SIZE*2,rowsPerImage:CLOUD_NOISE_SIZE},[CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE]);
      this.cloudNoise=noise.createView();
      this.cloudNoiseSampler=this.device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',addressModeW:'repeat'});
      const module=await this.shader(cloudShaderHigh);
      this.cloudHigh=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},
        fragment:{module,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
        primitive:{topology:'triangle-list',cullMode:'none'}});
      this.cloudHighGroup=this.highCloudGroup();
    } catch(e) {console.warn('high clouds unavailable',e);this.cloudHighFailed=true;}
    this.cloudHighPending=false;
  }
  highCloudGroup() {
    return this.depth&&this.device.createBindGroup({layout:this.cloudHigh.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.cloudBuffer}},
      {binding:1,resource:this.depth.createView()},{binding:2,resource:this.cloudNoise},{binding:3,resource:this.cloudNoiseSampler},...this.maskEntries()]});
  }
  maskEntries() {return [{binding:4,resource:this.cloudMask.view},{binding:5,resource:this.cloudMask.sampler}];}
  drawClouds(pass,time,daylight,near,high) {
    this.cloudMask.update(this.planetRects());
    const cu=cloudUniform(this.view,time,daylight,this.manifest,near,this.gameSky,undefined,this.timeOfDay,this.planet);
    this.device.queue.writeBuffer(this.cloudBuffer,0,cu);
    const useHigh=high&&this.cloudHighGroup;
    pass.setPipeline(useHigh?this.cloudHigh:this.cloudPipeline);pass.setBindGroup(0,useHigh?this.cloudHighGroup:this.cloudGroup);pass.draw(3);
  }
  drawScene(pass,draws) {
    const firstTransparent=draws.findIndex(draw=>draw.batch.transparent);
    const count=firstTransparent<0?draws.length:firstTransparent,cached=this.sceneBundle;
    const encode=(encoder,{asset,batch,item,pipeline})=>{
      encoder.setPipeline(pipeline);encoder.setBindGroup(0,item.group,[item.offset]);
      encoder.setVertexBuffer(0,asset.vertices);encoder.setIndexBuffer(asset.indices,'uint32');
      encoder.drawIndexed(batch.indexCount,1,batch.firstIndex);
    };
    if(!cached || cached.draws.length!==count || cached.draws.some((draw,i)=>
      draw.asset!==draws[i].asset || draw.batch!==draws[i].batch || draw.item!==draws[i].item ||
      draw.offset!==draws[i].item.offset)) {
      const encoder=this.device.createRenderBundleEncoder({colorFormats:[this.format],depthStencilFormat:'depth24plus'});
      for(let i=0;i<count;i++)encode(encoder,draws[i]);
      this.sceneBundle={draws:draws.slice(0,count).map(({asset,batch,item})=>({asset,batch,item,offset:item.offset})),
        bundle:encoder.finish()};
      this.sceneBundleBuilds++;
    }
    pass.executeBundles([this.sceneBundle.bundle]);
    // Transparent batches retain their camera-dependent back-to-front order.
    for(let i=count;i<draws.length;i++)encode(pass,draws[i]);
  }
  draw(state,flight,dt,time,settings,lookBack=false) {
    this.uploadMaterials();
    const canvas=this.canvas,width=Math.max(1,Math.round(canvas.clientWidth*Math.min(devicePixelRatio,2)));
    const height=Math.max(1,Math.round(canvas.clientHeight*Math.min(devicePixelRatio,2)));
    if(!this.depth || canvas.width!==width || canvas.height!==height) {
      canvas.width=width;canvas.height=height;this.depth?.destroy();
      this.depth=this.device.createTexture({size:[width,height],format:'depth24plus',
        usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
      this.shadowGroup=this.device.createBindGroup({layout:this.shadowPipeline.getBindGroupLayout(0),
        entries:[{binding:0,resource:{buffer:this.shadowBuffer}},{binding:1,resource:this.depth.createView()}]});
      this.cloudGroup=this.device.createBindGroup({layout:this.cloudPipeline.getBindGroupLayout(0),
        entries:[{binding:0,resource:{buffer:this.cloudBuffer}},{binding:1,resource:this.depth.createView()},...this.maskEntries()]});
      this.cloudHighGroup=this.cloudHigh&&this.highCloudGroup();
    }
    const origin=flight?[Math.round(flight[0]),Math.round(flight[2])]:[state[11],state[12]];
    const p=[state[0]-origin[0],state[1],state[2]-origin[1]];
    const {look,near,up:cameraUp}=cameraView(this,state,flight,dt,origin,settings,lookBack);
    const {right,up}=cameraAxes(look,cameraUp);
    this.cameraLook=look;
    const aspect=width/height;
    this.view={eye:[this.camera[0]+origin[0],this.camera[1],this.camera[2]+origin[1]],right,up,look,aspect};
    const planetOn=!!flight&&settings.planet!==false,pf=this.planet=planetFactors(planetOn?this.view.eye[1]:0,planetOn);pf.mesh=planetOn&&!!settings.globeMesh;pf.registry=planetOn&&!!settings.globeRegistry;
    const target=settings.night?0:1,previous=this.daylight??target;
    const daylight=this.daylight=Math.abs(target-previous)<.002?target:previous+(target-previous)*Math.min(1,dt*1.5);
    const sky0=DAY_SKY.map((v,i)=>NIGHT_SKY[i]+(v-NIGHT_SKY[i])*daylight);
    this.timeOfDay=this.timeLock??advanceTime(this.timeOfDay??(settings.night?0:DAY),settings.night,dt);
    const game=this.sampleSky(),sky=game?game.fog:sky0;pf.fog=(game?game.horizon:sky).slice(0,3);
    this.gameSky=game;
    const skyFloats=game?[...game.fog,1,...game.sun,0,...game.horizon,0,...game.mid,0]:new Array(16).fill(0);
    if(this.manifest?.world_bounds){const [mx,mz]=maelstromCentre(this.manifest);skyFloats[7]=mx-origin[0];skyFloats[11]=mz-origin[1];skyFloats[15]=1;}
    const view=[...this.camera,200000,...right,origin[0]%4096,...up,origin[1]%4096,...look,daylight];
    const distant=settings.horizon?this.horizon.filter(h=>!this.tiles.has(h.near)):[];
    const coastal=[...this.coast].flatMap(([index,item])=>
      this.tiles.has(index)?item.backing?[item.backing]:[]:settings.horizon?[item]:[]);
    this.refreshOcean();
    const allTerrain=this.cameraBlocked?[]:[...distant,...this.tiles.values(),...(settings.horizon?this.seams.values():[]),...this.water,...coastal,...this.flags,...this.gates];
    if(!flight&&!this.craft&&!this.cameraBlocked)allTerrain.push(this.body);
    const cachedView=this.terrainView;
    if(!cachedView || cachedView.bent!==(pf.bend>0) || viewChanged(cachedView.view,this.view) ||
      cachedView.all.length!==allTerrain.length || allTerrain.some((item,i)=>cachedView.all[i]!==item))
      this.terrainView={view:this.view,all:allTerrain,bent:pf.bend>0,
        visible:allTerrain.filter(item=>item===this.body || pf.bend>0 || boundsVisible(item.bounds,this.view))};
    const terrain=this.terrainView.visible;
    this.fadeTime=Math.max(this.fadeTime||0,time);
    const fadeTime=this.fadeTime;
    let uniformCount=0;
    const u=this.uniformData;
    const writeUniform=item=>{
      if(uniformCount>=16384)throw Error('World draw uniform budget exceeded');
      const base=uniformCount++*64;
      item.offset=base*4;u.set(view,base);u.set(skyFloats,base+40);u[base+28]=u[base+60]=pf.bend;u[base+29]=u[base+61]=pf.space;return base;
    };
    for(const item of terrain){
      const base=writeUniform(item),body=item===this.body;
      u.set(p,base+16);u[base+19]=body?state[3]:(item.edgeMask||0);
      if(item.material&&item.materialSince===undefined)item.materialSince=fadeTime;
      u[base+20]=aspect;u[base+21]=time;
      u[base+22]=body?state[4]:Math.min(1,Math.max(0,(fadeTime-(item.materialSince??fadeTime))/.35));u[base+23]=near;
      u[base+24]=body?0:item.placement[0]-origin[0];u[base+25]=0;
      u[base+26]=body?0:item.placement[1]-origin[1];u[base+27]=item.cell??-1;
    }
    const fxIn={...this.fxInput,...this.fxOverride},beam=beamState({throttle:fxIn.throttle,boosting:fxIn.boosting,heat:fxIn.heat,health:fxIn.health});
const draws=[],selection=this.cameraBlocked?{selected:[],omitted:0}:
      sceneSelection(this.instances.filter(i=>(settings.distant!==false || !i.distant)&&
        (!i.distant||sceneReady(i,this.assets,this.textures))),this.assets,(instance,asset)=>
        sceneVisible(asset.bounds,this.sceneMatrix(instance,this.manifest.regions[this.sceneRegion],origin),
          this.camera,right,up,look,aspect));
    const append=(asset,instance,m,textures,items)=>{
        const distance=Math.hypot(m[12]-this.camera[0],m[13]-this.camera[1],m[14]-this.camera[2]);
        this.admissionFade??=new AdmissionFade();
        const coverage=instance.craft?1:this.admissionFade.opacity(instance.id,fadeTime);
        const cached=instance.drawItems || (instance.drawItems=[]);
        for(let b=0;b<asset.batches.length;b++) {
          const batch=asset.batches[b];
          const texture=(batch.texture&&textures.get(batch.texture))||this.white;
          let item=cached[b];
          if(!item || item.texture!==texture || item.asset!==asset) {
            const key=`${instance.id}:${instance.key}:${b}`;
            item=items.get(key);
            if(!item || item.texture!==texture || item.asset!==asset) {
              const sampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',
                addressModeU:batch.wrapX?'repeat':'clamp-to-edge',addressModeV:batch.wrapY?'repeat':'clamp-to-edge'});
              item={id:instance.id,key:instance.key,asset,texture,group:this.device.createBindGroup({layout:this.sceneLayout,entries:[
                {binding:0,resource:{buffer:this.frameUniforms,size:256}},{binding:1,resource:texture.createView()},{binding:2,resource:sampler},
                {binding:3,resource:this.waterNormals.createView()},{binding:4,resource:this.waveSampler}]} )};
              items.set(key,item);
            }
            cached[b]=item;
          }
          const base=writeUniform(item);
          u[base+16]=aspect;u[base+17]=time;u[base+18]=batch.water?1:0;u[base+19]=near;u.set(m,base+20);
          u[base+36]=batch.alphaCutoff||0;u[base+37]=batch.emissive?1:0;u[base+38]=instance.distant?1:0;
          u[base+39]=distance<128?1:coverage;
if(batch.beam&&instance.craft&&beam)u.set(beam,base+56);else u.fill(0,base+56,base+60);
          draws.push({asset,batch,item,distant:instance.distant,craft:instance.craft,pipeline:batch.pipeline,distance});
        }
    };
    if(settings.scenery && this.sceneRegion!==undefined) {
      const r=this.manifest.regions[this.sceneRegion];
      for(const instance of selection.selected) {
        const asset=this.posedAsset(instance,this.assets.get(instance.key));if(!asset)continue;
        const mv=this.moves?.size&&instance.id.includes(':npc:')?this.moves.get(instance.id):undefined;
        append(asset,instance,mv?this.moveMatrix(instance,mv,r,origin):this.sceneMatrix(instance,r,origin),this.textures,this.items);
      }
    }
    const wreckAge=this.wreck?performance.now()/1000-this.wreck.t0:0;
    if(this.wreck&&wreckAge>WRECK_SECONDS)this.endWreck();
    const wreckFrameNow=this.wreck&&wreckFrame(this.wreck,wreckAge);
    if(wreckFrameNow)this.wreck.parts.forEach((p,i)=>append(p.asset,p.instance,partMatrix(wreckFrameNow.subarray(i*7,i*7+7),p.center,this.wreck.scale,origin),this.craft.textures,this.craft.items));
    else if((!flight||this.showCraftInFlight)&&this.craft&&this.cameraMode!=='cockpit')append(this.craft.asset,this.craft.instance,
      craftMatrix(state,origin,this.craft.metadata.scale),this.craft.textures,this.craft.items);
    for(const p of this.props||[]){const c=Math.cos(p.yaw),s=Math.sin(p.yaw),k=p.scale;
      append(p.craft.asset,p.craft.instance,p.space==='craft'?craftMatrix([p.pos[0],p.pos[1],p.pos[2],p.yaw,0],origin,k):
        new Float32Array([c*k,0,-s*k,0,0,k,0,0,s*k,0,c*k,0,p.pos[0]-origin[0],p.pos[1],p.pos[2]-origin[1],1]),p.craft.textures,p.craft.items);}
    if(!this.wreck&&!flight&&this.craft?.flame&&this.cameraMode!=='cockpit') {
      const m=craftMatrix(state,origin,this.craft.metadata.scale),k=(.35+.9*Math.min(1,Math.abs(state[5])/150))*(1+.08*Math.sin(time*45));
      for(const part of this.craft.flame.parts) {
        const [x,y,z]=part.at,f=new Float32Array(m);
        for(let i=0;i<3;i++){f[i]=m[i]*k;f[12+i]=m[12+i]+m[i]*x+m[4+i]*y+m[8+i]*z;}
        append(this.craft.flame.asset,part.instance,f,this.craft.textures,this.craft.items);
      }
    }
    draws.sort((a,b)=>a.batch.transparent-b.batch.transparent || (a.batch.transparent?b.distance-a.distance:0));
    // Race props (gates, beacons) draw after the clouds so nearer props are never veiled by them.
    const propDraws=draws.filter(d=>d.item.id.startsWith('prop:'));
    if(propDraws.length)for(let i=draws.length;i--;)if(draws[i].item.id.startsWith('prop:'))draws.splice(i,1);
    if(uniformCount)this.device.queue.writeBuffer(this.frameUniforms,0,this.uniformData.buffer,0,uniformCount*256);
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({
      colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:sky[0],g:sky[1],b:sky[2],a:1},loadOp:'clear',storeOp:'store'}],
      depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'},
    });
    if(!this.cameraBlocked){
      if(game){this.device.queue.writeBuffer(this.skyBuffer,0,skyUniform(this.view,game,this.timeOfDay,horizonDip(this.view.eye[1],pf.bend),pf.space));pass.setPipeline(this.skyPipeline);pass.setBindGroup(0,this.skyGroup);pass.draw(3);this.drawSkyDome(pass);}
      if(pf.globe>0)this.drawPlanet(pass,pf,near);
      if(pf.globe>0&&pf.mesh)this.drawPatches(pass);
      this.drawTerrain(pass,terrain);this.drawScene(pass,draws);
    }
    pass.end();
    if(!this.cameraBlocked&&!flight&&settings.shadows!==false) {
      const shadowPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}]});
      this.drawShadow(shadowPass,state,near);shadowPass.end();
    }
    const nowMs=performance.now(),auto=settings.cloudQuality!=='high'&&settings.cloudQuality!=='standard';
    this.cloudGuard??=new SlowFrameGuard();
    if(auto&&!this.cloudSlow&&this.cloudHighGroup&&settings.clouds!==false&&this.cloudGuard.push(nowMs-(this.lastRenderMs??nowMs))){this.cloudSlow=true;console.warn('auto clouds: slow frames, using Standard');}
    this.lastRenderMs=nowMs;
    const highClouds=resolveCloudQuality(settings.cloudQuality,{highFailed:this.cloudHighFailed,slow:this.cloudSlow});
    if(highClouds&&!this.cloudHigh&&!this.cloudHighFailed)this.enableHighClouds();
    if(!this.cameraBlocked&&settings.clouds!==false) {
      // Clouds read the finished scene depth to clip their ray march, so they never need a depth-test bias.
      const cloudPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}]});
      this.drawClouds(cloudPass,time,daylight,near,highClouds);cloudPass.end();
    }
    if(!this.cameraBlocked&&propDraws.length) {
      const propPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}],
        depthStencilAttachment:{view:this.depth.createView(),depthLoadOp:'load',depthStoreOp:'store'}});
      for(const {asset,batch,item,pipeline} of propDraws) {
        propPass.setPipeline(pipeline);propPass.setBindGroup(0,item.group,[item.offset]);propPass.setVertexBuffer(0,asset.vertices);
        propPass.setIndexBuffer(asset.indices,'uint32');propPass.drawIndexed(batch.indexCount,1,batch.firstIndex);
      }
      propPass.end();
    }
    const fx=this.particles,quality=QUALITY[settings.particles]??QUALITY.medium;
    if(fx)fx.quality=quality;
    const craft=this.craft;
    if(fx&&quality>0&&craft?.source&&!this.wreck&&!this.cameraBlocked&&(!flight||this.showCraftInFlight)&&this.cameraMode!=='cockpit') {
      const input=this.fxInput||{},speed=Math.abs(state[5]),scale=craft.metadata.scale;
      craft.fx??={points:exhaustPoints(craft.source.vertices,craft.source.indices,craft.metadata),length:craft.size[0]};
      emitPlumes(fx,{points:craft.fx.points,matrix:craftMatrix(state,origin,scale),origin,scale,length:craft.fx.length,speed,
        thrust:input.throttle??Math.min(1,speed/150),boosting:!!input.boosting,dt:Math.min(dt,.1)});
      emitGroundDust(fx,{matrix:craftMatrix(state,origin,scale),origin,scale,length:craft.fx.length,speed,drift:!!input.drifting,grounded:state[7]>0,dt:Math.min(dt,.1)});
      if(input.heat)emitHeatSmoke(fx,{points:craft.fx.points,matrix:craftMatrix(state,origin,scale),origin,length:craft.fx.length,heat:input.heat,dt:Math.min(dt,.1)});
    }
    if(fx&&quality>0&&!this.cameraBlocked){
      fx.update(Math.min(dt,.1));
      const count=fx.fill(this.particleInstances,this.view.eye);
      if(count){
        this.device.queue.writeBuffer(this.particleBuffer,0,this.particleInstances,0,count*INSTANCE_FLOATS);
        this.device.queue.writeBuffer(this.particleUniformBuffer,0,particleUniform(this.view,near));
        const fxPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}],
          depthStencilAttachment:{view:this.depth.createView(),depthReadOnly:true}});
        fxPass.setPipeline(this.particlePipeline);fxPass.setBindGroup(0,this.particleGroup);fxPass.setVertexBuffer(0,this.particleBuffer);
        fxPass.draw(6,count);fxPass.end();
      }
    }
    if(fx&&quality>0&&this.wreck&&wreckFrameNow&&craft?.fx) {
      const size=craft.fx.length/3.5,sdt=Math.max(1/240,Math.min(dt,.1));
      this.wreck.parts.forEach((p,i)=>{const f=wreckFrameNow.subarray(i*7,i*7+7);emitDebris(fx,p.memo??={},[f[0],f[1],f[2]],wreckAge,sdt,size,`w${i}`,WRECK_SECONDS);});
    }
    this.particleCount=fx?.count||0;
    this.device.queue.submit([encoder.finish()]);
    return {horizonTiles:distant.length,detailedTiles:this.tiles.size,sceneInstances:this.instances.length,
      culledTerrainDraws:allTerrain.length-terrain.length,
      texturedTerrainTiles:[...this.tiles.values()].filter(t=>t.material).length,
      terrainGpuBytes:[...this.tiles.values()].reduce((n,t)=>n+(t.material?.bytes||0),0),
      terrainUploadPending:this.materialPending.size,minimapGpuBytes:this.minimapAtlases.length*(64*MINIMAP_SIZE)**2*4,
      uniformUploads:uniformCount?1:0,uniformBytes:uniformCount*256,terrainBundleBuilds:this.terrainBundleBuilds,
      sceneBundleBuilds:this.sceneBundleBuilds,
      craftDraws:draws.filter(d=>d.craft).length,craftPose:this.craft?.metadata.pose||'placeholder',craftGpuBytes:this.craft?.bytes||0,
      craftReady:!!this.craft,cockpitAvailable:!!this.craft?.anchor,cameraMode:this.cameraMode,
      cameraBlocked:this.cameraBlocked,worldDraws:terrain.length+draws.length,
      coastalWaterTiles:coastal.length,coastalWaterGpuBytes:this.coastBytes,
      waterShaderGpuBytes:this.waterNormalBytes||0,wmoWaterDraws:draws.filter(d=>d.batch.water).length,
      craftSize:this.craft?.size,craftSource:this.craft&&this.craft===this.override?'model':'game data',craftStatus:this.craft?'ready':this.craftError?'failed':'loading',
      craftTriangles:this.craft?this.craft.asset.count/3:0,craftError:this.craftError,
      npcInstances:this.instances.filter(i=>i.id.includes(':npc:')).length,
      wmoInstances:this.instances.filter(i=>i.kind==='group').length,
      texturedDraws:draws.filter(d=>d.item.texture!==this.white).length,
      alphaDraws:draws.filter(d=>d.batch.alphaCutoff>0).length,
      sceneTriangles:draws.reduce((n,d)=>n+d.batch.indexCount/3,0),gpuOmittedInstances:selection.omitted,culledSceneInstances:selection.culled||0,
      distantDraws:draws.filter(d=>d.distant).length,distantAlphaDraws:draws.filter(d=>d.distant&&d.batch.alphaCutoff>0).length,
      sceneDraws:draws.length,sceneGpuMeshBytes:[...this.assets.values()].reduce((n,a)=>n+a.bytes,0),origin};
  }
}
