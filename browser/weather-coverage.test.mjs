import test from 'node:test';
import assert from 'node:assert/strict';
import {density} from './cloud-march.js';
import {WEATHER as W} from './weather-config.js';
import {precipitation} from './weather-field.js';

// Long deterministic space/time sample of the same CPU density path the renderer uses (synthetic land mask, no game data).
const rng=seed=>{let s=seed;return()=>(s=(s*1664525+1013904223)>>>0)/4294967296;};
const mask=(land,lift)=>({w:2,h:2,data:new Uint8Array(16).map((_,i)=>i%4===0?land:i%4===3?255:lift)});
const sample=(x,z,t,m,wet=1,coverage)=>density([x,1500,z],t,false,[1e9,1e9],coverage,m,{wet,on:1});
const DENSE=.56;

test('thin cloud never rains and dry zones never rain over a long sample',()=>{
  const r=rng(3);let thin=0,dry=0;
  for(let i=0;i<4000;i++){const x=(r()-.5)*2e5,z=(r()-.5)*2e5,t=r()*5e4;
    if(sample(x,z,t,mask(0,128),1,W.coverage[0]-.01)[4]>0)thin++;
    if(sample(x,z,t,mask(255,255),0)[4]>0)dry++;}
  assert.equal(thin,0);assert.equal(dry,0);
});
test('about a fifth to a third of dense cloud is raining, in clearly separated spells',()=>{
  const r=rng(11),N=500,T=300,dt=60;let wet=0,n=0,wetRun=[],dryRun=[];
  for(let i=0;i<N;i++){const x=(r()-.5)*2e5,z=(r()-.5)*2e5,t0=r()*1e5;let prev=null,len=0;
    for(let k=0;k<T;k++){const on=sample(x,z,t0+k*dt,mask(0,128),1,DENSE)[4]>=W.on;n++;if(on)wet++;
      if(on===prev)len++;else{if(prev!==null)(prev?wetRun:dryRun).push(len*dt);prev=on;len=1;}
}
    if(prev===false)dryRun.push(len*dt);}
  const f=wet/n,mean=a=>a.reduce((s,v)=>s+v,0)/Math.max(a.length,1);
  assert(f>.2&&f<.36,`rain share of dense cloud ${f}`);
  assert(mean(wetRun)<1500,`mean wet spell ${mean(wetRun)}s`);
  assert(mean(dryRun)>=300,`mean dry spell ${mean(dryRun)}s`);
});
test('ground-time raining stays occasional when ~20% of the sky is dense cloud (land-like share measured in the real mask)',()=>{
  // Coverage mix from real-data measurement: land ~20% dense (>=.42), sea ~11%; the rest is thin cloud that never rains.
  const r=rng(29),pts=4000;let soft=0,hard=0,n=0;
  for(let i=0;i<pts;i++){const x=(r()-.5)*2e5,z=(r()-.5)*2e5,t=r()*1e5,cov=r()<.2?DENSE:.3,P=sample(x,z,t,mask(0,128),1,cov)[4];n++;if(P>=.1)soft++;if(P>=W.on)hard++;}
  assert(soft/n>.1&&soft/n<.2,`soft ${soft/n}`);assert(hard/n>.04&&hard/n<.12,`hard ${hard/n}`);
});

test('spawn regression: a clear sky inside the Maelstrom envelope (coverage .18, storm ~.3) never rains, even with wet climate',()=>{
  const storm=.3,eye=1,clear=.18;
  assert.equal(precipitation([0,0,0],0,clear,storm,eye),0);
  for(let t=0;t<2e4;t+=250)assert.equal(precipitation([4e3,2e3,9e3],t,clear,storm,eye),0);
  assert(precipitation([0,0,0],0,.95,.9,eye)>=W.heavy,'dense storm cloud still rains heavily');
});
