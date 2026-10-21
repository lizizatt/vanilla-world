import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackDraft,project,unproject,yawToward,slug} from './track-edit.js';
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
