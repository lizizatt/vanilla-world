import test from 'node:test';
import assert from 'node:assert/strict';
import {SimClock,simDelta,wrapTime,sanitiseScale,daylightAt,DAY_PERIOD,NOON,TIME_SCALES} from './sim-clock.js';
import {sunDirection} from './clouds.js';
import {sunShadow} from './shadow.js';

test('scale converts real seconds to sim minutes and pause freezes', () => {
  assert.equal(simDelta(1,60),1);
  const c=new SimClock(NOON,100);c.step(0.6);assert.ok(Math.abs(c.dt-1)<1e-9);assert.ok(Math.abs(c.now()-(NOON+1))<1e-9);
  c.scale=0;const t=c.now();c.step(5);assert.equal(c.now(),t);assert.equal(c.dt,0);
});
test('time wraps over the period and bad scales fall back', () => {
  assert.equal(wrapTime(-1),DAY_PERIOD-1);assert.equal(wrapTime(DAY_PERIOD+5),5);
  assert.equal(sanitiseScale('abc'),1);assert.equal(sanitiseScale(7),1);
  for(const s of TIME_SCALES)assert.equal(sanitiseScale(s),s);
  const c=new SimClock(DAY_PERIOD-1,1000);c.step(1);assert.ok(c.now()>=0&&c.now()<DAY_PERIOD);
});
test('easeTo reaches the target then free-runs', () => {
  const c=new SimClock(NOON,1);c.easeTo(0);let n=0;
  while(c.target!==undefined&&n++<1000)c.step(1/60);
  assert.equal(c.now(),0);assert.ok(n<200);c.step(60);assert.ok(c.now()>0);
});
test('sun is overhead at noon, below the horizon at midnight, and moves continuously', () => {
  assert.ok(sunDirection(NOON)[1]>.9);assert.ok(sunDirection(0)[1]<-.9);
  assert.ok(Math.abs(daylightAt(NOON)-1)<1e-9);assert.ok(daylightAt(0)<1e-9);
  let prev=sunDirection(0);
  for(let t=1;t<=DAY_PERIOD;t++){const s=sunDirection(t);assert.ok(Math.hypot(s[0]-prev[0],s[1]-prev[1],s[2]-prev[2])<.01);prev=s;}
  for(const t of [100,700,1440,2000])assert.ok(daylightAt(t)>=0&&daylightAt(t)<=1);
});
test('shadow follows the sun and vanishes at night', () => {
  assert.ok(sunShadow(sunDirection(NOON)).strength>0);
  assert.equal(sunShadow(sunDirection(0)).strength,0);
});
