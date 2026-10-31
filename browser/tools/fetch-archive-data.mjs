// CLI variant of the optional archive.org data source: downloads the needed MPQs into a Data folder you then pick in the app.
//   ARCHIVE_DATA_SOURCE=1 node browser/tools/fetch-archive-data.mjs --out <folder> --yes [--audio] [--locale enUS]
// Same lever as the browser option: without ARCHIVE_DATA_SOURCE=1 it refuses and makes no network request.
// Unlike a browser it can read the raw zip with Range requests (no CORS), so it resumes partial files and verifies each member's zip CRC-32.
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { ArchiveError, ARCHIVE_ITEM, ARCHIVE_ORIGIN, AUDIO_FILES, CORE_FILES, DEFAULT_LOCALE, PINNED_SIZES, ZIP_FACTS, zipName } from '../archive-manifest.js';
import { crc32, dataOffset, readCentralDirectory } from './archive-zip.mjs';

export const CLI_NOTICE = [
  'Unofficial fan project, not affiliated with or endorsed by Blizzard Entertainment.',
  'You are responsible for having the right to use this content.',
  'Files are downloaded directly from archive.org to this computer only; nothing is hosted or proxied by this project.',
].join('\n');

export function parseArgs(argv) {
  const options = { out: undefined, locale: DEFAULT_LOCALE, audio: false, yes: false, origin: ARCHIVE_ORIGIN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audio') options.audio = true;
    else if (a === '--yes') options.yes = true;
    else if (a === '--out' || a === '--locale' || a === '--origin') options[a.slice(2)] = argv[++i];
    else throw new ArchiveError('USAGE', `Unknown argument ${a}`);
  }
  return options;
}

async function fileCrc(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let crc = 0;
    for (let n; (n = (await handle.read(buffer, 0, buffer.length, null)).bytesRead) > 0; ) crc = crc32(crc, buffer.subarray(0, n));
    return crc;
  } finally { await handle.close(); }
}

export async function fetchArchiveData({ env = process.env, argv = [], fetch: fetcher = globalThis.fetch, log = console.log, pinnedSizes = PINNED_SIZES, zipFacts = ZIP_FACTS } = {}) {
  if (env.ARCHIVE_DATA_SOURCE !== '1') throw new ArchiveError('DISABLED', 'The archive.org data source is off. Set ARCHIVE_DATA_SOURCE=1 to enable it.');
  const options = parseArgs(argv);
  log(CLI_NOTICE);
  if (!options.yes) throw new ArchiveError('USAGE', 'Re-run with --yes to confirm the notice above.');
  if (!options.out) throw new ArchiveError('USAGE', 'Pass --out <folder> (the Data folder to create).');
  const url = `${options.origin}/download/${ARCHIVE_ITEM}/${zipName(options.locale)}`;
  const head = await fetcher(url, { method: 'HEAD', redirect: 'follow' });
  const total = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isSafeInteger(total) || total <= 0) throw new ArchiveError('HTTP', `archive.org HEAD answered ${head.status}`);
  const facts = zipFacts[options.locale];
  if (facts && facts.size !== total) throw new ArchiveError('INTEGRITY', `Zip is ${total} bytes, expected ${facts.size}`);
  const read = async (start, end) => {
    const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (response.status !== 206) throw new ArchiveError('RANGE', `Server ignored the Range request (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const entries = new Map((await readCentralDirectory(read, total)).map(e => [e.name, e]));
  const names = options.audio ? [...CORE_FILES, ...AUDIO_FILES] : [...CORE_FILES];
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });
  const results = [];
  for (const name of names) {
    const entry = entries.get(`Data/${name}`);
    if (!entry) throw new ArchiveError('MISSING', `Zip has no Data/${name}`);
    const pinned = options.locale === DEFAULT_LOCALE ? pinnedSizes[name] : undefined;
    if (pinned !== undefined && pinned !== entry.usize) throw new ArchiveError('INTEGRITY', `Data/${name}: ${entry.usize} bytes, expected ${pinned}`);
    const target = join(out, name), part = `${target}.part`;
    if (await stat(target).then(s => s.size === entry.usize && fileCrc(target).then(c => c === entry.crc), () => false)) { log(`ok (kept) ${name}`); results.push(name); continue; }
    const start = await dataOffset(read, entry);
    const have = entry.method === 0 ? await stat(part).then(s => Math.min(s.size, entry.csize), () => 0) : 0;
    if (have < entry.csize) {
      const response = await fetcher(url, { headers: { Range: `bytes=${start + have}-${start + entry.csize - 1}` } });
      if (response.status !== 206 || !response.body) throw new ArchiveError('RANGE', `Cannot range-read ${name} (${response.status})`);
      const sink = createWriteStream(part, { flags: have ? 'a' : 'w' });
      const source = Readable.fromWeb(response.body);
      if (entry.method === 0) await pipeline(source, sink);
      else if (entry.method === 8) await pipeline(source, createInflateRaw(), sink);
      else throw new ArchiveError('ZIP', `${name}: unsupported compression method ${entry.method}`);
    }
    if ((await stat(part)).size !== entry.usize || await fileCrc(part) !== entry.crc) {
      await rm(part, { force: true });
      throw new ArchiveError('INTEGRITY', `${name}: size or CRC-32 mismatch; partial file removed, run again`);
    }
    await rename(part, target);
    log(`ok ${name}`);
    results.push(name);
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  fetchArchiveData({ argv: process.argv.slice(2) }).catch(error => { console.error(error.message); process.exitCode = error.code === 'DISABLED' ? 2 : 1; });
}
