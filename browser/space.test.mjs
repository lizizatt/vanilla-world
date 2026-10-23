import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANET_RADIUS, CONTINENT_YD, CONTINENT_DEG, MOONS, planetFactors, planetFrame, moonPlanetPosition } from './space.js';
import { FLIGHT_CEILING, flightBoost } from './flight.js';

test('radius makes one continent span 40 degrees', () => {
  const deg = CONTINENT_YD / PLANET_RADIUS * 180 / Math.PI;
  assert.ok(Math.abs(deg - CONTINENT_DEG) < .01);
});

test('planet factors are bounded, monotonic and zero at ground', () => {
  const g = planetFactors(0);
  assert.deepEqual([g.bend, g.globe, g.space], [0, 0, 0]);
  assert.equal(g.cloud, 1);
  let p = planetFactors(0);
  for (let a = 10; a <= 1e6; a *= 1.3) {
    const f = planetFactors(a);
    for (const k of ['bend', 'globe', 'space']) { assert.ok(f[k] >= p[k] && f[k] <= 1); }
    assert.ok(f.cloud <= p.cloud && f.cloud >= 0);
    p = f;
  }
  assert.equal(p.space, 1);
  assert.equal(planetFactors(5000, false).bend, 0);
});

test('planet frame is orthonormal', () => {
  const { east, up, south } = planetFrame(-810, 5589);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const v of [east, up, south]) assert.ok(Math.abs(dot(v, v) - 1) < 1e-4);
  assert.ok(Math.abs(dot(east, up)) < 1e-4 && Math.abs(dot(up, south)) < 1e-4);
});

test('moons are periodic over their orbit', () => {
  for (const m of MOONS) {
    const a = moonPlanetPosition(m, 0), b = moonPlanetPosition(m, 2880 / m.turns);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-3 * m.orbit);
  }
});

test('fly boost leaves ground flight alone and reaches space', () => {
  assert.equal(flightBoost(0), 1);
  assert.equal(flightBoost(1500), 1);
  assert.equal(flightBoost(1e6), 60);
  assert.ok(FLIGHT_CEILING >= 500000);
});
