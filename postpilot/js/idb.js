// Tiny IndexedDB key-value store used to cache immutable git blobs between visits.

const DB = 'postpilot';
const STORE = 'blobs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbBlobStore() {
  if (typeof indexedDB === 'undefined') return null;
  let dbp = null;
  const db = () => (dbp ||= open());
  const run = (mode, fn) =>
    db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const tx = d.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req && req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  return {
    get: (sha) => run('readonly', (s) => s.get(sha)).then((v) => (v ? new Uint8Array(v) : null)),
    set: (sha, bytes) => run('readwrite', (s) => s.put(bytes, sha)),
  };
}

export async function clearBlobCache() {
  if (typeof indexedDB === 'undefined') return;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
