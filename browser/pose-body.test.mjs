import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {poseBody} from './pose-body.js';

const flight=(x,y,z)=>[x,y,z,0,0,0,0,0,1];

test('an explicit body id wins over position', () => {
  assert.equal(poseBody({body:'elune',flight:flight(1e5,5e4,0)}),'elune');
  assert.equal(poseBody({body:'azeroth',flight:flight(524,100,287)}),'azeroth');
});

test('legacy links: low poses near the Elune dome read as Elune, far or high ones as Azeroth', () => {
  assert.equal(poseBody({flight:flight(316.3,50.9,-91.4)}),'elune');
  assert.equal(poseBody({flight:flight(-2252.2,142.2,332)}),'elune');
  assert.equal(poseBody({flight:flight(-13826.6,60559.8,8394.3)}),'azeroth');
  assert.equal(poseBody({flight:flight(-30000,100,20000)}),'azeroth');
  assert.equal(poseBody({drive:[1,2,3,4]}),'azeroth');
  assert.equal(poseBody({body:'nonsense',flight:flight(0,1e5,0)}),'azeroth');
});

test('pose export records body and epoch days; import swaps before placing the flight', () => {
  const src=readFileSync(new URL('./app-pose.js',import.meta.url),'utf8');
  assert.match(src,/body:activeBody\(\)\.id,days:simEpoch\.days/);
  assert.ok(src.indexOf('app.soiSwap(target)')<src.lastIndexOf('await place()'));
  assert.match(src,/simEpoch\.days=Number\.isFinite\(view\.days\)/);
});
