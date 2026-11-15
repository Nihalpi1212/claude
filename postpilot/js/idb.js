// Tiny IndexedDB key-value store used to cache immutable git blobs between visits.
// Capped by total size: once it holds more than MAX_BYTES, the oldest entries are dropped.

const DB = 'postpilot-blobs';
const LEGACY_DB = 'postpilot'; // first version: bare blobs with no timestamps, so it could never be pruned
const STORE = 'blobs';
const MAX_BYTES = 200 * 1024 * 1024;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    // Records are {bytes, at, size}; the index lets pruning read ages and sizes without loading any bytes.
    req.onupgradeneeded = () => req.result.createObjectStore(STORE).createIndex('age', ['at', 'size']);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbBlobStore({ maxBytes = MAX_BYTES } = {}) {
  if (typeof indexedDB === 'undefined') return null;
  try {
    indexedDB.deleteDatabase(LEGACY_DB);
  } catch {
    /* ignore */
  }
  let dbp = null;
  // Close our connection when another tab deletes or upgrades the database (Forget this device),
  // otherwise that request is blocked, and every later open queues behind it until this tab closes.
  const db = () =>
    (dbp ||= open().then(
      (d) => {
        d.onversionchange = () => {
          d.close();
          dbp = null;
        };
        return d;
      },
      (err) => {
        dbp = null;
        throw err;
      },
    ));
  const run = (mode, fn) =>
    db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const tx = d.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE), tx);
          tx.oncomplete = () => resolve(req && req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );

  let total = null; // bytes stored (approximate between prunes; null = not counted yet)
  let pruning = null;
  /** Drop the oldest entries until the store is back under 80% of maxBytes. */
  const prune = () =>
    (pruning ||= run('readwrite', (store) => {
      const found = [];
      let sum = 0;
      store.index('age').openKeyCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          found.push([c.primaryKey, c.key[1]]);
          sum += c.key[1];
          c.continue();
          return;
        }
        if (sum > maxBytes) {
          for (const [sha, size] of found) {
            if (sum <= maxBytes * 0.8) break;
            store.delete(sha);
            sum -= size;
          }
        }
        total = sum;
      };
    }).finally(() => (pruning = null)));

  return {
    get: (sha) =>
      run('readonly', (s) => s.get(sha)).then((v) => (v && v.bytes ? new Uint8Array(v.bytes) : null)),
    set: (sha, bytes) =>
      run('readwrite', (s) => s.put({ bytes, at: Date.now(), size: bytes.length }, sha)).then(() => {
        if (total !== null) total += bytes.length;
        if (total === null || total > maxBytes) prune().catch(() => {});
      }),
    delete: (sha) => run('readwrite', (s) => s.delete(sha)),
  };
}

export async function clearBlobCache() {
  if (typeof indexedDB === 'undefined') return;
  await Promise.all(
    [DB, LEGACY_DB].map(
      (name) =>
        new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    ),
  );
}
