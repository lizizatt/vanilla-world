// Minimal ranged ZIP reader (central directory, ZIP64, stored + deflate) for the CLI downloader. Metadata and counting only; never logs content.
import { ArchiveError } from '../archive-manifest.js';

const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export const crc32 = (crc, bytes) => {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
};

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const big = (v, offset) => Number(v.getBigUint64(offset, true));

/** read(start, endInclusive) -> Uint8Array. Returns [{ name, method, crc, csize, usize, headerOffset }]. */
export async function readCentralDirectory(read, totalSize) {
  const tailLength = Math.min(totalSize, 65557 + 20 + 56);
  const tail = await read(totalSize - tailLength, totalSize - 1), tv = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ArchiveError('ZIP', 'End of central directory not found');
  let entries = tv.getUint16(eocd + 10, true), size = tv.getUint32(eocd + 12, true), offset = tv.getUint32(eocd + 16, true);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== 0x07064b50) throw new ArchiveError('ZIP', 'ZIP64 locator not found');
    const start = big(tv, loc + 8);
    const z = view(await read(start, start + 55));
    if (z.getUint32(0, true) !== 0x06064b50) throw new ArchiveError('ZIP', 'ZIP64 end record not found');
    entries = big(z, 32); size = big(z, 40); offset = big(z, 48);
  }
  const cd = await read(offset, offset + size - 1), v = view(cd), out = [];
  for (let p = 0; out.length < entries; ) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== 0x02014b50) throw new ArchiveError('ZIP', 'Corrupt central directory');
    const n = v.getUint16(p + 28, true), e = v.getUint16(p + 30, true), c = v.getUint16(p + 32, true);
    const entry = { name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + n)), method: v.getUint16(p + 10, true), crc: v.getUint32(p + 16, true),
      csize: v.getUint32(p + 20, true), usize: v.getUint32(p + 24, true), headerOffset: v.getUint32(p + 42, true) };
    for (let x = p + 46 + n, end = x + e; x + 4 <= end; ) {
      const id = v.getUint16(x, true), len = v.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (entry.usize === 0xffffffff) { entry.usize = big(v, q); q += 8; }
        if (entry.csize === 0xffffffff) { entry.csize = big(v, q); q += 8; }
        if (entry.headerOffset === 0xffffffff) entry.headerOffset = big(v, q);
      }
      x += 4 + len;
    }
    out.push(entry);
    p += 46 + n + e + c;
  }
  return out;
}

export async function dataOffset(read, entry) {
  const h = view(await read(entry.headerOffset, entry.headerOffset + 29));
  if (h.getUint32(0, true) !== 0x04034b50) throw new ArchiveError('ZIP', `Bad local header for ${entry.name}`);
  return entry.headerOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
}
