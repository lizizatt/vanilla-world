import {modelPath} from './scene-stream.js';
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
export function sceneSelection(instances,assets) {
  const selected=[];
  let triangles=0,draws=0;
  for(const instance of instances) {
    const asset=assets.get(instance.key);
    if(!asset)continue;
    const cost=asset.batches.reduce((n,b)=>n+b.indexCount/3,0);
    if(triangles+cost>2000000 || draws+asset.batches.length>4096)break;
    selected.push(instance);triangles+=cost;draws+=asset.batches.length;
  }
  return {selected,triangles,omitted:instances.length-selected.length};
}
const terrainShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,body:vec4f,settings:vec4f,tile:vec4f};
@group(0) @binding(0) var<uniform> u:U;
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) @interpolate(flat) material:f32};
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
  v.p=position;v.n=normal;v.material=material;return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let phase=v.p.x*.16+v.p.z*.12+u.settings.y;
  let ripple=.5+.5*sin(phase)*(1.0-smoothstep(.5,3.0,fwidth(phase)));
  let light=.35+.65*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0);
  var color=vec3f(.63,.59,.40)*light;
  if(v.material==1.0){color=vec3f(.1,.89,.82)*light;}
  if(v.material==2.0){color=mix(vec3f(.025,.18,.29),vec3f(.06,.36,.48),ripple);}
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
  let light=mix(.4+.6*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0),1.0,u.material.y);
  let fog=clamp(length(v.p-u.eye.xyz)/150000.0,0.0,.93);
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
    this.tiles=new Map();this.seams=new Map();this.horizon=[];this.water=[];this.indices=new Map();
    this.assets=new Map();this.textures=new Map();this.items=new Map();this.instances=[];this.pipelines=new Map();
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
    const terrain=await shader(terrainShader);this.sceneModule=await shader(sceneShader);
    this.pipeline=await this.device.createRenderPipelineAsync({
      layout:'auto',vertex:{module:terrain,entryPoint:'vs',buffers:[{arrayStride:28,attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32'}]}]},
      fragment:{module:terrain,entryPoint:'fs',targets:[{format:this.format}]},
      primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'},
    });
    this.sceneLayout=this.device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
    ]});
    this.scenePipelineLayout=this.device.createPipelineLayout({bindGroupLayouts:[this.sceneLayout]});
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
  drawable(vertices,placement) {
    const uniform=this.device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    return {buffer:this.buffer(vertices,GPUBufferUsage.VERTEX),count:vertices.length/7,placement,uniform,
      group:this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]})};
  }
  release(item){item?.buffer.destroy();item?.uniform.destroy();}
  reset() {
    for(const item of [...this.tiles.values(),...this.seams.values(),...this.horizon,...this.water])this.release(item);
    this.tiles.clear();this.seams.clear();this.horizon=[];this.water=[];
    for(const index of this.indices.values())index.destroy();this.indices.clear();
    for(const asset of this.assets.values()){asset.vertices.destroy();asset.indices.destroy();}this.assets.clear();
    for(const texture of this.textures.values())texture.destroy();this.textures.clear();
    for(const item of this.items.values())item.uniform.destroy();this.items.clear();
    this.instances=[];this.camera=undefined;this.origin=[0,0];
  }
  configure(manifest) {
    this.manifest=manifest;
    const [x,z,right,bottom]=manifest.ocean,y=manifest.sea_level,w=right-x,h=bottom-z;
    this.water.push(this.drawable(new Float32Array([
      0,y,0,0,1,0,2,w,y,0,0,1,0,2,w,y,h,0,1,0,2,0,y,0,0,1,0,2,w,y,h,0,1,0,2,0,y,h,0,1,0,2,
    ]),[x,z]));
  }
  event(data) {
    if(data.event==='horizon-index')this.indices.set(data.region,this.buffer(data.indices,GPUBufferUsage.INDEX));
    else if(data.event==='horizon')this.horizon.push({...this.drawable(data.vertices,data.placement),region:data.region,near:data.near});
    else if(data.event==='exterior-water')this.water.push(this.drawable(data.vertices,data.placement));
    else if(data.event==='detail') {
      for(const index of data.removed){this.release(this.tiles.get(index));this.tiles.delete(index);}
      for(const t of data.tiles){this.release(this.tiles.get(t.index));this.tiles.set(t.index,this.drawable(t.vertices,t.placement));}
      for(const item of this.seams.values())this.release(item);this.seams.clear();
      for(const s of data.seams)if(s.vertices.length)this.seams.set(s.index,this.drawable(s.vertices,this.tiles.get(s.index).placement));
    } else if(data.event==='scene') {
      for(const key of data.removedAssets){const a=this.assets.get(key);a?.vertices.destroy();a?.indices.destroy();this.assets.delete(key);}
      for(const key of data.removedTextures){this.textures.get(key)?.destroy();this.textures.delete(key);}
      for(const a of data.assets)this.assets.set(a.key,{vertices:this.buffer(a.vertices,GPUBufferUsage.VERTEX),
        indices:this.buffer(a.indices,GPUBufferUsage.INDEX),batches:a.batches,bytes:a.vertices.byteLength+a.indices.byteLength});
      for(const t of data.textures)this.textures.set(t.key,this.texture(t.width,t.height,t.rgba));
      this.instances=data.instances;this.sceneRegion=data.region;
      const wanted=new Set(data.instances.map(i=>i.id));
      for(const [key,item] of this.items)if(!wanted.has(item.id) || !this.assets.has(item.key)){
        item.uniform.destroy();this.items.delete(key);
      }
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
  draw(state,flight,dt,time,settings,lookBack=false) {
    const canvas=this.canvas,width=Math.max(1,Math.round(canvas.clientWidth*Math.min(devicePixelRatio,2)));
    const height=Math.max(1,Math.round(canvas.clientHeight*Math.min(devicePixelRatio,2)));
    if(!this.depth || canvas.width!==width || canvas.height!==height) {
      canvas.width=width;canvas.height=height;this.depth?.destroy();
      this.depth=this.device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    }
    const origin=flight?[Math.round(flight[0]),Math.round(flight[2])]:[state[11],state[12]];
    if(this.camera&&this.origin){this.camera[0]-=origin[0]-this.origin[0];this.camera[2]-=origin[1]-this.origin[1];}
    this.origin=origin;
    const p=[state[0]-origin[0],state[1],state[2]-origin[1]],yaw=state[3]+(lookBack?Math.PI:0);
    const forward=[-Math.sin(yaw),0,-Math.cos(yaw)],desired=[p[0]-forward[0]*13,p[1]+7,p[2]-forward[2]*13];
    this.camera=this.camera?this.camera.map((n,i)=>n+(desired[i]-n)*(1-Math.exp(-dt*6))):desired;
    let look=unit(sub([p[0]+forward[0]*7,p[1],p[2]+forward[2]*7],this.camera));
    if(flight){this.camera=[flight[0]-origin[0],flight[1],flight[2]-origin[1]];
      look=[-Math.sin(flight[3])*Math.cos(flight[4]),Math.sin(flight[4]),-Math.cos(flight[3])*Math.cos(flight[4])];}
    const right=unit(cross(look,[0,1,0])),up=cross(right,look);
    const near=flight?Math.max(.1,Math.min(100,Math.abs(flight[1])*.01)):.1;
    const view=[...this.camera,200000,...right,0,...up,0,...look,0];
    const distant=settings.horizon?this.horizon.filter(h=>!this.tiles.has(h.near)):[];
    const terrain=[...distant,...this.tiles.values(),...(settings.horizon?this.seams.values():[]),...this.water];
    if(!flight)terrain.push(this.body);
    for(const item of terrain)this.device.queue.writeBuffer(item.uniform,0,new Float32Array([
      ...view,...p,state[3],width/height,time,state[4],near,
      item===this.body?0:item.placement[0]-origin[0],0,item===this.body?0:item.placement[1]-origin[1],this.manifest.sea_level,
    ]));
    const draws=[],selection=sceneSelection(this.instances,this.assets);
    if(settings.scenery && this.sceneRegion!==undefined) {
      const r=this.manifest.regions[this.sceneRegion];
      for(const instance of selection.selected) {
        const asset=this.assets.get(instance.key);if(!asset)continue;
        const m=renderMatrix(instance.matrix,r,origin);
        for(let b=0;b<asset.batches.length;b++) {
          const batch=asset.batches[b],key=`${instance.id}:${instance.key}:${b}`;
          const texture=(batch.texture&&this.textures.get(modelPath(batch.texture)))||this.white;
          let item=this.items.get(key);
          if(!item || item.texture!==texture) {
            item?.uniform.destroy();
            const uniform=this.device.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
            const sampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',
              addressModeU:batch.wrapX?'repeat':'clamp-to-edge',addressModeV:batch.wrapY?'repeat':'clamp-to-edge'});
            item={id:instance.id,key:instance.key,uniform,texture,group:this.device.createBindGroup({layout:this.sceneLayout,entries:[
              {binding:0,resource:{buffer:uniform}},{binding:1,resource:texture.createView()},{binding:2,resource:sampler}]} )};
            this.items.set(key,item);
          }
          this.device.queue.writeBuffer(item.uniform,0,new Float32Array([...view,width/height,time,0,near,...m,batch.alphaCutoff||0,batch.emissive?1:0,0,0]));
          draws.push({asset,batch,item,pipeline:this.scenePipeline(batch),distance:Math.hypot(m[12]-this.camera[0],m[13]-this.camera[1],m[14]-this.camera[2])});
        }
      }
    }
    const transparent=batch=>['alpha','add','mod','mod2x'].includes(batch.blend);
    draws.sort((a,b)=>transparent(a.batch)-transparent(b.batch) || (transparent(a.batch)?b.distance-a.distance:0));
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({
      colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:SKY,loadOp:'clear',storeOp:'store'}],
      depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'},
    });
    pass.setPipeline(this.pipeline);
    for(const item of terrain){
      pass.setBindGroup(0,item.group);pass.setVertexBuffer(0,item.buffer);
      if(item.region!==undefined){pass.setIndexBuffer(this.indices.get(item.region),'uint32');pass.drawIndexed(3072);}
      else pass.draw(item.count);
    }
    for(const {asset,batch,item,pipeline} of draws){
      pass.setPipeline(pipeline);pass.setBindGroup(0,item.group);pass.setVertexBuffer(0,asset.vertices);pass.setIndexBuffer(asset.indices,'uint32');
      pass.drawIndexed(batch.indexCount,1,batch.firstIndex);
    }
    pass.end();this.device.queue.submit([encoder.finish()]);
    return {horizonTiles:distant.length,detailedTiles:this.tiles.size,sceneInstances:this.instances.length,
      npcInstances:this.instances.filter(i=>i.id.includes(':npc:')).length,
      wmoInstances:this.instances.filter(i=>i.kind==='group').length,
      texturedDraws:draws.filter(d=>d.item.texture!==this.white).length,
      alphaDraws:draws.filter(d=>d.batch.alphaCutoff>0).length,
      sceneTriangles:selection.triangles,gpuOmittedInstances:selection.omitted,
      sceneDraws:draws.length,sceneGpuMeshBytes:[...this.assets.values()].reduce((n,a)=>n+a.bytes,0),origin};
  }
}
