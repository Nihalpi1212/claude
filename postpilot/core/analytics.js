// KPI math over the analytics documents (pure, environment-neutral).
//
// Inputs follow core/model.js shapes:
//   days        analytics-daily.days   { 'YYYY-MM-DD': DailySnapshot }  (the whole doc is accepted too)
//   mediaStats  analytics-media.media  { [id]: MediaStats }              (an array is accepted too)
//
// Conventions:
//   - Missing data is null, never 0. A sum over days where a metric was never
//     reported is null so the UI can show "no data" instead of a fake zero.
//   - Rates are fractions (0.034 = 3.4%). Format them with formatPercent.
//   - Engagement rate (ER) = interactions / reach, or interactions / followers
//     when reach is missing. interactions = totalInteractions, else
//     likes + comments + saves + shares.

import { addDaysKey, dayKey, dayRange, zonedParts } from './time.js';
import { hashtagsIn } from './model.js';

/** Snapshot fields that are levels (take first/last), not flows (sum). */
export const STOCK_METRICS = ['followers', 'follows', 'mediaCount'];

/** Snapshot fields that are summed over a period. */
export const FLOW_METRICS = [
  'reach',
  'views',
  'accountsEngaged',
  'totalInteractions',
  'likes',
  'comments',
  'shares',
  'saves',
  'replies',
  'profileLinksTaps',
  'websiteClicks',
  'profileViews',
  'followsGained',
  'unfollows',
  // Reach and views split by followers / non-followers (ig.accountDaily breakdowns).
  'reachFollowers',
  'reachNonFollowers',
  'viewsFollowers',
  'viewsNonFollowers',
];

// ---------------------------------------------------------------------------
// Small shared helpers (also used by schedule.js)

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function num(v) {
  return isNum(v) ? v : null;
}

/** Parse an ISO timestamp (also Instagram's "+0000" offset form) to epoch ms; NaN when invalid. */
export function parseTimestamp(ts) {
  if (ts instanceof Date) return ts.getTime();
  if (isNum(ts)) return ts;
  if (typeof ts !== 'string' || !ts) return NaN;
  let t = Date.parse(ts);
  if (Number.isNaN(t)) t = Date.parse(ts.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return t;
}

/** Accept an object map ({id: item}) or an array and return an array of truthy items. */
export function toList(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection.filter(Boolean);
  if (typeof collection === 'object') return Object.values(collection).filter(Boolean);
  return [];
}

function daysMap(days) {
  if (!days || typeof days !== 'object') return {};
  // Accept the whole analytics-daily doc as well as its `days` map.
  if (days.days && typeof days.days === 'object' && !Array.isArray(days.days)) return days.days;
  return days;
}

function metricsOf(stats) {
  if (!stats || typeof stats !== 'object') return {};
  return stats.metrics && typeof stats.metrics === 'object' ? stats.metrics : stats;
}

function avg(values) {
  const v = values.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ---------------------------------------------------------------------------
// Engagement

/**
 * Interactions of a MediaStats, StoryStats, metrics object or DailySnapshot.
 * totalInteractions when present, else likes + comments + saves + shares (null when none is known).
 * @returns {number|null}
 */
export function interactionsOf(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const m = metricsOf(stats);
  if (isNum(m.totalInteractions)) return m.totalInteractions;
  const parts = [
    num(m.likes) ?? num(stats.likeCount),
    num(m.comments) ?? num(stats.commentsCount),
    num(m.saved) ?? num(m.saves),
    num(m.shares),
  ].filter(isNum);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/**
 * Engagement rate as a fraction: interactions / reach (when reach > 0), else interactions / followers.
 * @param {object} stats MediaStats, metrics object or DailySnapshot
 * @param {number} [followers]
 * @returns {number|null}
 */
export function engagementRate(stats, followers) {
  const interactions = interactionsOf(stats);
  if (interactions == null) return null;
  const reach = num(metricsOf(stats).reach);
  if (reach != null && reach > 0) return interactions / reach;
  if (isNum(followers) && followers > 0) return interactions / followers;
  return null;
}

/**
 * Value of a named metric for one media item.
 * Metric names: 'er' | 'engagementRate' | 'interactions' | 'totalInteractions' | 'likes' | 'comments' |
 * 'saves' | 'saved' | 'shares' | 'reach' | 'views' | 'profileVisits' | 'follows' | 'avgWatchTimeMs' | ...
 * @returns {number|null}
 */
export function metricValue(media, metric, { followers } = {}) {
  if (!media) return null;
  const m = metricsOf(media);
  switch (metric) {
    case 'er':
    case 'engagementRate':
      return engagementRate(media, followers);
    case 'interactions':
    case 'totalInteractions':
      return interactionsOf(media);
    case 'likes':
      return num(m.likes) ?? num(media.likeCount);
    case 'comments':
      return num(m.comments) ?? num(media.commentsCount);
    case 'saves':
    case 'saved':
      return num(m.saved) ?? num(m.saves);
    default:
      return num(m[metric]) ?? num(media[metric]);
  }
}

// ---------------------------------------------------------------------------
// Daily snapshots

/**
 * Totals for the inclusive day range. Flow metrics are summed; followers take the first and
 * last known value in the range. Metrics never reported stay null.
 * @returns {{followersStart, followersEnd, followerGrowth, followerGrowthPct, reach, views, accountsEngaged,
 *   totalInteractions, likes, comments, shares, saves, replies, profileLinksTaps, websiteClicks, profileViews,
 *   followsGained, unfollows, engagementRate, daysWithData}}
 */
export function summarizeDays(days, fromKey, toKey) {
  const map = daysMap(days);
  const out = { followersStart: null, followersEnd: null, followerGrowth: null, followerGrowthPct: null };
  for (const k of FLOW_METRICS) out[k] = null;
  let daysWithData = 0;
  if (fromKey && toKey && fromKey <= toKey) {
    for (const key of dayRange(fromKey, toKey)) {
      const snap = map[key];
      if (!snap || typeof snap !== 'object') continue;
      daysWithData++;
      if (isNum(snap.followers)) {
        if (out.followersStart == null) out.followersStart = snap.followers;
        out.followersEnd = snap.followers;
      }
      for (const k of FLOW_METRICS) if (isNum(snap[k])) out[k] = (out[k] ?? 0) + snap[k];
    }
  }
  if (out.followersStart != null) {
    out.followerGrowth = out.followersEnd - out.followersStart;
    out.followerGrowthPct = out.followersStart > 0 ? out.followerGrowth / out.followersStart : null;
  }
  const interactions = interactionsOf(out);
  out.engagementRate = interactions != null && out.reach > 0 ? interactions / out.reach : null;
  out.daysWithData = daysWithData;
  return out;
}

/**
 * Compare a period with the same-length window right before it.
 * delta[metric] = (current - previous) / |previous| (null when either side is missing or previous is 0).
 * For the rate metrics followerGrowthPct and engagementRate, delta is the difference in fraction points.
 * @returns {{current, previous, delta, previousRange: {fromKey, toKey}}}
 */
export function comparePeriods(days, fromKey, toKey) {
  const len = fromKey <= toKey ? dayRange(fromKey, toKey).length : 0;
  const prevTo = addDaysKey(fromKey, -1);
  const prevFrom = addDaysKey(fromKey, -Math.max(1, len));
  const current = summarizeDays(days, fromKey, toKey);
  const previous = summarizeDays(days, prevFrom, prevTo);
  const delta = {};
  for (const k of Object.keys(current)) {
    if (k === 'daysWithData') continue;
    const c = current[k];
    const p = previous[k];
    if (!isNum(c) || !isNum(p)) delta[k] = null;
    else if (k === 'followerGrowthPct' || k === 'engagementRate') delta[k] = c - p;
    else delta[k] = p === 0 ? null : (c - p) / Math.abs(p);
  }
  return { current, previous, delta, previousRange: { fromKey: prevFrom, toKey: prevTo } };
}

/**
 * Daily series for one snapshot metric (or 'engagementRate').
 * Stock metrics (followers, follows, mediaCount) are forward-filled by default, seeded from the last
 * known value up to 31 days before the range.
 * @param {object} [opts] { forwardFill?: boolean }
 * @returns {{labels: string[], values: (number|null)[]}}
 */
export function seriesFor(days, metric, fromKey, toKey, opts = {}) {
  const map = daysMap(days);
  const forwardFill = opts.forwardFill ?? STOCK_METRICS.includes(metric);
  const read = (snap) => {
    if (!snap || typeof snap !== 'object') return null;
    if (metric === 'engagementRate' || metric === 'er') return engagementRate(snap, snap.followers);
    return num(snap[metric]);
  };
  const labels = fromKey && toKey && fromKey <= toKey ? dayRange(fromKey, toKey) : [];
  let last = null;
  if (forwardFill && labels.length) {
    for (let i = 1; i <= 31 && last == null; i++) last = read(map[addDaysKey(fromKey, -i)]);
  }
  const values = labels.map((key) => {
    const v = read(map[key]);
    if (v != null) last = v;
    return v != null ? v : forwardFill ? last : null;
  });
  return { labels, values };
}

// ---------------------------------------------------------------------------
// Media

/** Media published (timestamp) between the two day keys inclusive, in `tz`. Newest first. */
export function mediaInRange(mediaStats, fromKey, toKey, tz = 'UTC') {
  return toList(mediaStats)
    .map((m) => ({ m, t: parseTimestamp(m.timestamp) }))
    .filter(({ t }) => Number.isFinite(t))
    .filter(({ t }) => {
      const k = dayKey(new Date(t), tz);
      return (!fromKey || k >= fromKey) && (!toKey || k <= toKey);
    })
    .sort((a, b) => b.t - a.t)
    .map(({ m }) => m);
}

/** Top n media by a metric (see metricValue). Items without the metric are left out. */
export function topMedia(list, metric = 'er', n = 10, opts = {}) {
  return toList(list)
    .map((m) => ({ m, v: metricValue(m, metric, opts) }))
    .filter(({ v }) => v != null)
    .sort((a, b) => b.v - a.v || parseTimestamp(b.m.timestamp) - parseTimestamp(a.m.timestamp))
    .slice(0, n)
    .map(({ m }) => m);
}

/**
 * Averages per media type.
 * @param {Array|object} list MediaStats
 * @param {'productType'|'mediaType'|function} [by] grouping key (default productType: FEED, REELS, STORY...)
 * @returns {{[type: string]: {count, avgReach, avgViews, avgER, avgInteractions, avgLikes, avgComments,
 *   avgSaves, avgShares, avgWatchTimeMs, totalReach, totalInteractions}}}
 */
export function aggregateByType(list, by = 'productType') {
  const groups = {};
  for (const m of toList(list)) {
    const key = (typeof by === 'function' ? by(m) : m[by]) || m.mediaType || 'UNKNOWN';
    (groups[key] ||= []).push(m);
  }
  const out = {};
  for (const [key, items] of Object.entries(groups)) {
    const values = (metric) => items.map((m) => metricValue(m, metric));
    const sum = (metric) => {
      const v = values(metric).filter(isNum);
      return v.length ? v.reduce((a, b) => a + b, 0) : null;
    };
    out[key] = {
      count: items.length,
      avgReach: avg(values('reach')),
      avgViews: avg(values('views')),
      avgER: avg(values('er')),
      avgInteractions: avg(values('interactions')),
      avgLikes: avg(values('likes')),
      avgComments: avg(values('comments')),
      avgSaves: avg(values('saves')),
      avgShares: avg(values('shares')),
      avgWatchTimeMs: avg(values('avgWatchTimeMs')),
      totalReach: sum('reach'),
      totalInteractions: sum('interactions'),
    };
  }
  return out;
}

/**
 * Hashtag performance from captions. Each tag counts once per post.
 * @returns {Array<{tag, posts, avgReach, avgER, avgInteractions}>} sorted by avgER (desc, nulls last)
 */
export function hashtagPerformance(mediaList, { minPosts = 2 } = {}) {
  const byTag = new Map();
  for (const m of toList(mediaList)) {
    for (const tag of new Set(hashtagsIn(m.caption || ''))) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(m);
    }
  }
  const rows = [];
  for (const [tag, items] of byTag) {
    if (items.length < minPosts) continue;
    rows.push({
      tag,
      posts: items.length,
      avgReach: avg(items.map((m) => metricValue(m, 'reach'))),
      avgER: avg(items.map((m) => engagementRate(m))),
      avgInteractions: avg(items.map((m) => interactionsOf(m))),
    });
  }
  return rows.sort((a, b) => (b.avgER ?? -1) - (a.avgER ?? -1) || b.posts - a.posts || (a.tag < b.tag ? -1 : 1));
}

/**
 * Average of a metric by local weekday (0=Sun) and hour of publication.
 * @returns {(number|null)[][]} 7x24, null where there is no data
 */
export function byWeekdayHour(mediaList, tz = 'UTC', metric = 'er') {
  const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const m of toList(mediaList)) {
    const t = parseTimestamp(m.timestamp);
    const v = metricValue(m, metric);
    if (!Number.isFinite(t) || v == null) continue;
    const p = zonedParts(new Date(t), tz);
    sums[p.weekday][p.hour] += v;
    counts[p.weekday][p.hour] += 1;
  }
  return sums.map((row, w) => row.map((s, h) => (counts[w][h] ? s / counts[w][h] : null)));
}

/** Posts per week published within the inclusive day range. */
export function postingFrequency(mediaList, fromKey, toKey, tz = 'UTC') {
  if (!fromKey || !toKey || fromKey > toKey) return 0;
  const days = dayRange(fromKey, toKey).length;
  return mediaInRange(mediaList, fromKey, toKey, tz).length / (days / 7);
}

/**
 * Sum a per-type breakdown map of the daily snapshots (reachByType, viewsByType: {POST, REEL, STORY,
 * CAROUSEL_CONTAINER, AD, ...}) over the inclusive range.
 * @returns {{[type: string]: number}|null} null when no day in the range has the breakdown
 */
export function breakdownTotals(days, fromKey, toKey, field) {
  const map = daysMap(days);
  let out = null;
  if (!fromKey || !toKey || fromKey > toKey) return null;
  for (const key of dayRange(fromKey, toKey)) {
    const b = map[key] && map[key][field];
    if (!b || typeof b !== 'object') continue;
    out ||= {};
    for (const [type, v] of Object.entries(b)) if (isNum(v)) out[type] = (out[type] ?? 0) + v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-post history (analytics-media-history.media[id].points)

/** Short keys of a history point and the metric each one holds. */
export const HISTORY_KEYS = { v: 'views', r: 'reach', l: 'likes', c: 'comments', s: 'saves', sh: 'shares', f: 'follows' };
/** Points kept per post (the middle is thinned, the first and last stay). */
export const HISTORY_MAX_POINTS = 48;
/** Points kept once a post is past HISTORY_ADD_DAYS and its curve no longer changes. */
export const HISTORY_FROZEN_POINTS = 20;
/** Points are added while a post is younger than this. */
export const HISTORY_ADD_DAYS = 30;
/** History of posts older than this is dropped. */
export const HISTORY_KEEP_DAYS = 90;
/** Ages (hours after publishing) whose surrounding points thinning keeps: the 24-hour and 7-day values. */
export const HISTORY_ANCHOR_HOURS = [24, 168];
const HOUR_MS = 3600e3;

/** ISO string without milliseconds (history points are stored many times over). */
function isoSeconds(t) {
  const ms = parseTimestamp(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

/**
 * A history point {t, v, r, l, c, s, sh, f} from a MediaStats entry at time `t`. Metrics Instagram
 * did not report are left out. Returns null when no metric is known.
 */
export function historyPoint(media, t) {
  const p = { t: isoSeconds(t) };
  if (!p.t) return null;
  let any = false;
  for (const [k, metric] of Object.entries(HISTORY_KEYS)) {
    const v = metricValue(media, metric);
    if (v != null) {
      p[k] = v;
      any = true;
    }
  }
  return any ? p : null;
}

/** Do two history points hold the same numbers (time aside)? */
export function sameHistoryValues(a, b) {
  return Object.keys(HISTORY_KEYS).every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

/**
 * Thin a time-ordered list to at most `max` points, always keeping the first and the last. Each
 * round removes the interior point whose neighbours are closest on a log(1 + hours since `originMs`)
 * scale, so the first hours (when a post moves fastest) stay denser than the later days. With
 * `originMs` (the publish time), the points right before and after each of `keepHours` also stay,
 * so the values at 24 hours and 7 days (valueAtAge) do not change when a curve is thinned.
 */
export function thinPoints(points, max = HISTORY_MAX_POINTS, originMs, keepHours = HISTORY_ANCHOR_HOURS) {
  const list = (points || []).filter(Boolean);
  if (list.length <= max) return list;
  if (max < 2) return list.slice(-Math.max(0, max));
  const t0 = Number.isFinite(originMs) ? originMs : parseTimestamp(list[0].t);
  const hours = list.map((p) => Math.max(0, parseTimestamp(p.t) - t0) / HOUR_MS);
  const pos = hours.map((h) => Math.log1p(h));
  const keep = new Set();
  if (Number.isFinite(originMs)) {
    for (const age of keepHours || []) {
      let before = -1;
      let after = -1;
      hours.forEach((h, i) => {
        if (h <= age) before = i;
        if (h >= age && after < 0) after = i;
      });
      if (before >= 0) keep.add(list[before]);
      if (after >= 0) keep.add(list[after]);
    }
  }
  while (list.length > max) {
    let best = -1;
    let bestGap = Infinity;
    for (let i = 1; i < list.length - 1; i++) {
      if (keep.has(list[i])) continue;
      const gap = pos[i + 1] - pos[i - 1];
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best < 0) break;
    list.splice(best, 1);
    pos.splice(best, 1);
  }
  return list;
}

/**
 * Append a point to a post's history. Skipped (returns null) when nothing changed and the last point
 * is less than `minGapMs` old, or when the point is not newer than the last one. Otherwise returns the
 * new list, thinned to `max` points.
 */
export function appendHistoryPoint(points, point, { minGapMs = 3 * HOUR_MS, max = HISTORY_MAX_POINTS, originMs } = {}) {
  const t = parseTimestamp(point && point.t);
  if (!Number.isFinite(t)) return null;
  const list = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(parseTimestamp(p.t)));
  const last = list[list.length - 1];
  if (last) {
    const lt = parseTimestamp(last.t);
    if (t <= lt) return null;
    if (sameHistoryValues(last, point) && t - lt < minGapMs) return null;
  }
  return thinPoints([...list, point], max, originMs);
}

/**
 * A history metric `ageHours` after publishing, interpolated linearly between the points around
 * that age. null when the history does not reach that age, starts after it, or its points around
 * it are too far apart. Cumulative views and reach rise fast and then flatten, so a straight line
 * from 0 at publishing to a late first point would understate the value: the publish time counts
 * as 0 only when the first point is a few minutes past the age (cron jitter), like the end case.
 * @param {Array} points history points
 * @param {string|number} publishedAt the post's timestamp
 * @param {number} ageHours e.g. 24 or 168
 * @param {string} [key] short history key ('v' views, 'r' reach, ...)
 * @returns {number|null}
 */
export function valueAtAge(points, publishedAt, ageHours, key = 'v') {
  const t0 = parseTimestamp(publishedAt);
  if (!Number.isFinite(t0) || !Array.isArray(points)) return null;
  const pts = points
    .map((p) => ({ h: (parseTimestamp(p && p.t) - t0) / HOUR_MS, v: num(p && p[key]) }))
    .filter((p) => Number.isFinite(p.h) && p.h >= 0 && p.v != null)
    .sort((a, b) => a.h - b.h);
  if (!pts.length) return null;
  let after = null;
  let before = null;
  for (const p of pts) {
    if (p.h <= ageHours) before = p;
    if (p.h >= ageHours && !after) after = p;
  }
  if (before && before.h === ageHours) return before.v;
  // A run a little short of or past the target age (cron jitter) still counts.
  const slack = Math.max(1, ageHours * 0.03);
  if (!after) return ageHours - before.h <= slack ? before.v : null;
  if (!before) return after.h - ageHours <= slack ? Math.round((after.v * ageHours) / after.h) : null;
  if (after.h - before.h > Math.max(6, ageHours / 2)) return null;
  return Math.round(before.v + ((after.v - before.v) * (ageHours - before.h)) / (after.h - before.h));
}

/** Median of the finite numbers in `values` (null when there are none). */
export function median(values) {
  const v = (values || []).filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Campaigns (post labels joined to media stats by igMediaId)

const labelKey = (l) => String(l ?? '').trim().toLowerCase();

/**
 * Labels of published posts by Instagram media id. Pass the posts (and posts-archive) arrays or docs.
 * @returns {Map<string, string[]>}
 */
export function labelsByMedia(...lists) {
  const out = new Map();
  for (const list of lists) {
    const arr = Array.isArray(list) ? list : Array.isArray(list && list.posts) ? list.posts : [];
    for (const p of arr) {
      if (!p || !p.igMediaId || !Array.isArray(p.labels)) continue;
      const id = String(p.igMediaId);
      const have = out.get(id) || [];
      for (const raw of p.labels) {
        const l = String(raw ?? '').trim();
        if (l && !have.some((x) => labelKey(x) === labelKey(l))) have.push(l);
      }
      if (have.length) out.set(id, have);
    }
  }
  return out;
}

/** Labels used on media in `mediaList`, most used first: [{label, count}]. */
export function labelCounts(mediaList, index) {
  const counts = new Map();
  for (const m of toList(mediaList)) {
    for (const l of (index && index.get(String(m.id))) || []) {
      const k = labelKey(l);
      const cur = counts.get(k) || { label: l, count: 0 };
      cur.count++;
      counts.set(k, cur);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Media items whose post carries `label` (case-insensitive). */
export function mediaWithLabel(mediaList, index, label) {
  const k = labelKey(label);
  if (!k) return toList(mediaList);
  return toList(mediaList).filter((m) => ((index && index.get(String(m.id))) || []).some((l) => labelKey(l) === k));
}

/**
 * Totals and per-post averages for a set of posts (a campaign).
 * @returns {{posts, reach, views, interactions, likes, comments, saves, shares, avgReach, avgViews,
 *   avgInteractions, avgER, top}}
 */
export function campaignStats(mediaList, { followers } = {}) {
  const list = toList(mediaList);
  const total = (metric) => {
    const v = list.map((m) => metricValue(m, metric, { followers })).filter(isNum);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const mean = (metric) => avg(list.map((m) => metricValue(m, metric, { followers })));
  return {
    posts: list.length,
    reach: total('reach'),
    views: total('views'),
    interactions: total('interactions'),
    likes: total('likes'),
    comments: total('comments'),
    saves: total('saves'),
    shares: total('shares'),
    avgReach: mean('reach'),
    avgViews: mean('views'),
    avgInteractions: mean('interactions'),
    avgER: mean('er'),
    top: topMedia(list, 'interactions', 1, { followers })[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Monthly reports

/** First and last day keys of a 'YYYY-MM' month. */
export function monthBounds(month) {
  const [y, m] = String(month).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { fromKey: `${month}-01`, toKey: `${month}-${String(last).padStart(2, '0')}` };
}

/** 'YYYY-MM' of the month before `month`. */
export function previousMonth(month) {
  return addDaysKey(`${month}-01`, -1).slice(0, 7);
}

/** Small copy of a MediaStats entry for a stored report (no media URLs except the expiring thumbnail). */
function mediaLite(m) {
  const mt = metricsOf(m);
  const metrics = {};
  for (const k of ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'totalInteractions', 'follows', 'profileVisits']) if (isNum(mt[k])) metrics[k] = mt[k];
  const caption = String(m.caption || '');
  return {
    id: m.id,
    caption: caption.length > 160 ? `${caption.slice(0, 159)}…` : caption,
    mediaType: m.mediaType || null,
    productType: m.productType || null,
    permalink: m.permalink || null,
    timestamp: m.timestamp || null,
    thumbnailUrl: m.thumbnailUrl || null,
    likeCount: num(m.likeCount),
    commentsCount: num(m.commentsCount),
    metrics,
  };
}

/** Share of a month's days that must be saved before its totals stand for the whole month. */
export const MONTH_COMPLETE_SHARE = 0.9;

const hasAccountNumbers = (d) => !!d && typeof d === 'object' && ['reach', 'views', 'accountsEngaged', 'totalInteractions'].some((k) => isNum(d[k]));

function monthNumbers(days, media, stories, month, tz) {
  const { fromKey, toKey } = monthBounds(month);
  const map = daysMap(days);
  const keys = dayRange(fromKey, toKey);
  const s = summarizeDays(map, fromKey, toKey);
  // Coverage: days with account numbers, with a follower count, and with Instagram's splits.
  let daysSaved = 0;
  let followerDays = 0;
  let breakdownDays = 0;
  let viewsByTypeDays = 0;
  let reachF = 0;
  let reachN = 0;
  for (const k of keys) {
    const d = map[k];
    if (hasAccountNumbers(d)) daysSaved++;
    if (d && isNum(d.followers)) followerDays++;
    if (d && d.viewsByType && typeof d.viewsByType === 'object') viewsByTypeDays++;
    if (d && isNum(d.reachFollowers) && isNum(d.reachNonFollowers)) {
      breakdownDays++;
      reachF += d.reachFollowers;
      reachN += d.reachNonFollowers;
    }
  }
  // A single follower count is not a change: growth needs counts from two different days.
  if (followerDays < 2) {
    s.followerGrowth = null;
    s.followerGrowthPct = null;
  }
  const posts = mediaInRange(media, fromKey, toKey, tz).filter((m) => m.productType !== 'STORY');
  const reels = posts.filter((m) => m.productType === 'REELS' || (m.mediaType === 'VIDEO' && m.productType !== 'FEED'));
  return {
    ...s,
    fromKey,
    toKey,
    daysInMonth: keys.length,
    daysSaved,
    followerDays,
    breakdownDays,
    viewsByTypeDays,
    // Over the days that have the split (reachNonFollowers alone is a partial sum when some lack it).
    nonFollowerReachShare: reachF + reachN > 0 ? reachN / (reachF + reachN) : null,
    interactions: interactionsOf(s),
    posts: posts.length,
    reels: reels.length,
    stories: mediaInRange(stories, fromKey, toKey, tz).length,
    postsPerWeek: postingFrequency(posts, fromKey, toKey, tz),
    avgPostReach: avg(posts.map((m) => metricValue(m, 'reach'))),
    avgPostER: avg(posts.map((m) => engagementRate(m))),
    viewsByType: breakdownTotals(days, fromKey, toKey, 'viewsByType'),
  };
}

/**
 * Numbers for a monthly report: the month, the month before it and its top posts. Posts deleted from
 * Instagram (deletedAt) still count in the totals but are not listed among the top posts.
 * @param {{days: object, media: object|Array, stories?: object|Array, month: string, tz?: string, topCount?: number}} args
 * @returns {{month, summary, previous, top: object[]}}
 */
export function buildMonthlyReport({ days, media, stories, month, tz = 'UTC', topCount = 5 }) {
  const summary = monthNumbers(days, media, stories, month, tz);
  const previous = monthNumbers(days, media, stories, previousMonth(month), tz);
  const inMonth = mediaInRange(media, summary.fromKey, summary.toKey, tz).filter((m) => m.productType !== 'STORY' && !m.deletedAt);
  return { month, summary, previous, top: topMedia(inMonth, 'interactions', topCount).map(mediaLite) };
}

/**
 * How much of a month a report's numbers cover: {saved, total, complete}. `complete` when at least
 * MONTH_COMPLETE_SHARE of its days have account numbers. Older stored reports lack daysInMonth and
 * daysSaved: the month's length and daysWithData stand in.
 * @param {object} numbers report.summary or report.previous
 * @param {string} [month] 'YYYY-MM'
 */
export function monthCoverage(numbers, month) {
  const n = numbers || {};
  const total = isNum(n.daysInMonth) ? n.daysInMonth : month ? dayRange(monthBounds(month).fromKey, monthBounds(month).toKey).length : null;
  const saved = isNum(n.daysSaved) ? n.daysSaved : isNum(n.daysWithData) ? n.daysWithData : null;
  return { saved, total, complete: saved != null && total != null && saved >= Math.ceil(total * MONTH_COMPLETE_SHARE) };
}

/** Can a report's month be compared with the month before (both have most of their days saved)? */
export function reportComparable(report) {
  if (!report || !report.month) return false;
  return monthCoverage(report.summary, report.month).complete && monthCoverage(report.previous, previousMonth(report.month)).complete;
}

/**
 * One-line headline for a report ("Reach 12.3K (+8%) · 14 posts · +120 followers"). The change is
 * left out when either month is incomplete, and an incomplete month says how many days it covers.
 */
export function reportHeadline(report) {
  const s = (report && report.summary) || {};
  const p = (report && report.previous) || {};
  const parts = [];
  if (isNum(s.reach)) {
    const d = reportComparable(report) && isNum(p.reach) && p.reach > 0 ? (s.reach - p.reach) / p.reach : null;
    parts.push(`Reach ${formatNumber(s.reach, { compact: true })}${d != null ? ` (${formatDelta(d, 0)})` : ''}`);
  } else if (isNum(s.views)) parts.push(`Views ${formatNumber(s.views, { compact: true })}`);
  if (isNum(s.posts)) parts.push(`${s.posts} ${s.posts === 1 ? 'post' : 'posts'}`);
  if (isNum(s.followerGrowth)) {
    const g = s.followerGrowth;
    parts.push(g === 0 ? 'no follower change' : `${g > 0 ? '+' : '−'}${formatNumber(Math.abs(g))} followers`);
  }
  const cov = monthCoverage(s, report && report.month);
  if (!cov.complete && cov.saved != null && cov.total != null) parts.push(`${cov.saved} of ${cov.total} days saved`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Formatting

const DASH = '—';

/** 12,345 or 12.3K with { compact: true }. null/NaN -> '—'. */
export function formatNumber(n, { compact = false, digits, locale } = {}) {
  if (!isNum(n)) return DASH;
  const opts = compact
    ? { notation: 'compact', maximumFractionDigits: digits ?? 1 }
    : { maximumFractionDigits: digits ?? (Number.isInteger(n) ? 0 : 2) };
  return new Intl.NumberFormat(locale, opts).format(n);
}

/** 0.0345 -> '3.5%'. null -> '—'. */
export function formatPercent(fraction, digits = 1) {
  if (!isNum(fraction)) return DASH;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 0.12 -> '+12.0%', -0.04 -> '−4.0%' (Unicode minus), null -> '—'. */
export function formatDelta(fraction, digits = 1) {
  if (!isNum(fraction)) return DASH;
  const abs = (Math.abs(fraction) * 100).toFixed(digits);
  if (Number(abs) === 0) return `${(0).toFixed(digits)}%`;
  return `${fraction > 0 ? '+' : '−'}${abs}%`;
}

/** 5300 -> '5.3s', 245000 -> '4m 05s', 11520000 -> '3h 12m', 190800000 -> '2d 5h'. null -> '—'. */
export function formatDuration(ms) {
  if (!isNum(ms) || ms < 0) return DASH;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? Number(s.toFixed(1)) : Math.round(s)}s`;
  }
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, '0')}s`;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 24 * 60) return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
  const totalHours = Math.round(ms / 3_600_000);
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

// ---------------------------------------------------------------------------
// CSV

function csvCell(value) {
  if (value == null) return '';
  let s;
  if (value instanceof Date) s = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else if (Array.isArray(value)) s = value.map((v) => (v == null ? '' : String(v))).join(', ');
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  // Spreadsheet formula injection guard: text cells only (real numbers like -5 stay numbers).
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * RFC 4180 CSV with CRLF line endings and a header row.
 * @param {object[]} rows
 * @param {Array<{key: string, label?: string, value?: (row) => any}>} columns
 * @param {object} [opts] { bom?: boolean } prepend a UTF-8 byte order mark (helps Excel)
 * @returns {string}
 */
export function toCsv(rows, columns, { bom = false } = {}) {
  const cols = columns || [];
  const lines = [cols.map((c) => csvCell(c.label ?? c.key)).join(',')];
  for (const row of rows || []) {
    lines.push(cols.map((c) => csvCell(typeof c.value === 'function' ? c.value(row) : row?.[c.key])).join(','));
  }
  return (bom ? '﻿' : '') + lines.join('\r\n');
}

