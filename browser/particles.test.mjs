import test from 'node:test';
import assert from 'node:assert/strict';
import {ParticlePool, QUALITY, KINDS, gradient, particleUniform, particleShader} from './particles.js';

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
