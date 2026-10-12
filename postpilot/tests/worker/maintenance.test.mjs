import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv } from '../helpers/worker-env.mjs';
import { compactBranch } from '../../worker/jobs/maintenance.mjs';
import { COMPACT_LOCK_PREFIX, createStore } from '../../core/store.js';
import { importDataKey } from '../../core/crypto.js';
import { newAsset, newPost } from '../../core/model.js';
import { unusedAssets } from '../../core/schedule.js';

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
  const filesBefore = await gh.getTree(env.ghMock.commits.get(headBefore).tree);
  assert.equal(await compactBranch({ gh, branch, store: env.store }), true);
  const head = env.ghMock.refs.get(branch);
  assert.deepEqual(env.ghMock.commits.get(head).parents, []);
  const filesAfter = await gh.getTree(env.ghMock.commits.get(head).tree);
  assert.deepEqual(filesAfter.map((f) => [f.path, f.sha]).sort(), filesBefore.map((f) => [f.path, f.sha]).sort(), 'same files, no lock marker left');
  await env.store.refresh();
  assert.deepEqual((await env.read('log')).entries, before.entries);
  const commitsBefore = env.ghMock.commits.size;
  assert.equal(await compactBranch({ gh, branch, store: env.store }), false, 'nothing to do on a single commit');
  assert.equal(env.ghMock.commits.size, commitsBefore, 'no lock commit when there is nothing to compact');
  // Writes still work on the compacted branch.
  await env.update('log', (d) => { d.entries.unshift({ at: 'after', job: 'x', level: 'info', message: 'm' }); });
  assert.equal((await env.read('log')).entries[0].at, 'after');
});

test('an app commit made while the branch is being compacted is not lost', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const branch = 'postpilot-data';
  await env.update('log', (d) => { d.entries.unshift({ at: 'before', job: 'x', level: 'info', message: 'm' }); });
  const worker = createStore({ gh: env.gh, key: await importDataKey(env.dataKeyRaw), author: 'worker' });
  await env.store.refresh(); // the app's cached head predates the lock
  // The app saves right before the worker's forced reset (after its last ref check).
  const real = env.ghMock.handle;
  let appSave = null;
  env.ghMock.handle = async (req, res, sub, body) => {
    if (!appSave && req.method === 'PATCH' && /\/git\/refs\/heads\//.test(sub) && body && body.force) {
      appSave = env.store.update('log', (d) => { d.entries.unshift({ at: 'during', job: 'x', level: 'info', message: 'm' }); });
      appSave.catch(() => {});
      await new Promise((r) => setTimeout(r, 600)); // long enough for an unguarded save to land
    }
    return real(req, res, sub, body);
  };
  assert.equal(await compactBranch({ gh: env.gh, branch, store: worker }), true);
  env.ghMock.handle = real;
  assert.ok(appSave, 'the app tried to save during compaction');
  await appSave;
  const head = env.ghMock.refs.get(branch);
  const files = (await env.gh.getTree(env.ghMock.commits.get(head).tree)).map((f) => f.path);
  assert.ok(!files.some((p) => p.startsWith(COMPACT_LOCK_PREFIX)), 'lock marker removed');
  const log = await env.read('log');
  assert.deepEqual(log.entries.slice(0, 2).map((e) => e.at), ['during', 'before'], 'the app save survived and is on top of the compacted branch');
});

test('a stale compaction marker does not block the app', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.store.transact((tx) => tx.writePublic(`${COMPACT_LOCK_PREFIX}${Date.now() - 6 * 60_000}`, { startedAt: 'old' }));
  const started = Date.now();
  await env.update('log', (d) => { d.entries.unshift({ at: 'x', job: 'x', level: 'info', message: 'm' }); });
  assert.ok(Date.now() - started < 1500);
  assert.equal((await env.read('log')).entries[0].at, 'x');
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

test('housekeeping archives old published and canceled posts once a day and keeps media usage the same', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const now = Date.now();
  const ago = (days) => new Date(now - days * 864e5).toISOString();
  const [a1, a2, a3] = [newAsset({ id: 'a_pub' }), newAsset({ id: 'a_can', usedBy: ['p_can'] }), newAsset({ id: 'a_new', usedBy: ['p_recent'] })];
  await env.update('library', (d) => {
    d.assets.push(a1, a2, a3);
  });
  const old = (id, partial) => newPost({ id, createdAt: ago(130), updatedAt: ago(100), scheduledAt: ago(100), ...partial });
  const posts = [
    old('p_pub', { status: 'published', publishedAt: ago(100), igMediaId: 'ig1', media: [{ assetId: 'a_pub', kind: 'image' }] }), // usedBy missing: added on archive
    old('p_edge', { status: 'published', publishedAt: ago(90.5), scheduledAt: ago(90.5), updatedAt: ago(90.5), igMediaId: 'ig2' }),
    old('p_can', { status: 'canceled', media: [{ assetId: 'a_can', kind: 'image' }] }),
    old('p_repost', { status: 'published', source: 'recycle', publishedAt: ago(100), igMediaId: 'ig3' }),
    old('p_recycled', { status: 'canceled', recycleOf: 'ig0' }),
    old('p_rejected', { status: 'canceled', source: 'autopilot', history: [{ at: ago(100), event: 'rejected' }] }),
    old('p_failed', { status: 'failed' }),
    old('p_draft', { status: 'draft', scheduledAt: null }),
    newPost({ id: 'p_recent', status: 'published', publishedAt: ago(30), scheduledAt: ago(30), media: [{ assetId: 'a_new', kind: 'image' }] }),
    old('p_future', { status: 'canceled', scheduledAt: new Date(now + 5 * 864e5).toISOString() }),
  ];
  await env.update('posts', (d) => {
    d.posts.push(...posts);
  });
  const before = await env.read('posts');
  const libBefore = await env.read('library');
  const unusedBefore = unusedAssets(libBefore.assets, before.posts).map((a) => a.id).sort();

  const res = await env.run({ only: ['housekeeping'] });
  assert.equal(res.summary.jobs.housekeeping.archived, 3);
  const after = await env.read('posts');
  const archive = await env.read('posts-archive');
  assert.deepEqual(archive.posts.map((p) => p.id).sort(), ['p_can', 'p_edge', 'p_pub']);
  assert.deepEqual(after.posts.map((p) => p.id).sort(), ['p_draft', 'p_failed', 'p_future', 'p_recent', 'p_recycled', 'p_rejected', 'p_repost']);
  assert.deepEqual(archive.posts.find((p) => p.id === 'p_pub'), before.posts.find((p) => p.id === 'p_pub'), 'moved unchanged');
  const lib = await env.read('library');
  const byId = Object.fromEntries(lib.assets.map((a) => [a.id, a]));
  assert.deepEqual(byId.a_pub.usedBy, ['p_pub']);
  assert.deepEqual(byId.a_can.usedBy, []);
  assert.deepEqual(byId.a_new.usedBy, ['p_recent']);
  assert.deepEqual(unusedAssets(lib.assets, after.posts).map((a) => a.id).sort(), unusedBefore, 'unused media is the same');

  // Nothing left to archive: no further archive commits.
  const again = await env.run({ only: ['housekeeping'] });
  assert.ok(!again.summary.jobs.housekeeping.archived);
  // A post just past 90 days waits until the daily slack has passed.
  await env.update('posts', (d) => {
    d.posts.push(newPost({ id: 'p_soon', status: 'published', publishedAt: ago(90.2), scheduledAt: ago(90.2), updatedAt: ago(90.2), createdAt: ago(91) }));
  });
  const third = await env.run({ only: ['housekeeping'] });
  assert.ok(!third.summary.jobs.housekeeping.archived);
  assert.ok((await env.read('posts')).posts.some((p) => p.id === 'p_soon'));
});
