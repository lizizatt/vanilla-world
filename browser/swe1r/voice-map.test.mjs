import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, filterIds, pickVoice, EVENTS } from './voice-map.js';

test('buildMap groups ids by event, sorted, dropping unknown tags', () => {
  const m = buildMap({ rali003a: 'lap-new', rali001: 'lap-new', raac002: 'finish', x: 'bogus' });
  assert.deepEqual(m, { finish: ['raac002'], 'lap-new': ['rali001', 'rali003a'] });
  assert.deepEqual(buildMap(undefined), {});
  assert.ok(EVENTS.includes('lap-record'));
});

test('filterIds is a case-insensitive prefix filter', () => {
  assert.deepEqual(filterIds(['rali001', 'RAAC001', 'mgsp001'], 'ra'), ['rali001', 'RAAC001']);
  assert.equal(filterIds(['a', 'b']).length, 2);
});

test('pickVoice avoids an immediate repeat and handles empty events', () => {
  const map = { finish: ['a', 'b'], one: ['x'] };
  for (let i = 0; i < 10; i++) assert.equal(pickVoice(map, 'finish', 'a', () => i / 10), 'b');
  assert.equal(pickVoice(map, 'one', 'x'), 'x');
  assert.equal(pickVoice(map, 'none'), null);
  assert.equal(pickVoice(undefined, 'finish'), null);
});
