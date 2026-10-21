import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFiles } from './build-dist.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('hosted file list is app-only and covers every static import', async () => {
  const files = await appFiles();
  assert.ok(files.includes('index.html') && files.includes('sw.js') && files.includes('pkg/flats_racer_web_bg.wasm'));
  assert.ok(!files.some(f => /test|smoke|server|runtime|local\/|\.py$|\.md$/.test(f)), 'no tests, server, private or docs');
  const set = new Set(files);
  for (const file of files.filter(f => f.endsWith('.js') && !f.startsWith('pkg/'))) {
    const source = await readFile(join(here, file), 'utf8');
    for (const [, spec] of source.matchAll(/(?:from\s+|import\s*\(\s*|new Worker\(\s*)'(\.\/[^']+\.js)'/g)) {
      assert.ok(set.has(spec.slice(2)), `${file} imports ${spec} which is not hosted`);
    }
  }
});
