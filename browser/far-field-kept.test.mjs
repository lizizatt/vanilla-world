import test from 'node:test';
import assert from 'node:assert/strict';
import {viewFrom} from './body-sky.js';
import {AZEROTH,ELUNE} from './bodies.js';

// The far-field look of the non-active body (globe disc, far shell) lives in the shared-space frame; body scoping of tracks/near content must never remove it.
test('each body\'s shared-space frame still carries the other body as a far sphere', () => {
  const onElune=viewFrom(ELUNE,1560),onAzeroth=viewFrom(AZEROTH,1560);
  assert.ok(onElune.moons.some(m=>m.radius===AZEROTH.radius&&m.position.every(Number.isFinite)));
  assert.ok(onAzeroth.moons.some(m=>m.radius===ELUNE.radius&&m.position.every(Number.isFinite)));
});
