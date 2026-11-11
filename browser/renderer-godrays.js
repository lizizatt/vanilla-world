import {godrayShader,godrayUniform,godraysTier} from './godrays.js';
import {sunDirection} from './clouds.js';

// Built on first use so users with godrays off pay no shader compile or memory.
export async function enableGodrays(r) {
  if(r.godrayPipeline||r.godrayPending||r.godrayFailed)return;
  r.godrayPending=true;
  try {
    const module=await r.shader(godrayShader);
    r.godrayBuffer=r.device.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    r.godrayPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},
      fragment:{module,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'one',dstFactor:'one'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]},
      primitive:{topology:'triangle-list',cullMode:'none'}});
    r.godrayGroup=null;
  } catch(e) {console.warn('godrays unavailable',e);r.godrayFailed=true;}
  r.godrayPending=false;
}

/** Records the additive ray pass into `pass`; no-op while off, still compiling, or when there is no sky to see. */
export function drawGodrays(r,pass,tier,near) {
  tier=godraysTier(tier);
  if(tier==='off'||near===false)return false;
  if(!r.godrayPipeline){enableGodrays(r);return false;}
  r.godrayGroup??=r.device.createBindGroup({layout:r.godrayPipeline.getBindGroupLayout(0),
    entries:[{binding:0,resource:{buffer:r.godrayBuffer}},{binding:1,resource:r.depth.createView()}]});
  const sun=r.sunLocal??sunDirection(r.timeOfDay);
  r.device.queue.writeBuffer(r.godrayBuffer,0,godrayUniform(r.view,sun,tier,r.weather?.look.wet??0,r.canvas.width,r.canvas.height));
  pass.setPipeline(r.godrayPipeline);pass.setBindGroup(0,r.godrayGroup);pass.draw(3);
  return true;
}
