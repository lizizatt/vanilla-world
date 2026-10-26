import test from 'node:test';
import assert from 'node:assert/strict';
import {viewFrom,relativeCentre} from './body-sky.js';
import {spaceUniform,planetFrame} from './space.js';
import {AZEROTH,ELUNE} from './bodies.js';
import {litFraction,sunInertial} from './sky-coupling.js';
import {eluneSkyAt} from './elune-sky.js';

const view=eye=>({eye,look:[0,-1,0],right:[1,0,0],up:[0,0,-1],aspect:1.7});
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const unit=a=>{const n=Math.hypot(...a);return a.map(v=>v/n);};

// The phase of Elune seen from Azeroth's chart must be the true inertial one, wherever the eye is on the chart.
test('Elune disc is lit by the inertial sun from any Azeroth eye position', () => {
  for(const t of [0,500,1547.58,5000])for(const eye of [[0,200000,0],[-49964,222429,18440],[90000,150000,-30000]]) {
    const u=spaceUniform(view(eye),[0,1,0],{space:1,globe:1,registry:0},[],t,1,2e5,undefined,viewFrom(AZEROTH,t));
    assert.equal(u.length,72);
    assert.equal(u[71],1);
    const toElune=unit([...u.slice(48,51)]),sun=unit([...u.slice(68,71)]);
    // Phase seen from the camera itself: sun and Elune direction in the eye frame, against the same quantity from inertial positions.
    const cam=planetFrame(eye[0],eye[2],AZEROTH.centre,AZEROTH.radius).up.map(v=>v*(AZEROTH.radius+eye[1])),
      el=relativeCentre(AZEROTH,ELUNE,t),toE=unit(el.map((v,i)=>v-cam[i])),si=sunInertial(t);
    const seen=(1-dot(sun,toElune))/2,expect=(1-dot(si,toE))/2;
    assert.ok(Math.abs(seen-expect)<.01,`t=${t} eye=${eye}: ${seen} vs ${expect}`);
  }
});

// Both sides of the swap agree on the phase: from Elune's sub-Azeroth point the sun elevation gives the lit fraction the Azeroth side computes.
test('Elune chart and Azeroth chart agree on the phase at the swap', () => {
  for(const t of [100,1547.58,3000]) {
    const sky=eluneSkyAt(1,-1,t);
    assert.ok(Math.abs((1+sky.sun[1])/2-litFraction(ELUNE,AZEROTH,t))<.02,`t=${t}`);
  }
});

test('the other body\'s disc shader variant follows its config: Azeroth seen from Elune is atmospheric, Elune seen from Azeroth is not', async () => {
  const {atmosphericDisc}=await import('./body-sky.js');
  const {shaderSetFor}=await import('./body-shaders.js');
  const {BODIES}=await import('./bodies.js');
  assert.equal(atmosphericDisc(AZEROTH),true);assert.equal(atmosphericDisc(ELUNE),false);
  assert.match(shaderSetFor(ELUNE).space,/axx:vec4f/);assert.match(shaderSetFor(ELUNE).space,/cloud\*\.7/);
  assert.doesNotMatch(shaderSetFor(AZEROTH).space,/axx:vec4f/);
  const v=viewFrom(ELUNE,1000);assert.equal(v.moons[0].axes.length,3);
  assert.equal(viewFrom(AZEROTH,1000).moons[0].axes,undefined);
  for(const a of v.moons[0].axes)assert.ok(Math.abs(Math.hypot(...a)-1)<1e-9);
  const u=spaceUniform({eye:[0,100,0],look:[0,0,-1],right:[1,0,0],up:[0,1,0],aspect:1},[0,1,0],{space:1,globe:0},[],1000,1,1e6,undefined,v);
  assert.equal(u[75],1);assert.ok(u.length>=80);void BODIES;
});

test('the other body disc samples its own baked registry (discTex, binding 6), only bodies with an atmospheric parent bind it', async () => {
  const {shaderSetFor}=await import('./body-shaders.js');
  const {wantsDisc}=await import('./renderer-init.js');
  const src=shaderSetFor(ELUNE).space;
  assert.match(src,/@binding\(6\) var discTex/);assert.match(src,/textureSampleLevel\(discTex/);
  assert.doesNotMatch(shaderSetFor(AZEROTH).space,/discTex/);
  assert.equal(wantsDisc(ELUNE),true);assert.equal(wantsDisc(AZEROTH),false);
});

test('a non-active body horizon event fills its own parked height grid, not the active one', async()=>{
  const {bodyEvent,swapPlanetState}=await import('./renderer-events.js');
  const r={heightGrid:new Float32Array(64).fill(-Infinity)};
  // Real grid size comes from height-bake; use it so the splat lands in range.
  const {HEIGHT_W,HEIGHT_H}=await import('./height-bake.js');
  r.heightGrid=new Float32Array(HEIGHT_W*HEIGHT_H).fill(-Infinity);
  const vertices=new Float32Array([100,321,200,0,0,0,0]);
  assert.equal(bodyEvent(r,ELUNE,{event:'horizon',vertices,placement:[0,0]}),true);
  assert.ok(r.bodyStates.get('elune').heightGrid.some(h=>h===321));
  assert.ok(r.heightGrid.every(h=>h===-Infinity));
  assert.equal(bodyEvent(r,ELUNE,{event:'tile'}),false);
  const parked=r.bodyStates.get('elune').heightGrid;
  swapPlanetState(r,'azeroth','elune');
  assert.equal(r.heightGrid,parked);
});
