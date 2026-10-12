import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv } from '../helpers/worker-env.mjs';
import { compactBranch } from '../../worker/jobs/maintenance.mjs';

test('keep-alive re-enables the scheduled workflow about every 20 days', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  env.ghMock.workflow.state = 'disabled_inactivity';
  await env.run({ only: ['maintenance'] });
  assert.equal(env.ghMock.workflow.enabledCalls, 1);
  assert.equal(env.ghMock.workflow.state, 'active');
  await env.run({ only: ['maintenance'] });
  assert.equal(env.ghMock.workflow.enabledCalls, 1, 'not again within 20 days');
  const s = await env.read('settings');
  assert.ok(s.worker.maintenance.keepaliveAt);
});

test('compaction keeps every file and leaves a single commit', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  for (let i = 0; i < 3; i++) await env.update('log', (d) => { d.entries.unshift({ at: String(i), job: 'x', level: 'info', message: 'm' }); });
  const before = await env.read('log');
  const branch = 'postpilot-data';
  const headBefore = env.ghMock.refs.get(branch);
  assert.ok(env.ghMock.commits.get(headBefore).parents.length > 0);
  const gh = env.store.gh;
  assert.equal(await compactBranch({ gh, branch }), true);
  const head = env.ghMock.refs.get(branch);
  assert.deepEqual(env.ghMock.commits.get(head).parents, []);
  assert.equal(env.ghMock.commits.get(head).tree, env.ghMock.commits.get(headBefore).tree);
  await env.store.refresh();
  assert.deepEqual((await env.read('log')).entries, before.entries);
  assert.equal(await compactBranch({ gh, branch }), false, 'nothing to do on a single commit');
  // Writes still work on the compacted branch.
  await env.update('log', (d) => { d.entries.unshift({ at: 'after', job: 'x', level: 'info', message: 'm' }); });
  assert.equal((await env.read('log')).entries[0].at, 'after');
});

test('the maintenance job compacts only at night and at most monthly', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('settings', (s) => { s.timezone = 'UTC'; s.createdAt = '2026-01-01T00:00:00Z'; });
  const day = await env.run({ only: ['maintenance'], now: '2026-10-12T14:00:00Z' });
  assert.equal(day.summary.jobs.maintenance.compacted, 0);
  const night = await env.run({ only: ['maintenance'], now: '2026-10-12T03:10:00Z' });
  assert.equal(night.summary.jobs.maintenance.compacted, 1);
  const again = await env.run({ only: ['maintenance'], now: '2026-10-13T03:10:00Z' });
  assert.equal(again.summary.jobs.maintenance.compacted, 0);
});
