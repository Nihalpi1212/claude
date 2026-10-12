import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateByType,
  appendHistoryPoint,
  breakdownTotals,
  byWeekdayHour,
  campaignStats,
  historyPoint,
  labelCounts,
  labelsByMedia,
  median,
  mediaWithLabel,
  monthBounds,
  previousMonth,
  thinPoints,
  valueAtAge,
  buildMonthlyReport,
  HISTORY_FROZEN_POINTS,
  monthCoverage,
  reportComparable,
  reportHeadline,
  comparePeriods,
  engagementRate,
  formatDelta,
  formatDuration,
  formatNumber,
  formatPercent,
  hashtagPerformance,
  interactionsOf,
  mediaInRange,
  metricValue,
  parseTimestamp,
  postingFrequency,
  seriesFor,
  summarizeDays,
  toCsv,
  topMedia,
} from '../../core/analytics.js';
import { defaultDoc } from '../../core/model.js';

const TZ = 'America/New_York';

function m(id, timestamp, metrics, extra = {}) {
  return { id, caption: '', mediaType: 'IMAGE', productType: 'FEED', timestamp, metrics, ...extra };
}

test('interactionsOf / engagementRate: totals, fallbacks and missing data', () => {
  assert.equal(interactionsOf({ metrics: { totalInteractions: 50, likes: 1 } }), 50);
  assert.equal(interactionsOf({ metrics: { likes: 10, comments: 2, saved: 3, shares: 1 } }), 16);
  assert.equal(interactionsOf({ likeCount: 7, commentsCount: 1, metrics: {} }), 8);
  assert.equal(interactionsOf({ likes: 4, saves: 1 }), 5); // DailySnapshot shape
  assert.equal(interactionsOf({ metrics: {} }), null);
  assert.equal(interactionsOf(null), null);

  assert.equal(engagementRate({ metrics: { reach: 200, totalInteractions: 10 } }), 0.05);
  assert.equal(engagementRate({ metrics: { reach: 0, totalInteractions: 10 } }, 1000), 0.01);
  assert.equal(engagementRate({ metrics: { totalInteractions: 10 } }, 500), 0.02);
  assert.equal(engagementRate({ metrics: { totalInteractions: 10 } }), null);
  assert.equal(engagementRate({ metrics: { reach: 100 } }), null);
  assert.equal(engagementRate({ reach: 100, totalInteractions: 0 }), 0);

  const media = m('a', '2026-10-01T12:00:00Z', { reach: 100, likes: 5, comments: 1, saved: 2, shares: 0, views: 300 }, { likeCount: 9 });
  assert.equal(metricValue(media, 'likes'), 5);
  assert.equal(metricValue(media, 'saves'), 2);
  assert.equal(metricValue(media, 'views'), 300);
  assert.equal(metricValue(media, 'er'), 0.08);
  assert.equal(metricValue(media, 'follows'), null);
  assert.equal(parseTimestamp('2026-10-01T15:00:00+0000'), Date.parse('2026-10-01T15:00:00Z'));
  assert.ok(Number.isNaN(parseTimestamp('nope')));
});

const DAYS = {
  '2026-10-01': { followers: 1000, reach: 100, views: 400, likes: 10, comments: 2, totalInteractions: 15 },
  '2026-10-02': { followers: 1010, reach: 150, views: 500, likes: 12 },
  '2026-10-03': { reach: 50 }, // followers missing that day
  '2026-10-04': { followers: 1030, reach: 200, profileViews: 7 },
  '2026-10-05': { followers: 1050, reach: 100, views: 100, totalInteractions: 5, websiteClicks: 3 },
  '2026-10-06': { followers: 1060, reach: 300, views: 600, totalInteractions: 20 },
  '2026-10-07': { followers: 1050, reach: 0, views: 0, totalInteractions: 0 },
  '2026-10-08': { followers: 1100, reach: 400, views: 900, totalInteractions: 40 },
};

test('summarizeDays: sums flows, first/last followers, nulls for missing metrics', () => {
  const s = summarizeDays(DAYS, '2026-10-01', '2026-10-04');
  assert.equal(s.followersStart, 1000);
  assert.equal(s.followersEnd, 1030);
  assert.equal(s.followerGrowth, 30);
  assert.equal(s.followerGrowthPct, 0.03);
  assert.equal(s.reach, 500);
  assert.equal(s.views, 900);
  assert.equal(s.likes, 22);
  assert.equal(s.comments, 2);
  assert.equal(s.totalInteractions, 15);
  assert.equal(s.profileViews, 7);
  assert.equal(s.shares, null);
  assert.equal(s.saves, null);
  assert.equal(s.websiteClicks, null);
  assert.equal(s.engagementRate, 15 / 500);
  assert.equal(s.daysWithData, 4);

  // Days without data, or with nothing, stay null; the whole doc is accepted too.
  const empty = summarizeDays({}, '2026-10-01', '2026-10-31');
  assert.equal(empty.reach, null);
  assert.equal(empty.followersStart, null);
  assert.equal(empty.followerGrowth, null);
  assert.equal(empty.daysWithData, 0);
  const doc = defaultDoc('analytics-daily');
  doc.days = DAYS;
  assert.equal(summarizeDays(doc, '2026-10-05', '2026-10-05').reach, 100);
  assert.equal(summarizeDays(DAYS, '2026-10-05', '2026-10-01').daysWithData, 0);
});

test('comparePeriods: same-length previous window and relative deltas', () => {
  const r = comparePeriods(DAYS, '2026-10-05', '2026-10-08');
  assert.deepEqual(r.previousRange, { fromKey: '2026-10-01', toKey: '2026-10-04' });
  assert.equal(r.current.reach, 800);
  assert.equal(r.previous.reach, 500);
  assert.equal(r.delta.reach, 0.6);
  assert.equal(r.delta.views, (1600 - 900) / 900);
  assert.equal(r.delta.followerGrowth, (50 - 30) / 30);
  assert.equal(r.delta.followerGrowthPct, 50 / 1050 - 0.03);
  assert.equal(r.delta.websiteClicks, null); // no previous value
  assert.equal(r.delta.shares, null);
  assert.ok(!('daysWithData' in r.delta));
  // Previous value 0 -> null instead of Infinity.
  const z = comparePeriods({ '2026-10-01': { reach: 0 }, '2026-10-02': { reach: 10 } }, '2026-10-02', '2026-10-02');
  assert.equal(z.delta.reach, null);
  const neg = comparePeriods({ '2026-10-01': { followers: 100 }, '2026-10-02': { followers: 90 }, '2026-10-03': { followers: 95 }, '2026-10-04': { followers: 100 } }, '2026-10-03', '2026-10-04');
  assert.equal(neg.delta.followerGrowth, (5 - -10) / 10);
});

test('seriesFor: labels per day, forward-filled stock metrics', () => {
  const f = seriesFor(DAYS, 'followers', '2026-10-02', '2026-10-04');
  assert.deepEqual(f.labels, ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(f.values, [1010, 1010, 1030]);
  assert.deepEqual(seriesFor(DAYS, 'followers', '2026-10-02', '2026-10-04', { forwardFill: false }).values, [1010, null, 1030]);
  // Seeded from the last value before the range.
  assert.deepEqual(seriesFor(DAYS, 'followers', '2026-10-09', '2026-10-10').values, [1100, 1100]);
  assert.deepEqual(seriesFor(DAYS, 'views', '2026-10-02', '2026-10-04').values, [500, null, null]);
  assert.deepEqual(seriesFor(DAYS, 'engagementRate', '2026-10-05', '2026-10-07').values, [0.05, 20 / 300, 0]);
  assert.deepEqual(seriesFor({}, 'reach', '2026-10-01', '2026-10-02'), { labels: ['2026-10-01', '2026-10-02'], values: [null, null] });
});

const MEDIA = {
  a: m('a', '2026-10-12T02:00:00Z', { reach: 1000, totalInteractions: 50, views: 2000 }, { caption: 'Sunset #Travel #beach' }), // Oct 11 22:00 EDT
  b: m('b', '2026-10-12T16:00:00Z', { reach: 500, totalInteractions: 50, views: 900 }, { caption: '#travel #food #travel' }),
  c: m('c', '2026-10-05T16:00:00Z', { reach: 2000, totalInteractions: 40, views: 5000, avgWatchTimeMs: 4000 }, { productType: 'REELS', mediaType: 'VIDEO', caption: '#food' }),
  d: m('d', '2026-10-01T16:00:00Z', { totalInteractions: 10 }, { caption: '#beach' }), // no reach
  e: m('e', '2026-10-06T16:00:00Z', { reach: 1000, totalInteractions: 10, avgWatchTimeMs: 6000 }, { productType: 'REELS', mediaType: 'VIDEO', caption: '#food #beach' }),
};

test('mediaInRange: local day boundaries, newest first', () => {
  assert.deepEqual(mediaInRange(MEDIA, '2026-10-11', '2026-10-11', TZ).map((x) => x.id), ['a']);
  assert.deepEqual(mediaInRange(MEDIA, '2026-10-12', '2026-10-12', TZ).map((x) => x.id), ['b']);
  assert.deepEqual(mediaInRange(MEDIA, '2026-10-12', '2026-10-12', 'UTC').map((x) => x.id), ['b', 'a']);
  assert.deepEqual(mediaInRange(Object.values(MEDIA), '2026-10-01', '2026-10-31', TZ).map((x) => x.id), ['b', 'a', 'e', 'c', 'd']);
  assert.deepEqual(mediaInRange(null, '2026-10-01', '2026-10-31', TZ), []);
});

test('topMedia and aggregateByType', () => {
  assert.deepEqual(topMedia(MEDIA, 'reach', 2).map((x) => x.id), ['c', 'a']);
  assert.deepEqual(topMedia(MEDIA, 'er', 4).map((x) => x.id), ['b', 'a', 'c', 'e']);
  assert.deepEqual(topMedia(MEDIA, 'er', 10, { followers: 50 }).map((x) => x.id)[0], 'd');
  assert.deepEqual(topMedia(MEDIA, 'follows'), []);

  const agg = aggregateByType(MEDIA);
  assert.deepEqual(Object.keys(agg).sort(), ['FEED', 'REELS']);
  assert.equal(agg.FEED.count, 3);
  assert.equal(agg.FEED.avgReach, 750);
  assert.equal(agg.FEED.totalReach, 1500);
  assert.equal(agg.FEED.avgER, (0.05 + 0.1) / 2);
  assert.equal(agg.FEED.avgInteractions, 110 / 3);
  assert.equal(agg.FEED.avgWatchTimeMs, null);
  assert.equal(agg.REELS.avgWatchTimeMs, 5000);
  assert.equal(agg.REELS.avgViews, 5000);
  assert.deepEqual(Object.keys(aggregateByType(MEDIA, 'mediaType')).sort(), ['IMAGE', 'VIDEO']);
  assert.deepEqual(aggregateByType([]), {});
});

test('hashtagPerformance: at least 2 posts, once per post, sorted by engagement', () => {
  const rows = hashtagPerformance(MEDIA);
  assert.deepEqual(rows.map((r) => r.tag), ['#travel', '#food', '#beach']);
  const travel = rows[0];
  assert.equal(travel.posts, 2);
  assert.equal(travel.avgReach, 750);
  assert.ok(Math.abs(travel.avgER - 0.075) < 1e-12);
  assert.equal(travel.avgInteractions, 50);
  assert.equal(rows.find((r) => r.tag === '#beach').posts, 3);
  assert.equal(rows.find((r) => r.tag === '#beach').avgER, (0.05 + 0.01) / 2); // d has no reach
  assert.deepEqual(hashtagPerformance(MEDIA, { minPosts: 4 }), []);
});

test('byWeekdayHour and postingFrequency', () => {
  const grid = byWeekdayHour(MEDIA, TZ, 'reach');
  assert.equal(grid.length, 7);
  assert.equal(grid[0][22], 1000); // a: Sunday 22:00 EDT
  assert.equal(grid[1][12], (500 + 2000) / 2); // b and c: Monday 12:00 EDT
  assert.equal(grid[3][12], null); // d has no reach
  assert.equal(grid[2][3], null);
  const er = byWeekdayHour(MEDIA, TZ);
  assert.equal(er[1][12], (0.1 + 0.02) / 2);
  assert.equal(postingFrequency(MEDIA, '2026-10-01', '2026-10-14', TZ), 5 / 2);
  assert.equal(postingFrequency(MEDIA, '2026-11-01', '2026-11-07', TZ), 0);
});

test('formatters', () => {
  assert.equal(formatNumber(1234567, { locale: 'en-US' }), '1,234,567');
  assert.equal(formatNumber(12345, { compact: true, locale: 'en-US' }), '12.3K');
  assert.equal(formatNumber(1.234, { locale: 'en-US' }), '1.23');
  assert.equal(formatNumber(null), '—');
  assert.equal(formatNumber(NaN), '—');
  assert.equal(formatPercent(0.0345), '3.5%');
  assert.equal(formatPercent(0.0345, 2), '3.45%');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatDelta(0.12), '+12.0%');
  assert.equal(formatDelta(-0.04), '−4.0%');
  assert.equal(formatDelta(0), '0.0%');
  assert.equal(formatDelta(-0.00001), '0.0%');
  assert.equal(formatDelta(undefined), '—');
  assert.equal(formatDuration(5300), '5.3s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(245_000), '4m 05s');
  assert.equal(formatDuration(11_520_000), '3h 12m');
  assert.equal(formatDuration(190_800_000), '2d 5h');
  assert.equal(formatDuration(null), '—');
});

test('toCsv: RFC 4180 quoting, CRLF and formula guard', () => {
  const rows = [
    { name: 'Plain', caption: 'Hello, "world"\nline 2', n: -5, tags: ['#a', '#b'], when: new Date('2026-10-01T00:00:00Z'), ok: true },
    { name: '=HYPERLINK("http://x")', caption: '+1 555', n: 3.5, tags: [], when: null, ok: false },
    { name: '@cmd', caption: '-2+3', n: null, tags: null, when: undefined, ok: null },
  ];
  const csv = toCsv(rows, [
    { key: 'name', label: 'Name' },
    { key: 'caption', label: 'Caption' },
    { key: 'n', label: 'Count' },
    { key: 'tags', label: 'Tags' },
    { key: 'when', label: 'When' },
    { key: 'ok', label: 'OK' },
    { key: 'calc', label: 'Calc, derived', value: (r) => (r.n == null ? '' : r.n * 2) },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Name,Caption,Count,Tags,When,OK,"Calc, derived"');
  assert.equal(lines[1], 'Plain,"Hello, ""world""\nline 2",-5,"#a, #b",2026-10-01T00:00:00.000Z,true,-10');
  assert.equal(lines[2], `"'=HYPERLINK(""http://x"")",'+1 555,3.5,,,false,7`);
  assert.equal(lines[3], `'@cmd,'-2+3,,,,,`);
  assert.equal(lines.length, 4);
  assert.ok(!csv.endsWith('\r\n'));
  assert.equal(toCsv([], [{ key: 'a' }]), 'a');
  assert.ok(toCsv([], [{ key: 'a' }], { bom: true }).startsWith('﻿'));
});

// ---------------------------------------------------------------------------
// Per-post history, breakdowns, campaigns

const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (h) => new Date(T0 + h * 36e5).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('historyPoint: short keys, missing metrics left out, seconds precision', () => {
  const p = historyPoint({ metrics: { views: 120, reach: 80, saved: 4, shares: 2, follows: 1 }, likeCount: 9, commentsCount: 2 }, T0 + 1234);
  assert.deepEqual(p, { t: '2026-10-01T12:00:01Z', v: 120, r: 80, l: 9, c: 2, s: 4, sh: 2, f: 1 });
  assert.deepEqual(historyPoint({ metrics: { reach: 5 } }, T0), { t: '2026-10-01T12:00:00Z', r: 5 });
  assert.equal(historyPoint({ metrics: {} }, T0), null);
  assert.equal(historyPoint({ metrics: { reach: 1 } }, 'not a date'), null);
});

test('appendHistoryPoint: skips unchanged points under 3 hours old, never goes back in time', () => {
  const pts = [{ t: at(1), v: 10, r: 5 }];
  assert.equal(appendHistoryPoint(pts, { t: at(2), v: 10, r: 5 }), null, 'unchanged, 1 hour later');
  assert.equal(appendHistoryPoint(pts, { t: at(4.5), v: 10, r: 5 }).length, 2, 'unchanged, 3.5 hours later');
  assert.equal(appendHistoryPoint(pts, { t: at(1.5), v: 11, r: 5 }).length, 2, 'changed');
  assert.equal(appendHistoryPoint(pts, { t: at(0.5), v: 11, r: 5 }), null, 'older than the last point');
  assert.deepEqual(appendHistoryPoint(undefined, { t: at(1), v: 1 }), [{ t: at(1), v: 1 }]);
});

test('thinPoints keeps 48 points, first and last, denser in the first hours', () => {
  const pts = [];
  for (let h = 1; h <= 48; h++) pts.push({ t: at(h), v: h });
  for (let d = 3; d <= 30; d++) pts.push({ t: at(d * 24), v: 100 + d });
  const thin = thinPoints(pts, 48, T0);
  assert.equal(thin.length, 48);
  assert.equal(thin[0], pts[0]);
  assert.equal(thin.at(-1), pts.at(-1));
  const hours = thin.map((p) => (Date.parse(p.t) - T0) / 36e5);
  assert.ok(hours.filter((h) => h <= 24).length >= 15, 'the first day keeps most of its points');
  assert.ok(hours.every((h, i) => i === 0 || h > hours[i - 1]), 'still in time order');
  assert.equal(thinPoints(pts.slice(0, 5), 48).length, 5);
});

test('valueAtAge interpolates, anchors at 0 near the start and returns null when unknown', () => {
  const pts = [{ t: at(6), v: 300 }, { t: at(20), v: 700 }, { t: at(30), v: 900 }, { t: at(150), v: 1500 }, { t: at(190), v: 1600 }];
  assert.equal(valueAtAge(pts, T0, 24), 780);
  assert.equal(valueAtAge(pts, T0, 168), 1545);
  assert.equal(valueAtAge(pts, T0, 30), 900);
  assert.equal(valueAtAge(pts, T0, 5), 250, 'between publishing (0) and the first point');
  assert.equal(valueAtAge(pts, T0, 3), null, 'first point more than 1.5x the age away');
  assert.equal(valueAtAge([{ t: at(60), v: 600 }], T0, 24), null, 'first point too far after the age');
  assert.equal(valueAtAge([{ t: at(10), v: 100 }], T0, 24), null, 'history does not reach the age');
  assert.equal(valueAtAge([{ t: at(23.6), v: 400 }], T0, 24), 400, 'a run a few minutes short counts');
  assert.equal(valueAtAge([{ t: at(2), v: 10 }, { t: at(160), v: 900 }], T0, 24), null, 'points too far apart');
  assert.equal(valueAtAge(pts, T0, 24, 'r'), null, 'metric missing');
  assert.equal(valueAtAge(null, T0, 24), null);
  assert.equal(valueAtAge(pts, 'bad', 24), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, undefined]), null);
});

test('breakdownTotals and the follower split sum over a range', () => {
  const days = {
    '2026-10-01': { reach: 100, reachFollowers: 60, reachNonFollowers: 40, viewsByType: { POST: 10, REEL: 20 } },
    '2026-10-02': { reach: 50, viewsByType: { REEL: 5, STORY: 1 } },
    '2026-10-03': { reach: 70 },
  };
  assert.deepEqual(breakdownTotals(days, '2026-10-01', '2026-10-03', 'viewsByType'), { POST: 10, REEL: 25, STORY: 1 });
  assert.equal(breakdownTotals(days, '2026-10-03', '2026-10-03', 'viewsByType'), null);
  assert.equal(breakdownTotals({ days }, '2026-10-01', '2026-10-01', 'viewsByType').POST, 10);
  const s = summarizeDays(days, '2026-10-01', '2026-10-03');
  assert.equal(s.reachFollowers, 60);
  assert.equal(s.reachNonFollowers, 40);
  assert.equal(s.viewsFollowers, null);
});

test('campaigns: labels joined by igMediaId, case-insensitive, with totals and averages', () => {
  const posts = [
    { id: 'p1', igMediaId: 'a', labels: ['Autumn drop', 'product'] },
    { id: 'p2', igMediaId: 'b', labels: ['autumn drop'] },
    { id: 'p3', igMediaId: null, labels: ['autumn drop'] },
    { id: 'p4', igMediaId: 'c', labels: [] },
  ];
  const archive = { posts: [{ id: 'p0', igMediaId: 'd', labels: [' Autumn Drop '] }] };
  const index = labelsByMedia(posts, archive);
  assert.deepEqual([...index.keys()].sort(), ['a', 'b', 'd']);
  assert.deepEqual(index.get('a'), ['Autumn drop', 'product']);
  const media = [
    m('a', '2026-10-01T10:00:00Z', { reach: 100, views: 200, likes: 10, comments: 1, saved: 2, shares: 1 }),
    m('b', '2026-10-02T10:00:00Z', { reach: 300, views: 500, likes: 20, comments: 4, saved: 1, shares: 0 }),
    m('c', '2026-10-03T10:00:00Z', { reach: 900 }),
  ];
  assert.deepEqual(labelCounts(media, index), [{ label: 'Autumn drop', count: 2 }, { label: 'product', count: 1 }]);
  const set = mediaWithLabel(media, index, 'AUTUMN DROP');
  assert.deepEqual(set.map((x) => x.id), ['a', 'b']);
  assert.equal(mediaWithLabel(media, index, '').length, 3);
  const c = campaignStats(set);
  assert.equal(c.posts, 2);
  assert.equal(c.reach, 400);
  assert.equal(c.views, 700);
  assert.equal(c.interactions, 39);
  assert.equal(c.avgReach, 200);
  assert.equal(c.top.id, 'b');
  assert.equal(campaignStats([]).top, null);
  assert.equal(campaignStats([]).reach, null);
});

test('month helpers', () => {
  assert.deepEqual(monthBounds('2028-02'), { fromKey: '2028-02-01', toKey: '2028-02-29' });
  assert.deepEqual(monthBounds('2026-12'), { fromKey: '2026-12-01', toKey: '2026-12-31' });
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-10'), '2026-09');
});

test('valueAtAge: a history that starts after the age gives no value (no straight line from publishing)', () => {
  // A concave cumulative curve, as views and reach are: fast at first, then flat.
  const views = (h) => Math.round(10000 * (1 - Math.exp(-h / 40)));
  const pts = (hours) => hours.map((h) => ({ t: at(h), v: views(h) }));
  assert.equal(valueAtAge(pts([240, 260, 280]), T0, 168), null, 'history from day 10: 7-day value unknown');
  assert.equal(valueAtAge(pts([34, 35, 36]), T0, 24), null, 'history from hour 34: 24-hour value unknown');
  assert.equal(valueAtAge(pts([25.5, 30]), T0, 24), null, '1.5 hours late is more than cron jitter');
  // A first point a few minutes past the age still counts (within 1 hour, or 3% of the age).
  const near = valueAtAge(pts([24.5, 30]), T0, 24);
  assert.ok(Math.abs(near - views(24)) / views(24) < 0.03, `${near} vs ${views(24)}`);
  assert.ok(valueAtAge(pts([172, 190]), T0, 168) != null, '4 hours past the 7-day mark is within 3%');
  // Points around the age further apart than half the age: unknown rather than a straight-line guess.
  assert.equal(valueAtAge(pts([60, 200]), T0, 168), null);
  assert.ok(valueAtAge(pts([120, 190]), T0, 168) != null);
});

test('thinPoints keeps the points around 24 hours and 7 days, so thinned curves keep their values', () => {
  const views = (h) => Math.round(20000 * (1 - Math.exp(-h / 40)));
  const pts = [];
  for (let h = 0.4; h < 48; h += 1) pts.push({ t: at(h), v: views(h) });
  for (let h = 48.4; h < 168; h += 6) pts.push({ t: at(h), v: views(h) });
  for (let h = 168.4; h < 720; h += 24) pts.push({ t: at(h), v: views(h) });
  const v24 = valueAtAge(pts, T0, 24);
  const v7 = valueAtAge(pts, T0, 168);
  for (const max of [48, HISTORY_FROZEN_POINTS, 8]) {
    const thin = thinPoints(pts, max, T0);
    assert.equal(thin.length, max);
    assert.equal(thin[0], pts[0]);
    assert.equal(thin.at(-1), pts.at(-1));
    assert.equal(valueAtAge(thin, T0, 24), v24, `24 h value with ${max} points`);
    assert.equal(valueAtAge(thin, T0, 168), v7, `7-day value with ${max} points`);
  }
  // Without the publish time there is nothing to anchor on: plain thinning.
  assert.equal(thinPoints(pts, 10).length, 10);
});

test('monthly report numbers record how much of each month was saved', () => {
  const days = {};
  // October: 12 days with numbers (from the 20th); September: 17 days (from the 14th).
  for (let d = 14; d <= 30; d++) days[`2026-09-${String(d).padStart(2, '0')}`] = { reach: 1000, followers: 4800 + d };
  for (let d = 20; d <= 31; d++) days[`2026-10-${d}`] = { reach: 1000, reachFollowers: 600, reachNonFollowers: 400 };
  days['2026-10-31'].followers = 4820; // a single follower count in October
  days['2026-10-05'] = { followers: 4810 }; // a follower count alone is not a day with account numbers
  const r = buildMonthlyReport({ days, media: {}, month: '2026-10' });
  assert.equal(r.summary.daysInMonth, 31);
  assert.equal(r.summary.daysSaved, 12);
  assert.equal(r.previous.daysInMonth, 30);
  assert.equal(r.previous.daysSaved, 17);
  assert.deepEqual(monthCoverage(r.summary, '2026-10'), { saved: 12, total: 31, complete: false });
  assert.equal(reportComparable(r), false);
  // Two follower counts in October (the 5th and the 31st): growth is known.
  assert.equal(r.summary.followerGrowth, 10);
  const headline = reportHeadline(r);
  assert.doesNotMatch(headline, /%/, 'no month-on-month change for incomplete months');
  assert.match(headline, /^Reach 12K · 0 posts · \+10 followers · 12 of 31 days saved$/);

  // One follower count is not a change of 0.
  delete days['2026-10-05'];
  const one = buildMonthlyReport({ days, media: {}, month: '2026-10' });
  assert.equal(one.summary.followersEnd, 4820);
  assert.equal(one.summary.followerGrowth, null);
  assert.equal(one.summary.followerGrowthPct, null);
  assert.doesNotMatch(reportHeadline(one), /followers/);
  // Two equal counts: no change, said in words (not "0 followers").
  days['2026-10-20'].followers = 4820;
  assert.match(reportHeadline(buildMonthlyReport({ days, media: {}, month: '2026-10' })), /· no follower change ·/);

  // Complete months are compared; 28 of 30 days counts as complete (90%).
  const full = {};
  for (const k of ['2026-08', '2026-09']) {
    const { toKey } = monthBounds(k);
    for (let d = 1; d <= Number(toKey.slice(8)); d++) full[`${k}-${String(d).padStart(2, '0')}`] = { reach: k === '2026-09' ? 300 : 200 };
  }
  delete full['2026-09-01'];
  delete full['2026-09-02'];
  const cmp = buildMonthlyReport({ days: full, media: {}, month: '2026-09' });
  assert.equal(cmp.summary.daysSaved, 28);
  assert.equal(reportComparable(cmp), true);
  assert.match(reportHeadline(cmp), /^Reach 8.4K \(\+35%\)/);
  // Older stored reports without the coverage fields fall back to daysWithData and the month length.
  assert.deepEqual(monthCoverage({ daysWithData: 30 }, '2026-09'), { saved: 30, total: 30, complete: true });
});

test('monthly report: the non-follower share of reach only counts days with the split', () => {
  // The split starts on the 21st (an upgrade): reach is 1000 every day, 40% from non-followers.
  const days = {};
  for (let d = 1; d <= 30; d++) {
    const k = `2026-09-${String(d).padStart(2, '0')}`;
    days[k] = { reach: 1000, views: 3000 };
    if (d >= 21) Object.assign(days[k], { reachFollowers: 600, reachNonFollowers: 400, viewsByType: { POST: 2000, REEL: 1000 } });
  }
  const r = buildMonthlyReport({ days, media: {}, month: '2026-09' });
  assert.equal(r.summary.reach, 30000);
  assert.equal(r.summary.breakdownDays, 10);
  assert.equal(r.summary.viewsByTypeDays, 10);
  assert.equal(r.summary.nonFollowerReachShare, 0.4);
  assert.equal(r.previous.nonFollowerReachShare, null);
});
