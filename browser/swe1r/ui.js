// Welcome-panel row for the optional SWE1R folder. Exposes the current reader via getSwe1r() for later phases.
import { levFromHandle, readerFromHandle, readerFromFiles, describe, remember, restore, forget, authorize } from './folder.js';

let reader = null;
const listeners = new Set();
export const getSwe1r = () => reader;
export const onSwe1r = fn => { listeners.add(fn); if (reader) fn(reader); };

export function initSwe1rRow(root = document) {
  const $ = id => root.getElementById(id);
  const status = $('swe1r-status'), pick = $('swe1r-pick'), forgetBtn = $('swe1r-forget'), files = $('swe1r-files');
  if (!status || !pick) return;
  const show = (text, ok = false) => { status.textContent = text; status.dataset.ok = ok ? '1' : ''; forgetBtn.hidden = !ok && !reader; };

  async function use(r, handle) {
    const info = await describe(r);
    reader = r;
    if (handle) await remember(handle).catch(() => {});
    show(`Racer data ready: ${info.models} models, ${info.textures} textures, ${info.sprites} sprites`, true);
    for (const fn of listeners) fn(r);
  }
  async function fromHandle(handle) {
    const lev = await levFromHandle(handle);
    if (!lev) throw new Error('No data\\lev01\\out_modelblock.bin found in that folder');
    await use(readerFromHandle(lev, handle.name), handle);
  }

  let pending = null;
  pick.addEventListener('click', async () => {
    try {
      if (pending) {
        if (!await authorize(pending, true)) throw new Error('read permission was not granted');
        const h = pending; pending = null; await fromHandle(h);
      } else if (window.showDirectoryPicker) await fromHandle(await window.showDirectoryPicker({ id: 'swe1r-data', mode: 'read' }));
      else files.click();
    } catch (e) { if (e.name !== 'AbortError') show(`Racer folder: ${e.message}`); }
  });
  files.addEventListener('change', async () => {
    try {
      const r = readerFromFiles([...files.files]);
      if (!r) throw new Error('No out_modelblock.bin in the selected files');
      await use(r);
    } catch (e) { show(`Racer folder: ${e.message}`); }
    files.value = '';
  });
  forgetBtn.addEventListener('click', async () => { await forget().catch(() => {}); reader = null; show('Optional: Star Wars Episode I: Racer data folder'); });

  restore().then(async handle => {
    if (!handle) return;
    if (await authorize(handle, false).catch(() => false)) await fromHandle(handle).catch(() => show('Racer folder moved or unreadable; pick it again'));
    else { pending = handle; show('Racer folder remembered; click to re-grant access'); }
  });
}
