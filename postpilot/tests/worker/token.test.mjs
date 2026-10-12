import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv, visibleLines, TEST_TOKEN } from '../helpers/worker-env.mjs';
import { runWorker } from '../../worker/run.mjs';

const DAY = 864e5;

test('refreshes an Instagram Login token older than 6 days and masks the new one', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('settings', (s) => {
    s.ig.tokenRefreshedAt = new Date(Date.now() - 7 * DAY).toISOString();
  });
  const res = await env.run({ only: ['token', 'stories'] });
  assert.equal(res.exitCode, 0);
  assert.equal(env.graph.state.tokens.refreshed.length, 1);
  assert.equal(env.graph.state.tokens.lastRefreshedFrom, TEST_TOKEN);
  const fresh = env.graph.state.tokens.refreshed[0];
  const settings = await env.read('settings');
  assert.equal(settings.ig.token, fresh);
  assert.ok(Date.now() - Date.parse(settings.ig.tokenRefreshedAt) < 60_000);
  assert.ok(Date.parse(settings.ig.tokenExpiresAt) > Date.now() + 50 * DAY);
  assert.equal(settings.ig.status.state, 'ok');
  assert.ok(res.lines.includes(`::add-mask::${fresh}`), 'new token masked');
  assert.ok(!visibleLines(res.lines).join('\n').includes(fresh));
  // Later jobs in the same run use the new token.
  const after = env.graph.state.requests.filter((r) => r.path.endsWith('/stories'));
  assert.ok(after.length > 0);
  assert.ok(res.summary.jobs.stories.stories > 0);

  // Next run: nothing to refresh.
  await env.run({ only: ['token'] });
  assert.equal(env.graph.state.tokens.refreshed.length, 1);
});

test('does not refresh a token younger than 24 hours', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('settings', (s) => {
    s.ig.tokenRefreshedAt = null;
    s.ig.connectedAt = new Date(Date.now() - 3600e3).toISOString();
  });
  await env.run({ only: ['token'] });
  assert.equal(env.graph.state.tokens.refreshed.length, 0);
});

test('an expired token is flagged for the app and Instagram jobs are skipped', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('settings', (s) => {
    s.ig.token = 'expired-token';
    s.ig.tokenRefreshedAt = new Date(Date.now() - 8 * DAY).toISOString();
  });
  const res = await env.run();
  assert.equal(res.exitCode, 0);
  const settings = await env.read('settings');
  assert.equal(settings.ig.status.state, 'expired');
  assert.equal(res.summary.jobs.token.tokenExpired, 1);
  for (const job of ['publish', 'automations', 'stories', 'analytics']) assert.equal(res.summary.jobs[job].skipped, 'token_expired');
  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'token' && e.level === 'error'));

  // Within the recheck window the worker does not keep calling Instagram.
  const mark = env.graph.state.requests.length;
  await env.run();
  assert.equal(env.graph.state.requests.length, mark);
});

test('facebook mode validates the page token once a day', async (t) => {
  const env = await startWorkerEnv({ mode: 'facebook', token: 'fb-user-token' });
  t.after(() => env.close());
  const res = await env.run({ only: ['token'] });
  assert.equal(res.summary.jobs.token.tokenChecked, 1);
  assert.equal(env.graph.state.tokens.refreshed.length, 0);
  const again = await env.run({ only: ['token'] });
  assert.equal(again.summary.jobs.token.tokenChecked, 0);
  const settings = await env.read('settings');
  assert.equal(settings.ig.mode, 'facebook');
  assert.equal(settings.ig.status.state, 'ok');
});

test('a GitHub refusal while saving the refreshed token does not flag the login as expired', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('settings', (s) => {
    s.ig.tokenRefreshedAt = new Date(Date.now() - 7 * DAY).toISOString();
  });
  let refused = 0;
  const fetchImpl = async (url, init = {}) => {
    if (!refused && init.method === 'POST' && String(url).endsWith('/git/commits') && JSON.parse(init.body).message === 'worker: token: update Instagram connection') {
      refused++;
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, init);
  };
  const lines = [];
  const res = await runWorker({ env: env.env, only: ['token', 'stories'], fetchImpl, log: (l) => lines.push(l) });
  assert.equal(refused, 1);
  assert.equal(res.exitCode, 0);
  assert.equal(res.summary.jobs.token.tokenExpired, undefined);
  assert.equal(res.summary.jobs.stories.skipped, undefined, 'Instagram jobs still run');
  const settings = await env.read('settings');
  assert.equal(settings.ig.status.state, 'ok');
  assert.equal(env.pushes.length, 0);
  assert.ok(!lines.some((l) => /login/i.test(l)));
  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'token' && e.level === 'warn' && /Could not refresh/.test(e.message)));
});
