import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv } from '../helpers/worker-env.mjs';
import { dayKey } from '../../core/time.js';
import { breakdownDaysFor, handPostedLinks, hasBreakdowns, mediaDue, mediaToRefresh, repullSince, sharedListing, shortcodeOf, updateHistory } from '../../worker/jobs/analytics.mjs';
import { newPost } from '../../core/model.js';
import { captureDue } from '../../worker/jobs/stories.mjs';
import { HISTORY_FROZEN_POINTS, valueAtAge } from '../../core/analytics.js';

test('stories are captured with their insights', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const res = await env.run({ only: ['stories'] });
  assert.equal(res.exitCode, 0);
  const doc = await env.read('analytics-stories');
  const stories = Object.values(doc.stories);
  assert.equal(stories.length, env.graph.state.stories.length);
  for (const s of stories) {
    assert.ok(s.firstSeenAt && s.capturedAt && s.timestamp);
    assert.ok(s.metrics.reach > 0);
    assert.ok(s.metrics.navigation, 'navigation breakdown captured');
  }
  assert.ok(res.lines.includes(`stories: ${stories.length} stories`));

  // Within the hour nothing is re-fetched or written...
  const before = env.ghMock.stats.writes;
  const again = await env.run({ only: ['stories'] });
  assert.equal(again.summary.jobs.stories.stories, 0);
  assert.equal(env.ghMock.stats.writes, before, 'no new commit for an unchanged story set');
});

test('the daily account snapshot is written once per local day', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const res = await env.run({ only: ['analytics'] });
  assert.equal(res.exitCode, 0);
  const daily = await env.read('analytics-daily');
  const today = dayKey(new Date(), 'UTC');
  assert.equal(daily.lastDailyRun, today);
  assert.equal(daily.days[today].followers, env.graph.state.followers);
  const keys = Object.keys(daily.days).sort();
  assert.ok(keys.length >= 20, `first run backfills about four weeks (${keys.length} days)`);
  const yesterday = daily.days[keys[keys.length - 2]];
  assert.ok(yesterday.reach > 0 && yesterday.capturedAt);

  const media = await env.read('analytics-media');
  const items = Object.values(media.media);
  assert.ok(items.length > 10);
  assert.ok(items.some((m) => m.metrics && m.metrics.reach > 0));
  const audience = await env.read('audience');
  assert.ok(audience.fetchedAt);
  assert.equal(audience.onlineFollowers.byHour.length, 24);
  assert.ok(audience.demographics.follower.age.length > 0);
  assert.ok(res.summary.jobs.analytics.snapshots > 0);

  // Second run the same day: no account insights, no audience calls.
  const userId = env.graph.state.userId;
  const mark = env.graph.state.requests.length;
  const again = await env.run({ only: ['analytics'] });
  const accountCalls = env.graph.state.requests.slice(mark).filter((r) => r.path.endsWith(`${userId}/insights`));
  assert.equal(accountCalls.length, 0);
  assert.equal(again.summary.jobs.analytics.snapshots, 0);
  const daily2 = await env.read('analytics-daily');
  assert.equal(daily2.days[today].capturedAt, daily.days[today].capturedAt);
});

test('a rate-limited weekly audience fetch keeps last week\'s data and is retried hours later, not in a week', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.run({ only: ['analytics'] });
  const before = await env.read('audience');
  assert.ok(before.fetchedAt && before.demographics.follower);

  const audienceMetric = (p) => /online_followers|demographics/.test(String(p.metric || ''));
  let calls = 0;
  // Counts audience requests (never matches, so it injects nothing).
  const counter = { method: 'GET', path: /\/insights$/, when: (p) => void (calls += audienceMetric(p) ? 1 : 0) };
  const limited = { method: 'GET', path: /\/insights$/, when: audienceMetric, error: { code: 4, status: 400, message: 'Application request limit reached' } };
  env.graph.state.faults.push(counter, limited);
  const week = Date.now() + 8 * 864e5;
  await env.run({ only: ['analytics'], now: week });
  const failed = await env.read('audience');
  assert.equal(failed.fetchedAt, before.fetchedAt, 'a failed attempt does not restart the weekly wait');
  assert.deepEqual(failed.demographics, before.demographics, 'demographics are not wiped');
  assert.deepEqual(failed.onlineFollowers, before.onlineFollowers);
  assert.ok(failed.lastAttemptAt);

  // An hour later the attempt is not repeated yet.
  calls = 0;
  await env.run({ only: ['analytics'], now: week + 36e5 });
  assert.equal(calls, 0);

  // Hours later, with Instagram back to normal, the audience is refreshed.
  env.graph.state.faults.splice(env.graph.state.faults.indexOf(limited), 1);
  await env.run({ only: ['analytics'], now: week + 7 * 36e5 });
  assert.ok(calls > 0);
  env.graph.state.faults.length = 0;
  const after = await env.read('audience');
  assert.ok(Date.parse(after.fetchedAt) > Date.parse(before.fetchedAt));
  assert.ok(after.demographics.follower);
});

test('media refresh cadence: young often, older daily, old weekly', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ago = (h) => new Date(now - h * 36e5).toISOString();
  assert.equal(mediaDue({ timestamp: ago(5) }, null, now), true);
  assert.equal(mediaDue({ timestamp: ago(5) }, { fetchedAt: ago(0.5) }, now), false);
  assert.equal(mediaDue({ timestamp: ago(5) }, { fetchedAt: ago(1.1) }, now), true);
  assert.equal(mediaDue({ timestamp: ago(24 * 10) }, { fetchedAt: ago(10) }, now), false);
  assert.equal(mediaDue({ timestamp: ago(24 * 10) }, { fetchedAt: ago(21) }, now), true);
  assert.equal(mediaDue({ timestamp: ago(24 * 60) }, { fetchedAt: ago(24 * 3) }, now), false);
  assert.equal(mediaDue({ timestamp: ago(24 * 60) }, { fetchedAt: ago(24 * 8) }, now), true);
});

test('competitors need Facebook Login; in facebook mode they are snapshotted daily', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('competitors', (d) => {
    d.accounts = [{ username: 'rival.studio' }];
  });
  const res = await env.run({ only: ['competitors'] });
  assert.equal(res.summary.jobs.competitors.skipped, 'needs_facebook_login');
  assert.equal((await env.read('competitors')).status, 'needs_facebook_login');

  const fb = await startWorkerEnv({ mode: 'facebook', token: 'fb-user-token' });
  t.after(() => fb.close());
  await fb.update('competitors', (d) => {
    d.accounts = ['@Atelier.Kin', { username: 'no.such.account' }];
  });
  const r2 = await fb.run({ only: ['competitors'] });
  assert.equal(r2.summary.jobs.competitors.competitors, 1);
  const doc = await fb.read('competitors');
  const today = dayKey(new Date(), 'UTC');
  const snap = doc.snapshots['atelier.kin'][today];
  assert.equal(snap.followers, 12480);
  assert.ok(snap.avgLikes > 0 && snap.er > 0);
  assert.equal(doc.posts['atelier.kin'].length, 12);
  assert.equal(doc.profiles['atelier.kin'].name, 'Atelier Kin');
  assert.match(doc.errors['no.such.account'].message, /could not find/);
  assert.equal(doc.status, 'ok');
  const r3 = await fb.run({ only: ['competitors'] });
  assert.equal(r3.summary.jobs.competitors.competitors, 0, 'once per day');
});

test('competitors removed in the app during the daily fetch are not brought back', async (t) => {
  const fb = await startWorkerEnv({ mode: 'facebook', token: 'fb-user-token' });
  t.after(() => fb.close());
  await fb.update('competitors', (d) => {
    d.accounts = ['atelier.kin', 'no.such.account'];
  });
  // The owner removes both accounts while the worker is reading Business Discovery.
  const real = fb.graph.handle;
  let removed = false;
  fb.graph.handle = async (req, res, sub, body, url) => {
    if (!removed && /business_discovery/.test(decodeURIComponent(sub))) {
      removed = true;
      await fb.update('competitors', (d) => {
        d.accounts = [];
        for (const k of ['snapshots', 'posts', 'profiles', 'errors']) if (d[k]) for (const u of ['atelier.kin', 'no.such.account']) delete d[k][u];
      });
    }
    return real(req, res, sub, body, url);
  };
  await fb.run({ only: ['competitors'] });
  fb.graph.handle = real;
  assert.ok(removed);
  const doc = await fb.read('competitors');
  assert.deepEqual(doc.accounts, []);
  for (const k of ['snapshots', 'posts', 'profiles', 'errors']) {
    assert.equal(doc[k]?.['atelier.kin'], undefined, `${k} not restored`);
    assert.equal(doc[k]?.['no.such.account'], undefined, `${k} not restored`);
  }
});

test('media refresh cadence: posts 2 to 7 days old every 6 hours', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ago = (h) => new Date(now - h * 36e5).toISOString();
  assert.equal(mediaDue({ timestamp: ago(24 * 4) }, { fetchedAt: ago(5) }, now), false);
  assert.equal(mediaDue({ timestamp: ago(24 * 4) }, { fetchedAt: ago(6.1) }, now), true);
  assert.equal(mediaDue({ timestamp: ago(24 * 8) }, { fetchedAt: ago(7) }, now), false, 'daily again after a week');
});

test('breakdown calls only for days that lack them, plus the settled oldest day', () => {
  const stored = { '2026-10-09': { reach: 1, viewsByType: { POST: 1 } }, '2026-10-10': { reach: 1, reachFollowers: 3 }, '2026-10-11': { reach: 1 } };
  assert.deepEqual(breakdownDaysFor(stored, '2026-10-09', '2026-10-11'), ['2026-10-09', '2026-10-11']);
  assert.deepEqual(breakdownDaysFor({}, '2026-10-10', '2026-10-11'), ['2026-10-10', '2026-10-11']);
  assert.equal(hasBreakdowns({ reach: 3 }), false);
});

test('daily snapshots carry reach and views breakdowns; the next day asks for them only where needed', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const userId = env.graph.state.userId;
  const breakdownCalls = (from) => env.graph.state.requests.slice(from).filter((r) => r.path.endsWith(`${userId}/insights`) && /media_product_type|follow_type|follower_type/.test(r.params.breakdown || '') && /reach|views/.test(r.params.metric || ''));
  let mark = env.graph.state.requests.length;
  await env.run({ only: ['analytics'] });
  const first = breakdownCalls(mark).length;
  const daily = await env.read('analytics-daily');
  const keys = Object.keys(daily.days).sort();
  const yesterday = daily.days[keys[keys.length - 2]];
  assert.ok(yesterday.reachByType && yesterday.reachByType.REEL > 0, 'reach by format');
  assert.ok(yesterday.viewsByType && Object.keys(yesterday.viewsByType).length >= 3, 'views by format');
  for (const f of ['reachFollowers', 'reachNonFollowers', 'viewsFollowers', 'viewsNonFollowers']) assert.equal(typeof yesterday[f], 'number', f);
  assert.equal(yesterday.reachFollowers + yesterday.reachNonFollowers, yesterday.reach);
  assert.ok(first >= 2 * 27, `about 2-3 breakdown calls per backfilled day (${first})`);

  // Next day: only yesterday (new) and the oldest re-pulled day (settled), 3 calls each.
  mark = env.graph.state.requests.length;
  await env.run({ only: ['analytics'], now: Date.now() + 864e5 });
  const second = breakdownCalls(mark);
  const days = new Set(second.map((r) => r.params.since));
  assert.equal(days.size, 2, 'two days get breakdowns');
  assert.equal(second.length, 2 * 3, `bounded breakdown calls (${second.length})`);
});

test('breakdown failures are not fatal: totals are kept when Instagram rate-limits the breakdowns', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  env.graph.state.faults.push({ method: 'GET', path: /\/insights$/, when: (p) => /media_product_type|follower_type/.test(String(p.breakdown || '')) || (p.breakdown === 'follow_type' && /reach/.test(String(p.metric || ''))), error: { code: 4, status: 400, message: 'Application request limit reached' } });
  const res = await env.run({ only: ['analytics'] });
  assert.equal(res.exitCode, 0);
  const daily = await env.read('analytics-daily');
  const keys = Object.keys(daily.days).sort();
  const yesterday = daily.days[keys[keys.length - 2]];
  assert.ok(yesterday.reach > 0 && yesterday.followsGained >= 0, 'totals saved');
  assert.equal(yesterday.reachByType, undefined);
  assert.equal(daily.lastDailyRun, keys[keys.length - 1]);
});

test('per-post history: a point per refresh of young posts, deduplicated, thinned and pruned', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('analytics-media-history', (d) => {
    d.media.gone = { points: [{ t: new Date().toISOString(), v: 1 }] };
  });
  env.graph.state.media[0].timestamp = Date.now() - 2 * 36e5; // a post from 2 hours ago (refreshed hourly, history hourly in its first 6 hours)
  const res = await env.run({ only: ['analytics'] });
  assert.ok(res.summary.jobs.analytics.historyPoints > 0);
  const media = (await env.read('analytics-media')).media;
  let hist = (await env.read('analytics-media-history')).media;
  assert.equal(hist.gone, undefined, 'history of media no longer in analytics-media is dropped');
  const young = Object.values(media).filter((m) => Date.now() - Date.parse(m.timestamp) < 30 * 864e5);
  const old = Object.values(media).filter((m) => Date.now() - Date.parse(m.timestamp) >= 30 * 864e5);
  assert.ok(young.length > 0 && old.length > 0);
  for (const m of young) {
    assert.equal(hist[m.id].points.length, 1, 'one point for each young post');
    const p = hist[m.id].points[0];
    assert.match(p.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(p.r, m.metrics.reach);
    if (m.metrics.views != null) assert.equal(p.v, m.metrics.views);
  }
  for (const m of old) assert.equal(hist[m.id], undefined, 'no points for posts older than 30 days');

  // An hour later the newest post is refreshed again; unchanged numbers add no point.
  const newest = young.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  assert.equal(newest.id, env.graph.state.media[0].id);
  await env.run({ only: ['analytics'], now: Date.now() + 65 * 60e3 });
  hist = (await env.read('analytics-media-history')).media;
  assert.equal(hist[newest.id].points.length, 1, 'unchanged and under 3 hours old: skipped');
  // New numbers add a point.
  const node = env.graph.state.media[0];
  node.ins.reach += 50;
  await env.run({ only: ['analytics'], now: Date.now() + 130 * 60e3 });
  hist = (await env.read('analytics-media-history')).media;
  assert.equal(hist[newest.id].points.length, 2);
  assert.equal(hist[newest.id].points[1].r, node.ins.reach);
  // Unchanged but 3 hours after the last point: added (keeps the curve's time axis honest).
  await env.run({ only: ['analytics'], now: Date.now() + 320 * 60e3 });
  assert.equal((await env.read('analytics-media-history')).media[newest.id].points.length, 3);

  // Thinning keeps at most 48 points, the first and the last among them.
  const id = young[0].id;
  const start = Date.parse(young[0].timestamp);
  await env.update('analytics-media-history', (d) => {
    d.media[id] = { points: Array.from({ length: 48 }, (_, i) => ({ t: new Date(start + (i + 1) * 36e5).toISOString().replace(/\.\d{3}Z$/, 'Z'), v: i, r: i })) };
  });
  const firstT = new Date(start + 36e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await env.update('analytics-media', (d) => {
    d.media[id].fetchedAt = new Date(Date.now() - 30 * 864e5).toISOString();
  });
  await env.run({ only: ['analytics'], now: Date.now() + 10 * 36e5 });
  const pts = (await env.read('analytics-media-history')).media[id].points;
  assert.equal(pts.length, 48);
  assert.equal(pts[0].t, firstT);
  assert.ok(Date.parse(pts[47].t) > Date.now(), 'the new point is the last one');
});

// ---- history write rate (updateHistory) ----------------------------------------------------------

const NOW = Date.parse('2026-10-12T12:00:00Z');
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hoursAgo = (h) => isoAt(NOW - h * 36e5);
const entry = (id, ageH, views, fetchedAgoH = 0) => ({ id, timestamp: hoursAgo(ageH), metrics: { views, reach: Math.round(views / 2) }, fetchedAt: hoursAgo(fetchedAgoH) });

test('updateHistory: written at most every 3 hours, hourly in a post\'s first 6 hours, at once for a first point', () => {
  const hist = { v: 1, updatedAt: hoursAgo(1.5), media: { a: { points: [{ t: hoursAgo(1.5), v: 100, r: 50 }] } } };
  // A 10-hour-old post refreshed now, 1.5 hours after the last write: held back.
  const media = { a: entry('a', 10, 140) };
  assert.equal(updateHistory(hist, media, { nowMs: NOW, nowIso: isoAt(NOW), refreshed: new Map([['a', media.a.metrics]]) }), null);
  // 3 hours after the last write: written.
  const later = { ...hist, updatedAt: hoursAgo(3), media: { a: { points: [{ t: hoursAgo(3), v: 100, r: 50 }] } } };
  const res = updateHistory(later, media, { nowMs: NOW, nowIso: isoAt(NOW), refreshed: new Map([['a', media.a.metrics]]) });
  assert.equal(res.added, 1);
  assert.equal(res.doc.updatedAt, isoAt(NOW));
  assert.deepEqual(res.doc.media.a.points.at(-1), { t: isoAt(NOW), v: 140, r: 70 });

  // A 4-hour-old post: hourly.
  const young = { b: entry('b', 4, 300) };
  const h2 = { v: 1, updatedAt: hoursAgo(1.05), media: { b: { points: [{ t: hoursAgo(1.05), v: 200, r: 100 }] } } };
  assert.equal(updateHistory(h2, young, { nowMs: NOW, nowIso: isoAt(NOW), refreshed: new Map([['b', young.b.metrics]]) }).added, 1);
  assert.equal(updateHistory({ ...h2, updatedAt: hoursAgo(0.5) }, young, { nowMs: NOW, nowIso: isoAt(NOW), refreshed: new Map([['b', young.b.metrics]]) }), null, 'not twice an hour');

  // A brand-new post gets its first point at once, and the other due points come along.
  const both = { a: media.a, c: entry('c', 0.3, 20) };
  const h3 = { v: 1, updatedAt: hoursAgo(0.2), media: { a: { points: [{ t: hoursAgo(2), v: 100, r: 50 }] } } };
  const r3 = updateHistory(h3, both, { nowMs: NOW, nowIso: isoAt(NOW), refreshed: new Map([['a', both.a.metrics], ['c', both.c.metrics]]) });
  assert.equal(r3.added, 2);
  assert.equal(r3.doc.media.c.points.length, 1);
});

test('updateHistory: a refresh held back by the write limit is saved at the next write; failed refreshes add nothing', () => {
  // Refreshed 2 hours ago (point held back), not refreshed in this run: its saved numbers become the point.
  const media = { a: entry('a', 50, 900, 2), b: entry('b', 50, 500, 2) };
  const hist = { v: 1, updatedAt: hoursAgo(4), media: { a: { points: [{ t: hoursAgo(8), v: 800, r: 400 }] }, b: { points: [{ t: hoursAgo(8), v: 500, r: 250 }] } } };
  const res = updateHistory(hist, media, { nowMs: NOW, nowIso: isoAt(NOW), refreshed: new Map() });
  assert.equal(res.added, 1);
  assert.deepEqual(res.doc.media.a.points.at(-1), { t: hoursAgo(2), v: 900, r: 450 }, 'dated when it was read');
  assert.equal(res.doc.media.b.points.length, 1, 'unchanged numbers from an earlier run (maybe a failed refresh) add no point');
  // A refresh that failed in this run (empty insights) adds nothing either.
  const failed = { a: { ...entry('a', 50, 800), metrics: { views: 800, reach: 400 } } };
  const h2 = { v: 1, updatedAt: hoursAgo(4), media: { a: { points: [{ t: hoursAgo(8), v: 700, r: 350 }] } } };
  assert.equal(updateHistory(h2, failed, { nowMs: NOW, nowIso: isoAt(NOW), refreshed: new Map([['a', {}]]) }), null);
});

test('updateHistory: posts past 30 days are thinned to 20 points with their 24 h and 7-day values; old and gone media dropped', () => {
  const views = (h) => Math.round(20000 * (1 - Math.exp(-h / 40)));
  const ageH = 31 * 24;
  const pts = [];
  for (let h = 0.3; h < 720; h += h < 48 ? 1 : h < 168 ? 6 : 24) pts.push({ t: hoursAgo(ageH - h), v: views(h) });
  const media = { old: { id: 'old', timestamp: hoursAgo(ageH), metrics: { views: 1 }, fetchedAt: hoursAgo(1) }, ancient: { id: 'ancient', timestamp: hoursAgo(91 * 24), metrics: {}, fetchedAt: hoursAgo(1) } };
  const hist = { v: 1, updatedAt: hoursAgo(5), media: { old: { points: pts }, ancient: { points: [{ t: hoursAgo(90 * 24), v: 1 }] }, gone: { points: [{ t: hoursAgo(5), v: 1 }] } } };
  const res = updateHistory(hist, media, { nowMs: NOW, nowIso: isoAt(NOW) });
  assert.equal(res.added, 0);
  assert.deepEqual(Object.keys(res.doc.media), ['old']);
  const thin = res.doc.media.old.points;
  assert.equal(thin.length, HISTORY_FROZEN_POINTS);
  assert.equal(thin[0], pts[0]);
  assert.equal(thin.at(-1), pts.at(-1));
  const t0 = media.old.timestamp;
  assert.equal(valueAtAge(thin, t0, 24), valueAtAge(pts, t0, 24));
  assert.equal(valueAtAge(thin, t0, 168), valueAtAge(pts, t0, 168));
  // Nothing left to do: no write.
  assert.equal(updateHistory({ ...res.doc, updatedAt: hoursAgo(5) }, media, { nowMs: NOW, nowIso: isoAt(NOW) }), null);
  // Pruning waits for the write limit too.
  assert.equal(updateHistory({ ...hist, updatedAt: hoursAgo(1) }, media, { nowMs: NOW, nowIso: isoAt(NOW) }), null);
});

test('history write volume: about 12 writes a day and a bounded document at one post a day', () => {
  // Replays the refresh cadence (mediaDue) and updateHistory with a run every 10 minutes for 100 days.
  const start = Date.parse('2026-06-01T00:00:00Z');
  const posts = Array.from({ length: 100 }, (_, d) => ({ id: String(1e9 + d), timestamp: new Date(start + d * 864e5 + 15 * 36e5).toISOString() }));
  const views = (h) => Math.round(20000 * (1 - Math.exp(-h / 40)));
  const md = {};
  let hist = { v: 1, media: {} };
  const writes = {};
  for (let t = start; t < start + 100 * 864e5; t += 10 * 60e3) {
    const due = posts.filter((p) => Date.parse(p.timestamp) <= t && mediaDue(p, md[p.id], t)).slice(0, 60);
    if (!due.length) continue;
    const refreshed = new Map();
    for (const p of due) {
      const v = views((t - Date.parse(p.timestamp)) / 36e5);
      md[p.id] = { id: p.id, timestamp: p.timestamp, metrics: { views: v, reach: Math.round(v * 0.55), likes: Math.round(v * 0.04), comments: Math.round(v * 0.003), saved: Math.round(v * 0.005), shares: Math.round(v * 0.002), follows: Math.round(v * 0.0005) }, fetchedAt: new Date(t).toISOString() };
      refreshed.set(p.id, md[p.id].metrics);
    }
    const res = updateHistory(hist, md, { nowMs: t, nowIso: new Date(t).toISOString(), refreshed });
    if (res) {
      hist = res.doc;
      const day = new Date(t).toISOString().slice(0, 10);
      writes[day] = (writes[day] || 0) + 1;
    }
  }
  const last = Object.keys(writes).sort().slice(-5).map((d) => writes[d]);
  assert.ok(last.every((n) => n <= 13), `writes per day: ${last.join(', ')}`);
  const bytes = JSON.stringify(hist).length;
  assert.ok(bytes < 230_000, `history document of ${bytes} bytes for 90 posts`);
  const lens = Object.entries(hist.media).map(([id, h]) => [Date.parse(posts.find((p) => p.id === id).timestamp), h.points.length]);
  assert.ok(lens.filter(([ts]) => start + 100 * 864e5 - ts > 31 * 864e5).every(([, n]) => n <= HISTORY_FROZEN_POINTS), 'old posts keep 20 points');
});

test('the daily re-pull fills a gap back to the last saved day (at most 28 days)', () => {
  assert.equal(repullSince({}, '2026-10-12'), '2026-09-14', 'first run: 28 days');
  assert.equal(repullSince({ '2026-10-11': { reach: 5 } }, '2026-10-12'), '2026-10-09', 'normal day: the last 3 days');
  assert.equal(repullSince({ '2026-10-01': { reach: 5 }, '2026-10-12': { followers: 9 } }, '2026-10-12'), '2026-10-02', 'stopped for 10 days');
  assert.equal(repullSince({ '2026-08-01': { views: 5 } }, '2026-10-12'), '2026-09-14', 'at most 28 days');
  assert.equal(repullSince({ '2026-10-10': { followers: 4 } }, '2026-10-12'), '2026-09-14', 'a follower count alone is not a saved day');
});

test('after the worker was stopped, the next daily snapshot fills the missing days', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  // Last run 10 days ago (the mock serves only days up to today), then nothing until now.
  const now = Date.now();
  await env.run({ only: ['analytics'], now: now - 10 * 864e5 });
  const before = await env.read('analytics-daily');
  const gap = Array.from({ length: 10 }, (_, i) => dayKey(new Date(now - (i + 1) * 864e5), 'UTC'));
  assert.ok(gap.every((k) => !(before.days[k] && before.days[k].reach > 0)), 'the last 10 days are missing');
  await env.run({ only: ['analytics'], now });
  const daily = await env.read('analytics-daily');
  assert.deepEqual(gap.filter((k) => !(daily.days[k] && daily.days[k].reach > 0)), [], 'the gap is filled');
});

const typeOf = (m) => (m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'reel' : 'feed');
const isoAtMs = (t) => new Date(t).toISOString();

test('posts marked as posted by hand are linked to their Instagram media, by their link or else by time', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  const [m0, m1, m2] = st.media;
  const byLinkMedia = st.media[5];
  const posts = {
    // The pasted link decides, even far from the planned time.
    byLink: newPost({ type: typeOf(byLinkMedia), status: 'published', publishMode: 'reminder', scheduledAt: isoAtMs(byLinkMedia.timestamp - 864e5), publishedAt: isoAtMs(byLinkMedia.timestamp - 864e5), permalink: ` https://www.instagram.com/p/${byLinkMedia.shortcode}/?igsh=abc ` }),
    // No link: the media of the same kind published within 2 hours after the reminder.
    byTime: newPost({ type: typeOf(m0), status: 'published', publishMode: 'reminder', scheduledAt: isoAtMs(m0.timestamp - 40 * 60e3), reminderSentAt: isoAtMs(m0.timestamp - 39 * 60e3), publishedAt: isoAtMs(m0.timestamp + 5 * 60e3) }),
    // Published by Postpilot: its media is not free.
    taken: newPost({ type: typeOf(m1), status: 'published', igMediaId: m1.id, publishedAt: isoAtMs(m1.timestamp) }),
    near: newPost({ type: typeOf(m1), status: 'published', publishMode: 'reminder', scheduledAt: isoAtMs(m1.timestamp - 10 * 60e3) }),
    // A link to someone else's post: no guessing by time.
    wrongLink: newPost({ type: typeOf(m2), status: 'published', publishMode: 'reminder', scheduledAt: isoAtMs(m2.timestamp - 10 * 60e3), permalink: 'https://www.instagram.com/p/NotOurs123/' }),
    story: newPost({ type: 'story', status: 'published', publishMode: 'reminder', scheduledAt: isoAtMs(m0.timestamp - 10 * 60e3) }),
  };
  await env.update('posts', (d) => void d.posts.push(...Object.values(posts)));
  const res = await env.run({ only: ['analytics'] });
  assert.equal(res.summary.jobs.analytics.linked, 2);
  const after = Object.fromEntries((await env.read('posts')).posts.map((p) => [p.id, p]));
  const got = (k) => after[posts[k].id];
  assert.equal(got('byLink').igMediaId, byLinkMedia.id);
  assert.equal(got('byLink').permalink, posts.byLink.permalink, 'the pasted link is kept');
  assert.equal(got('byTime').igMediaId, m0.id);
  assert.match(got('byTime').permalink, new RegExp(m0.shortcode));
  assert.equal(got('byTime').history.at(-1).event, 'linked');
  assert.equal(got('byTime').status, 'published');
  const sched = Date.parse(posts.near.scheduledAt);
  const other = st.media.find((x) => x.id !== m1.id && x.id !== m0.id && typeOf(x) === typeOf(m1) && x.timestamp >= sched && x.timestamp - sched <= 2 * 36e5);
  assert.equal(got('near').igMediaId, other ? other.id : null, 'never the media another post has');
  assert.equal(got('wrongLink').igMediaId, null);
  assert.equal(got('story').igMediaId, null);
  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'analytics' && /Found 2 posts you posted by hand/.test(e.message)));

  // Nothing more to link: the posts are left alone.
  const again = await env.run({ only: ['analytics'] });
  assert.equal(again.summary.jobs.analytics.linked, undefined);
  const later = (await env.read('posts')).posts.find((p) => p.id === posts.byTime.id);
  assert.deepEqual(later.history, got('byTime').history);
});

test('handPostedLinks: closest pairs first, each media once, posts by Postpilot and stories left out', () => {
  const T = Date.parse('2026-10-12T12:00:00Z');
  const media = [
    { id: 'm3', mediaType: 'IMAGE', timestamp: isoAtMs(T + 100 * 60e3), shortcode: 'C3', permalink: 'https://www.instagram.com/p/C3/' },
    { id: 'm2', mediaType: 'IMAGE', timestamp: isoAtMs(T + 20 * 60e3), shortcode: 'C2', permalink: 'https://www.instagram.com/p/C2/' },
    { id: 'm1', mediaType: 'VIDEO', productType: 'REELS', timestamp: isoAtMs(T + 5 * 60e3), shortcode: 'C1', permalink: 'https://www.instagram.com/reel/C1/' },
    { id: 'm0', mediaType: 'IMAGE', timestamp: isoAtMs(T - 3 * 36e5), shortcode: 'C0' },
  ];
  const post = (id, extra) => ({ id, type: 'feed', status: 'published', igMediaId: null, scheduledAt: isoAtMs(T), ...extra });
  const links = handPostedLinks(
    [
      post('a', { scheduledAt: isoAtMs(T + 15 * 60e3) }), // m2 is 5 minutes after
      post('b'), // m2 is 20 minutes after, but a is closer; m3 is 100 minutes after
      post('c', { type: 'reel' }), // m1
      post('d', { scheduledAt: isoAtMs(T - 6 * 36e5), publishedAt: isoAtMs(T - 3 * 36e5 + 10 * 60e3) }), // marked as posted 10 minutes after m0
      post('e', { status: 'reminded' }),
      post('f', { type: 'story' }),
      post('g', { igMediaId: 'm9' }),
      post('h', { permalink: 'https://instagram.com/reel/C3' }), // by link, whatever the time
    ],
    media,
  );
  const map = Object.fromEntries(links.map((l) => [l.postId, l.media.id]));
  assert.deepEqual(map, { h: 'm3', a: 'm2', c: 'm1', d: 'm0' });
  assert.equal(shortcodeOf('https://www.instagram.com/studio.north/p/AbC_1-x/?img_index=2'), 'AbC_1-x');
  assert.equal(shortcodeOf('instagram.com/reels/XyZ'), 'XyZ');
  assert.equal(shortcodeOf('https://example.com/p/abc'), null);
});

test('media deleted from Instagram is flagged deletedAt, archived media unlistedAt, and both clear when listed again', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  await env.run({ only: ['analytics'] });
  const [gone, viaApp, archived] = [st.media[1], st.media[3], st.media[4]];
  const fullList = st.media.slice();
  // Deleted in Instagram, deleted with "Delete from Instagram" in the app, archived (hidden from the listing).
  st.media = st.media.filter((m) => ![gone.id, viaApp.id, archived.id].includes(m.id));
  st.nodes.delete(gone.id);
  await env.update('posts', (d) => void d.posts.push(newPost({ type: typeOf(viaApp), status: 'canceled', igMediaId: viaApp.id, deletedFromInstagramAt: new Date().toISOString() })));
  const mark = st.requests.length;
  const res = await env.run({ only: ['analytics'], now: Date.now() + 36e5 });
  assert.equal(res.summary.jobs.analytics.deletedMedia, 2);
  let md = (await env.read('analytics-media')).media;
  assert.ok(md[gone.id].deletedAt && md[gone.id].metrics.reach > 0, 'flagged, numbers kept');
  assert.ok(md[viaApp.id].deletedAt);
  assert.ok(md[archived.id].unlistedAt && !md[archived.id].deletedAt);
  assert.equal(Object.values(md).filter((m) => m.deletedAt || m.unlistedAt).length, 3);
  const lookups = st.requests.slice(mark).filter((r) => r.method === 'GET' && /\/\d+$/.test(r.path)).map((r) => r.path.split('/').pop());
  assert.deepEqual(lookups.sort(), [gone.id, archived.id].sort(), 'the app-deleted one needs no lookup');

  // Not looked up again within a day.
  const mark2 = st.requests.length;
  await env.run({ only: ['analytics'], now: Date.now() + 2 * 36e5 });
  assert.ok(!st.requests.slice(mark2).some((r) => r.path.endsWith(`/${archived.id}`) || r.path.endsWith(`/${gone.id}`)));

  // Back from the archive: listed again, the flag goes.
  st.media = fullList.filter((m) => m.id !== gone.id && m.id !== viaApp.id);
  await env.run({ only: ['analytics'], now: Date.now() + 3 * 36e5 });
  md = (await env.read('analytics-media')).media;
  assert.ok(!md[archived.id].unlistedAt && !md[archived.id].deletedAt);
  assert.ok(md[gone.id].deletedAt && md[viaApp.id].deletedAt);
});

test('analytics reuses the automations listing: one media listing per run once its posts are known', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  const listings = (from) => st.requests.slice(from).filter((r) => r.method === 'GET' && r.path.endsWith(`/${st.userId}/media`)).length;
  await env.run({ only: ['automations', 'analytics'] });
  await env.run({ only: ['automations', 'analytics'] }); // the 10 oldest posts were left for this run (60 per run)
  const mark = st.requests.length;
  const res = await env.run({ only: ['automations', 'analytics'] });
  assert.equal(listings(mark), 1, 'only the automations listing');
  assert.ok(res.summary.jobs.analytics);
  // A week later the posts beyond the first 50 are due: analytics lists the newest 100 itself.
  const mark2 = st.requests.length;
  await env.run({ only: ['automations', 'analytics'], now: Date.now() + 8 * 864e5 });
  const reqs = st.requests.slice(mark2).filter((r) => r.method === 'GET' && r.path.endsWith(`/${st.userId}/media`));
  assert.ok(reqs.length > 1);
  const md = (await env.read('analytics-media')).media;
  assert.equal(Object.keys(md).length, st.media.length);
});

test('sharedListing: reused when it is everything, enough, or nothing stored beyond it is due', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const item = (i) => ({ id: `m${i}`, timestamp: isoAtMs(now - (i + 1) * 864e5) });
  const items = Array.from({ length: 50 }, (_, i) => item(i));
  const fresh = (i, h) => ({ ...item(i), fetchedAt: isoAtMs(now - h * 36e5) });
  assert.equal(sharedListing(null, {}, now), null);
  assert.equal(sharedListing({ items: items.slice(0, 20), max: 50 }, {}, now).length, 20, 'the whole account');
  assert.equal(sharedListing({ items, max: 50 }, {}, now), null, 'nothing known yet');
  const known = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`m${i}`, fresh(i, 1)]));
  assert.equal(sharedListing({ items, max: 50 }, known, now).length, 50);
  known.m60 = fresh(60, 24 * 8); // weekly refresh due beyond the shared listing
  assert.equal(sharedListing({ items, max: 50 }, known, now), null);
  known.m60 = { ...known.m60, deletedAt: isoAtMs(now) };
  assert.equal(sharedListing({ items, max: 50 }, known, now).length, 50, 'deleted media is never due');
  const many = Array.from({ length: 150 }, (_, i) => item(i));
  assert.equal(sharedListing({ items: many, max: 200 }, {}, now).length, 100);
});

test('mediaToRefresh: due posts youngest first; with a write anyway, posts halfway to their refresh go along', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ago = (h) => isoAtMs(now - h * 36e5);
  const listed = [
    { id: 'young', timestamp: ago(3) }, // hourly: due
    { id: 'day1', timestamp: ago(20) }, // every 3 hours: 2 hours since, past halfway
    { id: 'week', timestamp: ago(24 * 4) }, // every 6 hours: 2 hours since, not halfway
    { id: 'old', timestamp: ago(24 * 60) }, // weekly: 4 days since, past halfway
  ];
  const known = { young: { fetchedAt: ago(1.2) }, day1: { fetchedAt: ago(2) }, week: { fetchedAt: ago(2) }, old: { fetchedAt: ago(24 * 4) } };
  assert.deepEqual(mediaToRefresh(listed, known, now).map((m) => m.id), ['young', 'day1', 'old']);
  known.young.fetchedAt = ago(0.5);
  assert.deepEqual(mediaToRefresh(listed, known, now), [], 'nothing due: no early refresh');
  assert.deepEqual(mediaToRefresh(listed, known, now, { writing: true }).map((m) => m.id), ['young', 'day1', 'old']);
  assert.equal(mediaDue({ timestamp: ago(20) }, { fetchedAt: ago(1.5) }, now), false, 'after 6 hours, every 3 hours');
  assert.equal(mediaDue({ timestamp: ago(20) }, { fetchedAt: ago(3.1) }, now), true);
});

test('analytics-media write volume: under 20 writes a day at one post a day (hourly refreshes made 24 to 49)', () => {
  // Replays mediaToRefresh with a run every 10 minutes for 60 days, posts at varying times of day.
  const start = Date.parse('2026-06-01T00:00:00Z');
  const posts = Array.from({ length: 60 }, (_, d) => ({ id: String(1e9 + d), timestamp: isoAtMs(start + d * 864e5 + ((d * 7) % 24) * 36e5 + 13 * 60e3) }));
  const known = {};
  const writes = {};
  for (let t = start; t < start + 60 * 864e5; t += 10 * 60e3) {
    const listed = posts.filter((p) => Date.parse(p.timestamp) <= t).reverse().slice(0, 100);
    const fresh = listed.filter((p) => !known[p.id]);
    const pick = mediaToRefresh(listed, known, t, { writing: fresh.length > 0 });
    for (const p of fresh) known[p.id] = { id: p.id, timestamp: p.timestamp, fetchedAt: null };
    for (const p of pick) known[p.id] = { ...known[p.id], fetchedAt: isoAtMs(t) };
    if (pick.length || fresh.length) {
      const day = isoAtMs(t).slice(0, 10);
      writes[day] = (writes[day] || 0) + 1;
    }
  }
  const last = Object.keys(writes).sort().slice(-20).map((d) => writes[d]);
  assert.ok(last.every((n) => n < 20), `writes per day: ${last.join(', ')}`);
});

test('account insights and the audience use the worker clock (moved forward in tests and simulations)', async (t) => {
  const shift = 8 * 864e5;
  const env = await startWorkerEnv({ graph: { now: () => new Date(Date.now() + shift) } });
  t.after(() => env.close());
  const res = await env.run({ only: ['analytics'], now: Date.now() + shift });
  assert.equal(res.exitCode, 0);
  const daily = await env.read('analytics-daily');
  const today = dayKey(new Date(Date.now() + shift), 'UTC');
  const reachDays = Object.keys(daily.days).filter((k) => typeof daily.days[k].reach === 'number').sort();
  assert.equal(reachDays.at(-1) >= dayKey(new Date(Date.now() + shift - 2 * 864e5), 'UTC'), true, `reach saved up to yesterday (${reachDays.at(-1)})`);
  assert.ok(reachDays.length >= 25, `${reachDays.length} days with reach`);
  assert.equal(daily.lastDailyRun, today);
  const audience = await env.read('audience');
  assert.ok(audience.onlineFollowers && audience.onlineFollowers.days > 0);
});

test('story captures: first sight, every 3 hours, every 30 minutes in the last 90 and every run in the last 20', () => {
  const posted = Date.parse('2026-10-12T08:03:00Z');
  const story = { id: 's1', timestamp: isoAtMs(posted) };
  let prev = null;
  const at = [];
  for (let t = posted + 4 * 60e3; t < posted + 864e5; t += 10 * 60e3) {
    if (!captureDue(prev, story, t)) continue;
    at.push((t - posted) / 60e3);
    prev = { capturedAt: isoAtMs(t) };
  }
  assert.ok(at.length <= 14, `${at.length} captures (one per run in the last 90 minutes and hourly before made about 32): ${at.join(', ')}`);
  assert.equal(at[0], 4, 'first sight');
  assert.ok(at.at(-1) >= 24 * 60 - 20, 'a capture in the last 20 minutes');
  const gaps = at.slice(1).map((m, i) => m - at[i]);
  assert.ok(gaps.every((g) => g <= 180), 'never more than 3 hours apart');
});
