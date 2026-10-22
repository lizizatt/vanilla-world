import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttach, classifyPickError, BLOCKED_HELP } from './attach.js';
import { cacheKey, cacheFiles, cacheMusic, readerFromCache } from './cache.js';

const memory = () => { const bytes = new Map(), idx = new Map(); return { bytes, idx,
  put: async (n, b, m) => { bytes.set(n, b); idx.set(n, m); }, get: async n => bytes.get(n), index: async () => new Map(idx),
  clear: async () => { bytes.clear(); idx.clear(); } }; };
const file = (path, size, mtime = 1) => ({ name: path.split('/').pop(), webkitRelativePath: path, size, lastModified: mtime, arrayBuffer: async () => new Uint8Array(size).buffer });
const racerFiles = () => [file('Racer/data/lev01/out_modelblock.bin', 8), file('Racer/data/lev01/out_textureblock.bin', 4), file('Racer/data/wavs/22K/SFX_a.wav', 50),
  file('Racer/data/wavs/22K/Voice/raac001.wav', 20), file('Racer/data/wavs/Music/PodLoop1.wav', 999), file('Racer/readme.txt', 1)];

function rig(over = {}) {
  const log = [], status = [], cache = memory(), stored = { handle: undefined };
  const reader = { name: 'r' };
  const deps = { cache, cacheFiles, describe: async () => ({ models: 1, textures: 2, sprites: 3 }),
    handles: { remember: async h => { stored.handle = h; }, restore: async () => stored.handle, forget: async () => { stored.handle = undefined; }, authorize: async () => true },
    fromHandle: async h => (h.good ? reader : null), fromFiles: f => (f.some(x => /out_modelblock/.test(x.webkitRelativePath)) ? reader : null),
    onChange: r => log.push(r), onStatus: (t, ok, x) => status.push({ t, ok, ...x }), ...over };
  return { a: createAttach(deps), log, status, cache, stored, reader };
}

test('cache keys keep only what we use: blocks, 22K wavs (Voice included) and Music', () => {
  assert.equal(cacheKey('X/data/lev01/out_modelblock.bin'), 'out_modelblock.bin');
  assert.equal(cacheKey('X\\data\\wavs\\22K\\Voice\\raac001.wav'), '22k/voice/raac001.wav');
  assert.equal(cacheKey('X/data/wavs/Music/PodLoop1.wav'), 'music/podloop1.wav');
  assert.equal(cacheKey('X/data/images/a.TGA'), null);
});

test('cacheFiles writes wanted files, skips unchanged ones, then a reader serves them', async () => {
  const b = memory(), seen = [];
  const out = await cacheFiles(racerFiles(), b, (n, t) => seen.push([n, t]));
  assert.deepEqual(out, { files: 5, written: 1081 });
  assert.deepEqual(seen.at(-1), [5, 5]);
  assert.equal((await cacheFiles(racerFiles(), b)).written, 0);
  const changed = racerFiles(); changed[2] = file('Racer/data/wavs/22K/SFX_a.wav', 60, 2);
  assert.equal((await cacheFiles(changed, b)).written, 60);
  const r = await readerFromCache(b);
  assert.equal((await r.read('out_modelblock.bin')).length, 8);
  assert.equal((await r.slice('out_modelblock.bin', 2, 4)).length, 2);
  assert.equal((await r.wav('sfx_A')).length, 60);
  assert.equal(await r.wav('nope'), null);
  assert.equal((await r.wav('Music/podloop1')).length, 999);
  assert.equal(await readerFromCache(memory()), null);
});

test('error classification: blocked folders, cancels and denied access all get a clear message', () => {
  assert.equal(classifyPickError(Object.assign(new Error('x'), { name: 'SecurityError' })).kind, 'blocked');
  assert.equal(classifyPickError(new Error("Can't open this folder because it contains system files")).kind, 'blocked');
  const c = classifyPickError(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
  assert.equal(c.kind, 'cancel');
  assert.match(c.message, /mklink \/J/);
  assert.match(BLOCKED_HELP, /Program Files/);
  assert.equal(classifyPickError(Object.assign(new Error('no'), { name: 'NotAllowedError' })).kind, 'denied');
  assert.equal(classifyPickError(new Error('boom')).message, 'boom');
});

test('late attach after the world is running: picker, remember, notify', async () => {
  const { a, log, stored, status, reader } = rig();
  const handle = { good: true };
  await a.pick(async () => handle);
  assert.deepEqual(log, [reader]);
  assert.equal(stored.handle, handle);
  assert.equal(a.source, 'folder');
  assert.equal(status.at(-1).ok, true);
});

test('wrong folder: clear error, no state change; wrong folder while attached keeps the old reader', async () => {
  const { a, log, status, reader } = rig();
  await a.pick(async () => ({ good: false }));
  assert.equal(a.reader, null); assert.deepEqual(log, []);
  assert.match(status.at(-1).t, /out_modelblock/);
  await a.pick(async () => ({ good: true }));
  await a.pick(async () => ({ good: false }));
  assert.equal(a.reader, reader);
  assert.match(status.at(-1).t, /Keeping the current Racer data/);
  assert.equal(log.length, 1);
});

test('blocked folder offers the file fallback; cancel while attached is silent; no picker API asks for the file input', async () => {
  const { a, status } = rig();
  const blocked = Object.assign(new Error('x'), { name: 'SecurityError' });
  await a.pick(async () => { throw blocked; });
  assert.equal(status.at(-1).fallback, true);
  assert.match(status.at(-1).t, /junction/);
  assert.equal(await a.pick(undefined), 'files');
  await a.pickFiles(racerFiles());
  const n = status.length;
  await a.pick(async () => { throw Object.assign(new Error('c'), { name: 'AbortError' }); });
  assert.equal(status.length, n);
});

test('files path attaches immediately and caches; a fresh page restores from the cache without a picker', async () => {
  const first = rig();
  await first.a.pickFiles(racerFiles());
  assert.equal(first.a.source, 'selected files');
  assert.match(first.status.at(-1).t, /cached locally \(5 files\)/);
  const later = rig({ cache: first.cache, handles: { restore: async () => undefined, forget: async () => {}, remember: async () => {}, authorize: async () => false } });
  await later.a.restore();
  assert.equal(later.a.source, 'local cache');
  assert.equal((await later.a.reader.read('out_textureblock.bin')).length, 4);
});

test('remembered handle needing a re-grant, then forget clears handle, cache and listeners', async () => {
  const handle = { good: true };
  let stored = handle, granted = false;
  const { a, log, cache } = rig({ handles: { restore: async () => stored, remember: async () => {}, forget: async () => { stored = undefined; }, authorize: async (_h, ask) => (ask ? (granted = true) : false) } });
  await a.restore();
  assert.equal(a.pending, true);
  assert.equal(a.reader, null);
  await a.pick(undefined);
  assert.equal(granted, true);
  assert.ok(a.reader);
  await cache.put('out_modelblock.bin', new Uint8Array(1), {});
  await a.forget();
  assert.equal(a.reader, null);
  assert.equal(stored, undefined);
  assert.equal(log.at(-1), null);
  assert.equal((await cache.index()).size, 0);
});
test('attaching a second time replaces the reader and notifies again', async () => {
  const r1 = { name: 'one' }, r2 = { name: 'two' };
  let n = 0;
  const { a, log } = rig({ fromHandle: async () => (++n === 1 ? r1 : r2) });
  await a.pick(async () => ({}));
  await a.pick(async () => ({}));
  assert.deepEqual(log, [r1, r2]);
  assert.equal(a.reader, r2);
});

test('music over budget keeps the smallest tracks; handle attach caches named music; reader falls back to the cache; forget clears', async () => {
  const b = memory(), big = 60 * 1024 * 1024;
  const out = await cacheFiles([file('R/data/wavs/Music/a.wav', big), file('R/data/wavs/Music/b.wav', big), file('R/data/wavs/Music/c.wav', 5)], b);
  assert.equal(out.files, 2); assert.ok(b.bytes.has('music/c.wav') && b.bytes.has('music/a.wav') && !b.bytes.has('music/b.wav'));
  const live = { name: 'h', wav: async n => (n === 'Music/PodLoop1' ? new Uint8Array(7) : null) };
  const r = rig({ fromHandle: async () => live, cacheMusic, musicNames: ['Music/PodLoop1', 'Music/Gone'] });
  await r.a.pick(async () => ({}));
  await new Promise(x => setTimeout(x, 20));
  assert.equal(r.cache.bytes.get('music/podloop1.wav').length, 7);
  assert.equal(r.cache.bytes.has('music/gone.wav'), false);
  await r.cache.put('music/later.wav', new Uint8Array(3), { size: 3 });
  assert.equal((await r.a.reader.wav('Music/Later')).length, 3);
  await r.a.forget();
  assert.equal((await r.cache.index()).size, 0);
});
