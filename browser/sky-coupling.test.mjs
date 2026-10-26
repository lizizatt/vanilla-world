import test from 'node:test';
import assert from 'node:assert/strict';
import {sunInertial,sunInBody,daylightFor,litFraction,earthshine,ambientFor,warpClamp} from './sky-coupling.js';
import {AZEROTH,ELUNE} from './bodies.js';
import {daylightAt} from './sim-clock.js';

test('inertial sun is a unit vector and matches the legacy sun at Azeroth chart origin', () => {
  for(const t of [0,720,1440,2000]) {
    const s=sunInertial(t);assert.ok(Math.abs(Math.hypot(...s)-1)<1e-12);
  }
  // noon: sun overhead at lon 0 (+X) with the legacy southward lean (-Y)
  const n=sunInertial(1440);assert.ok(n[0]>.9&&n[1]<0);
});

test('Azeroth daylight is exactly the existing curve', () => {
  for(const t of [0,500,1440,2700])assert.equal(daylightFor(AZEROTH,t,[1,0,0]),daylightAt(t));
});

test('Elune daylight: sharp terminator, follows the true sun', () => {
  const t=1440,s=sunInBody(ELUNE,t),up=s,down=s.map(v=>-v);
  assert.equal(daylightFor(ELUNE,t,up),1);
  assert.equal(daylightFor(ELUNE,t,down),0);
  const side=[s[1],-s[0],0],n=Math.hypot(...side);
  assert.ok(daylightFor(ELUNE,t,side.map(v=>v/n))>0&&daylightFor(ELUNE,t,side.map(v=>v/n))<1);
});

test('Elune sees the sun move over time (tidal lock, so the sky rotates)', () => {
  const a=sunInBody(ELUNE,0),b=sunInBody(ELUNE,1440);
  assert.ok(Math.hypot(...a.map((v,i)=>v-b[i]))>.1);
  assert.ok(Math.abs(Math.hypot(...b)-1)<1e-9);
});

test('phase: lit fractions are complementary-ish and in range', () => {
  for(const t of [0,1000,5000,12000]) {
    const f=litFraction(ELUNE,AZEROTH,t),g=litFraction(AZEROTH,ELUNE,t);
    assert.ok(f>=0&&f<=1&&g>=0&&g<=1);
  }
  // viewed from opposite ends of the line between them, lit fractions sum to 1
  const t=777;assert.ok(Math.abs(litFraction(ELUNE,AZEROTH,t)+litFraction(AZEROTH,ELUNE,t)-1)<1e-12);
});

test('earthshine and ambient floors', () => {
  for(const t of [0,3000,9000]){const e=earthshine(t);assert.ok(e>=.02&&e<=.07);}
  assert.equal(ambientFor(AZEROTH,0),null);
  assert.ok(ambientFor(ELUNE,0)>.03);
});

test('warp is unrestricted in fly mode at any altitude and 1x otherwise', () => {
  for(const alt of [0,100,5000,5e4,1e6])assert.equal(warpClamp(alt),1000);
  assert.equal(warpClamp(100,undefined,false),1);
});

test('Elune synodic day is 1.25 Azeroth days (3600 units = 30 min at 1x)', () => {
  let prev=null;const up=[];
  for(let t=0;t<20000;t++){const v=sunInBody(ELUNE,t)[2];if(prev!==null&&prev<0&&v>=0)up.push(t);prev=v;}
  assert.ok(up.length>=4);
  for(let i=1;i<up.length;i++)assert.ok(Math.abs(up[i]-up[i-1]-3600)<=1);
});
