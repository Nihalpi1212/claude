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

export class ConflictError extends Error {
  constructor() {
    super('Could not save because the data kept changing. Try again in a moment.');
    this.name = 'ConflictError';
  }
}

/** In-memory (and optionally persistent) cache of git blobs keyed by sha. Blobs are immutable. */
export function createBlobCache({ persist } = {}) {
  const mem = new Map();
  return {
    async get(sha) {
      if (mem.has(sha)) return mem.get(sha);
      if (persist) {
        const v = await persist.get(sha).catch(() => null);
        if (v) {
          mem.set(sha, v);
          return v;
        }
      }
      return null;
    },
    async set(sha, bytes) {
      mem.set(sha, bytes);
      if (persist && bytes.length < 8 * 1024 * 1024) await persist.set(sha, bytes).catch(() => {});
    },
  };
}

export function createStore({ gh, key, branch = DATA_BRANCH, cache = createBlobCache(), author = 'app', onChange } = {}) {
  let head = null; // { commit, tree, files: Map(path -> {sha, size}) }
  let headPromise = null;
  const decoded = new Map(); // `${path}@${sha}` -> parsed doc (deep-cloned on read)

  async function loadHead() {
    const commit = await gh.getRef(branch);
    if (!commit) throw new GitHubError(404, `The data branch "${branch}" does not exist yet. Finish setup first.`);
    if (head && head.commit === commit) return head;
    const c = await gh.getCommit(commit);
    const entries = await gh.getTree(c.tree.sha);
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
    const memoKey = `${path}@${file.sha}`;
    if (!decoded.has(memoKey)) {
      const raw = await blobBytes(file.sha);
      const value = path.endsWith('.enc') ? await decryptJSON(key, raw) : JSON.parse(fromUtf8(raw));
      decoded.set(memoKey, migrateDoc(name, value));
    }
    return structuredClone(decoded.get(memoKey));
  }

  async function readBytesAt(snapshot, path, { decrypt = true } = {}) {
    const file = snapshot.files.get(path);
    if (!file) return null;
    const raw = await blobBytes(file.sha);
    return decrypt ? decryptBytes(key, raw) : raw;
  }

  async function transact(fn, { message = 'update', retries = 6 } = {}) {
    let lastErr;
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

      const entries = [];
      for (const [path, w] of writes) {
        if (w.remove) {
          entries.push({ path, sha: null });
          continue;
        }
        let bytes;
        if (w.doc) bytes = path.endsWith('.enc') ? await encryptJSON(key, w.value) : utf8(JSON.stringify(w.value, null, 2));
        else bytes = w.encrypt ? await encryptBytes(key, w.bytes) : w.bytes;
        const sha = await gh.createBlob(bytes);
        await cache.set(sha, bytes);
        if (w.doc) decoded.set(`${path}@${sha}`, migrateDoc(w.doc, structuredClone(w.value)));
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
