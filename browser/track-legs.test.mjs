import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {legs,transitions,gatesOn,checkTrack,MIN_GATE_GAP} from './track-legs.js';
import {TrackDraft} from './track-edit.js';
import {validateTrack} from './race.js';

const gate=(x,z,body)=>({pos:[x,10,z],yaw:0,width:60,...(body?{body}:{})});
const moon=gates=>({id:'t',name:'t',body:'elune',vehicle:'podracer',mode:'p2p',laps:1,start:{pos:[0,10,0],yaw:0},gates});
const sample=()=>moon([gate(0,-100),gate(0,-200),gate(300,0,'azeroth'),gate(300,-120,'azeroth')]);

test('legs: one leg per run of gates on a body, start counted in leg 0', () => {
  assert.deepEqual(legs(sample()),[{body:'elune',first:0,last:1,count:2},{body:'azeroth',first:2,last:3,count:2}]);
  assert.deepEqual(legs(moon([gate(0,-100)])),[{body:'elune',first:0,last:0,count:1}]);
});

test('legs: a track whose first gate is already on the other body has an empty start leg', () => {
  const l=legs(moon([gate(0,-100,'azeroth')]));
  assert.equal(l[0].count,0);assert.equal(l[1].body,'azeroth');
});

test('transitions point at the first gate after each jump, and gatesOn splits by body', () => {
  const t=sample();
  assert.deepEqual(transitions(t),[{at:2,from:'elune',to:'azeroth'}]);
  assert.deepEqual(gatesOn(t,'elune'),[0,1]);assert.deepEqual(gatesOn(t,'azeroth'),[2,3]);
  t.gates.push(gate(0,-400));
  assert.deepEqual(transitions(t).map(x=>x.to),['azeroth','elune']);
});

test('checkTrack accepts a clean Elune -> Azeroth track', () => {
  const r=checkTrack(sample());
  assert.deepEqual(r.errors,[]);assert.deepEqual(r.warnings,[]);
});

test('checkTrack rejects empty tracks, laps across a jump, and empty legs', () => {
  assert.match(checkTrack(moon([])).errors[0],/at least one gate/);
  assert.ok(checkTrack({...sample(),mode:'lap'}).errors.some(e=>/point to point/.test(e)));
  assert.ok(checkTrack(moon([gate(0,-100,'azeroth')])).errors.some(e=>/Leg 1 \(Elune\) has no gates/.test(e)));
});

test('checkTrack rejects unknown bodies', () => {
  assert.ok(checkTrack(moon([gate(0,-100,'mars')])).errors.some(e=>/unknown body "mars"/.test(e)));
});

test('checkTrack: spacing is judged per frame, never across a jump', () => {
  // Gate 3 sits at the same numbers as gate 2 but on another body: not a spacing error.
  assert.deepEqual(checkTrack(moon([gate(0,-100),gate(0,-200,'azeroth')])).errors,[]);
  const close=checkTrack(moon([gate(0,-100),gate(0,-105)]));
  assert.ok(close.errors.some(e=>/Gate 2 is only 5\.0 yd from gate 1/.test(e)&&e.includes(String(MIN_GATE_GAP))));
  assert.ok(checkTrack(moon([gate(0,-5)])).errors.some(e=>/from the start/.test(e)));
  assert.ok(checkTrack(moon([gate(0,-100),gate(0,-120)])).warnings.some(w=>/close to gate 1/.test(w)));
});

test('checkTrack: a first gate on another body is not spacing-checked against the start', () => {
  const t=moon([gate(1,-100,'azeroth'),gate(1,-200,'azeroth')]);
  t.start.pos=[1,10,-100];
  assert.ok(!checkTrack(t).errors.some(e=>/yd from/.test(e)));
});

test('checkTrack flags gates and starts below the sampled ground, per gate', () => {
  const t=sample(),surf=[{ground:0,water:null},{ground:0},{ground:50},undefined,{ground:0}];
  const r=checkTrack(t,surf);
  assert.equal(r.errors.length,1);assert.match(r.errors[0],/Gate 2 is 40 yd inside the ground on Elune/);
  assert.match(checkTrack(t,[{ground:100}]).errors[0],/start is inside the ground/);
});

test('every shipped track passes validation and the authoring checks without errors', () => {
  for(const f of readdirSync(new URL('./tracks/',import.meta.url)).filter(n=>n.endsWith('.json'))){
    const t=validateTrack(JSON.parse(readFileSync(new URL('./tracks/'+f,import.meta.url),'utf8')));
    assert.deepEqual(checkTrack(t).errors,[],f);
  }
});

test('a drafted cross-body track round-trips through toTrack with per-gate bodies', () => {
  const d=TrackDraft.blank([0,10,0],0,'elune');
  d.addGate([0,10,-100],undefined,'elune');d.addGate([0,10,-200],undefined,'elune');
  d.addGate([300,10,0],undefined,'azeroth');d.addGate([300,10,-150],undefined,'azeroth');
  const t=JSON.parse(JSON.stringify(d.toTrack()));
  assert.deepEqual(t.gates.map(g=>g.body),[undefined,undefined,'azeroth','azeroth']);
  assert.equal(t.mode,'p2p');
  assert.deepEqual(validateTrack(t).gates.map(g=>g.body),[undefined,undefined,'azeroth','azeroth']);
  assert.deepEqual(checkTrack(t).errors,[]);
});
