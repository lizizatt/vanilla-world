import test from 'node:test';
import assert from 'node:assert/strict';
import {Race} from './race.js';
import {gateScene,lightPhase,sceneKey,sceneProps,START_AHEAD,startLine} from './race-gates.js';

const mk=id=>({id,start:{pos:[100,5,200],yaw:0},gates:[0,1,2].map(i=>({pos:[100,5,200-100*(i+1)],yaw:0,width:40})),mode:'p2p',laps:1,vehicle:'podracer'});
const kinds=l=>l.map(d=>d.id);

test('free-roam shows a label per track; none are gantries or gates', () => {
  assert.deepEqual(kinds(gateScene([mk('a'),mk('b')],undefined)),['L:a','L:b']);
});

test('start lights follow the countdown: off, red, amber, green on GO', () => {
  const r=new Race(mk('a'));r.start(0);
  assert.equal(lightPhase(r,0),0);
  r.lined(0);
  assert.deepEqual([0,.5,1.2,1.9,2.5].map(t=>lightPhase(r,t)),[1,1,2,2,2]);
  assert.equal(r.update([100,5,200],3),'go');
  assert.equal(lightPhase(r,3),3);
});

test('racing hides that track label, stands the gantry ahead of the line and shows next/passed gates only', () => {
  const r=new Race(mk('a'));r.start(0);r.lined(0);
  let l=gateScene([mk('a'),mk('b')],r,0);
  assert.deepEqual(kinds(l),['L:b','A:start']);
  assert.ok(Math.abs(l[1].at[2]-(200-START_AHEAD))<1e-9);
  r.update([100,5,200],3);
  assert.deepEqual(kinds(gateScene([mk('a')],r,3)),['A:start','C:next']);
  r.update([100,5,120],3.1);r.update([100,5,80],3.2);
  assert.equal(r.next,1);
  l=gateScene([mk('a')],r,3.3);
  assert.deepEqual(kinds(l),['A:start','C:next','C:passed']);
  assert.deepEqual(l.find(d=>d.id==='C:next').at,r.track.gates[1].pos);
  assert.deepEqual(l.find(d=>d.id==='C:passed').at,r.track.gates[0].pos);
});

test('the last gate becomes the chequered finish gantry; a finished or cancelled race returns the label', () => {
  const r=new Race(mk('a'));r.start(0);r.lined(0);r.update([100,5,200],3);
  r.next=2;
  assert.ok(gateScene([mk('a')],r,4).some(d=>d.id==='A:finish'&&d.phase===3&&!gateScene([mk('a')],r,4).some(e=>e.id==='C:next')));
  r.cancel();
  assert.deepEqual(kinds(gateScene([mk('a')],r,4)),['L:a']);
});

test('scene keys change only with visible state and props build (hosted fallback without a kit)', () => {
  const r=new Race(mk('a'));r.start(0);r.lined(0);
  const a=sceneKey(gateScene([mk('a')],r,0.1)),b=sceneKey(gateScene([mk('a')],r,0.2)),c=sceneKey(gateScene([mk('a')],r,1.5));
  assert.equal(a,b);assert.notEqual(a,c);
  const props=sceneProps(gateScene([mk('a'),mk('b')],r,0),undefined);
  assert.ok(props.length>=2&&props.every(p=>p.asset.indices.length>0));
});

test('circuit: the gantry and finish share the line and the grid sits behind it; p2p: gantry ahead of grid, finish at last gate', () => {
  const p2p=mk('a'),circuit={...mk('c'),mode:'lap',gates:[{pos:[100,5,100],yaw:0,width:40},{pos:[100,5,200.5],yaw:0,width:40}]};
  let s=startLine(p2p);
  assert.equal(s.circuit,false);assert.equal(s.at[2],200-START_AHEAD);assert.deepEqual(s.grid,[100,5,200]);
  s=startLine(circuit);
  assert.equal(s.circuit,true);assert.deepEqual(s.at,[100,5,200.5]);
  assert.ok(Math.abs(s.grid[2]-(200.5+START_AHEAD))<1e-9);
  const r=new Race(circuit);r.start(0);r.lined(0);
  assert.deepEqual(gateScene([circuit],r,0).find(d=>d.id==='A:start').at,circuit.gates[1].pos);
});
