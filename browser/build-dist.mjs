// Builds a static, publishable copy of the app: node browser/build-dist.mjs [outDir] (default ./dist at the repo root).
// The file list is generated from the import graph (shell-manifest.mjs) and stamped into sw.js, so what is cached offline and hosted cannot drift.
// Never copied: tests, smoke scripts, server.mjs, runtime/ and local/ (private NPC pack), SQL, or any game data.
import { cp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellManifest, stampServiceWorker, archiveStamp, archiveEnabled, stampHeaders } from './shell-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function appFiles() {
  return (await shellManifest()).files;
}

// Original vehicle models are optional (they are not in the service worker's precache list, so a missing file cannot break install).
export async function vehicleFiles() {
  const names = await readdir(join(here, 'vehicles')).catch(() => []);
  return names.filter(n => /^[a-z0-9-]+\.glb$/.test(n)).map(n => `vehicles/${n}`);
}

// The trimmed public NPC pack is published only when explicitly requested (INCLUDE_NPC_PACK=1) and only if the local file is
// the de-identified format; a private full pack is refused. Source: browser/npc-pack.public.json (tracked).
export async function npcPack(env = process.env, path = join(here, 'npc-pack.public.json')) {
  if (env.INCLUDE_NPC_PACK !== '1') return null;
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  const pack = JSON.parse(text);
  if (pack.format !== 'npc-trimmed-v1' || pack.provenance?.redistribution !== 'public-trimmed') throw new Error('refusing to publish a non-trimmed NPC pack');
  return text;
}

export async function build(out = resolve(here, '..', 'dist'), { archive = archiveEnabled() } = {}) {
  const manifest = await shellManifest({ archive }), files = [...manifest.files, ...await vehicleFiles()];
  for (const file of files) {
    if (/(^|\/)(local|runtime)\//.test(file) || /\.(test|smoke)\.|-smoke\./.test(file)) throw new Error(`refusing to publish ${file}`);
    await access(join(here, file)).catch(() => { throw new Error(`${file} is missing${file.startsWith('pkg/') ? '; run browser\\Build.ps1 first' : ''}`); });
  }
  const pack = await npcPack();
  await rm(out, { recursive: true, force: true });
  for (const file of files) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    if (file === 'archive-flag.js') await writeFile(join(out, file), archiveStamp(await readFile(join(here, file), 'utf8'), archive));
    else if (file === 'sw.js') await writeFile(join(out, file), stampServiceWorker(await readFile(join(here, file), 'utf8'), manifest));
    else await cp(join(here, file), join(out, file));
  }
  if (pack) await writeFile(join(out, 'npc-pack.json'), pack);
  await writeFile(join(out, '_headers'), stampHeaders(await readFile(join(here, 'hosting', '_headers'), 'utf8'), archive));
  await writeFile(join(out, '.nojekyll'), '');
  return { out, files: files.length + 2 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await build(process.argv[2] && resolve(process.argv[2]));
  console.log(`Built ${result.files} files into ${result.out}`);
}
