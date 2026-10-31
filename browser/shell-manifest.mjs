// Single source of truth for the hosted/offline app shell, generated from the import graph.
// Roots: index.html. Followed: static and dynamic imports, worker/URL literals and any './x.(js|json|css|svg|wasm)' string literal in app JS.
// server.mjs serves it, build-dist.mjs publishes it and the stamped service worker precaches it, so none of them keeps a hand-edited list.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Files no static analysis can see (loaded through the wasm-bindgen glue). Add runtime-only URLs here.
export const RUNTIME_ASSETS = ['pkg/flats_racer_web.js', 'pkg/flats_racer_web_bg.wasm'];
// world-map-art.jpg is a git-ignored, user-supplied painted map: never required, never published (map-panel draws a generated parchment map from the streamed far terrain when it is absent).

// Fetched optionally at runtime and published separately (see build-dist.mjs and server.mjs), never part of the shell.
export const OPTIONAL_RUNTIME = new Set(['npc-pack.json', 'local/npc-spawns.json', 'world-map-art.jpg']);
export const FORBIDDEN = /test|smoke|server|runtime|local\/|\.py$|\.md$/;
const LOCAL_REF = /['"](\.{1,2}\/[\w./-]+\.(?:js|mjs|json|css|svg|wasm))['"]/g;
const HTML_REF = /(?:src|href)="(\.\/[^"#?]+)"/g;
export const PLACEHOLDER = '/*SHELL_MANIFEST*/null';

async function read(file, optional) {
  try { return await readFile(join(here, file), 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

// Optional archive.org data source: part of the shell only when ARCHIVE_DATA_SOURCE=1 (the single deploy lever). With it off these files are not
// followed, not served, not published and not precached, and archive-flag.js stays `false`.
export const ARCHIVE_MODULES = new Set(['archive-ui.js', 'archive-source.js', 'archive-manifest.js']);
export const archiveEnabled = (env = process.env) => env.ARCHIVE_DATA_SOURCE === '1';
const ARCHIVE_FLAG = 'export const ARCHIVE_DATA_SOURCE = false;';
export function archiveStamp(source, on) {
  if (!source.includes(ARCHIVE_FLAG)) throw new Error('archive-flag.js lacks its default-off flag line');
  return on ? source.replace(ARCHIVE_FLAG, 'export const ARCHIVE_DATA_SOURCE = true;') : source;
}
// Only connect-src changes, and only with the flag on: direct downloads (and their redirects) from archive.org hosts.
export function stampHeaders(source, on) {
  return on ? source.replaceAll("object-src 'none';", "object-src 'none'; connect-src 'self' https://archive.org https://*.archive.org;") : source;
}
export const CSP = on => stampHeaders("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", on);

/** Walks the graph. Missing files fail closed unless `allowMissing` (dev server before a wasm build). */
export async function shellManifest({ allowMissing = false, archive = archiveEnabled() } = {}) {
  const found = new Set(['index.html']);
  const queue = ['index.html'];
  const add = file => { if (!found.has(file)) { found.add(file); queue.push(file); } };
  for (const file of RUNTIME_ASSETS) found.add(file);
  while (queue.length) {
    const file = queue.shift();
    const text = await read(file, allowMissing);
    if (text === null || file.startsWith('pkg/')) continue;
    const pattern = file.endsWith('.html') ? HTML_REF : file.endsWith('.js') ? LOCAL_REF : null;
    if (!pattern) continue;
    for (const [, ref] of text.matchAll(pattern)) {
      const target = posix.normalize(posix.join(posix.dirname(file), ref));
      if (target.startsWith('../')) throw new Error(`${file} references ${ref} outside the app`);
      if (!OPTIONAL_RUNTIME.has(target) && (archive || !ARCHIVE_MODULES.has(target))) add(target);
    }
  }
  const files = [...found].sort();
  const bad = files.filter(f => FORBIDDEN.test(f));
  if (bad.length) throw new Error(`shell would include forbidden files: ${bad.join(', ')}`);
  const hash = createHash('sha256').update(archive ? 'archive-on' : 'archive-off');
  for (const file of files) {
    const bytes = await readFile(join(here, file)).catch(error => {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw new Error(`${file} is missing${file.startsWith('pkg/') ? '; run browser\\Build.ps1 first' : ''}`);
    });
    if (bytes) hash.update(file).update('\0').update(bytes);
  }
  return { hash: hash.digest('hex').slice(0, 12), files };
}

/** Embeds the manifest in sw.js so its bytes (and cache name) change whenever any shell file does. */
export function stampServiceWorker(source, manifest) {
  if (!source.includes(PLACEHOLDER)) throw new Error('sw.js lacks the SHELL_MANIFEST placeholder');
  return source.replace(PLACEHOLDER, JSON.stringify({ hash: manifest.hash, files: ['./', ...manifest.files.map(f => `./${f}`)] }));
}
