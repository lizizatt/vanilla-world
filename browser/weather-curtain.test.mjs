import test from 'node:test';
import assert from 'node:assert/strict';
import {curtainShader,curtainUniform,curtainFade,CURTAIN_UNIFORM_BYTES} from './weather-curtain.js';
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
test('curtain fades out as the eye climbs into the cloud base',()=>{
  assert.equal(curtainFade(0,1316),1);assert.equal(curtainFade(1316,1316),0);assert.equal(curtainFade(2000,1316),0);
  const mid=curtainFade(1316-W.curtain.fade/2,1316);assert(mid>.4&&mid<.6);
});
test('quality tier: off wins, explicit tier wins, auto drops to low when slow',()=>{
  assert.equal(resolveWeatherTier(false,'high'),'off');assert.equal(resolveWeatherTier(true,'off'),'off');
  assert.equal(resolveWeatherTier(true,'high',true),'high');assert.equal(resolveWeatherTier(true,'low'),'low');
  assert.equal(resolveWeatherTier(true,'auto'),'standard');assert.equal(resolveWeatherTier(true,'auto',true),'low');
  assert.equal(resolveWeatherTier(undefined,undefined),'standard');
});
