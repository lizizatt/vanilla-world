import test from 'node:test';
import assert from 'node:assert/strict';
import { viewPose, pixelStats, modelChecks, VIEWS } from './pod-render-lib.mjs';

test('view poses look at the craft from the requested side', () => {
  const craft = [10, 5, 20, 0];
  const look = p => [-Math.sin(p[3]) * Math.cos(p[4]), Math.sin(p[4]), -Math.cos(p[3]) * Math.cos(p[4])];
  for (const v of VIEWS) {
    const p = viewPose(craft, v, 10), l = look(p), to = [10 - p[0], 5.8 - p[1], 20 - p[2]], n = Math.hypot(...to);
    to.forEach((c, i) => assert.ok(Math.abs(c / n - l[i]) < 1e-6, `${v} aims at craft`));
  }
  assert.ok(viewPose(craft, 'front', 10)[2] < 20, 'front camera is ahead (-z at yaw 0)');
  assert.ok(viewPose(craft, 'rear', 10)[2] > 20);
  assert.ok(viewPose(craft, 'side', 10)[0] < 10, 'side camera is on the left');
  assert.ok(viewPose(craft, 'top', 10)[1] > 14);
  assert.throws(() => viewPose(craft, 'under', 1));
});

test('pixel stats flag blank frames and magenta fallback', () => {
  assert.equal(pixelStats(new Uint8ClampedArray([5, 5, 5, 255, 5, 5, 5, 255])).flat, true);
  const s = pixelStats(new Uint8ClampedArray([255, 0, 255, 255, 0, 0, 0, 255]));
  assert.equal(s.magentaFraction, .5);
  assert.equal(s.flat, false);
});

test('model checks catch NaN, empty and reversed pods', () => {
  const asset = (pts, idx) => ({ vertices: Float32Array.from(pts.flatMap(p => [...p, 0, 0, 1, 0, 0, 1, 1, 1, 1])), indices: Uint32Array.from(idx) });
  assert.deepEqual(modelChecks(asset([[-2, 0, 0], [6, 1, 0], [0, -1, 2]], [0, 1, 2])).defects, []);
  assert.match(modelChecks(asset([[-6, 0, 0], [2, 1, 0], [0, -1, 2]], [0, 1, 2])).warnings[0], /engines do not lead/);
  assert.match(modelChecks(asset([[NaN, 0, 0], [6, 1, 0], [0, -1, 2]], [0, 1, 2])).defects[0], /non-finite/);
  assert.ok(modelChecks(asset([[0, 0, 0]], [])).defects.includes('no triangles'));
});
