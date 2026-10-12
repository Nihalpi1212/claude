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
//     under 2 days   hourly        (~48 calls: the first-day curve and the 24-hour value)
//     2 to 7 days    every 6 hours (~20 calls: the 7-day value)
//     7 to 30 days   daily         (~23 calls)
//     older          weekly
//   About 90 calls per post in its first month; even at one post a day that is under 150 calls a
//   day, far below Instagram's per-account budget (4800 x daily impressions per 24 hours).
//   Stored in analytics-media.media[id].
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
import { DAY_MS } from './shared.mjs';

const FIRST_RUN_DAYS = 28;
const REPULL_DAYS = 3;
const MAX_MEDIA_PER_RUN = 60;
const YOUNG_MS = 2 * DAY_MS;
const YOUNG_EVERY_MS = 60 * 60e3;
const WEEK_MS = 7 * DAY_MS;
const FIRST_WEEK_EVERY_MS = 6 * 36e5;
const MONTH_MS = 30 * DAY_MS;
const DAILY_EVERY_MS = 20 * 36e5;
const WEEKLY_EVERY_MS = 7 * DAY_MS;
const AUDIENCE_EVERY_MS = 7 * DAY_MS;
const AUDIENCE_RETRY_MS = 6 * 36e5;
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

/** Is this media item due for an insights refresh? Exported for tests. */
export function mediaDue(m, prev, nowMs) {
  const age = nowMs - ms(m.timestamp);
  const last = ms(prev?.fetchedAt);
  if (!Number.isFinite(last)) return true;
  const since = nowMs - last;
  if (!(age >= 0)) return since >= DAILY_EVERY_MS;
  if (age < YOUNG_MS) return since >= YOUNG_EVERY_MS;
  if (age < WEEK_MS) return since >= FIRST_WEEK_EVERY_MS;
  if (age < MONTH_MS) return since >= DAILY_EVERY_MS;
  return since >= WEEKLY_EVERY_MS;
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
  const today = ctx.today();
  const [daily, mediaDoc, audience] = await Promise.all([ctx.store.read('analytics-daily'), ctx.store.read('analytics-media'), ctx.store.read('audience')]);
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
      const got = await ig.accountDaily({ sinceKey, untilKey, tz: ctx.tz, breakdowns });
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
  let listed = [];
  try {
    listed = await ig.listMedia({ limit: 50, max: 100 });
  } catch (err) {
    if (err && err.isAuth) throw err;
    ctx.log('analytics', 'warn', `Could not list posts: ${describeError(err)}`);
  }
  const known = mediaDoc.media || {};
  const due = listed
    .filter((m) => m && m.id && mediaDue(m, known[m.id], nowMs))
    .sort((a, b) => (ms(b.timestamp) || 0) - (ms(a.timestamp) || 0))
    .slice(0, MAX_MEDIA_PER_RUN);
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
  const newIds = listed.filter((m) => m && m.id && !known[m.id]).map((m) => m.id);

  // ---- audience (weekly) ----------------------------------------------------------------------
  let audiencePatch = null;
  const audienceDue = !audience.fetchedAt || nowMs - ms(audience.fetchedAt) >= AUDIENCE_EVERY_MS;
  // After a failed attempt, wait a few hours instead of asking again on every run.
  if (audienceDue && !(nowMs - ms(audience.lastAttemptAt) < AUDIENCE_RETRY_MS)) {
    let online = null;
    let demographics = null;
    try {
      online = await ig.onlineFollowers({ tz: ctx.tz });
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

  if (!dayPatch && !insights.size && !newIds.length && !audiencePatch) return result;

  await ctx.store.transact(
    async (tx) => {
      const nowIso = ctx.nowIso();
      result.snapshots = 0;
      result.mediaRefreshed = 0;
      result.historyPoints = 0;
      result.audience = 0;
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
      if (insights.size || newIds.length) {
        const md = await tx.read('analytics-media');
        md.media ||= {};
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
  return result;
}
