// Depth/precision prototype (design/elune.md step B): analytic spheres (Azeroth, Elune, a 1 yd pod) drawn with eye-relative f64-derived
// uniforms and a selectable depth strategy, read back and compared with the CPU reference in depth-proto-math.js.
import {viewSpheres,cameraFor,classify,planFor,FOV_Y} from './depth-proto-math.js';

const WGSL=`
struct U{tx:f32,ty:f32,near:f32,far:f32,reversed:u32,pad0:u32,pad1:u32,pad2:u32}
struct S{c:vec3f,r:f32,k:f32,id:f32,p0:f32,p1:f32}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var<storage,read> spheres:array<S>;
struct V{@builtin(position) pos:vec4f,@location(0) ndc:vec2f,@location(1) @interpolate(flat) inst:u32}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V{
  var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var o:V;o.pos=vec4f(p[vi],0,1);o.ndc=p[vi];o.inst=ii;return o;}
struct F{@location(0) colour:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn fs(v:V)->F{
  let s=spheres[v.inst];
  let d=normalize(vec3f(v.ndc.x*u.tx,v.ndc.y*u.ty,1.0));
  let b=dot(d,s.c);let disc=b*b-s.k;
  if(disc<0.0||b<=0.0){discard;}
  let t=s.k/(b+sqrt(disc));let z=t*d.z;
  if(z<u.near||z>u.far){discard;}
  var depth:f32;
  if(u.reversed==1u){depth=u.near*(u.far-z)/(z*(u.far-u.near));}else{depth=(z-u.near)*u.far/(z*(u.far-u.near));}
  let n=normalize(t*d-s.c);let shade=0.3+0.7*max(dot(n,-d),0.0);
  var base=vec3f(0.5,0.5,0.5);
  if(s.id<0.5){base=vec3f(0.0,0.5,1.0);}else if(s.id>1.5){base=vec3f(1.0,0.15,0.15);}else{base=vec3f(0.9,0.9,0.9);}
  var o:F;o.colour=vec4f(base*shade,1.0);o.depth=depth;return o;}
`;

export async function createProto(width=320,height=200) {
  const adapter=await navigator.gpu?.requestAdapter();if(!adapter)throw new Error('no WebGPU adapter');
  const device=await adapter.requestDevice(),module=device.createShaderModule({code:WGSL});
  const colour=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const readback=device.createBuffer({size:width*height*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const pipelines={};
  const pipelineFor=(format,reversed)=>pipelines[format+reversed]??=device.createRenderPipeline({layout:'auto',
    vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},
    primitive:{topology:'triangle-list'},depthStencil:{format,depthWriteEnabled:true,depthCompare:reversed?'greater':'less'}});

  async function render(s,mode) {
    const plan=planFor(mode,s.eye,s.t),cam=cameraFor(s),sp=viewSpheres(s.eye,cam,s.t,{pod:s.pod});
    const data=new Float32Array(sp.length*8);
    sp.forEach((q,i)=>data.set([...q.c,q.r,q.k,q.id,0,0],i*8));
    const sbuf=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(sbuf,0,data);
    const depth=device.createTexture({size:[width,height],format:plan.format,usage:GPUTextureUsage.RENDER_ATTACHMENT});
    const aspect=width/height,pipeline=pipelineFor(plan.format,plan.reversed),enc=device.createCommandEncoder();
    plan.layers.forEach((layer,i)=>{
      const ub=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const u=new ArrayBuffer(32),f=new Float32Array(u),w=new Uint32Array(u);
      f[0]=Math.tan(FOV_Y/2)*aspect;f[1]=Math.tan(FOV_Y/2);f[2]=layer.near;f[3]=layer.far;w[4]=plan.reversed?1:0;device.queue.writeBuffer(ub,0,u);
      const bg=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:ub}},{binding:1,resource:{buffer:sbuf}}]});
      const pass=enc.beginRenderPass({colorAttachments:[{view:colour.createView(),loadOp:i?'load':'clear',storeOp:'store',clearValue:[0,0,0,1]}],
        depthStencilAttachment:{view:depth.createView(),depthClearValue:plan.reversed?0:1,depthLoadOp:'clear',depthStoreOp:'store'}});
      pass.setPipeline(pipeline);pass.setBindGroup(0,bg);pass.draw(3,sp.length);pass.end();
    });
    enc.copyTextureToBuffer({texture:colour},{buffer:readback,bytesPerRow:width*4},[width,height]);
    device.queue.submit([enc.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const px=new Uint8Array(readback.getMappedRange().slice(0));readback.unmap();depth.destroy();sbuf.destroy();
    return {px,spheres:sp,plan};
  }
  const idAt=(px,x,y)=>{const o=(y*width+x)*4,r=px[o],g=px[o+1],b=px[o+2];
    if(Math.max(r,g,b)<20)return -1;if(r>g*1.5&&r>b*1.5)return 2;if(b>r*1.5)return 0;return 1;};

  /** Mismatch fraction vs the analytic reference; a pixel passes if the GPU id matches the reference anywhere in its 3x3 neighbourhood (silhouette AA tolerance). */
  async function compare(s,mode) {
    const {px,spheres,plan}=await render(s,mode),aspect=width/height;let bad=0,total=0;const hist={};
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++) {
      const got=idAt(px,x,y),ok=new Set();
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)ok.add(classify(spheres,((x+dx+.5)/width)*2-1,1-((y+dy+.5)/height)*2,aspect));
      total++;hist[got]=(hist[got]||0)+1;if(!ok.has(got))bad++;
    }
    return {scenario:s.name,mode,bad,total,fraction:bad/total,layers:plan.layers.length,hist};
  }
  return {render,compare,device};
}
