import test from 'node:test';
import assert from 'node:assert/strict';
import {ELUNE,AZEROTH,centreAt,toInertial,bodiesEnabled} from './bodies.js';
import {nearElune,overheadLooking,poseLink} from './elune-pose.js';

test('multi-body world is on by default; ?bodies=0 and ?moonEngine=0 opt out', () => {
  assert.equal(bodiesEnabled(''),true);
  assert.equal(bodiesEnabled('?bodies'),true);
  assert.equal(bodiesEnabled('?bodies=0'),false);
  assert.equal(bodiesEnabled('?bodies=off'),false);
  assert.equal(bodiesEnabled('?bodies&moonEngine=0','moonEngine'),false);
  assert.equal(bodiesEnabled('?bodies','moonEngine'),true);
});

test('nearElune places the camera the standoff above Elune, outside its SOI swap', () => {
  const t=720,pose=nearElune(30000,t),d=Math.hypot(...toInertial(AZEROTH,pose.slice(0,3),t).map((v,i)=>v-centreAt(ELUNE,t)[i]));
  assert.ok(Math.abs(d-(ELUNE.radius+30000))<5,`distance ${d}`);
  assert.ok(pose.every(Number.isFinite));
  assert.ok(overheadLooking(120000,t).every(Number.isFinite));
  assert.match(poseLink(pose,t),/^\?pose=|&pose=/);
});
