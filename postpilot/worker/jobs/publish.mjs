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
// - Reminder posts (publishMode 'reminder', for what the API cannot post: library music on accounts
//   without the Audio API, link stickers, polls, product tags, filters) make no Instagram calls: when
//   due they become 'reminded' and the owner gets a phone notification that opens #/post-now/<id>.
//   They do not use the publishing quota and still go out while Instagram is disconnected (run.mjs
//   runs this job without a connection; only the Instagram part is skipped then).
//   The reminder push is sent right away (ctx.notify only queues, and run.mjs sends the queue after
//   every job, which can be many minutes later); without a device that gets notifications the
//   reminder only shows on the Today screen, and the activity log says so.
// - Media that the worker still has to download from a link (asset.importUrl, CSV and RSS imports):
//   the post waits (noted once in its history); it fails when the download failed (importError) or
//   is still pending 6 hours after the post was due (or after it was last changed, e.g. scheduled
//   again). It never fails while the feeds job, which runs after this one, is about to try the
//   download in this same run (after a paused worker, or right after "Try again" in the Library).

import { duePosts } from '../../core/schedule.js';
import { classifyError, publishPost } from '../../core/publish.js';
import { PublishPendingError } from '../../core/ig.js';
import { describeError, isIgAuth } from '../context.mjs';
import { NOTIFY_DEFAULTS, sendNotifications } from '../notify.mjs';
import { pendingDownloads } from './feeds.mjs';
import { pushHistory } from './shared.mjs';
import { markExpired } from './token.mjs';

export const MAX_ATTEMPTS = 4;
const MAX_POSTS_PER_RUN = 10;
const PENDING_GIVE_UP_MS = 3 * 36e5; // stop waiting for Instagram to process a video after 3 hours
const RUN_BUDGET_MS = 14 * 60e3; // keep well inside the 20 minute workflow timeout
const WAIT_SLICE_MS = 30_000; // while waiting for an upcoming post, look for new due posts this often
const IMPORT_GIVE_UP_MS = 6 * 36e5; // a file still downloading 6 hours after the post was due fails the post

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
      } else if (post.status === 'scheduled' && !post.needsApproval && post.publishMode !== 'reminder' && Date.parse(post.scheduledAt) <= ctx.nowMs() + 1000) {
        post.status = 'publishing';
        post.publishStartedAt = nowIso;
        post.attempts = (post.attempts || 0) + 1;
        pushHistory(post, nowIso, 'publishing', post.attempts > 1 ? `Attempt ${post.attempts}.` : undefined);
      } else {
        return; // changed in the app meanwhile (canceled, rescheduled, published, switched to a reminder)
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

/**
 * Library files of a post that the worker still has to download from a link (asset.importUrl).
 * Returns {pending: Asset[], failed: Asset[]} (failed = the download failed: importError).
 */
export function importState(post, assetsById) {
  const ids = [...new Set([...(post.media || []).map((m) => m && m.assetId), post.coverAssetId].filter(Boolean))];
  const pending = [];
  const failed = [];
  for (const id of ids) {
    const a = assetsById.get(id);
    if (!a || !a.importUrl) continue;
    (a.importError ? failed : pending).push(a);
  }
  return { pending, failed };
}

const fileName = (a) => `"${a.name || 'a file'}"`;

/** True when a reminder can reach a phone: push keys, at least one device, and the event turned on. */
function canPushReminders(settings) {
  const cfg = (settings && settings.notifications) || {};
  const events = { ...NOTIFY_DEFAULTS, ...(cfg.events || {}) };
  const subs = (cfg.subscriptions || []).filter((s) => s && s.endpoint && s.keys && s.keys.p256dh && s.keys.auth);
  return !!(cfg.vapid && cfg.vapid.privateKeyJwk && cfg.vapid.publicKey && subs.length && events.reminder);
}

/**
 * Send reminder pushes now instead of at the end of the run: run.mjs only sends ctx.notify's queue
 * after every job (and after this job's wait for later posts), and for a reminder the push is the
 * post going out. sendNotifications never throws; problems go to the encrypted log.
 */
async function pushReminders(ctx, sent) {
  const items = sent.map((p) => ({ event: 'reminder', postId: p.id, type: p.type, caption: p.caption }));
  const res = await sendNotifications({ ...ctx, notifications: items }, { fetchImpl: ctx.fetch });
  if (res.sent || res.failed) ctx.say(`notifications: ${res.sent} sent, ${res.failed} failed`);
  return res;
}

/**
 * Mark due reminder posts 'reminded' and send one phone notification for them. No Instagram calls,
 * so reminders never use the publishing quota. Returns how many posts were reminded.
 */
async function sendReminders(ctx, ids) {
  let sent = [];
  const push = canPushReminders(ctx.settings);
  await ctx.store.transact(
    async (tx) => {
      sent = [];
      const doc = await tx.read('posts');
      const nowIso = ctx.nowIso();
      for (const id of ids) {
        const p = doc.posts.find((x) => x.id === id);
        // Re-check: the owner may have changed or rescheduled it in the app meanwhile.
        if (!p || p.status !== 'scheduled' || p.needsApproval || p.publishMode !== 'reminder' || !(Date.parse(p.scheduledAt) <= ctx.nowMs() + 1000)) continue;
        p.status = 'reminded';
        p.reminderSentAt = nowIso;
        p.lastError = null;
        pushHistory(p, nowIso, 'reminder sent', push ? undefined : 'No device gets notifications, so it shows on the Today screen only.');
        sent.push({ id: p.id, type: p.type, caption: p.caption || '' });
      }
      if (sent.length) tx.write('posts', doc);
    },
    { message: 'publish: reminders' },
  );
  if (!sent.length) return 0;
  const res = push ? await pushReminders(ctx, sent) : null;
  for (const p of sent) {
    const what = `${TYPE_NAMES[p.type] || 'post'}${p.caption ? ` ("${p.caption.slice(0, 60)}")` : ''}`;
    if (!push) ctx.log('publish', 'info', `A ${what} is due to be posted by hand. No device gets notifications, so the reminder shows on the Today screen only.`, { postId: p.id });
    else if (res && res.sent) ctx.log('publish', 'info', `Sent a reminder to post a ${what} by hand.`, { postId: p.id });
    else ctx.log('publish', 'warn', `A ${what} is due to be posted by hand, but the phone notification could not be sent. It shows on the Today screen.`, { postId: p.id });
  }
  return sent.length;
}

/** Fail a due post whose media could not be downloaded from its link. Returns true when it failed now. */
async function failDownload(ctx, postId, message, code) {
  let failed = false;
  await ctx.store.transact(
    async (tx) => {
      failed = false;
      const doc = await tx.read('posts');
      const p = doc.posts.find((x) => x.id === postId);
      if (!p || p.status !== 'scheduled') return;
      const nowIso = ctx.nowIso();
      p.status = 'failed';
      p.lastError = { message, code, at: nowIso, permanent: true };
      pushHistory(p, nowIso, 'failed', message);
      tx.write('posts', doc);
      failed = true;
    },
    { message: 'publish: media download failed' },
  );
  if (failed) {
    ctx.log('publish', 'error', `A post failed: ${message}`, { postId, code });
    ctx.notify('failed', { message, postId });
  }
  return failed;
}

/** Note on the post (once, until something else happens to it) that it waits for a download. */
async function noteWaiting(ctx, postId, assets) {
  const one = assets.length === 1;
  const what = `${assets.map(fileName).join(', ')} from ${one ? 'its link' : 'their links'}`;
  let noted = false;
  await ctx.store.transact(
    async (tx) => {
      noted = false;
      const doc = await tx.read('posts');
      const p = doc.posts.find((x) => x.id === postId);
      const last = p && (p.history || [])[p.history.length - 1];
      if (!p || p.status !== 'scheduled' || (last && last.event === 'waiting_download')) return;
      pushHistory(p, ctx.nowIso(), 'waiting_download', `Waiting for the worker to download ${what}.`);
      tx.write('posts', doc);
      noted = true;
    },
    { message: 'publish: waiting for a download' },
  );
  if (noted) ctx.log('publish', 'info', `A due post waits until the worker has downloaded ${what}.`, { postId });
}

/**
 * When the post's 6-hour download clock started: when it was due, or when it was last changed (the
 * newest history entry other than this job's own waiting note), whichever is later. Scheduling it
 * again after a failed download restarts the clock even though its old time is kept.
 */
function waitingSince(post) {
  let since = Date.parse(post.scheduledAt || '') || 0;
  for (const h of post.history || []) {
    if (h.event === 'waiting_download') continue;
    const t = Date.parse(h.at || '');
    if (Number.isFinite(t) && t > since) since = t;
  }
  return since;
}

/**
 * Due posts whose media is not ready: still downloading (wait) or failed to download (fail the post).
 * Returns the posts that can go ahead; `skip` collects the ids handled here.
 */
async function checkDownloads(ctx, due, skip, result) {
  const needs = due.filter((p) => (p.media || []).some((m) => m && m.assetId) || p.coverAssetId);
  if (!needs.length) return due;
  const library = await ctx.store.read('library');
  const assetsById = new Map((library.assets || []).map((a) => [a.id, a]));
  // Files the feeds job (after this one) tries to download in this run: not backing off after a failed try.
  const tryingNow = new Set(pendingDownloads(library, [], ctx.nowMs()).map((a) => a.id));
  const ready = [];
  for (const p of due) {
    const { pending, failed } = importState(p, assetsById);
    if (!pending.length && !failed.length) {
      ready.push(p);
      continue;
    }
    skip.add(p.id);
    if (failed.length) {
      const a = failed[0];
      const message = `Postpilot could not download ${fileName(a)} from its link (${String(a.importError).slice(0, 200)}). In the Library, choose Try again or replace the file in this post, then schedule it again.`;
      if (await failDownload(ctx, p.id, message, 'import_failed')) result.failed++;
    } else if (ctx.nowMs() - waitingSince(p) > IMPORT_GIVE_UP_MS && !pending.some((a) => tryingNow.has(a.id))) {
      const message = `${fileName(pending[0])} was still downloading from its link 6 hours after this post was due. Check the link in the Library or replace the file, then schedule the post again.`;
      if (await failDownload(ctx, p.id, message, 'import_timeout')) result.failed++;
    } else {
      await noteWaiting(ctx, p.id, pending);
    }
  }
  return ready;
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
  let reminded = 0;
  const handled = new Set(); // posts this run tried to publish on Instagram
  const skip = new Set(); // due posts handled without Instagram: reminders, waiting or failed downloads
  // Without an Instagram connection (run.mjs still runs this job) only reminders go out; posts that
  // publish automatically stay scheduled until Instagram is connected again.
  const igOn = !!ctx.ig;
  let saidWaiting = false;
  let outOfTime = false;
  const waitSliceMs = Number(ctx.env.POSTPILOT_WAIT_SLICE_MS) || WAIT_SLICE_MS;
  // `reminded` is only added when non-zero so the usual console line stays the same.
  const done = () => (reminded ? { ...result, reminded } : result);
  const inScope = (p) => igOn || p.publishMode === 'reminder';
  try {
    for (let loop = 0; loop < 100; loop++) {
      if (loop > 0) await ctx.store.refresh(); // pick up edits made in the app while we waited
      const postsDoc = await ctx.store.read('posts');
      const nowMs = ctx.nowMs();
      const dueNow = duePosts(postsDoc.posts, nowMs, 0).filter((p) => !handled.has(p.id) && !skip.has(p.id) && inScope(p));
      const ready = await checkDownloads(ctx, dueNow, skip, result);
      const reminders = ready.filter((p) => p.publishMode === 'reminder');
      if (reminders.length) {
        for (const p of reminders) skip.add(p.id);
        reminded += await sendReminders(ctx, reminders.map((p) => p.id));
      }
      const resumable = igOn ? postsDoc.posts.filter((p) => p.status === 'publishing' && !handled.has(p.id)) : [];
      const due = ready.filter((p) => p.publishMode !== 'reminder');
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
            return done();
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
      const upcoming = duePosts(postsDoc.posts, nowMs, remaining).filter((p) => !handled.has(p.id) && !skip.has(p.id) && inScope(p));
      if (!upcoming.length) break;
      const waitMs = Math.max(0, Date.parse(upcoming[0].scheduledAt) - nowMs) + 500;
      if (!saidWaiting) {
        ctx.say('publish: waiting for a scheduled post');
        saidWaiting = true;
      }
      await ctx.sleep(Math.min(waitMs, waitSliceMs));
    }
    if (!igOn && !reminded && !result.failed) {
      return { skipped: ctx.settings.ig?.status?.state === 'expired' ? 'token_expired' : 'not_connected' };
    }
    if (!igOn) return { ...(reminded ? { reminded } : {}), ...(result.failed ? { failed: result.failed } : {}) };
    return done();
  } finally {
    if (igOn) await sweepExposed(ctx);
  }
}
