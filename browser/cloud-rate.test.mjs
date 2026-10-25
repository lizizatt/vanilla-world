import {cloudRate} from './sim-clock.js';
import test from 'node:test';import assert from 'node:assert/strict';
test('cloud rate follows the clock scale',()=>{assert.equal(cloudRate(0),0);assert.equal(cloudRate(1),1);assert.equal(cloudRate(10),10);assert.ok(cloudRate(100)>20&&cloudRate(1000)>cloudRate(100)*2);});
