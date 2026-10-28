import test from 'node:test';
import assert from 'node:assert/strict';
import {spaceReadout} from './space-hud.js';
import {createFlight} from './space-flight.js';
import {AZEROTH,ELUNE,centreAt} from './bodies.js';

test('readout names nearest body, altitude, speed and the parent well',()=>{
  const t=1440,c=centreAt(AZEROTH,t),s=createFlight([c[0]+AZEROTH.radius+1200,c[1],c[2]],t);
  const r=spaceReadout(s,t);
  assert.equal(r.nearest,'azeroth');assert.equal(r.parent,'azeroth');
  assert.ok(Math.abs(r.altitude-1200)<1e-6);assert.equal(r.speed,1200);
  assert.match(r.label,/^AZEROTH 1\.2k yd · 1\.2k yd\/s · WELL AZEROTH$/);
  assert.equal(spaceReadout(s,t,true).speed,8000);
});
test('near Elune the nearest body is Elune',()=>{
  const t=1440,c=centreAt(ELUNE,t),s=createFlight([c[0]+ELUNE.radius+500,c[1],c[2]],t,'elune');
  assert.equal(spaceReadout(s,t).nearest,'elune');
});

import {readoutVisible as _rv} from './space-hud.js';import {AZEROTH as _A} from './bodies.js';
test('readout hides in space with hysteresis',()=>{const e=_A.ranges.space[1];assert.equal(_rv(5,_A),false);assert.equal(_rv(e-1,_A,true),true);assert.equal(_rv(e,_A,true),false);assert.equal(_rv(e*.97,_A,false),false);assert.equal(_rv(e*.9,_A,false),true);});
