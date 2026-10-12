// Analytics snapshots. Instagram keeps account metrics for 30-90 days only, so Postpilot's own
// daily snapshots become the long-term history.
// - Once per local day (analytics-daily.lastDailyRun): account metrics for the last 3 complete days
//   (28 on the first run) merged into analytics-daily.days, plus followers/follows/media count
//   from the profile into today's key.
// - Media insights: media younger than 2 days every hour, younger than 30 days daily, older
//   weekly; at most 60 per run, youngest first. Stored in analytics-media.media[id].
// - Audience (online followers + demographics) weekly into the audience document. A run that gets
//   nothing usable keeps the old data and fetchedAt and tries again after AUDIENCE_RETRY_MS.
// All writes happen in one transaction at the end.

import { addDaysKey } from '../../core/time.js';
import { describeError } from '../context.mjs';
import { DAY_MS } from './shared.mjs';

const FIRST_RUN_DAYS = 28;
const REPULL_DAYS = 3;
const MAX_MEDIA_PER_RUN = 60;
const YOUNG_MS = 2 * DAY_MS;
const YOUNG_EVERY_MS = 60 * 60e3;
const MONTH_MS = 30 * DAY_MS;
const DAILY_EVERY_MS = 20 * 36e5;
const WEEKLY_EVERY_MS = 7 * DAY_MS;
const AUDIENCE_EVERY_MS = 7 * DAY_MS;
const AUDIENCE_RETRY_MS = 6 * 36e5;

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
  if (age < MONTH_MS) return since >= DAILY_EVERY_MS;
  return since >= WEEKLY_EVERY_MS;
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
  const result = { snapshots: 0, mediaRefreshed: 0, audience: 0 };

  // ---- daily account snapshot -----------------------------------------------------------------
  let dayPatch = null; // { days: {key: partial}, markDone: bool }
  if (daily.lastDailyRun !== today) {
    const hasHistory = Object.keys(daily.days || {}).length > 0;
    const sinceKey = addDaysKey(today, -(hasHistory ? REPULL_DAYS : FIRST_RUN_DAYS));
    const untilKey = addDaysKey(today, -1);
    const days = {};
    let markDone = true;
    try {
      const got = await ig.accountDaily({ sinceKey, untilKey, tz: ctx.tz });
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
