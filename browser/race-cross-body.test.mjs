import test from 'node:test';
import assert from 'node:assert/strict';
import {Race,validateTrack,breakoffDistance,gateBody,spansBodies} from './race.js';
import {gateScene,startLine} from './race-gates.js';
import {TrackDraft} from './track-edit.js';
import {formatTrack} from './track-normalize.js';
import {tracksFor} from './vehicles.js';

// Starts on Elune, gate 1 on Elune, gate 2 (finish) on Azeroth; frames are unrelated so the same numbers mean different places.
const track=()=>({id:'moon-to-home',name:'Moon to home',body:'elune',vehicle:'podracer',mode:'p2p',laps:1,
  start:{pos:[0,10,200],yaw:0},
  gates:[{pos:[0,10,0],yaw:0,width:60},{pos:[5000,30,-9000],yaw:0,width:200,body:'azeroth'}]});

test('per-gate body validates and round-trips through the saved track format',()=>{
  const t=validateTrack(track());
  assert.equal(gateBody(t,t.gates[0]),'elune');assert.equal(gateBody(t,t.gates[1]),'azeroth');assert.ok(spansBodies(t));
  assert.deepEqual(validateTrack(JSON.parse(formatTrack(t))),t);
  assert.throws(()=>validateTrack({...track(),gates:[{...track().gates[0],body:'No Body'}]}),/gate body/);
  assert.ok(!spansBodies(validateTrack({...track(),gates:[track().gates[0]]})));
});

test('a multi-body track never breaks off unless it sets breakoff',()=>{
  assert.equal(breakoffDistance(track()),Infinity);
  assert.equal(breakoffDistance({...track(),breakoff:700}),700);
});

test('gates count across the body handoff; only the active body\'s gates are crossed',()=>{
  const r=new Race(track());r.start(0);r.lined(0);
  assert.equal(r.update([0,10,200],3,'elune'),'go');
  assert.equal(r.update([0,10,100],3.5,'elune'),null);
  assert.equal(r.update([0,10,-20],4,'elune'),'gate');
  assert.equal(r.next,1);assert.equal(r.nextGate,r.track.gates[1]);
  // Far above Elune on the way out: nothing near any gate, still racing.
  assert.equal(r.update([0,90000,-4000],9,'elune'),null);assert.equal(r.state,'running');
  // Mid-swap the telemetry is stale: ignored even if it sits exactly on the Azeroth gate.
  assert.equal(r.update([5000,30,-8990],10,null),null);assert.equal(r.next,1);
  // The first Azeroth sample is not swept from the last Elune one, and the Elune frame cannot trigger the Azeroth gate.
  assert.equal(r.update([5000,30,-8900],11,'azeroth'),null);
  assert.equal(r.update([0,10,-4],11.5,'elune'),null);
  assert.equal(r.update([5000,30,-8900],12,'azeroth'),null);
  assert.equal(r.update([5000,30,-9100],13,'azeroth'),'finish');
  assert.equal(r.state,'finished');assert.equal(r.splits.length,2);assert.ok(r.time>8&&r.time<10);
});

test('a track on one body behaves as before when the body is passed',()=>{
  const t={id:'flat',body:'elune',start:{pos:[0,0,50],yaw:0},gates:[{pos:[0,0,0],yaw:0,width:40}]};
  const r=new Race(t);r.start(0);r.lined(0);r.update([0,0,50],3,'elune');
  assert.equal(r.update([0,0,-10],3.1,'elune'),'finish');
});

test('breakoff only measures course points in the craft\'s own frame',()=>{
  const r=new Race({...track(),breakoff:600});r.start(0);r.lined(0);r.update([0,10,200],3,'elune');
  assert.equal(r.update([0,10,-20],4,'elune'),'gate');
  assert.equal(r.update([5000,30,-8900],5,'azeroth'),null);assert.equal(r.state,'running');
  assert.equal(r.update([9e6,0,0],6,'azeroth'),null);assert.equal(r.state,'cancelled');
});

test('gate scene shows only the props standing on the active body',()=>{
  const t=validateTrack(track()),r=new Race(t);r.start(0);r.lined(0);r.update([0,10,200],3,'elune');
  const ids=b=>gateScene([],r,3.1,200,b).map(d=>d.id).sort();
  assert.deepEqual(ids('elune'),['A:start','C:next']);
  assert.deepEqual(ids('azeroth'),[]);
  r.update([0,10,-20],4,'elune');
  assert.deepEqual(ids('elune'),['A:start','C:passed']);
  assert.deepEqual(ids('azeroth'),['A:finish']);
  assert.ok(!startLine(t).circuit);
});

test('tracks are listed on their start body and the editor draft keeps per-gate bodies',()=>{
  const t=validateTrack(track());
  assert.equal(tracksFor([t],'podracer','elune').length,1);assert.equal(tracksFor([t],'podracer','azeroth').length,0);
  const d=new TrackDraft(t);
  assert.equal(d.gates[1].body,'azeroth');assert.equal(d.toTrack().gates[1].body,'azeroth');
  d.addGate([1,2,3],0,'elune');d.addGate([1,2,3],0,'azeroth');
  assert.equal(d.gates[2].body,undefined);assert.equal(d.gates[3].body,'azeroth');
});
