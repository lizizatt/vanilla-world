import test from 'node:test';
import assert from 'node:assert/strict';
import { lapText, lapTimesText, lapBanner, finishBanner } from './hud.js';

test('lap readout is 1-based and clamped to the total', () => {
  assert.equal(lapText(1, 3), 'Lap 1/3');
  assert.equal(lapText(3, 3), 'Lap 3/3');
  assert.equal(lapText(4, 3), 'Lap 3/3');
  assert.equal(lapText(0, 1), 'Lap 1/1');
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
