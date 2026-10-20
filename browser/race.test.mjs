import test from 'node:test';
import assert from 'node:assert/strict';
import {Race,crossesGate,breakoffDistance,validateTrack,BREAKOFF_MARGIN} from './race.js';

// Gates face -z (yaw 0), spaced 100 yd apart northward.
const gate=z=>({pos:[0,0,z],yaw:0,width:40});
const track={id:'t',start:{pos:[0,0,50],yaw:0},gates:[gate(-50),gate(-150)],mode:'p2p'};
const drive=(race,zs,t0=10,x=0)=>{const ev=[];zs.forEach((z,i)=>ev.push(race.update([x,0,z],t0+i)));return ev;};
const run=r=>{r.start(0);r.lined(0);r.update([0,0,50],3);};

test('gate crossing needs forward direction, width and height',()=>{
  const g=gate(-50);
  assert.ok(crossesGate(g,[0,0,-40],[0,0,-60]));
  assert.ok(!crossesGate(g,[0,0,-60],[0,0,-40]));
  assert.ok(!crossesGate(g,[30,0,-40],[30,0,-60]));
  assert.ok(!crossesGate(g,[0,500,-40],[0,500,-60]));
  assert.ok(crossesGate({...g,yaw:Math.PI/2},[0,0,-50].map((v,i)=>i===0?v+10:v),[-10,0,-50]));
});
test('breakoff is max pairwise distance plus margin unless overridden',()=>{
  assert.equal(breakoffDistance(validateTrack(track)),200+BREAKOFF_MARGIN);
  assert.equal(breakoffDistance({...track,breakoff:900}),900);
});
test('state machine runs idle -> lineup -> countdown -> running -> finished',()=>{
  const r=new Race(track);assert.equal(r.state,'idle');
  r.start(0);assert.equal(r.state,'lineup');
  r.lined(1);assert.equal(r.state,'countdown');assert.equal(r.countdown(2),2);
  assert.equal(r.update([0,0,50],3),null);assert.equal(r.update([0,0,50],4),'go');assert.equal(r.state,'running');
  assert.deepEqual(drive(r,[-40,-60],5),[null,'gate']);
  assert.equal(r.nextGate.pos[2],-150);
  assert.deepEqual(drive(r,[-140,-160],8),[null,'finish']);
  assert.equal(r.state,'finished');assert.equal(r.time,r.splits[1]);assert.equal(r.splits.length,2);
});
test('gates must be crossed in order',()=>{
  const r=new Race(track);run(r);
  r.update([100,0,50],5);r.update([100,0,-100],6);r.update([0,0,-100],7);
  assert.equal(r.update([0,0,-160],8),null);
  assert.equal(r.next,0);
});
test('laps loop the gate list and finish after the last gate of the last lap',()=>{
  const r=new Race({...track,mode:'lap',laps:2,gates:[gate(-50)]});
  r.start(0);r.lined(0);r.update([0,0,50],3);
  assert.equal(r.update([0,0,-40],4),null);assert.equal(r.update([0,0,-60],5),'gate');
  assert.equal(r.state,'running');assert.equal(r.lap,2);
  r.update([0,0,-40],6);assert.equal(r.update([0,0,-60],7),'finish');
});
test('far from the whole course cancels without a time',()=>{
  const r=new Race(track);run(r);r.update([0,0,50],4);
  assert.equal(r.update([5000,0,50],5),null);
  assert.equal(r.state,'cancelled');assert.equal(r.reason,'breakoff');assert.equal(r.time,null);
});
test('cancel keeps no result and finished races ignore cancel',()=>{
  const r=new Race(track);run(r);r.cancel('abandon');assert.equal(r.state,'cancelled');
  const f=new Race({...track,gates:[gate(-50)]});run(f);f.update([0,0,-40],4);f.update([0,0,-60],5);
  f.cancel();assert.equal(f.state,'finished');
});
test('invalid tracks are rejected',()=>{
  assert.throws(()=>validateTrack({...track,gates:[]}));
  assert.throws(()=>validateTrack({...track,gates:[{pos:[0,0,0],yaw:0,width:0}]}));
  assert.throws(()=>validateTrack({...track,id:'Bad Id'}));
  assert.throws(()=>validateTrack({...track,mode:'p2p',laps:2}));
});
