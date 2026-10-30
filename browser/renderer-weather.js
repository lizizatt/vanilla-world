// Renderer side of the weather system: per-frame state (CPU), and the distant curtain pass. See design/weather.md.
import {WeatherRuntime} from './weather.js';
import {WEATHER as W,WEATHER_TIERS} from './weather-config.js';
import {curtainShader,curtainUniform,curtainFade,CURTAIN_UNIFORM_BYTES} from './weather-curtain.js';
import {maelstromCentre} from './clouds.js';
import {activeBody} from './body-shaders.js';
import {regimeOf} from './regime.js';
import {CLOUD_THICKNESS} from './cloud-config.js';

/** 'auto' follows frame health (slow -> low); an explicit tier wins; weather off wins over everything. */
export function resolveWeatherTier(enabled,quality,slow=false) {
  if(enabled===false||quality==='off')return 'off';
  if(WEATHER_TIERS.includes(quality)&&quality!=='off')return quality;
  return slow?'low':'standard';
}

export async function initWeather(r) {
  r.weather=new WeatherRuntime();r.weatherTier='off';r.weatherUniform=new Float32Array(CURTAIN_UNIFORM_BYTES/4);
  r.curtainBuffer=r.device.createBuffer({size:CURTAIN_UNIFORM_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const module=await r.shader(curtainShader);
  r.curtainPipeline=await r.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},
    fragment:{module,entryPoint:'fs',targets:[{format:r.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
    primitive:{topology:'triangle-list',cullMode:'none'}});
}
export function weatherGroups(r) {
  if(!r.curtainPipeline||!r.depth)return;
  r.curtainGroup=r.device.createBindGroup({layout:r.curtainPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.curtainBuffer}},{binding:1,resource:r.depth.createView()}]});
}

/** One CPU step per frame: resolves tier and enable, then samples the cell field. Safe to call with weather off. */
export function stepWeather(r,dt,settings,flight,regimeAltitude) {
  if(!r.weather)return;
  const tier=resolveWeatherTier(settings.weather,settings.weatherQuality,r.weatherSlow);
  r.weatherTier=tier;
  const eye=r.view.eye,body=activeBody().id,regime=regimeOf(regimeAltitude??eye[1]);
  r.weather.step({dt,eye,time:r.cloudTime??0,centre:r.manifest?maelstromCentre(r.manifest):[1e9,1e9],mask:r.cloudMask?.mask,
    flow:r.planet?{cycles:r.planet.flowCycles,scale:r.planet.flowScale}:undefined,enabled:tier!=='off',regime,body,area:r.weatherArea??{name:'',cold:false}});
}

/** Scalar the cloud uniform needs: 1 when weather is live, else 0. */
export const weatherOn=r=>r.weather?.on??0;

export function drawCurtain(r,pass,cloudUniformData) {
  const w=r.weather;
  if(!w||!r.curtainGroup||r.weatherTier==='off'||r.weatherTier==='low'||!w.anyWet)return false;
  const base=cloudUniformData[18]-CLOUD_THICKNESS/2,fade=curtainFade(r.view.eye[1],base);
  if(fade<=0)return false;
  const wx=[w.state.snowMix,w.state.level,fade,0];
  r.device.queue.writeBuffer(r.curtainBuffer,0,curtainUniform(cloudUniformData,w.polar,wx,r.weatherUniform));
  pass.setPipeline(r.curtainPipeline);pass.setBindGroup(0,r.curtainGroup);pass.draw(3);
  r.curtainDrawn=(r.curtainDrawn??0)+1;
  return true;
}
