// Outbox: commands the app queued for the worker (inbox.outbox, status 'pending').
//   publish_now {postId}                -> post becomes scheduled for now (the publish job picks it up)
//   reply_comment {commentId, text}     -> public reply
//   hide_comment {commentId, hide}      -> hide / unhide
//   delete_comment {commentId}
//   send_dm {recipientId, text}
//   private_reply {commentId, text}     -> DM to the commenter
// Each command ends 'done' (with `result`) or 'failed' (with a plain-language `error`). Temporary
// problems keep the command pending for up to 3 attempts.
// Instagram commands are sent at most once: they are claimed ('sending', attempts + 1) in one commit
// before any is sent, the same way publish.mjs claims a post. A command still 'sending' at the start
// of a run belongs to a run that stopped before recording the outcome; it becomes 'failed' (it may
// already have gone out) and is never sent again automatically.

import { describeError } from '../context.mjs';
import { clip, DAY_MS, findCachedComment, isRetryable, pushHistory } from './shared.mjs';

const MAX_PER_RUN = 25;
const MAX_ATTEMPTS = 3;
const KEEP_FINISHED_DAYS = 7;
const IG_TYPES = new Set(['reply_comment', 'hide_comment', 'delete_comment', 'send_dm', 'private_reply']);
const MAYBE_SENT_ERROR = 'It may already have been sent. Check Instagram before retrying.';

async function execute(ctx, cmd) {
  const p = cmd.payload || {};
  const ig = ctx.ig;
  switch (cmd.type) {
    case 'reply_comment': {
      if (!p.commentId || !String(p.text || '').trim()) throw new Error('The reply is empty.');
      const r = await ig.replyToComment(p.commentId, String(p.text));
      return { id: r?.id ?? null };
    }
    case 'hide_comment':
      await ig.hideComment(p.commentId, p.hide !== false);
      return { hidden: p.hide !== false };
    case 'delete_comment':
      await ig.deleteComment(p.commentId);
      return { deleted: true };
    case 'send_dm': {
      if (!p.recipientId || !String(p.text || '').trim()) throw new Error('The message is empty.');
      const r = await ig.sendMessage(p.recipientId, String(p.text));
      return { messageId: r?.messageId ?? null };
    }
    case 'private_reply': {
      if (!p.commentId || !String(p.text || '').trim()) throw new Error('The message is empty.');
      const r = await ig.privateReply(p.commentId, String(p.text));
      return { messageId: r?.messageId ?? null };
    }
    default:
      throw Object.assign(new Error(`Unknown command "${cmd.type}".`), { permanent: true });
  }
}

/** Reflect a finished command in the cached comment list so the app's fallback view is current. */
function applyToCache(ib, cmd, result, ctx) {
  const p = cmd.payload || {};
  if (!p.commentId || !Array.isArray(ib.comments)) return;
  const found = findCachedComment(ib.comments, p.commentId);
  if (!found) return;
  if (cmd.type === 'hide_comment') found.comment.hidden = p.hide !== false;
  else if (cmd.type === 'delete_comment') {
    if (found.parent) found.parent.replies.splice(found.index, 1);
    else ib.comments.splice(found.index, 1);
  } else if (cmd.type === 'reply_comment' && result?.id) {
    const target = found.parent || found.comment;
    target.replies = [
      ...(target.replies || []),
      { id: result.id, text: String(p.text), timestamp: ctx.nowIso(), username: ctx.settings.ig?.username || '', fromId: ctx.ig?.userId ?? null, likeCount: 0, hidden: false, parentId: target.id, replies: [] },
    ];
  }
}

export default async function outbox(ctx) {
  const peek = await ctx.store.read('inbox');
  const all = peek.outbox || [];
  const pending = all.filter((c) => c && c.status === 'pending').slice(0, MAX_PER_RUN);
  const interrupted = all.some((c) => c && c.status === 'sending');
  const nowMs = ctx.nowMs();
  const stale = all.some((c) => c && c.status !== 'pending' && c.status !== 'sending' && nowMs - Date.parse(c.doneAt || c.createdAt || 0) > (KEEP_FINISHED_DAYS + 1) * DAY_MS);
  if (!pending.length && !stale && !interrupted) return { commands: 0 };

  // Claim the Instagram commands in one commit before sending any of them (see the top of the file).
  const toClaim = new Set(ctx.ig ? pending.filter((c) => IG_TYPES.has(c.type)).map((c) => c.id) : []);
  let claimed = [];
  let unconfirmed = 0;
  if (toClaim.size || interrupted) {
    await ctx.store.transact(
      async (tx) => {
        claimed = [];
        unconfirmed = 0;
        const ib = await tx.read('inbox');
        const nowIso = ctx.nowIso();
        for (const c of ib.outbox || []) {
          if (!c) continue;
          if (c.status === 'sending') {
            Object.assign(c, { status: 'failed', error: MAYBE_SENT_ERROR, doneAt: nowIso });
            unconfirmed++;
          } else if (c.status === 'pending' && toClaim.has(c.id)) {
            c.status = 'sending';
            c.attempts = (c.attempts || 0) + 1;
            claimed.push(structuredClone(c));
          }
        }
        if (claimed.length || unconfirmed) tx.write('inbox', ib);
      },
      { message: 'outbox: claim commands' },
    );
    if (unconfirmed) ctx.log('outbox', 'error', `${unconfirmed} queued action${unconfirmed === 1 ? '' : 's'} may already have been sent by an interrupted run; marked as failed instead of sending again.`);
  }
  const claimedIds = new Set(claimed.map((c) => c.id));

  const outcomes = new Map(); // id -> fields to merge
  const publishNow = [];
  const toRun = [...claimed];
  let done = 0;
  let failed = unconfirmed;
  for (const cmd of pending) {
    const nowIso = ctx.nowIso();
    if (cmd.type === 'publish_now') {
      publishNow.push(cmd);
      continue;
    }
    if (IG_TYPES.has(cmd.type) && !ctx.ig) {
      const expired = ctx.settings.ig?.status?.state === 'expired';
      const error = expired ? 'Your Instagram login expired. Reconnect Instagram in Settings and try again.' : 'Instagram is not connected. Connect it in Settings and try again.';
      outcomes.set(cmd.id, { status: 'failed', error, doneAt: nowIso });
      failed++;
      continue;
    }
    if (!IG_TYPES.has(cmd.type)) toRun.push(cmd); // unknown type: fails below
  }
  for (const cmd of toRun) {
    const nowIso = ctx.nowIso();
    const attempts = claimedIds.has(cmd.id) ? cmd.attempts : (cmd.attempts || 0) + 1;
    try {
      const result = await execute(ctx, cmd);
      outcomes.set(cmd.id, { status: 'done', result, error: null, doneAt: nowIso, attempts });
      done++;
      ctx.log('outbox', 'info', `Done: ${cmd.type.replace(/_/g, ' ')}.`);
    } catch (err) {
      const message = describeError(err);
      if (err && err.maybeSent) {
        // The connection dropped after the request may have reached Instagram: never resend it.
        outcomes.set(cmd.id, { status: 'failed', error: MAYBE_SENT_ERROR, doneAt: nowIso, attempts });
        failed++;
        ctx.log('outbox', 'error', `Could not confirm ${cmd.type.replace(/_/g, ' ')}: ${message}`, { code: err.code ?? null });
      } else if (isRetryable(err) && attempts < MAX_ATTEMPTS) {
        outcomes.set(cmd.id, { status: 'pending', error: message, attempts });
        ctx.log('outbox', 'warn', `Will retry ${cmd.type.replace(/_/g, ' ')}: ${message}`);
      } else {
        outcomes.set(cmd.id, { status: 'failed', error: message, doneAt: nowIso, attempts });
        failed++;
        ctx.log('outbox', 'error', `Could not ${cmd.type.replace(/_/g, ' ')}: ${message}`, { code: err?.code ?? null });
      }
    }
  }
  if (!outcomes.size && !publishNow.length && !stale) return { commands: 0, commandsFailed: failed };

  await ctx.store.transact(
    async (tx) => {
      const ib = await tx.read('inbox');
      const nowIso = ctx.nowIso();
      // publish_now is pure data: apply it inside the transaction so it is safe to re-run.
      if (publishNow.length) {
        const postsDoc = await tx.read('posts');
        let postsChanged = false;
        for (const cmd of publishNow) {
          const post = postsDoc.posts.find((p) => p.id === cmd.payload?.postId);
          if (!post) {
            outcomes.set(cmd.id, { status: 'failed', error: 'This post no longer exists.', doneAt: nowIso });
          } else if (post.status === 'published' || post.status === 'publishing') {
            outcomes.set(cmd.id, { status: 'done', result: { status: post.status }, error: null, doneAt: nowIso });
          } else if (post.status === 'canceled') {
            outcomes.set(cmd.id, { status: 'failed', error: 'This post was canceled.', doneAt: nowIso });
          } else {
            post.status = 'scheduled';
            post.scheduledAt = nowIso;
            post.needsApproval = false;
            if (post.lastError) post.attempts = 0;
            post.lastError = null;
            pushHistory(post, nowIso, 'publish_now', 'Publishing now.');
            postsChanged = true;
            outcomes.set(cmd.id, { status: 'done', result: { scheduledAt: nowIso }, error: null, doneAt: nowIso });
          }
        }
        if (postsChanged) tx.write('posts', postsDoc);
      }
      const list = ib.outbox || [];
      for (const c of list) {
        const o = outcomes.get(c.id);
        if (o && c.status === (claimedIds.has(c.id) ? 'sending' : 'pending')) {
          Object.assign(c, o);
          if (o.status === 'done' && IG_TYPES.has(c.type)) applyToCache(ib, c, o.result, ctx);
        }
      }
      const keepAfter = ctx.nowMs() - KEEP_FINISHED_DAYS * DAY_MS;
      ib.outbox = list.filter((c) => c && (c.status === 'pending' || c.status === 'sending' || Date.parse(c.doneAt || c.createdAt || 0) >= keepAfter));
      tx.write('inbox', ib);
    },
    { message: 'outbox: process commands' },
  );

  const publishDone = publishNow.filter((c) => outcomes.get(c.id)?.status === 'done').length;
  const publishFailed = publishNow.length - publishDone;
  if (publishDone) ctx.log('outbox', 'info', `Queued ${publishDone} post${publishDone === 1 ? '' : 's'} to publish now.`);
  if (publishFailed) ctx.log('outbox', 'warn', `${publishFailed} publish request${publishFailed === 1 ? '' : 's'} could not be applied: ${clip(outcomes.get(publishNow.find((c) => outcomes.get(c.id)?.status !== 'done').id).error)}`);
  return { commands: done + publishDone, commandsFailed: failed + publishFailed };
}
