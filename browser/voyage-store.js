function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vanilla-world-voyage', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('meta');
      request.result.createObjectStore('tiles');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Route storage blocked by another tab.'));
  });
}

export async function readRoute(store, key) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store);
    const request = tx.objectStore(store).get(key);
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Route read aborted')); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function writeRouteSave(save) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(save, 'save');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Route save aborted')); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

export async function importRoute(files, validate) {
  const selected = new Map();
  for (const file of files) {
    if (selected.has(file.name)) throw new Error(`Duplicate selected file: ${file.name}`);
    selected.set(file.name, file);
  }
  const descriptor = selected.get('route.json');
  if (!descriptor || descriptor.size > 64*1024) throw new Error('Select route.json (under 64 KiB) and all its ADT files together.');
  const json = await descriptor.text();
  await validate(json,files);
  const manifest = JSON.parse(json);
  const pack = { id: await digest(new TextEncoder().encode(json)), json, manifest };
  const db = await database();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['meta','tiles'], 'readwrite');
    tx.objectStore('tiles').clear();
    for (const tile of manifest.tiles) tx.objectStore('tiles').put(selected.get(tile.file), tile.file);
    tx.objectStore('meta').put(pack, 'pack');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('Pack import aborted; previous pack retained'));
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
  return pack;
}
