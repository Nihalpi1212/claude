// Publish due posts.
//
// - Due = status 'scheduled', not waiting for approval, scheduledAt <= now (schedule.duePosts).
//   Posts left in 'publishing' by an earlier run are resumed (publishPost picks up post.containers).
// - When nothing is due now but a post is due within this run's window (POSTPILOT_MAX_WAIT_SEC),
//   the job sleeps until it is due, so posts go out on time even though cron runs every 10 minutes.
// - Each post: claim it ('publishing', attempts++), run publishPost (containers are persisted as soon
//   as they exist), then mark it 'published' or handle the error:
//     PublishPendingError -> stays 'publishing' with its containers; the next run resumes it
//     permanent error     -> 'failed' with lastError (the run exits 1 so GitHub emails the owner)
//     temporary error     -> back to 'scheduled' for the next run, 'failed' after 4 attempts
// - Plaintext copies (public/tmp on the throwaway branch, see context.mjs) are removed once Instagram
//   has the media (success or failure); while a container is still processing they are kept and
//   remembered on the post. At the end of the job the throwaway branch is rewritten to hold only
//   copies that a post still being processed needs.
// - Once media_publish succeeded, a failed GitHub write never reschedules or fails the post: it stays
//   'publishing' with its containers and the next run records it (no second publish).

import { duePosts } from '../../core/schedule.js';
import { classifyError, publishPost } from '../../core/publish.js';
import { PublishPendingError } from '../../core/ig.js';
import { describeError, isIgAuth } from '../context.mjs';
import { pushHistory } from './shared.mjs';
import { markExpired } from './token.mjs';

export const MAX_ATTEMPTS = 4;
const MAX_POSTS_PER_RUN = 10;
const PENDING_GIVE_UP_MS = 3 * 36e5; // stop waiting for Instagram to process a video after 3 hours
const RUN_BUDGET_MS = 14 * 60e3; // keep well inside the 20 minute workflow timeout
const WAIT_SLICE_MS = 30_000; // while waiting for an upcoming post, look for new due posts this often

const TYPE_NAMES = { feed: 'post', carousel: 'carousel', reel: 'reel', story: 'story' };

function classify(err) {
  if (err && err.name === 'WorkerError') {
    return { permanent: !!err.permanent, userMessage: err.userMessage || err.message, code: err.code ?? null, subcode: null };
  }
  if (err && (err.name === 'GitHubError' || err.name === 'ConflictError')) {
    return { permanent: false, userMessage: `Could not reach the Postpilot data on GitHub (${err.message}). Postpilot will try again.`, code: 'github', subcode: null };
  }
  try {
    const c = classifyError(err) || {};
    return {
      permanent: !!c.permanent,
      userMessage: c.userMessage || describeError(err),
      code: c.code ?? err?.code ?? null,
      subcode: c.subcode ?? err?.subcode ?? null,
    };
  } catch {
    return { permanent: false, userMessage: describeError(err), code: err?.code ?? null, subcode: null };
  }
}

/** Rate limits, the daily publishing quota and login problems do not count as a failed attempt. */
function countsAsAttempt(err) {
  return !(err && (err.isRateLimit || isIgAuth(err) || err.code === 'publish_limit' || err.subcode === 2207042));
}

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Crash recovery: a post left in 'publishing' without saved containers may still have been
 * published (if saving progress failed). Look for it among the newest media before uploading again.
 */
async function findPublishedWithoutContainers(ctx, post) {
  if (post.type === 'story' || !normText(post.caption)) return null;
  const since = Date.parse(post.publishStartedAt || '') - 10 * 60e3;
  if (!Number.isFinite(since)) return null;
  const prefix = normText(post.caption).slice(0, 60);
  const recent = await ctx.ig.listMedia({ limit: 10, max: 10 });
  const found = recent.find((m) => normText(m.caption).startsWith(prefix) && Date.parse(m.timestamp || 0) >= since);
  return found ? { igMediaId: found.id, permalink: found.permalink || null, containers: null, warnings: [] } : null;
}

async function claim(ctx, postId) {
  let claimed = null;
  await ctx.store.transact(
    async (tx) => {
      claimed = null;
      const doc = await tx.read('posts');
      const post = doc.posts.find((p) => p.id === postId);
      if (!post) return;
      const nowIso = ctx.nowIso();
      if (post.status === 'publishing') {
        // Resume: containers from an earlier run are still processing (no write needed), or an
        // earlier run stopped before saving any (note it and start over).
        claimed = structuredClone(post);
        if (post.containers) return;
        claimed.containersMissing = true;
        pushHistory(post, nowIso, 'resumed', 'Starting the upload again.');
        if (!post.publishStartedAt) post.publishStartedAt = claimed.publishStartedAt = nowIso;
        tx.write('posts', doc);
        return;
      } else if (post.status === 'scheduled' && !post.needsApproval && Date.parse(post.scheduledAt) <= ctx.nowMs() + 1000) {
        post.status = 'publishing';
        post.publishStartedAt = nowIso;
        post.attempts = (post.attempts || 0) + 1;
        pushHistory(post, nowIso, 'publishing', post.attempts > 1 ? `Attempt ${post.attempts}.` : undefined);
      } else {
        return; // changed in the app meanwhile (canceled, rescheduled, published)
      }
      claimed = structuredClone(post);
      claimed.countedAttempt = true;
      tx.write('posts', doc);
    },
    { message: 'publish: start' },
  );
  return claimed;
}

/** Take plaintext copies off the throwaway branch now that Instagram has the media. Failures are retried by sweepExposed. */
async function releaseExposed(ctx, paths) {
  if (!paths.length) return;
  try {
    await ctx.removeExposed(paths);
  } catch (err) {
    ctx.log('publish', 'warn', `Could not remove temporary media yet: ${describeError(err)}`);
  }
}

async function finishPublished(ctx, post, res, exposedNow) {
  let found = true;
  let already = false;
  let released = [];
  await ctx.store.transact(
    async (tx) => {
      already = false;
      const doc = await tx.read('posts');
      const nowIso = ctx.nowIso();
      const p = doc.posts.find((x) => x.id === post.id);
      found = !!p;
      released = [...new Set([...(p?.exposedPaths || []), ...(post.exposedPaths || []), ...exposedNow])];
      for (const path of released) if (tx.exists(path)) tx.delete(path); // copies older workers put on the data branch
      if (!p) return;
      if (p.status === 'published') {
        already = true; // an earlier try whose reply was lost went through
        return;
      }
      p.status = 'published';
      p.igMediaId = res.igMediaId || null;
      p.permalink = res.permalink || null;
      p.publishedAt = nowIso;
      p.lastError = null;
      if (res.firstCommentId) p.firstCommentId = res.firstCommentId;
      delete p.containers;
      delete p.exposedPaths;
      pushHistory(p, nowIso, 'published');
      for (const w of res.warnings || []) pushHistory(p, nowIso, 'warning', String(w));
      tx.write('posts', doc);

      // Library: remember which posts used each asset.
      const lib = await tx.read('library');
      const ids = new Set([...(p.media || []).map((m) => m.assetId), p.coverAssetId].filter(Boolean));
      let libChanged = false;
      for (const a of lib.assets || []) {
        if (!ids.has(a.id)) continue;
        a.usedBy = a.usedBy || [];
        if (!a.usedBy.includes(p.id)) {
          a.usedBy.push(p.id);
          libChanged = true;
        }
      }
      if (libChanged) tx.write('library', lib);

      // Evergreen lists: count the use (or drop the item when the list does not repeat).
      if (p.listId && p.listItemId) {
        const lists = await tx.read('lists');
        const list = (lists.lists || []).find((l) => l.id === p.listId);
        const idx = list ? (list.items || []).findIndex((it) => it.id === p.listItemId) : -1;
        if (idx >= 0) {
          if (list.repeat === false) list.items.splice(idx, 1);
          else {
            list.items[idx].timesUsed = (list.items[idx].timesUsed || 0) + 1;
            list.items[idx].lastUsedAt = nowIso;
          }
          tx.write('lists', lists);
        }
      }
    },
    { message: 'publish: published' },
  );
  await releaseExposed(ctx, released);
  if (already) return;
  const what = TYPE_NAMES[post.type] || 'post';
  if (found) ctx.notify('published', { type: post.type, caption: post.caption, postId: post.id });
  if (found) ctx.log('publish', 'info', `Published a ${what}${post.caption ? ` ("${post.caption.slice(0, 60)}")` : ''}.`, { postId: post.id, permalink: res.permalink || null });
  else ctx.log('publish', 'warn', `Published a ${what}, but the post was deleted in Postpilot while it was publishing.`, { igMediaId: res.igMediaId || null });
  for (const w of res.warnings || []) ctx.log('publish', 'warn', String(w), { postId: post.id });
}

async function keepPending(ctx, post, err, exposedNow) {
  let gaveUp = false;
  let released = [];
  await ctx.store.transact(
    async (tx) => {
      gaveUp = false;
      released = [];
      const doc = await tx.read('posts');
      const p = doc.posts.find((x) => x.id === post.id);
      if (!p) return;
      const nowIso = ctx.nowIso();
      const started = Date.parse(p.publishStartedAt || post.publishStartedAt || nowIso);
      if (ctx.nowMs() - started > PENDING_GIVE_UP_MS) {
        gaveUp = true;
        p.status = 'failed';
        p.lastError = { message: 'Instagram did not finish processing the media within 3 hours. Try a smaller file or re-export it as MP4 (H.264, AAC).', code: 'processing_timeout', at: nowIso, permanent: true };
        released = [...new Set([...(p.exposedPaths || []), ...exposedNow])];
        for (const path of released) if (tx.exists(path)) tx.delete(path);
        delete p.containers;
        delete p.exposedPaths;
        pushHistory(p, nowIso, 'failed', p.lastError.message);
      } else {
        p.status = 'publishing';
        if (err.containers) p.containers = err.containers;
        p.exposedPaths = [...new Set([...(p.exposedPaths || []), ...exposedNow])];
        const last = (p.history || [])[p.history.length - 1];
        if (!last || last.event !== 'processing') pushHistory(p, nowIso, 'processing', 'Instagram is still processing the media.');
      }
      tx.write('posts', doc);
    },
    { message: 'publish: still processing' },
  );
  await releaseExposed(ctx, released);
  if (gaveUp) {
    ctx.log('publish', 'error', 'Gave up on a post because Instagram did not finish processing it within 3 hours.', { postId: post.id });
    ctx.notify('failed', { message: 'Instagram did not finish processing the media within 3 hours.', postId: post.id });
  }
  else ctx.log('publish', 'info', 'Instagram is still processing a post; the next run will finish it.', { postId: post.id });
  return gaveUp ? 'failed' : 'pending';
}

async function finishError(ctx, post, err, exposedNow) {
  const c = classify(err);
  if (isIgAuth(err)) c.permanent = false; // publish once Instagram is reconnected
  let outcome = 'retried';
  let attempts = 0;
  let released = [];
  await ctx.store.transact(
    async (tx) => {
      const doc = await tx.read('posts');
      const p = doc.posts.find((x) => x.id === post.id);
      released = [...new Set([...(p?.exposedPaths || []), ...exposedNow])];
      for (const path of released) if (tx.exists(path)) tx.delete(path);
      if (!p) {
        outcome = 'gone';
        return;
      }
      const nowIso = ctx.nowIso();
      if (!countsAsAttempt(err) && post.countedAttempt) p.attempts = Math.max(0, (p.attempts || 1) - 1);
      attempts = p.attempts || 0;
      const retryAllowed = ctx.settings.publishing?.retryFailed !== false;
      let permanent = c.permanent || !retryAllowed || (countsAsAttempt(err) && attempts >= MAX_ATTEMPTS);
      let message = c.userMessage;
      if (!c.permanent && permanent && retryAllowed) message = `${message} Postpilot gave up after ${attempts} attempts.`;
      p.lastError = { message, code: c.code, ...(c.subcode ? { subcode: c.subcode } : {}), at: nowIso, permanent };
      delete p.exposedPaths;
      if (permanent) {
        outcome = 'failed';
        p.status = 'failed';
        delete p.containers;
        pushHistory(p, nowIso, 'failed', message);
      } else {
        outcome = 'retried';
        p.status = 'scheduled'; // keep containers so the next run can resume them
        pushHistory(p, nowIso, 'retry', message);
      }
      tx.write('posts', doc);
    },
    { message: 'publish: error' },
  );
  await releaseExposed(ctx, released);
  if (outcome === 'failed') {
    ctx.log('publish', 'error', `A post failed to publish: ${c.userMessage}`, { postId: post.id, code: c.code, subcode: c.subcode });
    ctx.notify('failed', { message: c.userMessage, postId: post.id });
  }
  else if (outcome === 'retried') ctx.log('publish', 'warn', `A post will be retried on the next run: ${c.userMessage}`, { postId: post.id, code: c.code, attempts });
  return outcome;
}

/** Publish one post by id. Returns 'published' | 'pending' | 'failed' | 'retried' | 'skipped' | 'gone'. */
export async function publishOne(ctx, postId) {
  const post = await claim(ctx, postId);
  if (!post) return 'skipped';

  const library = await ctx.store.read('library');
  const assets = new Map((library.assets || []).map((a) => [a.id, a]));
  const exposedNow = [];
  const exposeMedia = async (asset) => {
    const r = await ctx.exposeMedia(asset);
    exposedNow.push(r.path);
    return r;
  };
  const onContainers = async (containers) => {
    await ctx.store.transact(
      async (tx) => {
        const doc = await tx.read('posts');
        const p = doc.posts.find((x) => x.id === post.id);
        if (!p) return;
        p.containers = containers;
        p.exposedPaths = [...new Set([...(p.exposedPaths || []), ...exposedNow])];
        tx.write('posts', doc);
      },
      { message: 'publish: containers created' },
    );
  };
  const budgetLeft = ctx.startedAtMs + RUN_BUDGET_MS - ctx.nowMs();
  const env = ctx.env;
  const maxWaitMs = Math.max(1000, Math.min(Number(env.POSTPILOT_PUBLISH_WAIT_MS) || 240_000, budgetLeft));
  const pollIntervalMs = Number(env.POSTPILOT_POLL_MS) || 4000;

  let recorded = true;
  try {
    let res = null;
    try {
      if (post.containersMissing) res = await findPublishedWithoutContainers(ctx, post);
      if (!res) {
        res = await publishPost({
          ig: ctx.ig,
          post,
          assets,
          exposeMedia,
          readMedia: ctx.readMedia,
          onContainers,
          log: (message, data) => ctx.log('publish', 'info', String(message), data),
          sleep: ctx.sleep,
          pollIntervalMs,
          maxWaitMs,
        });
      }
    } catch (err) {
      if (err instanceof PublishPendingError || err?.name === 'PublishPendingError') return await keepPending(ctx, post, err, exposedNow);
      const outcome = await finishError(ctx, post, err, exposedNow);
      if (isIgAuth(err)) {
        // The login stopped working: record it for the app and skip Instagram for the rest of the run.
        await markExpired(ctx, ctx.settings.ig, err);
        throw err;
      }
      return outcome;
    }
    // The post is live on Instagram. A failed write here must never reach finishError, which would
    // reschedule or fail the post and drop its containers, so a later run would publish it again.
    // Retry once on a fresh head; if that fails too, the post stays 'publishing' with its containers
    // and the next run finds the container PUBLISHED and records it.
    recorded = false;
    try {
      await finishPublished(ctx, post, res, exposedNow);
    } catch {
      await ctx.store.refresh().catch(() => {});
      await finishPublished(ctx, post, res, exposedNow);
    }
    recorded = true;
    return 'published';
  } finally {
    // When the published post could not be recorded, its copies stay in ctx.exposed so the
    // end-of-run cleanup removes them (Instagram already has the media).
    if (recorded) for (const p of exposedNow) ctx.exposed.delete(p);
  }
}

/** Rewrite the throwaway branch to hold only copies that posts still being processed need. */
async function sweepExposed(ctx) {
  try {
    await ctx.store.refresh();
    const { posts } = await ctx.store.read('posts');
    const keep = posts.filter((p) => p.status === 'publishing').flatMap((p) => p.exposedPaths || []);
    const removed = await ctx.pruneExposed(keep);
    if (removed) ctx.log('publish', 'info', `Removed ${removed} leftover temporary media file${removed === 1 ? '' : 's'}.`);
  } catch (err) {
    ctx.log('publish', 'warn', `Could not remove temporary media: ${describeError(err)}`);
  }
}

export default async function publish(ctx) {
  const result = { published: 0, failed: 0, pending: 0, retried: 0 };
  const handled = new Set();
  let saidWaiting = false;
  let outOfTime = false;
  const waitSliceMs = Number(ctx.env.POSTPILOT_WAIT_SLICE_MS) || WAIT_SLICE_MS;
  try {
    for (let loop = 0; loop < 100; loop++) {
      if (loop > 0) await ctx.store.refresh(); // pick up edits made in the app while we waited
      const postsDoc = await ctx.store.read('posts');
      const nowMs = ctx.nowMs();
      const resumable = postsDoc.posts.filter((p) => p.status === 'publishing' && !handled.has(p.id));
      const due = duePosts(postsDoc.posts, nowMs, 0).filter((p) => !handled.has(p.id));
      const batch = [...resumable, ...due];
      if (batch.length) {
        for (const post of batch) {
          if (handled.size >= MAX_POSTS_PER_RUN) break;
          // Out of time: leave the rest to the next run (always handle at least one post per run).
          if (handled.size > 0 && ctx.nowMs() >= ctx.startedAtMs + RUN_BUDGET_MS) {
            outOfTime = true;
            ctx.log('publish', 'info', 'This run is out of time; the next run publishes the remaining posts.');
            break;
          }
          handled.add(post.id);
          let outcome;
          try {
            outcome = await publishOne(ctx, post.id);
          } catch (err) {
            if (!isIgAuth(err)) throw err;
            // The login stopped working (recorded by publishOne); keep this run's counts.
            result.retried++;
            return result;
          }
          if (outcome in result) result[outcome]++;
        }
        if (handled.size >= MAX_POSTS_PER_RUN || outOfTime) break;
        continue;
      }
      // Nothing due right now: wait for a post due within this run's window. Wake up regularly so a
      // post the owner publishes now (while this run waits) is not stuck behind the wait.
      const remaining = ctx.deadlineMs - nowMs;
      if (remaining <= 0) break;
      const upcoming = duePosts(postsDoc.posts, nowMs, remaining).filter((p) => !handled.has(p.id));
      if (!upcoming.length) break;
      const waitMs = Math.max(0, Date.parse(upcoming[0].scheduledAt) - nowMs) + 500;
      if (!saidWaiting) {
        ctx.say('publish: waiting for a scheduled post');
        saidWaiting = true;
      }
      await ctx.sleep(Math.min(waitMs, waitSliceMs));
    }
    return result;
  } finally {
    await sweepExposed(ctx);
  }
}
