// Builds a static, publishable copy of the app: node browser/build-dist.mjs [outDir] (default ./dist at the repo root).
// The file list is the service worker's precache list, so what is cached offline and what is hosted cannot drift.
// Never copied: tests, smoke scripts, server.mjs, runtime/ and local/ (private NPC pack), SQL, or any game data.
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function appFiles() {
  const sw = await readFile(join(here, 'sw.js'), 'utf8');
  const list = /const FILES = (\[[\s\S]*?\]);/.exec(sw);
  if (!list) throw new Error('sw.js FILES list not found');
  const files = JSON.parse(list[1].replace(/'/g, '"')).filter(f => f !== './').map(f => f.slice(2));
  return [...files, 'sw.js'];
}

export async function build(out = resolve(here, '..', 'dist')) {
  const files = await appFiles();
  for (const file of files) {
    if (/(^|\/)(local|runtime)\//.test(file) || /\.(test|smoke)\.|-smoke\./.test(file)) throw new Error(`refusing to publish ${file}`);
    await access(join(here, file)).catch(() => { throw new Error(`${file} is missing${file.startsWith('pkg/') ? '; run browser\\Build.ps1 first' : ''}`); });
  }
  await rm(out, { recursive: true, force: true });
  for (const file of files) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    await cp(join(here, file), join(out, file));
  }
  await cp(join(here, 'hosting', '_headers'), join(out, '_headers'));
  await writeFile(join(out, '.nojekyll'), '');
  return { out, files: files.length + 2 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await build(process.argv[2] && resolve(process.argv[2]));
  console.log(`Built ${result.files} files into ${result.out}`);
}
