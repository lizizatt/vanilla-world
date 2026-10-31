import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_FILES, AUDIO_FILES, ArchiveError, parseListing, planFiles, PINNED_SIZES } from './archive-manifest.js';
import { downloadArchiveData, clearArchiveCache, archiveCacheStatus, CACHE_DIR, NOTICE } from './archive-source.js';
import { fetchArchiveData } from './tools/fetch-archive-data.mjs';
import { shellManifest, archiveStamp, stampHeaders, CSP, ARCHIVE_MODULES } from './shell-manifest.mjs';
import { startMock, fixtureBytes, memoryRoot } from './archive-mock.mjs';

const here = new URL('.', import.meta.url);
const sizes = Object.fromEntries([...CORE_FILES, ...AUDIO_FILES].map((n, i) => [n, 1500 + i * 331]));
const fixtures = Object.fromEntries(Object.entries(sizes).map(([n, s]) => [n, fixtureBytes(n, s)]));

// ---- lever off: zero code, UI, network
test('default is OFF: tracked flag is false and the archive modules are not in the shell', async () => {
  assert.match(await readFile(new URL('archive-flag.js', here), 'utf8'), /ARCHIVE_DATA_SOURCE = false;/);
  const off = await shellManifest({ allowMissing: true, archive: false });
  assert.ok(off.files.includes('archive-flag.js'));
  for (const module of ARCHIVE_MODULES) assert.ok(!off.files.includes(module), `${module} must not ship when off`);
  const on = await shellManifest({ allowMissing: true, archive: true });
  for (const module of ARCHIVE_MODULES) assert.ok(on.files.includes(module), `${module} ships when on`);
  assert.notEqual(on.hash, off.hash);
});

test('flag off: no shipped file mentions archive.org and the CSP does not allow it', async () => {
  const { files } = await shellManifest({ allowMissing: true, archive: false });
  for (const file of files.filter(f => /\.(js|html|css|json)$/.test(f) && !f.startsWith('pkg/')))
    assert.ok(!/archive\.org/i.test(await readFile(new URL(file, here), 'utf8')), `${file} mentions archive.org while the lever is off`);
  const headers = await readFile(new URL('hosting/_headers', here), 'utf8');
  assert.equal(stampHeaders(headers, false), headers);
  assert.ok(!CSP(false).includes('archive.org'));
  assert.ok(CSP(true).includes('connect-src') && CSP(true).includes('https://*.archive.org'));
  const flag = await readFile(new URL('archive-flag.js', here), 'utf8');
  assert.equal(archiveStamp(flag, false), flag);
  assert.match(archiveStamp(flag, true), /ARCHIVE_DATA_SOURCE = true;/);
  assert.throws(() => archiveStamp('export const x = 1;', true));
});

test('the only entry point is behind the flag', async () => {
  const app = await readFile(new URL('world-app.js', here), 'utf8');
  const uses = [...app.matchAll(/archive-ui\.js/g)];
  assert.equal(uses.length, 1);
  assert.match(app, /if\(ARCHIVE_DATA_SOURCE\)\(await import\('\.\/archive-ui\.js'\)\)/);
});

async function withServer(env, run) {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.on('data', d => /Local world/.test(String(d)) && resolve()); child.on('exit', reject); });
    return await run(`http://127.0.0.1:${port}`);
  } finally { child.kill(); }
}
test('dev server: off serves nothing from the archive modules; on serves them with a stamped flag and CSP', async () => {
  await withServer({ ARCHIVE_DATA_SOURCE: '' }, async base => {
    assert.equal((await fetch(`${base}/archive-ui.js`)).status, 404);
    assert.equal((await fetch(`${base}/archive-source.js`)).status, 404);
    const flag = await fetch(`${base}/archive-flag.js`);
    assert.match(await flag.text(), /ARCHIVE_DATA_SOURCE = false;/);
    assert.ok(!flag.headers.get('content-security-policy').includes('archive.org'));
  });
  await withServer({ ARCHIVE_DATA_SOURCE: '1' }, async base => {
    assert.equal((await fetch(`${base}/archive-ui.js`)).status, 200);
    const flag = await fetch(`${base}/archive-flag.js`);
    assert.match(await flag.text(), /ARCHIVE_DATA_SOURCE = true;/);
    assert.match(flag.headers.get('content-security-policy'), /connect-src 'self' https:\/\/archive\.org https:\/\/\*\.archive\.org/);
  });
});

test('CLI refuses without the flag and makes no network request', async () => {
  const fetcher = () => { throw new Error('network used while the lever is off'); };
  await assert.rejects(fetchArchiveData({ env: {}, argv: ['--out', 'x', '--yes'], fetch: fetcher, log() {} }), { code: 'DISABLED' });
  await assert.rejects(fetchArchiveData({ env: { ARCHIVE_DATA_SOURCE: '0' }, argv: [], fetch: fetcher, log() {} }), { code: 'DISABLED' });
  await assert.rejects(fetchArchiveData({ env: { ARCHIVE_DATA_SOURCE: '1' }, argv: ['--out', 'x'], fetch: fetcher, log() {} }), { code: 'USAGE' });
});

test('notice states the required points', () => {
  const text = NOTICE.join(' ');
  for (const phrase of [/unofficial/i, /not affiliated/i, /right to use/i, /directly from archive\.org/i, /only on this device/i, /Nothing is hosted, proxied/i]) assert.match(text, phrase);
});

// ---- listing / planning
test('listing parser reads the real table shape; plan rejects size drift and missing files', () => {
  const html = '<tr><td><a href="//archive.org/download/I/Z.zip/Data%2Fdbc.MPQ">Data/dbc.MPQ</a></td><td>2026-05-09 21:42</td><td>3875834</td></tr><tr><td>Data/</td><td>2026-05-09 21:44</td><td></td></tr><tr><td>Data/Interface/x.avi</td><td>2026-05-09 21:42</td><td>5</td></tr>';
  const listing = parseListing(html);
  assert.deepEqual([...listing], [['dbc.MPQ', 3875834]]);
  assert.deepEqual(planFiles(listing, ['dbc.MPQ']), [{ name: 'dbc.MPQ', size: 3875834 }]);
  assert.throws(() => planFiles(new Map([['dbc.MPQ', 1]]), ['dbc.MPQ']), { code: 'INTEGRITY' });
  assert.throws(() => planFiles(new Map(), ['dbc.MPQ']), { code: 'MISSING' });
  assert.equal(PINNED_SIZES['dbc.MPQ'], 3875834);
});

// ---- browser source against the mock
async function download(mock, root, extra = {}) {
  const progress = [];
  const dir = await downloadArchiveData(root, { origin: mock.origin, pinnedSizes: sizes, onProgress: p => progress.push(p), ...extra });
  return { dir, progress };
}
const names = async dir => { const out = []; for await (const [n, e] of dir.entries()) if (e.kind === 'file') out.push(n); return out.sort(); };

test('downloads only core files, verifies sizes, reports progress, talks only to the mock origin', async () => {
  const mock = await startMock(fixtures);
  try {
    const root = memoryRoot();
    const { dir, progress } = await download(mock, root);
    assert.deepEqual((await names(dir)).filter(n => n.endsWith('.MPQ')), [...CORE_FILES].sort());
    for (const name of CORE_FILES) assert.equal((await (await dir.getFileHandle(name)).getFile()).size, sizes[name]);
    const total = CORE_FILES.reduce((s, n) => s + sizes[n], 0);
    assert.equal(progress.at(-1).completed, total);
    assert.ok(progress.every((p, i) => i === 0 || p.completed >= progress[i - 1].completed));
    assert.ok(mock.log.every(r => !r.range), 'per-member endpoint is fetched whole, never with Range');
    assert.ok(!mock.log.some(r => /sound|speech/i.test(r.path)), 'audio is opt-in');
    assert.deepEqual(await archiveCacheStatus(root), { files: CORE_FILES.length, bytes: total });
    await clearArchiveCache(root);
    assert.deepEqual(await archiveCacheStatus(root), { files: 0, bytes: 0 });
    await clearArchiveCache(root);
  } finally { await mock.close(); }
});

test('audio opt-in adds the audio MPQs; a second run resumes without re-downloading', async () => {
  const mock = await startMock(fixtures);
  try {
    const root = memoryRoot();
    await download(mock, root);
    const first = mock.log.length;
    await download(mock, root, { audio: true });
    const members = mock.log.slice(first).filter(r => r.path.includes('Data%2F') && !r.path.includes('view_archive'));
    assert.deepEqual(members.map(r => decodeURIComponent(r.path.split('Data%2F')[1])).sort(), [...AUDIO_FILES].sort());
    const again = mock.log.length;
    await download(mock, root, { audio: true });
    assert.equal(mock.log.slice(again).filter(r => r.path.includes('Data%2F') || r.path.includes('view_archive')).length, 0);
  } finally { await mock.close(); }
});

test('integrity failures leave no file behind: wrong length, truncation, bad magic, drifted listing', async () => {
  for (const [label, options, code] of [['lie', { lieLength: true }, 'INTEGRITY'], ['truncate', { truncate: true }, 'INTEGRITY'], ['magic', { badMagic: ['dbc.MPQ'] }, 'INTEGRITY']]) {
    const mock = await startMock(fixtures, options);
    try {
      const root = memoryRoot();
      await assert.rejects(download(mock, root), { code }, label);
      const dir = await root.getDirectoryHandle(CACHE_DIR);
      assert.ok(!(await names(dir)).includes('dbc.MPQ') || (await (await dir.getFileHandle('dbc.MPQ')).getFile()).size === 0, label);
    } finally { await mock.close(); }
  }
  const mock = await startMock(fixtures);
  try { await assert.rejects(downloadArchiveData(memoryRoot(), { origin: mock.origin, pinnedSizes: { ...sizes, 'dbc.MPQ': 1 } }), { code: 'INTEGRITY' }); }
  finally { await mock.close(); }
});

test('abort stops cleanly and a later run resumes the remaining files', async () => {
  const mock = await startMock(fixtures);
  try {
    const root = memoryRoot(), controller = new AbortController();
    await assert.rejects(download(mock, root, { signal: controller.signal, onProgress: ({ text }) => { if (text === 'Downloading fonts.MPQ') controller.abort(); } }), { name: 'AbortError' });
    const dir = await root.getDirectoryHandle(CACHE_DIR);
    assert.ok((await names(dir)).includes('dbc.MPQ'));
    const before = mock.log.length;
    await download(mock, root);
    const refetched = mock.log.slice(before).filter(r => r.path.includes('Data%2F')).map(r => decodeURIComponent(r.path.split('Data%2F')[1]));
    assert.ok(!refetched.includes('dbc.MPQ') && refetched.includes('fonts.MPQ'));
  } finally { await mock.close(); }
});

// ---- CLI against the mock raw zip (Range, no CORS)
async function cli(mock, out, extra = {}) {
  return fetchArchiveData({ env: { ARCHIVE_DATA_SOURCE: '1' }, argv: ['--yes', '--out', out, '--origin', mock.origin], pinnedSizes: sizes, zipFacts: {}, log() {}, ...extra });
}
for (const [label, options] of [['stored', {}], ['deflate + zip64', { zip64: true, deflate: ['model.MPQ', 'texture.MPQ'] }]]) {
  test(`CLI downloads and CRC-verifies by ranged zip reads (${label})`, async () => {
    const mock = await startMock(fixtures, options), out = await mkdtemp(join(tmpdir(), 'arch-cli-'));
    try {
      assert.deepEqual((await cli(mock, out)).sort(), [...CORE_FILES].sort());
      for (const name of CORE_FILES) assert.deepEqual(new Uint8Array(await readFile(join(out, name))), fixtures[name]);
      assert.ok(mock.log.some(r => r.range), 'uses Range');
      assert.ok(!mock.log.some(r => r.path.includes('view_archive')), 'does not use the whole-member endpoint');
      await cli(mock, out);
    } finally { await mock.close(); await rm(out, { recursive: true, force: true }); }
  });
}

test('CLI resumes a stored partial file and rejects corrupt data', async () => {
  const mock = await startMock(fixtures), out = await mkdtemp(join(tmpdir(), 'arch-cli-'));
  try {
    await writeFile(join(out, 'dbc.MPQ.part'), fixtures['dbc.MPQ'].subarray(0, 700));
    await cli(mock, out);
    assert.ok(mock.log.some(r => r.range && /^bytes=\d+-\d+$/.test(r.range)));
    assert.deepEqual(new Uint8Array(await readFile(join(out, 'dbc.MPQ'))), fixtures['dbc.MPQ']);
    assert.ok(!(await readdir(out)).some(n => n.endsWith('.part')));
  } finally { await mock.close(); await rm(out, { recursive: true, force: true }); }
  const bad = await startMock(fixtures), dir = await mkdtemp(join(tmpdir(), 'arch-cli-'));
  try {
    const zip = Buffer.from(bad.zip);
    zip[zip.indexOf(Buffer.from(fixtures['dbc.MPQ'].subarray(0, 8))) + 100] ^= 0xff;
    bad.setZip(zip);
    await assert.rejects(cli(bad, dir), { code: 'INTEGRITY' });
    assert.ok(!(await readdir(dir)).includes('dbc.MPQ'));
  } finally { await bad.close(); await rm(dir, { recursive: true, force: true }); }
});
