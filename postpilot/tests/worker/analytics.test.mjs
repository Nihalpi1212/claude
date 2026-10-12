import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv } from '../helpers/worker-env.mjs';
import { dayKey } from '../../core/time.js';
import { mediaDue } from '../../worker/jobs/analytics.mjs';

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
