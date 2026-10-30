import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {WAVE_COMPONENTS,WAVE_G,WAVE_PERIOD,WAVE_SCALES,WAVE_SLOPE_CAPS,WAVE_VERSION,waveParams,waveSlopeSum,waveTag,waveTagCompatible} from './wave-config.js';
import {paramsFromArray,sampleWaves,waveTime,openSea} from './wave-math.js';

const GOLDEN=new URL('./wave-golden.json',import.meta.url);
const params=waveParams({maelstrom:[1000,-2000]});
const points=[[0,0,0],[123.4,-56.7,777],[-300,40,120000],[1000,-2000,5],[1500,-2200,99999],[9000,9000,1],[-4e4,2e4,123456],[1e5,-1e5,2**20]];

test('wave table obeys dispersion, integer frequencies and the slope/contraction limits',()=>{
  const p=paramsFromArray(params);
  assert.equal(p.period,WAVE_PERIOD);
  for(const c of p.components){
    assert.ok(Math.abs(c.omega*c.omega/WAVE_G-c.k)<1e-12);
    const n=c.omega*WAVE_PERIOD/(2*Math.PI);assert.ok(Math.abs(n-Math.round(n))<1e-9);
    assert.ok(Math.abs(Math.hypot(...c.dir)-1)<1e-12);
  }
  const slope=waveSlopeSum();
  assert.ok(slope*WAVE_SCALES.normal<=WAVE_SLOPE_CAPS.normal);
  assert.ok(slope*WAVE_SCALES.maelstrom<=WAVE_SLOPE_CAPS.maelstrom);
  assert.ok(p.components.reduce((s,c)=>s+c.steepness*c.amp*c.k,0)*WAVE_SCALES.maelstrom<=.9);
  assert.equal(WAVE_COMPONENTS.reduce((s,c)=>s+c.amp,0),1,'1 yd normal amplitude');
});

test('wave clock wraps exactly and is a pure function of the tick',()=>{
  const p=paramsFromArray(params),wrap=WAVE_PERIOD*120;
  assert.equal(waveTime(p,777),waveTime(p,777+wrap));
  const a=sampleWaves(p,10,20,waveTime(p,500)),b=sampleWaves(p,10,20,waveTime(p,500+wrap));
  assert.deepEqual(a,b);
});

test('regions: 1x normal, 2.5x storm, 10x at the Maelstrom, waves off far from land only by shore',()=>{
  const p=paramsFromArray(params);
  const peak=(x,z)=>{let m=0;for(let k=0;k<4000;k+=7)m=Math.max(m,Math.abs(sampleWaves(p,x,z,waveTime(p,k*30)).height));return m;};
  const far=peak(60000,60000),storm=peak(1000+12000,-2000),eye=peak(1000,-2000);
  assert.ok(far<=1.01&&far>.5,`normal ${far}`);
  assert.ok(storm>far*1.5&&storm<2.51*1.01);
  assert.ok(eye>far*6&&eye<=10.1,`maelstrom ${eye}`);
});

test('shore: flat at and near land, normal in the open',()=>{
  const p=paramsFromArray(params),land=(x)=>Math.abs(x);
  assert.deepEqual(sampleWaves(p,0,0,12,x=>land(x)).height,0);
  assert.equal(sampleWaves(p,10,0,12,land).height,0);
  assert.notEqual(sampleWaves(p,3000,0,12,land).height,0);
});

test('recordings carry a wave version; waves-off recordings only replay with waves off',()=>{
  assert.equal(waveTag(true,42).waveVersion,WAVE_VERSION);
  assert.equal(waveTag(false).waveVersion,0);
  assert.ok(waveTagCompatible(waveTag(true),true)&&!waveTagCompatible(waveTag(true),false));
  assert.ok(waveTagCompatible(undefined,false)&&!waveTagCompatible(undefined,true));
});

test('golden vectors: Rust (voyage/wave_tests.rs) and JS agree',()=>{
  const p=paramsFromArray(params);
  const cases=points.map(([x,z,tick])=>{
    const s=sampleWaves(p,x,z,waveTime(p,tick),openSea);
    return {p:[x,z],tick,h:s.height,n:s.normal,v:s.velocity,amp:s.ampK};
  });
  const golden={params:Array.from(params),cases};
  if(process.env.WRITE_WAVE_GOLDEN)writeFileSync(GOLDEN,JSON.stringify(golden,null,1)+'\n');
  const saved=JSON.parse(readFileSync(GOLDEN,'utf8'));
  assert.deepEqual(saved.params,golden.params);
  saved.cases.forEach((c,i)=>{
    const g=cases[i];
    for(const [a,b] of [[c.h,g.h],[c.amp,g.amp],...c.n.map((v,j)=>[v,g.n[j]]),...c.v.map((v,j)=>[v,g.v[j]])])assert.ok(Math.abs(a-b)<1e-9,`case ${i}: ${a} vs ${b}`);
  });
});
