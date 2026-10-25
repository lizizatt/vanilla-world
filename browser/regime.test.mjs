import test from 'node:test';
import assert from 'node:assert/strict';
import {regimeOf,REGIME_BANDS} from './regime.js';
import {BEND_RANGE,GLOBE_RANGE,SPACE_RANGE,CLOUD_RANGE,planetFactors,wgslRamp} from './terrain-transition.js';
import {CLOUD_ALTITUDE,CLOUD_THICKNESS} from './cloud-config.js';
import {zoneBlend} from './renderer-sky.js';
import {spaceShader} from './space.js';
import {FLIGHT,flightBoost,moveFlight} from './flight.js';
import {ORIENT,spaceBlend,stepOrient,fromEuler,basis} from './orient.js';
import {CAMERA} from './world-camera.js';
import {WorldInput,idleIntent} from './world-input.js';

test('regime tag follows the planet ramps at the band edges', () => {
  assert.equal(regimeOf(-5),'ground');
  assert.equal(regimeOf(149.99),'ground');
  assert.equal(regimeOf(150),'atmosphere');
  assert.equal(regimeOf(8999),'atmosphere');
  assert.equal(regimeOf(9000),'orbit');
  assert.equal(REGIME_BANDS.atmosphere,BEND_RANGE[0]);
  assert.equal(planetFactors(REGIME_BANDS.atmosphere).bend,0);
  assert.equal(planetFactors(REGIME_BANDS.orbit).space,1);
});

test('tuning tables are frozen and keep their shipped values', () => {
  for(const t of [FLIGHT,ORIENT,CAMERA,BEND_RANGE,GLOBE_RANGE,SPACE_RANGE,CLOUD_RANGE])assert.ok(Object.isFrozen(t));
  assert.deepEqual({...FLIGHT},{walkSpeed:1200,fastSpeed:8000,floor:-10000,ceiling:1000000,pitch:Math.PI/2,boostFrom:1000,boostMax:40});
  assert.deepEqual([...ORIENT.levelAlt],[800,4000]);
  assert.deepEqual([BEND_RANGE,GLOBE_RANGE,SPACE_RANGE,CLOUD_RANGE].map(r=>[...r]),[[150,1500],[0,60],[2000,9000],[3000,9000]]);
  assert.equal(CAMERA.recentre,7);
});

test('flight boost is monotone, continuous and spans 1x to 40x', () => {
  assert.equal(flightBoost(1),1);
  assert.equal(flightBoost(1000),1);
  assert.ok(Math.abs(flightBoost(FLIGHT.ceiling)-FLIGHT.boostMax)<1e-9);
  let last=0;
  for(let a=1;a<=FLIGHT.ceiling;a*=1.05){const b=flightBoost(a);assert.ok(b>=last);assert.ok(b-last<2);last=b;}
});

test('flight speed uses the table', () => {
  const walk=moveFlight([0,100,0,0,0],new Set(['KeyW']),1),fast=moveFlight([0,100,0,0,0],new Set(['KeyW','ShiftLeft']),1);
  assert.ok(Math.abs(Math.hypot(walk[0],walk[2])-FLIGHT.walkSpeed)<1e-6);
  assert.ok(Math.abs(Math.hypot(fast[0],fast[2])-FLIGHT.fastSpeed)<1e-6);
  assert.equal(moveFlight([0,FLIGHT.ceiling,0,0,0],new Set(['KeyE']),1)[1],FLIGHT.ceiling);
});

test('attitude stays a finite unit quaternion across the blend band', () => {
  assert.equal(spaceBlend(ORIENT.levelAlt[0]),0);
  assert.equal(spaceBlend(ORIENT.levelAlt[1]),1);
  let q=fromEuler(.3,.2);
  for(let i=0;i<500;i++){
    q=stepOrient(q,{yaw:.01,pitch:.005,roll:.002},i*12,1/60);
    assert.ok(q.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...q)-1)<1e-9);
  }
  const b=basis(q);assert.ok(Math.abs(Math.hypot(...b.look)-1)<1e-9);
});

test('keyboard and controller map to the same Intent shape', () => {
  const idle=Object.keys(idleIntent()).sort();
  const kb=new WorldInput().sample(new Set(['KeyW']),[],true);
  assert.deepEqual(Object.keys(kb).sort(),idle);
  assert.equal(kb.throttle,1);
  const pad={index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},(_,i)=>({pressed:i===7,value:i===7?1:0}))};
  const input=new WorldInput(),pd=input.sample(new Set(),[pad],true);
  assert.deepEqual(Object.keys(pd).sort(),idle);
  assert.ok(pd.throttle>0.9);
  assert.deepEqual(input.sample(new Set(),[],false),idleIntent(true));
});

test('globe fog shader takes its ramp from the transition owner', () => {
  assert.ok(spaceShader.includes(wgslRamp(BEND_RANGE)+'s.p.x)'));
});

test('zone lighting weight is 0 at and above the lowest cloud layer base and 1 on the ground',()=>{
  const base=CLOUD_ALTITUDE-CLOUD_THICKNESS/2;
  assert.equal(planetFactors(base).zone,0);assert.equal(planetFactors(base*3).zone,0);assert.equal(planetFactors(20000).zone,0);
  assert.equal(planetFactors(1).zone,1);assert.ok(planetFactors(base/2+100).zone>0);
  const sky={fog:[1,0,0],sun:[0,1,0],horizon:[0,0,1],mid:[1,1,0],cloud:[1,0,1],cloud2:[0,1,1]};
  assert.deepEqual(zoneBlend(zoneBlend(sky,0),0),zoneBlend({...sky,fog:[0,0,0],horizon:[9,9,9]},0));
});
