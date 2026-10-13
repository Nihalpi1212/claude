// Maintenance:
// - keep-alive: GitHub disables scheduled workflows in public repositories after 60 days without
//   repository activity. Every ~20 days the worker calls the "enable workflow" API on itself (only
//   in GitHub Actions: a worker run elsewhere has no schedule there to keep alive). A refusal (403,
//   no `actions: write` permission) or a missing workflow (404) also waits the ~20 days, so it is one
//   warning per interval instead of one per run.
// - compaction: every encrypted write adds a new copy of a document to the data branch's history,
//   and encrypted data does not compress. About once a month, at night in the owner's time zone,
//   the branch is replaced by a single commit holding the same files so old copies can be
//   garbage-collected by GitHub. The current files are untouched. GitHub's ref update has no
//   compare-and-swap, so the worker first commits a lock marker (core/store.js
//   COMPACT_LOCK_PREFIX): the app does not commit on top of it, so the forced reset cannot
//   discard an app commit. The compacted tree leaves the marker out.

import { COMPACT_LOCK_PREFIX } from '../../core/store.js';
import { zonedParts } from '../../core/time.js';
import { DAY_MS } from './shared.mjs';

export const WORKFLOW_FILE = 'postpilot-worker.yml';
const KEEPALIVE_EVERY_DAYS = 20;
const COMPACT_EVERY_DAYS = 30;
const COMPACT_HOURS = [2, 3, 4, 5]; // local night hours, when the app is least likely to be writing

async function keepAlive(ctx, state) {
  if (ctx.env.GITHUB_ACTIONS !== 'true') return false;
  // keepaliveAt: the last success; keepaliveTriedAt: the last attempt GitHub refused (see the top).
  const last = Math.max(Date.parse(state.keepaliveAt || 0) || 0, Date.parse(state.keepaliveTriedAt || 0) || 0);
  if (ctx.nowMs() - last < KEEPALIVE_EVERY_DAYS * DAY_MS) return false;
  const path = `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/actions/workflows/${WORKFLOW_FILE}/enable`;
  try {
    await ctx.gh.request('PUT', path);
  } catch (err) {
    if (err && (err.status === 403 || err.status === 404) && !err.isRateLimit) state.keepaliveTriedAt = ctx.nowIso();
    throw err;
  }
  state.keepaliveAt = ctx.nowIso();
  ctx.log('maintenance', 'info', 'Kept the scheduled worker enabled (GitHub turns schedules off after 60 quiet days).');
  return true;
}

/**
 * Replace the data branch with one commit holding the current tree. Returns true when done.
 * With `store` (the worker's store on the same branch), a lock marker keeps app commits out while
 * the branch is replaced.
 */
export async function compactBranch({ gh, branch, store = null, nowMs = Date.now() }) {
  const first = await gh.getRef(branch);
  if (!first) return false;
  const firstCommit = await gh.getCommit(first);
  if (!firstCommit.parents || !firstCommit.parents.length) return false; // already a single commit
  const lockPath = `${COMPACT_LOCK_PREFIX}${nowMs}`;
  if (store) await store.transact((tx) => tx.writePublic(lockPath, { startedAt: new Date(nowMs).toISOString() }), { message: 'maintenance: compacting history' });
  let done = false;
  try {
    // Every app commit from here on is built on the lock commit, and the app refuses to make one.
    const head = await gh.getRef(branch);
    const commit = await gh.getCommit(head);
    // Leave the marker (and any left by a run that crashed) out of the compacted tree.
    const locks = store ? (await gh.getTree(commit.tree.sha)).map((e) => e.path).filter((p) => p.startsWith(COMPACT_LOCK_PREFIX)) : [];
    const tree = locks.length ? await gh.createTree(locks.map((path) => ({ path, sha: null })), commit.tree.sha) : commit.tree.sha;
    const root = await gh.createCommit({ message: 'Compact history (Postpilot keeps only the latest data)', tree, parents: [] });
    if ((await gh.getRef(branch)) !== head) return false;
    await gh.updateRef(branch, root, true);
    done = true;
    return true;
  } finally {
    if (store && !done) {
      try {
        await store.transact((tx) => tx.delete(lockPath), { message: 'maintenance: compaction skipped' });
      } catch {
        // a stale marker is ignored after 5 minutes
      }
    }
  }
}

export default async function maintenance(ctx) {
  const settings = await ctx.store.read('settings');
  const state = { ...((settings.worker && settings.worker.maintenance) || {}) };
  const out = { keepalive: 0, compacted: 0 };

  try {
    if (await keepAlive(ctx, state)) out.keepalive = 1;
  } catch (err) {
    // Not fatal: a refusal waits the normal interval (keepaliveTriedAt), an API hiccup is tried again next run.
    ctx.log('maintenance', 'warn', `Could not refresh the schedule keep-alive (${err.status || err.message}).`);
    state.keepaliveAt = state.keepaliveAt || null;
  }

  const lastCompact = Date.parse(state.compactedAt || settings.createdAt || 0) || 0;
  const hour = zonedParts(new Date(ctx.nowMs()), ctx.tz || 'UTC').hour;
  const due = ctx.nowMs() - lastCompact >= COMPACT_EVERY_DAYS * DAY_MS && COMPACT_HOURS.includes(hour);
  if (due && ctx.env.POSTPILOT_NO_COMPACT !== '1') {
    if (await compactBranch({ gh: ctx.gh, branch: ctx.store.branch, store: ctx.store })) {
      out.compacted = 1;
      await ctx.store.refresh();
      ctx.log('maintenance', 'info', 'Compacted the data history to save storage. Your current data is unchanged.');
    }
    state.compactedAt = ctx.nowIso();
  }

  const changed = JSON.stringify(state) !== JSON.stringify((settings.worker && settings.worker.maintenance) || {});
  if (changed) {
    await ctx.store.update('settings', (s) => {
      s.worker = { ...(s.worker || {}), maintenance: { ...((s.worker && s.worker.maintenance) || {}), ...state } };
    }, { message: 'maintenance' });
  }
  return out;
}
