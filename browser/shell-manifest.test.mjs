import test from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shellManifest, stampServiceWorker, FORBIDDEN, PLACEHOLDER } from './shell-manifest.mjs';

const needsPkg = { skip: existsSync(new URL('./pkg/flats_racer_web_bg.wasm', import.meta.url)) ? false : 'run browser\\Build.ps1 first (no wasm pkg on a clean checkout)' };
test('manifest is generated from the import graph and is app-only', needsPkg, async () => {
  const { files, hash } = await shellManifest();
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(files, [...files].sort());
  for (const needed of ['index.html', 'sw.js', 'world-app.js', 'world-worker.js', 'far-worker.js', 'asset-worker.js', 'style.css', 'swe1r/voice-map.json', 'tracks/steamwheedle.json', 'pkg/flats_racer_web_bg.wasm'])
    assert.ok(files.includes(needed), `${needed} missing from the shell`);
  assert.ok(!files.some(f => FORBIDDEN.test(f)), 'no tests, smokes, server, private or docs');
  assert.ok(!files.includes('npc-pack.json'), 'optional population packs are not shell files');
});

test('stamped service worker carries the manifest and a content-derived cache name', needsPkg, async () => {
  const manifest = await shellManifest();
  const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
  assert.ok(source.includes(PLACEHOLDER), 'sw.js keeps its placeholder');
  const stamped = stampServiceWorker(source, manifest);
  assert.ok(!stamped.includes(PLACEHOLDER));
  assert.ok(stamped.includes(`"hash":"${manifest.hash}"`) && stamped.includes('"./world-app.js"'));
  assert.notEqual(stamped, stampServiceWorker(source, { ...manifest, hash: 'other' }), 'a hash change changes sw.js bytes so browsers reinstall');
  assert.throws(() => stampServiceWorker('const x=1;', manifest));
});

test('the git-ignored painted map is never a required shell file', async () => {
  const { files } = await shellManifest({ allowMissing: true });
  assert.ok(!files.includes('world-map-art.jpg'));
});

