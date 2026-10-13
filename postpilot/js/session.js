// Unlocking the app: GitHub token + passphrase -> data key -> store.

import { b64decode, b64encode, createKeyring, decryptBytes, DecryptError, generateDataKey, importDataKey, unlockKeyring, utf8 } from '../core/crypto.js';
import { createGitHub, GitHubError } from '../core/github.js';
import { createBlobCache, createDataBranch, createStore, readKeyring } from '../core/store.js';
import { DATA_BRANCH, DATA_KEY_SECRET, ENDPOINTS } from './config.js';
import { idbBlobStore } from './idb.js';

const KEY = 'postpilot.session';

/** Saved sessions, this tab's first, then the remembered one. */
function storageAll() {
  const out = [];
  for (const s of [safe(() => sessionStorage), safe(() => localStorage)]) {
    try {
      const raw = s && s.getItem(KEY);
      if (raw) out.push(JSON.parse(raw));
    } catch {
      /* storage unavailable */
    }
  }
  return out;
}

function storageGet() {
  return storageAll()[0] || null;
}

function storageSet(value, remember) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
  try {
    if (remember) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Last used owner/repo/token hints (never the passphrase). */
export function savedLogin() {
  const s = storageGet();
  if (s) return { owner: s.owner, repo: s.repo, remember: !!s.remember, hasToken: !!s.token };
  try {
    const hint = JSON.parse(localStorage.getItem('postpilot.hint') || 'null');
    if (hint) return hint;
  } catch {
    /* ignore */
  }
  return null;
}

function rememberHint(owner, repo) {
  try {
    localStorage.setItem('postpilot.hint', JSON.stringify({ owner, repo }));
  } catch {
    /* ignore */
  }
}

export function forget() {
  for (const s of [safe(() => sessionStorage), safe(() => localStorage)]) {
    try {
      s && s.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

function build({ token, owner, repo, dataKeyRaw, login, onChange }) {
  const gh = createGitHub({ token, owner, repo, apiBase: ENDPOINTS.github });
  return importDataKey(dataKeyRaw).then((key) => {
    const store = createStore({
      gh,
      key,
      branch: DATA_BRANCH,
      author: 'app',
      cache: createBlobCache({ persist: idbBlobStore() }),
      onChange,
    });
    return { gh, store, key, owner, repo, branch: DATA_BRANCH, login, dataKeyRaw, token };
  });
}

/**
 * Check a token against a repo before asking for the passphrase.
 * Returns { login, repoInfo, keyring, isPrivate } (keyring null when Postpilot has not been set up there;
 * isPrivate true for a private repository, where free GitHub Pages and publishing do not work).
 */
export async function inspectRepo({ token, owner, repo }) {
  const gh = createGitHub({ token, owner, repo, apiBase: ENDPOINTS.github });
  const user = await gh.getUser();
  let repoInfo;
  try {
    repoInfo = await gh.getRepo();
  } catch (err) {
    if (err instanceof GitHubError && err.isNotFound) {
      throw new GitHubError(404, `Repository ${owner}/${repo} was not found, or this token cannot access it.`);
    }
    throw err;
  }
  if (repoInfo.permissions && repoInfo.permissions.push === false) {
    throw new GitHubError(403, 'This token can read the repository but cannot write to it. Give it "Contents: Read and write".');
  }
  const keyring = await readKeyring(gh, DATA_BRANCH);
  return { login: user.login, repoInfo, keyring, isPrivate: repoInfo.private === true };
}

export async function unlock({ token, owner, repo, passphrase, remember, keyring, login, onChange }) {
  const gh = createGitHub({ token, owner, repo, apiBase: ENDPOINTS.github });
  const kr = keyring || (await readKeyring(gh, DATA_BRANCH));
  if (!kr) throw new Error('Postpilot is not set up in this repository yet.');
  const dataKeyRaw = await unlockKeyring(kr, passphrase);
  storageSet({ token, owner, repo, dataKey: b64encode(dataKeyRaw), login, remember: !!remember }, remember);
  rememberHint(owner, repo);
  return build({ token, owner, repo, dataKeyRaw, login, onChange });
}

/** First-time setup: create the encrypted data branch. */
export async function createWorkspace({ token, owner, repo, passphrase, remember, login, onChange }) {
  const gh = createGitHub({ token, owner, repo, apiBase: ENDPOINTS.github });
  const dataKeyRaw = generateDataKey();
  const keyring = await createKeyring(passphrase, dataKeyRaw);
  await createDataBranch(gh, keyring, DATA_BRANCH);
  storageSet({ token, owner, repo, dataKey: b64encode(dataKeyRaw), login, remember: !!remember }, remember);
  rememberHint(owner, repo);
  return build({ token, owner, repo, dataKeyRaw, login, onChange });
}

/**
 * Re-open a session saved in this browser (no passphrase needed). When the data key was replaced
 * (Settings → Security on any device), a saved key no longer decrypts: it is dropped and the lock screen shows.
 */
export async function resume({ onChange } = {}) {
  const tried = new Set();
  for (const s of storageAll()) {
    if (!s || !s.token || !s.dataKey || tried.has(s.dataKey)) continue;
    tried.add(s.dataKey);
    let session;
    try {
      session = await build({ token: s.token, owner: s.owner, repo: s.repo, dataKeyRaw: b64decode(s.dataKey), login: s.login, onChange });
      await session.store.read('settings');
    } catch (err) {
      if (!session || err instanceof DecryptError) continue;
      // Offline or GitHub unavailable: open anyway, the app explains the error.
    }
    if (tried.size > 1) storageSet(s, !!s.remember);
    return session;
  }
  if (tried.size) forget();
  return null;
}

/**
 * Re-wrap the same data key under a new passphrase. Nothing is re-encrypted and the worker keeps working.
 * It does not lock anyone out: the previous keyring.json stays in the public history of the data branch.
 */
export async function changePassphrase(session, newPassphrase) {
  const keyring = await createKeyring(newPassphrase, session.dataKeyRaw);
  await session.store.transact(async (tx) => tx.writePublic('keyring.json', keyring), { message: 'change passphrase' });
}

/** Files encrypted with the data key: documents and media (originals and thumbnails). */
function encryptedPaths(tx) {
  return [...tx.list('db/').filter((p) => p.endsWith('.enc')), ...tx.list('media/')];
}

/**
 * Change the passphrase AND replace the data key. In one commit every encrypted file (db/*.enc, media/*)
 * is decrypted with the current key and re-encrypted with a new one, and keyring.json is re-written for
 * the new passphrase. Then the worker's POSTPILOT_DATA_KEY secret is re-sealed and this browser's saved
 * session switches to the new key. `session.store` keeps using the old key, so reload the app afterwards.
 * Earlier commits stay readable with the old key: rotation protects what is written from now on.
 * Returns { dataKeyRaw, secretSaved, secretError }.
 */
export async function rotateDataKey(session, newPassphrase, { onProgress } = {}) {
  const { gh } = session;
  // Without access to Actions secrets the worker would be left with a key that no longer works: stop before changing anything.
  let pk;
  try {
    pk = await gh.getSecretsPublicKey();
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      throw new Error('Your GitHub token cannot update the worker\'s secret, so the worker would stop working with a new key. Give the token "Secrets: Read and write" for this repository, or change only the passphrase.');
    }
    throw err;
  }
  const dataKeyRaw = generateDataKey();
  const newKey = await importDataKey(dataKeyRaw);
  const keyring = await createKeyring(newPassphrase, dataKeyRaw);
  // A second store that encrypts with the new key; reads use raw bytes decrypted with the old key.
  const writer = createStore({ gh, key: newKey, branch: session.branch || DATA_BRANCH, author: 'app' });
  await writer.transact(async (tx) => {
    const paths = encryptedPaths(tx);
    let done = 0;
    for (const path of paths) {
      let plain;
      try {
        plain = await decryptBytes(session.key, await tx.readBytes(path, { decrypt: false }));
      } catch (err) {
        throw new Error(`Could not decrypt ${path} with the current key, so nothing was changed. ${err.message || err}`);
      }
      tx.writeBytes(path, plain);
      onProgress?.({ done: ++done, total: paths.length });
    }
    tx.writePublic('keyring.json', keyring);
  }, { message: 'rotate data key' });

  const saved = storageGet() || { token: session.token, owner: session.owner, repo: session.repo, login: session.login, remember: false };
  storageSet({ ...saved, dataKey: b64encode(dataKeyRaw) }, !!saved.remember);

  try {
    const { sealedBox } = await import('../vendor/sealed-box.js');
    const sealed = sealedBox(utf8(b64encode(dataKeyRaw)), b64decode(pk.key));
    await gh.putSecret(DATA_KEY_SECRET, b64encode(sealed), pk.key_id);
    return { dataKeyRaw, secretSaved: true, secretError: null };
  } catch (err) {
    return { dataKeyRaw, secretSaved: false, secretError: err };
  }
}
