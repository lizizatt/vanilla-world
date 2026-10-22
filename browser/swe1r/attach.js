import { readerFromCache, cachedWavKey } from './cache.js';

// Attach state machine for the optional Racer folder: pick / re-grant / restore / forget, valid in any order relative to
// the WoW Data folder and while the world is running. DOM-free; ui.js wires it. All collaborators are injected.
export const BLOCKED_HELP = 'Your browser refuses folders under Program Files, Windows or AppData (Steam installs live there). ' +
  'Use "Choose as files" instead, or copy the folder elsewhere, or make a junction: mklink /J C:\\Games\\Racer "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Star Wars Episode I Racer"';

// Chromium shows its own "contains system files" dialog and then rejects with AbortError, so a cancel is indistinguishable
// from a blocked folder: cancels carry the hint too.
export function classifyPickError(e) {
  const text = `${e?.name ?? ''} ${e?.message ?? e}`;
  if (e?.name === 'SecurityError' || /system files|can't be opened|blocked/i.test(text)) return { kind: 'blocked', message: BLOCKED_HELP };
  if (e?.name === 'AbortError') return { kind: 'cancel', message: `No folder chosen. If the browser said it "contains system files": ${BLOCKED_HELP}` };
  if (e?.name === 'NotAllowedError') return { kind: 'denied', message: 'Read permission was not granted.' };
  return { kind: 'other', message: e?.message ?? String(e) };
}

export function createAttach({ cache, handles, fromHandle, fromFiles, describe, cacheFiles, cacheMusic, musicNames = [], onChange, onStatus }) {
  let reader = null, source = null, pending = null;
  const say = (text, ok = false, extra = {}) => onStatus(text, ok, { fallback: false, ...extra });
  const keep = () => (reader ? ' Keeping the current Racer data.' : '');
  async function commit(r, from, note = '') {
    if (r.wav && !r.cachedMusic) { const w = r.wav; r.cachedMusic = true; r.wav = async n => (await w(n)) ?? (n.startsWith('Music/') ? cache.get(cachedWavKey(n)).catch(() => null) : null); }
    const info = await describe(r);
    reader = r; source = from;
    say(`Racer data ready (${from}): ${info.models} models, ${info.textures} textures, ${info.sprites} sprites${note}`, true);
    onChange(r);
  }
  async function useHandle(handle) {
    const r = await fromHandle(handle);
    if (!r) throw new Error('No data\\lev01\\out_modelblock.bin found in that folder.');
    await commit(r, 'folder');
    await handles.remember(handle).catch(() => {});
    if (cacheMusic) cacheMusic(r, musicNames, cache, (n, t) => say(`Caching music ${n}/${t}...`, true)).then(o => say(`Racer data ready (folder); music cached (${o.files} tracks).`, true), () => {});
    pending = null;
  }
  async function useFiles(files) {
    const r = fromFiles(files);
    if (!r) throw new Error('No out_modelblock.bin in the selected files.');
    await commit(r, 'selected files');
    try {
      const out = await cacheFiles(files, cache, (n, total) => say(`Caching Racer data ${n}/${total}...`, true));
      say(`Racer data ready and cached locally (${out.files} files); it will load after a reload.`, true);
    } catch (e) { say(`Racer data ready, but caching failed: ${e.message}`, true); }
  }
  const fail = e => {
    const c = classifyPickError(e);
    if (c.kind === 'cancel' && reader) return c; // cancelling a re-pick leaves the current data alone
    say(`Racer folder: ${c.message}${keep()}`, !!reader, { fallback: c.kind === 'blocked' || c.kind === 'cancel' });
    return c;
  };
  return {
    get reader() { return reader; }, get source() { return source; }, get pending() { return !!pending; },
    // showPicker: window.showDirectoryPicker wrapper or undefined. Returns 'files' when the caller should open the file input.
    async pick(showPicker) {
      try {
        if (pending) {
          if (!await handles.authorize(pending, true)) throw Object.assign(new Error('Read permission was not granted.'), { name: 'NotAllowedError' });
          return await useHandle(pending);
        }
        if (!showPicker) return 'files';
        return await useHandle(await showPicker());
      } catch (e) { return fail(e); }
    },
    async pickFiles(files) { try { await useFiles(files); } catch (e) { fail(e); } },
    async restore() {
      try {
        const handle = await handles.restore();
        if (handle) {
          if (await handles.authorize(handle, false).catch(() => false)) await useHandle(handle).catch(() => say('Racer folder moved or unreadable; pick it again.'));
          else { pending = handle; say('Racer folder remembered; click to re-grant access.'); }
          return;
        }
        const r = await readerFromCache(cache).catch(() => null);
        if (r) await commit(r, 'local cache');
      } catch { /* nothing remembered */ }
    },
    async forget() {
      await handles.forget().catch(() => {}); await cache.clear().catch(() => {});
      reader = null; source = null; pending = null;
      say('Optional: Star Wars Episode I: Racer data folder');
      onChange(null);
    },
  };
}
