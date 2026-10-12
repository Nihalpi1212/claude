// Encrypted, transactional document store on top of a git branch.
//
// Layout of the data branch (default "postpilot-data"):
//   keyring.json            plaintext, wrapped data key (see crypto.js)
//   db/<name>.enc           encrypted JSON documents (see model.js DOCS)
//   media/<assetId>         encrypted media bytes
//   media/<assetId>.thumb   encrypted JPEG thumbnail
//   public/...              PLAINTEXT files anyone can read (link-in-bio, temporary publish files)
//
// Every write goes through transact(): it reads a snapshot at the branch head,
// runs the caller's function, writes all changes as ONE commit and moves the
// branch with a fast-forward-only ref update. If someone else (the worker or
// another tab) moved the branch first, the function is re-run on fresh data.

import { decryptBytes, decryptJSON, encryptBytes, encryptJSON, fromUtf8, utf8 } from './crypto.js';
import { GitHubError, sleep } from './github.js';
import { defaultDoc, docPath, migrateDoc } from './model.js';

export const DATA_BRANCH = 'postpilot-data';

// Plaintext marker `lock/compacting-<epochMs>` the worker commits while it replaces the branch
// (worker/jobs/maintenance.mjs). Its forced reset could discard a commit made meanwhile, so
// transact() waits while a fresh marker is in the tree. Markers older than 5 minutes are ignored.
export const COMPACT_LOCK_PREFIX = 'lock/compacting-';
const COMPACT_LOCK_MS = 5 * 60_000;

function compactionLocked(files, writes) {
  const locks = [...files.keys()].filter((p) => p.startsWith(COMPACT_LOCK_PREFIX));
  if (!locks.length || locks.some((p) => writes.has(p))) return false; // the worker's own lock/unlock
  return locks.some((p) => Math.abs(Date.now() - Number(p.slice(COMPACT_LOCK_PREFIX.length))) < COMPACT_LOCK_MS);
}

export class ConflictError extends Error {
  constructor() {
    super('Could not save because the data kept changing. Try again in a moment.');
    this.name = 'ConflictError';
  }
}

/**
 * In-memory (and optionally persistent) cache of git blobs keyed by sha. Blobs are immutable.
 * The memory part is a byte-capped LRU that never holds large blobs (video originals), and only
 * blobs under 8 MB are persisted. A persistent store that does not answer in time counts as a miss,
 * so a stuck IndexedDB can never block reads.
 */
export function createBlobCache({ persist, maxMemBytes = 48 * 1024 * 1024, maxItemBytes = 4 * 1024 * 1024, persistMaxBytes = 8 * 1024 * 1024, persistTimeoutMs = 1500 } = {}) {
  const mem = new Map(); // sha -> bytes, least recently used first
  let memBytes = 0;
  const drop = (sha) => {
    const v = mem.get(sha);
    if (!v) return;
    mem.delete(sha);
    memBytes -= v.length;
  };
  const remember = (sha, bytes) => {
    drop(sha);
    if (bytes.length > maxItemBytes) return;
    mem.set(sha, bytes);
    memBytes += bytes.length;
    for (const k of mem.keys()) {
      if (memBytes <= maxMemBytes) break;
      drop(k);
    }
  };
  const persisted = (p) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), persistTimeoutMs);
      Promise.resolve(p).then(
        (v) => (clearTimeout(timer), resolve(v || null)),
        () => (clearTimeout(timer), resolve(null)),
      );
    });
  return {
    async get(sha) {
      const hit = mem.get(sha);
      if (hit) {
        remember(sha, hit); // mark as recently used
        return hit;
      }
      if (persist) {
        const v = await persisted(persist.get(sha));
        if (v) {
          remember(sha, v);
          return v;
        }
      }
      return null;
    },
    async set(sha, bytes) {
      remember(sha, bytes);
      // Not awaited: the persistent copy is only an optimisation for the next visit.
      if (persist && bytes.length < persistMaxBytes) Promise.resolve(persist.set(sha, bytes)).catch(() => {});
    },
    /** Drop a blob that is no longer needed (e.g. a superseded document version). */
    async forget(sha) {
      drop(sha);
      if (persist && persist.delete) await persisted(persist.delete(sha));
    },
  };
}

export function createStore({ gh, key, branch = DATA_BRANCH, cache = createBlobCache(), author = 'app', onChange } = {}) {
  let head = null; // { commit, tree, files: Map(path -> {sha, size}) }
  let headPromise = null;
  const decoded = new Map(); // path -> { sha, value }: the latest parsed version of each doc (deep-cloned on read)
  const superseded = new Set(); // commits our own successful writes moved the branch past

  /** Memoise a parsed doc version and let the cache drop the version it replaces. */
  function rememberDoc(path, sha, value) {
    const prev = decoded.get(path);
    if (prev && prev.sha !== sha && cache.forget) cache.forget(prev.sha).catch(() => {});
    decoded.set(path, { sha, value });
  }

  async function loadHead() {
    const before = head;
    const commit = await gh.getRef(branch);
    if (!commit) throw new GitHubError(404, `The data branch "${branch}" does not exist yet. Finish setup first.`);
    if (head && head.commit === commit) return head;
    // A local commit landed while we were reading the ref, or the ref read lags behind our own write:
    // keep the newer head instead of rolling back to an older snapshot.
    if (head !== before || superseded.has(commit)) return head;
    const c = await gh.getCommit(commit);
    const entries = await gh.getTree(c.tree.sha);
    if (head !== before) return head; // a local commit landed during the fetch
    const prev = head;
    head = { commit, tree: c.tree.sha, files: new Map(entries.map((e) => [e.path, { sha: e.sha, size: e.size }])), loadedAt: Date.now() };
    if (prev && onChange) {
      const changed = [];
      for (const [p, f] of head.files) if (!prev.files.has(p) || prev.files.get(p).sha !== f.sha) changed.push(p);
      for (const p of prev.files.keys()) if (!head.files.has(p)) changed.push(p);
      if (changed.length) onChange(changed);
    }
    return head;
  }

  async function refresh() {
    if (!headPromise) headPromise = loadHead().finally(() => (headPromise = null));
    return headPromise;
  }

  async function ensureHead() {
    return head || refresh();
  }

  async function blobBytes(sha) {
    let bytes = await cache.get(sha);
    if (!bytes) {
      bytes = await gh.getBlob(sha);
      await cache.set(sha, bytes);
    }
    return bytes;
  }

  async function readDocAt(snapshot, name) {
    const path = docPath(name);
    const file = snapshot.files.get(path);
    if (!file) return defaultDoc(name);
    let memo = decoded.get(path);
    if (!memo || memo.sha !== file.sha) {
      const raw = await blobBytes(file.sha);
      const value = path.endsWith('.enc') ? await decryptJSON(key, raw) : JSON.parse(fromUtf8(raw));
      memo = { sha: file.sha, value: migrateDoc(name, value) };
      // Only the current head's version is kept, so a read of an older snapshot does not evict it.
      if (snapshot === head || !decoded.has(path)) rememberDoc(path, file.sha, memo.value);
    }
    return structuredClone(memo.value);
  }

  async function readBytesAt(snapshot, path, { decrypt = true } = {}) {
    const file = snapshot.files.get(path);
    if (!file) return null;
    const raw = await blobBytes(file.sha);
    return decrypt ? decryptBytes(key, raw) : raw;
  }

  async function transact(fn, { message = 'update', retries = 6 } = {}) {
    let lastErr;
    // Byte writes keep their blob across conflict retries. Encrypting again would give new bytes
    // (fresh IV), so without this a large upload would be sent again on every attempt.
    const byteBlobs = new Map(); // path -> { bytes, encrypt, sha }
    for (let attempt = 0; attempt <= retries; attempt++) {
      const snap = attempt === 0 ? await ensureHead() : await refresh();
      const writes = new Map(); // path -> {bytes|null}
      const docs = new Map(); // name -> value (read-your-writes)
      const tx = {
        snapshot: snap,
        async read(name) {
          if (docs.has(name)) return docs.get(name);
          const v = await readDocAt(snap, name);
          docs.set(name, v);
          return v;
        },
        write(name, value) {
          docs.set(name, value);
          writes.set(docPath(name), { doc: name, value });
        },
        async readBytes(path, opts) {
          return readBytesAt(snap, path, opts);
        },
        writeBytes(path, bytes, { encrypt = true } = {}) {
          writes.set(path, { bytes, encrypt });
        },
        writePublic(path, valueOrBytes) {
          const bytes = valueOrBytes instanceof Uint8Array ? valueOrBytes : utf8(JSON.stringify(valueOrBytes, null, 2));
          writes.set(path, { bytes, encrypt: false });
        },
        delete(path) {
          if (snap.files.has(path)) writes.set(path, { remove: true });
          else writes.delete(path);
        },
        exists(path) {
          return snap.files.has(path);
        },
        list(prefix) {
          return [...snap.files.keys()].filter((p) => p.startsWith(prefix));
        },
      };
      const result = await fn(tx);
      if (!writes.size) return result;
      if (compactionLocked(snap.files, writes)) {
        // The worker is compacting the branch: wait, then build on the compacted branch.
        lastErr = new ConflictError();
        await sleep(2000);
        continue;
      }

      const entries = [];
      const docBlobs = []; // [path, sha, docName, value]: memoised once the commit lands
      for (const [path, w] of writes) {
        if (w.remove) {
          entries.push({ path, sha: null });
          continue;
        }
        if (!w.doc) {
          const prev = byteBlobs.get(path);
          if (prev && prev.bytes === w.bytes && prev.encrypt === w.encrypt) {
            entries.push({ path, sha: prev.sha });
            continue;
          }
        }
        let bytes;
        if (w.doc) bytes = path.endsWith('.enc') ? await encryptJSON(key, w.value) : utf8(JSON.stringify(w.value, null, 2));
        else bytes = w.encrypt ? await encryptBytes(key, w.bytes) : w.bytes;
        const sha = await gh.createBlob(bytes);
        await cache.set(sha, bytes);
        if (w.doc) docBlobs.push([path, sha, w.doc, w.value]);
        else byteBlobs.set(path, { bytes: w.bytes, encrypt: w.encrypt, sha });
        entries.push({ path, sha });
      }
      const tree = await gh.createTree(entries, snap.tree);
      const commit = await gh.createCommit({ message: `${author}: ${message}`, tree, parents: [snap.commit] });
      try {
        await gh.updateRef(branch, commit, false);
      } catch (err) {
        if (err instanceof GitHubError && err.isConflict) {
          lastErr = err;
          await sleep(150 + Math.random() * 400 * (attempt + 1));
          continue;
        }
        throw err;
      }
      // Advance our cached head without another round trip.
      if (superseded.size >= 200) superseded.clear();
      superseded.add(snap.commit);
      for (const [path, sha, name, value] of docBlobs) rememberDoc(path, sha, migrateDoc(name, structuredClone(value)));
      const files = new Map(snap.files);
      for (const e of entries) {
        if (e.sha === null) files.delete(e.path);
        else files.set(e.path, { sha: e.sha, size: 0 });
      }
      head = { commit, tree, files, loadedAt: Date.now() };
      if (onChange) onChange(entries.map((e) => e.path));
      return result;
    }
    throw lastErr instanceof GitHubError ? new ConflictError() : lastErr;
  }

  return {
    branch,
    key,
    gh,
    refresh,
    get head() {
      return head;
    },
    async read(name) {
      return readDocAt(await ensureHead(), name);
    },
    async readMany(names) {
      const snap = await ensureHead();
      const out = {};
      await Promise.all(names.map(async (n) => (out[n] = await readDocAt(snap, n))));
      return out;
    },
    async readBytes(path, opts) {
      return readBytesAt(await ensureHead(), path, opts);
    },
    async exists(path) {
      return (await ensureHead()).files.has(path);
    },
    async list(prefix) {
      return [...(await ensureHead()).files.keys()].filter((p) => p.startsWith(prefix));
    },
    transact,
    /** Read-modify-write one document. mutator may mutate in place or return a new value. */
    async update(name, mutator, opts = {}) {
      return transact(
        async (tx) => {
          const current = await tx.read(name);
          const next = (await mutator(current)) ?? current;
          tx.write(name, next);
          return next;
        },
        { message: opts.message || `update ${name}`, retries: opts.retries },
      );
    },
  };
}

/** Create the orphan data branch with keyring.json as its first commit. */
export async function createDataBranch(gh, keyring, branch = DATA_BRANCH) {
  const existing = await gh.getRef(branch);
  if (existing) return existing;
  const readme = utf8(
    '# Postpilot data\n\nEncrypted data for Postpilot. Files under `db/` and `media/` are encrypted with AES-256-GCM.\n' +
      'Files under `public/` are intentionally public (link-in-bio page, media handed to Instagram at publish time).\n',
  );
  const keyringBytes = utf8(JSON.stringify(keyring, null, 2));
  const [readmeSha, keyringSha] = [await gh.createBlob(readme), await gh.createBlob(keyringBytes)];
  const tree = await gh.createTree([
    { path: 'README.md', sha: readmeSha },
    { path: 'keyring.json', sha: keyringSha },
  ]);
  const commit = await gh.createCommit({ message: 'Initialize Postpilot data', tree, parents: [] });
  await gh.createRef(branch, commit);
  return commit;
}

/** Read keyring.json from the data branch (plaintext). Returns null when not set up. */
export async function readKeyring(gh, branch = DATA_BRANCH) {
  const commit = await gh.getRef(branch);
  if (!commit) return null;
  const c = await gh.getCommit(commit);
  const files = await gh.getTree(c.tree.sha);
  const f = files.find((e) => e.path === 'keyring.json');
  if (!f) return null;
  return JSON.parse(fromUtf8(await gh.getBlob(f.sha)));
}
