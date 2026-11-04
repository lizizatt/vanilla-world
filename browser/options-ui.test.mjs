import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {matchesQuery,loadStored,OPTION_TABS,PERSISTED_IDS,OPTIONS_KEY} from './options-ui.js';

test('search matches every word case-insensitively', () => {
  assert.ok(matchesQuery('Cloud quality','cloud QUAL'));
  assert.ok(!matchesQuery('Cloud quality','rain'));
  assert.ok(matchesQuery('anything',''));
});

test('stored options tolerate junk', () => {
  const store=v=>({getItem:()=>v});
  assert.deepEqual(loadStored(store('nope')),{});
  assert.deepEqual(loadStored(store('[1]')),{});
  assert.deepEqual(loadStored(store('{"clouds":false}')),{clouds:false});
  assert.deepEqual(loadStored({getItem(){throw new Error('x');}}),{});
  assert.equal(OPTIONS_KEY,'racer.options.v1');
});

test('every persisted id and tab has markup; Handling and Wind tuning are always present', async () => {
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  for(const id of PERSISTED_IDS)assert.ok(html.includes(`id="${id}"`),id);
  for(const [id] of OPTION_TABS)assert.ok(html.includes(`data-opt-tab="${id}"`),id);
  assert.ok(html.includes('id="wind-tuning-open"'));
  assert.ok(!/id="tuning-panel"[^>]*hidden/.test(html));
  assert.match(html,/F1 &middot; Controls/);
});
