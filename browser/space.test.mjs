import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestLandmark, PLANET_RADIUS, CONTINENT_YD, CONTINENT_DEG, MOONS, planetFrame, moonPlanetPosition, subPoint, globeToFlat, wrapFlat, placeName, WORLD_CENTRE, FALLBACK_RECTS } from './space.js';
import { BEND_ALWAYS, planetFactors } from './terrain-transition.js';
import { FLIGHT_CEILING, flightBoost, moveFlight } from './flight.js';

test('radius makes one continent span 40 degrees', () => {
  const deg = CONTINENT_YD / PLANET_RADIUS * 180 / Math.PI;
  assert.ok(Math.abs(deg - CONTINENT_DEG) < .01);
});

test('planet factors are bounded, monotonic and zero at ground', () => {
  const g = planetFactors(0);
  assert.deepEqual([g.bend, g.globe, g.space], [BEND_ALWAYS ? 1 : 0, 0, 0]);
  let p = planetFactors(0);
  for (let a = 10; a <= 1e6; a *= 1.3) {
    const f = planetFactors(a);
    for (const k of ['bend', 'globe', 'space']) { assert.ok(f[k] >= p[k] && f[k] <= 1); }
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

test('fly speed law is continuous, monotonic and 1x on the ground', () => {
  assert.equal(flightBoost(-500), 1);
  assert.equal(flightBoost(1000), 1);
  assert.ok(Math.abs(flightBoost(1e6) - 40) < 1e-9 && flightBoost(2e6) === flightBoost(1e6));
  let prev = 1;
  for (let a = 900; a <= 1.1e6; a *= 1.001) {
    const b = flightBoost(a);
    assert.ok(b >= prev - 1e-12 && b - prev < .01 * b, `jump at ${a}`);
    prev = b;
  }
  assert.ok(FLIGHT_CEILING >= 500000);
});

test('moveFlight is continuous and never flips direction (seeded sweep)', () => {
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const keysets = [['KeyW'], ['KeyS'], ['KeyW', 'ShiftLeft'], ['KeyD'], ['KeyE', 'ShiftLeft'], ['KeyQ']];
  for (let n = 0; n < 4000; n++) {
    const alt = (rnd() < .5 ? rnd() * 3000 : 10 ** (3 + rnd() * 3)), yaw = rnd() * 6.28, pitch = (rnd() - .5) * 3;
    const keys = new Set(keysets[n % keysets.length]);
    const a = moveFlight([0, alt, 0, yaw, pitch], keys, 1 / 60), b = moveFlight([0, alt * 1.001 + .5, 0, yaw, pitch], keys, 1 / 60);
    const da = [a[0], a[1] - alt, a[2]], db = [b[0], b[1] - alt * 1.001 - .5, b[2]];
    for (let i = 0; i < 3; i++) {
      assert.ok(Number.isFinite(a[i]));
      assert.ok(Math.abs(da[i] - db[i]) <= .01 * Math.hypot(...da) + 1e-6, 'speed jump');
      assert.ok(da[i] * db[i] >= -1e-9, 'sign flip');
    }
    assert.ok(Math.hypot(...da) < 8000 / 60 * 40 + 1e-6);
    assert.equal(a[3], yaw + 0);
  }
});

test('turn rate does not depend on altitude', () => {
  const keys = new Set(['ArrowLeft']);
  const lo = moveFlight([0, 10, 0, 0, 0], keys, .1)[3], hi = moveFlight([0, 5e5, 0, 0, 0], keys, .1)[3];
  assert.equal(lo, hi);
});
test('flat -> globe -> flat round trip is exact, incl. world edges, and matches the render frame', () => {
  let s = 99;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pts = [[-21867, -12267], [24725, 17067], [5333, 17600], [13525, -5333], [1429, -267], ...Array.from({ length: 2000 }, () => [-10000 + rnd() * 20000, -10000 + rnd() * 20000])];
  for (const [x, z] of pts) {
    const { lat, lon } = subPoint(x, z);
    const [rx, rz] = globeToFlat(lat, lon);
    assert.ok(Math.abs(rx - x) < 1e-6 && Math.abs(rz - z) < 1e-6);
    const up = planetFrame(x, z).up, lat2 = Math.asin(up[1]), lon2 = Math.atan2(up[2], up[0]);
    assert.ok(Math.abs(lat2 - lat) < 1e-9 && Math.abs(lon2 - lon) < 1e-9);
  }
  const k = subPoint(-21867, 0), e = subPoint(5333, 0);
  assert.ok(Math.abs((e.lon - k.lon) * 180 / Math.PI - 109.3) < 1);
});

test('wrapFlat wraps longitude and clamps latitude without moving points inside the world', () => {
  const w = wrapFlat(1000, 2000);
  assert.ok(Math.abs(w[0] - 1000) < 1e-6 && w[1] === 2000 && w[2] === false);
  const turn = 2 * Math.PI * PLANET_RADIUS, [x] = wrapFlat(WORLD_CENTRE[0] + turn + 5, 0);
  assert.ok(Math.abs(x - (WORLD_CENTRE[0] + 5)) < 1e-6);
  assert.ok(wrapFlat(0, 1e9)[1] <= WORLD_CENTRE[1] + Math.PI / 2 * PLANET_RADIUS + 1e-6);
});

test('place name and HUD text', () => {
  assert.equal(placeName(-810, 5589), 'KALIMDOR');
  assert.equal(placeName(20000, 0), 'EASTERN KINGDOMS');
  assert.equal(placeName(9000, 0), 'THE GREAT SEA');
});
test('nearest landmark names the closest icon and wraps around the planet', () => {
  const icons = [{ label: 'A', position: [0, 0] }, { label: 'B', position: [5000, 0] }];
  assert.equal(nearestLandmark(4000, 0, icons).label, 'B');
  const turn = 2 * Math.PI * PLANET_RADIUS, wrapped = nearestLandmark(turn - 100, 0, icons);
  assert.deepEqual([wrapped.label, Math.round(wrapped.distance)], ['A', 100]);
  assert.equal(nearestLandmark(0, 0, []), undefined);
});
