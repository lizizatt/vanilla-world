// Local cache of the Racer files we use (blocks + 22K wavs), for folders the browser's directory picker refuses
// (Chromium blocks Program Files, Windows, AppData ... and their children) and for persistence across reloads.
// Lives in this browser's IndexedDB only; never uploaded, committed or shipped. Backend is injectable for tests.
const DB = 'swe1r-cache';

export function idbBackend(idb = indexedDB) {
  const open = () => new Promise((res, rej) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('bytes'); r.result.createObjectStore('index'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = async (stores, mode, fn) => {
    const db = await open();
    try {
      return await new Promise((res, rej) => {
        const t = db.transaction(stores, mode), out = fn(...stores.map(s => t.objectStore(s)));
        t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error ?? new Error('cache aborted'));
      });
    } finally { db.close(); }
  };
  return {
    put: (name, bytes, meta) => run(['bytes', 'index'], 'readwrite', (b, i) => { b.put(bytes, name); return i.put(meta, name); }),
    get: name => run(['bytes'], 'readonly', b => b.get(name)),
    index: () => run(['index'], 'readonly', i => i.getAll()).then(async v => { const k = await run(['index'], 'readonly', i => i.getAllKeys()); return new Map(k.map((n, x) => [n, v[x]])); }),
    clear: () => run(['bytes', 'index'], 'readwrite', (b, i) => { i.clear(); return b.clear(); }),
  };
}

// Reader key for a picked file path, or null when we do not use it.
export function cacheKey(path) {
  const p = path.replace(/\\/g, '/').toLowerCase();
  return /(?:^|\/)lev01\/(out_[a-z]+block\.bin)$/.exec(p)?.[1] ?? /(?:^|\/)wavs\/((?:22k|music)\/.+\.wav)$/.exec(p)?.[1] ?? null;
}

export const MUSIC_CAP = 100 * 1024 * 1024;
const isMusic = key => key.startsWith('music/');
export const tick = () => new Promise(r => setTimeout(r));

// Copies the wanted files into the backend one at a time (yielding between files so playback stays smooth), skipping files whose
// size and mtime already match. progress(done, total, bytesWritten).
export async function cacheFiles(files, backend, progress = () => {}) {
  const have = await backend.index(), todo = [];
  for (const f of files) {
    const key = cacheKey(f.webkitRelativePath || f.name);
    if (key) todo.push([key, f]);
  }
  // Music is big: keep the smallest tracks until the ~100 MB budget is used (loops and stingers are small).
  let budget = MUSIC_CAP;
  const music = todo.filter(([k]) => isMusic(k)).sort((a, b) => a[1].size - b[1].size).filter(([, f]) => (budget -= f.size) >= 0);
  todo.splice(0, todo.length, ...todo.filter(([k]) => !isMusic(k)), ...music);
  let done = 0, written = 0;
  for (const [key, f] of todo) {
    const old = have.get(key);
    if (!old || old.size !== f.size || old.mtime !== f.lastModified) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      await backend.put(key, bytes, { size: f.size, mtime: f.lastModified });
      written += bytes.length;
    }
    progress(++done, todo.length, written);
    await tick();
  }
  return { files: todo.length, written };
}

export const cachedWavKey = n => (n.startsWith('Music/') ? `music/${n.slice(6).toLowerCase()}.wav` : `22k/${n.toLowerCase()}.wav`);

// Handle attaches: copy just the named Music/<name> tracks through the reader, one per tick, within the music budget.
export async function cacheMusic(reader, names, backend, progress = () => {}) {
  const have = await backend.index();
  let used = [...have].reduce((s, [k, m]) => s + (isMusic(k) ? m.size : 0), 0), done = 0, written = 0;
  for (const n of names) {
    const key = cachedWavKey(n);
    if (!have.has(key)) {
      const b = await reader.wav(n);
      if (b && used + b.length <= MUSIC_CAP) { await backend.put(key, b, { size: b.length, mtime: 0 }); used += b.length; written += b.length; }
    }
    progress(++done, names.length, written);
    await tick();
  }
  return { files: names.length, written };
}

// Reader over cached bytes, or null when the model block is missing.
export async function readerFromCache(backend) {
  const index = await backend.index();
  if (!index.has('out_modelblock.bin') || !index.has('out_textureblock.bin')) return null;
  const read = async n => { const b = await backend.get(n.toLowerCase()); if (!b) throw new Error(`missing ${n}`); return b; };
  return { name: 'cached Racer data', read, size: async n => index.get(n.toLowerCase())?.size ?? 0, slice: async (n, a, b) => (await read(n)).subarray(a, b),
    wav: async n => (await backend.get(cachedWavKey(n))) ?? null };
}
