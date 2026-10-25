import {shadowUniform,shadowHalf,sunShadow} from './shadow.js';
import {sunDirection,cloudShaderHigh,cloudUniform,bakeCloudNoise,CLOUD_NOISE_SIZE,stepTierMix} from './clouds.js';

export function drawShadow(r,pass,state,near) {
  const sh=sunShadow(sunDirection(r.timeOfDay));
  r.device.queue.writeBuffer(r.shadowBuffer,0,shadowUniform(r.view,state,shadowHalf(r.craft?.size),near,sh.strength,undefined,sh.sun));
  pass.setPipeline(r.shadowPipeline);pass.setBindGroup(0,r.shadowGroup);pass.draw(3);
}
// High tier (opt-in): built on first use so the noise bake and shader compile cost nothing for Standard.
export async function enableHighClouds(r) {
  if(r.cloudHigh||r.cloudHighPending)return;
  r.cloudHighPending=true;
  try {
    const noise=r.device.createTexture({size:[CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE],dimension:'3d',format:'rg8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    r.device.queue.writeTexture({texture:noise},bakeCloudNoise(),{bytesPerRow:CLOUD_NOISE_SIZE*2,rowsPerImage:CLOUD_NOISE_SIZE},[CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE,CLOUD_NOISE_SIZE]);
    r.cloudNoise=noise.createView();
    r.cloudNoiseSampler=r.device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',addressModeW:'repeat'});
    const module=await r.shader(cloudShaderHigh);
    r.cloudHigh=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},
      fragment:{module,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
      primitive:{topology:'triangle-list',cullMode:'none'}});
    r.cloudHighGroup=r.highCloudGroup();
  } catch(e) {console.warn('high clouds unavailable',e);r.cloudHighFailed=true;}
  r.cloudHighPending=false;
}
export function highCloudGroup(r) {
  return r.depth&&r.device.createBindGroup({layout:r.cloudHigh.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.cloudBuffer}},
    {binding:1,resource:r.depth.createView()},{binding:2,resource:r.cloudNoise},{binding:3,resource:r.cloudNoiseSampler},...r.maskEntries()]});
}
export function maskEntries(r) {return [{binding:4,resource:r.cloudMask.view},{binding:5,resource:r.cloudMask.sampler}];}
export function drawClouds(r,pass,time,daylight,near,high) {
  r.cloudMask.update(r.planetRects());
  const useHigh=!!(high&&r.cloudHighGroup),target=useHigh?1:0,nowMs=performance.now();
  r.tierMix=r.tierMix===undefined?target:stepTierMix(r.tierMix,target,(nowMs-(r.tierMs??nowMs))/1000);r.tierMs=nowMs;
  // Fading out of High needs its pipeline for the fade; fading into it already has it (useHigh).
  const m=r.tierMix,both=m>0&&m<1&&r.cloudHighGroup;
  const cu=cloudUniform(r.view,time,daylight,r.manifest,near,r.gameSky,undefined,r.timeOfDay,{...r.planet,tierMix:both?m:target});
  r.device.queue.writeBuffer(r.cloudBuffer,0,cu);
  if(both||!useHigh){pass.setPipeline(r.cloudPipeline);pass.setBindGroup(0,r.cloudGroup);pass.draw(3);}
  if(both||useHigh){pass.setPipeline(r.cloudHigh);pass.setBindGroup(0,r.cloudHighGroup);pass.draw(3);}
}
