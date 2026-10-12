// Housekeeping:
// - delete plaintext media copies under public/tmp older than 24 hours (file names start with the
//   creation time in epoch seconds: public/tmp/<epochSeconds>-<token>.<ext>; files without that
//   prefix are removed too, since nothing else may live there),
// - prune automations.processed entries (comments/messages after 30 days, conversations and
//   once-per-user records after a year) once a day,
// - drop finished outbox commands older than 7 days,
// - move published and canceled posts older than 90 days from `posts` (rewritten on every publish
//   and downloaded by every open tab) to `posts-archive`, about once a day. Their insights stay in
//   analytics-media. Kept in `posts`: reposts and the posts they recycle (autopilot's recycling
//   reads them) and rejected autopilot drafts (their media stays out of autopilot). Library usedBy
//   is adjusted so unusedAssets() treats the media exactly as before.
// Log entries (500) and run records (200) are trimmed by the run-log transaction in run.mjs.

import { TMP_PREFIX } from '../context.mjs';
import { DAY_MS, oldestProcessed, pruneProcessed } from './shared.mjs';

const TMP_MAX_AGE_SEC = 24 * 3600;
const PROCESSED_DAYS = 30;
const OUTBOX_KEEP_DAYS = 7;
const ARCHIVE_DAYS = 90;

/** Published or canceled posts whose latest date is before `cutoffMs` and that may be archived. Exported for tests. */
export function archivablePosts(posts, cutoffMs) {
  return (posts || []).filter((p) => {
    if (!p || !p.id || (p.status !== 'published' && p.status !== 'canceled')) return false;
    if (p.source === 'recycle' || p.recycleOf) return false;
    if (p.status === 'canceled' && (p.history || []).some((h) => h && h.event === 'rejected')) return false;
    const times = [p.publishedAt, p.scheduledAt, p.updatedAt, p.createdAt].map((t) => Date.parse(t || '')).filter(Number.isFinite);
    return times.length > 0 && Math.max(...times) < cutoffMs;
  });
}

/** Which public/tmp paths are stale at `nowMs`? Exported for tests. */
export function staleTmpFiles(paths, nowMs, exclude = new Set()) {
  const cutoff = Math.floor(nowMs / 1000) - TMP_MAX_AGE_SEC;
  return paths.filter((p) => {
    if (!p.startsWith(TMP_PREFIX) || exclude.has(p)) return false;
    const m = /^(\d{9,12})-/.exec(p.slice(TMP_PREFIX.length));
    return !m || Number(m[1]) < cutoff;
  });
}

export default async function housekeeping(ctx) {
  // Sweep plaintext media copies left on the throwaway public branch by runs that stopped mid-publish
  // (also covers runs where publishing is paused or Instagram is disconnected).
  let swept = 0;
  try {
    const live = await ctx.store.read('posts');
    const keep = live.posts.filter((p) => p.status === 'publishing').flatMap((p) => p.exposedPaths || []);
    swept = (await ctx.pruneExposed(keep)) || 0;
    if (swept) ctx.log('housekeeping', 'info', `Removed ${swept} leftover public media cop${swept === 1 ? 'y' : 'ies'}.`);
  } catch (err) {
    ctx.log('housekeeping', 'warn', `Could not sweep temporary public media: ${err.message || err}`);
  }
  const nowMs = ctx.nowMs();
  await ctx.store.refresh();
  const tmp = await ctx.store.list(TMP_PREFIX);
  const stale = staleTmpFiles(tmp, nowMs, ctx.exposed);

  const autom = await ctx.store.read('automations');
  // One day of slack so pruning (and its commit) happens about once a day, not every run.
  const pruneComments = oldestProcessed(autom.processed, 'comments') < nowMs - (PROCESSED_DAYS + 1) * DAY_MS;
  const pruneMessages = oldestProcessed(autom.processed, 'messages') < nowMs - (PROCESSED_DAYS + 1) * DAY_MS;
  const needPrune = pruneComments || pruneMessages;

  const inbox = await ctx.store.read('inbox');
  const outboxCutoff = nowMs - OUTBOX_KEEP_DAYS * DAY_MS;
  const needOutbox = (inbox.outbox || []).some((c) => c && c.status !== 'pending' && c.status !== 'sending' && Date.parse(c.doneAt || c.createdAt || 0) < outboxCutoff - DAY_MS);

  // One day of slack, like pruning: the archive commit happens about once a day.
  const postsDoc = await ctx.store.read('posts');
  const needArchive = archivablePosts(postsDoc.posts, nowMs - (ARCHIVE_DAYS + 1) * DAY_MS).length > 0;

  if (!stale.length && !needPrune && !needOutbox && !needArchive) return { tmpDeleted: swept, pruned: 0 };

  let deleted = 0;
  let pruned = 0;
  let archived = 0;
  await ctx.store.transact(
    async (tx) => {
      deleted = 0;
      pruned = 0;
      archived = 0;
      for (const p of stale) {
        if (tx.exists(p)) {
          tx.delete(p);
          deleted++;
        }
      }
      if (needPrune) {
        const a = await tx.read('automations');
        pruned = pruneProcessed(a.processed, ctx.nowMs(), { comments: PROCESSED_DAYS, messages: PROCESSED_DAYS, conversations: 365, users: 365 });
        if (pruned) tx.write('automations', a);
      }
      if (needOutbox) {
        const ib = await tx.read('inbox');
        const before = (ib.outbox || []).length;
        ib.outbox = (ib.outbox || []).filter((c) => c && (c.status === 'pending' || c.status === 'sending' || Date.parse(c.doneAt || c.createdAt || 0) >= outboxCutoff));
        pruned += before - ib.outbox.length;
        tx.write('inbox', ib);
      }
      if (needArchive) {
        const doc = await tx.read('posts');
        const moving = archivablePosts(doc.posts, ctx.nowMs() - ARCHIVE_DAYS * DAY_MS);
        if (moving.length) {
          const ids = new Set(moving.map((p) => p.id));
          const arch = await tx.read('posts-archive');
          arch.posts = [...(arch.posts || []).filter((p) => !ids.has(p.id)), ...moving];
          doc.posts = doc.posts.filter((p) => !ids.has(p.id));
          // unusedAssets() counts an unknown post id in usedBy as "used": drop archived canceled
          // posts (which never used their media) and make sure published ones are listed.
          const lib = await tx.read('library');
          const canceledIds = new Set(moving.filter((p) => p.status === 'canceled').map((p) => p.id));
          const byAsset = new Map();
          for (const p of moving) {
            if (p.status !== 'published') continue;
            for (const id of [...(p.media || []).map((m) => m.assetId), p.coverAssetId].filter(Boolean)) {
              if (!byAsset.has(id)) byAsset.set(id, []);
              byAsset.get(id).push(p.id);
            }
          }
          let libChanged = false;
          for (const a of lib.assets || []) {
            const before = a.usedBy || [];
            const after = [...new Set([...before.filter((id) => !canceledIds.has(id)), ...(byAsset.get(a.id) || [])])];
            if (JSON.stringify(after) !== JSON.stringify(before)) {
              a.usedBy = after;
              libChanged = true;
            }
          }
          if (libChanged) tx.write('library', lib);
          tx.write('posts-archive', arch);
          tx.write('posts', doc);
          archived = moving.length;
        }
      }
    },
    { message: 'housekeeping' },
  );
  if (deleted) ctx.log('housekeeping', 'info', `Removed ${deleted} leftover temporary media file${deleted === 1 ? '' : 's'}.`);
  if (archived) ctx.log('housekeeping', 'info', `Archived ${archived} post${archived === 1 ? '' : 's'} older than ${ARCHIVE_DAYS} days.`);
  return { tmpDeleted: deleted + swept, pruned, archived };
}
