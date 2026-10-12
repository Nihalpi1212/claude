// Scheduling brain (pure, environment-neutral): best-time scoring, queue slots,
// due posts, evergreen list expansion, autopilot planning and recycling picks.
//
// Every wall-clock computation goes through core/time.js in the owner's time zone.
// Matrices are 7x24 arrays indexed [weekday 0=Sun][hour 0-23] in that time zone.
// `now` arguments accept a Date, epoch ms or an ISO string (default: the current time).

import { addDaysKey, dayKey, isValidTimeZone, pad, weekdayOfKey, zonedParts, zonedToUtc } from './time.js';
import { engagementRate, interactionsOf, parseTimestamp, toList } from './analytics.js';
import { LIMITS } from './model.js';

const HOUR_MS = 36e5;
const DAY_MS = 864e5;

// Engagement smoothing parameters (see engagementScores).
const MIN_ENGAGEMENT_POSTS = 3;
const PRIOR_STRENGTH = 8; // pseudo-posts pulling a cell toward its hour / the account mean
const OUTLIER_CAP = Math.log(2.5); // one viral post counts as at most 2.5x the median ER
const LIFT_SPAN = 2 * Math.LN2; // 2x the mean ER maps to 1.0, half the mean to 0.0
const LOOKBACK_DAYS = 365;

// Typical Instagram audience activity used when the account has no data yet:
// weekday peaks at lunch (11-13h) and evening (18-21h); weekends a little lower.
const DEFAULT_HOURLY = [
  0.06, 0.04, 0.03, 0.02, 0.02, 0.04, // 0-5
  0.1, 0.2, 0.32, 0.42, 0.56, 0.86, // 6-11
  1.0, 0.88, 0.6, 0.5, 0.5, 0.62, // 12-17
  0.84, 0.95, 0.92, 0.82, 0.5, 0.22, // 18-23
];
const WEEKEND_FACTOR = 0.8;

// ---------------------------------------------------------------------------
// Helpers

function toMs(now) {
  if (now == null) return Date.now();
  const t = parseTimestamp(now);
  return Number.isFinite(t) ? t : Date.now();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function grid(fill = 0) {
  return Array.from({ length: 7 }, () => new Array(24).fill(fill));
}

function isMatrix(m) {
  return Array.isArray(m) && m.length === 7 && m.every((r) => Array.isArray(r) && r.length === 24);
}

function scoreAt(matrix, weekday, hour) {
  const v = matrix?.[weekday]?.[hour];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round(v, digits = 4) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function parseTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min, text: `${pad(h)}:${pad(min)}` };
}

/**
 * Wall-clock day + time in `tz` to an instant. Times that do not exist (spring-forward gap)
 * are moved forward by the gap, like Temporal's 'compatible' disambiguation.
 * @returns {{ms: number, exact: boolean}|null}
 */
function resolveLocal(day, time, tz) {
  const t = parseTime(time);
  if (!t) return null;
  const exact = (ms) => {
    const p = zonedParts(new Date(ms), tz);
    return dayKey(new Date(ms), tz) === day && p.hour === t.h && p.minute === t.min;
  };
  const date = zonedToUtc(day, t.text, tz);
  if (exact(date.getTime())) return { ms: date.getTime(), exact: true };
  // zonedToUtc may land on either side of a DST gap (before it west of UTC, after it east of UTC).
  // Read the wall time with the offsets in force a day before and a day after instead.
  const [y, mo, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, t.h, t.min);
  const offsets = [offsetMinutes(wall - DAY_MS, tz), offsetMinutes(wall + DAY_MS, tz)];
  for (const off of offsets) {
    const ms = wall - off * 60_000;
    if (exact(ms)) return { ms, exact: true };
  }
  // The wall time does not exist (spring-forward gap): the pre-transition (smaller) offset puts it
  // after the gap by the gap's length, e.g. 02:30 -> 03:30 on the same day.
  return { ms: wall - Math.min(...offsets) * 60_000, exact: false };
}

/** Offset of `tz` from UTC in minutes at `ms`. */
function offsetMinutes(ms, tz) {
  const p = zonedParts(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

function normalizeMinMax(matrix) {
  let min = Infinity;
  let max = -Infinity;
  for (const row of matrix) for (const v of row) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max - min > 1e-12)) return null;
  return matrix.map((row) => row.map((v) => (v - min) / (max - min)));
}

function normalizeMax(matrix) {
  let max = 0;
  for (const row of matrix) for (const v of row) if (v > max) max = v;
  return matrix.map((row) => row.map((v) => (max > 0 ? round(v / max) : 0)));
}

/** 32-bit FNV-1a hash of a string. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Best times

/** The built-in prior: typical audience activity, weekday 11-13h and 18-21h peaks. 7x24, 0..1. */
export function defaultMatrix() {
  return Array.from({ length: 7 }, (_, w) =>
    DEFAULT_HOURLY.map((v) => round(w === 0 || w === 6 ? v * WEEKEND_FACTOR : v)),
  );
}

function audienceScores(onlineFollowers, tz, nowMs) {
  if (!onlineFollowers || typeof onlineFollowers !== 'object') return null;
  const cleanRow = (r) =>
    Array.isArray(r) && r.length === 24 ? r.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)) : null;
  const hasData = (r) => r && r.some((v) => v > 0);
  const byHour = cleanRow(onlineFollowers.byHour);
  let rows = null;
  if (Array.isArray(onlineFollowers.byWeekdayHour) && onlineFollowers.byWeekdayHour.length === 7) {
    rows = onlineFollowers.byWeekdayHour.map((r) => {
      const row = cleanRow(r);
      return hasData(row) ? row : null;
    });
    const present = rows.filter(Boolean);
    const fill = hasData(byHour)
      ? byHour
      : present.length
        ? Array.from({ length: 24 }, (_, h) => present.reduce((a, r) => a + r[h], 0) / present.length)
        : null;
    if (!fill) rows = null;
    else rows = rows.map((r) => r || [...fill]);
  }
  if (!rows && hasData(byHour)) rows = Array.from({ length: 7 }, () => [...byHour]);
  if (!rows) return null;

  // Optional source time zone (e.g. data captured in another zone): rotate into `tz`.
  const src = onlineFollowers.tz;
  if (src && src !== tz && isValidTimeZone(src)) {
    const shift = Math.round((offsetMinutes(nowMs, tz) - offsetMinutes(nowMs, src)) / 60);
    if (shift) {
      const flat = rows.flat();
      const out = new Array(168);
      for (let i = 0; i < 168; i++) out[(((i + shift) % 168) + 168) % 168] = flat[i];
      rows = Array.from({ length: 7 }, (_, w) => out.slice(w * 24, w * 24 + 24));
    }
  }
  return normalizeMinMax(rows);
}

/**
 * Engagement score per local weekday/hour from past media, 0..1 with 0.5 = the account's average.
 * Works on log engagement rate, caps outliers at 2.5x the median, and shrinks each cell toward its
 * hour (pooled across weekdays and neighbouring hours) and each hour toward the account mean, so one
 * or two posts cannot dominate. Returns null when fewer than 3 posts have an engagement rate.
 * @returns {{matrix: number[][]|null, posts: number}}
 */
export function engagementScores(mediaStats, { tz = 'UTC', now, followers } = {}) {
  const nowMs = toMs(now);
  const samples = [];
  for (const m of toList(mediaStats)) {
    if (m.productType === 'STORY') continue;
    const t = parseTimestamp(m.timestamp);
    if (!Number.isFinite(t) || t > nowMs || t < nowMs - LOOKBACK_DAYS * DAY_MS) continue;
    const er = engagementRate(m, followers);
    if (er == null || !Number.isFinite(er) || er < 0) continue;
    const p = zonedParts(new Date(t), tz);
    samples.push({ w: p.weekday, h: p.hour, x: Math.log(er + 1e-4) });
  }
  if (samples.length < MIN_ENGAGEMENT_POSTS) return { matrix: null, posts: samples.length };

  const sorted = samples.map((s) => s.x).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  for (const s of samples) s.x = Math.min(median + OUTLIER_CAP, Math.max(median - OUTLIER_CAP, s.x));
  const mean = samples.reduce((a, s) => a + s.x, 0) / samples.length;

  const hourSum = new Array(24).fill(0);
  const hourN = new Array(24).fill(0);
  const cellSum = grid(0);
  const cellN = grid(0);
  for (const s of samples) {
    for (const [d, wt] of [[0, 1], [-1, 0.5], [1, 0.5]]) {
      const h = (s.h + d + 24) % 24;
      hourSum[h] += s.x * wt;
      hourN[h] += wt;
    }
    for (const [d, wt] of [[0, 1], [-1, 0.5], [1, 0.5]]) {
      const h = s.h + d;
      if (h < 0 || h > 23) continue;
      cellSum[s.w][h] += s.x * wt;
      cellN[s.w][h] += wt;
    }
  }
  const k = PRIOR_STRENGTH;
  const hourMean = hourSum.map((sum, h) => (sum + k * mean) / (hourN[h] + k));
  const cells = cellSum.map((row, w) => row.map((sum, h) => (sum + k * hourMean[h]) / (cellN[w][h] + k)));
  let spread = 0;
  for (const row of cells) for (const v of row) spread = Math.max(spread, Math.abs(v - mean));
  if (spread < 1e-9) return { matrix: null, posts: samples.length };
  const matrix = cells.map((row) => row.map((v) => Math.min(1, Math.max(0, 0.5 + (v - mean) / LIFT_SPAN))));
  return { matrix, posts: samples.length };
}

/**
 * Best time to post, per local weekday and hour.
 * - audience: Instagram online followers ({byHour: number[24]} and/or {byWeekdayHour: number[7][24]},
 *   optional {tz} when the counts are in another time zone).
 * - engagement: past media engagement rate by local publish time (see engagementScores).
 * Both: 60% audience / 40% engagement. Engagement only: 60% engagement / 40% default prior.
 * Nothing: the default prior.
 * @param {{onlineFollowers?: object, mediaStats?: object|Array, tz?: string, now?: Date|number|string, followers?: number}} args
 * @returns {{matrix: number[][], top: Array<{weekday, hour, score}>, basis: 'audience'|'engagement'|'blend'|'default', postsUsed: number}}
 */
export function bestTimeMatrix({ onlineFollowers, mediaStats, tz = 'UTC', now, followers } = {}) {
  const nowMs = toMs(now);
  const audience = audienceScores(onlineFollowers, tz, nowMs);
  const { matrix: engagement, posts } = engagementScores(mediaStats, { tz, now: nowMs, followers });
  const prior = defaultMatrix();
  const mix = (a, b, wa) => a.map((row, w) => row.map((v, h) => wa * v + (1 - wa) * b[w][h]));
  let raw;
  let basis;
  if (audience && engagement) [raw, basis] = [mix(audience, engagement, 0.6), 'blend'];
  else if (audience) [raw, basis] = [audience, 'audience'];
  else if (engagement) [raw, basis] = [mix(engagement, prior, 0.6), 'engagement'];
  else [raw, basis] = [prior, 'default'];
  const matrix = normalizeMax(raw);
  const top = [];
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) top.push({ weekday: w, hour: h, score: matrix[w][h] });
  top.sort((a, b) => b.score - a.score || a.weekday - b.weekday || a.hour - b.hour);
  return { matrix, top: top.slice(0, 10), basis, postsUsed: engagement ? posts : 0 };
}

// ---------------------------------------------------------------------------
// Slots

/**
 * Pick future publish times.
 * Best-time mode scores every local hour (:00) in the horizon with matrix[weekday][hour] times a small
 * per-day decay (prefers sooner slots of similar quality) and picks greedily. With fixedSlots
 * ([{weekday, time: 'HH:mm'}]) the earliest free fixed slots are used instead.
 * A slot is free when it is at least minGapHours away from every taken/picked time and its local day
 * has fewer than maxPerDay posts (taken times count; null or 0 = no daily limit).
 * @param {{matrix?: number[][], tz?: string, now?: any, count?: number, horizonDays?: number, minGapHours?: number,
 *   taken?: string[], fixedSlots?: Array<{weekday: number, time: string}>|null, earliestMinutesFromNow?: number,
 *   maxPerDay?: number|null, decay?: number}} args
 * @returns {string[]} ISO strings, ascending
 */
export function suggestSlots({
  matrix,
  tz = 'UTC',
  now,
  count = 1,
  horizonDays = 14,
  minGapHours = 20,
  taken = [],
  fixedSlots = null,
  earliestMinutesFromNow = 20,
  maxPerDay = 1,
  decay = 0.97,
} = {}) {
  const nowMs = toMs(now);
  const want = Math.max(0, Math.floor(count));
  if (!want) return [];
  const scores = isMatrix(matrix) ? matrix : defaultMatrix();
  const startMs = nowMs + Math.max(0, earliestMinutesFromNow) * 60_000;
  const endMs = nowMs + Math.max(0, horizonDays) * DAY_MS;
  const gapMs = Math.max(60_000, (Number(minGapHours) || 0) * HOUR_MS);
  const dayLimit = maxPerDay > 0 ? maxPerDay : Infinity;

  const takenMs = (taken || []).map(parseTimestamp).filter(Number.isFinite);
  const perDay = new Map();
  const bump = (day) => perDay.set(day, (perDay.get(day) || 0) + 1);
  for (const t of takenMs) bump(dayKey(new Date(t), tz));

  const fixed = Array.isArray(fixedSlots) ? fixedSlots.filter((s) => s && parseTime(s.time)) : [];
  const useFixed = fixed.length > 0;
  const today = dayKey(new Date(nowMs), tz);
  const seen = new Set();
  const candidates = [];
  const add = (ms, day, weekday, hour) => {
    if (ms < startMs || ms > endMs || seen.has(ms)) return;
    seen.add(ms);
    const score = scoreAt(scores, weekday, hour);
    candidates.push({ ms, day, score, eff: score * Math.pow(decay, (ms - nowMs) / DAY_MS) });
  };
  for (let i = 0; i <= Math.ceil(horizonDays) + 1; i++) {
    const day = addDaysKey(today, i);
    const wd = weekdayOfKey(day);
    if (useFixed) {
      for (const s of fixed) {
        if (Number(s.weekday) !== wd) continue;
        const r = resolveLocal(day, s.time, tz);
        if (!r) continue;
        const local = zonedParts(new Date(r.ms), tz);
        add(r.ms, day, local.weekday, local.hour);
      }
      continue;
    }
    // Best-time mode: every local hh:00 of the day. Stepping from local midnight is exact except
    // around DST changes, where the full conversion decides (hours that do not exist are skipped).
    const midnight = zonedToUtc(day, '00:00', tz).getTime();
    if (midnight > endMs + DAY_MS) break;
    if (midnight + 2 * DAY_MS < startMs) continue;
    for (let h = 0; h < 24; h++) {
      let ms = midnight + h * HOUR_MS;
      const p = zonedParts(new Date(ms), tz);
      if (p.hour !== h || p.minute !== 0 || p.day !== Number(day.slice(8))) {
        const r = resolveLocal(day, `${pad(h)}:00`, tz);
        if (!r || !r.exact) continue;
        ms = r.ms;
      }
      add(ms, day, wd, h);
    }
  }
  if (useFixed) candidates.sort((a, b) => a.ms - b.ms);
  else candidates.sort((a, b) => b.eff - a.eff || a.ms - b.ms);

  const picked = [];
  for (const c of candidates) {
    if (picked.length >= want) break;
    if ((perDay.get(c.day) || 0) >= dayLimit) continue;
    if (takenMs.some((t) => Math.abs(t - c.ms) < gapMs)) continue;
    if (picked.some((t) => Math.abs(t - c.ms) < gapMs)) continue;
    picked.push(c.ms);
    bump(c.day);
  }
  return picked.sort((a, b) => a - b).map(iso);
}

/** The next queue slot (suggestSlots with count 1), or null when none is free. */
export function nextQueueSlot(args = {}) {
  return suggestSlots({ ...args, count: 1 })[0] ?? null;
}

/**
 * Posts the worker should publish now: status 'scheduled', scheduledAt <= now + lookahead and not
 * waiting for approval. Oldest first.
 */
export function duePosts(posts, nowMs = Date.now(), lookaheadMs = 0) {
  const limit = toMs(nowMs) + Math.max(0, lookaheadMs || 0);
  return toList(posts)
    .filter((p) => p.status === 'scheduled' && !p.needsApproval && p.scheduledAt)
    .map((p) => ({ p, t: parseTimestamp(p.scheduledAt) }))
    .filter(({ t }) => Number.isFinite(t) && t <= limit)
    .sort((a, b) => a.t - b.t || String(a.p.id).localeCompare(String(b.p.id)))
    .map(({ p }) => p);
}

// ---------------------------------------------------------------------------
// Evergreen lists

function shuffledOrder(listId, cycle, n) {
  const next = rng(hash32(`${listId}:${cycle}`));
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/**
 * Item index for the p-th use of a list. 'sequential': p mod n. 'shuffle': a deterministic
 * permutation per cycle of n uses (seeded by list id + cycle), never repeating an item across the
 * cycle boundary when the list has 3+ items. Two-item lists alternate.
 */
export function listItemIndex(list, p) {
  const n = list?.items?.length || 0;
  if (!n) return -1;
  const pos = Math.max(0, Math.floor(p));
  if (list.order !== 'shuffle' || n <= 2) return pos % n;
  const cycle = Math.floor(pos / n);
  const perm = shuffledOrder(list.id, cycle, n);
  if (cycle > 0) {
    const prevLast = shuffledOrder(list.id, cycle - 1, n)[n - 1];
    if (perm[0] === prevLast) [perm[0], perm[1]] = [perm[1], perm[0]];
  }
  return perm[pos % n];
}

/**
 * Upcoming slot occurrences of an evergreen list that have no post yet.
 * Each occurrence has a time-zone-independent identity, listSlot = 'YYYY-MM-DD@HH:mm' (local day and
 * slot time). The worker stores it on the post it creates (post.listSlot). A slot is filled when any
 * post (any status, canceled included) with listId === list.id carries its listSlot, or is
 * scheduled within 1 minute of it (also covers posts created before listSlot existed). So moving a
 * list post in the planner or changing the time zone never makes its slot look empty again.
 * Items are assigned chronologically from list.nextIndex.
 * Persist the returned nextIndex on the list (for 'shuffle' it is a running counter; for
 * 'sequential' it wraps at the item count).
 * Slots in a DST gap move forward (02:30 on a spring-forward day becomes 03:30).
 * @param {object} list List (model.js)
 * @param {{tz?: string, now?: any, horizonDays?: number, existingPosts?: object[]}} opts
 * @returns {{slots: Array<{scheduledAt: string, itemIndex: number, listSlot: string}>, nextIndex: number}}
 */
export function expandListSlots(list, { tz = 'UTC', now, horizonDays, existingPosts = [] } = {}) {
  const start = Number.isInteger(list?.nextIndex) && list.nextIndex >= 0 ? list.nextIndex : 0;
  const items = list?.items || [];
  const slotDefs = (list?.slots || []).filter((s) => s && parseTime(s.time) && Number.isInteger(Number(s.weekday)));
  if (!list || list.enabled === false || !items.length || !slotDefs.length) return { slots: [], nextIndex: start };

  const nowMs = toMs(now);
  const horizon = Math.max(0, horizonDays ?? list.horizonDays ?? 14);
  const endMs = nowMs + horizon * DAY_MS;
  const own = toList(existingPosts).filter((p) => p.listId === list.id);
  const filledIds = new Set(own.map((p) => p.listSlot).filter(Boolean));
  const existing = own
    .filter((p) => p.scheduledAt)
    .map((p) => parseTimestamp(p.scheduledAt))
    .filter(Number.isFinite);

  const today = dayKey(new Date(nowMs), tz);
  const found = new Map(); // ms -> listSlot
  for (let i = 0; i <= Math.ceil(horizon) + 1; i++) {
    const day = addDaysKey(today, i);
    const wd = weekdayOfKey(day);
    for (const s of slotDefs) {
      if (Number(s.weekday) !== wd) continue;
      const r = resolveLocal(day, s.time, tz);
      if (!r || r.ms <= nowMs || r.ms > endMs || found.has(r.ms)) continue;
      const id = `${day}@${parseTime(s.time).text}`;
      if (filledIds.has(id)) continue;
      if (existing.some((t) => Math.abs(t - r.ms) <= 60_000)) continue;
      found.set(r.ms, id);
    }
  }
  const slots = [...found.keys()]
    .sort((a, b) => a - b)
    .map((ms, i) => ({ scheduledAt: iso(ms), itemIndex: listItemIndex(list, start + i), listSlot: found.get(ms) }));
  const used = start + slots.length;
  const nextIndex = list.order === 'shuffle' && items.length > 2 ? used : used % items.length;
  return { slots, nextIndex };
}

// ---------------------------------------------------------------------------
// Autopilot

const ACTIVE_STATUSES = new Set(['draft', 'scheduled', 'publishing']);

/**
 * Asset ids used by a post that is not canceled. An asset is also treated as used when its
 * usedBy lists a post id that is not a known canceled post (deleted posts still count as used).
 */
export function unusedAssets(assets, posts) {
  const postList = toList(posts);
  const used = new Set();
  const canceled = new Set();
  for (const p of postList) {
    if (p.status === 'canceled') canceled.add(p.id);
    else for (const m of p.media || []) used.add(m.assetId);
  }
  return toList(assets).filter((a) => !used.has(a.id) && !(a.usedBy || []).some((id) => !canceled.has(id)));
}

function groupAssets(pool, allowed) {
  const groups = [];
  const asReel = (a) => a.kind === 'video' && allowed.has('reel');
  for (let i = 0; i < pool.length; ) {
    const a = pool[i];
    if (asReel(a)) {
      groups.push({ assetIds: [a.id], type: 'reel' });
      i++;
      continue;
    }
    if (allowed.has('carousel') && a.folderId) {
      let run = 0;
      while (i + run < pool.length && pool[i + run].folderId === a.folderId && !asReel(pool[i + run])) run++;
      if (run >= LIMITS.carouselMin) {
        // Chunk long runs, never leaving a single straggler.
        let take = Math.min(run, LIMITS.carouselMax);
        if (run - take === 1) take -= 1;
        groups.push({ assetIds: pool.slice(i, i + take).map((x) => x.id), type: 'carousel' });
        i += take;
        continue;
      }
    }
    if (allowed.has('feed')) groups.push({ assetIds: [a.id], type: 'feed' });
    i++;
  }
  return groups;
}

/**
 * Plan the posts autopilot should create to keep its queue filled.
 * Target: round(postsPerWeek * horizonDays / 7) (at least 1) posts of any source scheduled (status
 * draft/scheduled) within the horizon. Media: unused library assets with autopilot === true in library
 * order, then (autopilot.useAllUnused) any other unused asset that was not in a rejected draft.
 * Consecutive assets sharing a folderId become a carousel (2-10) when allowed; videos become reels
 * when allowed; the rest single feed posts.
 * Times: suggestSlots with the matrix ('best') or autopilot.fixedSlots ('fixed'), at least minGapHours
 * from every other active or recently published post.
 * @returns {{create: Array<{assetIds: string[], type: string, scheduledAt: string}>, reason: string,
 *   code: 'disabled'|'full'|'no_assets'|'no_slots'|'planned'}}
 */
export function planAutopilot({ autopilot, assets = [], posts = [], matrix, tz = 'UTC', now } = {}) {
  const ap = autopilot || {};
  if (!ap.enabled) return { create: [], reason: 'Autopilot is off.', code: 'disabled' };
  const perWeek = Math.max(0, Number(ap.postsPerWeek) || 0);
  if (!perWeek) return { create: [], reason: 'Autopilot is set to 0 posts per week.', code: 'disabled' };

  const nowMs = toMs(now);
  const horizonDays = Number(ap.horizonDays) > 0 ? Number(ap.horizonDays) : 7;
  const endMs = nowMs + horizonDays * DAY_MS;
  const minGapHours = Number.isFinite(Number(ap.minGapHours)) ? Number(ap.minGapHours) : 20;
  const target = Math.max(1, Math.round((perWeek * horizonDays) / 7));
  const postList = toList(posts);

  const planned = postList.filter((p) => {
    if (p.status !== 'scheduled' && p.status !== 'draft') return false;
    const t = parseTimestamp(p.scheduledAt);
    return Number.isFinite(t) && t > nowMs && t <= endMs;
  }).length;
  const needed = target - planned;
  const days = `${horizonDays} day${horizonDays === 1 ? '' : 's'}`;
  if (needed <= 0) return { create: [], reason: `The next ${days} already have ${planned} posts planned.`, code: 'full' };

  const allowed = new Set(Array.isArray(ap.allowedTypes) && ap.allowedTypes.length ? ap.allowedTypes : ['feed', 'carousel', 'reel']);
  const unused = unusedAssets(assets, postList);
  const pool = unused.filter((a) => a.autopilot === true);
  if (ap.useAllUnused) {
    // Media of a rejected draft stays out of the fallback; marking it for autopilot again brings it back.
    const rejected = new Set();
    for (const p of postList) {
      if (p.status !== 'canceled' || !(p.history || []).some((h) => h && h.event === 'rejected')) continue;
      for (const m of p.media || []) rejected.add(m.assetId);
    }
    pool.push(...unused.filter((a) => a.autopilot !== true && !rejected.has(a.id)));
  }
  const groups = groupAssets(pool, allowed);
  if (!groups.length) {
    return {
      create: [],
      reason: 'No unused media is marked for autopilot. Send photos or videos to autopilot from the library.',
      code: 'no_assets',
    };
  }

  const gapMs = minGapHours * HOUR_MS;
  const taken = [];
  for (const p of postList) {
    const active = ACTIVE_STATUSES.has(p.status);
    if (!active && p.status !== 'published') continue;
    const t = parseTimestamp(active ? p.scheduledAt : p.publishedAt || p.scheduledAt);
    if (Number.isFinite(t) && t >= nowMs - gapMs && t <= endMs + gapMs) taken.push(iso(t));
  }
  const fixed = ap.slotStrategy === 'fixed' && Array.isArray(ap.fixedSlots) && ap.fixedSlots.length ? ap.fixedSlots : null;
  const slots = suggestSlots({
    matrix,
    tz,
    now: nowMs,
    count: Math.min(needed, groups.length),
    horizonDays,
    minGapHours,
    taken,
    fixedSlots: fixed,
    maxPerDay: fixed ? null : Math.max(1, Math.ceil(perWeek / 7)),
  });
  if (!slots.length) {
    return {
      create: [],
      reason: `No free time slots in the next ${days}. Lower the minimum gap between posts or add time slots.`,
      code: 'no_slots',
    };
  }
  const create = slots.map((scheduledAt, i) => ({ ...groups[i], scheduledAt }));
  let reason = `Planned ${create.length} post${create.length === 1 ? '' : 's'}.`;
  if (create.length < needed && groups.length < needed) reason += ' Add more media to autopilot to fill the queue.';
  else if (create.length < needed) reason += ' Not enough free time slots for more.';
  return { create, reason, code: 'planned' };
}

/**
 * Best-performing published media worth posting again: older than afterDays, not a story, not
 * itself a repost, and not recycled within the last afterDays (posts carry `recycleOf: <media id>`).
 * Ranked by engagement rate, then interactions.
 * @param {{mediaStats: object|Array, posts?: object[], now?: any, afterDays?: number, count?: number, followers?: number}} args
 * @returns {object[]} MediaStats, best first
 */
export function recyclePicks({ mediaStats, posts = [], now, afterDays = 120, count = 1, followers } = {}) {
  const nowMs = toMs(now);
  const cutoff = nowMs - Math.max(0, afterDays) * DAY_MS;
  const recent = new Set();
  const reposts = new Set();
  for (const p of toList(posts)) {
    if (p.source === 'recycle' && p.igMediaId) reposts.add(p.igMediaId);
    if (!p.recycleOf || p.status === 'canceled') continue;
    const t = parseTimestamp(p.scheduledAt || p.publishedAt || p.createdAt);
    if (!Number.isFinite(t) || t >= cutoff) recent.add(p.recycleOf);
  }
  return toList(mediaStats)
    .filter((m) => m.id && m.productType !== 'STORY' && !recent.has(m.id) && !reposts.has(m.id))
    .filter((m) => {
      const t = parseTimestamp(m.timestamp);
      return Number.isFinite(t) && t <= cutoff;
    })
    .map((m) => ({ m, er: engagementRate(m, followers), inter: interactionsOf(m) }))
    .filter(({ er, inter }) => er != null || inter != null)
    .sort((a, b) => (b.er ?? -1) - (a.er ?? -1) || (b.inter ?? -1) - (a.inter ?? -1))
    .slice(0, Math.max(0, count))
    .map(({ m }) => m);
}
