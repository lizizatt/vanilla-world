// Optional Star Wars Episode I: Racer data folder (local only; nothing here is uploaded, cached to disk by us, or shipped).
// Accepts the game root, its data\ folder, or data\lev01. Works with a FileSystemDirectoryHandle (Chromium) or
// a webkitdirectory FileList (Firefox). Returns a reader: { name, read(file) -> Uint8Array, size(file) }.
import { rememberDataFolder, restoreDataFolder, forgetDataFolder, authorizeDataFolder } from '../asset-folder.js';

const KEY = 'swe1r';
const BLOCKS = ['out_modelblock.bin', 'out_textureblock.bin', 'out_spriteblock.bin'];

async function sub(dir, name) {
  try { return await dir.getDirectoryHandle(name); } catch { return null; }
}

export async function levFromHandle(handle) {
  for (const path of [[], ['lev01'], ['data', 'lev01']]) {
    let d = handle;
    for (const p of path) d = d && await sub(d, p);
    if (!d) continue;
    try { await d.getFileHandle(BLOCKS[0]); return d; } catch { /* try next layout */ }
  }
  return null;
}

// data\wavs\22K next to lev01 (picked root or its data\ folder); null when absent.
export async function wavsFromHandle(handle) {
  for (const path of [['wavs', '22K'], ['data', 'wavs', '22K']]) {
    let d = handle;
    for (const p of path) d = d && await sub(d, p);
    if (d) return d;
  }
  return null;
}

export function readerFromHandle(lev, label, wavs) {
  const file = name => lev.getFileHandle(name).then(h => h.getFile());
  const wav = async n => { try { return new Uint8Array(await (await (await wavs.getFileHandle(`${n}.wav`)).getFile()).arrayBuffer()); } catch { return null; } };
  return { name: label ?? lev.name, wav: wavs ? wav : async () => null, size: async n => (await file(n)).size, read: async n => new Uint8Array(await (await file(n)).arrayBuffer()), slice: async (n, a, b) => new Uint8Array(await (await file(n)).slice(a, b).arrayBuffer()) };
}

export function readerFromFiles(files) {
  const byName = new Map();
  for (const f of files) {
    const base = f.name.toLowerCase();
    if (BLOCKS.includes(base) || base === 'out_splineblock.bin' || base.endsWith('.wav') || base.endsWith('.tga')) byName.set(f.webkitRelativePath || f.name, f);
  }
  const find = n => [...byName].find(([p]) => p.toLowerCase().replace(/\\/g, '/').endsWith(`/${n}`) || p === n)?.[1];
  if (!find(BLOCKS[0])) return null;
  const need = n => find(n) ?? (() => { throw new Error(`missing ${n}`); })();
  const wav = async n => { const f = find(`22k/${n.toLowerCase()}.wav`); return f ? new Uint8Array(await f.arrayBuffer()) : null; };
  return { name: 'selected files', wav, size: async n => need(n).size, read: async n => new Uint8Array(await need(n).arrayBuffer()), slice: async (n, a, b) => new Uint8Array(await need(n).slice(a, b).arrayBuffer()) };
}

// Cheap validation: item counts come from each block's first u32.
export async function describe(reader) {
  const count = async n => { const b = await reader.slice(n, 0, 4); return new DataView(b.buffer).getUint32(0, false); };
  return { models: await count(BLOCKS[0]), textures: await count(BLOCKS[1]), sprites: await count(BLOCKS[2]) };
}

export const remember = handle => rememberDataFolder(handle, KEY);
export const restore = () => restoreDataFolder(KEY).catch(() => undefined);
export const forget = () => forgetDataFolder(KEY);
export const authorize = (handle, request) => authorizeDataFolder(handle, { request });
