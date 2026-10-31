// Test-only: a local HTTP server imitating archive.org's response shapes (listing page, per-member redirect to a Range-ignoring
// view_archive endpoint with CORS, raw zip with Range and no CORS) plus a ZIP writer and an in-memory OPFS. Fixture bytes are generated.
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { ARCHIVE_ITEM, zipName } from './archive-manifest.js';
import { crc32 } from './tools/archive-zip.mjs';

export const fixtureBytes = (name, size) => {
  const bytes = new Uint8Array(size);
  let x = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  for (let i = 4; i < size; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; bytes[i] = x >>> 24; }
  bytes.set([0x4d, 0x50, 0x51, 0x1a]);
  return bytes;
};

export function makeZip(entries, { zip64 = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  for (const { name, data, method = 0 } of entries) {
    const body = method === 8 ? deflateRawSync(data) : Buffer.from(data), nameBytes = Buffer.from(name), crc = crc32(0, data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc), u32(body.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes]);
    const sizes = zip64 ? [u32(0xffffffff), u32(0xffffffff)] : [u32(body.length), u32(data.length)];
    const extra = zip64 ? Buffer.concat([u16(1), u16(24), u64(data.length), u64(body.length), u64(offset)]) : Buffer.alloc(0);
    central.push(Buffer.concat([u32(0x02014b50), u16(45), u16(45), u16(0), u16(method), u16(0), u16(0), u32(crc), sizes[0], sizes[1], u16(nameBytes.length),
      u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(zip64 ? 0xffffffff : offset), nameBytes, extra]));
    parts.push(local, body);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const tail = [];
  if (zip64) tail.push(u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(cd.length), u64(offset),
    u32(0x07064b50), u32(0), u64(offset + cd.length), u32(1));
  tail.push(u32(0x06054b50), u16(0), u16(0), u16(zip64 ? 0xffff : entries.length), u16(zip64 ? 0xffff : entries.length), u32(zip64 ? 0xffffffff : cd.length), u32(zip64 ? 0xffffffff : offset), u16(0));
  return Buffer.concat([...parts, cd, ...tail]);
}

/** files: { name: Uint8Array }. options.corrupt: flip a byte in the raw zip; options.truncateMember: stop member responses early. */
export async function startMock(files, { locale = 'enUS', zip64 = false, deflate = [], lieLength = false, truncate = false, badMagic = [] } = {}) {
  const served = new Map(Object.entries(files).map(([name, data]) => {
    if (badMagic.includes(name)) { data = Uint8Array.from(data); data[0] = 0; }
    return [name, data];
  }));
  let zip = makeZip([...files ? Object.entries(files) : []].map(([name, data]) => ({ name: `Data/${name}`, data, method: deflate.includes(name) ? 8 : 0 })), { zip64 });
  const log = [];
  const listing = `<html><table><tr><th>file as jpg</th><th>timestamp</th><th>size</th></tr><tr><td><a href="x">Data/</a></td><td>2026-05-09 21:44</td><td></td></tr>` +
    [...served].map(([name, data]) => `<tr><td><a href="//archive.org/download/${ARCHIVE_ITEM}/${zipName(locale)}/Data%2F${encodeURIComponent(name)}">Data/${name}</a></td><td>2026-05-09 21:42</td><td>${files[name].length}</td></tr>`).join('') +
    `</table></html>`;
  const base = `/download/${ARCHIVE_ITEM}/${zipName(locale)}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname + url.search, range: req.headers.range, origin: req.headers.origin });
    const cors = req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin, 'Access-Control-Allow-Credentials': 'true' } : {};
    if (url.pathname === `${base}/`) { res.writeHead(200, { 'Content-Type': 'text/html', ...cors }).end(listing); return; }
    if (url.pathname === base) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (req.method === 'HEAD') { res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': zip.length }).end(); return; }
      if (!m) { res.writeHead(200, { 'Content-Length': zip.length }).end(zip); return; }
      const start = Number(m[1]), end = Math.min(m[2] === '' ? zip.length - 1 : Number(m[2]), zip.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${zip.length}`, 'Content-Length': end - start + 1 }).end(zip.subarray(start, end + 1));
      return;
    }
    if (url.pathname.startsWith(`${base}/Data%2F`) || url.pathname.startsWith(`${base}/Data/`)) {
      res.writeHead(302, { Location: `/view_archive.php?file=${encodeURIComponent(decodeURIComponent(url.pathname.slice(base.length + 1)))}`, 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }
    if (url.pathname === '/view_archive.php') {
      const data = served.get(url.searchParams.get('file').replace(/^Data\//, ''));
      if (!data) { res.writeHead(404, cors).end(); return; }
      const body = truncate ? data.subarray(0, data.length >> 1) : data;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...(lieLength ? { 'Content-Length': data.length + 1 } : truncate ? { 'Content-Length': body.length } : { 'Content-Length': data.length }), ...cors });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, log, setZip: next => { zip = next; }, get zip() { return zip; }, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

// In-memory OPFS: just enough of FileSystemDirectoryHandle for archive-source.js. Writes commit on close(), like real createWritable.
export function memoryRoot() {
  const makeDir = () => {
    const entries = new Map();
    const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
    const dir = {
      kind: 'directory', entries: async function* () { yield* entries; },
      async getDirectoryHandle(name, { create } = {}) { if (!entries.has(name)) { if (!create) throw notFound(); entries.set(name, makeDir()); } return entries.get(name); },
      async getFileHandle(name, { create } = {}) {
        if (!entries.has(name)) {
          if (!create) throw notFound();
          entries.set(name, { kind: 'file', bytes: new Uint8Array(0) });
        }
        const entry = entries.get(name);
        return Object.assign(entry, {
          getFile: async () => ({ size: entry.bytes.length, text: async () => new TextDecoder().decode(entry.bytes), arrayBuffer: async () => entry.bytes.buffer.slice(0) }),
          createWritable: async () => {
            const chunks = [];
            return { write: async c => { chunks.push(typeof c === 'string' ? new TextEncoder().encode(c) : Uint8Array.from(c)); }, close: async () => { entry.bytes = Buffer.concat(chunks); }, abort: async () => {} };
          },
        });
      },
      async removeEntry(name) { if (!entries.delete(name)) throw notFound(); },
    };
    return dir;
  };
  return makeDir();
}
