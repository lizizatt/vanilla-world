// Renderer side of the wind (design/wind.md): per-frame CPU step (one windAt at the eye) and the two near-camera layers, spray and
// blowing dust/snow. Tier gating reuses the weather tiers (renderer-weather.js resolveWeatherTier -> r.weatherTier); below the wind thresholds
// nothing is uploaded or drawn.
import {WIND as W} from './wind-config.js';
import {WindRuntime,GroundGrid,windTime,zoneCharacter} from './wind.js';
import {WIND_UNIFORM_BYTES,GRID_UNIFORM_FLOATS,WIND_KIND,windParticleUniform,groundGridUniform,sprayShader,groundShader} from './wind-particles.js';
import {maelstromCentre} from './clouds.js';
import {activeFramedBody} from './body-shaders.js';
import {subPoint} from './space.js';
import {maskAmp} from './wave-render.js';
import {WAVE_TICKS_PER_SECOND} from './wave-config.js';
import {smoothstep} from './math.js';
import {DEPTH_STATE} from './render-passes.js';

const BLEND={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};

export async function initWind(r) {
  r.wind=new WindRuntime();r.windUniform=new Float32Array(WIND_UNIFORM_BYTES/4);r.windDraws=0;
  const make=async code=>{
    const module=await r.shader(code);
    return r.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:r.format,blend:BLEND}]},
      primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:DEPTH_STATE.particles});
  };
  r.sprayPipeline=await make(sprayShader);r.groundPipeline=await make(groundShader);
  const ub=()=>r.device.createBuffer({size:WIND_UNIFORM_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  r.sprayBuffer=ub();r.groundBuffer=ub();
  r.groundGridBuffer=r.device.createBuffer({size:GRID_UNIFORM_FLOATS*4,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  r.groundGroup=r.device.createBindGroup({layout:r.groundPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.groundBuffer}},{binding:1,resource:{buffer:r.groundGridBuffer}}]});
}

/** The wave tick clock, free-running on wall time while the sim is not stepping (same convention as the wave renderer) so gusts keep moving in flight and pause. */
function windTicks(r) {
  const ticks=r.waveSim?.ticks;
  if(ticks===undefined)return (r.cloudTime??0)*WAVE_TICKS_PER_SECOND;
  const now=performance.now(),c=r.windClockState;
  if(!c||c.ticks!==ticks){r.windClockState={ticks,wall:now};return ticks;}
  return ticks+Math.max(0,(now-c.wall)/1000-.5)*WAVE_TICKS_PER_SECOND;
}

/** One CPU step per frame; call after stepWeather (reads r.weatherTier and the smoothed rain level). Cheap and safe with wind off. */
export function stepWind(r,dt) {
  const w=r.wind;if(!w||!r.view)return;
  const eye=r.view.eye,tier=r.weatherTier??'off',enabled=!!r.weather?.on&&tier!=='off'&&(W.quality[tier]??0)>0;
  const body=activeFramedBody(),lat=subPoint(eye[0],eye[2],body.centre,body.radius).lat;
  const shore=r.shoreField,cell=shore&&shore.cell,si=shore?Math.floor((eye[0]-shore.origin[0])/cell):-1,sj=shore?Math.floor((eye[2]-shore.origin[1])/cell):-1;
  // Open waves (mask) or any water the shore field knows about: in the beach zone the mask amplitude is 0 but it is still sea, not desert.
  const sea=!!r.waveMask&&(maskAmp(r.waveMask,eye[0],eye[2])>.1||(shore&&si>=0&&sj>=0&&si<shore.n&&sj<shore.n&&shore.classes[sj*shore.n+si]!==0));
  const c=r.manifest?maelstromCentre(r.manifest):null,mael=c&&Math.abs(c[0])<1e8?c:null;
  w.step({dt,x:eye[0],z:eye[2],t:windTime(windTicks(r)),lat,character:zoneCharacter({area:r.weatherArea,climate:r.weather?.climate,sea}),
    storm:Math.max(r.weather?.on?r.weather.state.level:0,r.windStormHook??0),mael,enabled,sea});
}

/** Terrain height lattice around the eye (cached; the camera floor is a triangle raycast spanning y..y+200, so ask from 100 yd below the eye). Undefined until the cell under the eye is known. */
function groundUnder(r) {
  if(!r.cameraFloor)return undefined;
  const e=r.view.eye;
  if(!r.windGrid||r.windGrid.floorFn!==r.cameraFloor){
    const fn=r.cameraFloor;r.windGrid=new GroundGrid((x,z)=>fn(x,r.view.eye[1]-100,z));r.windGrid.floorFn=fn;
  }
  const g=r.windGrid.update(e[0],e[2]);
  return g.known?g.sample(e[0],e[2]):undefined;
}

/** Draws whichever layers are above their wind threshold in one depth-tested pass. Returns the number of layer draws (0 = no pass, no cost). */
export function drawWind(r,encoder,near,origin,depthAttachment) {
  const w=r.wind,count=W.quality[r.weatherTier]??0;
  if(!w||!w.on||!count||!r.groundGroup)return 0;
  const doSpray=w.spray>0&&r.waveActive,wantGround=w.ground>0;
  if(!doSpray&&!wantGround)return 0;
  const e=r.view.eye,cu=r.lastCloudUniform,light=Math.min(1,.35+(cu?cu[15]:1)),clock=r.cloudTime??0,t=windTime(windTicks(r));
  let fade=0,ground=0;
  if(wantGround){const g=groundUnder(r);if(g!==undefined){ground=g;fade=1-smoothstep(20,80,e[1]-g);}}
  const doGround=wantGround&&fade>0;
  if(!doSpray&&!doGround)return 0;
  const pass=encoder.beginRenderPass({colorAttachments:[{view:r.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}],depthStencilAttachment:depthAttachment});
  let n=0;
  if(doSpray){
    r.sprayGroup??=r.device.createBindGroup({layout:r.sprayPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.sprayBuffer}},
      {binding:4,resource:r.waveSampler},{binding:5,resource:{buffer:r.waveUniforms}},{binding:6,resource:r.waveMaskTexture.createView()}]});
    r.device.queue.writeBuffer(r.sprayBuffer,0,windParticleUniform(r.view,near,origin,t,clock,0,light,count,w.spray,WIND_KIND.spray,1,w.drift,w.params,r.windUniform));
    pass.setPipeline(r.sprayPipeline);pass.setBindGroup(0,r.sprayGroup);pass.draw(6,count);n++;
  }
  if(doGround){
    const kind=w.snow>w.dust?WIND_KIND.snow:WIND_KIND.dust;
    r.device.queue.writeBuffer(r.groundBuffer,0,windParticleUniform(r.view,near,origin,t,clock,ground,light,count,w.ground,kind,fade,w.drift,w.params,r.windUniform));
    r.windGridUniform=groundGridUniform(r.windGrid,r.windGridUniform);r.device.queue.writeBuffer(r.groundGridBuffer,0,r.windGridUniform);
    pass.setPipeline(r.groundPipeline);pass.setBindGroup(0,r.groundGroup);pass.draw(6,count);n++;
  }
  pass.end();r.windDraws+=n;
  return n;
}
