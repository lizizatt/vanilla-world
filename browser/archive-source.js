// Optional archive.org data source (spike). Only reachable when the deploy flag in archive-flag.js is stamped on; see design/data-hosting-research.md.
// Fetches whole files (never ranges: archive.org's per-member endpoint ignores Range) straight from archive.org into the user's own OPFS.
// Nothing is proxied or hosted by us, and no fetched bytes are ever logged.
import {
  ArchiveError, CORE_FILES, AUDIO_FILES, DEFAULT_LOCALE, ARCHIVE_ORIGIN, listingUrl, memberUrl, parseListing, planFiles,
} from './archive-manifest.js';

export const CACHE_DIR = 'wow-archive-data';
const STATE = 'archive-state.json';
const MPQ_MAGIC = [0x4d, 0x50, 0x51, 0x1a];
const FETCH_OPTIONS = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };

export const NOTICE = Object.freeze([
  'This is an unofficial fan project. It is not affiliated with or endorsed by Blizzard Entertainment.',
  'You are responsible for having the right to use this content. We do not grant you any rights to it.',
  'The files are fetched directly from archive.org into your browser and stored only on this device (browser storage). Nothing is hosted, proxied or uploaded by us.',
  'The download is about 4.5 GB (about 5.4 GB with audio) and can take a long time. You can cancel and resume; finished files are kept.',
]);

const ioError = (message, cause) => new ArchiveError('IO', message, cause);

async function cacheDirectory(root, create) {
  try { return await root.getDirectoryHandle(CACHE_DIR, { create }); }
  catch (error) { if (!create && error.name === 'NotFoundError') return null; throw ioError('Cannot open browser storage for the downloaded data', error); }
}
async function readState(dir, locale) {
  try {
    const state = JSON.parse(await (await (await dir.getFileHandle(STATE)).getFile()).text());
    return state.locale === locale && state.files && typeof state.files === 'object' ? state.files : {};
  } catch { return {}; }
}
async function writeState(dir, locale, files) {
  const writable = await (await dir.getFileHandle(STATE, { create: true })).createWritable();
  await writable.write(JSON.stringify({ locale, files }));
  await writable.close();
}

export async function fetchListing({ fetch: fetcher = globalThis.fetch, locale = DEFAULT_LOCALE, origin = ARCHIVE_ORIGIN, signal } = {}) {
  let response;
  try { response = await fetcher(listingUrl(locale, origin), { ...FETCH_OPTIONS, signal }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new ArchiveError('NETWORK', 'Cannot reach archive.org (offline, blocked, or the server does not allow this site)', error); }
  if (!response.ok) throw new ArchiveError('HTTP', `archive.org listing answered ${response.status}`);
  return parseListing(await response.text());
}

async function downloadFile(root, entry, { fetch: fetcher, locale, origin, signal, onBytes }) {
  const { name, size } = entry;
  let response;
  try { response = await fetcher(memberUrl(name, locale, origin), { ...FETCH_OPTIONS, signal }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new ArchiveError('NETWORK', `Cannot download ${name} from archive.org`, error); }
  if (!response.ok || !response.body) throw new ArchiveError('HTTP', `archive.org answered ${response.status} for ${name}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== size) throw new ArchiveError('INTEGRITY', `${name}: server announces ${declared} bytes, expected ${size}`);
  // createWritable stages into a swap file and commits only on close(), so an aborted or rejected download never leaves a partial file.
  const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
  const reader = response.body.getReader();
  let received = 0, first = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) {
        first = false;
        if (/\.mpq$/i.test(name) && !MPQ_MAGIC.every((byte, i) => value[i] === byte)) throw new ArchiveError('INTEGRITY', `${name} does not look like an MPQ archive`);
      }
      received += value.length;
      if (received > size) throw new ArchiveError('INTEGRITY', `${name}: more than the expected ${size} bytes`);
      await writable.write(value);
      onBytes(value.length);
    }
    if (received !== size) throw new ArchiveError('INTEGRITY', `${name}: received ${received} of ${size} bytes`);
    await writable.close();
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writable.abort().catch(() => {});
    await root.removeEntry(name).catch(() => {});
    throw error;
  }
}

/**
 * Downloads the needed MPQs into root/CACHE_DIR and returns that directory handle, usable exactly like a picked Data folder.
 * Resumable at file granularity: files already verified (state file + matching size) are skipped.
 */
export async function downloadArchiveData(root, {
  fetch: fetcher = globalThis.fetch, locale = DEFAULT_LOCALE, audio = false, origin = ARCHIVE_ORIGIN, signal, onProgress = () => {}, pinnedSizes,
} = {}) {
  const dir = await cacheDirectory(root, true);
  onProgress({ text: 'Reading the archive.org file list', completed: 0, total: 0 });
  const plan = planFiles(await fetchListing({ fetch: fetcher, locale, origin, signal }), audio ? [...CORE_FILES, ...AUDIO_FILES] : [...CORE_FILES], locale, pinnedSizes);
  const total = plan.reduce((sum, { size }) => sum + size, 0);
  const state = await readState(dir, locale);
  const done = new Set();
  for (const { name, size } of plan)
    if (state[name] === size && await dir.getFileHandle(name).then(h => h.getFile()).then(f => f.size === size, () => false)) done.add(name);
  let completed = plan.filter(({ name }) => done.has(name)).reduce((sum, { size }) => sum + size, 0);
  for (const entry of plan) {
    if (done.has(entry.name)) continue;
    onProgress({ text: `Downloading ${entry.name}`, completed, total });
    const base = completed;
    let file = 0;
    await downloadFile(dir, entry, { fetch: fetcher, locale, origin, signal, onBytes: n => {
      file += n;
      onProgress({ text: `Downloading ${entry.name}`, completed: base + file, total });
    } });
    completed = base + entry.size;
    state[entry.name] = entry.size;
    await writeState(dir, locale, state);
  }
  onProgress({ text: 'Download complete', completed: total, total });
  return dir;
}

export async function archiveCacheStatus(root) {
  const dir = await cacheDirectory(root, false);
  if (!dir) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for await (const [name, entry] of dir.entries()) if (entry.kind === 'file' && /\.mpq$/i.test(name)) { files++; bytes += (await entry.getFile()).size; }
  return { files, bytes };
}

export async function clearArchiveCache(root) {
  try { await root.removeEntry(CACHE_DIR, { recursive: true }); }
  catch (error) { if (error.name !== 'NotFoundError') throw ioError('Cannot clear the downloaded data', error); }
}
