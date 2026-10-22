import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFiles, vehicleFiles } from './build-dist.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('hosted file list is app-only and covers every static import', async () => {
  const files = await appFiles();
  assert.ok(files.includes('index.html') && files.includes('sw.js') && files.includes('pkg/flats_racer_web_bg.wasm'));
  assert.ok(!files.some(f => /test|smoke|server|runtime|local\/|\.py$|\.md$/.test(f)), 'no tests, server, private or docs');
  const set = new Set(files);
  for (const file of files.filter(f => f.endsWith('.js') && !f.startsWith('pkg/'))) {
    const source = await readFile(join(here, file), 'utf8');
    for (const [, spec] of source.matchAll(/(?:from\s+|import\s*\(\s*|new Worker\(\s*)'(\.{1,2}\/[^']+\.js)'/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      assert.ok(set.has(target), `${file} imports ${spec} which is not hosted`);
    }
  }
});

test('vehicle models are hosted by name pattern only', async () => {
  assert.ok((await vehicleFiles()).every(f => /^vehicles\/[a-z0-9-]+\.glb$/.test(f)));
  assert.ok(!(await appFiles()).some(f => f.endsWith('.glb')), 'optional models stay out of the precache list');
});
