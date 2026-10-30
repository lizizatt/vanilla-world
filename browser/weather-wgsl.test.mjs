import test from 'node:test';
import assert from 'node:assert/strict';
import {weatherWGSL,WEATHER_LOOK} from './weather-wgsl.js';
import {cloudShader,cloudShaderHigh,cloudUniform} from './clouds.js';
import {WEATHER as W} from './weather-config.js';
import {density} from './cloud-march.js';
import {sphereAt} from './cloud-flow.js';
import {PLANET_RADIUS} from './space.js';

const src=weatherWGSL();
test('shared emitter carries every weather constant the CPU field reads',()=>{
  for(const v of [W.cell.gate[0],W.cell.gate[1],W.cell.octave2,W.cell.mix,1-W.cell.mix,W.life.period,W.life.build,1-W.life.decay,W.coverage[0],W.coverage[1],W.storm.from,W.storm.to])
    assert(src.includes(Number.isInteger(v)?v.toFixed(1):String(v)),`missing ${v}`);
  assert(src.includes(String(1/W.cell.scale)));
  for(const fn of ['wxCellNoise','wxLifeEnvelope','wxCellIntensity','wxCoverageGate','wxStormRain'])assert(src.includes(`fn ${fn}(`));
});
test('both cloud tiers embed the emitter and couple the cell into the density and lighting',()=>{
  for(const s of [cloudShader,cloudShaderHigh]){
    assert(s.includes(src));
    assert(s.includes('wxCellIntensity(Q,t)*wxCoverageGate(base)*c.near.y'));
    assert(s.includes('fn sheetDensity(pos:vec3f,t:f32)->vec4f'));
    assert(s.includes(`mix(1.0,${1-WEATHER_LOOK.dim},s.w)`));
  }
});
test('weather uniform slots default off and carry climate + enabled',()=>{
  const view={eye:[0,0,0],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1},m={ocean:[0,0,1,1],world_bounds:[[0,0,1,1],[0,0,1,1]],regions:[{placement:[0,0]},{placement:[0,0]}]};
  const off=cloudUniform(view,0,1,m,5);assert.deepEqual([off[21],off[22]],[0,0]);
  const on=cloudUniform(view,0,1,m,5,undefined,undefined,1440,{bend:0,space:0,wet:.5,weatherOn:1});assert.deepEqual([on[21],on[22]],[.5,1]);
});
test('CPU mirror: weather off leaves the cloud untouched, on swells and reports P',()=>{
  let swelled=0,rained=0;
  for(let i=0;i<400;i++){
    const pos=[2e4+i*731,1590,-3e4+i*1213],off=density(pos,500+i*37,false,[0,0],.9),on=density(pos,500+i*37,false,[0,0],.9,undefined,{wet:1,on:1});
    assert.equal(off[4],0);
    assert(on[4]>=0&&on[4]<=1);
    if(on[4]>.5){rained++;if(on[0]>=off[0])swelled++;}
  }
  assert(rained>40);assert(swelled>=rained*.9);
  const dry=density([2e4,1590,-3e4],500,false,[0,0],.9,undefined,{wet:0,on:1});assert.equal(dry[4],0);
});
test('Maelstrom wall rains heavily through the sheet, the eye stays calm',()=>{
  const wall=density([1500,1590,0],100,false,[0,0],undefined,undefined,{wet:0,on:1}),eye=density([50,1590,0],100,false,[0,0],undefined,undefined,{wet:1,on:1});
  assert(wall[4]>=W.heavy,`wall ${wall[4]}`);assert.equal(eye[4],0);
});
