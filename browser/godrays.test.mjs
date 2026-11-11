import test from 'node:test';
import assert from 'node:assert/strict';
import {GODRAYS,godraysTier,godraySun,godrayUniform,godrayShader} from './godrays.js';

test('godrays tier defaults to off', () => {
  assert.equal(godraysTier(undefined),'off');
  assert.equal(godraysTier('ultra'),'off');
  assert.equal(godraysTier('low'),'low');
  assert.equal(godraysTier('high'),'high');
});

test('sun gain: none below the horizon, strong when up, rain mutes it', () => {
  assert.equal(godraySun(-.2).gain,0);
  assert.ok(godraySun(.3).gain>.99);
  assert.ok(godraySun(.3,1).gain<.25);
  const low=godraySun(.02).colour,high=godraySun(.6).colour;
  assert.ok(low[1]<high[1]&&low[2]<high[2],'low sun is warmer');
});

test('godray uniform layout matches the shader struct', () => {
  const view={right:[1,0,0],up:[0,1,0],look:[0,0,-1],aspect:1.5};
  const u=godrayUniform(view,[0,2,0],'high',0,1280,720);
  assert.equal(u.length,24);
  assert.equal(u[3],1.5);
  assert.deepEqual([...u.slice(12,15)],[0,1,0]);
  assert.ok(Math.abs(u[15]-GODRAYS.strength.high)<1e-6);
  assert.equal(u[19],GODRAYS.samples.high);
  assert.equal(u[20],1280);
  assert.ok(/struct G \{[^}]*scr:vec4f/.test(godrayShader));
});
