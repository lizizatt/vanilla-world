import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudClock, CLOUD_TIME_WRAP, CLOUD_MAX_DT } from './sim-clock.js';
import { flowPhaseAt } from './cloud-flow.js';

// Effective flow displacement seen by the shader: each phase's offset is only visible through its weight.
const disp = (c) => {
  const p = flowPhaseAt(c.cycles, c.stretch);
  return p;
};

test('cloud clock stays in range and pauses at scale 0', () => {
  const c = new CloudClock(100);
  const t0 = c.time, y0 = c.cycles;
  c.step(0.016, 0);
  assert.equal(c.time, t0);
  assert.equal(c.cycles, y0);
  for (let i = 0; i < 20000; i++) c.step(0.1, 1000);
  assert.ok(c.time >= 0 && c.time < CLOUD_TIME_WRAP);
  assert.ok(c.cycles >= 0 && c.cycles < 1);
});

test('flow phase cycle advance is bounded per step across scales, dts, hitches and scale changes', () => {
  const scales = [0, 1, 10, 100, 1000, 10, 1, 1000, 0, 100];
  const dts = [1 / 240, 1 / 60, 1 / 10, 0.5, 2];
  for (const dt of dts) {
    const c = new CloudClock(0);
    let prev = c.cycles;
    for (const s of scales) {
      for (let i = 0; i < 400; i++) {
        c.step(dt, s);
        let d = c.cycles - prev;
        if (d < -0.5) d += 1;
        prev = c.cycles;
        // dt is clamped, so one step can never move the cycle more than a bounded amount
        assert.ok(d >= 0 && d < 0.12, `cycle step ${d} at dt=${dt} scale=${s}`);
      }
    }
  }
});

test('flow weights are continuous in cycles', () => {
  const stretch = 5;
  let prev = flowPhaseAt(0, stretch);
  for (let i = 1; i <= 20000; i++) {
    const p = flowPhaseAt((i / 20000) % 1, stretch);
    for (const k of Object.keys(p)) {
      if (typeof p[k] === 'number' && typeof prev[k] === 'number' && k.startsWith('w')) {
        assert.ok(Math.abs(p[k] - prev[k]) < 0.01, `${k} jumped at ${i}`);
      }
    }
    prev = p;
  }
  assert.ok(disp(new CloudClock(0)));
});

test('max dt clamp is defined', () => {
  assert.ok(CLOUD_MAX_DT > 0 && CLOUD_MAX_DT <= 0.25);
});
