// Worker context: reads the environment, opens the encrypted store, builds the Instagram and AI
// clients and provides logging and media-exposure helpers shared by every job.
//
// Public-log rule: GitHub Actions logs of a public repository are public. Only `say()` writes to
// the console and callers must pass NON-SENSITIVE text (counts, generic status). Everything
// detailed goes through `log()`, which is persisted to the encrypted `log` document.

import { b64decode, DecryptError, importDataKey, randomToken, utf8 } from '../core/crypto.js';
import { createGitHub, GitHubError } from '../core/github.js';
import { createStore, DATA_BRANCH } from '../core/store.js';
import { createIg } from '../core/ig.js';
import { createAi } from '../core/ai.js';
import { dayKey } from '../core/time.js';
import { stripMp4Metadata } from '../core/mp4.js';

export const LOG_ENTRY_CAP = 500;
export const RUN_CAP = 200;
export const DEFAULT_MAX_WAIT_SEC = 540;
export const TMP_PREFIX = 'public/tmp/';
/**
 * Throwaway branch for the plaintext copies Instagram downloads while publishing. It never has
 * history: every change points it at a new root commit holding only the copies still needed, so a
 * removed copy is not reachable from any branch (unlike a delete commit on the data branch).
 */
export const TMP_BRANCH = 'postpilot-public-tmp';
const TMP_README = '# Postpilot temporary media\n\nCopies of photos and videos that Instagram downloads while Postpilot publishes them.\nThe worker replaces this branch with a fresh commit as soon as Instagram has the media.\n';

/** True only for an Instagram login error (not a GitHub 401/403 or an AI key error). */
export const isIgAuth = (err) => err?.name === 'IgError' && !!err.isAuth;

/** Thrown when the worker cannot start. `publicMessage` is safe to print; `fatal` decides the exit code. */
export class ConfigError extends Error {
  constructor(code, publicMessage, { fatal = false } = {}) {
    super(publicMessage);
    this.name = 'ConfigError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.fatal = fatal;
  }
}

/** Error raised by the worker itself (not by Instagram) with a plain-language message for the app. */
export class WorkerError extends Error {
  constructor(message, { permanent = false, code = 'worker' } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.userMessage = message;
    this.permanent = permanent;
    this.isPermanent = permanent;
    this.isTransient = !permanent;
    this.code = code;
  }
}

/** Parse a "now" override (ISO string, epoch ms, Date or function) into a clock function. */
export function makeClock(now, envNow) {
  if (typeof now === 'function') {
    return () => {
      const v = now();
      return v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    };
  }
  const base = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : now ? Date.parse(now) : envNow ? Date.parse(envNow) : NaN;
  if (!Number.isFinite(base)) return () => Date.now();
  // A fixed starting point that still advances with real time, so waiting for a post works in tests.
  const offset = base - Date.now();
  return () => Date.now() + offset;
}

function parseRepository(value) {
  const m = String(value || '').match(/^([^/\s]+)\/([^/\s]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function trimSlash(s) {
  return String(s).replace(/\/+$/, '');
}

/**
 * Build the worker context.
 * @returns {Promise<object>} ctx (see README in ARCHITECTURE.md section 8)
 */
export async function createContext({ env = {}, fetchImpl, now, consoleLog = console.log, maxWaitSec, sleep: sleepImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const repoInfo = parseRepository(env.GITHUB_REPOSITORY);
  if (!repoInfo) throw new ConfigError('no_repository', 'GITHUB_REPOSITORY is not set (expected owner/repo).', { fatal: true });
  if (!env.GITHUB_TOKEN) throw new ConfigError('no_github_token', 'GITHUB_TOKEN is not set.', { fatal: true });

  let rawKey;
  try {
    rawKey = b64decode(String(env.POSTPILOT_DATA_KEY).trim());
  } catch {
    rawKey = null;
  }
  if (!rawKey || rawKey.length !== 32) {
    throw new ConfigError('bad_data_key', 'The POSTPILOT_DATA_KEY secret is not a valid Postpilot data key. Save the worker secret again in Settings.', { fatal: true });
  }
  const key = await importDataKey(rawKey);

  const { owner, repo } = repoInfo;
  const branch = env.POSTPILOT_BRANCH || DATA_BRANCH;
  const endpoints = {
    github: trimSlash(env.POSTPILOT_GITHUB_API || 'https://api.github.com'),
    raw: trimSlash(env.POSTPILOT_RAW_BASE || 'https://raw.githubusercontent.com'),
    ig: trimSlash(env.POSTPILOT_IG_BASE || 'https://graph.instagram.com'),
    fb: trimSlash(env.POSTPILOT_FB_BASE || 'https://graph.facebook.com'),
    rupload: trimSlash(env.POSTPILOT_RUPLOAD_BASE || 'https://rupload.facebook.com/ig-api-upload'),
    anthropic: env.POSTPILOT_ANTHROPIC_BASE ? trimSlash(env.POSTPILOT_ANTHROPIC_BASE) : undefined,
  };

  const gh = createGitHub({ token: env.GITHUB_TOKEN, owner, repo, apiBase: endpoints.github, fetchImpl: doFetch });
  const store = createStore({ gh, key, branch, author: 'worker' });

  const clock = makeClock(now, env.POSTPILOT_NOW);
  const startedAtMs = clock();
  const waitSec = Number(maxWaitSec ?? env.POSTPILOT_MAX_WAIT_SEC ?? DEFAULT_MAX_WAIT_SEC);
  const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))));

  // ---- console output (public) -------------------------------------------------------------
  const secrets = new Set();
  const inActions = env.GITHUB_ACTIONS === 'true';
  function scrub(text) {
    let out = String(text);
    for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join('***');
    return out;
  }
  function say(message) {
    consoleLog(scrub(message));
  }
  function mask(value) {
    if (typeof value !== 'string' || value.length < 4) return;
    if (!secrets.has(value)) {
      secrets.add(value);
      if (inActions) consoleLog(`::add-mask::${value}`);
    }
  }

  // ---- encrypted activity log ----------------------------------------------------------------
  const entries = []; // oldest first while buffering
  function log(job, level, message, data) {
    const entry = { at: new Date(clock()).toISOString(), job, level, message: String(message || '') };
    if (data !== undefined) entry.data = data;
    entries.push(entry);
    if (entries.length > LOG_ENTRY_CAP) entries.shift();
    return entry;
  }

  // ---- push notifications (sent by run.mjs at the end of the run, see notify.mjs) -------------
  const notifications = [];
  function notify(event, detail = {}) {
    notifications.push({ event, ...detail });
  }

  // ---- open the data branch ----------------------------------------------------------------
  let settings;
  try {
    settings = await store.read('settings');
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      throw new ConfigError('no_data_branch', `Postpilot data branch "${branch}" was not found. Finish setup in the app first.`);
    }
    if (err instanceof GitHubError && err.status === 403 && /rate limit/i.test(err.message)) {
      throw new ConfigError('github_rate_limit', 'GitHub rate limit reached; the worker will try again on its next run.');
    }
    if (err instanceof GitHubError && err.isAuth) {
      throw new ConfigError('github_auth', 'GitHub refused the worker token. Check that the workflow has "contents: write" permission.', { fatal: true });
    }
    if (err instanceof DecryptError || err?.name === 'DecryptError') {
      throw new ConfigError('wrong_data_key', 'The POSTPILOT_DATA_KEY secret does not unlock this workspace. Save the worker secret again in Settings > Worker.', { fatal: true });
    }
    throw err;
  }

  for (const v of [settings.ig?.token, settings.ig?.pageToken, settings.ig?.userToken, settings.ig?.appSecret, settings.ai?.apiKey]) mask(v);

  const tz = settings.timezone || 'UTC';

  function buildIg(igs) {
    if (!igs || !igs.token || !igs.userId) return null;
    return createIg({
      mode: igs.mode || 'instagram',
      token: igs.token,
      userId: igs.userId,
      pageId: igs.pageId,
      pageToken: igs.pageToken,
      igBase: endpoints.ig,
      fbBase: endpoints.fb,
      ruploadBase: endpoints.rupload,
      fetchImpl: doFetch,
    });
  }

  async function buildAi(s) {
    const ai = s.ai || {};
    if (!ai.enabled || !ai.apiKey) return null;
    try {
      const { default: Anthropic } = await import('../vendor/anthropic-sdk.js');
      return createAi({
        Anthropic,
        apiKey: ai.apiKey,
        model: ai.model || undefined,
        baseURL: endpoints.anthropic,
        // The vendored SDK is a browser build; this flag only silences its browser check in Node.
        dangerouslyAllowBrowser: true,
        timeout: 120_000,
        voice: ai.voice || '',
        language: ai.language || 'English',
      });
    } catch (err) {
      log('worker', 'warn', `AI assistant could not start: ${err.message || err}`);
      return null;
    }
  }

  // ---- media exposure (public/tmp on the throwaway branch) -----------------------------------
  const exposed = new Set();
  let repoPublicChecked = false;
  let tmpFiles = null; // Map(path -> blob sha) of the copies on the throwaway branch, loaded once
  let tmpExists = false;
  let tmpReadmeSha = null;
  let tmpQueue = Promise.resolve();

  function rawUrl(path, ref = branch) {
    return `${endpoints.raw}/${owner}/${repo}/${ref.split('/').map(encodeURIComponent).join('/')}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Run changes to the throwaway branch one at a time (each one replaces the whole branch). */
  function withTmpBranch(fn) {
    const next = tmpQueue.then(fn, fn);
    tmpQueue = next.catch(() => {});
    return next;
  }

  async function loadTmpFiles() {
    if (tmpFiles) return tmpFiles;
    const files = new Map();
    const head = await gh.getRef(TMP_BRANCH);
    if (head) {
      const c = await gh.getCommit(head);
      for (const e of await gh.getTree(c.tree.sha)) if (e.path.startsWith(TMP_PREFIX)) files.set(e.path, e.sha);
    }
    tmpExists = !!head;
    tmpFiles = files;
    return files;
  }

  /** Point the throwaway branch at a new root commit holding exactly `files` (force, no history). */
  async function writeTmpBranch(files) {
    if (!tmpReadmeSha) tmpReadmeSha = await gh.createBlob(utf8(TMP_README));
    const tree = await gh.createTree([{ path: 'README.md', sha: tmpReadmeSha }, ...[...files].map(([path, sha]) => ({ path, sha }))]);
    const commit = await gh.createCommit({ message: 'Temporary media for Instagram', tree, parents: [] });
    const point = (create) => (create ? gh.createRef(TMP_BRANCH, commit) : gh.updateRef(TMP_BRANCH, commit, true));
    try {
      await point(!tmpExists);
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
      await point(tmpExists); // the branch was created or deleted meanwhile
    }
    tmpExists = true;
    tmpFiles = new Map(files);
  }

  /** Remove copies from the throwaway branch. Returns how many were there. */
  function removeTmpFiles(shouldRemove) {
    return withTmpBranch(async () => {
      const files = await loadTmpFiles();
      const next = new Map([...files].filter(([p]) => !shouldRemove(p)));
      if (next.size === files.size) return 0;
      await writeTmpBranch(next);
      return files.size - next.size;
    });
  }

  async function readMedia(asset) {
    const path = asset.path || `media/${asset.id}`;
    const bytes = await store.readBytes(path);
    if (!bytes) throw new WorkerError(`The media file "${asset.name || asset.id}" is missing from the library. Upload it again.`, { permanent: true, code: 'media_missing' });
    return bytes;
  }

  function extensionFor(asset) {
    const mime = String(asset.mime || '').toLowerCase();
    if (asset.kind === 'video' || mime.startsWith('video/')) return mime === 'video/quicktime' ? 'mov' : 'mp4';
    return 'jpg';
  }

  async function waitForUrl(url, { timeoutMs = 60_000, intervalMs = 2_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = 0;
    for (;;) {
      try {
        const res = await doFetch(url, { method: 'HEAD', cache: 'no-store' });
        last = res.status;
        if (res.status === 200) return true;
      } catch {
        last = -1;
      }
      if (Date.now() >= deadline) break;
      await sleep(intervalMs);
    }
    throw new WorkerError(
      last === 404
        ? 'Instagram could not be given the media file because it is not publicly reachable on GitHub. The repository must be public.'
        : 'GitHub did not serve the media file in time. Postpilot will try again on the next run.',
      { permanent: false, code: 'expose_failed' },
    );
  }

  async function exposeMedia(asset) {
    if (!repoPublicChecked) {
      const info = await gh.getRepo().catch(() => null);
      repoPublicChecked = true;
      if (info && info.private === true) {
        throw new WorkerError('Instagram can only download media from a public repository, and this repository is private. Make it public (all private data stays encrypted).', {
          permanent: true,
          code: 'repo_private',
        });
      }
    }
    // readMedia returns a fresh decrypted copy, so stripping in place never touches the stored original.
    const bytes = await readMedia(asset);
    const ext = extensionFor(asset);
    if (ext !== 'jpg') stripMp4Metadata(bytes); // photos were re-encoded (no EXIF) when they were added
    const path = `${TMP_PREFIX}${Math.floor(clock() / 1000)}-${randomToken(12)}.${ext}`;
    const sha = await gh.createBlob(bytes);
    await withTmpBranch(async () => {
      const files = new Map(await loadTmpFiles());
      files.set(path, sha);
      await writeTmpBranch(files);
    });
    exposed.add(path);
    const url = rawUrl(path, TMP_BRANCH);
    await waitForUrl(url, { timeoutMs: Number(env.POSTPILOT_EXPOSE_TIMEOUT_MS || 60_000) });
    return { url, path };
  }

  /** Remove exposed copies from the throwaway branch (ignores paths that are already gone). */
  async function removeExposed(paths) {
    const list = new Set((paths || []).filter((p) => typeof p === 'string' && p.startsWith(TMP_PREFIX)));
    if (!list.size) return 0;
    const removed = await removeTmpFiles((p) => list.has(p));
    for (const p of list) exposed.delete(p);
    return removed;
  }

  /**
   * Rewrite the throwaway branch so it holds only the copies in `keep` (media of containers that
   * Instagram may still be downloading). Clears leftovers from earlier runs that stopped early.
   */
  async function pruneExposed(keep = []) {
    const keepSet = new Set(keep);
    return removeTmpFiles((p) => !keepSet.has(p));
  }

  /** Delete exposed public/tmp files (ignores paths that are already gone). */
  async function cleanupExposed(paths) {
    const list = [...new Set((paths || []).filter((p) => typeof p === 'string' && p.startsWith(TMP_PREFIX)))];
    if (!list.length) return 0;
    const removed = await removeExposed(list);
    // Copies made on the data branch by older versions of the worker.
    let legacy = 0;
    await store.transact(
      async (tx) => {
        legacy = 0;
        for (const p of list) {
          if (tx.exists(p)) {
            tx.delete(p);
            legacy++;
          }
        }
      },
      { message: 'remove temporary media' },
    );
    return removed + legacy;
  }

  const ctx = {
    env,
    owner,
    repo,
    branch,
    endpoints,
    gh,
    store,
    settings,
    tz,
    /** fetch for other sites (feeds and linked media downloads); the injected fetchImpl in tests. */
    fetch: doFetch,
    ig: null,
    ai: null,
    startedAtMs,
    maxWaitMs: Math.max(0, (Number.isFinite(waitSec) ? waitSec : DEFAULT_MAX_WAIT_SEC) * 1000),
    deadlineMs: 0,
    now: () => new Date(clock()),
    nowMs: clock,
    nowIso: () => new Date(clock()).toISOString(),
    today: () => dayKey(new Date(clock()), tz),
    sleep,
    log,
    entries,
    notify,
    notifications,
    say,
    mask,
    scrub,
    rawUrl,
    exposeMedia,
    readMedia,
    cleanupExposed,
    removeExposed,
    pruneExposed,
    exposed,
    waitForUrl,
    trigger: env.GITHUB_EVENT_NAME || 'manual',
    /** Rebuild the Instagram client (after a token refresh or reconnect). */
    setIgSettings(igs) {
      ctx.settings.ig = igs;
      for (const v of [igs?.token, igs?.pageToken, igs?.userToken]) mask(v);
      ctx.ig = buildIg(igs);
      return ctx.ig;
    },
    /** Re-read settings from the branch and rebuild clients. */
    async reloadSettings() {
      await store.refresh();
      ctx.settings = await store.read('settings');
      for (const v of [ctx.settings.ig?.token, ctx.settings.ig?.pageToken, ctx.settings.ig?.userToken, ctx.settings.ai?.apiKey]) mask(v);
      ctx.ig = buildIg(ctx.settings.ig);
      return ctx.settings;
    },
  };
  ctx.deadlineMs = startedAtMs + ctx.maxWaitMs;
  ctx.ig = buildIg(settings.ig);
  ctx.ai = await buildAi(settings);
  return ctx;
}

/** Plain-language description of any error (IgError.userMessage, WorkerError, GitHubError...). */
export function describeError(err) {
  if (!err) return 'Unknown error';
  return err.userMessage || err.message || String(err);
}

/** Short, non-sensitive category for console output. */
export function errorKind(err) {
  if (!err) return 'error';
  if (isIgAuth(err)) return 'Instagram login problem';
  if (err.isRateLimit) return 'rate limited';
  if (err.name === 'GitHubError') return `GitHub error ${err.status || ''}`.trim();
  if (err.name === 'ConflictError') return 'data kept changing';
  if (err.isTransient) return 'temporary problem';
  return 'error';
}
