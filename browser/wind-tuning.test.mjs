import test from 'node:test';
import assert from 'node:assert/strict';
import {WIND as W,WIND_TUNE,WIND_TUNE_DEFAULTS} from './wind-config.js';
import {windTuneUniform,WIND_TUNE_FLOATS,groundShader,sprayShader} from './wind-particles.js';
import {dustK,snowK,sprayK,flatK,WindRuntime} from './wind.js';
import {applyTune,resetTune,tuneSnippet,TUNE_GROUPS} from './wind-tuning-panel.js';
import {smoothstep} from './math.js';

// The final values dialed in with the tuning panel. A fresh profile must look exactly like these.
const BAKED={"speed":0.45,"layerSpeed":0.9,"layerCount":2,"layerAlpha":0.34,"layerTop":0,"groundHeight":0.27,"sizeHeight":4.7,"sizeLength":1.6,"diag":0.6,"dustAlpha":0.17,"snowAlpha":0.5,"density":0.3,"farShare":0.61,"distance":1.7,"slopeFlat0":0.12,"slopeFlat1":0.35,"sway":0.39,"clear":0.05,"dustOn":0.52,"dustFull":0.9,"snowOn":0.48,"snowFull":0.85,"fadeNear":16,"fadeFar":80,"sprayCrest0":0.51,"sprayCrest1":0.9,"sprayAlpha":0.11,"spraySize":6,"sprayDensity":1.65,"sprayDistance":2,"sprayFarShare":0.67,"sprayOn":0.32,"sprayFull":0.72};

test('tuning defaults reproduce the dialed-in look exactly',()=>{
  assert.deepEqual(WIND_TUNE_DEFAULTS,BAKED);
  assert.deepEqual({...WIND_TUNE},WIND_TUNE_DEFAULTS,'nothing has touched the live values in a fresh process');
});
test('default tuning uniform packs the baked values (f32)',()=>{
  const legacy=[.27,.17,.5,.05, 0,.34,2,.6, 1.6,4.7,.12,.35, 48*1.7,240*1.7,1-.61,.39, .11,.51,.9,6, 56*2,280*2,1-.67,.32, .72,0,0,0].map(Math.fround);
  const u=windTuneUniform();
  assert.equal(u.length,WIND_TUNE_FLOATS);assert.deepEqual([...u],legacy);
  // Both shaders read the block and carry no stale literal for the tuned numbers.
  for(const s of [groundShader,sprayShader])assert(s.includes('var<uniform> tn:array<vec4f,7>'));
});
test('default CPU behaviour equals the legacy formulas',()=>{
  for(let s=0;s<=1.0001;s+=.01){
    assert.equal(dustK(s),smoothstep(W.dust.on,W.dust.full,s));assert.equal(snowK(s),smoothstep(W.snow.on,W.snow.full,s));
    assert.equal(sprayK(s),smoothstep(W.spray.on,W.spray.full,s));
  }
  for(let s=0;s<=.6;s+=.005)assert.equal(flatK(s),1-smoothstep(W.flat[0],W.flat[1],s));
  // Drift: legacy used groundSpeed, layers.speed and a groundFar wrap.
  const ctx={dt:.05,x:0,z:0,t:3,lat:.8,character:'desert',storm:.6,mael:null,enabled:true,sea:false},w=new WindRuntime();
  w.step(ctx);const d0=[...w.drift],l0=[...w.layerDrift];w.step(ctx);
  const k=w.sample.speed*ctx.dt*W.groundSpeed*WIND_TUNE_DEFAULTS.speed;
  assert.equal(w.drift[0]-d0[0],w.sample.dir[0]*k);assert.equal(w.layerDrift[1]-l0[1],w.sample.dir[1]*k*WIND_TUNE_DEFAULTS.layerSpeed);
});
test('layer heights: (k+1)/(n+1) of the top reproduces the old .25/.5/.75 table at 3 layers',()=>{
  const n=3;W.layers.fracs.forEach((fr,k)=>assert.equal(Math.fround((k+1)/(n+1)*W.layers.top),Math.fround(fr*W.layers.top)));
});
test('panel logic: apply clamps and ignores junk, reset restores defaults, snippet round-trips',()=>{
  const t={...WIND_TUNE_DEFAULTS};
  applyTune({speed:2,layerCount:99,bogus:5,density:'x',sway:null,dustAlpha:-3},t);
  assert.equal(t.speed,2);assert.equal(t.layerCount,6);assert.equal(t.dustAlpha,0);assert.equal(t.density,WIND_TUNE_DEFAULTS.density);assert.equal(t.sway,WIND_TUNE_DEFAULTS.sway);assert(!('bogus' in t));
  resetTune(t);assert.deepEqual(t,WIND_TUNE_DEFAULTS);
  const snippet=JSON.parse(tuneSnippet(t));
  const keys=TUNE_GROUPS.flatMap(([,l])=>l.map(r=>r[0]));
  assert.deepEqual(Object.keys(snippet).sort(),[...keys].sort());
  const back={...WIND_TUNE_DEFAULTS,speed:3};applyTune(snippet,back);
  for(const k of keys)assert(Math.abs(back[k]-WIND_TUNE_DEFAULTS[k])<1e-5,k);
});
