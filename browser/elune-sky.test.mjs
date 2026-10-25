import test from 'node:test';
import assert from 'node:assert/strict';
import {eluneSkyAt,AIRLESS_SKY} from './elune-sky.js';

test('sun and Azeroth are unit local directions; daylight is a sharp 0..1', () => {
  const s=eluneSkyAt(0,0,1000);
  assert.ok(Math.abs(Math.hypot(...s.sun)-1)<1e-9);
  assert.ok(Math.abs(Math.hypot(...s.azeroth)-1)<1e-9);
  assert.ok(s.daylight>=0&&s.daylight<=1);
  assert.deepEqual(AIRLESS_SKY,[0,0,0]);
});
test('Azeroth hangs at the zenith over the sub-Azeroth point and is fixed in the sky there', () => {
  for(const t of [0,500,2000]) assert.ok(eluneSkyAt(0,0,t).azeroth[1]>.999);
});
test('over a synodic day (3600 units) the sun at a point rises and sets', () => {
  let min=1,max=0;for(let t=0;t<3600;t+=60){const d=eluneSkyAt(2000,500,t).daylight;min=Math.min(min,d);max=Math.max(max,d);}
  assert.ok(min===0&&max===1,`${min} ${max}`);
});
test('far side of the moon never sees Azeroth', () => {
  const x=Math.PI*5093;// lon 180
  assert.ok(eluneSkyAt(x,0,100).azeroth[1]<-.999);
});
