import {modelPath} from './scene-stream.js';
import {MINIMAP_SIZE,TERRAIN_TEXTURE_SIZE} from './terrain-stream.js';
import {cameraView,craftMatrix,cockpitAnchor} from './world-camera.js';
import {COAST_GPU_LIMIT} from './water-stream.js';
export {craftMatrix} from './world-camera.js';
const SKY=[.08,.15,.20,1];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};
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
export function sceneVisible(bounds,m,eye,right,up,forward,aspect) {
  if(!bounds)return true;
  const lo=bounds[0],hi=bounds[1],hx=(hi[0]-lo[0])/2,hy=(hi[1]-lo[1])/2,hz=(hi[2]-lo[2])/2;
  const x=lo[0]+hx,y=lo[1]+hy,z=lo[2]+hz;
  const cx=m[0]*x+m[4]*y+m[8]*z+m[12]-eye[0],
    cy=m[1]*x+m[5]*y+m[9]*z+m[13]-eye[1],
    cz=m[2]*x+m[6]*y+m[10]*z+m[14]-eye[2];
  for(let plane=0;plane<5;plane++){
    const axis=plane===0?forward:plane<3?right:up,sign=plane===0?1:plane%2?-1:1,
      slope=plane===0?0:.55*(plane<3?aspect:1);
    const nx=axis[0]*sign+forward[0]*slope,ny=axis[1]*sign+forward[1]*slope,nz=axis[2]*sign+forward[2]*slope;
    const radius=hx*Math.abs(nx*m[0]+ny*m[1]+nz*m[2])+hy*Math.abs(nx*m[4]+ny*m[5]+nz*m[6])
      +hz*Math.abs(nx*m[8]+ny*m[9]+nz*m[10]);
    if(cx*nx+cy*ny+cz*nz+radius<-.01)return false;
  }
  return true;
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
const terrainShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,body:vec4f,settings:vec4f,tile:vec4f};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var minimap:texture_2d<f32>;
@group(0) @binding(2) var mapSampler:sampler;
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
  let relative=position-u.eye.xyz;let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.n=normal;v.material=material;v.uv=p.xz/(1600.0/3.0);return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let phase=v.p.x*.16+v.p.z*.12+u.settings.y;
  let ripple=.5+.5*sin(phase)*(1.0-smoothstep(.5,3.0,fwidth(phase)));
  let light=.35+.65*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0);
  var color=vec3f(.63,.59,.40)*light;
  let cell=vec2f(u.tile.w%64.0,floor(u.tile.w/64.0));
  let mapUv=(cell+clamp(v.uv,vec2f(.5/32.0),vec2f(1.0-.5/32.0)))/64.0;
  let mapColor=textureSample(minimap,mapSampler,mapUv);
  if(v.material==3.0 && u.tile.w>=0.0){color=mix(color,mapColor.rgb,mapColor.a);}
  if(v.material==1.0){color=vec3f(.1,.89,.82)*light;}
  if(v.material==2.0 || v.material==4.0){color=mix(vec3f(.025,.18,.29),vec3f(.06,.36,.48),ripple);}
  let fog=clamp(length(v.p-u.eye.xyz)/150000.0,0.0,.93);
  return vec4f(mix(color,vec3f(.08,.15,.20),fog),1);
}`;
const splatShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,body:vec4f,settings:vec4f,tile:vec4f};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var layers:texture_2d_array<f32>;
@group(0) @binding(2) var masks:texture_2d_array<f32>;
@group(0) @binding(3) var layerSampler:sampler;
@group(0) @binding(4) var minimap:texture_2d<f32>;
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) uv:vec2f,
  @location(2) @interpolate(flat) layers:vec4u,@location(3) @interpolate(flat) chunk:u32,@location(4) light:f32,
  @location(5) tileUv:vec2f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,
  @location(3) ids:vec4f,@location(4) chunk:f32)->V {
  let position=p+u.tile.xyz;let relative=position-u.eye.xyz;let z=dot(relative,u.forward.xyz);
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
  let fog=clamp(length(v.p-u.eye.xyz)/150000.0,0.0,.93);
  return vec4f(mix(color,vec3f(.08,.15,.20),fog),1);
}`;
const sceneShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,settings:vec4f,model:mat4x4f,material:vec4f};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var imageSampler:sampler;
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) color:vec4f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) color:vec4f)->V {
  let position=(u.model*vec4f(p,1)).xyz;let relative=position-u.eye.xyz;let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.n=(u.model*vec4f(n,0)).xyz;v.uv=uv;v.color=color;return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let texel=textureSample(image,imageSampler,v.uv)*v.color;
  if(texel.a<u.material.x){discard;}
  let distance=length(v.p-u.eye.xyz);
  if(u.material.z>0.0 && fract(dot(floor(v.clip.xy),vec2f(.754877666,.569840296)))>=1.0-smoothstep(3500.0,6000.0,distance)){discard;}
  let light=mix(.4+.6*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0),1.0,u.material.y);
  let fog=max(clamp(distance/150000.0,0.0,.93),u.material.z*.8*smoothstep(3500.0,6000.0,distance));
  return vec4f(mix(texel.rgb*light,vec3f(.08,.15,.20),fog),texel.a);
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
    this.tiles=new Map();this.seams=new Map();this.horizon=[];this.water=[];this.coast=new Map();this.indices=new Map();
    this.coastBytes=0;
    this.assets=new Map();this.textures=new Map();this.items=new Map();this.instances=[];this.pipelines=new Map();
    this.materialPending=new Map();this.minimapAtlases=[];
    this.pendingEvents=[];
    this.terrainBundleBuilds=0;this.sceneBundleBuilds=0;
    this.uniformData=new Float32Array(16384*64);
    this.frameUniforms=device.createBuffer({size:this.uniformData.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
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
    this.terrainLayout=this.device.createBindGroupLayout({entries:[uniformEntry(112),
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
    this.splatLayout=this.device.createBindGroupLayout({entries:[uniformEntry(112),
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
      uniformEntry(160),
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
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
    this.mapSampler=this.device.createSampler({minFilter:'linear',magFilter:'linear'});
    this.layerSampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',
      addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:4});
    this.emptyMap=this.texture(1,1,new Uint8Array(4));
    this.white=this.texture(1,1,new Uint8Array([255,255,255,255]));
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
    return {buffer:this.buffer(vertices,GPUBufferUsage.VERTEX),count:vertices.length/7,placement,
      group:this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.frameUniforms,size:112}},{binding:1,resource:map.createView()},{binding:2,resource:this.mapSampler}]})};
  }
  releaseMaterial(item){if(item)for(const resource of [item.vertices,item.indices,item.layers,item.masks])resource?.destroy();}
  release(item){item?.buffer.destroy();this.releaseMaterial(item?.material);}
  releaseCraft(){
    if(!this.craft)return;
    this.craft.asset.vertices.destroy();this.craft.asset.indices.destroy();
    for(const texture of this.craft.textures.values())texture.destroy();
    this.craft=undefined;
  }
  reset() {
    this.terrainBundle=undefined;this.terrainBundleBuilds=0;
    this.sceneBundle=undefined;this.sceneBundleBuilds=0;
    this.releaseCraft();
    this.craftError=undefined;
    for(const item of [...this.tiles.values(),...this.seams.values(),...this.horizon,...this.water,...this.coast.values()])this.release(item);
    this.tiles.clear();this.seams.clear();this.horizon=[];this.water=[];this.coast.clear();this.coastBytes=0;
    for(const index of this.indices.values())index.destroy();this.indices.clear();
    for(const asset of this.assets.values()){asset.vertices.destroy();asset.indices.destroy();}this.assets.clear();
    for(const texture of this.textures.values())texture.destroy();this.textures.clear();
    this.items.clear();
    this.instances=[];this.nearInstances=[];this.farInstances=[];this.farRegion=undefined;
    this.camera=undefined;this.origin=[0,0];
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
    const [x,z,right,bottom]=manifest.ocean,y=manifest.sea_level,w=right-x,h=bottom-z;
    this.water.push(this.drawable(new Float32Array([
      0,y,0,0,1,0,2,w,y,0,0,1,0,2,w,y,h,0,1,0,2,0,y,0,0,1,0,2,w,y,h,0,1,0,2,0,y,h,0,1,0,2,
    ]),[x,z]));
    const pending=this.pendingEvents;this.pendingEvents=[];
    for(const data of pending)this.event(data);
  }
  event(data) {
    if(!this.manifest){
      if(this.pendingEvents.length>=16384)throw Error('World startup event budget exceeded');
      this.pendingEvents.push(data);return;
    }
    if(data.event==='craft'){
      if(data.metadata.display!==10318||!Number.isFinite(data.metadata.scale)||data.metadata.scale<=0||
        data.asset.indices.length>60000||data.textures.length>16)throw Error('Invalid authored craft payload');
      const bytes=data.asset.vertices.byteLength+data.asset.indices.byteLength+data.textures.reduce((n,t)=>n+t.rgba.byteLength,0);
      if(bytes>32*1024*1024)throw Error('Authored craft exceeds GPU budget');
      const anchor=cockpitAnchor(data.metadata),batches=this.prepareBatches(data.asset.batches);
      this.releaseCraft();
      this.craftError=undefined;
      this.craft={asset:{vertices:this.buffer(data.asset.vertices,GPUBufferUsage.VERTEX),
        indices:this.buffer(data.asset.indices,GPUBufferUsage.INDEX),batches,count:data.asset.indices.length},
        textures:new Map(data.textures.map(t=>[t.key,this.texture(t.width,t.height,t.rgba)])),
        metadata:data.metadata,anchor,items:new Map(),instance:{id:'player-craft',key:'10318',craft:true},bytes};
    }
    else if(data.event==='craft-error')this.craftError=data.error;
    else if(data.event==='horizon-index'){
      this.indices.set(data.region,this.buffer(data.indices,GPUBufferUsage.INDEX));
      this.terrainBundle=undefined;
    }
    else if(data.event==='horizon')this.horizon.push({...this.drawable(data.vertices,data.placement,this.minimapAtlases[data.region]),
      region:data.region,near:data.near,cell:data.source[0]+64*data.source[1]});
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
        this.tiles.set(t.index,{...this.drawable(t.vertices,t.placement),liquid,
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
        const near=this.nearInstances||(far?this.instances:previousInstances),nearIds=new Set(near.map(i=>i.id));
        this.instances=[...near,...(this.farRegion===this.sceneRegion?this.farInstances||[]:[])
          .filter(i=>!nearIds.has(i.id))];
      }
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
        {binding:0,resource:{buffer:this.frameUniforms,size:112}},{binding:1,resource:gpu.layers.createView({dimension:'2d-array'})},
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
    return batches.map(batch=>({...batch,texture:batch.texture?modelPath(batch.texture):null,
      transparent:['alpha','add','mod','mod2x'].includes(batch.blend),pipeline:this.scenePipeline(batch)}));
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
      this.depth=this.device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    }
    const origin=flight?[Math.round(flight[0]),Math.round(flight[2])]:[state[11],state[12]];
    const p=[state[0]-origin[0],state[1],state[2]-origin[1]];
    const {look,near,up:cameraUp}=cameraView(this,state,flight,dt,origin,settings,lookBack);
    const right=unit(cross(look,cameraUp||[0,1,0])),up=cross(right,look);
    this.cameraLook=look;
    const view=[...this.camera,200000,...right,0,...up,0,...look,0];
    const distant=settings.horizon?this.horizon.filter(h=>!this.tiles.has(h.near)):[];
    const coastal=[...this.coast].flatMap(([index,item])=>
      this.tiles.has(index)?item.backing?[item.backing]:[]:settings.horizon?[item]:[]);
    const terrain=this.cameraBlocked?[]:[...distant,...this.tiles.values(),...(settings.horizon?this.seams.values():[]),...this.water,...coastal];
    if(!flight&&!this.craft&&!this.cameraBlocked)terrain.push(this.body);
    let uniformCount=0;
    const u=this.uniformData,aspect=width/height;
    const writeUniform=item=>{
      if(uniformCount>=16384)throw Error('World draw uniform budget exceeded');
      const base=uniformCount++*64;
      item.offset=base*4;u.set(view,base);return base;
    };
    for(const item of terrain){
      const base=writeUniform(item),body=item===this.body;
      u.set(p,base+16);u[base+19]=body?state[3]:(item.edgeMask||0);
      u[base+20]=aspect;u[base+21]=time;u[base+22]=state[4];u[base+23]=near;
      u[base+24]=body?0:item.placement[0]-origin[0];u[base+25]=0;
      u[base+26]=body?0:item.placement[1]-origin[1];u[base+27]=item.cell??-1;
    }
    const draws=[],selection=this.cameraBlocked?{selected:[],omitted:0}:
      sceneSelection(this.instances.filter(i=>settings.distant!==false || !i.distant),this.assets,(instance,asset)=>
        sceneVisible(asset.bounds,this.sceneMatrix(instance,this.manifest.regions[this.sceneRegion],origin),
          this.camera,right,up,look,aspect));
    const append=(asset,instance,m,textures,items)=>{
        const distance=Math.hypot(m[12]-this.camera[0],m[13]-this.camera[1],m[14]-this.camera[2]);
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
                {binding:0,resource:{buffer:this.frameUniforms,size:160}},{binding:1,resource:texture.createView()},{binding:2,resource:sampler}]} )};
              items.set(key,item);
            }
            cached[b]=item;
          }
          const base=writeUniform(item);
          u[base+16]=aspect;u[base+17]=time;u[base+18]=0;u[base+19]=near;u.set(m,base+20);
          u[base+36]=batch.alphaCutoff||0;u[base+37]=batch.emissive?1:0;u[base+38]=instance.distant?1:0;u[base+39]=0;
          draws.push({asset,batch,item,distant:instance.distant,craft:instance.craft,pipeline:batch.pipeline,distance});
        }
    };
    if(settings.scenery && this.sceneRegion!==undefined) {
      const r=this.manifest.regions[this.sceneRegion];
      for(const instance of selection.selected) {
        const asset=this.assets.get(instance.key);if(!asset)continue;
        append(asset,instance,this.sceneMatrix(instance,r,origin),this.textures,this.items);
      }
    }
    if(!flight&&this.craft&&this.cameraMode!=='cockpit')append(this.craft.asset,this.craft.instance,
      craftMatrix(state,origin,this.craft.metadata.scale),this.craft.textures,this.craft.items);
    draws.sort((a,b)=>a.batch.transparent-b.batch.transparent || (a.batch.transparent?b.distance-a.distance:0));
    if(uniformCount)this.device.queue.writeBuffer(this.frameUniforms,0,this.uniformData.buffer,0,uniformCount*256);
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({
      colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:SKY,loadOp:'clear',storeOp:'store'}],
      depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'},
    });
    if(!this.cameraBlocked){this.drawTerrain(pass,terrain);this.drawScene(pass,draws);}
    pass.end();this.device.queue.submit([encoder.finish()]);
    return {horizonTiles:distant.length,detailedTiles:this.tiles.size,sceneInstances:this.instances.length,
      texturedTerrainTiles:[...this.tiles.values()].filter(t=>t.material).length,
      terrainGpuBytes:[...this.tiles.values()].reduce((n,t)=>n+(t.material?.bytes||0),0),
      terrainUploadPending:this.materialPending.size,minimapGpuBytes:this.minimapAtlases.length*(64*MINIMAP_SIZE)**2*4,
      uniformUploads:uniformCount?1:0,uniformBytes:uniformCount*256,terrainBundleBuilds:this.terrainBundleBuilds,
      sceneBundleBuilds:this.sceneBundleBuilds,
      craftDraws:draws.filter(d=>d.craft).length,craftPose:this.craft?.metadata.pose||'placeholder',craftGpuBytes:this.craft?.bytes||0,
      craftReady:!!this.craft,cockpitAvailable:!!this.craft?.anchor,cameraMode:this.cameraMode,
      cameraBlocked:this.cameraBlocked,worldDraws:terrain.length+draws.length,
      coastalWaterTiles:coastal.length,coastalWaterGpuBytes:this.coastBytes,
      craftStatus:this.craft?'ready':this.craftError?'failed':'loading',
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
