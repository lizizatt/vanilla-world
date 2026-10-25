import {cloudRate} from './sim-clock.js';
import test from 'node:test';import assert from 'node:assert/strict';
test('cloud rate follows the clock scale',()=>{assert.equal(cloudRate(0),0);assert.equal(cloudRate(1),1);assert.equal(cloudRate(10),10);assert.ok(cloudRate(100)>20&&cloudRate(1000)>cloudRate(100)*2);});

test('flow-map cycle stays >= 4.5 real seconds at every speed and never shrinks below the 1x cycle',async()=>{
  const {flowScale}=await import('./sim-clock.js'),{FLOW,flowPhase,beltWind}=await import('./cloud-flow.js');
  for(const s of [1,10,100,1000]){const r=cloudRate(s),cycle=FLOW.period*flowScale(r)/Math.max(r,1);assert.ok(flowScale(r)>=1);if(s>=10)assert.ok(cycle>=4.5,`${s}x cycle ${cycle}`);}
  const a=flowPhase(1000,5),b=flowPhase(1000+1e-3,5);assert.ok(Math.abs(a.wA-b.wA)<1e-3);
  for(const lat of [0,Math.PI/6,Math.PI/3])assert.ok(Math.hypot(...beltWind(lat))>=1,`stagnant belt at ${lat}`);
});
