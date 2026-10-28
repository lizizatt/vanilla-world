import test from 'node:test';
import assert from 'node:assert/strict';
import {shellExtent} from './cloud-march.js';
import {PLANET_RADIUS} from './space.js';
import {SHELL_CURVATURE,shellCurvatureAt,stepTierMix,TIER_FADE_SECONDS,cloudShader,cloudShaderHigh,cloudUniform} from './clouds.js';
import {cloudShellRadius,CLOUD_RADIUS_RANGE,CLOUD_RADIUS_GROUND_SCALE,planetFactors,BEND_RANGE,SPACE_RANGE,GLOBE_RANGE,ZONE_LIGHT_RANGE} from './terrain-transition.js';

const VISIBLE=15e4; // beyond this the sheet is fully fogged

// The curved shell is the only cloud path: the visible span must change smoothly with altitude from the ground up through the terrain bend band.
test('visible cloud span is continuous with altitude from ground level to orbit',()=>{
  for(const high of [false,true]) for(const p of [-.002,-.0005,0,.0005,.002,.01,.03,.1,.3,.8]) {
    let prev=null;
    for(let a=2;a<=1700;a+=.5) {
      const x=shellExtent(a,Math.sin(p),shellCurvatureAt(a),high);
      const m=x.live?Math.max(0,Math.min(x.s1,VISIBLE)-Math.min(x.s0,VISIBLE)):0;
      if(prev!==null)assert.ok(Math.abs(m-prev)<=.25*Math.max(m,prev)+1500,`pop at alt ${a} pitch ${p} high=${high}: ${prev} -> ${m}`);
      prev=m;
    }
  }
});

test('blended planet factors are C0 and monotonic with altitude',()=>{
  const ranges={bend:BEND_RANGE,globe:GLOBE_RANGE,space:SPACE_RANGE,zone:ZONE_LIGHT_RANGE};
  for(const key of Object.keys(ranges)) {
    const tol=1.6/(ranges[key][1]-ranges[key][0])+1e-5;
    let prev=planetFactors(0.5)[key];
    for(let a=1;a<=12000;a+=1) {
      const v=planetFactors(a)[key];
      assert.ok(Math.abs(v-prev)<=tol,`${key} steps ${prev}->${v} at ${a}`);
      prev=v;
    }
  }
  for(const r of [BEND_RANGE,SPACE_RANGE,GLOBE_RANGE,ZONE_LIGHT_RANGE])assert.ok(r[1]>r[0]);
});



test('cloud shell radius: limits, monotonic, C1 and continuous in altitude',()=>{
  const R=PLANET_RADIUS,r=a=>cloudShellRadius(a,R);
  assert.equal(r(0),R*CLOUD_RADIUS_GROUND_SCALE);
  assert.ok(Math.abs(r(CLOUD_RADIUS_RANGE[1])-R)<1e-6);
  assert.equal(r(1e6),R);
  let prev=r(0),slope=0;
  for(let a=1;a<=60000;a+=1) {
    const v=r(a),s=(v-prev);
    assert.ok(v<=prev+1e-9,`radius grows at ${a}`);
    assert.ok(Math.abs(s-slope)<=R*.02,`slope jump at ${a}`);
    slope=s;prev=v;
  }
  assert.ok(shellCurvatureAt(0)<SHELL_CURVATURE/5&&shellCurvatureAt(9000)===SHELL_CURVATURE);
});

test('apparent cloud horizon dip grows with altitude and matches the terrain bend curvature',()=>{
  const dip=a=>{let low=0;for(let d=5;d>-80;d-=.05)if(shellExtent(a,Math.sin(d*Math.PI/180),shellCurvatureAt(a),false).live)low=-d;return low;};
  let prev=-1;
  for(const a of [50,100,300,600,1000,1300])assert.ok(dip(a)>prev,`dip at ${a}`),prev=dip(a);
  for(const a of [100,500,1000,1500]){const g=1/CLOUD_RADIUS_GROUND_SCALE,b=planetFactors(a).bend;assert.ok(Math.abs(shellCurvatureAt(a)*PLANET_RADIUS-(g+(1-g)*b))<1e-4,`curvature follows the terrain bend at ${a}`);}
  assert.ok(Math.abs(shellCurvatureAt(7000)-SHELL_CURVATURE)<1e-12);
});

test('low-altitude horizon: the flatter shell keeps distant cloud above the ground horizon',()=>{
  const low=shellExtent(40,0,shellCurvatureAt(40),false),old=shellExtent(40,0,SHELL_CURVATURE,false);
  assert.ok(low.s0>3*old.s0,`ground horizon cloud starts ${low.s0} vs ${old.s0}`);
});

test('tier crossfade weight is continuous, bounded per frame and reaches both ends',()=>{
  for(const dt of [.004,.016,.05,.5,3]) {
    let m=0,prev=0,frames=0;
    while(m<1&&frames++<1000){m=stepTierMix(m,1,dt);assert.ok(m-prev<=.1/TIER_FADE_SECONDS+1e-9,`step ${m-prev} at dt ${dt}`);prev=m;}
    assert.equal(m,1);
    while(m>0&&frames++<2000){m=stepTierMix(m,0,dt);}
    assert.equal(m,0);
  }
  assert.equal(stepTierMix(.5,.5,.016),.5);
});

test('High and Standard shaders cull complementary pixel sets from the tier weight',()=>{
  assert.match(cloudShaderHigh,/tierPick>=c\.fog\.w\)\{discard/);
  assert.match(cloudShader,/tierPick<c\.fog\.w\)\{discard/);
  const u=cloudUniform({eye:[0,100,0],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1},0,1,{ocean:[5333,-17600,13525,17066],world_bounds:[[0,0,51,56],[24,20,45,62]],regions:[{placement:[-21866,-17600]},{placement:[725,-16000]}]},1,null,undefined,1440,{bend:0,space:0,tierMix:.37});
  assert.ok(Math.abs(u[31]-.37)<1e-6);
});



