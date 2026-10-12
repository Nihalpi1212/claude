import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateByType,
  byWeekdayHour,
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
