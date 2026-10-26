import test from 'node:test';
import assert from 'node:assert/strict';
import {smoothstep,smoothRange} from './math.js';
import {gravityAt,densityAt,circularSpeed,SURFACE_GRAVITY,ATMOSPHERE_EDGE} from './planet-physics.js';
import {AZEROTH,ELUNE,gravityFor,densityFor,circularSpeedFor,planetFactorsFor,regimeOf} from './bodies.js';
import {planetFactors} from './terrain-transition.js';
import {regimeOf as azRegime} from './regime.js';

test('smoothstep golden values and clamping',()=>{
  assert.equal(smoothstep(0,10,-5),0);assert.equal(smoothstep(0,10,15),1);
  assert.equal(smoothstep(0,10,5),.5);assert.equal(smoothstep(0,10,2.5),0.15625);
  assert.equal(smoothRange([100,200],150),.5);
});

test('body physics wrappers equal the Azeroth functions',()=>{
  for(const h of [0,50,1000,ATMOSPHERE_EDGE-1,ATMOSPHERE_EDGE,1e5]){
    assert.equal(gravityFor(AZEROTH,h),gravityAt(h));
    assert.equal(densityFor(AZEROTH,h),densityAt(h));
    assert.equal(circularSpeedFor(AZEROTH,h),circularSpeed(h));
  }
  assert.equal(gravityAt(0),SURFACE_GRAVITY);
  assert.equal(densityFor(ELUNE,100),0);
});

test('Azeroth body tables reproduce the legacy ramps and regimes',()=>{
  for(const h of [-5,0,10,150,500,1500,2500,5000,9000,20000])
    assert.deepEqual(planetFactorsFor(AZEROTH,h),{...planetFactors(h,true)},'alt '+h),
    assert.equal(regimeOf(h),azRegime(h));
});
