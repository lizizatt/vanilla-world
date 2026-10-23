import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldAudio,masterGain} from './world-audio.js';

test('master volume uses a v^2 curve, defaults to 50% and scales the shared output node', () => {
  assert.equal(masterGain(0),0);assert.equal(masterGain(1),1);assert.equal(masterGain(.5),.25);
  assert.equal(masterGain(NaN),0);assert.equal(masterGain(7),1);
  const audio=new WorldAudio();
  assert.equal(audio.volume,.5);
  let target;audio.out={gain:{setTargetAtTime:v=>{target=v;}}};audio.context={currentTime:0};
  audio.setVolume(.8);assert.ok(Math.abs(target-.64)<1e-9);
});
