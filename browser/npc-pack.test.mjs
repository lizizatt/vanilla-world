import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTrimmed, resolveModels, loadPopulation } from './npc-pack.js';
import { validatePopulation } from './scene-stream.js';
import { npcPack } from './build-dist.mjs';

const trimmed = () => ({ version: 1, format: 'npc-trimmed-v1', provenance: { redistribution: 'public-trimmed', source: 's' },
  spawns: [[0, 9, 12, -23, 30, 578, 125], [1, 5, 0, 0, 0, 0, 100], [1, 77, 5, 5, 5, 5, 100]] });
const res = (body, ok = true, type = 'application/json', status = ok ? 200 : 404) => ({ ok, status, headers: { get: () => type }, json: async () => body });
const source = { read: async () => new Uint8Array(1) };
const wasm = { scene_resolve_displays: (_m, _d, _e, ids) => JSON.stringify(Object.fromEntries([...ids].filter(i => i !== 77).map(i => [i, { path: 'Creature\\A\\A.mdx', scale: 1, skins: [null, null, null, null] }]))) };

test('trimmed pack decodes to runtime spawns with index ids and unquantised units', () => {
  const p = decodeTrimmed(trimmed());
  assert.deepEqual(p.spawns[0], { id: 0, map: 0, displayId: 9, position: [1.2, -2.3, 3], orientation: 5.78, scale: 1.25 });
  assert.throws(() => decodeTrimmed({ ...trimmed(), format: 'x' }), /Invalid trimmed/);
  assert.throws(() => decodeTrimmed({ ...trimmed(), spawns: [[1, 2]] }), /Invalid trimmed NPC spawn/);
  assert.throws(() => decodeTrimmed({ ...trimmed(), provenance: { redistribution: 'private-local-only' } }), /Invalid trimmed/);
});

test('models resolve from the user DBCs, unresolved displays drop, and the result validates', async () => {
  const p = await resolveModels(decodeTrimmed(trimmed()), source, wasm);
  assert.equal(p.spawns.length, 2);
  assert.equal(validatePopulation(p).size > 0, true);
});

test('loader: private pack wins on loopback, hosted trimmed pack is the fallback, absence or HTML is silent, private 5xx still throws', async () => {
  const priv = { version: 1, marker: 'private' };
  const fetchFn = routes => async url => { const r = routes[url]; if (r instanceof Error) throw r; return r ?? res('', false, 'text/plain'); };
  assert.equal((await loadPopulation({ fetchFn: fetchFn({ './local/npc-spawns.json': res(priv), './npc-pack.json': res(trimmed()) }), loopback: true, source, wasm })).marker, 'private');
  assert.equal((await loadPopulation({ fetchFn: fetchFn({ './npc-pack.json': res(trimmed()) }), loopback: true, source, wasm })).spawns.length, 2);
  assert.equal((await loadPopulation({ fetchFn: fetchFn({ './npc-pack.json': res(trimmed()) }), loopback: false, source, wasm })).spawns.length, 2);
  assert.equal(await loadPopulation({ fetchFn: fetchFn({}), loopback: false, source, wasm }), undefined);
  assert.equal(await loadPopulation({ fetchFn: fetchFn({ './npc-pack.json': res('<html>', true, 'text/html') }), loopback: false, source, wasm }), undefined);
  assert.equal(await loadPopulation({ fetchFn: fetchFn({ './npc-pack.json': res({ junk: 1 }) }), loopback: false, source, wasm }), undefined);
  await assert.rejects(loadPopulation({ fetchFn: fetchFn({ './local/npc-spawns.json': res('', false, 'text/plain', 500) }), loopback: true, source, wasm }), /HTTP 500/);
});

test('dist includes the trimmed pack only when asked, only if present, and never a private pack', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'npc-'));
  const path = join(dir, 'npc-pack.json');
  assert.equal(await npcPack({ INCLUDE_NPC_PACK: '1' }, path), null);
  await writeFile(path, JSON.stringify(trimmed()));
  assert.equal(await npcPack({}, path), null);
  assert.ok(await npcPack({ INCLUDE_NPC_PACK: '1' }, path));
  await writeFile(path, JSON.stringify({ version: 1, provenance: { redistribution: 'private-local-only' }, spawns: [] }));
  await assert.rejects(npcPack({ INCLUDE_NPC_PACK: '1' }, path), /non-trimmed/);
});
