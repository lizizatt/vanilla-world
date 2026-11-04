import test from 'node:test';
import assert from 'node:assert/strict';
import {gateGuide,formatRange} from './gate-guide.js';
import {AZEROTH,ELUNE} from './bodies.js';

const here={pos:[0,0,0],yaw:0,body:'azeroth',gateBody:'azeroth'};

test('range formats adaptively', () => {
  assert.deepEqual([formatRange(12.4),formatRange(999),formatRange(1500),formatRange(25000)],['12 yd','999 yd','1.5k yd','25k yd']);
});

test('gate ahead: zero angle, range, no climb or behind', () => {
  const g=gateGuide({...here,gate:{pos:[0,0,-300]}});
  assert.equal(g.visible,true);assert.ok(Math.abs(g.angle)<1e-9);
  assert.deepEqual([g.range,g.climb,g.behind],['300 yd','',false]);
});

test('gate behind is flagged, side gate is not', () => {
  assert.equal(gateGuide({...here,gate:{pos:[0,0,300]}}).behind,true);
  assert.equal(gateGuide({...here,gate:{pos:[300,0,0]}}).behind,false);
});

test('range is 3D and climb cue follows the vertical offset', () => {
  const up=gateGuide({...here,gate:{pos:[0,400,-300]}}),down=gateGuide({...here,gate:{pos:[0,-400,-300]}});
  assert.deepEqual([up.range,up.climb,down.climb],['500 yd','\u25B2','\u25BC']);
  assert.equal(gateGuide({...here,gate:{pos:[0,20,-300]}}).climb,'');
});

test('gate on another body without a frame is not guided but names the body', () => {
  const g=gateGuide({...here,gate:{pos:[0,0,-300]},gateBody:'elune'});
  assert.deepEqual([g.visible,g.label,g.range],[false,' (elune)','']);
});

test('gate on Azeroth while on Elune (and back) is guided through the shared frame', () => {
  const t=720,there=gateGuide({pos:[0,10,0],yaw:0,gate:{pos:[1000,5,-2000]},body:'elune',gateBody:'azeroth',frame:{active:ELUNE,target:AZEROTH,t}});
  const back=gateGuide({pos:[1000,5,-2000],yaw:0,gate:{pos:[0,10,0]},body:'azeroth',gateBody:'elune',frame:{active:AZEROTH,target:ELUNE,t}});
  for(const g of [there,back]){assert.equal(g.visible&&g.cross,true);assert.ok(g.delta.every(Number.isFinite));assert.ok(g.rangeYd>5e4&&g.rangeYd<2.2e5);assert.match(g.range,/^\d+k yd$/);}
  assert.ok(Math.abs(there.rangeYd-back.rangeYd)<1e-3,'same distance both ways');
  assert.deepEqual([there.label,back.label],[' (azeroth)',' (elune)']);
});

test('no gate hides the guide', () => {
  assert.equal(gateGuide({...here,gate:undefined}).visible,false);
});
