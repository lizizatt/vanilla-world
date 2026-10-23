import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR,HYJAL_SUMMIT,MAELSTROM,FUNNEL,cloudShader,cloudUniform,funnelShader,maelstromCentre,sunDirection} from './clouds.js';

const manifest={ocean:[5333,-17600,13525,17066],world_bounds:[[0,0,51,56],[24,20,45,62]],
  regions:[{placement:[-21866,-17600]},{placement:[725,-16000]}]};
test('cloud uniform puts the maelstrom on the world-map eye at 0.8x Hyjal and tracks daylight',()=>{
  assert.equal(CLOUD_ALTITUDE,CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT);
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:2};
  const u=cloudUniform(view,5,.25,manifest,.5),[x,z]=maelstromCentre(manifest);
  assert.deepEqual([...u.slice(16,20)],[x,z,CLOUD_ALTITUDE,60000].map(Math.fround));
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