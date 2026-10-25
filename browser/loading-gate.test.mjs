import test from 'node:test';
import assert from 'node:assert/strict';
import { nearChunksReady, NEAR_TIMEOUT_MS } from './loading-gate.js';

test('waits for the first handful of nearby chunks, bounded by a timeout', () => {
  assert.equal(nearChunksReady({ total: 9, resident: 3 }, 0), false);
  assert.equal(nearChunksReady({ total: 9, resident: 4 }, 0), true);
  assert.equal(nearChunksReady({ total: 2, resident: 2 }, 0), true, 'edge of the world needs fewer');
  assert.equal(nearChunksReady({ total: 0, resident: 0 }, 0), true);
  assert.equal(nearChunksReady({ total: 9, resident: 0 }, NEAR_TIMEOUT_MS), true, 'timeout releases');
  assert.equal(nearChunksReady(undefined, 0), true, 'older engines report nothing');
});
