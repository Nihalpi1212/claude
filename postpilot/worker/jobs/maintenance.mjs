// Maintenance:
// - keep-alive: GitHub disables scheduled workflows in public repositories after 60 days without
//   repository activity. Every ~20 days the worker calls the "enable workflow" API on itself.
// - compaction: every encrypted write adds a new copy of a document to the data branch's history,
//   and encrypted data does not compress. About once a month, at night in the owner's time zone,
//   the branch is replaced by a single commit holding the same files so old copies can be
//   garbage-collected by GitHub. The current files are untouched.

import { zonedParts } from '../../core/time.js';
import { DAY_MS } from './shared.mjs';

export const WORKFLOW_FILE = 'postpilot-worker.yml';
const KEEPALIVE_EVERY_DAYS = 20;
const COMPACT_EVERY_DAYS = 30;
const COMPACT_HOURS = [2, 3, 4, 5]; // local night hours, when the app is least likely to be writing

async function keepAlive(ctx, state) {
  const last = Date.parse(state.keepaliveAt || 0) || 0;
  if (ctx.nowMs() - last < KEEPALIVE_EVERY_DAYS * DAY_MS) return false;
  const path = `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/actions/workflows/${WORKFLOW_FILE}/enable`;
  await ctx.gh.request('PUT', path);
  state.keepaliveAt = ctx.nowIso();
  ctx.log('maintenance', 'info', 'Kept the scheduled worker enabled (GitHub turns schedules off after 60 quiet days).');
  return true;
}

/** Replace the data branch with one commit holding the current tree. Returns true when done. */
export async function compactBranch({ gh, branch }) {
  const head = await gh.getRef(branch);
  if (!head) return false;
  const commit = await gh.getCommit(head);
  if (!commit.parents || !commit.parents.length) return false; // already a single commit
  const root = await gh.createCommit({ message: 'Compact history (Postpilot keeps only the latest data)', tree: commit.tree.sha, parents: [] });
  // Shrink the race window with the app: only force-move the branch if nobody wrote meanwhile.
  if ((await gh.getRef(branch)) !== head) return false;
  await gh.updateRef(branch, root, true);
  return true;
}

export default async function maintenance(ctx) {
  const settings = await ctx.store.read('settings');
  const state = { ...((settings.worker && settings.worker.maintenance) || {}) };
  const out = { keepalive: 0, compacted: 0 };

  try {
    if (await keepAlive(ctx, state)) out.keepalive = 1;
  } catch (err) {
    // Missing `actions: write` permission or an API hiccup: not fatal, try again next run.
    ctx.log('maintenance', 'warn', `Could not refresh the schedule keep-alive (${err.status || err.message}).`);
    state.keepaliveAt = state.keepaliveAt || null;
  }

  const lastCompact = Date.parse(state.compactedAt || settings.createdAt || 0) || 0;
  const hour = zonedParts(new Date(ctx.nowMs()), ctx.tz || 'UTC').hour;
  const due = ctx.nowMs() - lastCompact >= COMPACT_EVERY_DAYS * DAY_MS && COMPACT_HOURS.includes(hour);
  if (due && ctx.env.POSTPILOT_NO_COMPACT !== '1') {
    if (await compactBranch({ gh: ctx.gh, branch: ctx.store.branch })) {
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
