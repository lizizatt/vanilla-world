import { AssetError } from './asset-source.js';

const DB = 'vanilla-world-local-folder';
async function store(mode, action) {
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('handles', mode);
      const request = action(transaction.objectStore('handles'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Folder storage aborted'));
    });
  } catch (error) {
    throw new AssetError('STORAGE', 'Cannot persist the Data folder handle', error);
  } finally { db?.close(); }
}
export const rememberDataFolder = handle => {
  if (handle?.kind !== 'directory') throw new AssetError('INVALID_FOLDER', 'Expected a Data directory handle');
  return store('readwrite', records => records.put(handle, 'data'));
};
export const restoreDataFolder = () => store('readonly', records => records.get('data'));
export const forgetDataFolder = () => store('readwrite', records => records.delete('data'));

// request=true must be called directly from a main-thread user gesture, never a worker.
export async function authorizeDataFolder(handle, { request = false } = {}) {
  if (handle?.kind !== 'directory') throw new AssetError('INVALID_FOLDER', 'Expected a Data directory handle');
  try {
    let permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && request) permission = await handle.requestPermission({ mode: 'read' });
    return permission === 'granted';
  } catch (error) {
    throw new AssetError('PERMISSION', 'Cannot authorize Data folder access; use a user-gesture button', error);
  }
}
