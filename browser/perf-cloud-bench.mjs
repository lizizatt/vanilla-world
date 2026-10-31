// On-demand GPU microbench for the High-tier cloud pass (no game data): renders the real cloudShaderHigh full-screen at several eye poses
// over a procedural land mask and cleared (sky) depth, with weather on, and reports ms per pass (N passes per submit) plus a pixel sample readback for equivalence.
// Usage: node perf-cloud-bench.mjs [label] [compareLabel]  -> test-results/perf-cloud/<label>.json; the compare prints max abs byte diff.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import assert from 'node:assert/strict';

const label=process.argv[2]||'run',compare=process.argv[3];
const W=Number(process.env.W||1920),H=Number(process.env.H||1080),N=Number(process.env.N||10),STD=process.env.TIER==='standard';
const root=new URL('./',import.meta.url),out=new URL('./test-results/perf-cloud/',import.meta.url);
await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.json':'application/json'};
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://x').pathname;
  if(path==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><title>bench</title>');}
  try{const f=await readFile(new URL('.'+path,root));res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.end(f);}
  catch{res.statusCode=404;res.end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const port=server.address().port;assert.notEqual(port,4173);
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio','--enable-unsafe-webgpu']});
const page=await browser.newPage();const errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404/.test(m.text()))errors.push(m.text());});
await page.goto(`http://127.0.0.1:${port}/`);
const result=await page.evaluate(async([W,H,N,STD])=>{
  const C=await import('./clouds.js'),{MASK}=await import('./cloud-flow.js');
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
  device.addEventListener('uncapturederror',e=>console.error('GPU '+e.error.message));
  const manifest={ocean:[5333,-17600,13525,17066],world_bounds:[[0,0,51,56],[24,20,45,62]],regions:[{placement:[-21866,-17600]},{placement:[725,-16000]}]};
  const high=!STD,module=device.createShaderModule({code:high?C.cloudShaderHigh:C.cloudShader});
  const info=await module.getCompilationInfo();if(info.messages.some(m=>m.type==='error'))throw Error(info.messages.map(m=>m.message).join('\n'));
  const format='rgba8unorm';
  const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},
    fragment:{module,entryPoint:'fs',targets:[{format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]}});
  const depth=device.createTexture({size:[W,H],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  {const e=device.createCommandEncoder();e.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}}).end();device.queue.submit([e.finish()]);}
  const color=device.createTexture({size:[W,H],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const ub=device.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const mask=device.createTexture({size:[MASK.w,MASK.h],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  const md=new Uint8Array(MASK.w*MASK.h*4);
  for(let j=0;j<MASK.h;j++)for(let i=0;i<MASK.w;i++){const o=(j*MASK.w+i)*4,l=Math.sin(i*.19)*Math.cos(j*.31)>0?255:0;md[o]=l;md[o+1]=128+Math.round(60*Math.sin(i*.07));md[o+2]=128+Math.round(60*Math.cos(j*.11));md[o+3]=255;}
  device.queue.writeTexture({texture:mask},md,{bytesPerRow:MASK.w*4},[MASK.w,MASK.h]);
  const entries=[{binding:0,resource:{buffer:ub}},{binding:1,resource:depth.createView()},{binding:4,resource:mask.createView()},
    {binding:5,resource:device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'clamp-to-edge'})}];
  if(high){
    const noise=device.createTexture({size:[C.CLOUD_NOISE_SIZE,C.CLOUD_NOISE_SIZE,C.CLOUD_NOISE_SIZE],dimension:'3d',format:'rg8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture:noise},C.bakeCloudNoise(),{bytesPerRow:C.CLOUD_NOISE_SIZE*2,rowsPerImage:C.CLOUD_NOISE_SIZE},[C.CLOUD_NOISE_SIZE,C.CLOUD_NOISE_SIZE,C.CLOUD_NOISE_SIZE]);
    entries.push({binding:2,resource:noise.createView()},{binding:3,resource:device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',addressModeW:'repeat'})});
  }
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
  const aspect=W/H,[sx,sz]=C.maelstromCentre(manifest);
  const baseOf=u=>u[18]-C.CLOUD_THICKNESS/2,probe=C.cloudUniform({eye:[0,0,0],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect},0,1,manifest,1,null),base=baseOf(probe);
  const poses=[['ground',[0,100,0],.08,0],['in-cloud',[0,base+120,0],.02,0],['above-cloud',[0,base+C.CLOUD_THICKNESS+1500,0],-.25,0],['orbit',[0,400000,0],-1.2,1],['storm',[sx+6000,120,sz],.1,0]];
  const rows=[],sample={};
  for(const [name,eyeIn,pitch,space] of poses){
    const eye=eyeIn.slice();if(name!=='storm'){eye[0]=sx-30000;eye[2]=sz+20000;}
    const cp=Math.cos(pitch),sp=Math.sin(pitch),look=[name==='storm'?-cp:0,sp,name==='storm'?0:cp],right=name==='storm'?[0,0,-1]:[1,0,0],up=name==='storm'?[sp,cp,0]:[0,cp,-sp];
    const cu=C.cloudUniform({eye,right,up,look,aspect},37.5,1,manifest,1,null,undefined,1440,{bend:0,space,tierMix:high?1:0,wet:1,weatherOn:1,rainStreak:1});
    device.queue.writeBuffer(ub,0,cu);
    const pass=e=>{const p=e.beginRenderPass({colorAttachments:[{view:color.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});p.setPipeline(pipeline);p.setBindGroup(0,group);p.draw(3);p.end();};
    for(let i=0;i<2;i++){const e=device.createCommandEncoder();pass(e);device.queue.submit([e.finish()]);}
    await device.queue.onSubmittedWorkDone();
    const runs=[];
    for(let rep=0;rep<5;rep++){
      const e=device.createCommandEncoder(),t0=performance.now();for(let i=0;i<N;i++)pass(e);
      device.queue.submit([e.finish()]);await device.queue.onSubmittedWorkDone();runs.push((performance.now()-t0)/N);
    }
    runs.sort((a,b)=>a-b);
    const e=device.createCommandEncoder();pass(e);
    const bpr=Math.ceil(W*4/256)*256,rbuf=device.createBuffer({size:bpr*H,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    e.copyTextureToBuffer({texture:color},{buffer:rbuf,bytesPerRow:bpr},[W,H]);device.queue.submit([e.finish()]);
    await rbuf.mapAsync(GPUMapMode.READ);const raw=new Uint8Array(rbuf.getMappedRange().slice(0));rbuf.unmap();
    const px=new Uint8Array(W*H*4);for(let y=0;y<H;y++)px.set(raw.subarray(y*bpr,y*bpr+W*4),y*W*4);
    let sum=0;for(let i=3;i<px.length;i+=4)sum+=px[i];
    sample[name]=btoa(String.fromCharCode(...px.filter((_,i)=>i%97===0)));
    rows.push({pose:name,eyeY:Math.round(eye[1]),msMedian:+runs[2].toFixed(3),msMin:+runs[0].toFixed(3),msMax:+runs[4].toFixed(3),meanAlpha:+(sum/(W*H)/255).toFixed(4)});
  }
  return {tier:high?'high':'standard',W,H,N,rows,sample};
},[W,H,N,STD]);
await browser.close();server.close();
assert.deepEqual(errors,[],'page errors: '+errors.join('; '));
await writeFile(new URL(`${label}.json`,out),JSON.stringify(result));
console.log(label,result.tier,`${W}x${H}`);console.table(result.rows);
if(compare){
  const base=JSON.parse(await readFile(new URL(`${compare}.json`,out),'utf8'));
  for(const k of Object.keys(result.sample)){
    const a=Buffer.from(result.sample[k],'base64'),b=Buffer.from(base.sample[k],'base64');let max=0,n=0;
    for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d>max)max=d;if(d)n++;}
    console.log(k,'max byte diff vs',compare,max,'differing samples',n,'/',a.length);
  }
}
