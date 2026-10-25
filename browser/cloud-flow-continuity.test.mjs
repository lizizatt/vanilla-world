import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudClock, CLOUD_TIME_WRAP } from './sim-clock.js';
import { flowPhaseAt, flowShift, FLOW } from './cloud-flow.js';
import { PLANET_RADIUS } from './space.js';

const DAY = 86400;
// Globe sample sites: [lat deg, flat dx, flat dz from the Maelstrom centre] (poles, equator, belt edges, Maelstrom core/arms/far field).
const SITES = [
  [90, 0, 0], [-90, 0, 0], [0, 0, 0], [30, 3000, -2000], [-30, -3000, 2000], [60, 0, 0], [-60, 0, 0],
  [10, 0, 0], [45, 0, 0], [20, 10, 5], [20, 2600, 0], [20, 5200, 0], [20, 9000, 4000], [20, 40000, -8000], [80, 100, 100], [89, 0, 0],
];
const rad = d => d * Math.PI / 180;

// Effective flow-map displacement of a site: the two phases' warp offsets blended by their weights (what the shader samples).
function displacement(site, clock) {
  const [lat, dx, dz] = site, p = flowPhaseAt(clock.cycles, clock.stretch);
  const a = flowShift(rad(lat), dx, dz, p.tauA), b = flowShift(rad(lat), dx, dz, p.tauB);
  return [a[0] * p.wA + b[0] * (1 - p.wA), a[1] * p.wA + b[1] * (1 - p.wA)];
}

// Run a real-time window at a fixed dt and return per-site displacement series.
function series(clock, scaleAt, seconds, dt) {
  const n = Math.round(seconds / dt), out = SITES.map(() => []);
  for (let i = 0; i < n; i++) {
    clock.step(dt, scaleAt(i * dt));
    SITES.forEach((s, k) => out[k].push(displacement(s, clock)));
  }
  return out;
}

// Largest finite-difference derivative (order 1 or 2, per axis) over a series, in units/s^order.
function maxDeriv(ser, dt, order) {
  let m = 0;
  for (let i = 0; i + order < ser.length; i++) for (let ax = 0; ax < 2; ax++) {
    const v = order === 1 ? (ser[i + 1][ax] - ser[i][ax]) / dt
      : order === 2 ? (ser[i + 2][ax] - 2 * ser[i + 1][ax] + ser[i][ax]) / (dt * dt)
        : (ser[i + 3][ax] - 3 * ser[i + 2][ax] + 3 * ser[i + 1][ax] - ser[i][ax]) / (dt * dt * dt);
    m = Math.max(m, Math.abs(v));
  }
  return m;
}

// Jump test: compare the largest derivative at dt with the same at dt/2; a smooth function barely changes it, a discontinuity doubles it.
function assertOrder(label, mk, scaleAt, seconds, order, tol) {
  const dt = 1 / 60;
  const a = series(mk(), scaleAt, seconds, dt), b = series(mk(), scaleAt, seconds, dt / 2);
  a.forEach((sa, k) => {
    const ma = maxDeriv(sa, dt, order), mb = maxDeriv(b[k], dt / 2, order);
    assert.ok(mb <= ma * tol + 1e-3, `${label} order ${order} site ${k}: ${ma} -> ${mb}`);
  });
}

const sweeps = [
  ['1x', () => 1, 1],
  ['10x', () => 10, 1],
  ['100x', () => 100, 1],
  ['1000x', () => 1000, 1],
  ['ramp 1x->1000x->10x', t => (t < 3 ? 1 : t < 7 ? 1000 : 10), 1],
  ['ramp 1000x->100x', t => (t < 5 ? 1000 : 100), 1],
];

for (const [name, scaleAt] of sweeps) {
  test(`flow displacement continuity C0/C1/C2 (${name})`, () => {
    // Start mid-day windows at several sim days so each cycle phase is covered.
    for (const day of [0, 3, 6]) {
      const mk = () => new CloudClock(day * DAY);
      assertOrder(`${name} d${day}`, mk, scaleAt, 12, 1, 1.4);
      assertOrder(`${name} d${day}`, mk, scaleAt, 12, 2, 1.4);
      assertOrder(`${name} d${day}`, mk, scaleAt, 12, 3, 1.4);
    }
  });
}

test('displacement has no jumps at flow-cycle wraps and phase blend edges', () => {
  const c = new CloudClock(0);
  c.stretch = 1;
  const f = x => { c.cycles = ((x % 1) + 1) % 1; return displacement(SITES[3], c); };
  const h = 1e-5;
  for (const x of [0, .4, .5, .6, .9, 1 - 1e-9, 1, 1.5]) {
    const lo = f(x - h), mid = f(x), hi = f(x + h);
    for (let ax = 0; ax < 2; ax++) {
      assert.ok(Math.abs(hi[ax] - mid[ax]) < 1e-2 * PLANET_RADIUS * 1e-3 + 60 * h * 90, `C0 at ${x}`);
      const d2 = (hi[ax] - 2 * mid[ax] + lo[ax]) / (h * h);
      assert.ok(Math.abs(d2) < 5e5, `C2 at ${x}: ${d2}`);
    }
  }
});

test('CLOUD_TIME_WRAP crossing does not move the flow displacement', () => {
  const mk = () => { const c = new CloudClock(0); c.time = CLOUD_TIME_WRAP - 5; return c; };
  const a = mk(), b = mk();
  for (let i = 0; i < 600; i++) {
    a.step(1 / 60, 1000); b.step(1 / 60, 1000);
    SITES.forEach(s => assert.deepEqual(displacement(s, a), displacement(s, b)));
  }
  assert.ok(a.time < 1e5, 'clock wrapped');
  assert.ok(FLOW.period > 0);
});
