// On-demand GPU microbench for the weather curtain pass (no game data): renders the real curtainShader full-screen over a synthetic wet polar grid
// and a cleared (sky) depth buffer at several eye poses, reports GPU ms per pass (timestamp query, else batched wall time) and a pixel hash/readback.
// Usage: node perf-curtain-bench.mjs [label] [compareLabel]  -> test-results/perf-curtain/<label>.json (+ .bin readback); compare prints max abs byte diff.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import assert from 'node:assert/strict';

const label=process.argv[2]||'run',compare=process.argv[3];
const W=Number(process.env.W||1920),H=Number(process.env.H||1080),N=Number(process.env.N||40);
const root=new URL('./',import.meta.url),out=new URL('./test-results/perf-curtain/',import.meta.url);
await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.json':'application/json'};
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://x').pathname;
  if(path==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><title>bench</title>');}
  try{const f=await readFile(new URL('.'+(path==='/'?'/index.html':path),root));res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.end(f);}
  catch{res.statusCode=404;res.end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const port=server.address().port;assert.notEqual(port,4173);
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio','--enable-unsafe-webgpu','--enable-webgpu-developer-features','--disable-dawn-features=timestamp_quantization']});
const page=await browser.newPage();const errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404/.test(m.text()))errors.push(m.text());});
await page.goto(`http://127.0.0.1:${port}/`);
const result=await page.evaluate(async([W,H,N])=>{
  const {curtainShader,curtainUniform,CURTAIN_UNIFORM_BYTES,curtainFade,layerWeight}=await import('./weather-curtain.js');
  const {cloudUniform,CLOUD_THICKNESS}=await import('./clouds.js');
  const {WEATHER}=await import('./weather-config.js');
  const adapter=await navigator.gpu.requestAdapter(),timed=false;// timestamp queries read back 0 on this Edge/Dawn build, so time N passes per submit instead
  
  const device=await adapter.requestDevice({requiredFeatures:timed?['timestamp-query']:[]});
  device.addEventListener('uncapturederror',e=>console.error('GPU '+e.error.message));
  const manifest={ocean:[5333,-17600,13525,17066],world_bounds:[[0,0,51,56],[24,20,45,62]],regions:[{placement:[-21866,-17600]},{placement:[725,-16000]}]};
  const module=device.createShaderModule({code:curtainShader});
  const info=await module.getCompilationInfo();if(info.messages.some(m=>m.type==='error'))throw Error(info.messages.map(m=>m.message).join('\n'));
  const format='rgba8unorm';
  const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},
    fragment:{module,entryPoint:'fs',targets:[{format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]}});
  const depth=device.createTexture({size:[W,H],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  const color=device.createTexture({size:[W,H],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const ub=device.createBuffer({size:CURTAIN_UNIFORM_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:ub}},{binding:1,resource:depth.createView()}]});
  {const e=device.createCommandEncoder();e.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}}).end();device.queue.submit([e.finish()]);}
  // Deterministic wet grid: dry/wet sectors with smoothly varying intensity.
  const A=WEATHER.polar.azimuth,R=WEATHER.polar.rings,polar=new Float32Array(A*R);
  for(let a=0;a<A;a++)for(let k=0;k<R;k++){const s=Math.sin(a*.37+k*.9)+Math.sin(a*.11-k*.4+1.3);polar[a*R+k]=s>-.2?Math.min(1,.35+.4*(s+.2)):0;}
  const poses=[['ground',[0,120,0],0],['below-base',[0,900,0],.05],['in-cloud',null,.02],['above-cloud',null,-.25]];
  const rows=[],pixels={};
  const aspect=W/H;
  for(const [name,eyeIn,pitch] of poses){
    const probe=cloudUniform({eye:[0,0,0],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect},0,1,manifest,1,null),base=probe[18]-CLOUD_THICKNESS/2;
    const eye=eyeIn||[0,name==='in-cloud'?base+120:base+CLOUD_THICKNESS+1500,0];
    const cp=Math.cos(pitch),sp=Math.sin(pitch),look=[0,sp,cp],up=[0,cp,-sp];
    const cu=cloudUniform({eye,right:[1,0,0],up,look,aspect},37.5,1,manifest,1,null);
    const wx=[0,.8,curtainFade(eye[1],base),layerWeight(eye[1],base)];
    device.queue.writeBuffer(ub,0,curtainUniform(cu,polar,wx));
    const pass=encoder=>{const p=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),clearValue:[0,0,0,0],    loadOp:'clear',storeOp:'store'}]});
      p.setPipeline(pipeline);p.setBindGroup(0,group);p.draw(3);p.end();};
    // Warm up, then N passes in one submit.
    for(let i=0;i<3;i++){const e=device.createCommandEncoder();pass(e);device.queue.submit([e.finish()]);}
    await device.queue.onSubmittedWorkDone();
    const runs=[];
    for(let rep=0;rep<5;rep++){
      const e=device.createCommandEncoder();let qs,qb,rb;
      if(timed){qs=device.createQuerySet({type:'timestamp',count:2});qb=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});rb=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});e.writeTimestamp?.(qs,0);}
      const t0=performance.now();
      if(timed&&!e.writeTimestamp){// timestampWrites only on pass descriptors: bracket with first/last pass instead
        for(let i=0;i<N;i++){const p=e.beginRenderPass({colorAttachments:[{view:color.createView(),clearValue:[0,0,0,0],        loadOp:'clear',storeOp:'store'}],          ...(i===0?{timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0}}:{}),...(i===N-1?{timestampWrites:{querySet:qs,endOfPassWriteIndex:1}}:{})});
          p.setPipeline(pipeline);p.setBindGroup(0,group);p.draw(3);p.end();}
        e.resolveQuerySet(qs,0,2,qb,0);e.copyBufferToBuffer(qb,0,rb,0,16);
      } else for(let i=0;i<N;i++)pass(e);
      device.queue.submit([e.finish()]);await device.queue.onSubmittedWorkDone();
      const wall=(performance.now()-t0)/N;let gpu=null;
      if(rb){await rb.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(rb.getMappedRange().slice(0));gpu=Number(t[1]-t[0])/1e6/N;rb.unmap();}
      runs.push(gpu??wall);
    }
    runs.sort((a,b)=>a-b);
    // Readback of one pass for equivalence checks.
    const e=device.createCommandEncoder();pass(e);
    const bpr=Math.ceil(W*4/256)*256,rbuf=device.createBuffer({size:bpr*H,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    e.copyTextureToBuffer({texture:color},{buffer:rbuf,bytesPerRow:bpr},[W,H]);device.queue.submit([e.finish()]);
    await rbuf.mapAsync(GPUMapMode.READ);const raw=new Uint8Array(rbuf.getMappedRange().slice(0));rbuf.unmap();
    const px=new Uint8Array(W*H*4);for(let y=0;y<H;y++)px.set(raw.subarray(y*bpr,y*bpr+W*4),y*W*4);
    let sum=0;for(let i=3;i<px.length;i+=4)sum+=px[i];
    pixels[name]=Array.from(px.subarray(0,0));pixels[name+'_bin']=btoa(String.fromCharCode(...px.filter((_,i)=>i%97===0)));
    rows.push({pose:name,eyeY:Math.round(eye[1]),msMedian:runs[2],msMin:runs[0],msMax:runs[4],meanAlpha:sum/(W*H)/255});
  }
  return {timed,W,H,N,rows,sample:Object.fromEntries(Object.entries(pixels).filter(([k])=>k.endsWith('_bin')))};
},[W,H,N]);
await browser.close();server.close();
assert.deepEqual(errors,[],'page errors: '+errors.join('; '));
await writeFile(new URL(`${label}.json`,out),JSON.stringify(result));
console.log(label,result.timed?'(GPU timestamps)':'(wall time)',`${W}x${H}`);
console.table(result.rows);
if(compare){
  const base=JSON.parse(await readFile(new URL(`${compare}.json`,out),'utf8'));
  for(const k of Object.keys(result.sample)){
    const a=Buffer.from(result.sample[k],'base64'),b=Buffer.from(base.sample[k],'base64');let max=0,n=0;
    for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d>max)max=d;if(d)n++;}
    console.log(k.replace('_bin',''),'max byte diff vs',compare,max,'differing samples',n,'/',a.length);
  }
}
