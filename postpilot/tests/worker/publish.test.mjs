import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv, visibleLines, sleep, TEST_TOKEN } from '../helpers/worker-env.mjs';
import { newPost } from '../../core/model.js';

const CAPTION = 'Secret launch caption about our spring collection';

async function schedulePost(env, partial) {
  const post = newPost({ status: 'scheduled', scheduledAt: new Date(Date.now() - 60_000).toISOString(), ...partial });
  await env.update('posts', (d) => {
    d.posts.push(post);
  });
  return post;
}

function tmpFiles(env) {
  return env.store.refresh().then(() => env.store.list('public/tmp/'));
}

test('publishes a due feed post end to end and cleans up public/tmp', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f01.jpg');
  const post = await schedulePost(env, { caption: CAPTION, firstComment: 'First!', media: [{ assetId: asset.id, kind: 'image', altText: 'A mug' }] });
  const before = env.graph.state.publishCount;

  const res = await env.run({ only: ['publish'] });
  assert.equal(res.exitCode, 0);
  assert.equal(env.graph.state.publishCount, before + 1);

  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.ok(saved.igMediaId);
  assert.match(saved.permalink, /instagram\.com/);
  assert.ok(saved.publishedAt);
  assert.equal(saved.lastError, null);
  assert.equal(saved.containers, undefined);
  assert.ok(saved.history.some((h) => h.event === 'published'));

  const media = env.graph.state.media.find((m) => m.id === saved.igMediaId);
  assert.ok(media, 'mock graph has the new media');
  assert.equal(media.caption, CAPTION);
  assert.equal(media.alt_text, 'A mug');
  // The image URL Instagram fetched was a raw GitHub URL of a public/tmp copy...
  assert.match(media.url, /\/gh\/raw\/o\/r\/postpilot-data\/public\/tmp\/\d+-[0-9a-f]+\.jpg$/);
  // ...which is gone again.
  assert.deepEqual(await tmpFiles(env), []);
  // First comment posted.
  assert.ok([...env.graph.state.comments.values()].some((c) => c.mediaId === saved.igMediaId && c.text === 'First!'));

  // Library usage recorded.
  const lib = await env.read('library');
  assert.deepEqual(lib.assets.find((a) => a.id === asset.id).usedBy, [post.id]);

  // Console output: counts only.
  assert.ok(res.lines.includes('publish: 1 published, 0 failed, 0 pending, 0 retried'));
  const visible = visibleLines(res.lines).join('\n');
  assert.ok(!visible.includes('spring collection'), 'caption never printed');
  assert.ok(!visible.includes(TEST_TOKEN), 'token never printed');
  assert.ok(!visible.includes(saved.igMediaId), 'ids never printed');
  assert.ok(!/https?:\/\//.test(visible), 'URLs never printed');
  // The token was masked for the Actions log.
  assert.ok(res.lines.includes(`::add-mask::${TEST_TOKEN}`));

  // Run record.
  const log = await env.read('log');
  assert.equal(log.runs[0].counts.published, 1);
  assert.equal(log.runs[0].trigger, 'schedule');
  assert.ok(log.entries.some((e) => e.job === 'publish' && /Published a post/.test(e.message)));
});

test('a permanent error marks the post failed and exits 1', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  // A 9:16 photo is not allowed in the feed: the container ends in ERROR (2207009).
  const asset = await env.addAsset('story01.jpg', { width: 1080, height: 1920 });
  const post = await schedulePost(env, { caption: 'Too tall', media: [{ assetId: asset.id, kind: 'image' }] });

  const res = await env.run({ only: ['publish'] });
  assert.equal(res.exitCode, 1);
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.lastError.permanent, true);
  assert.equal(saved.lastError.subcode, 2207009);
  assert.match(saved.lastError.message, /aspect ratio/);
  assert.deepEqual(await tmpFiles(env), []);
  assert.ok(res.lines.some((l) => /1 post failed to publish/.test(l)));
  assert.ok(!visibleLines(res.lines).join('\n').includes('Too tall'));
});

test('a temporary error puts the post back in the queue', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f02.jpg');
  const post = await schedulePost(env, { caption: 'Retry me', media: [{ assetId: asset.id, kind: 'image' }] });
  env.graph.state.faults.push({ method: 'POST', path: /\/media$/, error: { code: 2, status: 500, message: 'Service temporarily unavailable' }, times: 1 });

  const first = await env.run({ only: ['publish'] });
  assert.equal(first.exitCode, 0);
  let saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'scheduled');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.lastError.permanent, false);
  assert.deepEqual(await tmpFiles(env), []);

  const second = await env.run({ only: ['publish'] });
  assert.equal(second.exitCode, 0);
  saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.equal(saved.attempts, 2);
});

test('gives up after 4 temporary failures', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f03.jpg');
  const post = await schedulePost(env, { caption: 'Flaky', attempts: 3, media: [{ assetId: asset.id, kind: 'image' }] });
  env.graph.state.faults.push({ method: 'POST', path: /\/media$/, error: { code: 2, status: 500 }, times: 1 });
  const res = await env.run({ only: ['publish'] });
  assert.equal(res.exitCode, 1);
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'failed');
  assert.match(saved.lastError.message, /gave up after 4 attempts/);
});

test('a reel still processing is resumed by the next run', async (t) => {
  const env = await startWorkerEnv({ graph: { videoProcessingMs: 1500 } });
  t.after(() => env.close());
  const video = await env.addAsset('clip.mp4');
  const post = await schedulePost(env, { type: 'reel', caption: 'Slow pour', media: [{ assetId: video.id, kind: 'video' }] });

  const first = await env.run({ only: ['publish'], env: { POSTPILOT_PUBLISH_WAIT_MS: '200' } });
  assert.equal(first.exitCode, 0);
  let saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'publishing');
  assert.ok(saved.containers && saved.containers.parent, 'containers saved for the next run');
  assert.ok(first.lines.includes('publish: 0 published, 0 failed, 1 pending, 0 retried'));
  const containersBefore = env.graph.state.containers.size;

  await sleep(1600);
  const second = await env.run({ only: ['publish'], env: { POSTPILOT_PUBLISH_WAIT_MS: '2000' } });
  assert.equal(second.exitCode, 0);
  saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.equal(env.graph.state.containers.size, containersBefore, 'no new container on resume');
  assert.equal(saved.attempts, 1);
  const media = env.graph.state.media.find((m) => m.id === saved.igMediaId);
  assert.equal(media.media_product_type, 'REELS');
  assert.ok(env.graph.state.uploads.size >= 1, 'video bytes went through the resumable upload');
});

test('waits for a post due within the run window', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f04.jpg');
  const post = await schedulePost(env, { caption: 'On the dot', scheduledAt: new Date(Date.now() + 1500).toISOString(), media: [{ assetId: asset.id, kind: 'image' }] });

  const started = Date.now();
  const res = await env.run({ only: ['publish'], env: { POSTPILOT_MAX_WAIT_SEC: '6' } });
  assert.equal(res.exitCode, 0);
  assert.ok(res.lines.includes('publish: waiting for a scheduled post'));
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.ok(Date.parse(saved.publishedAt) >= Date.parse(post.scheduledAt));
  assert.ok(Date.now() - started < 6000);
});

test('does not wait for posts beyond the window or needing approval', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f05.jpg');
  await schedulePost(env, { caption: 'Later', scheduledAt: new Date(Date.now() + 60_000).toISOString(), media: [{ assetId: asset.id, kind: 'image' }] });
  await schedulePost(env, { caption: 'Approve me', needsApproval: true, media: [{ assetId: asset.id, kind: 'image' }] });
  const started = Date.now();
  const res = await env.run({ only: ['publish'], env: { POSTPILOT_MAX_WAIT_SEC: '2' } });
  assert.ok(Date.now() - started < 1800);
  assert.ok(!res.lines.includes('publish: waiting for a scheduled post'));
  const posts = (await env.read('posts')).posts;
  assert.ok(posts.every((p) => p.status === 'scheduled'));
});

test('publish_now from the outbox publishes in the same run', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f06.jpg');
  const post = newPost({ status: 'draft', caption: 'Now please', media: [{ assetId: asset.id, kind: 'image' }] });
  await env.update('posts', (d) => void d.posts.push(post));
  await env.update('inbox', (d) => void d.outbox.push({ id: 'cmd1', type: 'publish_now', payload: { postId: post.id }, status: 'pending', createdAt: new Date().toISOString() }));
  const res = await env.run({ only: ['outbox', 'publish'] });
  assert.equal(res.exitCode, 0);
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  const inbox = await env.read('inbox');
  assert.equal(inbox.outbox[0].status, 'done');
});

test('an expired login keeps the post scheduled and flags the connection', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f07.jpg');
  const post = await schedulePost(env, { caption: 'Blocked', media: [{ assetId: asset.id, kind: 'image' }] });
  await env.update('settings', (s) => {
    s.ig.token = 'expired-token';
  });
  const res = await env.run();
  assert.equal(res.exitCode, 0);
  const settings = await env.read('settings');
  assert.equal(settings.ig.status.state, 'expired');
  assert.match(settings.ig.status.message, /Reconnect Instagram/);
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'scheduled');
  assert.ok(res.lines.some((l) => /login has expired/.test(l)));
  assert.equal(res.summary.jobs.publish.skipped, 'token_expired');
});
