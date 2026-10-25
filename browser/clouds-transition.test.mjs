import test from 'node:test';
import assert from 'node:assert/strict';
import {shellExtent,extent} from './cloud-march.js';
import {shellCurvature} from './clouds.js';
import {planetFactors,BEND_RANGE,SPACE_RANGE,GLOBE_RANGE,CLOUD_RANGE,ZONE_LIGHT_RANGE} from './terrain-transition.js';

const VISIBLE=15e4; // beyond this the sheet is fully fogged

// The flat-sheet to curved-shell switch (terrain bend starting at BEND_RANGE[0]) must not pop the visible cloud span.
test('visible cloud span is continuous across the flat-to-shell transition',()=>{
  for(const high of [false,true]) for(const p of [-.002,-.0005,0,.0005,.002,.01,.03,.1,.3,.8]) {
    let prev=null;
    for(let a=100;a<=1700;a+=.5) {
      const dy=Math.sin(p),k=shellCurvature(planetFactors(a).bend);
      const x=k>0?shellExtent(a,dy,k,high):(()=>{const f=extent(a,dy,1e9,high);return {live:f.s1>f.s0,s0:f.s0,s1:f.s1};})();
      const m=x.live?Math.max(0,Math.min(x.s1,VISIBLE)-Math.min(x.s0,VISIBLE)):0;
      if(prev!==null)assert.ok(Math.abs(m-prev)<=.25*Math.max(m,prev)+1500,`pop at alt ${a} pitch ${p} high=${high}: ${prev} -> ${m}`);
      prev=m;
    }
  }
});

test('blended planet factors are C0 and monotonic with altitude',()=>{
  const ranges={bend:BEND_RANGE,globe:GLOBE_RANGE,space:SPACE_RANGE,cloud:CLOUD_RANGE,zone:ZONE_LIGHT_RANGE};
  for(const key of Object.keys(ranges)) {
    const tol=1.6/(ranges[key][1]-ranges[key][0])+1e-5;
    let prev=planetFactors(0.5)[key];
    for(let a=1;a<=12000;a+=1) {
      const v=planetFactors(a)[key];
      assert.ok(Math.abs(v-prev)<=tol,`${key} steps ${prev}->${v} at ${a}`);
      prev=v;
    }
  }
  for(const r of [BEND_RANGE,SPACE_RANGE,GLOBE_RANGE,CLOUD_RANGE,ZONE_LIGHT_RANGE])assert.ok(r[1]>r[0]);
});


