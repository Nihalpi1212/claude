import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv, visibleLines } from '../helpers/worker-env.mjs';
import { b64url, generateVapidKeys } from '../../core/webpush.js';
import { addDaysKey, dayRange } from '../../core/time.js';
import { buildMonthlyReport, reportHeadline } from '../../core/analytics.js';
import { aiInput, monthLabel, reportDue } from '../../worker/jobs/reports.mjs';

const AI = { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5-5', voice: '', language: 'English', emoji: 'some', enabled: true };

/** Daily snapshots for August and September 2026 (UTC), captured on 2026-10-02 unless told otherwise. */
function days({ capturedAt = '2026-10-02T00:20:00Z' } = {}) {
  const out = {};
  let followers = 1000;
  for (const k of dayRange('2026-08-01', '2026-09-30')) {
    const sept = k >= '2026-09-01';
    followers += sept ? 5 : 2;
    out[k] = { followers, reach: sept ? 300 : 200, views: sept ? 900 : 600, likes: 20, comments: 2, shares: 1, saves: 3, totalInteractions: 26, reachFollowers: 180, reachNonFollowers: sept ? 120 : 20, viewsByType: { POST: 500, REEL: 400 }, capturedAt };
  }
  return out;
}

const MEDIA = {
  m1: { id: 'm1', caption: 'Autumn vases are here #ceramics', mediaType: 'IMAGE', productType: 'FEED', permalink: 'https://instagram.com/p/1', timestamp: '2026-09-04T15:00:00+0000', metrics: { reach: 800, likes: 60, comments: 5, saved: 9, shares: 2, totalInteractions: 76 } },
  m2: { id: 'm2', caption: 'Wheel day', mediaType: 'VIDEO', productType: 'REELS', timestamp: '2026-09-20T18:00:00+0000', metrics: { reach: 2400, views: 5100, likes: 150, comments: 12, saved: 30, shares: 25, totalInteractions: 217 } },
  m3: { id: 'm3', caption: 'August post', mediaType: 'IMAGE', productType: 'FEED', timestamp: '2026-08-10T15:00:00+0000', metrics: { reach: 500, totalInteractions: 40 } },
};

async function setup(t, { ai = false, capturedAt } = {}) {
  const env = await startWorkerEnv({ settings: ai ? { ai: AI } : {} });
  t.after(() => env.close());
  await env.update('analytics-daily', (d) => {
    d.days = days({ capturedAt });
    d.lastDailyRun = '2026-10-02';
  });
  await env.update('analytics-media', (d) => {
    d.media = MEDIA;
  });
  await env.update('analytics-stories', (d) => {
    d.stories = { s1: { id: 's1', timestamp: '2026-09-12T10:00:00+0000', metrics: { reach: 90 } } };
  });
  return env;
}

test('reportDue: days 1-3 only, the previous month once, after the last day was read again', () => {
  const d = days();
  assert.deepEqual(reportDue({ today: '2026-10-02', lastMonth: null, days: d }), { month: '2026-09' });
  assert.deepEqual(reportDue({ today: '2026-10-04', lastMonth: null, days: d }), { skipped: 'not_due' });
  assert.deepEqual(reportDue({ today: '2026-10-02', lastMonth: '2026-09', days: d }), { skipped: 'not_due' });
  assert.deepEqual(reportDue({ today: '2026-10-02', lastMonth: null, days: {} }), { skipped: 'nothing_due' });
  // On the 1st the month's last day has only been read once (captured on the 1st): wait.
  const early = days({ capturedAt: '2026-10-01T00:20:00Z' });
  assert.deepEqual(reportDue({ today: '2026-10-01', lastMonth: null, days: early }), { skipped: 'not_due' });
  assert.deepEqual(reportDue({ today: '2026-10-02', lastMonth: null, days: early }), { skipped: 'not_due' });
  // On the 3rd it is made with what is saved.
  assert.deepEqual(reportDue({ today: '2026-10-03', lastMonth: null, days: early }), { month: '2026-09' });
  // January reports December of the year before.
  const dec = Object.fromEntries(dayRange('2025-12-01', '2025-12-31').map((k) => [k, { reach: 5, capturedAt: '2026-01-02T01:00:00Z' }]));
  assert.deepEqual(reportDue({ today: '2026-01-02', lastMonth: '2025-11', days: dec }), { month: '2025-12' });
  // The capture day is judged in the owner's time zone.
  const tzDays = Object.fromEntries(dayRange('2026-09-01', '2026-09-30').map((k) => [k, { reach: 5, capturedAt: '2026-10-01T23:30:00Z' }])); // Oct 2 in Berlin, Oct 1 in UTC
  assert.deepEqual(reportDue({ today: '2026-10-02', lastMonth: null, days: tzDays, tz: 'Europe/Berlin' }), { month: '2026-09' });
  assert.deepEqual(reportDue({ today: '2026-10-02', lastMonth: null, days: tzDays, tz: 'UTC' }), { skipped: 'not_due' });
});

test('buildMonthlyReport sums the month, the month before and the top posts', () => {
  const r = buildMonthlyReport({ days: days(), media: MEDIA, stories: { s1: { id: 's1', timestamp: '2026-09-12T10:00:00Z' } }, month: '2026-09', tz: 'UTC' });
  assert.equal(r.summary.reach, 300 * 30);
  assert.equal(r.previous.reach, 200 * 31);
  assert.equal(r.summary.posts, 2);
  assert.equal(r.summary.reels, 1);
  assert.equal(r.summary.stories, 1);
  assert.equal(r.previous.posts, 1);
  assert.equal(r.summary.reachNonFollowers, 120 * 30);
  assert.deepEqual(r.summary.viewsByType, { POST: 500 * 30, REEL: 400 * 30 });
  assert.equal(r.summary.followerGrowth, 5 * 29);
  assert.deepEqual(r.top.map((m) => m.id), ['m2', 'm1']);
  assert.equal(r.top[1].permalink, 'https://instagram.com/p/1');
  assert.equal(reportHeadline(r), 'Reach 9K (+45%) · 2 posts · +145 followers');
  assert.equal(monthLabel('2026-09'), 'September 2026');
});

test('the monthly report is stored, notified and made once', async (t) => {
  const env = await setup(t);
  const phone = await (async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    return { endpoint: `${env.url}/push/phone`, keys: { p256dh, auth: b64url(crypto.getRandomValues(new Uint8Array(16))) }, device: 'phone', createdAt: new Date().toISOString() };
  })();
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  await env.update('settings', (s) => {
    s.notifications = { vapid, subscriptions: [phone], events: { report: true } };
  });
  await env.update('reports', (d) => {
    d.branding = { logoAssetId: 'a_logo' };
  });
  const ghPaths = [];
  const realHandle = env.ghMock.handle;
  env.ghMock.handle = (req, res, sub, body) => (ghPaths.push(`${req.method} ${sub}`), realHandle(req, res, sub, body));

  const res = await env.run({ only: ['reports'], now: '2026-10-02T09:00:00Z' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.summary.jobs.reports.reportsCreated, 1);
  const doc = await env.read('reports');
  assert.equal(doc.lastMonth, '2026-09');
  assert.equal(doc.reports.length, 1);
  const r = doc.reports[0];
  assert.equal(r.month, '2026-09');
  assert.match(r.id, /^rp_/);
  assert.equal(r.summary.reach, 9000);
  assert.equal(r.previous.reach, 6200);
  assert.equal(r.top[0].id, 'm2');
  assert.equal(r.ai, null, 'no AI configured');
  assert.equal(r.headline, 'Reach 9K (+45%) · 2 posts · +145 followers');
  assert.deepEqual(doc.branding, { logoAssetId: 'a_logo' }, 'the logo choice is kept');
  assert.equal(env.pushes.filter((p) => p.path === '/phone').length, 1, 'one report notification');
  assert.ok(res.lines.includes('reports: 1 reports created'));
  const visible = visibleLines(res.lines).join('\n');
  assert.ok(!/Wheel day|Autumn vases|September/.test(visible), 'no captions or report text in the public log');
  const entry = (await env.read('log')).entries.find((e) => e.job === 'reports');
  assert.match(entry.message, /September 2026/);
  assert.ok(ghPaths.length > 0);
  assert.ok(!ghPaths.some((p) => /\/issues/.test(p)), 'never a GitHub issue (the repository is public)');
  env.ghMock.handle = realHandle;

  const again = await env.run({ only: ['reports'], now: '2026-10-02T10:00:00Z' });
  assert.equal(again.summary.jobs.reports.skipped, 'not_due');
  assert.equal((await env.read('reports')).reports.length, 1);

  const later = await env.run({ only: ['reports'], now: '2026-10-12T10:00:00Z' });
  assert.equal(later.summary.jobs.reports.skipped, 'not_due');
});

test('a failing AI summary never blocks the report; a working one is stored', async (t) => {
  const env = await setup(t, { ai: true });
  await env.update('settings', (s) => {
    s.ai.apiKey = 'bad-key';
  });
  const res = await env.run({ only: ['reports'], now: '2026-10-02T09:00:00Z' });
  assert.equal(res.summary.jobs.reports.reportsCreated, 1);
  const r = (await env.read('reports')).reports[0];
  assert.equal(r.ai, null);
  assert.ok((await env.read('log')).entries.some((e) => e.job === 'reports' && e.level === 'warn' && /without an AI summary/.test(e.message)));

  const env2 = await setup(t, { ai: true });
  const res2 = await env2.run({ only: ['reports'], now: '2026-10-03T09:00:00Z' });
  assert.equal(res2.summary.jobs.reports.reportsCreated, 1);
  const r2 = (await env2.read('reports')).reports[0];
  assert.equal(typeof r2.ai, 'string');
  assert.ok(r2.ai.length > 10);
  const req = env2.anthropic.state.requests.at(-1);
  assert.ok(!JSON.stringify(req.body || req).includes('instagram.com/p/1'), 'no links sent to the AI');
});

test('reports wait on the 1st for settled numbers, keep 24 and skip months without data', async (t) => {
  const env = await setup(t, { capturedAt: '2026-10-01T00:20:00Z' });
  const first = await env.run({ only: ['reports'], now: '2026-10-01T09:00:00Z' });
  assert.equal(first.summary.jobs.reports.skipped, 'not_due');
  await env.update('reports', (d) => {
    d.reports = Array.from({ length: 24 }, (_, i) => ({ id: `rp_${i}`, month: addDaysKey('2024-09-15', i * 30).slice(0, 7), summary: {}, previous: {}, top: [], ai: null }));
    d.lastMonth = '2026-08';
  });
  const third = await env.run({ only: ['reports'], now: '2026-10-03T09:00:00Z' });
  assert.equal(third.summary.jobs.reports.reportsCreated, 1);
  const doc = await env.read('reports');
  assert.equal(doc.reports.length, 24);
  assert.equal(doc.reports[0].month, '2026-09');

  // November 1st: October has no saved numbers, so there is nothing to report.
  const nov = await env.run({ only: ['reports'], now: '2026-11-02T09:00:00Z' });
  assert.equal(nov.summary.jobs.reports.skipped, 'nothing_due');
});

test('a month with fewer than 7 saved days gets no report', () => {
  const few = {};
  for (let d = 25; d <= 30; d++) few[`2026-09-${d}`] = { reach: 900, capturedAt: '2026-10-02T00:20:00Z' };
  assert.deepEqual(reportDue({ today: '2026-10-03', lastMonth: null, days: few }), { skipped: 'too_little_data' });
  few['2026-09-24'] = { reach: 900 };
  assert.deepEqual(reportDue({ today: '2026-10-03', lastMonth: null, days: few }), { month: '2026-09' });
  // Follower counts alone do not count as saved days.
  const followersOnly = {};
  for (let d = 1; d <= 30; d++) followersOnly[`2026-09-${String(d).padStart(2, '0')}`] = { followers: 100 + d };
  assert.deepEqual(reportDue({ today: '2026-10-03', lastMonth: null, days: followersOnly }), { skipped: 'too_little_data' });
});

test('AI input: no comparison with an incomplete month, and a non-follower share instead of a partial sum', () => {
  const d = {};
  // October saved from the 20th (12 days); September from the 14th (17 days); split on every saved day.
  for (let n = 14; n <= 30; n++) d[`2026-09-${n}`] = { reach: 1000, reachFollowers: 600, reachNonFollowers: 400, followers: 4800 };
  for (let n = 20; n <= 31; n++) d[`2026-10-${n}`] = { reach: 1000, reachFollowers: 700, reachNonFollowers: 300, followers: 4800 + n };
  const r = buildMonthlyReport({ days: d, media: MEDIA, month: '2026-10' });
  const input = aiInput(r, 'October 2026', 'kiln');
  assert.equal(input.previous, undefined, 'September is not compared');
  assert.equal(input.comparedWith, undefined);
  assert.match(input.note, /12 of the 31 days/);
  assert.equal(input.current.daysWithNumbers, 12);
  assert.equal(input.current.shareOfReachFromNonFollowers, 0.3);
  assert.equal('reachFromNonFollowers' in input.current, false, 'no partial absolute sum');

  // Complete months are compared; a split covering under half the days is left out.
  const full = days();
  for (const k of Object.keys(full)) if (k >= '2026-09-10') delete full[k].reachNonFollowers;
  const both = aiInput(buildMonthlyReport({ days: full, media: MEDIA, month: '2026-09' }), 'September 2026');
  assert.equal(both.comparedWith, 'August 2026');
  assert.equal(both.note, undefined);
  assert.equal(both.previous.reach, 6200);
  assert.equal(both.current.shareOfReachFromNonFollowers, null);
  assert.ok(both.previous.shareOfReachFromNonFollowers > 0);
});

test('a report for a partly saved month says so and leaves the changes out (headline and notification)', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('analytics-daily', (doc) => {
    doc.days = {};
    for (let n = 14; n <= 30; n++) doc.days[`2026-09-${n}`] = { reach: 1600, followers: 4800, capturedAt: '2026-10-12T00:20:00Z' };
    for (let n = 20; n <= 31; n++) doc.days[`2026-10-${n}`] = { reach: 1300, followers: 4820, capturedAt: '2026-11-02T00:20:00Z' };
  });
  const res = await env.run({ only: ['reports'], now: '2026-11-02T09:00:00Z' });
  assert.equal(res.summary.jobs.reports.reportsCreated, 1);
  const r = (await env.read('reports')).reports[0];
  assert.equal(r.month, '2026-10');
  assert.equal(r.summary.daysSaved, 12);
  assert.equal(r.summary.daysInMonth, 31);
  assert.equal(r.previous.daysSaved, 17);
  assert.doesNotMatch(r.headline, /%/);
  assert.match(r.headline, /12 of 31 days saved$/);
  assert.match(r.headline, /no follower change/);
});
