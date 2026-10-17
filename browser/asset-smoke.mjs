// Private install stays read-only. The HTTP server below serves code only, never game assets.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { readdir, readFile, mkdtemp, rm, rmdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDataSource, ASSET_LIMITS } from './asset-source.js';

if (!process.env.WOW_DATA || !process.env.MPQX) throw new Error('Set WOW_DATA to your Data directory and MPQX to the built native mpqx executable');
const root = path.resolve(process.env.WOW_DATA), mpqx = path.resolve(process.env.MPQX);
const catalog = await Promise.all((await readdir(root)).filter(name => /\.mpq$/i.test(name)).map(async name => {
  const file = await openAsBlob(path.join(root, name));
  Object.defineProperty(file, 'lastModified', { value: Math.trunc((await stat(path.join(root, name))).mtimeMs) });
  return { path: name, file };
}));
const source = await openDataSource(catalog);
const list = new TextDecoder().decode(await source.read('(listfile)')).split(/[;\r\n]/).filter(Boolean);
const assetPaths = [
  'World\\Maps\\Kalimdor\\Kalimdor.wdt', 'World\\Maps\\Kalimdor\\Kalimdor.wdl',
  'World\\Maps\\Azeroth\\Azeroth.wdt', 'World\\Maps\\Azeroth\\Azeroth.wdl',
  'World\\Maps\\Kalimdor\\Kalimdor_39_43.adt', 'DBFilesClient\\Map.dbc',
];
// The winning patch listfile need not contain every type; walk each archive's list where present.
for (const extension of ['.m2', '.wmo', '.blp']) {
  let found = list.find(name => name.toLowerCase().endsWith(extension));
  if (!found) {
    for (const entry of [...catalog].reverse()) {
      const one = await openDataSource([{ ...entry, path: 'patch.MPQ' }]);
      let names;
      try { names = new TextDecoder().decode(await one.read('(listfile)')).split(/[;\r\n]/); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      finally { await one.close(); }
      found = names?.find(name => name.toLowerCase().endsWith(extension));
      if (found) break;
    }
  }
  assert(found, `No test ${extension} entry discovered`);
  assetPaths.push(found);
}
const temporary = await mkdtemp(path.join(tmpdir(), 'vanilla-asset-test-'));
const expected = [], nativeSources = [];
try {
  for (let i = 0; i < assetPaths.length; i++) {
    const gamePath = assetPaths[i], output = path.join(temporary, `${i}.bin`);
    nativeSources.push(execFileSync(mpqx, [root, gamePath, output], { encoding: 'utf8' }).trim());
    const native = await readFile(output), browser = await source.read(gamePath);
    assert.deepEqual(Buffer.from(browser), native, gamePath);
    expected.push({ path: gamePath, size: native.length, hash: createHash('sha256').update(native).digest('hex') });
  }
} finally {
  for (let i = 0; i < assetPaths.length; i++) await rm(path.join(temporary, `${i}.bin`), { force: true });
  await rmdir(temporary);
}
await source.close();

const worker = `
import {openDataSource} from '/asset-source.js';
self.onmessage=async({data})=>{
  try {
    const source=await openDataSource(data.catalog), results=[];
    for (const path of data.paths) {
      const start=performance.now(),bytes=await source.read(path);
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
      results.push({path,size:bytes.length,hash,ms:performance.now()-start});
    }
    let missing;
    try {await source.read('this-file-does-not-exist.adt');} catch(error) {missing=error.code;}
    self.postMessage({results,stats:source.stats,fingerprint:source.fingerprint,missing});
    await source.close();
  } catch(error) {self.postMessage({error:error.stack,code:error.code});}
};`;
const html = `<input id="data" type="file" webkitdirectory><script>
window.run=paths=>new Promise((resolve,reject)=>{
const worker=new Worker('/worker.js',{type:'module'});
worker.onmessage=e=>{worker.terminate();resolve(e.data);};worker.onerror=reject;
worker.postMessage({paths,catalog:[...document.querySelector('input').files].map(file=>({path:file.webkitRelativePath,file}))});
});</script>`;
const modules = new Map([
  ['/asset-source.js', await readFile(new URL('./asset-source.js', import.meta.url))],
  ['/asset-folder.js', await readFile(new URL('./asset-folder.js', import.meta.url))],
  ['/worker.js', worker],
]);
const server = createServer((request, response) => {
  const content = request.url === '/' ? html : modules.get(request.url);
  if (!content) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'text/javascript');
  response.end(content);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#data').setInputFiles(root);
  const result = await page.evaluate(paths => window.run(paths), assetPaths);
  assert(!result.error, JSON.stringify(result));
  assert.deepEqual(result.results.map(({ ms, ...rest }) => rest), expected);
  assert.equal(result.missing, 'NOT_FOUND');
  assert.equal(result.fingerprint, source.fingerprint);
  assert(result.stats.maxReadBytes <= ASSET_LIMITS.readBytes);
  assert(result.stats.indexBytes < ASSET_LIMITS.totalIndexBytes);
  const persistence = await page.evaluate(async () => {
    const { rememberDataFolder, restoreDataFolder, forgetDataFolder, authorizeDataFolder } = await import('/asset-folder.js');
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle('asset-test', { create: true });
    await rememberDataFolder(handle);
    const restored = await restoreDataFolder();
    const equal = await handle.isSameEntry(restored), authorized = await authorizeDataFolder(restored);
    await forgetDataFolder();
    const forgotten = (await restoreDataFolder()) === undefined;
    await root.removeEntry('asset-test');
    return { equal, authorized, forgotten };
  });
  assert.deepEqual(persistence, { equal: true, authorized: true, forgotten: true });
  console.log(JSON.stringify({ browser: browser.version(), nativeSources, ...result, persistence,
    limits: 'Native picker dialog not automated; directory-backed Files read in actual Edge module worker, handle persistence tested with OPFS' }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
