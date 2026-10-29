import test from 'node:test';
import assert from 'node:assert/strict';
import {gateGuide,formatRange} from './gate-guide.js';

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

test('gate on another body hides the arrow and names the body', () => {
  const g=gateGuide({...here,gate:{pos:[0,0,-300]},gateBody:'elune'});
  assert.deepEqual([g.visible,g.label,g.range],[false,' (elune)','']);
});

test('no gate hides the guide', () => {
  assert.equal(gateGuide({...here,gate:undefined}).visible,false);
});
