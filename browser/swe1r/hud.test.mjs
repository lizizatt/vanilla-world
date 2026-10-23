import test from 'node:test';
import assert from 'node:assert/strict';
import { lapText, lapCount, lapTimesText, lapBanner, finishBanner } from './hud.js';

test('lap readout is 1-based and clamped to the total', () => {
  assert.equal(lapText(1, 3), 'Lap 1/3');
  assert.equal(lapText(3, 3), 'Lap 3/3');
  assert.equal(lapText(4, 3), 'Lap 3/3');
  assert.equal(lapText(0, 1), 'Lap 1/1');
});

test('top-banner lap cell is current/total, clamped, 1/1 for one-lap races', () => {
  assert.equal(lapCount(1, 3), '1/3');
  assert.equal(lapCount(5, 3), '3/3');
  assert.equal(lapCount(0, 3), '1/3');
  assert.equal(lapCount(2, undefined), '1/1');
});

test('lap times readout shows last and best lap only once a lap is done', () => {
  const f = s => s.toFixed(1);
  assert.equal(lapTimesText([], f), '');
  assert.equal(lapTimesText([50, 45, 47], f), 'Last 47.0  Best lap 45.0');
});

test('banners: lap number, final lap, lap record, finish', () => {
  assert.equal(lapBanner(2, 3, [50]), 'LAP 2');
  assert.equal(lapBanner(3, 3, [50, 55]), 'FINAL LAP');
  assert.equal(lapBanner(2, 3, [50, 45]), 'LAP RECORD');
  assert.equal(lapBanner(3, 3, [50, 55, 40]), 'LAP RECORD - FINAL LAP');
  assert.equal(finishBanner(true), 'NEW BEST TIME');
  assert.equal(finishBanner(false), 'FINISH');
});

import {hitFlash} from './hud.js';
test('hitFlash fires on a fast contact edge, fades, and ignores slow or held contact',()=>{
  const m={};
  assert.equal(hitFlash(m,0,100,0),0);
  assert.ok(hitFlash(m,3,100,1)>.4);
  assert.equal(hitFlash(m,3,100,1.2)<hitFlash({at:1,strength:.5},3,100,1),true);
  assert.equal(hitFlash(m,3,100,2),0);
  const s={};hitFlash(s,0,0,0);assert.equal(hitFlash(s,3,10,1),0);
}); 

import {boostFx} from './hud.js';
test('boostFx ramps while boosting (boost is never empty) and fades otherwise',()=>{
  const m={};
  assert.equal(boostFx(m,true,.1),.5);
  assert.equal(boostFx(m,true,1),1);
  assert.equal(boostFx(m,true,.1),1);
  assert.equal(boostFx(m,false,1),0);
}); 
