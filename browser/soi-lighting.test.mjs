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

test('otherView: the other body centre sits straight below the re-based camera, rotations preserve the basis', async()=>{
  const {otherView}=await import('./body-sky.js');
  const {centreAt,axesAt}=await import('./bodies.js');
  for(const [A,B,eye] of [[AZEROTH,ELUNE,[1500,4000,-900]],[ELUNE,AZEROTH,[300,250,200]]]) for(const t of [100,2600,9000]){
    const view={eye,look:[0,0,-1],right:[1,0,0],up:[0,1,0],aspect:1.5},o=otherView(view,A,B,t);
    assert.ok(o.altitude>0);
    const f=planetFrame(eye[0],eye[2],A.centre,A.radius),rA=A.radius+eye[1];
    const toB=(c,m)=>c[0]*m[0]+c[1]*m[1]+c[2]*m[2];void toB;
    const cb=centreAt(B,t),ca=centreAt(A,t),ax=axesAt(A,t);
    const cam=[0,1,2].map(i=>ca[i]+rA*(ax[0][i]*f.up[0]+ax[1][i]*f.up[1]+ax[2][i]*f.up[2]));
    const toBcentreInertial=[cb[0]-cam[0],cb[1]-cam[1],cb[2]-cam[2]];
    // B centre expressed in A eye-local, then carried into B's view: must be (0,-(R+alt),0).
    const eyeLocal=[f.east,f.up,f.south].map(a=>0).map((_,k)=>{const col=[f.east,f.up,f.south][k];const pl=[0,1,2].map(i=>ax[0][i]*col[0]+ax[1][i]*col[1]+ax[2][i]*col[2]);return pl[0]*toBcentreInertial[0]+pl[1]*toBcentreInertial[1]+pl[2]*toBcentreInertial[2];});
    const c=o.toOther(eyeLocal);
    assert.ok(Math.abs(c[0])<1&&Math.abs(c[2])<1&&Math.abs(c[1]+B.radius+o.altitude)<1,JSON.stringify([c,B.radius+o.altitude]));
    const {look,right,up}=o.view;
    assert.ok(Math.abs(Math.hypot(...look)-1)<1e-9&&Math.abs(look[0]*right[0]+look[1]*right[1]+look[2]*right[2])<1e-9&&Math.abs(Math.hypot(...up)-1)<1e-9);
    assert.ok(Math.abs(Math.hypot(...o.sun)-1)<1e-9);
  }
});

test('multi-body frame: the active globe and the other body both draw in one pass, the other from its own resources, and the stand-in disc is switched off', async()=>{
  const {drawBodies,sharedFrame,otherBodies}=await import('./renderer-sky.js');
  const {setActiveBody,activeBody}=await import('./body-shaders.js');
  const {HEIGHT_W,HEIGHT_H}=await import('./height-bake.js');
  const prev=activeBody();setActiveBody(ELUNE);
  try {
    const writes=[],calls=[];
    const mk=name=>({spacePipeline:name+'-space',patchPipeline:name+'-patch',spaceGroup:name+'-sg',patchGroup:name+'-pg',spaceBuffer:{name},patchBuffer:{name:name+'p'},surfaceTex:{name},heightTex:{name:name+'h'}});
    const r={sharedSpace:true,timeOfDay:900,view:{eye:[300,250,200],look:[0,0,-1],right:[1,0,0],up:[0,1,0],aspect:1.5},
      bodyStates:new Map([['azeroth',{heightGrid:new Float32Array(HEIGHT_W*HEIGHT_H).fill(-Infinity),colourGrid:new Float32Array(0),surfaceBytes:new Uint8Array(1024*512*4)}]]),
      planetSets:{azeroth:{},elune:{}},otherSets:{azeroth:mk('azeroth')},
      device:{queue:{writeTexture:(t)=>writes.push(['tex',t.texture.name]),writeBuffer:(b)=>writes.push(['buf',b.name])}}};
    const pass={setPipeline:p=>calls.push(p),setBindGroup:()=>{},setVertexBuffer:()=>{},draw:(n,i)=>calls.push(['draw',n,i])};
    assert.deepEqual(otherBodies(r).map(b=>b.id),['azeroth']);
    drawBodies(r,pass,{mesh:false,registry:true,globe:1},.1);
    assert.deepEqual(calls.filter(c=>typeof c==='string'),['azeroth-space']);
    assert.ok(writes.some(w=>w[0]==='buf'&&w[1]==='azeroth'),'own uniform buffer');
    assert.ok(writes.some(w=>w[0]==='tex'&&w[1]==='azeroth'),'own surface texture');
    assert.equal(sharedFrame(r).moons[0].radius,0);
    delete r.otherSets;assert.equal(sharedFrame(r).moons[0].radius,AZEROTH.radius);
  } finally {setActiveBody(prev);}
});

test('an Azeroth-only session (no parked bodies) never takes the multi-body path', async()=>{
  const {otherBodies,sharedFrame}=await import('./renderer-sky.js');
  assert.deepEqual(otherBodies({sharedSpace:false,bodyStates:new Map(),planetSets:{}}),[]);
  assert.deepEqual(otherBodies({sharedSpace:true}),[]);
  assert.equal(sharedFrame({sharedSpace:false,timeOfDay:5}),undefined);
});
