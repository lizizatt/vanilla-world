// Welcome/Data-tab row for the optional SWE1R folder. DOM wiring only; the logic lives in attach.js. Exposes the current reader via getSwe1r().
import { levFromHandle, wavsFromHandle, musicFromHandle, readerFromHandle, readerFromFiles, describe, remember, restore, forget, authorize } from './folder.js';
import { createAttach } from './attach.js';
import { idbBackend, cacheFiles } from './cache.js';

const listeners = new Set();
let attach = null;
export const getSwe1r = () => attach?.reader ?? null;
// fn(reader) on every attach, fn(null) when forgotten.
export const onSwe1r = fn => { listeners.add(fn); if (attach?.reader) fn(attach.reader); };
export const attachSwe1r = () => document.getElementById('swe1r-pick')?.click();

export function initSwe1rRow(root = document) {
  const $ = id => root.getElementById(id);
  const status = $('swe1r-status'), pick = $('swe1r-pick'), forgetBtn = $('swe1r-forget'), files = $('swe1r-files'), asFiles = $('swe1r-as-files');
  if (!status || !pick) return;
  attach = createAttach({
    cache: idbBackend(), cacheFiles, describe,
    handles: { remember, restore, forget, authorize },
    fromHandle: async handle => { const lev = await levFromHandle(handle); return lev && readerFromHandle(lev, handle.name, await wavsFromHandle(handle), await musicFromHandle(handle)); },
    fromFiles: list => readerFromFiles(list),
    onChange: r => { forgetBtn.hidden = !r; for (const fn of listeners) fn(r); },
    onStatus: (text, ok, extra) => { status.textContent = text; status.dataset.ok = ok ? '1' : ''; asFiles.hidden = !extra.fallback; forgetBtn.hidden = !attach?.reader; },
  });
  pick.addEventListener('click', async () => {
    const picker = window.showDirectoryPicker && (() => window.showDirectoryPicker({ id: 'swe1r-data', mode: 'read' }));
    if (await attach.pick(picker) === 'files') files.click();
  });
  asFiles.addEventListener('click', () => files.click());
  files.addEventListener('change', async () => { const list = [...files.files]; files.value = ''; await attach.pickFiles(list); });
  forgetBtn.addEventListener('click', () => attach.forget());
  attach.restore();
}
