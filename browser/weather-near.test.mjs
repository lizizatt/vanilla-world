import test from 'node:test';
import assert from 'node:assert/strict';
import {particleShader,weatherParticleUniform,PARTICLE_UNIFORM_BYTES} from './weather-particles.js';
import {nearCount} from './renderer-weather.js';
import {weatherLevel,RAIN_AUDIO} from './world-audio.js';
import {WEATHER as W} from './weather-config.js';

test('near-box uniform packs camera axes, eye+time, velocity+count and params',()=>{
  const view={right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1.5};
  const u=weatherParticleUniform(view,.5,[10,20,30],7,[1,2,3],1500,[.5,.25,1,.8]);
  assert.equal(u.byteLength,PARTICLE_UNIFORM_BYTES);
  assert.deepEqual([...u.slice(0,4)],[1,0,0,1.5]);assert.deepEqual([...u.slice(12,16)],[10,20,30,7]);
  assert.deepEqual([...u.slice(16,20)],[1,2,3,1500]);assert.deepEqual([...u.slice(20,24)],[.5,.25,1,.8].map(Math.fround));
  assert(particleShader.includes('fn h3(')&&particleShader.includes('@builtin(instance_index)'));
});
test('quality tiers set the instance budget; off has none',()=>{
  assert.equal(nearCount('off'),0);assert(nearCount('low')>0&&nearCount('low')<nearCount('standard')&&nearCount('standard')<nearCount('high'));
});
test('weather audio follows level and altitude fade; snow is quieter and darker',()=>{
  assert.equal(weatherLevel(0).gain,0);assert.equal(weatherLevel(1,0,0).gain,0);
  const rain=weatherLevel(1,0,1),snow=weatherLevel(1,1,1);
  assert.equal(rain.gain,RAIN_AUDIO.rainGain);assert(snow.gain<rain.gain&&snow.cutoff<rain.cutoff);
  assert(weatherLevel(.4).gain<weatherLevel(.8).gain);
});
