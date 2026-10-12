// Housekeeping:
// - delete plaintext media copies under public/tmp older than 24 hours (file names start with the
//   creation time in epoch seconds: public/tmp/<epochSeconds>-<token>.<ext>; files without that
//   prefix are removed too, since nothing else may live there),
// - prune automations.processed entries (comments/messages after 30 days, conversations and
//   once-per-user records after a year) once a day,
// - drop finished outbox commands older than 7 days.
// Log entries (500) and run records (200) are trimmed by the run-log transaction in run.mjs.

import { TMP_PREFIX } from '../context.mjs';
import { DAY_MS, oldestProcessed, pruneProcessed } from './shared.mjs';

const TMP_MAX_AGE_SEC = 24 * 3600;
const PROCESSED_DAYS = 30;
const OUTBOX_KEEP_DAYS = 7;

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

  if (!stale.length && !needPrune && !needOutbox) return { tmpDeleted: 0, pruned: 0 };

  let deleted = 0;
  let pruned = 0;
  await ctx.store.transact(
    async (tx) => {
      deleted = 0;
      pruned = 0;
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
    },
    { message: 'housekeeping' },
  );
  if (deleted) ctx.log('housekeeping', 'info', `Removed ${deleted} leftover temporary media file${deleted === 1 ? '' : 's'}.`);
  return { tmpDeleted: deleted, pruned };
}
