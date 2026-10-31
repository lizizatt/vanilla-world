import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_TIME_WRAP } from './sim-clock.js';
import { MAELSTROM as M, FUNNEL as F } from './cloud-config.js';
import { WEATHER as W } from './weather-config.js';
import { cellIntensity } from './weather-field.js';
import { WAVE_PERIOD } from './wave-config.js';

// The shader clock wraps at CLOUD_TIME_WRAP; anything periodic in time must come back to the same value or the cloud layer snaps to a different state.
const turns = x => { const f = ((x % 1) + 1) % 1; return Math.min(f, 1 - f); };
const TAU = 2 * Math.PI;

test('storm arm and funnel phases are whole turns per clock wrap', () => {
  assert.ok(turns(M.arms * M.spin * CLOUD_TIME_WRAP / TAU) < 1e-6, 'maelstrom arms');
  assert.ok(turns(F.spin * CLOUD_TIME_WRAP / TAU) < 1e-6, 'funnel spin');
});

test('weather life, wind/wave and water periods divide the clock wrap', () => {
  assert.equal(CLOUD_TIME_WRAP % W.life.period, 0);
  assert.equal(CLOUD_TIME_WRAP % WAVE_PERIOD, 0);
  assert.equal(CLOUD_TIME_WRAP % 7200, 0);
  assert.equal(CLOUD_TIME_WRAP % .5, 0);
});

test('precipitation cells do not change across the clock wrap', () => {
  for (const Q of [[1e4, 2e4, 3e4], [-5e3, 7e3, 4e4], [123456, -2222, 98765]]) {
    for (const dt of [0, 1, 37.5]) {
      const a = cellIntensity(Q, dt), b = cellIntensity(Q, CLOUD_TIME_WRAP + dt);
      assert.ok(Math.abs(a - b) < 1e-6, `cell at ${Q} dt=${dt}: ${a} vs ${b}`);
    }
  }
});
