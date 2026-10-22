import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBlock } from './block.js';
import { decompress, isComp } from './comp.js';
import { decodePixels, decodeSprite, FMT, rgba5551 } from './image.js';
import { findLev, listModels } from './cli.mjs';
import { alphaMode, buildPod, decodeTriangles } from './pod.js';
import { toCraft, podSkinList, loadPodModel } from './skin.js';
import { loadSfx, SFX } from './sfx.js';
import { loadHudSprites, needleAngle } from './hud.js';
import { readerFromFiles } from './folder.js';
import { VEHICLES, normalizeChoice, setRuntimeSkins } from '../vehicles.js';

const be32 = n => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];

test('readBlock splits parts by next nonzero offset and handles empty parts', () => {
  // 2 model items: item0 = [mask 'AB', body 'CDE'], item1 = [mask empty, body 'F'] ; header = 4 + 4*4 + 4 = 24
  const bytes = Uint8Array.from([...be32(2), ...be32(24), ...be32(26), ...be32(0), ...be32(29), ...be32(30), 65, 66, 67, 68, 69, 70]);
  const it = readBlock(bytes, 'model');
  assert.equal(it.length, 2);
  assert.deepEqual([...it[0][0]], [65, 66]);
  assert.deepEqual([...it[0][1]], [67, 68, 69]);
  assert.equal(it[1][0].length, 0);
  assert.deepEqual([...it[1][1]], [70]);
});

test('readBlock rejects truncated or bogus containers', () => {
  assert.throws(() => readBlock(new Uint8Array(4), 'model'));
  assert.throws(() => readBlock(Uint8Array.from([...be32(1000), 0, 0, 0, 0]), 'model'));
  assert.throws(() => readBlock(new Uint8Array(16), 'bogus'));
});

// Encodes: literal "abc", then a back-reference copying "abc" (window offset 1, length 3), then the offset-0 end token.
test('Comp decompressor (synthetic only; bit order unverified on real data): literals, window back-references, terminator', () => {
  const body = [0b00000111, 97, 98, 99, /* token: len 3 => (3-2)<<4, offset 1 */ 0x10, 0x01, 0x00, 0x00];
  const src = Uint8Array.from([0x43, 0x6f, 0x6d, 0x70, 0x57, 0x6f, 0x6c, 0x66, ...be32(6), ...body]);
  assert.ok(isComp(src));
  assert.equal(Buffer.from(decompress(src)).toString('latin1'), 'abcabc');
});

test('Comp decompressor passes raw data through and rejects short output', () => {
  const raw = Uint8Array.from([80, 111, 100, 100, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(decompress(raw), raw);
  const bad = Uint8Array.from([0x43, 0x6f, 0x6d, 0x70, 0, 0, 0, 0, ...be32(9), 0b1, 65]);
  assert.throws(() => decompress(bad));
});

test('pixel formats decode to RGBA', () => {
  assert.deepEqual(rgba5551(0xf8, 0x01), [255, 0, 0, 255]);
  assert.deepEqual([...decodePixels(FMT.G8, Uint8Array.of(0, 255), 2, 1)], [0, 0, 0, 0, 255, 255, 255, 255]);
  assert.deepEqual([...decodePixels(FMT.GA4, Uint8Array.of(0x0f), 2, 1)], [0, 0, 0, 0, 255, 255, 255, 255]);
  const pal = [[1, 2, 3, 255], [4, 5, 6, 255]];
  assert.deepEqual([...decodePixels(FMT.CI4, Uint8Array.of(0x01), 2, 1, pal)], [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual([...decodePixels(FMT.RGBA32, Uint8Array.of(9, 8, 7, 6), 1, 1)], [9, 8, 7, 6]);
});

test('sprite decoder lays tiles out row-major with rows stored bottom-up', () => {
  // 64x64 CI8 sprite, 2 tiles of 64x32; palette idx 1 = red (top tile), 2 = blue (bottom tile); first stored row of each tile differs.
  const hdr = 20, tbl = 16, palOff = hdr + tbl, pxOff = palOff + 512;
  const b = new Uint8Array(pxOff + 2 * 2048);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 64); dv.setUint16(2, 64); dv.setUint16(4, FMT.CI8); dv.setUint32(8, palOff); dv.setUint16(12, 2); dv.setUint32(16, hdr);
  dv.setUint16(hdr, 64); dv.setUint16(hdr + 2, 32); dv.setUint32(hdr + 4, pxOff);
  dv.setUint16(hdr + 8, 64); dv.setUint16(hdr + 10, 32); dv.setUint32(hdr + 12, pxOff + 2048);
  dv.setUint16(palOff + 2, 0xf801); dv.setUint16(palOff + 4, 0x003f);
  b.fill(1, pxOff, pxOff + 64); // tile 0's first stored row => its bottom row
  b.fill(2, pxOff + 2048, pxOff + 2048 + 64);
  const s = decodeSprite(b);
  assert.equal(s.w, 64);
  const px = (x, y) => [...s.rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  assert.deepEqual(px(0, 31), [255, 0, 0, 255]);
  assert.deepEqual(px(0, 63), [0, 0, 255, 255]);
});

const dataDir = process.env.SWE1R_DATA;
test('real install: container, models and sprites parse', { skip: !dataDir && 'SWE1R_DATA not set' }, () => {
  const lev = findLev(dataDir);
  const models = listModels(lev);
  assert.ok(models.length > 300);
  const tags = new Set(models.map(m => m.tag));
  for (const t of ['Podd', 'Part', 'Trak', 'MAlt']) assert.ok(tags.has(t), t);
  const pods = models.filter(m => m.tag === 'Podd');
  assert.ok(pods.length >= 20 && pods.every(m => m.size > 1000));
  const sprites = readBlock(fs.readFileSync(path.join(lev, 'out_spriteblock.bin')), 'sprite');
  const s = decodeSprite(sprites[27][0]);
  assert.deepEqual([s.w, s.h], [320, 240]);
  const tex = readBlock(fs.readFileSync(path.join(lev, 'out_textureblock.bin')), 'texture');
  assert.equal(tex.length, 1648);
});

// Minimal Part: MeshGroup node -> one mesh -> G_VTX(3) + G_TRI1 + G_ENDDL over three vertices.
function fixtureBody() {
  const b = new Uint8Array(0x100), dv = new DataView(b.buffer);
  b.set([0x50, 0x61, 0x72, 0x74]); dv.setUint32(4, 0x10); dv.setUint32(8, 0xffffffff);
  dv.setUint32(0x10, 0x3064); dv.setUint32(0x24, 1); dv.setUint32(0x28, 0x60);
  dv.setUint32(0x60, 0x70);
  dv.setUint32(0x70 + 0x30, 0xb0); dv.setUint32(0x70 + 0x34, 0xd0); dv.setInt16(0x70 + 0x3a, 3);
  dv.setUint32(0xb0, 0x01003006); dv.setUint32(0xb4, 0xd0); dv.setUint32(0xb8, 0x05000204); dv.setUint32(0xc0, 0xdf000000);
  [[0, 0, 0], [100, 0, 0], [0, 100, 50]].forEach((p, i) => { p.forEach((c, k) => dv.setInt16(0xd0 + 16 * i + 2 * k, c)); dv.setUint32(0xd0 + 16 * i + 12, 0xffffffff); });
  return b;
}

test('buildPod decodes a synthetic display list into triangles with flat normals', () => {
  const pod = buildPod(fixtureBody(), new Uint8Array(0));
  assert.equal(pod.meshCount, 1);
  assert.deepEqual([...pod.asset.indices], [0, 1, 2]);
  assert.deepEqual(pod.bounds.hi, [100, 100, 50]);
  const v = pod.asset.vertices;
  assert.ok(v[4] < 0 && v[5] > 0);
  assert.deepEqual([...v.subarray(8, 12)], [1, 1, 1, 1]);
});

test('toCraft maps model axes to +x forward, +y left, +z up', () => {
  const pod = buildPod(fixtureBody(), new Uint8Array(0));
  toCraft(pod.asset, pod.bounds, 1);
  assert.deepEqual([...pod.asset.vertices.subarray(12, 15)], [0, -100, 0]);
});

test('runtime skins are replaced wholesale and removable', () => {
  const base = VEHICLES.podracer.skins.length;
  setRuntimeSkins('swe1r', podSkinList());
  assert.ok(VEHICLES.podracer.skins.length > base);
  assert.equal(normalizeChoice({ vehicle: 'podracer', skin: 'swe1r-255' }).skin, 'swe1r-255');
  setRuntimeSkins('swe1r', []);
  assert.equal(VEHICLES.podracer.skins.length, base);
  assert.equal(normalizeChoice({ vehicle: 'podracer', skin: 'swe1r-255' }).skin, 'rocket');
});

test('real install: Lod1 pod loads as a textured craft payload', { skip: !process.env.SWE1R_DATA && 'SWE1R_DATA not set' }, async () => {
  const lev = findLev(process.env.SWE1R_DATA);
  const reader = { read: async n => new Uint8Array(fs.readFileSync(path.join(lev, n))) };
  const skin = podSkinList().find(s => s.name === 'Anakin Skywalker');
  const payload = await loadPodModel(reader, skin);
  assert.ok(payload.asset.indices.length >= 900 && payload.asset.indices.length < 120000);
  assert.ok(payload.textures.length > 16 && payload.textures.length <= 64); // no longer capped at 16
  assert.ok(payload.asset.vertices.every(Number.isFinite));
});
test('real install: texture UVs are normalised by 4096, so a 16x128 strip is not tiled', { skip: !process.env.SWE1R_DATA && 'SWE1R_DATA not set' }, async () => {
  const lev = findLev(process.env.SWE1R_DATA);
  const reader = { read: async n => new Uint8Array(fs.readFileSync(path.join(lev, n))) };
  const { asset } = await loadPodModel(reader, podSkinList().find(s => s.name === 'Anakin Skywalker'));
  const strip = asset.batches.find(b => b.texture === 'swe1r\\107');
  assert.ok(strip);
  for (let i = strip.firstIndex; i < strip.firstIndex + strip.indexCount; i++) {
    const u = asset.vertices[asset.indices[i] * 12 + 6];
    assert.ok(u > -0.1 && u < 1.1, `u ${u}`);
  }
});

test('real install: every listed pod is a Part model with plausible size (name table lags the model block by one)', { skip: !process.env.SWE1R_DATA && 'SWE1R_DATA not set' }, async () => {
  const lev = findLev(process.env.SWE1R_DATA);
  const reader = { read: async n => new Uint8Array(fs.readFileSync(path.join(lev, n))) };
  for (const skin of podSkinList()) {
    assert.equal(skin.index, +skin.id.slice(6) + 1);
    const { asset } = await loadPodModel(reader, skin);
    const v = asset.vertices, ext = a => { let lo = 1e9, hi = -1e9; for (let i = a; i < v.length; i += 12) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); } return (hi - lo) * skin.scale; };
    assert.ok(ext(0) > 3 && ext(0) < 20, `${skin.name} length ${ext(0)}`);
  }
});

test('alphaMode: opaque, cutout and blended textures', () => {
  const mk = a => ({ rgba: Uint8Array.from(a.flatMap(v => [9, 9, 9, v])) });
  const rep = (v, n) => Array(n).fill(v);
  assert.deepEqual(alphaMode(mk(rep(255, 16))), { blend: 'opaque', alphaCutoff: 0 });
  assert.deepEqual(alphaMode(mk([...rep(255, 8), ...rep(0, 8)])), { blend: 'opaque', alphaCutoff: 0.5 });
  assert.equal(alphaMode(mk([...rep(255, 8), ...rep(128, 8)])).blend, 'alpha');
  assert.equal(alphaMode(mk(rep(0, 16))).blend, 'opaque');
  assert.equal(alphaMode(null).blend, 'opaque');
});

test('loadSfx keeps present wavs, drops missing or empty ones', async () => {
  const wav = new Uint8Array(100);
  const reader = { wav: async n => n === 'a' ? wav : n === 'b' ? new Uint8Array(10) : null };
  assert.deepEqual([...(await loadSfx(reader, ['a', 'b', 'c'])).keys()], ['a']);
  assert.equal((await loadSfx({}, ['a'])).size, 0);
});

test('readerFromFiles serves wavs from a 22K folder case-insensitively', async () => {
  const f = (p, bytes) => ({ name: p.split('/').pop(), webkitRelativePath: p, size: bytes.length, arrayBuffer: async () => bytes.buffer });
  const r = readerFromFiles([f('data/lev01/out_modelblock.bin', new Uint8Array(4)), f('data/wavs/22K/SFX_X.wav', new Uint8Array(60))]);
  assert.equal((await r.wav('sfx_x')).length, 60);
  assert.equal(await r.wav('nope'), null);
});

test('real install: SFX wavs are plain PCM and load', { skip: !process.env.SWE1R_DATA && 'SWE1R_DATA not set' }, async () => {
  const dir = path.join(process.env.SWE1R_DATA, 'wavs', '22K');
  const reader = { wav: async n => fs.existsSync(path.join(dir, `${n}.wav`)) ? new Uint8Array(fs.readFileSync(path.join(dir, `${n}.wav`))) : null };
  const got = await loadSfx(reader);
  assert.equal(got.size, Object.keys(SFX).length);
  for (const b of got.values()) assert.equal(String.fromCharCode(...b.slice(0, 4)), 'RIFF');
});
test('needleAngle sweeps 270 degrees and clamps bad input', () => {
  assert.equal(needleAngle(0), 0.75 * Math.PI);
  assert.ok(Math.abs(needleAngle(1) - 2.25 * Math.PI) < 1e-12);
  assert.equal(needleAngle(5), needleAngle(1));
  assert.equal(needleAngle(NaN), needleAngle(0));
});

test('real install: HUD ring/face sprites decode as 64x64', { skip: !process.env.SWE1R_DATA && 'SWE1R_DATA not set' }, async () => {
  const lev = findLev(process.env.SWE1R_DATA);
  const s = await loadHudSprites({ read: async n => new Uint8Array(fs.readFileSync(path.join(lev, n))) });
  assert.ok(s && s.ring.rgba.some((v, i) => i % 4 === 3 && v > 0) && s.face.rgba.some((v, i) => i % 4 === 3 && v > 0));
});
test('pod vertex bytes are normals, not colours (no G_GEOMETRYMODE -> lit)', () => {
  const body = new Uint8Array(256), dv = new DataView(body.buffer);
  dv.setUint32(0, 0x01003006); dv.setUint32(4, 64);       // G_VTX n=3 at 64
  dv.setUint32(8, 0x05000204); dv.setUint32(12, 0); body[16] = 0xdf;      // G_TRI1 0,1,2
  for (let i = 0; i < 3; i++) body.set([0x82, 0xee, 0x00, 0xff], 64 + i * 16 + 12);
  const [tri] = decodeTriangles(body, { cl: 0 });
  assert.deepEqual([tri[0].r, tri[0].g, tri[0].b], [1, 1, 1]);
});
