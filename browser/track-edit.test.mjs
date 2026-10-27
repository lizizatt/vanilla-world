import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackDraft,project,unproject,yawToward,slug,uniqueId,gateY,clampTrack,CLEAR_MAX,CLEAR_MIN} from './track-edit.js';
import {Race,crossesGate} from './race.js';

test('new gates face along the course and undo restores the previous state',()=>{
  const d=TrackDraft.blank([0,0,0],0);
  d.addGate([0,0,-100]);d.addGate([100,0,-100]);
  assert.ok(Math.abs(d.gates[0].yaw)<1e-9);
  assert.ok(Math.abs(d.gates[1].yaw-yawToward([0,0,-100],[100,0,-100]))<1e-9);
  const rev=d.revision;
  assert.ok(d.deleteGate(0));assert.equal(d.gates.length,1);
  assert.ok(d.undo());assert.equal(d.gates.length,2);assert.ok(d.revision>rev);
  while(d.undo());assert.equal(d.gates.length,0);
});
test('a drafted gate is crossed by driving along the course',()=>{
  const d=TrackDraft.blank([0,0,0]);d.addGate([0,0,-100]);
  assert.ok(crossesGate(d.gates[0],[0,0,-90],[0,0,-110]));
});
test('toTrack validates, slugs the name, forces one lap for p2p and exposes auto breakoff',()=>{
  const d=TrackDraft.blank([0,0,0]);
  assert.throws(()=>d.toTrack());
  d.addGate([0,0,-300]);d.setMeta({name:'My Cool Track!',mode:'p2p',laps:3});
  const t=d.toTrack();assert.equal(t.id,'my-cool-track');assert.equal(t.laps,1);
  assert.equal(d.breakoff(),800);
  assert.ok(new Race(t));
});
test('width is clamped and slug strips punctuation',()=>{
  const d=TrackDraft.blank([0,0,0]);d.addGate([0,0,-9]);d.setWidth(0,5);assert.equal(d.gates[0].width,20);
  d.setWidth(0,999);assert.equal(d.gates[0].width,200);assert.equal(slug(' A--b c '),'a-b-c');
});
test('unproject inverts project on the ground plane for a tilted camera',()=>{
  const view={eye:[10,300,20],look:[0,-Math.SQRT1_2,-Math.SQRT1_2],right:[1,0,0],up:[0,Math.SQRT1_2,-Math.SQRT1_2],aspect:1.5};
  const p=[40,0,-150],s=project(view,1200,800,p);
  const q=unproject(view,1200,800,s[0],s[1],0);
  assert.ok(Math.hypot(q[0]-p[0],q[2]-p[2])<1e-6);
  assert.equal(project(view,1200,800,[10,300,200]),undefined);
});

test('draft carries the vehicle class into the validated track',()=>{
  const d=TrackDraft.blank([0,0,0]);d.addGate([0,0,-300]);d.setMeta({name:'Air',vehicle:'podracer'});
  assert.equal(d.toTrack().vehicle,'podracer');assert.equal(d.preview().vehicle,'podracer');
  d.undo();assert.equal(d.vehicle,'podracer');
});

test('new tracks get a permanent unique id that never collides with shipped or saved tracks',()=>{
  assert.equal(uniqueId('Steamwheedle',['steamwheedle']),'steamwheedle-2');
  assert.equal(uniqueId('Steamwheedle',['steamwheedle','steamwheedle-2']),'steamwheedle-3');
  assert.equal(uniqueId('!!!',[]),'track');
  assert.equal(uniqueId('New track',[]),'new-track-2');
  const taken=['steamwheedle'],d=TrackDraft.blank([0,0,0]);
  d.addGate([0,0,-50]);d.setMeta({name:'Steamwheedle'});
  assert.equal(d.assignId(taken),'steamwheedle-2');
  d.setMeta({name:'Totally renamed'});
  assert.equal(d.toTrack().id,'steamwheedle-2');
  assert.equal(d.assignId([...taken,'steamwheedle-2']),'steamwheedle-2');
  const e=TrackDraft.blank([0,0,0]);e.addGate([0,0,-50]);e.setMeta({name:'Second'});
  assert.notEqual(e.assignId([...taken,d.id]),d.id);
});
test('editor flow: second new track never overwrites the first; list helpers keep both',()=>{
  const list=[{id:'steamwheedle'}],ids=()=>list.map(t=>t.id);
  const make=name=>{const d=TrackDraft.blank([0,0,0]);d.addGate([0,0,-50]);d.setMeta({name});d.assignId(ids());return d.toTrack();};
  const a=make('Mine');list.push(a);const b=make('Mine');list.push(b);
  assert.deepEqual(ids(),['steamwheedle','mine','mine-2']);
});
test('gate heights sit above ground and water within a bounded clearance',()=>{
  assert.equal(gateY(0,{ground:100,water:NaN}),105);
  assert.equal(gateY(9999,{ground:100,water:NaN}),100+CLEAR_MAX);
  assert.equal(gateY(120,{ground:100,water:NaN}),120);
  assert.equal(gateY(10,{ground:-50,water:20}),20+CLEAR_MIN);
  assert.equal(gateY(77,{ground:NaN,water:NaN}),77);
  assert.equal(gateY(77,undefined),77);
});
test('clampTrack fixes stale heights from the current ground and leaves unknown points alone',()=>{
  const t={id:'x',start:{pos:[0,-500,0],yaw:0},gates:[{pos:[0,-500,-10],yaw:0,width:70},{pos:[0,40,-20],yaw:0,width:70},{pos:[0,3000,-30],yaw:0,width:70}]};
  const o=clampTrack(t,[{ground:10},{ground:10},{ground:NaN},{ground:10}]);
  assert.equal(o.start.pos[1],10);
  assert.equal(o.gates[0].pos[1],15);
  assert.equal(o.gates[1].pos[1],40);
  assert.equal(o.gates[2].pos[1],10+CLEAR_MAX);
  assert.equal(t.gates[0].pos[1],-500);
  assert.ok(new Race(o));
});
test('setGateHeight and undo round-trip the height',()=>{
  const d=TrackDraft.blank([0,0,0]);d.addGate([0,0,-50]);d.checkpoint();d.setGateHeight(0,77);
  assert.equal(d.gates[0].pos[1],77);assert.ok(d.undo());assert.equal(d.gates[0].pos[1],0);
});
test('loading another track resets history so undo cannot resurrect old gates',()=>{
  const d=TrackDraft.blank([0,0,0]);d.addGate([0,0,-50]);d.addGate([0,0,-90]);
  d.load({id:'b',name:'B',start:{pos:[5,0,5],yaw:0},gates:[]});
  assert.equal(d.undo(),false);assert.equal(d.gates.length,0);
});

test('drafts keep their body: moon tracks stay on the moon, Azeroth tracks stay unstamped',()=>{
  const moon=TrackDraft.blank([1,2,3],0,'elune');moon.addGate([1,2,-40]);
  assert.equal(moon.toTrack().body,'elune');
  assert.equal(new TrackDraft(JSON.parse(JSON.stringify(moon.toTrack()))).toTrack().body,'elune');
  assert.notEqual(moon.state(),TrackDraft.blank([1,2,3],0).state());
  const az=TrackDraft.blank([1,2,3],0);az.addGate([1,2,-40]);
  assert.equal('body' in az.toTrack(),false);
});
