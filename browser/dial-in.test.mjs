import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {TrackDraft} from './track-edit.js';
import {DialSession,OrbitCamera,DIST_MIN,DIST_MAX} from './dial-in.js';

const draft=()=>{
  const d=TrackDraft.blank([0,0,0],0);
  d.addGate([0,5,-100]);d.addGate([50,6,-200]);d.addGate([100,7,-300]);
  return d;
};

test('stepping wraps and labels the gate',()=>{
  const s=new DialSession(draft(),0);
  assert.equal(s.label,'Gate 1 / 3');
  s.step(-1);assert.equal(s.label,'Gate 3 / 3');
  s.step(1);s.step(1);assert.equal(s.label,'Gate 2 / 3');
  assert.equal(s.prevGate(),s.draft.gates[0]);assert.equal(s.nextGate(),s.draft.gates[2]);
});
test('edits undo and redo over many steps, per gate',()=>{
  const s=new DialSession(draft(),0);
  s.setPos(1,2,3);s.end();s.step(1);s.setWidth(120);s.end();s.setYaw(1);s.end();
  assert.deepEqual(s.draft.gates[0].pos,[1,2,3]);
  assert.ok(s.undo());assert.equal(s.gate.yaw,s.originals[1].yaw);assert.equal(s.gate.width,120);
  assert.ok(s.undo());assert.equal(s.gate.width,70);
  assert.ok(s.undo());assert.equal(s.index,0);assert.deepEqual(s.gate.pos,[0,5,-100]);
  assert.equal(s.undo(),false);
  assert.ok(s.redo());assert.deepEqual(s.gate.pos,[1,2,3]);
  s.setWidth(90);s.end();assert.equal(s.redo(),false);
});
test('a drag is one undo step and an unchanged gesture leaves none',()=>{
  const s=new DialSession(draft(),1);
  s.begin();for(let i=1;i<=10;i++)s.setPos(50+i,6,-200);s.end();
  assert.equal(s.undoStack.length,1);
  s.begin();s.end();assert.equal(s.undoStack.length,1);
  s.undo();assert.deepEqual(s.gate.pos,[50,6,-200]);
});
test('width is clamped, bad numbers ignored, reset restores the entry state',()=>{
  const s=new DialSession(draft(),0);
  s.setWidth(5);assert.equal(s.gate.width,20);s.setWidth(9999);assert.equal(s.gate.width,200);s.end();
  s.setWidth(NaN);s.setPos(NaN,0,0);assert.equal(s.gate.width,200);
  s.setPos(9,9,9);s.end();
  assert.ok(s.resetGate());assert.deepEqual(s.gate.pos,[0,5,-100]);assert.equal(s.gate.width,70);
  assert.equal(s.resetGate(),false);
  assert.ok(s.undo());assert.deepEqual(s.gate.pos,[9,9,9]);
});
test('cancel restores every gate and other tracks are untouched; done keeps a valid track',()=>{
  const d=draft(),other=JSON.stringify({id:'other',gates:[{pos:[1,1,1]}]}),before=JSON.stringify(d.gates);
  const s=new DialSession(d,0);
  s.setPos(5,5,5);s.end();s.step(2);s.setWidth(150);s.end();
  assert.ok(s.dirty);assert.ok(d.toTrack());
  const rev=d.revision;s.cancel();
  assert.equal(JSON.stringify(d.gates),before);assert.ok(d.revision>rev);assert.equal(other,JSON.stringify({id:'other',gates:[{pos:[1,1,1]}]}));
});
test('done is one map-level undo step back to the pre-dial gates',()=>{
  const d=draft(),entry=JSON.stringify(d.gates),s=new DialSession(d,0);
  s.setPos(5,5,5);s.end();s.setWidth(150);s.end();
  d.checkpointGates(JSON.parse(s.entry));
  assert.ok(d.undo());assert.equal(JSON.stringify(d.gates),entry);
});
test('orbit camera clamps zoom and pitch and looks at its target',()=>{
  const c=new OrbitCamera();c.focus([10,20,30],true);
  for(let i=0;i<100;i++)c.zoom(1);assert.equal(c.dist,DIST_MAX);
  for(let i=0;i<100;i++)c.zoom(-1);assert.equal(c.dist,DIST_MIN);
  c.orbit(0,-1e6);assert.ok(c.pitch<0);c.orbit(0,1e6);assert.ok(c.pitch>=-1.5);
  c.yaw=.7;c.pitch=-.5;c.dist=100;
  const [x,y,z,yaw,pitch]=c.pose(),look=[-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)];
  assert.ok(Math.hypot(x+look[0]*100-10,y+look[1]*100-20,z+look[2]*100-30)<1e-9);
  c.focus([0,0,0]);for(let i=0;i<200;i++)c.update(.05);assert.ok(Math.hypot(...c.target)<1e-6);
});
test('panning follows the pointer on the ground plane',()=>{
  const c=new OrbitCamera();c.yaw=0;c.focus([0,0,0],true);
  c.pan(100,0,1000);assert.ok(c.target[0]<0&&Math.abs(c.target[2])<1e-9);
  c.pan(0,100,1000);assert.ok(c.target[2]<0);
});
const fixture=new URL('./dial-in.fixture.json',import.meta.url);
test('a real exported race (Orgrimmar) dials through every gate and stays valid',{skip:!existsSync(fixture)},()=>{
  const d=new TrackDraft(JSON.parse(readFileSync(fixture,'utf8'))),s=new DialSession(d,0);
  for(let i=0;i<d.gates.length;i++){s.setPos(...s.gate.pos.map(v=>v+1));s.end();s.step(1);}
  assert.ok(d.toTrack());
  while(s.undo());assert.equal(JSON.stringify(d.gates),s.entry);
});
