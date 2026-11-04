import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('every te-* id the track editor looks up exists in index.html', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./track-editor.js', import.meta.url), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('(te-[a-z-]+)'\)/g)].map(m => m[1]));
  const missing = [...ids].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});
