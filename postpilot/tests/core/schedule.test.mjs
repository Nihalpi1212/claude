import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestTimeMatrix,
  defaultMatrix,
  duePosts,
  engagementScores,
  expandListSlots,
  listItemIndex,
  nextQueueSlot,
  planAutopilot,
  recyclePicks,
  suggestSlots,
  unusedAssets,
} from '../../core/schedule.js';
import { addDaysKey, dayKey, timeKey, zonedParts, zonedToUtc } from '../../core/time.js';
import { newAsset, newList, newPost } from '../../core/model.js';

const TZ = 'America/New_York';
const NOW = '2026-10-12T12:00:00.000Z'; // Monday 08:00 EDT
const HOUR = 36e5;

const at = (day, time, tz = TZ) => zonedToUtc(day, time, tz).toISOString();
const local = (iso, tz = TZ) => `${dayKey(new Date(iso), tz)} ${timeKey(new Date(iso), tz)}`;

function flat(value = 0.1) {
  return Array.from({ length: 7 }, () => new Array(24).fill(value));
}

function withPeaks(peaks, base = 0.1) {
  const m = flat(base);
  for (const [w, h, v] of peaks) m[w][h] = v;
  return m;
}

/** A media item published at local day/time with the given engagement rate. */
function media(id, day, time, er, extra = {}) {
  return {
    id,
    caption: '',
    mediaType: 'IMAGE',
    productType: 'FEED',
    timestamp: at(day, time),
    metrics: { reach: 1000, totalInteractions: Math.round(er * 1000) },
    ...extra,
  };
}

/** Day key of weekday w (0=Sun) in the week that is `weeksAgo` weeks before 2026-10-12 (Mon). */
function dayOf(weeksAgo, w) {
  return addDaysKey('2026-10-12', -7 * weeksAgo + (w - 1));
}

// ---------------------------------------------------------------------------
// Best times

test('defaultMatrix: weekday lunch and evening peaks, quiet nights, softer weekends', () => {
  const m = defaultMatrix();
  assert.equal(m.length, 7);
  for (const row of m) assert.equal(row.length, 24);
  for (const w of [1, 2, 3, 4, 5]) {
    for (const h of [11, 12, 13, 18, 19, 20, 21]) assert.ok(m[w][h] >= 0.8, `weekday ${w} ${h}h is a peak`);
    for (const h of [0, 1, 2, 3, 4, 5]) assert.ok(m[w][h] < 0.1, `weekday ${w} ${h}h is quiet`);
  }
  assert.ok(m[0][12] < m[1][12] && m[6][19] < m[5][19]);
});

test('bestTimeMatrix: default basis when there is no data', () => {
  const r = bestTimeMatrix({ tz: TZ, now: NOW });
  assert.equal(r.basis, 'default');
  assert.equal(r.postsUsed, 0);
  assert.equal(r.top.length, 10);
  assert.deepEqual(r.top[0], { weekday: 1, hour: 12, score: 1 });
  for (const t of r.top) assert.ok(t.weekday >= 1 && t.weekday <= 5 && [11, 12, 13, 18, 19, 20, 21].includes(t.hour));
  // Fewer than 3 posts with an engagement rate is not enough data.
  const two = { a: media('a', dayOf(1, 2), '18:00', 0.1), b: media('b', dayOf(2, 2), '18:00', 0.1) };
  assert.equal(bestTimeMatrix({ mediaStats: two, tz: TZ, now: NOW }).basis, 'default');
  // Empty / zero audience data is ignored.
  assert.equal(bestTimeMatrix({ onlineFollowers: { byHour: new Array(24).fill(0) }, tz: TZ, now: NOW }).basis, 'default');
  assert.equal(bestTimeMatrix({ onlineFollowers: {}, mediaStats: {}, tz: TZ, now: NOW }).basis, 'default');
});

test('bestTimeMatrix: audience from byHour, normalized 0..1', () => {
  const byHour = Array.from({ length: 24 }, (_, h) => 100 + (h === 20 ? 900 : h === 8 ? 500 : 0) - (h < 6 ? 90 : 0));
  const r = bestTimeMatrix({ onlineFollowers: { byHour }, tz: TZ, now: NOW });
  assert.equal(r.basis, 'audience');
  for (const row of r.matrix) {
    assert.equal(Math.max(...row), 1);
    assert.equal(row.indexOf(1), 20);
    assert.ok(Math.min(...row) >= 0);
  }
  assert.equal(r.matrix[3][2], 0);
  assert.ok(r.top.slice(0, 7).every((t) => t.hour === 20));
  assert.ok(r.top.slice(7).every((t) => t.hour === 8));
});

test('bestTimeMatrix: byWeekdayHour rows, gaps filled from byHour', () => {
  const byHour = Array.from({ length: 24 }, (_, h) => (h === 20 ? 50 : 10));
  const monday = Array.from({ length: 24 }, (_, h) => (h === 9 ? 80 : 10));
  const byWeekdayHour = [null, monday, new Array(24).fill(0), null, null, null, null];
  const r = bestTimeMatrix({ onlineFollowers: { byHour, byWeekdayHour }, tz: TZ, now: NOW });
  assert.equal(r.basis, 'audience');
  const argmax = (row) => row.indexOf(Math.max(...row));
  assert.equal(argmax(r.matrix[1]), 9);
  assert.equal(argmax(r.matrix[2]), 20);
  assert.equal(argmax(r.matrix[6]), 20);
  assert.deepEqual(r.top[0], { weekday: 1, hour: 9, score: 1 });
});

test('bestTimeMatrix: audience counts in another time zone are rotated into the owner time zone', () => {
  const byHour = Array.from({ length: 24 }, (_, h) => (h === 17 ? 100 : 10));
  // October: New York is UTC-4, so 17:00 UTC is 13:00 local.
  const r = bestTimeMatrix({ onlineFollowers: { byHour, tz: 'UTC' }, tz: TZ, now: NOW });
  assert.equal(r.matrix[3].indexOf(1), 13);
  // January: UTC-5 -> 12:00 local.
  const w = bestTimeMatrix({ onlineFollowers: { byHour, tz: 'UTC' }, tz: TZ, now: '2026-01-15T12:00:00Z' });
  assert.equal(w.matrix[3].indexOf(1), 12);
});

test('engagementScores: buckets by local weekday/hour in the owner time zone', () => {
  const list = [];
  for (let i = 1; i <= 5; i++) list.push(media(`hi${i}`, dayOf(i, 2), '18:00', 0.12)); // Tue 18:00 EDT = 22:00 UTC
  for (let i = 1; i <= 5; i++) list.push(media(`lo${i}`, dayOf(i, 4), '10:00', 0.03));
  const { matrix, posts } = engagementScores(list, { tz: TZ, now: NOW });
  assert.equal(posts, 10);
  assert.ok(matrix[2][18] > 0.5, 'Tue 18h above average');
  assert.ok(matrix[4][10] < 0.5, 'Thu 10h below average');
  assert.ok(matrix[2][18] > matrix[2][22], 'scored at the local hour, not the UTC hour');
  for (const row of matrix) for (const v of row) assert.ok(v >= 0 && v <= 1);
  // Media in the future, older than a year, stories and items without metrics are ignored.
  const ignored = [
    media('future', '2026-12-01', '12:00', 0.9),
    media('old', '2025-01-01', '12:00', 0.9),
    media('story', dayOf(1, 3), '12:00', 0.9, { productType: 'STORY' }),
    { id: 'nometrics', timestamp: at(dayOf(1, 3), '12:00'), metrics: {} },
  ];
  assert.equal(engagementScores([...list, ...ignored], { tz: TZ, now: NOW }).posts, 10);
});

test('engagementScores: one or two viral posts do not outrank a consistently strong slot', () => {
  const base = [];
  let n = 0;
  for (const w of [1, 2, 3, 4, 5]) for (const h of ['09:00', '10:00', '15:00', '16:00']) base.push(media(`b${n++}`, dayOf((n % 8) + 1, w), h, 0.04));
  const strong = Array.from({ length: 8 }, (_, i) => media(`s${i}`, dayOf(i + 1, 2), '18:00', 0.1)); // Tue 18h at 2.5x
  const viral1 = [media('v1', dayOf(3, 3), '12:00', 0.6)]; // Wed 12h at 15x
  const viral2 = [...viral1, media('v2', dayOf(5, 3), '12:00', 0.8)];
  for (const virals of [viral1, viral2]) {
    const { matrix } = engagementScores([...base, ...strong, ...virals], { tz: TZ, now: NOW });
    assert.ok(matrix[2][18] > matrix[3][12], `consistent slot wins with ${virals.length} viral post(s)`);
    assert.ok(matrix[3][12] > 0.5, 'the viral slot still scores above average');
  }
});

test('bestTimeMatrix: blend of audience and engagement, engagement-only basis', () => {
  const list = [];
  for (let i = 1; i <= 6; i++) list.push(media(`hi${i}`, dayOf(i, 3), '15:00', 0.15));
  for (let i = 1; i <= 6; i++) list.push(media(`lo${i}`, dayOf(i, 5), '15:00', 0.03));
  const eng = bestTimeMatrix({ mediaStats: list, tz: TZ, now: NOW });
  assert.equal(eng.basis, 'engagement');
  assert.equal(eng.postsUsed, 12);
  assert.ok(eng.matrix[3][15] > eng.matrix[5][15]);
  assert.ok(eng.matrix[3][3] < 0.5, 'nights stay low through the default prior');

  const byHour = Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 21 ? 100 : 5));
  const blend = bestTimeMatrix({ onlineFollowers: { byHour }, mediaStats: list, tz: TZ, now: NOW });
  assert.equal(blend.basis, 'blend');
  assert.ok(blend.matrix[3][15] > blend.matrix[5][15]);
  assert.equal(Math.max(...blend.matrix.flat()), 1);
});

// ---------------------------------------------------------------------------
// Slots

test('suggestSlots: picks the highest-scoring hours, sorted, at :00 local time', () => {
  const matrix = withPeaks([[3, 15, 1], [5, 10, 0.9]]);
  const slots = suggestSlots({ matrix, tz: TZ, now: NOW, count: 2 });
  assert.deepEqual(slots, [at('2026-10-14', '15:00'), at('2026-10-16', '10:00')]);
  assert.deepEqual(slots.map((s) => local(s)), ['2026-10-14 15:00', '2026-10-16 10:00']);
});

test('suggestSlots: respects taken times, minimum gap, max per day and horizon', () => {
  const matrix = withPeaks([[3, 15, 1], [5, 10, 0.9], [3, 9, 0.95]]);
  // A post on Wed 14:00 blocks Wed 15:00 and Wed 09:00 (within 20h); next week's Wed wins.
  const slots = suggestSlots({ matrix, tz: TZ, now: NOW, count: 2, taken: [at('2026-10-14', '14:00')] });
  assert.deepEqual(slots.map((s) => local(s)), ['2026-10-16 10:00', '2026-10-21 15:00']);

  // maxPerDay 1 keeps Wed 09:00 and Wed 15:00 apart; 2 allows both with a small gap.
  const one = suggestSlots({ matrix, tz: TZ, now: NOW, count: 2, minGapHours: 2, maxPerDay: 1 });
  assert.deepEqual(one.map((s) => local(s)), ['2026-10-14 15:00', '2026-10-16 10:00']);
  const two = suggestSlots({ matrix, tz: TZ, now: NOW, count: 2, minGapHours: 2, maxPerDay: 2 });
  assert.deepEqual(two.map((s) => local(s)), ['2026-10-14 09:00', '2026-10-14 15:00']);

  // Every pick keeps the minimum gap from the others.
  const many = suggestSlots({ matrix: defaultMatrix(), tz: TZ, now: NOW, count: 10, minGapHours: 30 });
  for (let i = 1; i < many.length; i++) assert.ok(Date.parse(many[i]) - Date.parse(many[i - 1]) >= 30 * HOUR);
  for (const s of many) assert.ok(Date.parse(s) <= Date.parse(NOW) + 14 * 24 * HOUR);
  assert.ok(many.length >= 8);

  assert.deepEqual(suggestSlots({ matrix, tz: TZ, now: NOW, count: 0 }), []);
  assert.deepEqual(suggestSlots({ matrix, tz: TZ, now: NOW, count: 3, horizonDays: 0 }), []);
});

test('suggestSlots / nextQueueSlot: earliest start and empty results', () => {
  const matrix = withPeaks([[3, 15, 1]], 0);
  const wed1450 = at('2026-10-14', '14:50');
  assert.equal(local(nextQueueSlot({ matrix, tz: TZ, now: wed1450 })), '2026-10-21 15:00');
  assert.equal(local(nextQueueSlot({ matrix, tz: TZ, now: wed1450, earliestMinutesFromNow: 5 })), '2026-10-14 15:00');
  // A post every 6 hours for two weeks leaves nothing free with a 20h gap.
  const taken = Array.from({ length: 70 }, (_, i) => new Date(Date.parse(NOW) + i * 6 * HOUR).toISOString());
  assert.equal(nextQueueSlot({ matrix, tz: TZ, now: NOW, taken }), null);
  // An invalid matrix falls back to the default prior (weekday lunch).
  assert.equal(timeKey(new Date(nextQueueSlot({ matrix: [[1]], tz: TZ, now: NOW })), TZ), '12:00');
});

test('suggestSlots: DST spring forward skips the missing hour', () => {
  // 2026-03-08 02:00-02:59 does not exist in New York.
  const matrix = withPeaks([[0, 2, 1], [0, 3, 0.5]], 0);
  const slots = suggestSlots({ matrix, tz: TZ, now: '2026-03-07T12:00:00Z', count: 1, horizonDays: 2, decay: 1 });
  assert.deepEqual(slots, ['2026-03-08T07:00:00.000Z']);
  assert.equal(local(slots[0]), '2026-03-08 03:00');
  const all = suggestSlots({ matrix: flat(1), tz: TZ, now: '2026-03-07T12:00:00Z', count: 100, minGapHours: 0, maxPerDay: 0, horizonDays: 2 });
  for (const s of all) {
    assert.equal(zonedParts(new Date(s), TZ).minute, 0);
    assert.notEqual(local(s), '2026-03-08 02:00');
  }
  assert.equal(all.filter((s) => dayKey(new Date(s), TZ) === '2026-03-08').length, 23);
});

test('suggestSlots: DST fall back offers the repeated hour once', () => {
  const all = suggestSlots({ matrix: flat(1), tz: TZ, now: '2026-10-31T12:00:00Z', count: 200, minGapHours: 0, maxPerDay: 0, horizonDays: 2 });
  const sunday = all.filter((s) => dayKey(new Date(s), TZ) === '2026-11-01');
  assert.equal(sunday.length, 24);
  assert.equal(sunday.filter((s) => timeKey(new Date(s), TZ) === '01:00').length, 1);
  assert.equal(new Set(all).size, all.length);
});

test('suggestSlots: fixed slots keep local wall time across DST and go in order', () => {
  const fixedSlots = [{ weekday: 0, time: '12:00' }];
  const slots = suggestSlots({ tz: TZ, now: '2026-10-25T12:00:00Z', count: 2, fixedSlots });
  assert.deepEqual(slots, ['2026-10-25T16:00:00.000Z', '2026-11-01T17:00:00.000Z']);
  const two = [{ weekday: 4, time: '18:00' }, { weekday: 2, time: '09:30' }, { weekday: 9, time: 'bad' }];
  assert.deepEqual(
    suggestSlots({ matrix: withPeaks([[4, 18, 1]]), tz: TZ, now: NOW, count: 3, fixedSlots: two }).map((s) => local(s)),
    ['2026-10-13 09:30', '2026-10-15 18:00', '2026-10-20 09:30'],
  );
});

test('duePosts: scheduled, due within lookahead, not waiting for approval, oldest first', () => {
  const now = Date.parse(NOW);
  const posts = [
    newPost({ id: 'late', status: 'scheduled', scheduledAt: new Date(now - 60_000).toISOString() }),
    newPost({ id: 'oldest', status: 'scheduled', scheduledAt: new Date(now - 3 * HOUR).toISOString() }),
    newPost({ id: 'soon', status: 'scheduled', scheduledAt: new Date(now + 5 * 60_000).toISOString() }),
    newPost({ id: 'later', status: 'scheduled', scheduledAt: new Date(now + 2 * HOUR).toISOString() }),
    newPost({ id: 'approval', status: 'scheduled', needsApproval: true, scheduledAt: new Date(now - HOUR).toISOString() }),
    newPost({ id: 'draft', status: 'draft', scheduledAt: new Date(now - HOUR).toISOString() }),
    newPost({ id: 'done', status: 'published', scheduledAt: new Date(now - HOUR).toISOString() }),
    newPost({ id: 'notime', status: 'scheduled', scheduledAt: null }),
  ];
  assert.deepEqual(duePosts(posts, now).map((p) => p.id), ['oldest', 'late']);
  assert.deepEqual(duePosts(posts, now, 10 * 60_000).map((p) => p.id), ['oldest', 'late', 'soon']);
  assert.deepEqual(duePosts([], now), []);
  assert.deepEqual(duePosts(null, now), []);
});

// ---------------------------------------------------------------------------
// Evergreen lists

function list(partial = {}) {
  return newList({
    id: 'l_1',
    slots: [{ weekday: 1, time: '09:00' }, { weekday: 4, time: '18:30' }],
    items: [{ id: 'i0' }, { id: 'i1' }, { id: 'i2' }],
    nextIndex: 2,
    horizonDays: 14,
    ...partial,
  });
}

test('expandListSlots: sequential items from nextIndex across the horizon', () => {
  const r = expandListSlots(list(), { tz: TZ, now: NOW });
  assert.deepEqual(
    r.slots.map((s) => [local(s.scheduledAt), s.itemIndex]),
    [['2026-10-12 09:00', 2], ['2026-10-15 18:30', 0], ['2026-10-19 09:00', 1], ['2026-10-22 18:30', 2]],
  );
  assert.equal(r.nextIndex, 0);
  // Explicit horizon overrides the list's.
  assert.equal(expandListSlots(list(), { tz: TZ, now: NOW, horizonDays: 4 }).slots.length, 2);
});

test('expandListSlots: skips slots that already have a post from this list (+-1 min)', () => {
  const existingPosts = [
    newPost({ listId: 'l_1', status: 'scheduled', scheduledAt: new Date(Date.parse(at('2026-10-15', '18:30')) + 30_000).toISOString() }),
    newPost({ listId: 'l_1', status: 'canceled', scheduledAt: at('2026-10-22', '18:30') }),
    newPost({ listId: 'l_other', status: 'scheduled', scheduledAt: at('2026-10-19', '09:00') }),
    newPost({ listId: 'l_1', status: 'scheduled', scheduledAt: new Date(Date.parse(at('2026-10-12', '09:00')) + 5 * 60_000).toISOString() }),
  ];
  const r = expandListSlots(list(), { tz: TZ, now: NOW, existingPosts });
  assert.deepEqual(r.slots.map((s) => [local(s.scheduledAt), s.itemIndex]), [['2026-10-12 09:00', 2], ['2026-10-19 09:00', 0]]);
  assert.equal(r.nextIndex, 1);
  // Running again with the created posts adds nothing.
  const created = r.slots.map((s) => newPost({ listId: 'l_1', status: 'scheduled', scheduledAt: s.scheduledAt }));
  const again = expandListSlots(list({ nextIndex: r.nextIndex }), { tz: TZ, now: NOW, existingPosts: [...existingPosts, ...created] });
  assert.deepEqual(again, { slots: [], nextIndex: 1 });
});

test('expandListSlots: disabled lists, empty lists and invalid slots produce nothing', () => {
  assert.deepEqual(expandListSlots(list({ enabled: false }), { tz: TZ, now: NOW }), { slots: [], nextIndex: 2 });
  assert.deepEqual(expandListSlots(list({ items: [] }), { tz: TZ, now: NOW }), { slots: [], nextIndex: 2 });
  assert.deepEqual(expandListSlots(list({ slots: [{ weekday: 1, time: '25:00' }] }), { tz: TZ, now: NOW }), { slots: [], nextIndex: 2 });
  assert.deepEqual(expandListSlots(null, { tz: TZ, now: NOW }), { slots: [], nextIndex: 0 });
  // nextIndex beyond the item count wraps.
  assert.equal(expandListSlots(list({ nextIndex: 7 }), { tz: TZ, now: NOW }).slots[0].itemIndex, 1);
});

test('expandListSlots: a slot inside the spring-forward gap moves to the next valid time', () => {
  const l = list({ slots: [{ weekday: 0, time: '02:30' }] });
  const r = expandListSlots(l, { tz: TZ, now: '2026-03-07T12:00:00Z', horizonDays: 3 });
  assert.deepEqual(r.slots.map((s) => s.scheduledAt), ['2026-03-08T07:30:00.000Z']);
  assert.equal(local(r.slots[0].scheduledAt), '2026-03-08 03:30');
  // Fall back: 01:30 happens twice, the list posts once.
  const f = expandListSlots(list({ slots: [{ weekday: 0, time: '01:30' }] }), { tz: TZ, now: '2026-10-31T12:00:00Z', horizonDays: 3 });
  assert.equal(f.slots.length, 1);
  assert.equal(local(f.slots[0].scheduledAt), '2026-11-01 01:30');
});

test('DST gap east of UTC: Sunday 02:30 stays on Sunday (03:30), times next to a transition stay exact', () => {
  const sunday230 = [{ weekday: 0, time: '02:30' }];
  for (const [tz, now, day] of [['Europe/Berlin', '2026-03-27T12:00:00Z', '2026-03-29'], ['Australia/Sydney', '2026-10-02T12:00:00Z', '2026-10-04']]) {
    const fixed = suggestSlots({ tz, now, count: 1, horizonDays: 3, fixedSlots: sunday230 });
    assert.deepEqual(fixed.map((s) => local(s, tz)), [`${day} 03:30`], tz);
    const r = expandListSlots(list({ slots: sunday230 }), { tz, now, horizonDays: 3 });
    assert.deepEqual(r.slots.map((s) => [local(s.scheduledAt, tz), s.listSlot]), [[`${day} 03:30`, `${day}@02:30`]], tz);
  }
  // Valid wall times on transition days keep their exact time.
  const fall = expandListSlots(list({ slots: [{ weekday: 0, time: '01:30' }, { weekday: 0, time: '03:00' }] }), { tz: 'Europe/Berlin', now: '2026-10-23T12:00:00Z', horizonDays: 3 });
  assert.deepEqual(fall.slots.map((s) => local(s.scheduledAt, 'Europe/Berlin')), ['2026-10-25 01:30', '2026-10-25 03:00']);
  const syd = expandListSlots(list({ slots: [{ weekday: 0, time: '00:00' }] }), { tz: 'Australia/Sydney', now: '2026-04-03T00:00:00Z', horizonDays: 3 });
  assert.deepEqual(syd.slots.map((s) => local(s.scheduledAt, 'Australia/Sydney')), ['2026-04-05 00:00']);
  const ny = suggestSlots({ tz: TZ, now: '2026-03-07T12:00:00Z', count: 2, horizonDays: 3, fixedSlots: [{ weekday: 0, time: '03:00' }, { weekday: 0, time: '01:30' }], minGapHours: 0, maxPerDay: 0 });
  assert.deepEqual(ny.map((s) => local(s)), ['2026-03-08 01:30', '2026-03-08 03:00']);
});

test('expandListSlots: a moved list post keeps its slot filled (listSlot identity)', () => {
  const r = expandListSlots(list(), { tz: TZ, now: NOW });
  assert.deepEqual(r.slots.map((s) => s.listSlot), ['2026-10-12@09:00', '2026-10-15@18:30', '2026-10-19@09:00', '2026-10-22@18:30']);
  const created = r.slots.map((s) => newPost({ listId: 'l_1', status: 'scheduled', scheduledAt: s.scheduledAt, listSlot: s.listSlot }));
  // Drag the Thursday post to Friday 10:00 and shift the next Monday one by two days.
  created[1].scheduledAt = at('2026-10-16', '10:00');
  created[2].scheduledAt = new Date(Date.parse(created[2].scheduledAt) + 2 * 864e5).toISOString();
  created[3].status = 'canceled';
  assert.deepEqual(expandListSlots(list({ nextIndex: r.nextIndex }), { tz: TZ, now: NOW, existingPosts: created }).slots, []);
  // Without listSlot (posts made before it existed) only the time match counts, so the moved slots reopen.
  const legacy = created.map((p) => ({ ...p, listSlot: undefined }));
  assert.deepEqual(
    expandListSlots(list(), { tz: TZ, now: NOW, existingPosts: legacy }).slots.map((s) => s.listSlot),
    ['2026-10-15@18:30', '2026-10-19@09:00'],
  );
});

test('expandListSlots: changing the time zone does not fill the same slots again', () => {
  const now = '2026-10-12T02:00:00Z';
  const berlin = expandListSlots(list(), { tz: 'Europe/Berlin', now });
  assert.equal(berlin.slots.length, 4);
  const posts = berlin.slots.map((s) => newPost({ listId: 'l_1', status: 'scheduled', scheduledAt: s.scheduledAt, listSlot: s.listSlot }));
  for (const tz of [TZ, 'Asia/Tokyo', 'Europe/Berlin']) {
    const again = expandListSlots(list(), { tz, now, existingPosts: posts });
    const ids = new Set(posts.map((p) => p.listSlot));
    assert.ok(again.slots.every((s) => !ids.has(s.listSlot)), `${tz}: no slot is filled twice`);
  }
  assert.deepEqual(expandListSlots(list(), { tz: TZ, now, existingPosts: posts }).slots, []);
});

test('listItemIndex: shuffle is a deterministic permutation per cycle without boundary repeats', () => {
  for (const id of ['l_a', 'l_b', 'l_c', 'l_d']) {
    const l = list({ id, order: 'shuffle', items: Array.from({ length: 5 }, (_, i) => ({ id: `i${i}` })) });
    const seq = Array.from({ length: 60 }, (_, p) => listItemIndex(l, p));
    for (let c = 0; c < 12; c++) assert.deepEqual([...seq.slice(c * 5, c * 5 + 5)].sort(), [0, 1, 2, 3, 4]);
    for (let p = 1; p < seq.length; p++) assert.notEqual(seq[p], seq[p - 1], `no repeat at ${p} for ${id}`);
    assert.deepEqual(seq, Array.from({ length: 60 }, (_, p) => listItemIndex(l, p)));
  }
  const two = list({ order: 'shuffle', items: [{}, {}] });
  assert.deepEqual([0, 1, 2, 3].map((p) => listItemIndex(two, p)), [0, 1, 0, 1]);
  assert.equal(listItemIndex(list({ items: [] }), 3), -1);
  // Shuffle lists persist a running counter.
  const l = list({ order: 'shuffle', items: Array.from({ length: 4 }, () => ({})), nextIndex: 6 });
  const r = expandListSlots(l, { tz: TZ, now: NOW });
  assert.equal(r.nextIndex, 6 + r.slots.length);
  assert.deepEqual(r.slots.map((s) => s.itemIndex), [6, 7, 8, 9].map((p) => listItemIndex(l, p)));
});

// ---------------------------------------------------------------------------
// Autopilot

const AP = {
  enabled: true,
  postsPerWeek: 3,
  horizonDays: 7,
  slotStrategy: 'best',
  fixedSlots: [{ weekday: 2, time: '12:00' }, { weekday: 4, time: '18:00' }],
  minGapHours: 20,
  allowedTypes: ['feed', 'carousel', 'reel'],
};

function libraryAssets() {
  return [
    newAsset({ id: 'a1', folderId: 'f1', autopilot: true }),
    newAsset({ id: 'a2', folderId: 'f1', autopilot: true }),
    newAsset({ id: 'a3', folderId: 'f1', autopilot: true }),
    newAsset({ id: 'a4', kind: 'video', mime: 'video/mp4', autopilot: true }),
    newAsset({ id: 'a5', autopilot: true }),
    newAsset({ id: 'a6', folderId: 'f2', autopilot: true }),
    newAsset({ id: 'a7', autopilot: false }),
  ];
}

test('planAutopilot: fills the queue with carousels, reels and single posts at spaced best times', () => {
  const r = planAutopilot({ autopilot: AP, assets: libraryAssets(), posts: [], tz: TZ, now: NOW });
  assert.equal(r.code, 'planned');
  assert.equal(r.reason, 'Planned 3 posts.');
  assert.deepEqual(
    r.create.map((c) => [c.type, c.assetIds]),
    [['carousel', ['a1', 'a2', 'a3']], ['reel', ['a4']], ['feed', ['a5']]],
  );
  const times = r.create.map((c) => Date.parse(c.scheduledAt));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 20 * HOUR);
  for (const t of times) assert.ok(t > Date.parse(NOW) && t <= Date.parse(NOW) + 7 * 24 * HOUR);
  for (const c of r.create) assert.equal(zonedParts(new Date(c.scheduledAt), TZ).minute, 0);
});

test('planAutopilot: counts posts already planned and stops when full or off', () => {
  const soon = (h) => new Date(Date.parse(NOW) + h * HOUR).toISOString();
  const one = [newPost({ status: 'scheduled', scheduledAt: soon(30), media: [{ assetId: 'zz' }] })];
  const r = planAutopilot({ autopilot: AP, assets: libraryAssets(), posts: one, tz: TZ, now: NOW });
  assert.equal(r.create.length, 2);
  for (const c of r.create) assert.ok(Math.abs(Date.parse(c.scheduledAt) - Date.parse(soon(30))) >= 20 * HOUR);

  const three = [30, 60, 100].map((h) => newPost({ status: h === 60 ? 'draft' : 'scheduled', scheduledAt: soon(h) }));
  const full = planAutopilot({ autopilot: AP, assets: libraryAssets(), posts: three, tz: TZ, now: NOW });
  assert.equal(full.code, 'full');
  assert.deepEqual(full.create, []);
  // Canceled or out-of-horizon posts do not count.
  const notCounted = [newPost({ status: 'canceled', scheduledAt: soon(30) }), newPost({ status: 'scheduled', scheduledAt: soon(24 * 9) })];
  assert.equal(planAutopilot({ autopilot: AP, assets: libraryAssets(), posts: notCounted, tz: TZ, now: NOW }).create.length, 3);

  assert.equal(planAutopilot({ autopilot: { ...AP, enabled: false }, assets: libraryAssets(), tz: TZ, now: NOW }).code, 'disabled');
  assert.equal(planAutopilot({ autopilot: { ...AP, postsPerWeek: 0 }, assets: libraryAssets(), tz: TZ, now: NOW }).code, 'disabled');
  assert.equal(planAutopilot({ autopilot: null }).code, 'disabled');
});

test('planAutopilot: only unused autopilot media, with useAllUnused fallback', () => {
  const assets = libraryAssets();
  const posts = [
    newPost({ id: 'p_used', status: 'scheduled', scheduledAt: '2026-11-30T12:00:00Z', media: [{ assetId: 'a1' }, { assetId: 'a4' }] }),
    newPost({ id: 'p_gone', status: 'canceled', media: [{ assetId: 'a5' }] }),
  ];
  assets.find((a) => a.id === 'a5').usedBy = ['p_gone']; // only a canceled post -> still unused
  assets.find((a) => a.id === 'a6').usedBy = ['p_deleted']; // unknown (deleted) post -> used
  assert.deepEqual(unusedAssets(assets, posts).map((a) => a.id), ['a2', 'a3', 'a5', 'a7']);
  const r = planAutopilot({ autopilot: AP, assets, posts, tz: TZ, now: NOW });
  assert.deepEqual(r.create.map((c) => [c.type, c.assetIds]), [['carousel', ['a2', 'a3']], ['feed', ['a5']]]);
  assert.match(r.reason, /Add more media/);

  const none = planAutopilot({ autopilot: AP, assets: [newAsset({ id: 'x' })], tz: TZ, now: NOW });
  assert.equal(none.code, 'no_assets');
  const fallback = planAutopilot({ autopilot: { ...AP, useAllUnused: true }, assets: [newAsset({ id: 'x' })], tz: TZ, now: NOW });
  assert.deepEqual(fallback.create.map((c) => c.assetIds), [['x']]);
});

test('planAutopilot: media from a rejected draft is not suggested again by useAllUnused', () => {
  const rejected = newPost({ id: 'p1', source: 'autopilot', status: 'canceled', media: [{ assetId: 'a1' }], history: [{ at: NOW, event: 'created' }, { at: NOW, event: 'rejected' }] });
  const assets = [newAsset({ id: 'a1', autopilot: false, usedBy: ['p1'] })];
  const ap = { ...AP, useAllUnused: true };
  assert.equal(planAutopilot({ autopilot: ap, assets, posts: [rejected], tz: TZ, now: NOW }).code, 'no_assets');
  // A post canceled for another reason frees its media as before.
  const canceled = { ...rejected, history: [{ at: NOW, event: 'canceled' }] };
  assert.deepEqual(planAutopilot({ autopilot: ap, assets, posts: [canceled], tz: TZ, now: NOW }).create.map((c) => c.assetIds), [['a1']]);
  // Marking it for autopilot again is an explicit choice: it comes back.
  const again = [{ ...assets[0], autopilot: true }];
  assert.deepEqual(planAutopilot({ autopilot: ap, assets: again, posts: [rejected], tz: TZ, now: NOW }).create.map((c) => c.assetIds), [['a1']]);
});

test('planAutopilot: allowed types, long folders and video fallback', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => newAsset({ id: `c${i}`, folderId: 'big', autopilot: true }));
  const r = planAutopilot({ autopilot: { ...AP, postsPerWeek: 7 }, assets: eleven, tz: TZ, now: NOW });
  assert.deepEqual(r.create.map((c) => [c.type, c.assetIds.length]), [['carousel', 9], ['carousel', 2]]);

  const noReel = planAutopilot({ autopilot: { ...AP, allowedTypes: ['feed'] }, assets: libraryAssets(), tz: TZ, now: NOW });
  assert.deepEqual(noReel.create.map((c) => [c.type, c.assetIds]), [['feed', ['a1']], ['feed', ['a2']], ['feed', ['a3']]]);
  const reelsOnly = planAutopilot({ autopilot: { ...AP, allowedTypes: ['reel'] }, assets: libraryAssets(), tz: TZ, now: NOW });
  assert.deepEqual(reelsOnly.create.map((c) => [c.type, c.assetIds]), [['reel', ['a4']]]);
  const videoFeed = planAutopilot({ autopilot: { ...AP, allowedTypes: ['feed'] }, assets: [newAsset({ id: 'v', kind: 'video', autopilot: true })], tz: TZ, now: NOW });
  assert.deepEqual(videoFeed.create.map((c) => c.type), ['feed']);
});

test('planAutopilot: fixed slots and spacing from recently published posts', () => {
  const r = planAutopilot({ autopilot: { ...AP, slotStrategy: 'fixed' }, assets: libraryAssets(), tz: TZ, now: NOW });
  assert.deepEqual(r.create.map((c) => local(c.scheduledAt)), ['2026-10-13 12:00', '2026-10-15 18:00']);
  assert.match(r.reason, /Not enough free time slots/);

  // A post published 2 hours ago blocks the next 18 hours.
  const published = newPost({ status: 'published', publishedAt: new Date(Date.parse(NOW) - 2 * HOUR).toISOString() });
  const matrix = withPeaks([[1, 12, 1]], 0.2);
  const g = planAutopilot({ autopilot: { ...AP, postsPerWeek: 1 }, assets: libraryAssets(), posts: [published], matrix, tz: TZ, now: NOW });
  assert.equal(g.create.length, 1);
  assert.ok(Date.parse(g.create[0].scheduledAt) - Date.parse(published.publishedAt) >= 20 * HOUR);

  const blocked = planAutopilot({ autopilot: { ...AP, slotStrategy: 'fixed', fixedSlots: [{ weekday: 1, time: '09:00' }], horizonDays: 1 }, assets: libraryAssets(), posts: [published], tz: TZ, now: NOW });
  assert.equal(blocked.code, 'no_slots');
});

// ---------------------------------------------------------------------------
// Recycling

test('recyclePicks: best older media that was not recycled recently', () => {
  const daysAgo = (d) => new Date(Date.parse(NOW) - d * 864e5).toISOString();
  const m = (id, d, er, extra = {}) => ({ id, productType: 'FEED', timestamp: daysAgo(d), metrics: { reach: 1000, totalInteractions: er * 1000 }, ...extra });
  const mediaStats = {
    m1: m('m1', 200, 0.1),
    m2: m('m2', 300, 0.2),
    m3: m('m3', 10, 0.5),
    m4: m('m4', 200, 0.6, { productType: 'STORY' }),
    m5: m('m5', 250, 0.3),
    m6: m('m6', 150, 0.4),
    m7: { id: 'm7', productType: 'FEED', timestamp: daysAgo(400), metrics: {} },
    m8: m('m8', 500, 0.25),
  };
  const posts = [
    newPost({ source: 'recycle', recycleOf: 'm5', status: 'published', scheduledAt: daysAgo(30) }),
    newPost({ source: 'recycle', recycleOf: 'm8', status: 'published', scheduledAt: daysAgo(130) }),
    newPost({ source: 'recycle', recycleOf: 'm1', status: 'canceled', scheduledAt: daysAgo(5) }),
    newPost({ source: 'recycle', recycleOf: 'm9', status: 'published', igMediaId: 'm6', scheduledAt: daysAgo(150) }),
  ];
  const picks = recyclePicks({ mediaStats, posts, now: NOW, afterDays: 120, count: 3 });
  assert.deepEqual(picks.map((p) => p.id), ['m8', 'm2', 'm1']);
  assert.deepEqual(recyclePicks({ mediaStats, posts, now: NOW, afterDays: 120 }).map((p) => p.id), ['m8']);
  assert.deepEqual(recyclePicks({ mediaStats: {}, now: NOW }), []);
});
