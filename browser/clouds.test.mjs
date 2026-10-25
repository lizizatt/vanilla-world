import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR,HYJAL_SUMMIT,MAELSTROM,FUNNEL,cloudShader,cloudUniform,funnelShader,maelstromCentre,sunDirection,cloudShaderHigh,bakeCloudNoise,CLOUD_TOWER,resolveCloudQuality,SlowFrameGuard} from './clouds.js';

const manifest={ocean:[5333,-17600,13525,17066],world_bounds:[[0,0,51,56],[24,20,45,62]],
  regions:[{placement:[-21866,-17600]},{placement:[725,-16000]}]};
test('cloud uniform puts the maelstrom on the world-map eye at 0.8x Hyjal and tracks daylight',()=>{
  assert.equal(CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT);
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:2};
  const u=cloudUniform(view,5,.25,manifest,.5),[x,z]=maelstromCentre(manifest);
  assert.deepEqual([...u.slice(16,20)],[x,z,CLOUD_ALTITUDE,250000].map(Math.fround));
  assert.equal(u[20],.5);assert.equal(u[15],.25);assert.equal(u[11],5);assert.equal(u[7],2);
});
test('maelstrom centre is 43% across the gap, north of the old midpoint',()=>{
  const [x,z]=maelstromCentre(manifest);
  assert(Math.abs(x-(5333+.43*(13525-5333)))<1e-6);
  assert(z<-1000&&z>-2200,`z ${z}`);
});
test('shader carries the tunable eye/wall radii and counter-clockwise spiral',()=>{
  assert(cloudShader.includes(MAELSTROM.eyeRadius.toFixed(1)));assert(cloudShader.includes('atan2(-d.y,d.x)'));
});test('clouds clip their ray march to the sampled scene depth instead of depth-testing a bias plane',()=>{
  assert(cloudShader.includes('textureLoad(sceneDepth'));assert(cloudShader.includes('s1=min(s1,sceneDist)')&&cloudShader.includes('f1=min(f1,sceneDist)'));
});

test('game cloud and fog colours ride in the spare uniform slots',()=>{
  const view={eye:[0,0,0],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1};
  const u=cloudUniform(view,0,1,manifest,0,{cloud:[.1,.2,.3],fog:[.4,.5,.6]});
  assert.equal(u[27],1);assert.ok(Math.abs(u[28]-.4)<1e-6);
  assert.equal(cloudUniform(view,0,1,manifest,0)[27],0);
});

test('funnel rises far above the sheet, tapers wider upward and shares the cloud depth bindings',()=>{
  assert.ok(FUNNEL.top>5*520);assert.ok(FUNNEL.topRadius>FUNNEL.baseRadius);
  assert.match(funnelShader,/sceneDepth:texture_depth_2d/);assert.match(funnelShader,/atan2\(-d\.y,d\.x\)/);
});

test('sheet and funnel share one ray march ordered by distance',()=>{
  assert.equal(funnelShader,cloudShader);assert.match(cloudShader,/ts<=tf/);assert.match(cloudShader,/sheetDensity[\s\S]*funnelDensity/);
});

test('sun direction follows the half-minute clock and lighting reaches the cloud uniform',()=>{
  const noon=sunDirection(1440),dusk=sunDirection(2160),night=sunDirection(0);
  assert.ok(noon[1]>.9);assert.ok(Math.abs(dusk[1])<1e-6&&dusk[0]<-.9);assert.ok(night[1]<-.9);
  const view={eye:[0,0,0],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1};
  const u=cloudUniform(view,0,1,manifest,0,{cloud:[.1,.2,.3],fog:[.4,.5,.6],sun:[.9,.8,.7],cloud2:[.2,.3,.4]},undefined,2160);
  assert.ok(Math.abs(u[32]-dusk[0])<1e-6);assert.ok(Math.abs(u[36]-.9)<1e-6);assert.ok(Math.abs(u[40]-.2)<1e-6&&u[43]===1);
  assert.match(cloudShader,/cloud2:vec4f/);assert.match(cloudShader,/fn silver/);
});
test('high tier adds noise texture bindings, 16 steps and a sun light tap; standard stays texture-free',()=>{
  assert.match(cloudShaderHigh,/texture_3d<f32>/);assert.match(cloudShaderHigh,/const NS=28/);assert.match(cloudShaderHigh,/let shade=mix/);
  assert.doesNotMatch(cloudShader,/texture_3d/);assert.match(cloudShader,/const NS=8/);assert.match(cloudShader,/let shade=1\.0/);
});

test('baked cloud noise is deterministic, spans the range and tiles',()=>{
  const a=bakeCloudNoise(16),b=bakeCloudNoise(16);
  assert.equal(a.length,16*16*16*2);assert.deepEqual(a,b);
  assert.ok(Math.max(...a)>170&&Math.min(...a)<85);
  // Wrapped lattice: the lowest-frequency channel varies smoothly across the seam.
  const at=(x,y,z)=>a[((z*16+y)*16+x)*2];
  assert.ok(Math.abs(at(15,3,3)-at(0,3,3))<60);
});

test('storm columns grow only in the High tier; Standard keeps the flat slab',()=>{
  assert.match(cloudShaderHigh,new RegExp('const UP='+CLOUD_TOWER.up+'\\.0'));assert.match(cloudShaderHigh,new RegExp('const DOWN='+CLOUD_TOWER.down+'\\.0'));
  assert.match(cloudShader,/const UP=0\.0/);assert.match(cloudShader,/const DOWN=0\.0/);
  assert.ok(CLOUD_TOWER.up>CLOUD_TOWER.down);
});

test('cloud quality: auto is High when supported, explicit choices win, slow frames drop auto only',()=>{
  assert.equal(resolveCloudQuality('auto'),true);
  assert.equal(resolveCloudQuality('auto',{highFailed:true}),false);
  assert.equal(resolveCloudQuality('auto',{slow:true}),false);
  assert.equal(resolveCloudQuality('high',{slow:true}),true);
  assert.equal(resolveCloudQuality('standard'),false);
  const g=new SlowFrameGuard();let r=false;for(let i=0;i<200;i++)r=g.push(40)||r;assert.ok(r);
  const h=new SlowFrameGuard();r=false;for(let i=0;i<400;i++)r=h.push(16)||r;assert.ok(!r);assert.ok(!h.push(5000));
});

test('funnel base is sparse and un-bent onto the curved water',()=>{
  assert.ok(FUNNEL.baseDensity>0&&FUNNEL.baseDensity<.3&&FUNNEL.sparseHeight>500);
  assert.match(cloudShader,/mix\(0\.120,1\.0,smoothstep\(SEA,SEA\+2200\.0,pos\.y\)\)/);
  assert.match(cloudShader,/worldAt\(dir\*tf\)/);
});

test('zone lighting blends out with altitude (zone factor)',()=>{
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:2},g={cloud:[.2,.4,.9],fog:[.5,.1,.1],sun:[1,0,0],cloud2:[.1,.1,.1]};
  const lo=cloudUniform(view,0,1,manifest,1,g,undefined,1440,{bend:0,space:0,zone:1}),hi=cloudUniform(view,0,1,manifest,1,g,undefined,1440,{bend:1,space:1,zone:0});
  assert.deepEqual([...lo.slice(24,27)].map(v=>+v.toFixed(2)),[.2,.4,.9]);assert.deepEqual([...hi.slice(24,27)],[1,1,1]);assert.deepEqual([...hi.slice(36,39)].map(v=>+v.toFixed(2)),[1,.96,.88]);
});
