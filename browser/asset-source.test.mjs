import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { File } from 'node:buffer';
import { openDataSource, mpqHash, mountOrder, ASSET_LIMITS } from './asset-source.js';
import { authorizeDataFolder } from './asset-folder.js';

const table = new Uint32Array(0x500);
let seed = 0x100001;
for (let i = 0; i < 256; i++) for (let j = 0; j < 5; j++) {
  seed = (seed * 125 + 3) % 0x2aaaab; const high = (seed & 65535) << 16;
  seed = (seed * 125 + 3) % 0x2aaaab; table[i + j * 256] = high | (seed & 65535);
}
function encrypt(bytes, key) {
  const out = Buffer.from(bytes);
  let seed = 0xeeeeeeee;
  for (let i = 0; i + 4 <= out.length; i += 4) {
    seed = (seed + table[0x400 + (key & 255)]) >>> 0;
    const plain = out.readUInt32LE(i);
    out.writeUInt32LE((plain ^ ((key + seed) >>> 0)) >>> 0, i);
    key = (((~key << 21) + 0x11111111) | (key >>> 11)) >>> 0;
    seed = (plain + seed + (seed << 5) + 3) >>> 0;
  }
  return out;
}
export function fixture(name, data, { flags = 0x80000200, method = 2, corruptOffsets = false } = {}) {
  const bytes = Buffer.from(data), blockOffset = 112, sectors = [], single = flags & 0x1000000;
  let key = mpqHash(name.replaceAll('/', '\\').split('\\').at(-1), 0x300);
  if (flags & 0x20000) key = ((key + blockOffset) ^ bytes.length) >>> 0;
  for (let i = 0; i < bytes.length; i += single ? bytes.length : 4096) {
    const raw = bytes.subarray(i, single ? bytes.length : i + 4096);
    const compressed = Buffer.concat([Buffer.from([method]), deflateSync(raw)]);
    let sector = flags & 0x200 && compressed.length < raw.length ? compressed : raw;
    if (flags & 0x10000) sector = encrypt(sector, (key + i / 4096) >>> 0);
    sectors.push(sector);
  }
  let stored;
  if (flags & 0x200 && !single && bytes.length) {
    const offsets = Buffer.alloc((sectors.length + 1) * 4);
    let start = offsets.length;
    sectors.forEach((sector, i) => { offsets.writeUInt32LE(start, i * 4); start += sector.length; });
    offsets.writeUInt32LE(corruptOffsets ? 0xffffffff : start, sectors.length * 4);
    stored = Buffer.concat([flags & 0x10000 ? encrypt(offsets, (key - 1) >>> 0) : offsets, ...sectors]);
  } else stored = Buffer.concat(sectors);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x1a51504d); header.writeUInt32LE(32, 4);
  header.writeUInt32LE(blockOffset + stored.length, 8); header.writeUInt16LE(3, 14);
  header.writeUInt32LE(32, 16); header.writeUInt32LE(96, 20);
  header.writeUInt32LE(4, 24); header.writeUInt32LE(1, 28);
  const hashes = Buffer.alloc(64, 255), off = (mpqHash(name, 0) & 3) * 16;
  hashes.writeUInt32LE(mpqHash(name, 0x100), off); hashes.writeUInt32LE(mpqHash(name, 0x200), off + 4);
  hashes.writeUInt32LE(0, off + 8); hashes.writeUInt32LE(0, off + 12);
  const block = Buffer.alloc(16);
  block.writeUInt32LE(blockOffset); block.writeUInt32LE(stored.length, 4);
  block.writeUInt32LE(bytes.length, 8); block.writeUInt32LE(flags, 12);
  return Buffer.concat([header, encrypt(hashes, mpqHash('(hash table)', 0x300)),
    encrypt(block, mpqHash('(block table)', 0x300)), stored]);
}
const entry = (path, bytes) => ({ path, file: new File([bytes], path, { lastModified: 1234 }) });
const code = expected => error => error.code === expected;

test('Storm hashes and native mount precedence, including single-character patch glob', () => {
  assert.equal(mpqHash('(hash table)', 0x300), 0xc3af3770);
  assert.equal(mpqHash('(block table)', 0x300), 0xec83b3a3);
  assert.equal(mpqHash('file.txt', 0), 0x3ea98d7a);
  const paths = ['speech2.MPQ', 'patch-B.MPQ', 'patch-10.MPQ', 'base.MPQ', 'patch.mpq', 'DBC.MPQ', 'patch-a.MPQ', 'enUS/locale.MPQ'];
  assert.deepEqual(mountOrder(paths.map(path => ({ path }))).map(e => e.path),
    ['DBC.MPQ', 'patch.mpq', 'patch-a.MPQ', 'patch-B.MPQ', 'speech2.MPQ']);
});
test('stored, compressed, encrypted, fixed-key, and single-unit extraction', async () => {
  const path = 'World\\Maps\\Test\\Test.wdl';
  for (const flags of [0x80000000, 0x80000200, 0x80010200, 0x80030200, 0x81000200, 0x81030200, 0x80010000, 0x81010000]) {
    const bytes = Buffer.from('synthetic sector payload!'.repeat(421));
    const source = await openDataSource([entry('terrain.MPQ', fixture(path, bytes, { flags }))]);
    assert.deepEqual(Buffer.from(await source.read('world/maps/test/test.WDL')), bytes, flags.toString(16));
    assert(source.stats.maxReadBytes <= ASSET_LIMITS.readBytes);
    await source.close();
    await assert.rejects(source.read(path), code('CLOSED'));
  }
});
test('patches win, deleted files never fall back, queue survives errors', async () => {
  const path = 'dbfilesclient\\map.dbc';
  const base = entry('dbc.MPQ', fixture(path, 'base'));
  const patch = entry('patch.MPQ', fixture(path, 'patch'));
  const source = await openDataSource([patch, base]);
  await assert.rejects(source.read('absent'), code('NOT_FOUND'));
  assert.equal(Buffer.from(await source.read(path)).toString(), 'patch');
  await assert.rejects(source.read('../map.dbc'), code('INVALID_PATH'));
  const deleted = await openDataSource([base, entry('patch.MPQ', fixture(path, '', { flags: 0x82000000 }))]);
  await assert.rejects(deleted.read(path), code('NOT_FOUND'));
  const corrupt = await openDataSource([base, entry('patch.MPQ', fixture(path, 'a'.repeat(9000), { corruptOffsets: true }))]);
  await assert.rejects(corrupt.read(path), code('CORRUPT'));
});
test('sector extraction yields a task to physics without interleaving archive reads', async () => {
  const path='file',bytes=Buffer.from('bounded sector work'.repeat(2000));
  const source=await openDataSource([entry('terrain.MPQ',fixture(path,bytes))]);
  const original=Object.getOwnPropertyDescriptor(globalThis,'performance');
  let now=0,finished=false,observedPending=false;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now+=5}});
  const timer=setInterval(()=>{if(!finished)observedPending=true;},0);
  try {
    const first=source.read(path),second=source.read(path);
    assert.deepEqual(Buffer.from(await first),bytes);
    assert.deepEqual(Buffer.from(await second),bytes);
    finished=true;
    assert(observedPending,'A real task must run before extraction completes');
    assert(source.stats.extractionYields>=4,'Repeated sectors must continue yielding');
  } finally {
    clearInterval(timer);
    Object.defineProperty(globalThis,'performance',original);
    await source.close();
  }
});
test('unsupported codec, truncated archive, oversized asset and indexes fail explicitly', async () => {
  const path = 'file';
  const unsupported = await openDataSource([entry('dbc.MPQ', fixture(path, 'a'.repeat(8000), { method: 8 }))]);
  await assert.rejects(unsupported.read(path), code('UNSUPPORTED'));
  const bytes = fixture(path, 'payload');
  const truncated = await openDataSource([entry('dbc.MPQ', bytes.subarray(0, bytes.length - 1))]);
  await assert.rejects(truncated.read(path), code('CORRUPT'));
  const invalid = Buffer.from(bytes); invalid.writeUInt32LE(0x10000000, 24);
  await assert.rejects(openDataSource([entry('dbc.MPQ', invalid)]), code('LIMIT'));
  const block = Buffer.alloc(16);
  block.writeUInt32LE(112); block.writeUInt32LE(7, 4); block.writeUInt32LE(ASSET_LIMITS.fileBytes + 1, 8);
  block.writeUInt32LE(0x80000000, 12);
  encrypt(block, mpqHash('(block table)', 0x300)).copy(bytes, 96);
  const oversized = await openDataSource([entry('dbc.MPQ', bytes)]);
  await assert.rejects(oversized.read(path), code('LIMIT'));
});
test('metadata identity is stable across enumeration order and changes with the install', async () => {
  const a = entry('dbc.MPQ', fixture('a', 'one')), b = entry('patch.MPQ', fixture('b', 'two'));
  const first = await openDataSource([a, b]), second = await openDataSource([b, a]);
  assert.equal(first.fingerprint, second.fingerprint);
  const changed = await openDataSource([a, entry('patch.MPQ', fixture('b', 'different'))]);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});
test('raw webkitdirectory catalog strips only the selected root', async () => {
  const source = await openDataSource([
    entry('Data/dbc.MPQ', fixture('a', 'base')),
    entry('Data/patch.MPQ', fixture('a', 'patch')),
    entry('Data/backup/patch.MPQ', fixture('a', 'wrong')),
  ]);
  assert.equal(Buffer.from(await source.read('a')).toString(), 'patch');
  assert.deepEqual(source.archives, ['dbc.MPQ', 'patch.MPQ']);
});
test('corrupt zlib checksum, short output, and inflate overflow are rejected', async () => {
  const path = 'file';
  const bytes = fixture(path, 'a'.repeat(3000));
  bytes[bytes.length - 1] ^= 0xff;
  const damaged = await openDataSource([entry('dbc.MPQ', bytes)]);
  await assert.rejects(damaged.read(path), code('CORRUPT'));
  for (const declared of [2999, 3001, 1]) {
    const bytes = fixture(path, 'a'.repeat(3000));
    const block = Buffer.alloc(16);
    block.writeUInt32LE(112); block.writeUInt32LE(bytes.length - 112, 4);
    block.writeUInt32LE(declared, 8); block.writeUInt32LE(0x80000200, 12);
    encrypt(block, mpqHash('(block table)', 0x300)).copy(bytes, 96);
    const source = await openDataSource([entry('dbc.MPQ', bytes)]);
    await assert.rejects(source.read(path), code('CORRUPT'));
  }
});
test('reauthorization never prompts unless explicitly requested by UI', async () => {
  let requested = 0;
  const handle = { kind: 'directory', queryPermission: async () => 'prompt',
    requestPermission: async () => { requested++; return 'granted'; } };
  assert.equal(await authorizeDataFolder(handle), false);
  assert.equal(requested, 0);
  assert.equal(await authorizeDataFolder(handle, { request: true }), true);
  assert.equal(requested, 1);
  handle.requestPermission = async () => 'denied';
  assert.equal(await authorizeDataFolder(handle, { request: true }), false);
});
