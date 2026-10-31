// Explicit-click UI for the optional archive.org data source. Loaded only when ARCHIVE_DATA_SOURCE is stamped on.
import { NOTICE, downloadArchiveData, archiveCacheStatus, clearArchiveCache } from './archive-source.js';

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
};

export function installArchiveSource(app) {
  const root = () => navigator.storage.getDirectory();
  const open = el('button', { type: 'button', id: 'archive-open', textContent: 'Or download Data from archive.org (optional)' });
  const agree = el('input', { type: 'checkbox', id: 'archive-agree' });
  const audio = el('input', { type: 'checkbox', id: 'archive-audio' });
  const progress = el('progress', { id: 'archive-progress', max: 1, value: 0, hidden: true });
  const status = el('p', { id: 'archive-status', role: 'status' });
  const start = el('button', { type: 'button', id: 'archive-start', disabled: true, textContent: 'Download' });
  const cancel = el('button', { type: 'button', id: 'archive-cancel', textContent: 'Close' });
  const clear = el('button', { type: 'button', id: 'archive-clear', textContent: 'Delete downloaded data' });
  const dialog = el('dialog', { id: 'archive-dialog' },
    el('h2', {}, 'Get Data from archive.org'),
    ...NOTICE.map(text => el('p', {}, text)),
    el('label', {}, agree, ' I understand, and I have the right to use this content.'),
    el('label', {}, audio, ' Include audio (about 0.9 GB more)'),
    progress, status,
    el('footer', {}, clear, cancel, start));
  let controller;
  const refresh = async () => {
    start.disabled = !agree.checked || !!controller;
    const { files, bytes } = await archiveCacheStatus(await root()).catch(() => ({ files: 0, bytes: 0 }));
    clear.hidden = files === 0;
    if (!controller && files) status.textContent = `${files} files (${(bytes / 1e9).toFixed(2)} GB) are already stored on this device.`;
  };
  agree.addEventListener('change', refresh);
  open.addEventListener('click', () => { dialog.showModal(); void refresh(); });
  cancel.addEventListener('click', () => { controller?.abort(); dialog.close(); });
  clear.addEventListener('click', async () => {
    await clearArchiveCache(await root());
    status.textContent = 'Downloaded data deleted from this device.';
    await refresh();
  });
  start.addEventListener('click', async () => {
    controller = new AbortController();
    progress.hidden = false;
    start.disabled = true;
    try {
      const dir = await downloadArchiveData(await root(), { signal: controller.signal, audio: audio.checked, onProgress: ({ text, completed, total }) => {
        status.textContent = total ? `${text} (${(completed / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB)` : text;
        if (total) { progress.max = total; progress.value = completed; } else progress.removeAttribute('value');
      } });
      controller = undefined;
      dialog.close();
      app.folder = dir;
      await app.open(dir, true);
    } catch (error) {
      controller = undefined;
      status.textContent = error.name === 'AbortError' ? 'Cancelled. Finished files are kept; start again to resume.' : `Download failed: ${error.message}`;
      await refresh();
    }
  });
  document.getElementById('welcome-actions').append(open);
  document.body.append(dialog);
}
