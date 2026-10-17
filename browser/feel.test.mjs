import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraView} from './world-camera.js';
import {WorldInput} from './world-input.js';
import {engineSample,EngineEnvelope} from './world-audio.js';

test('native chase smoothing is time-based, rebases precisely, and clips after filtering',()=>{
  const state=[100,2,100,0],settings={cameraSeconds:.5,cameraDistance:15};
  const run=fps=>{
    const rig={camera:[0,0,0],origin:[100,100],chase:[0,-Math.atan(.3)],lookBack:false};
    for(let i=0;i<fps;i++)cameraView(rig,state,undefined,1/fps,[100,100],settings);
    return rig.camera;
  };
  const reference=run(30);
  for(const fps of [60,144])assert(run(fps).every((n,i)=>Math.abs(n-reference[i])<1e-10));
  const rig={camera:[1,2,3],origin:[1e9,-1e9],chase:[0,0],lookBack:false};
  cameraView(rig,[1e9,2,-1e9,0],undefined,0,[1e9+256,-1e9+256],settings);
  assert.deepEqual(rig.camera,[-255,2,-253]);
  let casts=0;
  rig.clipCamera=(_pivot,to)=>{casts++;return [to[0],to[1],Math.min(4,to[2])];};
  cameraView(rig,[0,2,0,0],undefined,.016,[0,0],settings);
  assert.equal(casts,2);assert(rig.camera[2]<=4);
  rig.camera=undefined;
  cameraView(rig,[0,2,0,1],undefined,0,[0,0],settings);
  assert.equal(rig.chase[0],1);
});
test('camera orbit clamps pitch, wraps yaw and returns behind the craft; flight bypasses chase',()=>{
  const rig={},state=[0,2,0,Math.PI-.01];
  cameraView(rig,state,undefined,.016,[0,0],{});
  for(let i=0;i<100;i++)cameraView(rig,state,undefined,.1,[0,0],{cameraLook:[1,1]});
  assert(Math.abs(rig.chase[0])<=Math.PI);assert(rig.chase[1]<Math.PI/2);
  const pitch=rig.chase[1];cameraView(rig,state,undefined,.1,[0,0],{});
  assert(rig.chase[1]<pitch);
  cameraView(rig,state,[100,200,300,0,0],.1,[100,300],{});
  assert.deepEqual(rig.camera,[0,200,0]);
});
const pad=()=>({connected:true,mapping:'standard',index:0,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))});
test('native and legacy keyboard profiles preserve brake/hop intent and input gates',()=>{
  const input=new WorldInput(),keys=new Set(['KeyS','Space','ControlLeft']);
  assert.deepEqual([input.sample(keys,[],true).throttle,input.sample(keys,[],true).flags],[0,13]);
  assert.deepEqual([input.sample(keys,[],true,'legacy').throttle,input.sample(keys,[],true,'legacy').flags],[-1,5]);
  assert.equal(input.sample(new Set(['KeyW','Space']),[],false).flags,1);
  assert.equal(input.sample(new Set(['KeyW']),[],false).throttle,0);
});
test('gamepad triggers subtract, noisy sticks never steal input, edges and disconnect are safe',()=>{
  const input=new WorldInput(),p=pad(),keys=new Set(['KeyW']);
  p.axes[0]=.17;input.sample(keys,[p],true);assert.equal(input.device,'keyboard');
  p.buttons[6].value=1;p.axes[2]=1;
  let state=input.sample(keys,[p],true);assert.equal(state.throttle,-1);assert.equal(state.look[0],1);
  p.buttons[7].value=1;p.buttons[11].pressed=true;
  state=input.sample(keys,[p],true);assert.equal(state.throttle,0);assert(state.cockpit);
  assert(!input.sample(keys,[p],true).cockpit);
  input.keyboard();input.sample(keys,[p],true);assert.equal(input.device,'keyboard');
  assert.equal(input.sample(keys,[],true).throttle,1);
  assert.equal(input.device,'keyboard');
});
test('native engine beds are bounded, seamless stereo; envelopes release boost and suppress held thrust',()=>{
  for(let layer=0;layer<3;layer++) {
    for(let i=0;i<2400;i++)assert(engineSample(layer,i/1200).every(n=>Number.isFinite(n)&&Math.abs(n)<=1));
    assert(engineSample(layer,2).every(n=>Math.abs(n)<1e-10));
  }
  assert.notEqual(engineSample(0,.13)[0],engineSample(0,.13)[1]);
  const envelope=new EngineEnvelope();
  for(let i=0;i<120;i++)envelope.advance(120,1,true,false,false,1/60);
  assert(envelope.boost>.99 && envelope.thrust>.99);
  for(let i=0;i<120;i++)envelope.advance(120,1,true,true,false,1/60);
  assert(envelope.boost<.001 && envelope.thrust<.001 && envelope.speed<.001);
});
