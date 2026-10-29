import test from 'node:test';
import assert from 'node:assert/strict';
import {boostView} from './boost-hud.js';
import {spendCharge,LAUNCH} from './pod-launch.js';

test('hidden without a pickup charge', () => {
  for(const pod of [undefined,null,{},{remaining:0},{remaining:-1},{remaining:NaN}])assert.equal(boostView(pod).visible,false);
});

test('full charge shows 15.0 s at 100%', () => {
  const v=boostView({remaining:LAUNCH.charge});
  assert.deepEqual([v.visible,v.fraction,v.text,v.low],[true,1,'15.0 s',false]);
});

test('over-range values clamp and low warns at a quarter', () => {
  assert.equal(boostView({remaining:99}).fraction,1);
  assert.equal(boostView({remaining:3.75}).low,true);
  assert.equal(boostView({remaining:3.8}).low,false);
});

test('bar follows boost-seconds consumed, not elapsed time', () => {
  let remaining=LAUNCH.charge;
  for(let i=0;i<60;i++)remaining=spendCharge(remaining,false,1,1/60).remaining;
  assert.equal(boostView({remaining}).text,'15.0 s');
  for(let i=0;i<120;i++)remaining=spendCharge(remaining,true,1,1/60).remaining;
  assert.equal(boostView({remaining}).text,'13.0 s');
  for(let i=0;i<60;i++)remaining=spendCharge(remaining,true,0,1/60).remaining;
  assert.equal(boostView({remaining}).text,'13.0 s');
});
