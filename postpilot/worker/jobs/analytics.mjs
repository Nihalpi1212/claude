// Analytics snapshots. Instagram keeps account metrics for 30-90 days only, so Postpilot's own
// daily snapshots become the long-term history.
// - Once per local day (analytics-daily.lastDailyRun): account metrics for the last 3 complete days
//   (28 on the first run, and back to the last saved day after the worker was stopped, at most 28)
//   merged into analytics-daily.days, plus followers/follows/media count from the profile into
//   today's key. Reach and views split by format and by followers
//   (reachByType, viewsByType, reachFollowers...) are asked only for days that lack them and for the
//   oldest re-pulled day (3 days old, when Instagram's up-to-48-hour delay has passed), so a normal
//   day adds about 6 calls to the 7 the totals take (28 days x 2-3 calls on the very first run).
// - Media insights, one call per post, youngest first, at most 60 per run. Cadence by post age:
//     under 6 hours  hourly        (~6 calls: the history's hourly points)
//     6 h to 2 days  every 3 hours (~14 calls: the first-day curve and the 24-hour value, as often as
//                                   the history takes points)
//     2 to 7 days    every 6 hours (~20 calls: the 7-day value)
//     7 to 30 days   daily         (~23 calls)
//     older          weekly
//   About 65 calls per post in its first month; even at one post a day that is about 100 calls a
//   day, far below Instagram's per-account budget (4800 x daily impressions per 24 hours).
//   Stored in analytics-media.media[id]. The whole document is re-encrypted and committed on every
//   write, so a run that refreshes anything also refreshes the posts more than halfway to their next
//   refresh (fewer runs with a write).
// - The listing of the newest 100 posts reuses the automations job's listing of this run
//   (ctx.mediaListing, usually the newest 50) and lists again only when a stored post beyond it is
//   due, or when it reached no post analytics knows.
// - Media deleted from Instagram (with "Delete from Instagram", posts[].deletedFromInstagramAt, or in
//   Instagram itself) is flagged analytics-media.media[id].deletedAt; its numbers stay for totals and
//   reports, views leave it out. A stored post newer than the oldest listed one that the listing
//   lacks is looked up: "not found" means deleted; found means Instagram hides it from the listing
//   (archived): unlistedAt, looked up again a day later. Both flags go when the post is listed again.
// - Posts marked as posted by hand (status 'published' without igMediaId: reminder posts) are linked
//   to their Instagram media (igMediaId, and permalink when missing) by the shortcode of the pasted
//   link, or else by the closest listed media of the same type published within 2 hours after the
//   reminder or the planned time (or up to 2 hours before being marked as posted), not linked to
//   another post. The planner then shows them once, with their numbers.
// - Per-post history (updateHistory): a post younger than 30 days gets a point {t, v, r, l, c, s, sh, f}
//   in analytics-media-history.media[id].points from its latest refresh (skipped when nothing changed
//   and the last point is under 3 hours old; thinned to 48 points, first and last kept). The whole
//   document is re-encrypted and committed on every write, so it is written at most every 3 hours
//   (hourly while a post is in its first 6 hours, and at once for a post's first point); a refresh
//   between writes is picked up from analytics-media at the next one. That gives about 6 hourly
//   points, then one every 3 hours to day 2, every 6 hours to day 7 and daily to day 30. Past 30
//   days a curve no longer changes and is thinned to 20 points (the ones around 24 hours and 7 days
//   stay). History of media that left analytics-media or is older than 90 days is dropped.
// - Audience (online followers + demographics) weekly into the audience document. A run that gets
//   nothing usable keeps the old data and fetchedAt and tries again after AUDIENCE_RETRY_MS.
// All writes happen in one transaction at the end.

import {
  appendHistoryPoint,
  HISTORY_ADD_DAYS,
  HISTORY_FROZEN_POINTS,
  HISTORY_KEEP_DAYS,
  historyPoint,
  parseTimestamp,
  sameHistoryValues,
  thinPoints,
} from '../../core/analytics.js';
import { addDaysKey, dayRange } from '../../core/time.js';
import { describeError } from '../context.mjs';
import { DAY_MS, pushHistory } from './shared.mjs';

const FIRST_RUN_DAYS = 28;
const REPULL_DAYS = 3;
const MAX_MEDIA_PER_RUN = 60;
const LIST_MAX = 100; // newest posts whose insights are refreshed
const EARLY_MS = 6 * 36e5;
const EARLY_EVERY_MS = 60 * 60e3;
const YOUNG_MS = 2 * DAY_MS;
const YOUNG_EVERY_MS = 3 * 36e5;
const WEEK_MS = 7 * DAY_MS;
const FIRST_WEEK_EVERY_MS = 6 * 36e5;
const MONTH_MS = 30 * DAY_MS;
const DAILY_EVERY_MS = 20 * 36e5;
const WEEKLY_EVERY_MS = 7 * DAY_MS;
const AUDIENCE_EVERY_MS = 7 * DAY_MS;
const AUDIENCE_RETRY_MS = 6 * 36e5;
const RIDE_ALONG_SHARE = 0.5; // refreshed with a write anyway once this share of the wait has passed
const GONE_LOOKUPS_MAX = 5; // unlisted stored posts looked up per run
const UNLISTED_RECHECK_MS = DAY_MS;
const LINK_WINDOW_MS = 2 * 36e5; // a post by hand is matched to media published this long after its reminder
const LINK_EARLY_MS = 15 * 60e3; // ...or marked as posted at most this long before the media appeared
const HISTORY_EVERY_MS = 3 * 36e5; // analytics-media-history is written at most this often...
const HISTORY_EARLY_MS = 6 * 36e5; // ...except while a post is younger than this:
const HISTORY_EARLY_EVERY_MS = 60 * 60e3; // then hourly

function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : NaN;
}

function fatal(err) {
  return err && (err.isAuth || err.isRateLimit);
}

function previewUrl(m) {
  const child = (m.children || [])[0] || {};
  return m.thumbnailUrl || (m.mediaType === 'VIDEO' ? null : m.mediaUrl) || child.thumbnailUrl || child.mediaUrl || null;
}

/** How long a post's insights stay fresh, by its age. */
function refreshEvery(m, nowMs) {
  const age = nowMs - ms(m.timestamp);
  if (!(age >= 0)) return DAILY_EVERY_MS;
  if (age < EARLY_MS) return EARLY_EVERY_MS;
  if (age < YOUNG_MS) return YOUNG_EVERY_MS;
  if (age < WEEK_MS) return FIRST_WEEK_EVERY_MS;
  if (age < MONTH_MS) return DAILY_EVERY_MS;
  return WEEKLY_EVERY_MS;
}

/**
 * Is this media item due for an insights refresh? `share` < 1 asks whether that share of its wait
 * has passed (refreshing early along with a write that happens anyway). Exported for tests.
 */
export function mediaDue(m, prev, nowMs, share = 1) {
  const last = ms(prev?.fetchedAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= refreshEvery(m, nowMs) * share;
}

/**
 * Listed posts to refresh this run (at most MAX_MEDIA_PER_RUN): the due ones youngest first, then,
 * when the document is written anyway (something due, or `writing`), the ones more than halfway to
 * their next refresh. Exported for tests.
 */
export function mediaToRefresh(listed, known, nowMs, { writing = false } = {}) {
  const items = (listed || []).filter((m) => m && m.id);
  const youngest = (a, b) => (ms(b.timestamp) || 0) - (ms(a.timestamp) || 0);
  const due = items.filter((m) => mediaDue(m, known[m.id], nowMs)).sort(youngest);
  if (!due.length && !writing) return [];
  const early = items.filter((m) => !due.includes(m) && mediaDue(m, known[m.id], nowMs, RIDE_ALONG_SHARE)).sort(youngest);
  return [...due, ...early].slice(0, MAX_MEDIA_PER_RUN);
}

/**
 * The automations job's listing of this run (ctx.mediaListing: newest first, the same fields) when it
 * covers what analytics needs, else null (list again, newest LIST_MAX). It covers it when it holds
 * every post of the account or LIST_MAX of them, or when it reached a known post and no stored post
 * beyond it (one a full listing would include) is due. Exported for tests.
 */
export function sharedListing(shared, known, nowMs) {
  if (!shared || !Array.isArray(shared.items)) return null;
  const items = shared.items.filter((m) => m && m.id);
  if (items.length < shared.max || items.length >= LIST_MAX) return items.slice(0, LIST_MAX);
  if (!items.some((m) => known[m.id])) return null; // newer posts than any known: more may follow
  const ids = new Set(items.map((m) => String(m.id)));
  const oldest = ms(items[items.length - 1].timestamp);
  const beyond = Object.values(known || {})
    .filter((e) => e && e.id && !ids.has(String(e.id)) && !e.deletedAt && !e.unlistedAt && ms(e.timestamp) <= oldest)
    .sort((a, b) => (ms(b.timestamp) || 0) - (ms(a.timestamp) || 0))
    .slice(0, LIST_MAX - items.length);
  return beyond.some((e) => mediaDue(e, e, nowMs)) ? null : items;
}

const SHORTCODE_RE = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

/** Shortcode of an Instagram post link (instagram.com/p/<code>/, /reel/<code>/...), or null. */
export function shortcodeOf(url) {
  const m = SHORTCODE_RE.exec(String(url || '').trim());
  return m ? m[1] : null;
}

/** Can listed media `m` be the hand-posted post `p` (same kind of post)? */
function sameKind(p, m) {
  if (p.type === 'carousel') return m.mediaType === 'CAROUSEL_ALBUM';
  if (p.type === 'reel') return m.mediaType === 'VIDEO' || m.productType === 'REELS';
  if (p.type === 'feed') return m.mediaType === 'IMAGE' || (m.mediaType === 'VIDEO' && (p.media || [])[0]?.kind === 'video');
  return false; // stories are not in the media listing
}

/**
 * Links for posts marked as posted by hand (status 'published', no igMediaId): [{postId, media}].
 * By the shortcode of the pasted link (in the listing, or among stored media); otherwise the media
 * of the same kind nearest to the post's reminder or planned time (published at most 2 hours after
 * it) or to when it was marked as posted (at most 2 hours before, 15 minutes after), closest pairs
 * first, each media at most once and never one another post has. Exported for tests.
 */
export function handPostedLinks(posts, listed, known = {}) {
  const linked = new Set((posts || []).filter((p) => p && p.igMediaId).map((p) => String(p.igMediaId)));
  const open = (posts || []).filter((p) => p && p.status === 'published' && !p.igMediaId && p.type !== 'story');
  const media = (listed || []).filter((m) => m && m.id && !linked.has(String(m.id)));
  const out = [];
  const used = new Set();
  const pairs = [];
  for (const p of open) {
    const code = shortcodeOf(p.permalink);
    if (code) {
      // A pasted link decides: no guessing by time when it matches nothing.
      const m = media.find((x) => x.shortcode === code) || Object.values(known).find((x) => x && x.id && x.shortcode === code && !linked.has(String(x.id)));
      if (m && !used.has(String(m.id))) {
        used.add(String(m.id));
        out.push({ postId: p.id, media: m });
      }
      continue;
    }
    const after = [p.reminderSentAt, p.scheduledAt].map(ms).filter(Number.isFinite);
    const marked = ms(p.publishedAt);
    for (const m of media) {
      if (!sameKind(p, m)) continue;
      const t = ms(m.timestamp);
      if (!Number.isFinite(t)) continue;
      const gaps = after.filter((a) => t >= a && t - a <= LINK_WINDOW_MS).map((a) => t - a);
      if (Number.isFinite(marked) && t <= marked + LINK_EARLY_MS && marked - t <= LINK_WINDOW_MS) gaps.push(Math.abs(marked - t));
      if (gaps.length) pairs.push({ p, m, gap: Math.min(...gaps) });
    }
  }
  const done = new Set(out.map((x) => x.postId));
  for (const { p, m } of pairs.sort((a, b) => a.gap - b.gap)) {
    if (done.has(p.id) || used.has(String(m.id))) continue;
    done.add(p.id);
    used.add(String(m.id));
    out.push({ postId: p.id, media: m });
  }
  return out;
}

/** Does a stored daily snapshot already hold the reach/views breakdowns? */
export function hasBreakdowns(snap) {
  return !!snap && (!!snap.viewsByType || !!snap.reachByType || typeof snap.reachFollowers === 'number' || typeof snap.viewsFollowers === 'number');
}

/**
 * Days of a re-pull window that get the (extra) breakdown calls: days without them, plus the
 * oldest day of the window, whose numbers have settled by now (Instagram can lag up to 48 hours).
 */
export function breakdownDaysFor(stored, sinceKey, untilKey) {
  return dayRange(sinceKey, untilKey).filter((k) => k === sinceKey || !hasBreakdowns(stored && stored[k]));
}

/** Does a stored day hold account numbers (not just the profile's follower count)? */
function hasAccountNumbers(snap) {
  return !!snap && ['reach', 'views', 'accountsEngaged', 'totalInteractions'].some((k) => typeof snap[k] === 'number');
}

/**
 * First day of the daily re-pull: the last 3 complete days, or back to the day after the last one
 * with account numbers when the worker was stopped for longer (gaps are filled while Instagram
 * still has them), at most 28 days. The first run takes 28 days. Exported for tests.
 */
export function repullSince(storedDays, today) {
  const recent = addDaysKey(today, -REPULL_DAYS);
  const oldest = addDaysKey(today, -FIRST_RUN_DAYS);
  const last = Object.keys(storedDays || {})
    .filter((k) => k < today && hasAccountNumbers(storedDays[k]))
    .sort()
    .pop();
  if (!last) return oldest;
  const next = addDaysKey(last, 1);
  return next >= recent ? recent : next < oldest ? oldest : next;
}

/** Time of the last write to the history document (its updatedAt, or the newest point). */
function lastHistoryWrite(hist) {
  let t = parseTimestamp(hist && hist.updatedAt);
  if (!Number.isFinite(t)) t = -Infinity;
  for (const h of Object.values((hist && hist.media) || {})) {
    const pts = h && h.points;
    const last = Array.isArray(pts) && pts.length ? parseTimestamp(pts[pts.length - 1] && pts[pts.length - 1].t) : NaN;
    if (last > t) t = last;
  }
  return t;
}

/**
 * Per-post history step (pure: runs inside the transaction on the analytics-media entries about to
 * be written). Exported for tests.
 * - A post under 30 days old gets a point from its entry when its stats are newer than its last
 *   point: refreshed in this run (`refreshed`: id -> fresh insights; an empty refresh is skipped), or
 *   refreshed by an earlier run whose point was held back (then only when the numbers changed, since
 *   that refresh may have failed and left the old numbers under a newer fetchedAt).
 * - Points are written at most every HISTORY_EVERY_MS, hourly while a post is under 6 hours old,
 *   and at once for a post's first point.
 * - Media older than 90 days or gone from analytics-media is dropped; past 30 days a curve is
 *   thinned to HISTORY_FROZEN_POINTS.
 * @returns {{doc: object, added: number}|null} the document to write, or null to leave it alone
 */
export function updateHistory(hist, media, { nowMs, nowIso, refreshed = new Map() }) {
  const cur = (hist && hist.media) || {};
  const since = nowMs - lastHistoryWrite(hist);
  let open = since >= HISTORY_EVERY_MS;
  const adds = [];
  for (const [id, entry] of Object.entries(media || {})) {
    const published = parseTimestamp(entry && entry.timestamp);
    const age = nowMs - published;
    if (!(age >= 0) || age >= HISTORY_ADD_DAYS * DAY_MS) continue;
    const fresh = refreshed.get(id);
    if (fresh !== undefined && !Object.keys(fresh || {}).length) continue;
    const point = historyPoint(entry, entry.fetchedAt);
    if (!point) continue;
    const pts = (cur[id] && cur[id].points) || [];
    const last = pts[pts.length - 1];
    if (last && !(parseTimestamp(point.t) > parseTimestamp(last.t))) continue;
    if (fresh === undefined && last && sameHistoryValues(last, point)) continue;
    adds.push({ id, point, published });
    if (!pts.length || (age < HISTORY_EARLY_MS && since >= HISTORY_EARLY_EVERY_MS)) open = true;
  }
  if (!open) return null;
  const doc = { ...(hist || {}), media: { ...cur } };
  let added = 0;
  let changed = false;
  for (const { id, point, published } of adds) {
    const next = appendHistoryPoint(doc.media[id] && doc.media[id].points, point, { originMs: published });
    if (!next) continue;
    doc.media[id] = { ...(doc.media[id] || {}), points: next };
    added++;
  }
  for (const id of Object.keys(doc.media)) {
    const entry = media && media[id];
    const published = parseTimestamp(entry && entry.timestamp);
    if (!entry || (Number.isFinite(published) && nowMs - published > HISTORY_KEEP_DAYS * DAY_MS)) {
      delete doc.media[id];
      changed = true;
      continue;
    }
    const pts = doc.media[id] && doc.media[id].points;
    if (Number.isFinite(published) && nowMs - published >= HISTORY_ADD_DAYS * DAY_MS && Array.isArray(pts) && pts.length > HISTORY_FROZEN_POINTS) {
      doc.media[id] = { ...doc.media[id], points: thinPoints(pts, HISTORY_FROZEN_POINTS, published) };
      changed = true;
    }
  }
  if (!added && !changed) return null;
  doc.updatedAt = nowIso;
  return { doc, added };
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) out[k] = v;
  return out;
}

export default async function analytics(ctx) {
  const ig = ctx.ig;
  const nowMs = ctx.nowMs();
  const runIso = new Date(nowMs).toISOString();
  const today = ctx.today();
  const [daily, mediaDoc, audience, postsDoc] = await Promise.all([ctx.store.read('analytics-daily'), ctx.store.read('analytics-media'), ctx.store.read('audience'), ctx.store.read('posts')]);
  const result = { snapshots: 0, mediaRefreshed: 0, historyPoints: 0, audience: 0 };

  // ---- daily account snapshot -----------------------------------------------------------------
  let dayPatch = null; // { days: {key: partial}, markDone: bool }
  if (daily.lastDailyRun !== today) {
    const sinceKey = repullSince(daily.days, today);
    const untilKey = addDaysKey(today, -1);
    const days = {};
    let markDone = true;
    try {
      const breakdowns = breakdownDaysFor(daily.days, sinceKey, untilKey);
      const got = await ig.accountDaily({ sinceKey, untilKey, tz: ctx.tz, breakdowns, nowMs });
      for (const [k, v] of Object.entries(got || {})) days[k] = clean(v);
    } catch (err) {
      if (err && err.isAuth) throw err;
      markDone = !(err && (err.isTransient || err.isRateLimit));
      ctx.log('analytics', 'warn', `Could not read account insights: ${describeError(err)}`, { code: err?.code ?? null });
    }
    try {
      const me = await ig.me();
      days[today] = clean({ ...(days[today] || {}), followers: me.followersCount, follows: me.followsCount, mediaCount: me.mediaCount });
    } catch (err) {
      if (err && err.isAuth) throw err;
      markDone = false;
      ctx.log('analytics', 'warn', `Could not read the profile: ${describeError(err)}`);
    }
    dayPatch = { days, markDone };
  }

  // ---- media insights -------------------------------------------------------------------------
  const known = mediaDoc.media || {};
  let listed = sharedListing(ctx.mediaListing, known, nowMs);
  if (!listed) {
    listed = [];
    try {
      listed = await ig.listMedia({ limit: 50, max: LIST_MAX });
    } catch (err) {
      if (err && err.isAuth) throw err;
      ctx.log('analytics', 'warn', `Could not list posts: ${describeError(err)}`);
    }
  }
  listed = listed.filter((m) => m && m.id);
  const listedIds = new Set(listed.map((m) => String(m.id)));
  const newIds = listed.filter((m) => !known[m.id]).map((m) => m.id);

  // Media gone from Instagram (see the top of the file): {id: {deletedAt} | {unlistedAt} | null (listed again)}.
  const flags = new Map();
  const deletedInApp = new Set((postsDoc.posts || []).filter((p) => p && p.deletedFromInstagramAt && p.igMediaId).map((p) => String(p.igMediaId)));
  // The listing is newest first: every post newer than its last item should be in it.
  const listedUntil = listed.length ? ms(listed[listed.length - 1].timestamp) : NaN;
  const lookups = [];
  for (const [id, e] of Object.entries(known)) {
    if (!e) continue;
    if (listedIds.has(id)) {
      if (e.deletedAt || e.unlistedAt) flags.set(id, null);
      continue;
    }
    if (e.deletedAt) continue;
    if (deletedInApp.has(id)) flags.set(id, { deletedAt: runIso });
    else if (ms(e.timestamp) > listedUntil && !(nowMs - ms(e.unlistedAt) < UNLISTED_RECHECK_MS)) lookups.push(id);
  }
  for (const id of lookups.slice(0, GONE_LOOKUPS_MAX)) {
    try {
      await ig.getMedia(id, 'id');
      flags.set(id, { unlistedAt: runIso });
    } catch (err) {
      if (err && err.isAuth) throw err;
      if (err && (err.isNotFound || (err.code === 100 && !err.isTransient))) flags.set(id, { deletedAt: runIso });
      else if (err && err.isRateLimit) break;
      // Other errors: look again next run.
    }
  }

  // Posts marked as posted by hand, linked to their media (see the top of the file).
  const links = handPostedLinks(postsDoc.posts, listed, known);

  const due = mediaToRefresh(listed, known, nowMs, { writing: newIds.length > 0 || flags.size > 0 });
  const insights = new Map();
  for (const m of due) {
    try {
      insights.set(m.id, (await ig.mediaInsights(m)) || {});
    } catch (err) {
      if (fatal(err)) {
        if (err.isAuth) throw err;
        ctx.log('analytics', 'warn', `Instagram is limiting requests; refreshed ${insights.size} posts this run.`);
        break;
      }
      insights.set(m.id, {});
      ctx.log('analytics', 'warn', `Could not read insights for a post: ${describeError(err)}`);
    }
  }

  // ---- audience (weekly) ----------------------------------------------------------------------
  let audiencePatch = null;
  const audienceDue = !audience.fetchedAt || nowMs - ms(audience.fetchedAt) >= AUDIENCE_EVERY_MS;
  // After a failed attempt, wait a few hours instead of asking again on every run.
  if (audienceDue && !(nowMs - ms(audience.lastAttemptAt) < AUDIENCE_RETRY_MS)) {
    let online = null;
    let demographics = null;
    try {
      online = await ig.onlineFollowers({ tz: ctx.tz, nowMs });
    } catch (err) {
      if (err && err.isAuth) throw err;
      ctx.log('analytics', 'warn', `Could not read when followers are online: ${describeError(err)}`);
    }
    try {
      demographics = await ig.demographics({ timeframe: 'this_month' });
    } catch (err) {
      if (err && err.isAuth) throw err;
      ctx.log('analytics', 'warn', `Could not read audience demographics: ${describeError(err)}`);
    }
    // demographics() returns {follower: null, engaged: null} when Instagram refused every breakdown
    // (rate limit, temporary error): that must not replace last week's data.
    const usableDemo = demographics && (demographics.follower || demographics.engaged) ? demographics : null;
    audiencePatch = { online, demographics: usableDemo };
  }

  if (!dayPatch && !insights.size && !newIds.length && !flags.size && !links.length && !audiencePatch) return result;

  let deletedNow = 0;
  let linkedNow = 0;
  await ctx.store.transact(
    async (tx) => {
      const nowIso = ctx.nowIso();
      result.snapshots = 0;
      result.mediaRefreshed = 0;
      result.historyPoints = 0;
      result.audience = 0;
      deletedNow = 0;
      linkedNow = 0;
      if (dayPatch) {
        const d = await tx.read('analytics-daily');
        d.days ||= {};
        for (const [k, v] of Object.entries(dayPatch.days)) {
          if (!Object.keys(v).length) continue;
          d.days[k] = { ...(d.days[k] || {}), ...v, capturedAt: nowIso };
          result.snapshots++;
        }
        if (dayPatch.markDone) d.lastDailyRun = today;
        d.lastAttemptAt = nowIso;
        tx.write('analytics-daily', d);
      }
      if (insights.size || newIds.length || flags.size) {
        const md = await tx.read('analytics-media');
        md.media ||= {};
        for (const [id, flag] of flags) {
          const prev = md.media[id];
          if (!prev || listedIds.has(id)) continue; // listed entries are rebuilt below, without the flags
          if (flag && flag.deletedAt && !prev.deletedAt) {
            md.media[id] = { ...prev, deletedAt: flag.deletedAt };
            deletedNow++;
          } else if (flag && flag.unlistedAt) md.media[id] = { ...prev, unlistedAt: flag.unlistedAt };
        }
        for (const m of listed) {
          if (!m || !m.id) continue;
          const fresh = insights.get(m.id);
          const prev = md.media[m.id];
          if (!prev && fresh === undefined && !newIds.includes(m.id)) continue;
          const entry = {
            ...(prev || {}),
            id: m.id,
            caption: m.caption || '',
            mediaType: m.mediaType || null,
            productType: m.productType || null,
            permalink: m.permalink || null,
            shortcode: m.shortcode || null,
            timestamp: m.timestamp || null,
            thumbnailUrl: previewUrl(m),
            mediaUrl: m.mediaUrl || null,
            likeCount: m.likeCount ?? prev?.likeCount ?? null,
            commentsCount: m.commentsCount ?? prev?.commentsCount ?? null,
            metrics: prev?.metrics || {},
            fetchedAt: prev?.fetchedAt || null,
          };
          if (fresh !== undefined) {
            if (Object.keys(fresh).length) entry.metrics = { ...entry.metrics, ...fresh };
            entry.fetchedAt = nowIso;
            result.mediaRefreshed++;
          }
          // Listed, so not deleted (any more) and not hidden from the listing.
          delete entry.deletedAt;
          delete entry.unlistedAt;
          md.media[m.id] = entry;
        }
        md.updatedAt = nowIso;
        tx.write('analytics-media', md);

        // Per-post history (see updateHistory: points from the entries just written, rate-limited writes).
        const hist = updateHistory(await tx.read('analytics-media-history'), md.media, { nowMs, nowIso, refreshed: insights });
        if (hist) {
          tx.write('analytics-media-history', hist.doc);
          result.historyPoints = hist.added;
        }
      }
      if (links.length) {
        const doc = await tx.read('posts');
        const taken = new Set(doc.posts.filter((p) => p.igMediaId).map((p) => String(p.igMediaId)));
        for (const { postId, media } of links) {
          const p = doc.posts.find((x) => x.id === postId);
          // Re-checked on the current document: the app may have changed the post meanwhile.
          if (!p || p.status !== 'published' || p.igMediaId || taken.has(String(media.id))) continue;
          p.igMediaId = String(media.id);
          if (!p.permalink && media.permalink) p.permalink = media.permalink;
          taken.add(p.igMediaId);
          pushHistory(p, nowIso, 'linked', 'Found this post on Instagram; its numbers now show here.');
          linkedNow++;
        }
        if (linkedNow) tx.write('posts', doc);
      }
      if (audiencePatch) {
        const a = await tx.read('audience');
        if (audiencePatch.online) a.onlineFollowers = audiencePatch.online;
        if (audiencePatch.demographics) a.demographics = audiencePatch.demographics;
        // Only real data restarts the weekly wait; a failed attempt is retried after a few hours.
        if (audiencePatch.online || audiencePatch.demographics) a.fetchedAt = nowIso;
        a.lastAttemptAt = nowIso;
        result.audience = audiencePatch.online || audiencePatch.demographics ? 1 : 0;
        tx.write('audience', a);
      }
    },
    { message: 'analytics: snapshot' },
  );
  if (deletedNow) result.deletedMedia = deletedNow;
  if (linkedNow) result.linked = linkedNow;
  if (result.linked) ctx.log('analytics', 'info', `Found ${result.linked === 1 ? 'a post' : `${result.linked} posts`} you posted by hand on Instagram; ${result.linked === 1 ? 'its' : 'their'} numbers now show in Postpilot.`);
  return result;
}
