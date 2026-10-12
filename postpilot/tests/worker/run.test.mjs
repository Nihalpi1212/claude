import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker, NOT_CONFIGURED_MESSAGE, formatJobLine } from '../../worker/run.mjs';
import { startWorkerEnv, visibleLines, TEST_TOKEN } from '../helpers/worker-env.mjs';
import { b64encode, generateDataKey } from '../../core/crypto.js';
import { newPost } from '../../core/model.js';
import { staleTmpFiles } from '../../worker/jobs/housekeeping.mjs';

test('without POSTPILOT_DATA_KEY the worker explains and exits 0', async () => {
  const lines = [];
  const res = await runWorker({ env: { GITHUB_REPOSITORY: 'o/r' }, log: (l) => lines.push(l) });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(lines, [NOT_CONFIGURED_MESSAGE]);
});

test('a data key that does not match the workspace exits 1 with a clear message', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const res = await env.run({ env: { POSTPILOT_DATA_KEY: b64encode(generateDataKey()) } });
  assert.equal(res.exitCode, 1);
  assert.match(res.lines.join('\n'), /does not unlock this workspace/);
});

test('a missing data branch is not an error', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const res = await env.run({ env: { POSTPILOT_BRANCH: 'nope' } });
  assert.equal(res.exitCode, 0);
  assert.match(res.lines.join('\n'), /data branch "nope" was not found/);
});

test('a full run: every job runs, the run is recorded, the console stays clean', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f08.jpg');
  await env.update('posts', (d) => void d.posts.push(newPost({ status: 'scheduled', scheduledAt: new Date(Date.now() - 5000).toISOString(), caption: 'Confidential caption text', media: [{ assetId: asset.id, kind: 'image' }] })));
  // A leftover public file from a crashed run two days ago.
  const old = `public/tmp/${Math.floor(Date.now() / 1000) - 2 * 86400}-deadbeef.jpg`;
  await env.store.transact(async (tx) => tx.writePublic(old, new Uint8Array([1, 2, 3])));

  const res = await env.run({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch', POSTPILOT_REASON: 'Publish now' } });
  assert.equal(res.exitCode, 0, res.lines.join('\n'));
  assert.deepEqual(res.summary.errors, []);
  for (const job of ['token', 'outbox', 'publish', 'evergreen', 'autopilot', 'automations', 'stories', 'analytics', 'competitors', 'bio', 'housekeeping']) {
    assert.ok(res.summary.jobs[job], `${job} ran`);
  }
  assert.equal(res.summary.counts.published, 1);
  assert.equal(res.summary.jobs.housekeeping.tmpDeleted, 1);
  await env.store.refresh();
  assert.deepEqual(await env.store.list('public/tmp/'), []);

  const log = await env.read('log');
  const run = log.runs[0];
  assert.equal(run.trigger, 'workflow_dispatch');
  assert.equal(run.reason, 'Publish now');
  assert.equal(run.ok, true);
  assert.ok(run.startedAt <= run.finishedAt);
  assert.ok(run.counts.stories > 0 && run.counts.snapshots > 0);
  assert.ok(log.entries.length > 0 && log.entries.length <= 500);

  const visible = visibleLines(res.lines);
  const text = visible.join('\n');
  for (const secret of [TEST_TOKEN, 'gh-test-token', env.env.POSTPILOT_DATA_KEY, 'Confidential', env.graph.state.username, env.graph.state.userId]) {
    assert.ok(!text.includes(secret), `console must not contain ${secret}`);
  }
  assert.ok(!/https?:\/\//.test(text));
  // Every job line is "name: numbers" or "name: skipped (...)".
  for (const l of visible.filter((x) => /^[a-z]+: /.test(x))) assert.match(l, /^[a-z]+: (skipped \([^)]*\)|done|[0-9][0-9a-z ,]*|waiting for a scheduled post)$/);
});

test('idle runs only write a heartbeat, coalesced into one record', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const first = await env.run();
  assert.equal(first.exitCode, 0);
  let log = await env.read('log');
  assert.equal(log.runs.length, 1);
  assert.equal(log.runs[0].idle, true);
  assert.equal(log.runs[0].skipped.publish, 'not_connected');
  assert.equal(first.summary.jobs.publish.skipped, 'not_connected');
  const writes = env.ghMock.stats.writes;
  await env.run();
  assert.equal(env.ghMock.stats.writes, writes, 'an idle run inside the heartbeat window writes nothing');
  await env.run({ now: Date.now() + 31 * 60e3 });
  log = await env.read('log');
  assert.equal(log.runs.length, 1, 'idle heartbeats replace each other');
  assert.ok(Date.parse(log.runs[0].finishedAt) > Date.now() + 30 * 60e3);
  // A run that does something is kept, and the next heartbeat goes on top of it.
  const asset = await env.addAsset('f01.jpg');
  await env.update('posts', (d) => void d.posts.push(newPost({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1000).toISOString(), caption: 'x', media: [{ assetId: asset.id, kind: 'image' }] })));
  await env.update('lists', (d) => void d.lists.push({ id: 'l', enabled: true, items: [{ id: 'i', type: 'feed', caption: 'x', media: [{ assetId: asset.id, kind: 'image' }] }], slots: [{ weekday: 1, time: '10:00' }], horizonDays: 14, nextIndex: 0 }));
  await env.run();
  log = await env.read('log');
  assert.equal(log.runs.length, 2);
  assert.ok(!log.runs[0].idle);
  assert.ok(log.runs[0].counts.evergreenCreated > 0);
  assert.ok(JSON.stringify(log.runs[0]).length < 600, 'run records stay small');
});

test('a paused worker only does maintenance', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('settings', (s) => void (s.worker = { enabled: false }));
  const res = await env.run();
  assert.equal(res.summary.jobs.publish.skipped, 'paused');
  assert.ok(!res.summary.jobs.token.skipped || res.summary.jobs.token.skipped !== 'paused');
});

test('formatJobLine prints numbers and fixed reasons only', () => {
  assert.equal(formatJobLine('publish', { published: 1, failed: 0 }), 'publish: 1 published, 0 failed');
  assert.equal(formatJobLine('bio', { skipped: 'not_due' }), 'bio: skipped (not due yet)');
  assert.equal(formatJobLine('x', { skipped: 'something <secret>' }), 'x: skipped (nothing to do)');
  assert.equal(formatJobLine('x', { note: 'secret caption', count: 2 }), 'x: 2 count');
});

test('stale public/tmp detection', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const s = Math.floor(now / 1000);
  const files = [`public/tmp/${s - 100}-a.jpg`, `public/tmp/${s - 90000}-b.jpg`, 'public/tmp/weird.jpg', 'public/bio.json'];
  assert.deepEqual(staleTmpFiles(files, now), [`public/tmp/${s - 90000}-b.jpg`, 'public/tmp/weird.jpg']);
});
