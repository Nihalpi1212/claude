// Unlocking the app: GitHub token + passphrase -> data key -> store.

import { b64decode, b64encode, createKeyring, generateDataKey, importDataKey, unlockKeyring } from '../core/crypto.js';
import { createGitHub, GitHubError } from '../core/github.js';
import { createBlobCache, createDataBranch, createStore, readKeyring } from '../core/store.js';
import { DATA_BRANCH, ENDPOINTS } from './config.js';
import { idbBlobStore } from './idb.js';

const KEY = 'postpilot.session';

function storageGet() {
  for (const s of [safe(() => sessionStorage), safe(() => localStorage)]) {
    try {
      const raw = s && s.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      /* storage unavailable */
    }
  }
  return null;
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
 * Returns { login, repo, keyring } (keyring null when Postpilot has not been set up there).
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
  return { login: user.login, repoInfo, keyring };
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

/** Re-open a session saved in this browser (no passphrase needed). */
export async function resume({ onChange } = {}) {
  const s = storageGet();
  if (!s || !s.token || !s.dataKey) return null;
  try {
    return await build({ token: s.token, owner: s.owner, repo: s.repo, dataKeyRaw: b64decode(s.dataKey), login: s.login, onChange });
  } catch {
    forget();
    return null;
  }
}

/** Re-wrap the data key under a new passphrase. */
export async function changePassphrase(session, newPassphrase) {
  const keyring = await createKeyring(newPassphrase, session.dataKeyRaw);
  await session.store.transact(async (tx) => tx.writePublic('keyring.json', keyring), { message: 'change passphrase' });
}
