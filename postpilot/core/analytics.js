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

