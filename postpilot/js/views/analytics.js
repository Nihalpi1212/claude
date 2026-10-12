// Analytics: Overview, Posts, Reels, Stories, Audience, Best times, Hashtags.
//
// Numbers come from the worker's encrypted snapshots (analytics-daily, analytics-media,
// analytics-stories, audience). When the worker has fewer than 3 days of snapshots for the chosen
// range (or a short range has gaps), the missing days are loaded live from Instagram with
// ig.accountDaily (at most 31 days, within Instagram's 90-day window) and labelled as such.
// Several pieces are exported for the Reports screen (useAnalytics, computeOverview, sections, CSV).

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { mutate, useDocs } from '../data.js';
import { saveBlob } from '../media.js';
import { setQuery } from '../router.js';
import { BarChart, Donut, Heatmap, LineChart, StackedBar } from '../ui/charts.js';
import { Badge, Button, Callout, DataTable, Drawer, EmptyState, Icon, Menu, PageHeader, Panel, ProgressBar, Segmented, Skeleton, Spinner, Stat, Tabs, cx, formatValue } from '../ui/kit.js';
import { RangePicker, formatRangeLabel, previousRange, rangeFromQuery, rangeLength, rangeToQuery, resolveRange, shortDay } from '../ui/range-picker.js';
import {
  comparePeriods,
  engagementRate,
  formatDuration,
  formatPercent,
  hashtagPerformance,
  interactionsOf,
  mediaInRange,
  metricValue,
  parseTimestamp,
  postingFrequency,
  seriesFor,
  toCsv,
  toList,
  topMedia,
} from '../../core/analytics.js';
import { bestTimeMatrix } from '../../core/schedule.js';
import { addDaysKey, dayKey, dayRange, format, relative, weekdayOfKey, WEEKDAY_NAMES, zonedToUtc } from '../../core/time.js';

loadViewCss('analytics');

const MIN_DAYS = 3; // fewer stored days than this -> load the range live
const MAX_LIVE_DAYS = 31; // longest span loaded live in one go
const HISTORY_DAYS = 89; // Instagram keeps account insights for about 90 days
const LIVE_TTL_MS = 20 * 60e3;
const DOCS = ['analytics-daily', 'analytics-media', 'analytics-stories', 'audience', 'competitors'];

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'posts', label: 'Posts' },
  { id: 'reels', label: 'Reels' },
  { id: 'stories', label: 'Stories' },
  { id: 'audience', label: 'Audience' },
  { id: 'best-times', label: 'Best times' },
  { id: 'hashtags', label: 'Hashtags' },
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
const sum = (vals) => {
  const v = vals.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};
const avg = (vals) => {
  const v = vals.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const rel = (c, p) => (isNum(c) && isNum(p) && p !== 0 ? (c - p) / Math.abs(p) : null);
const roundOrNull = (v) => (isNum(v) ? Math.round(v) : null);
const firstNum = (arr) => arr.find(isNum) ?? null;
const lastNum = (arr) => {
  for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i])) return arr[i];
  return null;
};
const signed = (n) => (isNum(n) ? `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatValue(Math.abs(n))}` : '—');
const fmtCount = (n) => (isNum(n) && Math.abs(n) >= 100000 ? 'compact' : 'number');
/** Format for tables/tiles: 'percent' always shows one decimal (8.0%, not 8%). */
const show = (v, kind = 'number') => (kind === 'percent' ? formatPercent(v) : formatValue(v, kind));

function hasFlow(snap) {
  return !!snap && typeof snap === 'object' && (isNum(snap.reach) || isNum(snap.views) || isNum(snap.totalInteractions) || isNum(snap.accountsEngaged));
}

// ---------------------------------------------------------------------------
// Media helpers

/** photo | carousel | reel | video | story */
export function mediaKindOf(m) {
  if (!m) return 'photo';
  if (m.productType === 'STORY') return 'story';
  if (m.productType === 'REELS' || (m.mediaType === 'VIDEO' && m.productType !== 'FEED')) return 'reel';
  if (m.mediaType === 'CAROUSEL_ALBUM') return 'carousel';
  if (m.mediaType === 'VIDEO') return 'video';
  return 'photo';
}

export const KIND_LABEL = { photo: 'Photo', carousel: 'Carousel', reel: 'Reel', video: 'Video', story: 'Story' };
const KIND_PLURAL = { photo: 'Photos', carousel: 'Carousels', reel: 'Reels', video: 'Videos' };
// Color follows the entity (post type), never its rank.
const KIND_COLOR = { photo: 'var(--series-1)', carousel: 'var(--series-2)', reel: 'var(--series-3)', video: 'var(--series-4)' };

/** Skip rate as a fraction (Instagram reports a percentage). */
function skipRateOf(m) {
  const v = num(m?.metrics?.skipRate);
  if (v == null) return null;
  return v > 1 ? v / 100 : v;
}

export function captionLine(text, max = 140) {
  const first = String(text || '').split(/\n/).find((l) => l.trim() && !/^[.\s]*$/.test(l)) || '';
  const clean = first.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function previewOf(m) {
  return m.thumbnailUrl || (m.mediaType === 'VIDEO' ? null : m.mediaUrl) || null;
}

export function shortDateTime(iso, tz) {
  const t = parseTimestamp(iso);
  return Number.isFinite(t) ? format(new Date(t), tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

function shortDate(iso, tz) {
  const t = parseTimestamp(iso);
  return Number.isFinite(t) ? format(new Date(t), tz, { month: 'short', day: 'numeric' }) : '—';
}

/** Media thumbnail with a quiet placeholder when the (expiring) Instagram URL fails. */
export function Thumb({ src, alt = '', size = 40, ratio = '1 / 1', kind, eager = false, class: cls }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return html`<span class=${cx('an-thumb', cls)} style=${{ width: size ? `${size}px` : undefined, aspectRatio: ratio }}>
    ${src && !failed
      ? html`<img src=${src} alt=${alt} loading=${eager ? 'eager' : 'lazy'} decoding="async" referrerpolicy="no-referrer" onError=${() => setFailed(true)} />`
      : html`<${Icon} name=${kind === 'reel' ? 'reel' : kind === 'story' ? 'story' : 'image'} size=${size && size < 48 ? 15 : 22} />`}
  </span>`;
}

// ---------------------------------------------------------------------------
// Followers (stock metric) reconstruction

/**
 * Daily follower totals for a range. Days the worker captured keep their value; the others are
 * estimated from the nearest captured total and the daily follows/unfollows in between. A day
 * whose path to a captured total crosses a day without follow data stays null (unknown).
 * @returns {{labels: string[], values: (number|null)[], estimated: boolean}}
 */
export function followerSeries(days, fromKey, toKey) {
  const labels = fromKey <= toKey ? dayRange(fromKey, toKey) : [];
  const anchors = Object.keys(days || {}).filter((k) => isNum(days[k]?.followers)).sort();
  if (!anchors.length) return { labels, values: labels.map(() => null), estimated: false };
  const netOf = (k) => {
    const d = days[k];
    const g = num(d?.followsGained);
    const u = num(d?.unfollows);
    return g == null && u == null ? null : (g ?? 0) - (u ?? 0);
  };
  let estimated = false;
  const values = labels.map((k) => {
    if (isNum(days[k]?.followers)) return days[k].followers;
    const next = anchors.find((a) => a > k);
    if (next) {
      let v = days[next].followers;
      for (let j = next; j > k; j = addDaysKey(j, -1)) {
        const n = netOf(j);
        if (n == null) {
          if (j === next) continue; // the anchor day itself is still in progress
          return null;
        }
        v -= n;
      }
      estimated = true;
      return v;
    }
    const prev = anchors[anchors.length - 1];
    let v = days[prev].followers;
    for (let j = addDaysKey(prev, 1); j <= k; j = addDaysKey(j, 1)) {
      const n = netOf(j);
      if (n == null) return null;
      v += n;
    }
    estimated = true;
    return v;
  });
  return { labels, values, estimated };
}

// ---------------------------------------------------------------------------
// Live fallback

const liveCache = new Map(); // key -> { at, promise }

function fetchLive(ig, { fromKey, toKey }, tz) {
  const key = `${ig.userId}|${tz}|${fromKey}|${toKey}`;
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.promise;
  const promise = Promise.all([ig.accountDaily({ sinceKey: fromKey, untilKey: toKey, tz }), ig.me().catch(() => null)]).then(([days, me]) => ({ days: days || {}, me }));
  liveCache.set(key, { at: Date.now(), promise });
  promise.catch(() => liveCache.delete(key));
  return promise;
}

function clampWindow(fromKey, toKey, today) {
  const to = toKey < today ? toKey : today;
  let from = fromKey;
  const floor = addDaysKey(today, -HISTORY_DAYS);
  if (from < floor) from = floor;
  const cap = addDaysKey(to, -(MAX_LIVE_DAYS - 1));
  if (from < cap) from = cap;
  return from <= to ? { fromKey: from, toKey: to, days: rangeLength(from, to) } : null;
}

/**
 * Which days of a range must be loaded live, or null.
 * - fewer than MIN_DAYS stored days: the range (its last 31 days, within Instagram's 90 days)
 * - a short range (<= 31 days) with gaps: the span covering the gaps
 */
function liveNeed(stored, r, today, { allowGaps }) {
  const end = r.toKey < today ? r.toKey : addDaysKey(today, -1); // today is never complete
  const keys = r.fromKey <= end ? dayRange(r.fromKey, end) : [];
  const missing = keys.filter((k) => !hasFlow(stored[k]));
  const have = keys.length - missing.length;
  if (have < MIN_DAYS) {
    const win = clampWindow(r.fromKey, r.toKey, today);
    return win ? { ...win, mode: 'range', have } : null;
  }
  if (!missing.length || !allowGaps || r.days > MAX_LIVE_DAYS) return null;
  const win = clampWindow(missing[0], missing[missing.length - 1], today);
  return win ? { ...win, mode: 'gaps', have } : null;
}

const hasFollowData = (d) => !!d && (isNum(d.followers) || isNum(d.followsGained) || isNum(d.unfollows));

/**
 * Follower totals are reconstructed backwards from the latest captured total, so a range that
 * ends before the stored history needs the days in between too. Returns that "bridge" window
 * (range end + 1 .. day before the first stored follow data, or today), or null.
 */
function bridgeNeed(stored, r, today) {
  const start = addDaysKey(r.toKey, 1);
  if (start >= today) return null;
  const next = Object.keys(stored).filter((k) => k >= start && hasFollowData(stored[k])).sort()[0] || today;
  const end = addDaysKey(next, -1);
  if (end < start) return null;
  const win = clampWindow(start, end, today);
  return win && win.fromKey === start ? { ...win, mode: 'bridge' } : null;
}

function coverage(stored, r, today) {
  const end = r.toKey < today ? r.toKey : addDaysKey(today, -1);
  const keys = r.fromKey <= end ? dayRange(r.fromKey, end) : [];
  return { have: keys.filter((k) => hasFlow(stored[k])).length, total: keys.length };
}

/**
 * Analytics data for a range: stored snapshots merged with live days when needed.
 * @returns {{ready, error, range, prev, today, days, media, mediaDoc, storiesDoc, audience, competitors,
 *   followers, live: {current, previous}, coverage, freshness}}
 */
export function useAnalytics(range, { compare = true } = {}) {
  const { ig, tz } = useApp();
  const docs = useDocs(DOCS);
  const daily = docs.data['analytics-daily'];
  const ready = !!daily && !!docs.data['analytics-media'];
  const stored = (daily && daily.days) || {};
  const today = range.today || dayKey(new Date(), tz);
  const prev = useMemo(() => previousRange(range.fromKey, range.toKey), [range.fromKey, range.toKey]);

  const curNeed = ready ? liveNeed(stored, range, today, { allowGaps: true }) : null;
  const prevNeed = ready && compare && prev.days <= MAX_LIVE_DAYS ? liveNeed(stored, { ...prev, today }, today, { allowGaps: true }) : null;
  const bridge = curNeed ? bridgeNeed(stored, range, today) : null;
  const curKey = curNeed ? `${curNeed.fromKey}|${curNeed.toKey}` : '';
  const prevKey = prevNeed ? `${prevNeed.fromKey}|${prevNeed.toKey}` : '';
  const bridgeKey = bridge ? `${bridge.fromKey}|${bridge.toKey}` : '';

  const [live, setLive] = useState({});
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);
  useEffect(() => {
    if (!ig) return;
    for (const need of [curNeed, prevNeed, bridge]) {
      if (!need) continue;
      const k = `${need.fromKey}|${need.toKey}`;
      if (live[k] && live[k].status !== 'error') continue;
      setLive((s) => ({ ...s, [k]: { status: 'loading' } }));
      fetchLive(ig, need, tz).then(
        (res) => alive.current && setLive((s) => ({ ...s, [k]: { status: 'done', ...res } })),
        (error) => alive.current && setLive((s) => ({ ...s, [k]: { status: 'error', error } })),
      );
    }
  }, [ig, tz, curKey, prevKey, bridgeKey]);

  const curLive = curKey ? live[curKey] || { status: ig ? 'loading' : 'unavailable' } : null;
  const prevLive = prevKey ? live[prevKey] || { status: ig ? 'loading' : 'unavailable' } : null;
  const bridgeLive = bridgeKey ? live[bridgeKey] || null : null;

  const days = useMemo(() => {
    const out = {};
    for (const src of [bridgeLive, prevLive, curLive]) {
      if (src && src.status === 'done') for (const [k, v] of Object.entries(src.days || {})) out[k] = { ...v, _live: true };
    }
    for (const [k, v] of Object.entries(stored)) {
      if (!v || typeof v !== 'object') continue;
      out[k] = hasFlow(v) || !out[k] ? { ...v } : { ...out[k], ...v };
    }
    const me = (curLive && curLive.me) || (prevLive && prevLive.me);
    if (me && isNum(me.followersCount) && !Object.values(out).some((d) => isNum(d.followers))) {
      out[today] = { ...(out[today] || {}), followers: me.followersCount };
    }
    return out;
  }, [stored, curLive, prevLive, bridgeLive, today]);

  const media = useMemo(() => toList(docs.data['analytics-media']?.media), [docs.data['analytics-media']]);
  const followers = useMemo(() => {
    const keys = Object.keys(days).filter((k) => isNum(days[k].followers)).sort();
    return keys.length ? days[keys[keys.length - 1]].followers : null;
  }, [days]);

  const freshness = useMemo(() => {
    const times = [daily?.lastAttemptAt, docs.data['analytics-media']?.updatedAt].map((t) => Date.parse(t || '')).filter(Number.isFinite);
    if (!times.length) {
      for (const d of Object.values(stored)) {
        const t = Date.parse(d?.capturedAt || '');
        if (Number.isFinite(t)) times.push(t);
      }
    }
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  }, [daily, docs.data['analytics-media']]);

  return {
    ready,
    error: docs.error,
    range,
    prev,
    today,
    days,
    media,
    mediaDoc: docs.data['analytics-media'],
    storiesDoc: docs.data['analytics-stories'],
    audience: docs.data.audience,
    competitors: docs.data.competitors,
    followers,
    live: { current: curNeed && { ...curNeed, ...curLive }, previous: prevNeed && { ...prevNeed, ...prevLive } },
    coverage: coverage(stored, range, today),
    freshness,
  };
}

// ---------------------------------------------------------------------------
// Overview math

/** Everything the Overview (and the report summary) shows, computed once per data change. */
export function computeOverview(a, tz, { compare = true } = {}) {
  const { days, range, prev, media } = a;
  const { current: cur, previous: pre } = comparePeriods(days, range.fromKey, range.toKey);
  const fol = followerSeries(days, addDaysKey(range.fromKey, -1), range.toKey);
  const folValues = fol.values.slice(1);
  const folStart = firstNum(fol.values);
  const folEnd = lastNum(folValues);
  const growth = folStart != null && folEnd != null ? folEnd - folStart : null;
  const pfol = followerSeries(days, addDaysKey(prev.fromKey, -1), prev.toKey);
  const pStart = firstNum(pfol.values);
  const pEnd = lastNum(pfol.values);
  const prevGrowth = pStart != null && pEnd != null && pfol.values.filter(isNum).length > 1 ? pEnd - pStart : null;

  const posts = mediaInRange(media, range.fromKey, range.toKey, tz).filter((m) => m.productType !== 'STORY');
  const prevPosts = mediaInRange(media, prev.fromKey, prev.toKey, tz).filter((m) => m.productType !== 'STORY');
  const interactions = interactionsOf(cur);
  const prevInteractions = interactionsOf(pre);
  const er = interactions != null && cur.reach > 0 ? interactions / cur.reach : null;
  const prevEr = prevInteractions != null && pre.reach > 0 ? prevInteractions / pre.reach : null;
  const labels = dayRange(range.fromKey, range.toKey);
  const s = (metric) => seriesFor(days, metric, range.fromKey, range.toKey, { forwardFill: false }).values;
  const interactionSeries = labels.map((k) => (days[k] ? interactionsOf(days[k]) : null));
  const erSeries = labels.map((k) => {
    const d = days[k];
    const i = d ? interactionsOf(d) : null;
    return i != null && d.reach > 0 ? i / d.reach : null;
  });
  const has = (pv) => compare && isNum(pv);
  const prevLoading = compare && a.live && a.live.previous && a.live.previous.status === 'loading';
  const missingLabel = prevLoading ? 'Loading the previous period…' : 'No data for the previous period';

  const tiles = [
    {
      key: 'followers',
      label: 'Followers',
      value: folEnd,
      format: fmtCount(folEnd),
      delta: growth != null && folStart > 0 ? growth / folStart : undefined,
      deltaLabel: growth != null ? `${signed(growth)} this period${compare && prevGrowth != null ? ` (${signed(prevGrowth)} before)` : ''}` : 'No follower history yet',
      spark: folValues,
    },
    { key: 'reach', label: 'Reach', value: cur.reach, prev: pre.reach, spark: s('reach') },
    { key: 'views', label: 'Views', value: cur.views, prev: pre.views, spark: s('views') },
    { key: 'interactions', label: 'Interactions', value: interactions, prev: prevInteractions, spark: interactionSeries },
    { key: 'er', label: 'Engagement rate', value: er, prev: prevEr, format: 'percent', spark: erSeries, hint: null },
    { key: 'engaged', label: 'Accounts engaged', value: cur.accountsEngaged, prev: pre.accountsEngaged, spark: s('accountsEngaged') },
    { key: 'linkTaps', label: 'Profile link taps', value: cur.profileLinksTaps, prev: pre.profileLinksTaps, spark: s('profileLinksTaps') },
    { key: 'posts', label: 'Posts published', value: posts.length, prev: prevPosts.length },
  ].map((t) => {
    if (t.key === 'followers') return t;
    const d = compare ? rel(t.value, t.prev) : undefined;
    return {
      ...t,
      value: t.format === 'percent' ? (isNum(t.value) ? formatPercent(t.value) : null) : t.value,
      format: t.format === 'percent' ? undefined : fmtCount(t.value),
      delta: compare ? d : undefined,
      deltaLabel: compare ? (has(t.prev) ? `vs ${show(t.prev, t.format === 'percent' ? 'percent' : 'number')} before` : missingLabel) : undefined,
    };
  });

  const byKind = {};
  for (const m of posts) {
    const k = mediaKindOf(m);
    (byKind[k] ||= []).push(m);
  }
  const kinds = ['photo', 'carousel', 'reel', 'video'].filter((k) => byKind[k]);
  const typeRows = kinds.map((k) => ({
    kind: k,
    count: byKind[k].length,
    avgReach: avg(byKind[k].map((m) => metricValue(m, 'reach'))),
    avgEr: avg(byKind[k].map((m) => engagementRate(m))),
    avgInteractions: avg(byKind[k].map((m) => interactionsOf(m))),
  }));

  return {
    labels,
    xLabels: labels.map(shortDay),
    current: cur,
    previous: pre,
    followers: { values: folValues, start: folStart, end: folEnd, growth, prevGrowth, estimated: fol.estimated },
    reach: s('reach'),
    views: s('views'),
    interactionSeries,
    interactions,
    prevInteractions,
    er,
    prevEr,
    breakdown: [
      { label: 'Likes', value: cur.likes },
      { label: 'Comments', value: cur.comments },
      { label: 'Shares', value: cur.shares },
      { label: 'Saves', value: cur.saves },
    ],
    posts,
    prevPosts,
    perWeek: postingFrequency(posts, range.fromKey, range.toKey, tz),
    prevPerWeek: postingFrequency(prevPosts, prev.fromKey, prev.toKey, tz),
    typeRows,
    top: topMedia(posts, 'interactions', 3),
    tiles,
  };
}

// ---------------------------------------------------------------------------
// CSV

function csvDownload(rows, columns, filename) {
  const csv = toCsv(rows, columns, { bom: true });
  saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
}

/** Daily metrics for the range (followers estimated where not captured). */
export function exportDailyCsv(a) {
  const { days, range } = a;
  const fol = followerSeries(days, range.fromKey, range.toKey);
  const rows = dayRange(range.fromKey, range.toKey).map((k, i) => {
    const d = days[k] || {};
    return { date: k, followers: fol.values[i], ...d, interactions: hasFlow(d) ? interactionsOf(d) : null, source: hasFlow(d) ? (d._live ? 'Instagram (live)' : 'Postpilot worker') : '' };
  });
  const cols = [
    { key: 'date', label: 'Date' },
    { key: 'followers', label: 'Followers' },
    { key: 'followsGained', label: 'New follows' },
    { key: 'unfollows', label: 'Unfollows' },
    { key: 'reach', label: 'Reach' },
    { key: 'views', label: 'Views' },
    { key: 'accountsEngaged', label: 'Accounts engaged' },
    { key: 'interactions', label: 'Interactions' },
    { key: 'likes', label: 'Likes' },
    { key: 'comments', label: 'Comments' },
    { key: 'shares', label: 'Shares' },
    { key: 'saves', label: 'Saves' },
    { key: 'replies', label: 'Replies' },
    { key: 'profileLinksTaps', label: 'Profile link taps' },
    { key: 'source', label: 'Source' },
  ];
  csvDownload(rows, cols, `postpilot-daily-${range.fromKey}_${range.toKey}.csv`);
  return rows.length;
}

/** Posts published in the range with their latest metrics. */
export function exportPostsCsv(a, tz) {
  const { range, media } = a;
  const list = mediaInRange(media, range.fromKey, range.toKey, tz);
  const t = (m) => new Date(parseTimestamp(m.timestamp));
  const cols = [
    { key: 'date', label: 'Date', value: (m) => dayKey(t(m), tz) },
    { key: 'time', label: 'Time', value: (m) => format(t(m), tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) },
    { key: 'type', label: 'Type', value: (m) => KIND_LABEL[mediaKindOf(m)] },
    { key: 'caption', label: 'Caption' },
    { key: 'permalink', label: 'Link' },
    { key: 'reach', label: 'Reach', value: (m) => metricValue(m, 'reach') },
    { key: 'views', label: 'Views', value: (m) => metricValue(m, 'views') },
    { key: 'likes', label: 'Likes', value: (m) => metricValue(m, 'likes') },
    { key: 'comments', label: 'Comments', value: (m) => metricValue(m, 'comments') },
    { key: 'saves', label: 'Saves', value: (m) => metricValue(m, 'saves') },
    { key: 'shares', label: 'Shares', value: (m) => metricValue(m, 'shares') },
    { key: 'interactions', label: 'Interactions', value: (m) => interactionsOf(m) },
    { key: 'er', label: 'Engagement rate (%)', value: (m) => (engagementRate(m) == null ? null : Math.round(engagementRate(m) * 10000) / 100) },
    { key: 'watch', label: 'Avg watch time (s)', value: (m) => (isNum(m.metrics?.avgWatchTimeMs) ? Math.round(m.metrics.avgWatchTimeMs / 100) / 10 : null) },
    { key: 'skip', label: 'Skip rate (%)', value: (m) => (skipRateOf(m) == null ? null : Math.round(skipRateOf(m) * 1000) / 10) },
  ];
  csvDownload(list, cols, `postpilot-posts-${range.fromKey}_${range.toKey}.csv`);
  return list.length;
}

// ---------------------------------------------------------------------------
// Overview sections (shared with Reports)

export function OverviewStats({ ov, loading = false, class: cls }) {
  return html`<div class=${cx('stats an-stats', cls)}>
    ${ov.tiles.map(
      (t) => html`<${Stat} key=${t.key} label=${t.label} value=${t.value ?? '—'} format=${t.format} delta=${t.delta} deltaLabel=${t.deltaLabel}
        sparkline=${t.spark && t.spark.filter(isNum).length > 1 ? t.spark : undefined} loading=${loading} />`,
    )}
  </div>`;
}

export function FollowersChart({ ov, height = 220 }) {
  const f = ov.followers;
  return html`<${Panel} title="Followers" subtitle=${f.estimated ? 'Daily total, estimated from follows and unfollows between snapshots' : 'Daily total'}>
    <${LineChart} label="Followers per day" area=${false} height=${height} xLabels=${ov.xLabels}
      series=${[{ name: 'Followers', values: f.values }]} emptyText="No follower history for this range yet" />
  <//>`;
}

export function ReachViewsChart({ ov, height = 220 }) {
  return html`<${Panel} title="Reach and views" subtitle="Accounts reached and times your content was seen, per day">
    <${LineChart} label="Reach and views per day" height=${height} xLabels=${ov.xLabels}
      series=${[{ name: 'Views', values: ov.views }, { name: 'Reach', values: ov.reach }]} emptyText="No reach data for this range yet" />
  <//>`;
}

export function InteractionsChart({ ov, trend = true }) {
  const sub = ov.interactions != null ? `${formatValue(ov.interactions)} interactions · ${formatPercent(ov.er)} engagement rate` : 'Likes, comments, shares and saves';
  return html`<${Panel} title="Interactions" subtitle=${sub}>
    <${BarChart} horizontal label="Interactions by type" data=${ov.breakdown} emptyText="No interactions in this range" />
    ${trend && ov.interactionSeries.filter(isNum).length > 1
      ? html`<div class="an-subchart">
          <h3 class="an-subchart-title">Per day</h3>
          <${LineChart} label="Interactions per day" height=${132} xLabels=${ov.xLabels} series=${[{ name: 'Interactions', values: ov.interactionSeries }]} />
        </div>`
      : null}
    <p class="an-note">Engagement rate is interactions divided by reach.</p>
  <//>`;
}

export function PostingFrequency({ ov, compare = true }) {
  const segs = ov.typeRows.map((r) => ({ label: KIND_PLURAL[r.kind], value: r.count, color: KIND_COLOR[r.kind] }));
  return html`<${Panel} title="Posting frequency" subtitle="Feed posts and reels published in this period">
    ${ov.posts.length
      ? html`<div class="stack an-freq">
          <div class="an-figure">
            <span class="an-figure-value">${formatValue(Math.round(ov.perWeek * 10) / 10)}</span>
            <span class="an-figure-unit">posts per week</span>
            ${compare && ov.prevPosts.length ? html`<span class="an-figure-compare">vs ${formatValue(Math.round(ov.prevPerWeek * 10) / 10)} before</span>` : null}
          </div>
          <${StackedBar} label="Posts by type" segments=${segs} />
          <div class="table-wrap">
            <table class="table table-dense an-mini-table">
              <thead><tr><th scope="col">Type</th><th scope="col" class="align-right">Posts</th><th scope="col" class="align-right an-col-reach">Avg reach</th><th scope="col" class="align-right">Eng. rate</th></tr></thead>
              <tbody>
                ${ov.typeRows.map(
                  (r) => html`<tr key=${r.kind}>
                    <td><span class="legend-key is-rect an-key" style=${{ '--key': KIND_COLOR[r.kind] }}></span>${KIND_PLURAL[r.kind]}</td>
                    <td class="align-right">${r.count}</td>
                    <td class="align-right an-col-reach">${formatValue(r.avgReach == null ? null : Math.round(r.avgReach))}</td>
                    <td class="align-right">${formatPercent(r.avgEr)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>
        </div>`
      : html`<${EmptyState} compact icon="calendar" title="No posts in this period" body="Posts you publish show up here with their reach and engagement." />`}
  <//>`;
}

export function TopPosts({ ov, tz, onOpen, title = 'Top posts', count = 3 }) {
  const list = ov.top.slice(0, count);
  return html`<${Panel} title=${title} subtitle="Most interactions in this period">
    ${list.length
      ? html`<div class="an-top">
          ${list.map((m, i) => {
            const kind = mediaKindOf(m);
            const body = html`
              <span class="an-top-rank mono" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
              <${Thumb} src=${previewOf(m)} size=${null} ratio="4 / 5" kind=${kind} class="an-top-thumb" eager />
              <span class="an-top-meta">
                <span class="row row-between"><span class="muted text-sm">${shortDateTime(m.timestamp, tz)}</span><${Badge} tone="outline">${KIND_LABEL[kind]}<//></span>
                <span class="an-top-caption clamp-2">${captionLine(m.caption) || 'No caption'}</span>
                <span class="an-top-nums">
                  <span><strong class="num">${formatValue(interactionsOf(m))}</strong> interactions</span>
                  <span><strong class="num">${formatValue(metricValue(m, 'reach'))}</strong> reach</span>
                  <span><strong class="num">${formatPercent(engagementRate(m))}</strong> eng.</span>
                </span>
              </span>`;
            return onOpen
              ? html`<button type="button" key=${m.id} class="an-top-card" onClick=${() => onOpen(m)} aria-label=${`Post ${i + 1}: ${captionLine(m.caption, 60) || KIND_LABEL[kind]}`}>${body}</button>`
              : html`<div key=${m.id} class="an-top-card">${body}</div>`;
          })}
        </div>`
      : html`<${EmptyState} compact icon="trophy" title="No post stats in this period" body="The worker saves stats for your recent posts every day." />`}
  <//>`;
}

// ---------------------------------------------------------------------------
// Status line: freshness + live labels

function SourceNotes({ a, ig }) {
  const cur = a.live.current;
  const prev = a.live.previous;
  const out = [];
  if (cur) {
    if (cur.status === 'loading') out.push(html`<${Badge} tone="info" key="cl"><${Spinner} size=${11} label="" /> Loading from Instagram…<//>`);
    else if (cur.status === 'done') out.push(html`<${Badge} tone="info" icon="instagram-outline" key="cd" title=${`Live from Instagram: ${formatRangeLabel(cur.fromKey, cur.toKey)}`}>${cur.mode === 'gaps' ? 'Gaps filled live from Instagram' : 'Live from Instagram'}<//>`);
  }
  if (prev && prev.status === 'done') out.push(html`<span class="muted text-sm" key="pd">Previous period loaded live from Instagram</span>`);
  return out.length ? html`<span class="row an-source">${out}</span>` : null;
}

function LiveProblems({ a, ig }) {
  const cur = a.live.current;
  if (!cur) {
    if (a.coverage.total && a.coverage.have < a.coverage.total && a.coverage.have >= MIN_DAYS) {
      return html`<p class="an-note">Daily stats cover ${a.coverage.have} of ${a.coverage.total} complete days in this range. Postpilot keeps every day from when the worker started; Instagram only keeps the last 90 days.</p>`;
    }
    return null;
  }
  if (cur.status === 'unavailable' || !ig) {
    return html`<${Callout} tone="warning" title="Not enough saved data for this range"
      action=${html`<${Button} size="sm" variant="secondary" href="#/settings?section=instagram">Open Settings<//>`}>
      The worker has saved fewer than ${MIN_DAYS} days here. Connect Instagram in Settings to load these days live.
    <//>`;
  }
  if (cur.status === 'error') {
    const msg = (cur.error && (cur.error.userMessage || cur.error.message)) || 'Instagram did not answer.';
    return html`<${Callout} tone="warning" title="Could not load these days from Instagram">${msg} Showing the days Postpilot has saved.<//>`;
  }
  if (cur.status === 'done' && cur.mode === 'range' && (cur.fromKey !== a.range.fromKey || cur.toKey !== a.range.toKey)) {
    return html`<p class="an-note">Instagram only shares daily stats for the last 90 days, at most 31 days at a time, so this view covers ${formatRangeLabel(cur.fromKey, cur.toKey)}.</p>`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Post details drawer

function MetricList({ m }) {
  const mt = m.metrics || {};
  const rows = [
    ['Reach', metricValue(m, 'reach')],
    ['Views', metricValue(m, 'views')],
    ['Likes', metricValue(m, 'likes')],
    ['Comments', metricValue(m, 'comments')],
    ['Saves', metricValue(m, 'saves')],
    ['Shares', metricValue(m, 'shares')],
    ['Reposts', num(mt.reposts)],
    ['Interactions', interactionsOf(m)],
    ['Engagement rate', engagementRate(m), 'percent'],
    ['Profile visits', num(mt.profileVisits)],
    ['Follows', num(mt.follows)],
    ['Avg watch time', num(mt.avgWatchTimeMs), 'ms'],
    ['Total watch time', num(mt.totalWatchTimeMs), 'ms'],
    ['Skip rate', skipRateOf(m), 'percent'],
  ].filter(([, v]) => v != null);
  if (!rows.length) return html`<p class="muted">Instagram has not reported stats for this post yet.</p>`;
  return html`<dl class="kv an-kv">
    ${rows.map(([label, v, kind]) => html`<dt>${label}</dt><dd class="num">${kind === 'ms' ? formatDuration(v) : show(v, kind || 'number')}</dd>`)}
  </dl>`;
}

export function PostDrawer({ media, onClose }) {
  const { ig, tz, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setError(null), [media && media.id]);
  if (!media) return html`<${Drawer} open=${false} onClose=${onClose} />`;
  const kind = mediaKindOf(media);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await ig.mediaInsights({ id: media.id, mediaType: media.mediaType, productType: media.productType });
      const at = new Date().toISOString();
      await mutate(
        'analytics-media',
        (d) => {
          const m = d.media && d.media[media.id];
          if (!m) return;
          m.metrics = { ...(m.metrics || {}), ...(fresh || {}) };
          m.fetchedAt = at;
        },
        { message: 'analytics: refresh one post' },
      );
      toast('Post stats updated from Instagram.', { kind: 'success' });
    } catch (err) {
      setError(err.userMessage || err.message || String(err));
    } finally {
      setBusy(false);
    }
  };
  return html`<${Drawer} open=${true} title="Post details" onClose=${onClose}
    footer=${html`
      ${media.permalink ? html`<${Button} variant="ghost" icon="external" href=${media.permalink} target="_blank" rel="noopener noreferrer">View on Instagram<//>` : null}
      <${Button} variant="secondary" icon="refresh" loading=${busy} disabled=${!ig} onClick=${refresh}>Refresh from Instagram<//>`}>
    <div class="stack an-drawer">
      <div class="an-drawer-head">
        <${Thumb} src=${previewOf(media)} size=${120} ratio="4 / 5" kind=${kind} eager />
        <div class="stack-sm stack">
          <div class="row"><${Badge} tone="outline">${KIND_LABEL[kind]}<//><span class="muted text-sm">${shortDateTime(media.timestamp, tz)}</span></div>
          <p class="pre-wrap an-drawer-caption">${media.caption || 'No caption'}</p>
        </div>
      </div>
      ${error ? html`<${Callout} tone="danger" title="Could not refresh this post">${error}<//>` : null}
      ${!ig ? html`<p class="an-note">Connect Instagram in Settings to refresh a post's stats live.</p>` : null}
      <h3 class="section-title">Stats</h3>
      <${MetricList} m=${media} />
      <p class="an-note">${media.fetchedAt ? `Updated ${relative(media.fetchedAt)}.` : 'Not refreshed yet.'} The worker refreshes new posts hourly and older ones daily or weekly.</p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Posts tab

function mediaColumns(tz, { reels = false } = {}) {
  const n = (key, label, getter, fmt = 'number') => ({
    key,
    label,
    align: 'right',
    sortable: true,
    sortValue: getter,
    render: (m) => html`<span class="num">${show(getter(m), fmt)}</span>`,
  });
  const base = [
    { key: 'thumb', label: '', width: 48, render: (m) => html`<${Thumb} src=${previewOf(m)} size=${36} kind=${mediaKindOf(m)} />` },
    {
      key: 'date',
      label: 'Date',
      sortable: true,
      sortValue: (m) => parseTimestamp(m.timestamp),
      defaultDir: 'desc',
      render: (m) => html`<span class="nowrap">${shortDateTime(m.timestamp, tz)}</span>`,
    },
  ];
  if (!reels) base.push({ key: 'type', label: 'Type', sortable: true, sortValue: (m) => KIND_LABEL[mediaKindOf(m)], render: (m) => html`<${Badge} tone="outline">${KIND_LABEL[mediaKindOf(m)]}<//>` });
  base.push({ key: 'caption', label: 'Caption', class: 'an-caption-cell', render: (m) => html`<span class="an-caption" title=${captionLine(m.caption, 300)}>${captionLine(m.caption, 90) || html`<span class="faint">No caption</span>`}</span>` });
  if (reels) {
    return [
      ...base,
      n('views', 'Views', (m) => metricValue(m, 'views')),
      n('reach', 'Reach', (m) => metricValue(m, 'reach')),
      { ...n('watch', 'Avg watch', (m) => num(m.metrics?.avgWatchTimeMs)), render: (m) => html`<span class="num">${formatDuration(num(m.metrics?.avgWatchTimeMs))}</span>` },
      n('skip', 'Skip rate', skipRateOf, 'percent'),
      n('likes', 'Likes', (m) => metricValue(m, 'likes')),
      n('comments', 'Comments', (m) => metricValue(m, 'comments')),
      n('shares', 'Shares', (m) => metricValue(m, 'shares')),
      n('saves', 'Saves', (m) => metricValue(m, 'saves')),
      n('er', 'Eng. rate', (m) => engagementRate(m), 'percent'),
    ];
  }
  return [
    ...base,
    n('reach', 'Reach', (m) => metricValue(m, 'reach')),
    n('views', 'Views', (m) => metricValue(m, 'views')),
    n('likes', 'Likes', (m) => metricValue(m, 'likes')),
    n('comments', 'Comments', (m) => metricValue(m, 'comments')),
    n('saves', 'Saves', (m) => metricValue(m, 'saves')),
    n('shares', 'Shares', (m) => metricValue(m, 'shares')),
    n('er', 'Eng. rate', (m) => engagementRate(m), 'percent'),
  ];
}

const POST_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'photo', label: 'Photos' },
  { value: 'carousel', label: 'Carousels' },
  { value: 'reel', label: 'Reels' },
];

function PostsTab({ a, ov, tz, onOpen }) {
  const [kind, setKind] = useState('all');
  const rows = useMemo(() => (kind === 'all' ? ov.posts : ov.posts.filter((m) => mediaKindOf(m) === kind || (kind === 'reel' && mediaKindOf(m) === 'video'))), [ov.posts, kind]);
  const cols = useMemo(() => mediaColumns(tz), [tz]);
  const avgEr = avg(rows.map((m) => engagementRate(m)));
  const avgReach = avg(rows.map((m) => metricValue(m, 'reach')));
  if (!a.media.length) {
    return html`<${EmptyState} icon="list" title="No post stats yet" body="The worker saves stats for your recent posts every day. Use Refresh now to run it." />`;
  }
  return html`<div class="stack">
    <div class="toolbar">
      <${Segmented} label="Post type" options=${POST_FILTERS} value=${kind} onChange=${setKind} size="sm" />
      <span class="spacer"></span>
      <span class="muted text-sm">${rows.length} ${rows.length === 1 ? 'post' : 'posts'} · avg reach <strong class="num an-ink">${formatValue(avgReach == null ? null : Math.round(avgReach))}</strong> · avg engagement <strong class="num an-ink">${formatPercent(avgEr)}</strong></span>
    </div>
    <${Panel} flush>
      <${DataTable} dense columns=${cols} rows=${rows} rowKey=${(m) => m.id} initialSort=${{ key: 'date', dir: 'desc' }} onRowClick=${onOpen} maxHeight=${620}
        caption="Posts in this period" empty=${html`<${EmptyState} compact icon="list" title="No posts of this type in this period" />`} />
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------
// Reels tab

export function reelsOf(ov) {
  return ov.posts.filter((m) => mediaKindOf(m) === 'reel');
}

export function ReelsSummary({ reels }) {
  return html`<div class="stats an-stats-4">
    <${Stat} label="Reels" value=${reels.length} />
    <${Stat} label="Avg views" value=${roundOrNull(avg(reels.map((m) => metricValue(m, 'views'))))} format="compact" />
    <${Stat} label="Avg watch time" value=${formatDuration(avg(reels.map((m) => num(m.metrics?.avgWatchTimeMs))))} />
    <${Stat} label="Avg skip rate" value=${formatPercent(avg(reels.map(skipRateOf)))} hint="Viewers who swiped away in the first 3 seconds" />
  </div>`;
}

export function ReelViewsChart({ reels, tz, height = 220 }) {
  const data = [...reels].sort((x, y) => parseTimestamp(x.timestamp) - parseTimestamp(y.timestamp)).map((m) => ({ label: shortDate(m.timestamp, tz), value: metricValue(m, 'views') }));
  return html`<${Panel} title="Views per reel" subtitle="Oldest to newest; the most viewed reel is highlighted">
    <${BarChart} label="Views per reel" data=${data} highlightMax height=${height} emptyText="No reels in this period" />
  <//>`;
}

function ReelsTab({ ov, tz, onOpen }) {
  const reels = reelsOf(ov);
  const cols = useMemo(() => mediaColumns(tz, { reels: true }), [tz]);
  if (!reels.length) {
    return html`<${EmptyState} icon="reel" title="No reels in this period" body="Pick a longer date range, or publish a reel from the composer." />`;
  }
  return html`<div class="stack-lg stack">
    <${ReelsSummary} reels=${reels} />
    <${ReelViewsChart} reels=${reels} tz=${tz} />
    <${Panel} flush>
      <${DataTable} dense columns=${cols} rows=${reels} rowKey=${(m) => m.id} initialSort=${{ key: 'date', dir: 'desc' }} onRowClick=${onOpen} maxHeight=${560} caption="Reels in this period" />
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------
// Stories tab

const STORY_LIFE_MS = 24 * 3600e3;
const isLiveStory = (s, nowMs = Date.now()) => nowMs - parseTimestamp(s.timestamp) < STORY_LIFE_MS;

/** Stories posted in the range, plus (with includeLive) the ones still live right now. */
export function storiesInRange(storiesDoc, range, tz, { includeLive = false } = {}) {
  const nowMs = Date.now();
  return toList(storiesDoc && storiesDoc.stories)
    .filter((s) => {
      const t = parseTimestamp(s.timestamp);
      if (!Number.isFinite(t)) return false;
      if (includeLive && isLiveStory(s, nowMs)) return true;
      const k = dayKey(new Date(t), tz);
      return k >= range.fromKey && k <= range.toKey;
    })
    .sort((x, y) => parseTimestamp(y.timestamp) - parseTimestamp(x.timestamp));
}

const navOf = (s) => (s.metrics && s.metrics.navigation) || {};
export const exitRateOf = (s) => {
  const exits = num(navOf(s).tapExit);
  const views = num(s.metrics?.views);
  return exits != null && views > 0 ? exits / views : null;
};

export function storyColumns(tz) {
  const n = (key, label, getter, fmt = 'number') => ({ key, label, align: 'right', sortable: true, sortValue: getter, render: (s) => html`<span class="num">${show(getter(s), fmt)}</span>` });
  return [
    { key: 'thumb', label: '', width: 44, render: (s) => html`<${Thumb} src=${s.thumbnailUrl || (s.mediaType === 'VIDEO' ? null : s.mediaUrl)} size=${32} ratio="9 / 16" kind="story" />` },
    {
      key: 'date',
      label: 'Posted',
      sortable: true,
      sortValue: (s) => parseTimestamp(s.timestamp),
      render: (s) => html`<span class="nowrap">${shortDateTime(s.timestamp, tz)}</span>${isLiveStory(s) ? html` <${Badge} tone="success">Live<//>` : null}`,
    },
    n('reach', 'Reach', (s) => num(s.metrics?.reach)),
    n('views', 'Views', (s) => num(s.metrics?.views)),
    n('replies', 'Replies', (s) => num(s.metrics?.replies)),
    n('fwd', 'Taps forward', (s) => num(navOf(s).tapForward)),
    n('back', 'Taps back', (s) => num(navOf(s).tapBack)),
    n('exit', 'Exits', (s) => num(navOf(s).tapExit)),
    n('exitRate', 'Exit rate', exitRateOf, 'percent'),
  ];
}

export function StoriesSummary({ stories }) {
  return html`<div class="stats an-stats-4">
    <${Stat} label="Stories" value=${stories.length} />
    <${Stat} label="Avg reach" value=${roundOrNull(avg(stories.map((s) => num(s.metrics?.reach))))} />
    <${Stat} label="Replies" value=${sum(stories.map((s) => num(s.metrics?.replies))) ?? 0} />
    <${Stat} label="Avg exit rate" value=${formatPercent(avg(stories.map(exitRateOf)))} hint="Exits divided by views" />
  </div>`;
}

function StoriesTab({ a, tz }) {
  const stories = storiesInRange(a.storiesDoc, a.range, tz, { includeLive: true });
  const cols = useMemo(() => storyColumns(tz), [tz]);
  const unsupported = a.storiesDoc && a.storiesDoc.unsupported;
  return html`<div class="stack-lg stack">
    <${Callout} tone="info" title="Story stats are saved while stories are live">
      Instagram deletes story stats 24 hours after posting, so Postpilot saves them every 10 minutes while a story is live. Stories that are live right now are listed whatever the date range.
    <//>
    ${unsupported ? html`<${Callout} tone="warning" title="Story stats aren't available for this connection">${unsupported.message || ''}<//>` : null}
    ${stories.length
      ? html`<${StoriesSummary} stories=${stories} />
          <${Panel} flush>
            <${DataTable} dense columns=${cols} rows=${stories} rowKey=${(s) => s.id} initialSort=${{ key: 'date', dir: 'desc' }} maxHeight=${560} caption="Stories in this period" />
          <//>`
      : html`<${EmptyState} icon="story" title="No stories saved for this period" body="Stories you post appear here once the worker has seen them." />`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Audience tab

const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const GENDER = { F: ['Women', 'var(--series-1)'], M: ['Men', 'var(--series-2)'], U: ['Not specified', 'var(--series-muted)'] };

let regionNames = null;
function countryName(code) {
  try {
    regionNames ||= new Intl.DisplayNames(undefined, { type: 'region' });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

/** Rows with their share of `base` (or of their own total). */
function shares(rows, base) {
  const list = (rows || []).filter((r) => r && isNum(r.value));
  const total = base || sum(list.map((r) => r.value)) || 0;
  return list.map((r) => ({ ...r, share: total ? r.value / total : null }));
}
const pct = (v) => formatPercent(v);

export function AudienceCharts({ audience, who = 'follower', compact = false }) {
  const demo = audience && audience.demographics && audience.demographics[who];
  if (!demo) {
    return html`<${EmptyState} icon="users" title="No audience breakdown yet"
      body="Instagram shares age, gender and location once an account has at least 100 followers. The worker saves it weekly." />`;
  }
  // Instagram lists only the top countries and cities, so their shares use the whole audience
  // (the gender breakdown covers everyone) rather than the listed rows.
  const base = sum((demo.gender || []).map((r) => r && r.value)) || sum((demo.age || []).map((r) => r && r.value));
  const age = shares(demo.age)
    .sort((x, y) => AGE_ORDER.indexOf(x.key) - AGE_ORDER.indexOf(y.key))
    .map((r) => ({ label: r.key, value: r.share }));
  const gender = shares(demo.gender).map((r) => ({ label: (GENDER[r.key] || [r.key])[0], value: r.value, color: (GENDER[r.key] || [])[1] }));
  const countries = shares(demo.country, base).slice(0, compact ? 6 : 10).map((r) => ({ label: countryName(r.key), value: r.share }));
  const cities = shares(demo.city, base).slice(0, compact ? 6 : 10).map((r) => ({ label: r.key.replace(/,.*$/, ''), value: r.share }));
  return html`<div class="grid-2 an-grid">
    <${Panel} title="Age" subtitle="Share of the audience by age group">
      <${BarChart} label="Audience by age" data=${age} format=${pct} highlightMax />
    <//>
    <${Panel} title="Gender" class="an-donut-panel">
      <div class="an-donut"><${Donut} label="Audience" segments=${gender} format="number" /></div>
    <//>
    <${Panel} title="Top countries" subtitle="Share of the whole audience">
      <${BarChart} horizontal label="Audience by country" data=${countries} format=${pct} />
    <//>
    <${Panel} title="Top cities" subtitle="Share of the whole audience">
      <${BarChart} horizontal label="Audience by city" data=${cities} format=${pct} />
    <//>
  </div>`;
}

function onlineMatrix(online) {
  if (!online) return null;
  if (Array.isArray(online.byWeekdayHour) && online.byWeekdayHour.length === 7) return online.byWeekdayHour;
  if (Array.isArray(online.byHour) && online.byHour.length === 24) return Array.from({ length: 7 }, () => online.byHour);
  return null;
}

function AudienceTab({ a }) {
  const { ig, tz, toast } = useApp();
  const [who, setWho] = useState('follower');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const audience = a.audience;
  const matrix = onlineMatrix(audience && audience.onlineFollowers);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    const [online, demo] = await Promise.allSettled([ig.onlineFollowers({ tz }), ig.demographics({ timeframe: 'this_month' })]);
    const got = { online: online.status === 'fulfilled' ? online.value : null, demo: demo.status === 'fulfilled' ? demo.value : null };
    const usableDemo = got.demo && (got.demo.follower || got.demo.engaged) ? got.demo : null;
    if (!got.online && !usableDemo) {
      const err = online.reason || demo.reason;
      setError((err && (err.userMessage || err.message)) || 'Instagram did not return audience data.');
      setBusy(false);
      return;
    }
    const at = new Date().toISOString();
    try {
      await mutate(
        'audience',
        (d) => {
          if (got.online) d.onlineFollowers = got.online;
          if (usableDemo) d.demographics = usableDemo;
          d.fetchedAt = at;
        },
        { message: 'audience: refresh from Instagram' },
      );
      toast('Audience updated from Instagram.', { kind: 'success' });
    } catch {
      /* mutate already showed the error */
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="stack-lg stack">
    <div class="toolbar">
      <${Segmented} label="Audience" size="sm" value=${who} onChange=${setWho}
        options=${[{ value: 'follower', label: 'Followers' }, { value: 'engaged', label: 'Engaged audience' }]} />
      <span class="spacer"></span>
      <span class="muted text-sm">${audience && audience.fetchedAt ? `Updated weekly · last ${relative(audience.fetchedAt)}` : 'Updated weekly by the worker'}</span>
      <${Button} size="sm" variant="secondary" icon="refresh" loading=${busy} disabled=${!ig} onClick=${refresh}>Refresh from Instagram<//>
    </div>
    <p class="an-note">Audience data describes the last 30 days and isn't affected by the date range.${who === 'engaged' ? ' Engaged audience means accounts that interacted with your content this month.' : ''}</p>
    ${error ? html`<${Callout} tone="danger" title="Could not refresh the audience">${error}<//>` : null}
    <${AudienceCharts} audience=${audience} who=${who} />
    <${Panel} title="When your followers are online" subtitle=${`Average followers online per hour, in your time zone (${tz})`}>
      ${matrix
        ? html`<${Heatmap} label="Followers online by weekday and hour" matrix=${matrix} format="number" />`
        : html`<${EmptyState} compact icon="clock" title="No online-follower data yet" body="Instagram reports this for accounts with at least 100 followers." />`}
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------
// Best times tab

function hourLabel(h) {
  return format(new Date(Date.UTC(2026, 0, 1, h)), 'UTC', { hour: 'numeric' });
}

const BASIS_TEXT = {
  blend: (n) => `Based on when your followers are online (60%) and how your last ${n} posts performed by the hour they went out (40%).`,
  audience: () => 'Based on when your followers are online over the last 30 days.',
  engagement: (n) => `Based on how your last ${n} posts performed by the hour they went out, blended with typical Instagram activity.`,
  default: () => 'Typical Instagram activity. It becomes specific to you once the worker has saved audience data or a few posts.',
};

export function useBestTimes(a, tz) {
  return useMemo(
    () => bestTimeMatrix({ onlineFollowers: a.audience && a.audience.onlineFollowers, mediaStats: a.mediaDoc && a.mediaDoc.media, tz, followers: a.followers ?? undefined }),
    [a.audience, a.mediaDoc, tz, a.followers],
  );
}

/** Next time (ISO) this weekday/hour comes round in tz, at least 20 minutes from now. */
function nextSlot(weekday, hour, tz, now = Date.now()) {
  const today = dayKey(new Date(now), tz);
  for (let i = 0; i <= 7; i++) {
    const k = addDaysKey(today, i);
    if (weekdayOfKey(k) !== weekday) continue;
    const at = zonedToUtc(k, `${String(hour).padStart(2, '0')}:00`, tz);
    if (at.getTime() > now + 20 * 60e3) return at.toISOString();
  }
  return zonedToUtc(addDaysKey(today, 7), `${String(hour).padStart(2, '0')}:00`, tz).toISOString();
}

export function BestTimesSection({ bt, tz, count = 5, compact = false, onPlan }) {
  const top = bt.top.slice(0, count);
  return html`<div class=${cx('an-best', compact && 'is-compact')}>
    <${Panel} title="Best time to post" subtitle=${BASIS_TEXT[bt.basis](bt.postsUsed)} class="an-best-map">
      <${Heatmap} label="Best time score by weekday and hour" matrix=${bt.matrix} format=${(v) => `${Math.round(v * 100)} / 100`} />
    <//>
    <${Panel} title="Top slots" subtitle=${`Times in ${tz}`} class="an-best-list">
      <ol class="list an-slots">
        ${top.map(
          (s, i) => html`<li key=${`${s.weekday}-${s.hour}`} class="list-row">
            <span class="an-slot-rank mono">${String(i + 1).padStart(2, '0')}</span>
            <span class="grow">
              <span class="an-slot-time">${WEEKDAY_NAMES[s.weekday]} ${hourLabel(s.hour)}</span>
              <${ProgressBar} value=${Math.round(s.score * 100)} max=${100} label=${`Score ${Math.round(s.score * 100)} of 100`} />
            </span>
            <span class="num an-slot-score">${Math.round(s.score * 100)}</span>
            ${onPlan ? html`<${Button} size="sm" variant="ghost" icon="plus" class="no-print" onClick=${() => onPlan(nextSlot(s.weekday, s.hour, tz))}
              aria-label=${`Plan a post for ${WEEKDAY_NAMES[s.weekday]} ${hourLabel(s.hour)}`} title="Plan a post at this time" />` : null}
          </li>`,
        )}
      </ol>
    <//>
  </div>`;
}

function BestTimesTab({ a, tz }) {
  const { openComposer } = useApp();
  const bt = useBestTimes(a, tz);
  return html`<div class="stack">
    <p class="an-note">Best times use your audience and every saved post, so they aren't affected by the date range. The composer and autopilot use the same scores. Use + to plan a post at the next occurrence of a slot.</p>
    <${BestTimesSection} bt=${bt} tz=${tz} onPlan=${(iso) => openComposer({ scheduledAt: iso })} />
  </div>`;
}

// ---------------------------------------------------------------------------
// Hashtags tab

export function hashtagColumns() {
  const n = (key, label, fmt = 'number') => ({ key, label, align: 'right', sortable: true, render: (r) => html`<span class="num">${show(r[key] == null ? null : fmt === 'number' ? Math.round(r[key]) : r[key], fmt)}</span>` });
  return [
    { key: 'tag', label: 'Hashtag', sortable: true, render: (r) => html`<span class="mono">${r.tag}</span>` },
    n('posts', 'Posts'),
    n('avgReach', 'Avg reach'),
    n('avgInteractions', 'Avg interactions'),
    n('avgER', 'Avg eng. rate', 'percent'),
  ];
}

function HashtagsTab({ ov, range }) {
  const rows = useMemo(() => hashtagPerformance(ov.posts, { minPosts: 2 }), [ov.posts]);
  const cols = useMemo(() => hashtagColumns(), []);
  const chart = rows.slice(0, 10).map((r) => ({ label: r.tag, value: r.avgER }));
  return html`<div class="stack-lg stack">
    <${Callout} tone="neutral" title="Instagram uses at most 5 hashtags per post">
      Since December 2025 Instagram ignores hashtags past the fifth, so keep the ones that perform best.
    <//>
    ${rows.length
      ? html`<${Panel} title="Engagement rate by hashtag" subtitle="Average across posts that used the hashtag (at least 2 posts)">
            <${BarChart} horizontal label="Average engagement rate by hashtag" data=${chart} format=${(v) => formatPercent(v)} />
          <//>
          <${Panel} flush>
            <${DataTable} dense columns=${cols} rows=${rows} rowKey=${(r) => r.tag} initialSort=${{ key: 'avgER', dir: 'desc' }} maxHeight=${520} caption="Hashtag performance" />
          <//>`
      : html`<${EmptyState} icon="hash" title="Not enough posts to compare hashtags"
          body="A hashtag needs at least 2 posts in the date range. Try a longer range."
          action=${range.preset !== '90d' ? html`<${Button} variant="secondary" onClick=${() => setQuery(rangeToQuery({ preset: '90d' }))}>Show last 90 days<//>` : null} />`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Overview tab

function OverviewTab({ a, ov, tz, compare, onOpen, ig }) {
  return html`<div class="stack-lg stack">
    <${LiveProblems} a=${a} ig=${ig} />
    <${OverviewStats} ov=${ov} />
    <div class="grid-2 an-grid">
      <${FollowersChart} ov=${ov} />
      <${ReachViewsChart} ov=${ov} />
      <${InteractionsChart} ov=${ov} />
      <${PostingFrequency} ov=${ov} compare=${compare} />
    </div>
    <${TopPosts} ov=${ov} tz=${tz} onOpen=${onOpen} />
  </div>`;
}

function OverviewSkeleton() {
  return html`<div class="stack-lg stack" aria-busy="true">
    <div class="stats an-stats">${Array.from({ length: 8 }, (_, i) => html`<${Stat} key=${i} label="Loading" value="" loading />`)}</div>
    <div class="grid-2 an-grid">${[0, 1].map((i) => html`<${Panel} key=${i}><${Skeleton} height=${220} /><//>`)}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Screen

export default function AnalyticsView() {
  const { route, tz, ig, settings, dispatchWorker, toast } = useApp();
  const q = route.query || {};
  const tab = TABS.some((t) => t.id === q.tab) ? q.tab : 'overview';
  const sel = rangeFromQuery(q);
  const compare = q.compare !== '0';
  const range = resolveRange(sel, tz);
  const a = useAnalytics(range, { compare });
  const [open, setOpen] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // While a new range loads live, keep showing the last complete render (dimmed) instead of flashing.
  const stable = useRef(null);
  const loadingLive = a.live.current && a.live.current.status === 'loading';
  if (a.ready && !loadingLive) stable.current = a;
  const shown = loadingLive && stable.current ? stable.current : a;
  const ov = useMemo(() => (shown.ready ? computeOverview(shown, tz, { compare }) : null), [shown.days, shown.media, shown.range.fromKey, shown.range.toKey, shown.ready, shown.live.previous && shown.live.previous.status, tz, compare]);

  const openMedia = (m) => setOpen(m && m.id);
  const openItem = open ? (a.mediaDoc && a.mediaDoc.media && a.mediaDoc.media[open]) || null : null;
  const storiesCount = a.ready ? storiesInRange(a.storiesDoc, range, tz, { includeLive: true }).length : 0;
  const tabs = TABS.map((t) => ({
    ...t,
    badge: !ov ? null : t.id === 'posts' ? ov.posts.length : t.id === 'reels' ? reelsOf(ov).length : t.id === 'stories' ? storiesCount : null,
  }));

  const refresh = async () => {
    setRefreshing(true);
    try {
      await dispatchWorker('analytics refresh');
    } catch {
      /* dispatchWorker already explained the problem */
    } finally {
      setRefreshing(false);
    }
  };
  const doExport = (kind) => {
    if (!a.ready) return;
    const n = kind === 'daily' ? exportDailyCsv(a) : exportPostsCsv(a, tz);
    toast(kind === 'daily' ? `Downloaded ${n} days of metrics.` : `Downloaded ${n} ${n === 1 ? 'post' : 'posts'}.`, { kind: 'success' });
  };
  const username = settings && settings.ig && settings.ig.username;
  const freshness = a.freshness ? `Updated ${relative(a.freshness)} by the worker` : 'The worker has not saved analytics yet';

  return html`<div class="page an-page">
    <${PageHeader} eyebrow="Measure" title="Analytics"
      subtitle=${`${username ? `@${username} · ` : ''}${range.label}`}
      actions=${html`
        <${Button} variant="ghost" icon="refresh" loading=${refreshing} onClick=${refresh}>Refresh now<//>
        <${Menu} label="Export CSV" align="end"
          trigger=${(p) => html`<${Button} ...${p} variant="secondary" icon="download" iconRight="chevron-down">Export CSV<//>`}
          items=${[
            { label: 'Daily metrics', icon: 'calendar', hint: 'CSV', onClick: () => doExport('daily'), disabled: !a.ready },
            { label: 'Posts', icon: 'grid', hint: 'CSV', onClick: () => doExport('posts'), disabled: !a.ready },
          ]} />`} />

    <div class="an-filters">
      <${RangePicker} value=${sel} tz=${tz} onChange=${(next) => setQuery(rangeToQuery(next))}
        compare=${compare} onCompareChange=${(v) => setQuery({ compare: v ? undefined : '0' })} />
      <span class="spacer"></span>
      <span class="an-freshness muted text-sm"><${Icon} name="clock" size=${14} />${freshness}</span>
      <${SourceNotes} a=${a} ig=${ig} />
    </div>

    <${Tabs} label="Analytics sections" tabs=${tabs} value=${tab} onChange=${(id) => setQuery({ tab: id === 'overview' ? undefined : id })} />

    <div role="tabpanel" aria-label=${TABS.find((t) => t.id === tab).label} class=${cx('an-panel', loadingLive && 'is-refreshing')}>
      ${a.error
        ? html`<${Callout} tone="danger" title="Could not open your analytics">${a.error.userMessage || a.error.message}<//>`
        : !ov
          ? html`<${OverviewSkeleton} />`
          : tab === 'overview'
            ? html`<${OverviewTab} a=${shown} ov=${ov} tz=${tz} compare=${compare} onOpen=${openMedia} ig=${ig} />`
            : tab === 'posts'
              ? html`<${PostsTab} a=${shown} ov=${ov} tz=${tz} onOpen=${openMedia} />`
              : tab === 'reels'
                ? html`<${ReelsTab} ov=${ov} tz=${tz} onOpen=${openMedia} />`
                : tab === 'stories'
                  ? html`<${StoriesTab} a=${shown} tz=${tz} />`
                  : tab === 'audience'
                    ? html`<${AudienceTab} a=${shown} />`
                    : tab === 'best-times'
                      ? html`<${BestTimesTab} a=${shown} tz=${tz} />`
                      : html`<${HashtagsTab} ov=${ov} range=${range} />`}
    </div>
    <${PostDrawer} media=${openItem} onClose=${() => setOpen(null)} />
  </div>`;
}
