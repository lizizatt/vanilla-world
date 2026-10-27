import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudAltitudeAt,CLOUD_LAYER_RANGE,CLOUD_FAR_ALTITUDE_FRACTION} from './terrain-transition.js';
import {CLOUD_ALTITUDE} from './cloud-config.js';

test('cloud layer altitude is the ground value below the range and hugs the surface above it', () => {
  const R=14260;
  assert.equal(cloudAltitudeAt(0,R),CLOUD_ALTITUDE);
  assert.equal(cloudAltitudeAt(CLOUD_LAYER_RANGE[0],R),CLOUD_ALTITUDE);
  assert.ok(Math.abs(cloudAltitudeAt(CLOUD_LAYER_RANGE[1],R)-CLOUD_FAR_ALTITUDE_FRACTION*R)<1e-6);
  let prev=Infinity;
  for(let a=0;a<=12000;a+=250){const v=cloudAltitudeAt(a,R);assert.ok(v<=prev+1e-9);prev=v;}
});
