import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldAudio,masterGain,windLevel,idleThrob,EngineEnvelope} from './world-audio.js';
import {podEngineFor,POD_ENGINES,SFX} from './swe1r/sfx.js';

test('master volume uses a v^2 curve, defaults to 50% and scales the shared output node', () => {
  assert.equal(masterGain(0),0);assert.equal(masterGain(1),1);assert.equal(masterGain(.5),.25);
  assert.equal(masterGain(NaN),0);assert.equal(masterGain(7),1);
  const audio=new WorldAudio();
  assert.equal(audio.volume,.8);
  let target;audio.out={gain:{setTargetAtTime:v=>{target=v;}}};audio.context={currentTime:0};
  audio.setVolume(.5);assert.ok(Math.abs(target-.25)<1e-9);
});

test('wind is silent at rest, grows with speed in air, and thins to a faint low rumble in space',()=>{
  assert.equal(windLevel(0,100).gain,0);assert.equal(windLevel(0,1e6).gain,0);
  const slow=windLevel(500,100),fast=windLevel(2500,100);assert(fast.gain>slow.gain&&fast.cutoff>slow.cutoff);
  const high=windLevel(2500,20000),space=windLevel(30000,1e6);
  assert(high.gain<fast.gain,'thin air is quieter');
  assert(space.gain>0&&space.gain<fast.gain/3,'space keeps a subtle speed-tied rumble');assert(space.cutoff<150);
  assert(windLevel(30000,1e6).gain>windLevel(5000,1e6).gain);
});

test('idle throb is strongest at rest and gone at speed or full throttle',()=>{
  const e=new EngineEnvelope();for(let i=0;i<60;i++)e.advance(0,0,false,false,false,.05);
  assert(e.idle>.95);
  const seen=new Set();for(let i=0;i<40;i++)seen.add(idleThrob(e.idle,i/100).toFixed(2));assert(seen.size>5,'the idle pulses');
  for(let i=0;i<60;i++)e.advance(120,1,false,false,false,.05);
  assert(e.idle<.05);
});

test('Anakin and Sebulba get their own engine loops; other pods and non-swe1r skins use the generic loop',()=>{
  assert.equal(podEngineFor({source:'swe1r',name:'Sebulba'}),POD_ENGINES.Sebulba);
  assert.equal(podEngineFor({source:'swe1r',name:'Anakin Skywalker'}),POD_ENGINES['Anakin Skywalker']);
  assert.notEqual(POD_ENGINES.Sebulba,POD_ENGINES['Anakin Skywalker']);
  assert.equal(podEngineFor({source:'swe1r',name:'Ben Quadinaros'}),SFX.engine);
  assert.equal(podEngineFor({source:'model',name:'Sebulba'}),SFX.engine);assert.equal(podEngineFor(undefined),SFX.engine);
});
