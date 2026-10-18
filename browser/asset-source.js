// Storm hashing/decryption and mount order mirror benilla-mpq and benilla-formats::Chain.
// Archive data stays in File objects; only indexes and a bounded read window enter memory.
export class AssetError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'AssetError';
    this.code = code;
  }
}

export const ASSET_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  indexBytes: 64 * 1024 * 1024,
  totalIndexBytes: 128 * 1024 * 1024,
  readBytes: 1024 * 1024,
  sectorBytes: 1024 * 1024,
  headerSearchBytes: 1024 * 1024,
});
const fail = (code, message) => { throw new AssetError(code, message); };
const BASE = ['dbc', 'speech', 'fonts', 'interface', 'misc', 'sound', 'wmo', 'terrain', 'texture', 'model'];
const COMPRESS = 0x200, IMPLODE = 0x100, ENCRYPTED = 0x10000, FIX_KEY = 0x20000;
const SINGLE = 0x1000000, DELETED = 0x2000000, EXISTS = 0x80000000;
const crypt = new Uint32Array(0x500);
let seed = 0x100001;
for (let i = 0; i < 256; i++) {
  for (let j = 0; j < 5; j++) {
    seed = (seed * 125 + 3) % 0x2aaaab;
    const high = (seed & 0xffff) << 16;
    seed = (seed * 125 + 3) % 0x2aaaab;
    crypt[i + j * 256] = high | (seed & 0xffff);
  }
}
const encoder = new TextEncoder();
export function mpqHash(name, kind) {
  let a = 0x7fed7fed, b = 0xeeeeeeee;
  for (let ch of encoder.encode(name)) {
    if (ch === 47) ch = 92;
    if (ch >= 97 && ch <= 122) ch -= 32;
    a = (crypt[kind + ch] ^ ((a + b) >>> 0)) >>> 0;
    b = (ch + a + b + (b << 5) + 3) >>> 0;
  }
  return a;
}
function decrypt(bytes, key) {
  const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = 0xeeeeeeee;
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    s = (s + crypt[0x400 + (key & 255)]) >>> 0;
    const value = (words.getUint32(i, true) ^ ((key + s) >>> 0)) >>> 0;
    words.setUint32(i, value, true);
    key = (((~key << 21) + 0x11111111) | (key >>> 11)) >>> 0;
    s = (value + s + (s << 5) + 3) >>> 0;
  }
  return bytes;
}
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (bytes, offset) => view(bytes).getUint32(offset, true);
const asciiLower = name => name.replace(/[A-Z]/g, ch => ch.toLowerCase());
export function normalizeGamePath(path) {
  if (typeof path !== 'string' || !path || /[\0-\x1f]/.test(path)) fail('INVALID_PATH', 'Expected a game asset path');
  const parts = path.replaceAll('/', '\\').split('\\');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) fail('INVALID_PATH', `Invalid game path: ${path}`);
  return asciiLower(parts.join('\\'));
}

// Vanilla mounts root files only, not expansion locale subdirectories. speech2 wins last.
export function mountOrder(catalog) {
  const root = catalog.filter(({ path }) => !/[\\/]/.test(path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const find = name => root.find(entry => asciiLower(entry.path) === name);
  return [...BASE.map(name => find(`${name}.mpq`)), find('patch.mpq'),
    ...root.filter(({ path }) => /^patch-.\.mpq$/i.test(path)).sort((a, b) =>
      asciiLower(a.path) < asciiLower(b.path) ? -1 : asciiLower(a.path) > asciiLower(b.path) ? 1 : 0),
    find('speech2.mpq')].filter(Boolean);
}

export async function catalogDataFolder(handle) {
  if (handle?.kind !== 'directory') fail('INVALID_FOLDER', 'Select the WoW 1.12 Data folder');
  try {
    const catalog = [];
    for await (const [path, entry] of handle.entries()) {
      if (entry.kind === 'file' && /\.mpq$/i.test(path)) catalog.push({ path, file: await entry.getFile() });
    }
    return catalog;
  } catch (error) {
    throw new AssetError(error.name === 'NotAllowedError' ? 'PERMISSION' : 'IO', 'Cannot read the selected Data folder', error);
  }
}

class Archive {
  constructor(entry, stats) {
    this.name = entry.path;
    this.file = entry.file;
    this.stats = stats;
    this.window = null;
  }
  async bytes(offset, length, cached = false) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.file.size)
      fail('CORRUPT', `${this.name}: read outside archive (${offset}+${length})`);
    if (length > ASSET_LIMITS.indexBytes) fail('LIMIT', `${this.name}: read exceeds index limit`);
    if (cached && this.window && offset >= this.window.offset && offset + length <= this.window.offset + this.window.bytes.length) {
      const start = offset - this.window.offset;
      return this.window.bytes.slice(start, start + length);
    }
    if (cached && length <= ASSET_LIMITS.readBytes) {
      const size = Math.min(ASSET_LIMITS.readBytes, this.file.size - offset);
      this.window = { offset, bytes: await this.bytes(offset, size) };
      this.stats.windowBytes = Math.max(this.stats.windowBytes, size);
      return this.window.bytes.slice(0, length);
    }
    const output = new Uint8Array(length);
    for (let start = 0; start < length; start += ASSET_LIMITS.readBytes) {
      const end = Math.min(start + ASSET_LIMITS.readBytes, length);
      let bytes;
      try {
        bytes = new Uint8Array(await this.file.slice(offset + start, offset + end).arrayBuffer());
      } catch (error) {
        throw new AssetError(error.name === 'NotAllowedError' ? 'PERMISSION' : 'IO', `${this.name}: reading archive`, error);
      }
      if (bytes.length !== end - start) fail('CORRUPT', `${this.name}: truncated read`);
      output.set(bytes, start);
      this.stats.readCalls++;
      this.stats.readBytes += bytes.length;
      this.stats.maxReadBytes = Math.max(this.stats.maxReadBytes, bytes.length);
    }
    return output;
  }
  async open() {
    const probe = await this.bytes(0, Math.min(this.file.size, ASSET_LIMITS.headerSearchBytes));
    let base = -1;
    for (let off = 0; off + 4 <= probe.length; off += 512) {
      const signature = u32(probe, off);
      if (signature === 0x1a51504d) { base = off; break; }
      if (signature === 0x1b51504d) {
        if (off + 12 > probe.length) fail('CORRUPT', `${this.name}: truncated user header`);
        base = off + u32(probe, off + 8);
        break;
      }
    }
    if (base < 0) fail('UNSUPPORTED', `${this.name}: no MPQ header in first 1 MiB`);
    const header = await this.bytes(base, 32);
    if (u32(header, 0) !== 0x1a51504d) fail('CORRUPT', `${this.name}: invalid MPQ header`);
    const version = view(header).getUint16(12, true);
    const shift = view(header).getUint16(14, true);
    if (version > 1) fail('UNSUPPORTED', `${this.name}: MPQ version ${version}`);
    if (shift > 11) fail('LIMIT', `${this.name}: sector size exceeds 1 MiB`);
    this.sectorSize = 512 * 2 ** shift;
    this.base = base;
    let hashPos = u32(header, 16), blockPos = u32(header, 20);
    if (version === 1) {
      const extended = await this.bytes(base + 32, 12);
      if (view(extended).getBigUint64(0, true) !== 0n) fail('UNSUPPORTED', `${this.name}: extended block offsets`);
      hashPos += view(extended).getUint16(8, true) * 2 ** 32;
      blockPos += view(extended).getUint16(10, true) * 2 ** 32;
    }
    const hashCount = u32(header, 24), blockCount = u32(header, 28);
    if (!hashCount || (hashCount & (hashCount - 1))) fail('CORRUPT', `${this.name}: hash count is not a power of two`);
    const indexBytes = (hashCount + blockCount) * 16;
    if (indexBytes > ASSET_LIMITS.indexBytes || this.stats.indexBytes + indexBytes > ASSET_LIMITS.totalIndexBytes)
      fail('LIMIT', `${this.name}: archive indexes exceed memory budget`);
    this.hashes = decrypt(await this.bytes(base + hashPos, hashCount * 16), mpqHash('(hash table)', 0x300));
    this.blocks = decrypt(await this.bytes(base + blockPos, blockCount * 16), mpqHash('(block table)', 0x300));
    this.stats.indexBytes += indexBytes;
  }
  find(path) {
    const count = this.hashes.length / 16, start = mpqHash(path, 0) & (count - 1);
    const a = mpqHash(path, 0x100), b = mpqHash(path, 0x200);
    for (let i = 0; i < count; i++) {
      const off = ((start + i) % count) * 16, index = u32(this.hashes, off + 12);
      if (index === 0xffffffff) return null;
      if (index === 0xfffffffe) continue;
      // Native Chain's vanilla indexes are locale-neutral: first matching hash wins.
      if (u32(this.hashes, off) === a && u32(this.hashes, off + 4) === b) {
        if (index >= this.blocks.length / 16) fail('CORRUPT', `${this.name}: block index outside table`);
        const pos = index * 16;
        return { offset: u32(this.blocks, pos), packed: u32(this.blocks, pos + 4),
          size: u32(this.blocks, pos + 8), flags: u32(this.blocks, pos + 12) };
      }
    }
    return null;
  }
  async decode(raw, want, flags, path) {
    if (raw.length === want) return raw;
    if (!raw.length || raw.length > want) fail('CORRUPT', `${path}: invalid packed sector length`);
    const method = flags & COMPRESS ? raw[0] : 0x08;
    if (method !== 0x02) fail('UNSUPPORTED', `${path}: MPQ sector codec 0x${method.toString(16)}`);
    if (typeof DecompressionStream === 'undefined') fail('UNSUPPORTED', 'This browser lacks zlib DecompressionStream');
    // Small compressed chunks also bound the native inflater's output between cancellation points.
    let position = 1;
    const input = new ReadableStream({
      pull(controller) {
        if (position === raw.length) { controller.close(); return; }
        const end = Math.min(position + 1024, raw.length);
        controller.enqueue(raw.subarray(position, end));
        position = end;
      },
    });
    const reader = input.pipeThrough(new DecompressionStream('deflate')).getReader();
    const output = new Uint8Array(want);
    let used = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (used + value.length > want) {
          await reader.cancel();
          fail('CORRUPT', `${path}: zlib output exceeds declared sector size`);
        }
        output.set(value, used);
        used += value.length;
      }
    } catch (error) {
      if (error instanceof AssetError) throw error;
      throw new AssetError('CORRUPT', `${path}: invalid zlib stream`, error);
    } finally { reader.releaseLock(); }
    if (used !== want) fail('CORRUPT', `${path}: short decompressed sector (${used}, expected ${want})`);
    return output;
  }
  async read(path, block, defer) {
    const { offset, packed, size, flags } = block;
    if (!(flags & EXISTS) || flags & DELETED) fail('NOT_FOUND', `${path}: deleted by ${this.name}`);
    if (flags & 0x00100000) fail('UNSUPPORTED', `${path}: incremental MPQ patch`);
    if (size > ASSET_LIMITS.fileBytes || packed > ASSET_LIMITS.fileBytes) fail('LIMIT', `${path}: asset exceeds 64 MiB`);
    if (this.base + offset + packed > this.file.size) fail('CORRUPT', `${path}: block outside archive`);
    if (!size) return new Uint8Array();
    const compressed = flags & (COMPRESS | IMPLODE);
    let key = mpqHash(path.slice(path.lastIndexOf('\\') + 1), 0x300);
    if (flags & FIX_KEY) key = ((key + offset) ^ size) >>> 0;
    const count = Math.ceil(size / this.sectorSize);
    if (flags & SINGLE) {
      let raw = await this.bytes(this.base + offset, packed);
      if (flags & ENCRYPTED) raw = decrypt(raw, key);
      if (compressed) return this.decode(raw, size, flags, path);
      if (raw.length !== size) fail('CORRUPT', `${path}: stored size mismatch`);
      return raw;
    }
    const output = new Uint8Array(size);
    let offsets;
    if (compressed) {
      const tableBytes = (count + 1) * 4;
      if (tableBytes > packed) fail('CORRUPT', `${path}: short sector table`);
      offsets = await this.bytes(this.base + offset, tableBytes, true);
      if (flags & ENCRYPTED) decrypt(offsets, (key - 1) >>> 0);
      if (u32(offsets, 0) < tableBytes) fail('CORRUPT', `${path}: sectors overlap offset table`);
    } else if (packed !== size) fail('CORRUPT', `${path}: stored size mismatch`);
    let yielded = performance.now();
    for (let i = 0; i < count; i++) {
      if(defer?.())fail('DEFERRED',`${path}: optional extraction yielded to queued assets`);
      // Resolved sector promises otherwise starve the worker's queued physics messages.
      if (performance.now() - yielded >= (defer?1:4)) {
        if(defer&&globalThis.scheduler?.postTask)await scheduler.postTask(()=>{},{priority:'background'});
        else await new Promise(resolve => setTimeout(resolve, 0));
        this.stats.extractionYields++;
        yielded = performance.now();
      }
      const want = Math.min(this.sectorSize, size - i * this.sectorSize);
      const start = offsets ? u32(offsets, i * 4) : i * this.sectorSize;
      const end = offsets ? u32(offsets, (i + 1) * 4) : start + want;
      if (end <= start || end > packed || end - start > want) fail('CORRUPT', `${path}: invalid sector ${i} offsets`);
      let raw = await this.bytes(this.base + offset + start, end - start, true);
      if (flags & ENCRYPTED) decrypt(raw, (key + i) >>> 0);
      if (compressed) raw = await this.decode(raw, want, flags, path);
      output.set(raw, i * this.sectorSize);
    }
    return output;
  }
}

export async function openDataSource(input) {
  let catalog = Array.isArray(input) ? input : await catalogDataFolder(input);
  for (const entry of catalog) {
    if (!entry || typeof entry.path !== 'string' || !entry.file || !Number.isSafeInteger(entry.file.size) ||
        entry.file.size < 0 || typeof entry.file.slice !== 'function')
      fail('INVALID_FOLDER', 'Expected a structured-cloned {path, file} catalog');
  }
  // webkitdirectory includes the selected root in every relative path; handle catalogs do not.
  const root = catalog[0]?.path.replaceAll('\\', '/').split('/');
  if (root?.length > 1 && catalog.every(({ path }) => path.replaceAll('\\', '/').startsWith(`${root[0]}/`)))
    catalog = catalog.map(entry => ({ ...entry, path: entry.path.replaceAll('\\', '/').slice(root[0].length + 1) }));
  const selected = mountOrder(catalog);
  if (!selected.length) fail('INVALID_FOLDER', 'No known WoW 1.12 MPQs in this folder; select Data, not the install parent');
  const stats = { indexBytes: 0, readBytes: 0, readCalls: 0, maxReadBytes: 0, windowBytes: 0, extractionYields: 0 };
  const archives = [];
  for (const entry of selected) {
    const archive = new Archive(entry, stats);
    await archive.open();
    archives.push(archive);
  }
  const identity = JSON.stringify(selected.map(({ path, file }) => [path, file.size, file.lastModified ?? 0]));
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(identity));
  const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let closed = false, tail = Promise.resolve(),foregroundReads=0;
  const read = (path,{background=false,shouldDefer}={}) => {
    if(!background)foregroundReads++;
    const defer=background?()=>foregroundReads>0||!!shouldDefer?.():undefined;
    // Serialize extraction so simultaneous scene requests cannot multiply decode buffers.
    const pending = tail.then(async () => {
      if (closed) fail('CLOSED', 'Data source is closed');
      if(defer?.())fail('DEFERRED','Optional extraction yielded to queued assets');
      const normalized = normalizeGamePath(path);
      for (let i = archives.length - 1; i >= 0; i--) {
        const block = archives[i].find(normalized);
        if (block) {
          try { return await archives[i].read(normalized, block,defer); }
          finally { archives[i].window = null; }
        }
      }
      fail('NOT_FOUND', `File not in Data patch chain: ${path}`);
    });
    tail = pending.then(() => undefined, () => undefined);
    return pending.finally(()=>{if(!background)foregroundReads--;});
  };
  return {
    read, fingerprint, archives: selected.map(({ path }) => path), stats,
    close() {
      closed = true;
      return tail.then(() => { archives.length = 0; stats.indexBytes = 0; });
    },
  };
}
