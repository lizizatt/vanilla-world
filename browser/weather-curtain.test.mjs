import test from 'node:test';
import assert from 'node:assert/strict';
import {curtainExit,curtainShader,curtainUniform,curtainFade,layerWeight,CURTAIN_UNIFORM_BYTES} from './weather-curtain.js';
import {resolveWeatherTier} from './renderer-weather.js';
import {WEATHER as W} from './weather-config.js';

test('curtain uniform packs camera block, extras and the whole polar grid at the WGSL offsets',()=>{
  const cloud=Float32Array.from({length:60},(_,i)=>i+1),polar=Float32Array.from({length:W.polar.azimuth*W.polar.rings},(_,i)=>i/1000);
  const u=curtainUniform(cloud,polar,[.25,.5,.75,0]);
  assert.equal(u.byteLength,CURTAIN_UNIFORM_BYTES);
  assert.equal(u[0],1);assert.equal(u[59],60);assert.deepEqual([...u.slice(60,64)],[.25,.5,.75,0]);
  assert.equal(u[64],0);assert.equal(u[64+511],polar[511]);
  assert.equal(CURTAIN_UNIFORM_BYTES,256+512*4);
});
test('curtain shader declares the grid at the packed size and shares the cloud camera block',()=>{
  assert(curtainShader.includes(`array<vec4f,${W.polar.azimuth*W.polar.rings/4}>`));
  assert(curtainShader.includes('wx:vec4f'));assert(curtainShader.includes('fn precipAt('));assert(curtainShader.includes('textureLoad(sceneDepth'));
});
test('curtain fades out as the eye climbs above the cloud layer',()=>{
  assert.equal(curtainFade(0,1316),1);assert.equal(curtainFade(1316,1316),1);assert.equal(curtainFade(5000,1316),0);
});
test('curtain follows the curved cloud shell: a level ray leaves the sub-cloud volume within a few km, not at the 24 km grid edge (repro pose)',()=>{
  const k=7.012622518232092e-5,eye=1024.15,base=1576.8-W.curtain.baseDrop;
  const exit=curtainExit(eye,0,base,k);
  assert(Number.isFinite(exit)&&exit<4500&&exit>2000,`level exit ${exit}`);
  assert(curtainExit(eye,0,base,1e-9)>1e5,'flat limit stays unbounded');
  assert(curtainExit(eye,.3,base,k)<exit,'climbing rays leave sooner');
  assert(curtainShader.includes('worldAt(dir*s)')&&curtainShader.includes('shellRoots(eyeY,dir.y,base)'));
});
test('weather stack stays full through the cloud layer and fades only above its top (no vanish at the base)',()=>{
  const base=1316,top=base+W.layer.top;
  assert.equal(curtainFade(0,base),1);assert.equal(curtainFade(base,base),1);assert.equal(curtainFade(base+400,base),1);assert.equal(curtainFade(top,base),1);
  assert.equal(curtainFade(top+W.curtain.fade,base),0);assert.equal(curtainFade(top+5000,base),0);
  const mid=curtainFade(top+W.curtain.fade/2,base);assert(mid>.4&&mid<.6);
  let prev=1;for(let y=0;y<top+W.curtain.fade+100;y+=10){const v=curtainFade(y,base);assert(v<=prev+1e-12&&Math.abs(v-prev)<.05);prev=v;}
});
test('in-layer shaft weight ramps smoothly across the base: 0 well under it, 1 inside, no step',()=>{
  const base=1316;
  assert.equal(layerWeight(base-W.layer.blend,base),0);assert.equal(layerWeight(base+W.layer.blend,base),1);assert.equal(layerWeight(0,base),0);assert.equal(layerWeight(base+9000,base),1);
  assert(Math.abs(layerWeight(base,base)-.5)<1e-9);
  let prev=0;for(let y=base-300;y<base+300;y+=5){const v=layerWeight(y,base);assert(v>=prev&&v-prev<.06);prev=v;}
});
test('curtain shader keeps marching past the base from inside the layer, with layer and haze falloff',()=>{
  assert(curtainShader.includes('let wIn=c.wx.w;')&&curtainShader.includes('if(wIn<=0.001){'));
  assert(curtainShader.includes(`smoothstep(${W.layer.mid.toFixed(1)},${W.layer.top.toFixed(1)},-drop)`));
  assert(curtainShader.includes(`smoothstep(${W.layer.haze[0].toFixed(1)},${W.layer.haze[1].toFixed(1)},s)`));
});
test('quality tier: off wins, explicit tier wins, auto drops to low when slow',()=>{
  assert.equal(resolveWeatherTier(false,'high'),'off');assert.equal(resolveWeatherTier(true,'off'),'off');
  assert.equal(resolveWeatherTier(true,'high',true),'high');assert.equal(resolveWeatherTier(true,'low'),'low');
  assert.equal(resolveWeatherTier(true,'auto'),'standard');assert.equal(resolveWeatherTier(true,'auto',true),'low');
  assert.equal(resolveWeatherTier(undefined,undefined),'standard');
});
