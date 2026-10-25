import test from 'node:test';
import assert from 'node:assert/strict';
import {ParticlePool, QUALITY, KINDS, gradient, exhaustPoints, emitPlumes, emitBurst, emitDebris, emitHeatSmoke, emitGroundDust, particleUniform, particleShader, emitLamps} from './particles.js';

test('ring buffer overwrites the oldest particle when full', () => {
  const pool = new ParticlePool(4);
  for (let i = 0; i < 6; i++) pool.emit('plume', i, 0, 0);
  assert.equal(pool.count, 4);
  const xs = new Float32Array(32), n = pool.fill(xs, [0, 0, 0]);
  assert.deepEqual([...Array(n).keys()].map(i => xs[i * 8]).sort(), [2, 3, 4, 5]);
});

test('particles age out and stop being drawn', () => {
  const pool = new ParticlePool(8);
  pool.emit('burst', 0, 0, 0);
  pool.update(.1); assert.equal(pool.count, 1);
  pool.update(2); assert.equal(pool.count, 0);
  assert.equal(pool.fill(new Float32Array(64), [0, 0, 0]), 0);
});

test('emission budget carries fractions and scales with quality', () => {
  const pool = new ParticlePool(8);
  pool.quality = QUALITY.high;
  assert.equal(pool.budget('a', 30, .01), 0);
  assert.equal(pool.budget('a', 30, .01), 0);
  assert.equal(pool.budget('a', 30, .02), 1);
  pool.quality = QUALITY.off; assert.equal(pool.budget('b', 1000, 1), 0);
  pool.quality = QUALITY.low; assert.equal(pool.budget('c', 100, .1), 3);
});

test('fill writes eye-relative position, size and premultiplied colour', () => {
  const pool = new ParticlePool(2, () => .5);
  pool.emit('fire', 10, 5, 3, 0, 0, 0, 2);
  const out = new Float32Array(16);
  assert.equal(pool.fill(out, [4, 1, 1]), 1);
  assert.deepEqual([...out.slice(0, 3)], [6, 4, 2]);
  assert.ok(out[3] > 0.9 && out[3] <= KINDS.fire.size[0] * 2 + 1e-6);
  assert.ok(out[4] >= 0 && out[7] >= 0 && out[7] <= 1);
});

test('plume is a hot blue-white core fading to dark orange; smoke is non-additive', () => {
  const start = gradient(KINDS.plume.stops, 0), end = gradient(KINDS.plume.stops, 1);
  assert.ok(start[2] > start[0] - .1 && start[0] > .5);
  assert.equal(end[3], 0);
  assert.equal(gradient(KINDS.smoke.stops, .5)[4], 0);
});

test('uniform packs camera axes, aspect, near and far; shader compiles to expected entry points', () => {
  const u = particleUniform({right: [1, 0, 0], up: [0, 1, 0], look: [0, 0, 1], aspect: 2}, .5, 100);
  assert.deepEqual([...u], [1, 0, 0, 2, 0, 1, 0, .5, 0, 0, 1, 100]);
  assert.match(particleShader, /fn vs/); assert.match(particleShader, /fn fs/);
});

// Synthetic craft (+x forward): a central body plus a left and right engine box far forward.
function craft() {
  const v = [], idx = [], box = (x0, x1, y0, y1) => { const b = v.length / 12; for (const x of [x0, x1]) for (const y of [y0, y1]) v.push(x, y, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1); for (const q of [[0, 1, 2], [1, 3, 2]]) idx.push(...q.map(i => b + i)); };
  box(0, 4, -.5, .5); box(6, 9, 1, 2); box(6, 9, -2, -1);
  return { vertices: Float32Array.from(v), indices: Uint32Array.from(idx) };
}

test('exhaust points sit at the rear of each engine; metadata overrides; no engines falls back to the tail', () => {
  const { vertices, indices } = craft();
  assert.deepEqual(exhaustPoints(vertices, indices).map(p => p.map(Math.round)), [[6, 1.5 * 1, 0], [6, -1.5, 0]].map(p => p.map(Math.round)));
  assert.deepEqual(exhaustPoints(vertices, indices, { exhausts: [[1, 2, 3]] }), [[1, 2, 3]]);
  const body = craft(); body.indices = body.indices.slice(0, 6);
  assert.deepEqual(exhaustPoints(body.vertices, body.indices), [[0, 0, 0]]);
});

test('plumes spawn at the exhaust in world space, trail backwards, and boost emits more', () => {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = 2;
  const run = boosting => {
    const pool = new ParticlePool(512, () => .5); pool.quality = 1;
    emitPlumes(pool, { points: [[0, 1, 0]], matrix: m, origin: [100, 50], scale: 1, length: 4, speed: 0, thrust: 1, boosting, dt: .1 });
    return pool;
  };
  const calm = run(false), hot = run(true);
  assert.ok(calm.count > 5 && hot.count > calm.count);
  const out = new Float32Array(8 * 64); calm.fill(out, [0, 0, 0]);
  assert.ok(Math.abs(out[0] - 102 - 100 + 100) < .5 && Math.abs(out[1] - 1) < .5 && Math.abs(out[2] - 50) < .5);
  assert.ok(calm.data[3] < 0, 'exhaust leaves rearwards (-x)');
});
const kinds = pool => { const c = {}; for (let i = 0; i < pool.capacity; i++) if (pool.data[i * 12 + 6] < pool.data[i * 12 + 7]) { const k = Object.keys(KINDS)[pool.data[i * 12 + 10]]; c[k] = (c[k] || 0) + 1; } return c; };

test('explosion burst spawns fire, burst and smoke particles', () => {
  const pool = new ParticlePool(512, () => .5); pool.quality = 1;
  emitBurst(pool, [0, 0, 0], 1);
  const c = kinds(pool); assert.ok(c.burst > 5 && c.fire > 0 && c.smoke > 0);
});

test('debris burns for the first 1.4 s, smokes throughout and kicks up dust only when it lands', () => {
  const run = (age, ys) => {
    const pool = new ParticlePool(512, () => .5), memo = {}; pool.quality = 1;
    ys.forEach(y => emitDebris(pool, memo, [0, y, 0], age, .05, 1, 'p'));
    return kinds(pool);
  };
  assert.ok(run(.2, [5, 5, 5]).fire > 0 && !run(2, [5, 5, 5]).fire);
  assert.ok(run(2, [5, 5, 5, 5, 5, 5, 5, 5]).smoke > 0);
  assert.ok(!run(.5, [10, 9, 8]).dust, 'falling is not landing');
  assert.ok(run(.5, [10, 9, 8, 8]).dust > 0, 'losing the downward speed raises dust');
});

test('heat smoke only appears past the warning level and grows with heat', () => {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
  const run = heat => { const pool = new ParticlePool(512, () => .5); pool.quality = 1; emitHeatSmoke(pool, { points: [[0, 0, 0]], matrix: m, origin: [0, 0], length: 4, heat, dt: .5 }); return pool.count; };
  assert.equal(run(.79), 0); assert.ok(run(.9) > 0 && run(1) > run(.9));
});
test('ground dust needs a grounded craft, thickens when drifting and goes behind the craft', () => {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
  const run = o => { const pool = new ParticlePool(512, () => .5); pool.quality = 1; emitGroundDust(pool, { matrix: m, origin: [0, 0], scale: 1, length: 4, speed: 100, drift: false, grounded: true, dt: .1, ...o }); return pool; };
  assert.equal(run({ grounded: false }).count, 0); assert.equal(run({ speed: 3 }).count, 0); assert.ok(run({ speed: 30 }).count > 0 && run({ speed: 30 }).count < run({ speed: 120 }).count, 'ordinary driving kicks up dust, more with speed');
  assert.ok(run({ drift: true }).count > run({}).count && run({}).count > 0);
  assert.ok(run({}).data[0] < 0, 'spawned behind the craft (-x)');
});
test('lamp glow emits only at night and scales with it', () => {
  const m = new Float32Array(16).map((v, i) => i % 5 ? 0 : 1);
  const lit = new ParticlePool(64, () => .5), day = new ParticlePool(64, () => .5);
  emitLamps(day, [{ points: [[0, 0, 1]], matrix: m }], [0, 0], .5, 0);
  emitLamps(lit, [{ points: [[0, 0, 1]], matrix: m }], [0, 0], .5, 1);
  assert.equal(day.count, 0);
  assert.ok(lit.count > 0);
});

import {emitWaterFx as ewf, overWater as ow} from './particles.js';
test('water: spray+wake when moving, ripple pulse when still, none above water', () => {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
  const kinds = o => { const p = new ParticlePool(512, () => .5); p.quality = 1; for (let i = 0; i < 40; i++) ewf(p, { matrix: m, origin: [0, 0], scale: 1, length: 4, speed: 100, time: i * .1, dt: .1, ...o }); const s = new Set(); for (let i = 0; i < p.capacity; i++) if (p.data[i * 8 + 6] < p.data[i * 8 + 7]) s.add(p.data[i * 8 + 12]); return p; };
  assert.ok(ow(0, 4) && ow(-1, 4) && !ow(20, 4));
  assert.ok(kinds({}).carry.has('spray') && kinds({}).carry.has('wake'));
  assert.ok(kinds({ speed: 0, time: 0 }).carry.has('ripplePulse'));
});

test('idle grounded craft puffs a few small dust particles; none when airborne or particles off', () => {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
  const run = o => { const pool = new ParticlePool(512, () => .5); pool.quality = 1; emitGroundDust(pool, { matrix: m, origin: [0, 0], scale: 1, length: 4, speed: 0, drift: false, grounded: true, dt: 1, ...o }); return pool; };
  const idle = run({});
  assert.ok(idle.count > 0 && idle.count < 10, `idle count ${idle.count}`);
  assert.equal(run({ speed: 0, grounded: false, dt: 1 }).count, 0);
  const off = new ParticlePool(512, () => .5); off.quality = 0;
  emitGroundDust(off, { matrix: m, origin: [0, 0], scale: 1, length: 4, speed: 0, drift: false, grounded: true, dt: 1 });
  assert.equal(off.count, 0);
});
