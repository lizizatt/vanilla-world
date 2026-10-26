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

import {wrapAngle,wrapTurn,unwrapNear} from './math.js';
import {wrapFlat,PLANET_RADIUS as R,WORLD_CENTRE} from './space.js';
import {toPlanet,fromPlanet} from './planet-frame.js';
test('wrap helpers golden',()=>{
  assert.ok(Math.abs(wrapAngle(3*Math.PI+.5)-(-Math.PI+.5))<1e-12);
  assert.equal(wrapAngle(-Math.PI),-Math.PI);assert.equal(wrapTurn(150,100),-50);
  assert.equal(unwrapNear(10,990,1000),1010);assert.equal(unwrapNear(10,-980,1000),-990);
});
test('wrapFlat and planet-frame round trips still unwrap',()=>{
  const [x,z,flipped]=wrapFlat(WORLD_CENTRE[0]+2*Math.PI*R*1.25,WORLD_CENTRE[1]+100);
  assert.ok(Math.abs(x-(WORLD_CENTRE[0]+2*Math.PI*R*.25))<1e-6);assert.equal(z,WORLD_CENTRE[1]+100);assert.equal(flipped,false);
  const p=[5000,300,-2000],back=fromPlanet(toPlanet(p),p[0]);
  for(let i=0;i<3;i++)assert.ok(Math.abs(back[i]-p[i])<1e-6);
  const far=fromPlanet(toPlanet(p),p[0]+2*Math.PI*R);assert.ok(Math.abs(far[0]-(p[0]+2*Math.PI*R))<1e-6);
});
