import test from 'node:test';
import assert from 'node:assert/strict';
import {gravityAt,densityAt,circularSpeed,ATMOSPHERE_EDGE,SURFACE_GRAVITY} from './planet-physics.js';
import {PLANET_RADIUS} from './space.js';

test('gravity is inverse-square and monotone',() => {
  assert.equal(gravityAt(0),SURFACE_GRAVITY);
  assert.ok(Math.abs(gravityAt(PLANET_RADIUS)-SURFACE_GRAVITY/4)<1e-9);
  let prev=Infinity;for(let h=0;h<2e6;h+=1e4){const g=gravityAt(h);assert.ok(g<=prev);prev=g;}
});
test('atmosphere density falls continuously to zero at the edge',() => {
  assert.equal(densityAt(0),1);assert.equal(densityAt(ATMOSPHERE_EDGE),0);assert.equal(densityAt(1e7),0);
  let prev=1;for(let h=0;h<=ATMOSPHERE_EDGE;h+=50){const d=densityAt(h);assert.ok(d<=prev+1e-12&&d>=0);assert.ok(prev-d<.08);prev=d;}
});
test('circular orbit speed matches v^2/r = g',() => {
  const h=20000,v=circularSpeed(h);assert.ok(Math.abs(v*v/(PLANET_RADIUS+h)-gravityAt(h))<1e-9);
});

