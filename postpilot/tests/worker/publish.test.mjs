import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv, visibleLines, sleep, fixtureBytes, TEST_TOKEN } from '../helpers/worker-env.mjs';
import { newAsset, newPost } from '../../core/model.js';
import { runWorker } from '../../worker/run.mjs';
import { TMP_BRANCH } from '../../worker/context.mjs';

const CAPTION = 'Secret launch caption about our spring collection';

async function schedulePost(env, partial) {
  const post = newPost({ status: 'scheduled', scheduledAt: new Date(Date.now() - 60_000).toISOString(), ...partial });
  await env.update('posts', (d) => {
    d.posts.push(post);
  });
  return post;
}

/** Files on the throwaway media branch (path -> blob sha). */
function tmpBranchFiles(env) {
  const head = env.ghMock.refs.get(TMP_BRANCH);
  if (!head) return new Map();
  const tree = env.ghMock.trees.get(env.ghMock.commits.get(head).tree);
  return new Map([...tree].filter(([p]) => p.startsWith('public/tmp/')));
}

/** Plaintext copies left anywhere: on the throwaway branch or (older workers) the data branch. */
async function tmpFiles(env) {
  await env.store.refresh();
  return [...(await env.store.list('public/tmp/')), ...tmpBranchFiles(env).keys()];
}

/** Every path that was ever in the data branch's history. */
function dataHistoryPaths(env) {
  const seen = new Set();
  const paths = new Set();
  const stack = [env.ghMock.refs.get('postpilot-data')];
  while (stack.length) {
    const sha = stack.pop();
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    const c = env.ghMock.commits.get(sha);
    for (const p of env.ghMock.trees.get(c.tree).keys()) paths.add(p);
    stack.push(...c.parents);
  }
  return [...paths];
}

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * Run the worker with a fetch wrapper: `fault(url, init)` may return a Response to answer a
 * request itself (injected GitHub failures); otherwise the request goes to the mocks.
 */
async function runWith(env, fault, { only = ['publish'], env: extra = {}, now } = {}) {
  const lines = [];
  const fetchImpl = async (url, init = {}) => (await fault(String(url), init)) || fetch(url, init);
  const res = await runWorker({ env: { ...env.env, ...extra }, only, now, fetchImpl, log: (l) => lines.push(String(l)) });
  return { ...res, lines };
}

/** Fail the next `times` data-branch commits with this message (fast: 422 is not retried). */
function failCommit(message, times = 1) {
  const state = { left: times, hits: 0 };
  state.fault = (url, init) => {
    if (state.left <= 0 || init.method !== 'POST' || !url.endsWith('/git/commits')) return null;
    if (JSON.parse(init.body).message !== `worker: ${message}`) return null;
    state.left--;
    state.hits++;
    return jsonResponse(422, { message: 'Validation Failed' });
  };
  return state;
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
  // The image URL Instagram fetched was a raw GitHub URL of a copy on the throwaway branch...
  assert.match(media.url, /\/gh\/raw\/o\/r\/postpilot-public-tmp\/public\/tmp\/\d+-[0-9a-f]+\.jpg$/);
  // ...which is gone again, and not reachable from any branch's history.
  assert.deepEqual(await tmpFiles(env), []);
  const tmpHead = env.ghMock.commits.get(env.ghMock.refs.get(TMP_BRANCH));
  assert.deepEqual(tmpHead.parents, [], 'the throwaway branch has no history');
  assert.ok(!dataHistoryPaths(env).some((p) => p.startsWith('public/tmp/')), 'the plaintext copy never touched the data branch');
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

test('video copies live on the throwaway branch without location metadata; a processing video keeps its copy and leftovers are swept', async (t) => {
  const env = await startWorkerEnv({ graph: { videoProcessingMs: 1500 } });
  t.after(() => env.close());
  // Instagram Login has no resumable upload: the video goes out through a public link.
  env.graph.state.faults.push({ method: 'POST', path: /\/media$/, when: (p) => p.upload_type === 'resumable', error: { code: 100, status: 400, message: 'Unsupported' }, times: 1 });
  // A copy left behind by an earlier run that was stopped mid-way.
  const stale = 'public/tmp/1700000000-0123456789abcdef01234567.jpg';
  const staleBlob = await env.gh.createBlob(new Uint8Array([1, 2, 3]));
  await env.gh.createRef(TMP_BRANCH, await env.gh.createCommit({ message: 'x', tree: await env.gh.createTree([{ path: stale, sha: staleBlob }]), parents: [] }));

  // A phone video with a GPS metadata box.
  const clip = await fixtureBytes('clip.mp4');
  const gps = Buffer.from('+40.7128-074.0060/');
  const udta = Buffer.alloc(8 + gps.length);
  udta.writeUInt32BE(udta.length);
  udta.write('udta', 4, 'latin1');
  gps.copy(udta, 8);
  const bytes = new Uint8Array(Buffer.concat([clip, udta]));
  const video = newAsset({ name: 'home.mp4', kind: 'video', mime: 'video/mp4', bytes: bytes.length, width: 720, height: 1280, durationSec: 5 });
  await env.store.refresh();
  await env.store.transact(async (tx) => {
    tx.writeBytes(video.path, bytes);
    tx.writeBytes(video.thumbPath, await fixtureBytes('story02.jpg'));
    const lib = await tx.read('library');
    lib.assets.push(video);
    tx.write('library', lib);
  });
  const post = await schedulePost(env, { type: 'reel', caption: 'Home pour', media: [{ assetId: video.id, kind: 'video' }] });

  const exposedBlobs = [];
  const watch = (url, init) => {
    if (init.method === 'POST' && url.endsWith('/git/blobs')) {
      const b = Buffer.from(JSON.parse(init.body).content, 'base64');
      if (b.subarray(4, 8).toString('latin1') === 'ftyp') exposedBlobs.push(b);
    }
    return null;
  };
  const first = await runWith(env, watch, { env: { POSTPILOT_PUBLISH_WAIT_MS: '200' } });
  assert.equal(first.exitCode, 0);
  let saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'publishing');
  assert.equal(saved.exposedPaths.length, 1);
  assert.deepEqual([...tmpBranchFiles(env).keys()], saved.exposedPaths, 'the processing video keeps its copy; the leftover is gone');
  const container = env.graph.state.containers.get(saved.containers.parent);
  assert.match(container.params.video_url, /\/postpilot-public-tmp\/public\/tmp\/\d+-[0-9a-f]+\.mp4$/);

  // What went public had its metadata box neutralised (same size, so the video still plays).
  assert.equal(exposedBlobs.length, 1);
  assert.equal(exposedBlobs[0].length, bytes.length);
  const tail = exposedBlobs[0].subarray(clip.length);
  assert.equal(tail.subarray(4, 8).toString('latin1'), 'free');
  assert.ok(!exposedBlobs[0].includes(Buffer.from('udta')), 'no metadata box left');
  // The stored original is untouched.
  await env.store.refresh();
  assert.ok(Buffer.from(await env.store.readBytes(video.path)).includes(Buffer.from('udta')));

  await sleep(1600);
  const second = await runWith(env, () => null, { env: { POSTPILOT_PUBLISH_WAIT_MS: '2000' } });
  assert.equal(second.exitCode, 0);
  saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.deepEqual(await tmpFiles(env), []);
  assert.ok(!dataHistoryPaths(env).some((p) => p.startsWith('public/tmp/')));
});

test('a carousel exposes its photos together: fewer throwaway-branch rewrites, all copies removed', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const assets = [await env.addAsset('f01.jpg'), await env.addAsset('f02.jpg'), await env.addAsset('f03.jpg'), await env.addAsset('f04.jpg')];
  const post = await schedulePost(env, { type: 'carousel', caption: 'Four at once', media: assets.map((a) => ({ assetId: a.id, kind: 'image' })) });
  const rewrites = () => [...env.ghMock.commits.values()].filter((c) => c.message === 'Temporary media for Instagram').length;
  const before = rewrites();
  const res = await env.run({ only: ['publish'] });
  assert.equal(res.summary.jobs.publish.published, 1);
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.equal(env.graph.state.media.find((m) => m.id === saved.igMediaId).children.length, 4);
  // One at a time this took 4 rewrites to add the copies and 1 to remove them.
  assert.ok(rewrites() - before <= 3, `copies exposed together share rewrites (${rewrites() - before})`);
  assert.deepEqual(await tmpFiles(env), []);
});

test('a GitHub write failure after Instagram published never publishes the post twice', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f08.jpg');
  const before = env.graph.state.publishCount;

  // One failed 'published' commit: retried on a fresh head in the same run, even on the last attempt.
  const once = await schedulePost(env, { caption: 'Last try', attempts: 3, media: [{ assetId: asset.id, kind: 'image' }] });
  const blip = failCommit('publish: published', 1);
  const run1 = await runWith(env, blip.fault);
  assert.equal(blip.hits, 1);
  assert.equal(run1.exitCode, 0);
  let saved = (await env.read('posts')).posts.find((p) => p.id === once.id);
  assert.equal(saved.status, 'published');
  assert.equal(env.graph.state.publishCount, before + 1);

  // GitHub keeps failing: the post stays 'publishing' with its containers and the next run records it.
  const post = await schedulePost(env, { caption: 'Live already', media: [{ assetId: asset.id, kind: 'image' }] });
  const outage = failCommit('publish: published', 2);
  const run2 = await runWith(env, outage.fault);
  assert.equal(outage.hits, 2);
  assert.equal(env.graph.state.publishCount, before + 2);
  saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'publishing');
  assert.ok(saved.containers && saved.containers.parent);
  assert.equal(saved.lastError, null);
  assert.deepEqual(await tmpFiles(env), [], 'the copy is removed at the end of the run');
  assert.ok(run2.lines.some((l) => /^publish: failed \(GitHub error 422\)/.test(l)));

  const run3 = await runWith(env, () => null);
  assert.equal(run3.exitCode, 0);
  saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.equal(env.graph.state.publishCount, before + 2, 'not published a second time');
});

test('a story is not published when its upload progress cannot be saved', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('story03.jpg', { width: 1080, height: 1920 });
  const post = await schedulePost(env, { type: 'story', caption: '', media: [{ assetId: asset.id, kind: 'image' }] });
  const before = env.graph.state.publishCount;

  const blip = failCommit('publish: containers created', 1);
  const run1 = await runWith(env, blip.fault);
  assert.equal(run1.exitCode, 0);
  assert.equal(env.graph.state.publishCount, before, 'media_publish never ran without saved containers');
  let saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'scheduled');
  assert.match(saved.lastError.message, /Could not save upload progress/);
  assert.deepEqual(await tmpFiles(env), []);

  await runWith(env, () => null);
  saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.equal(env.graph.state.publishCount, before + 1);
});

test('a GitHub 403 while publishing is not taken for an expired Instagram login', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f09.jpg');
  const post = await schedulePost(env, { caption: 'Rate limited', media: [{ assetId: asset.id, kind: 'image' }] });
  const isJpegBlob = (url, init) => init.method === 'POST' && url.endsWith('/git/blobs') && JSON.parse(init.body).content.startsWith('/9j/');

  // A secondary rate limit on the exposed copy is waited out and retried.
  let limited = 0;
  const rateLimit = (url, init) => {
    if (limited || !isJpegBlob(url, init)) return null;
    limited++;
    return jsonResponse(403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, { 'retry-after': '0.05' });
  };
  const run1 = await runWith(env, rateLimit, { only: ['token', 'publish'] });
  assert.equal(limited, 1);
  assert.equal(run1.exitCode, 0);
  let saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
  assert.notEqual((await env.read('settings')).ig.status?.state, 'expired');

  // A GitHub refusal that is not retried: the post goes back to the queue, the login stays fine.
  const post2 = await schedulePost(env, { caption: 'Refused', media: [{ assetId: asset.id, kind: 'image' }] });
  const refuse = (url, init) => (isJpegBlob(url, init) ? jsonResponse(403, { message: 'Resource not accessible by integration' }) : null);
  const run2 = await runWith(env, refuse, { only: ['token', 'publish'] });
  assert.equal(run2.exitCode, 0);
  const settings = await env.read('settings');
  assert.notEqual(settings.ig.status?.state, 'expired');
  assert.equal(env.pushes.length, 0);
  saved = (await env.read('posts')).posts.find((p) => p.id === post2.id);
  assert.equal(saved.status, 'scheduled');
  assert.equal(saved.lastError.code, 'github');
  assert.ok(!run2.lines.some((l) => /login/i.test(l)));
  assert.equal(run2.summary.jobs.publish.retried, 1);

  // The next run publishes it (Instagram jobs were never paused).
  const run3 = await runWith(env, () => null, { only: ['token', 'publish'] });
  assert.equal(run3.summary.jobs.publish.published, 1);
});

test('a GitHub rate limit that outlasts the retries is not counted as an attempt', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f09.jpg');
  const post = await schedulePost(env, { caption: 'Busy GitHub', media: [{ assetId: asset.id, kind: 'image' }] });
  let limited = 0;
  const rateLimit = (url, init) => {
    if (init.method !== 'POST' || !url.endsWith('/git/blobs') || !JSON.parse(init.body).content.startsWith('/9j/')) return null;
    limited++;
    return jsonResponse(403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, { 'retry-after': '0.01' });
  };
  // More runs than MAX_ATTEMPTS: a temporary error would have failed the post by now.
  for (let i = 0; i < 5; i++) {
    const res = await runWith(env, rateLimit, { only: ['publish'] });
    assert.equal(res.exitCode, 0);
    assert.equal(res.summary.jobs.publish.retried, 1);
  }
  assert.equal(limited, 15, 'each run tried three times');
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'scheduled');
  assert.equal(saved.attempts, 0);
  assert.equal(saved.lastError.code, 'github');
  assert.equal(saved.lastError.permanent, false);
  assert.match(saved.lastError.message, /rate limit/);
  const run = await runWith(env, () => null, { only: ['publish'] });
  assert.equal(run.summary.jobs.publish.published, 1);
});

test('stops claiming posts once the run is out of time', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f10.jpg');
  const a = await schedulePost(env, { caption: 'First', media: [{ assetId: asset.id, kind: 'image' }] });
  const b = await schedulePost(env, { caption: 'Second', media: [{ assetId: asset.id, kind: 'image' }] });
  const before = env.graph.state.publishCount;
  // The clock jumps 15 minutes once the first post is out (a slow upload).
  const res = await env.run({ only: ['publish'], now: () => Date.now() + (env.graph.state.publishCount > before ? 15 * 60e3 : 0) });
  assert.equal(res.exitCode, 0);
  assert.equal(env.graph.state.publishCount, before + 1);
  const posts = (await env.read('posts')).posts;
  const statuses = [a, b].map((p) => posts.find((x) => x.id === p.id)).map((p) => [p.status, p.attempts || 0]).sort();
  assert.deepEqual(statuses, [['published', 1], ['scheduled', 0]]);
  const next = await env.run({ only: ['publish'] });
  assert.equal(next.summary.jobs.publish.published, 1);
});

test('a post published now is picked up while the run waits for a later post', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f11.jpg');
  const later = await schedulePost(env, { caption: 'Later', scheduledAt: new Date(Date.now() + 3000).toISOString(), media: [{ assetId: asset.id, kind: 'image' }] });
  const running = env.run({ only: ['publish'], env: { POSTPILOT_MAX_WAIT_SEC: '8', POSTPILOT_WAIT_SLICE_MS: '200' } });
  await sleep(400);
  const now = await schedulePost(env, { caption: 'Now', scheduledAt: new Date().toISOString(), media: [{ assetId: asset.id, kind: 'image' }] });
  const res = await running;
  assert.equal(res.exitCode, 0);
  const posts = (await env.read('posts')).posts;
  const savedNow = posts.find((p) => p.id === now.id);
  const savedLater = posts.find((p) => p.id === later.id);
  assert.equal(savedNow.status, 'published');
  assert.equal(savedLater.status, 'published');
  assert.ok(Date.parse(savedNow.publishedAt) < Date.parse(later.scheduledAt), 'not held back until the later post was due');
});

// ---------------------------------------------------------------------------
// Reminder posts and media still downloading from a link

const subtle = globalThis.crypto.subtle;

/** A push subscription on the test server plus the keys to read what was sent to it. */
async function pushDevice(env, name) {
  const { b64url } = await import('../../core/webpush.js');
  const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64url(new Uint8Array(await subtle.exportKey('raw', keys.publicKey)));
  return { keys, auth, sub: { endpoint: `${env.url}/push/${name}`, keys: { p256dh, auth: b64url(auth) }, device: name, createdAt: new Date().toISOString() } };
}

/** RFC 8291 decryption, as the browser does it. */
async function readPush(body, ua, authSecret) {
  const te = new TextEncoder();
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (s, ikm, info, len) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const ikm = await hk(authSecret, secret, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

/** Instagram calls that publish or check the quota (none of these may happen for a reminder). */
const publishingCalls = (env, from = 0) =>
  env.graph.state.requests.slice(from).filter((r) => (r.method === 'POST' && /\/media(_publish)?$/.test(r.path)) || /content_publishing_limit/.test(r.path));

test('a due reminder post sends a phone notification instead of publishing, once', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await pushDevice(env, 'phone');
  const { generateVapidKeys } = await import('../../core/webpush.js');
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  await env.update('settings', (s) => {
    s.notifications = { vapid, subscriptions: [phone.sub], events: { published: true, failed: true, reminder: true } };
  });
  const asset = await env.addAsset('f02.jpg');
  const reminder = await schedulePost(env, { caption: 'Poll in the story: which glaze next?', type: 'story', publishMode: 'reminder', media: [{ assetId: asset.id, kind: 'image' }] });
  const auto = await schedulePost(env, { caption: 'Automatic one', media: [{ assetId: asset.id, kind: 'image' }] });
  const before = env.graph.state.publishCount;
  const mark = env.graph.state.requests.length;

  const res = await env.run({ only: ['publish'] });
  assert.equal(res.exitCode, 0);
  assert.equal(env.graph.state.publishCount, before + 1, 'only the automatic post was published');
  assert.equal(res.summary.jobs.publish.reminded, 1);
  assert.equal(res.summary.jobs.publish.published, 1);
  assert.ok(res.lines.includes('publish: 1 published, 0 failed, 0 pending, 0 retried, 1 reminded'));
  assert.ok(!visibleLines(res.lines).join('\n').includes('which glaze'), 'caption never printed');

  const posts = (await env.read('posts')).posts;
  const saved = posts.find((p) => p.id === reminder.id);
  assert.equal(saved.status, 'reminded');
  assert.ok(Date.parse(saved.reminderSentAt) > Date.now() - 60_000);
  assert.equal(saved.igMediaId, null);
  assert.equal(saved.attempts, 0, 'a reminder is not a publishing attempt');
  assert.equal(saved.history[saved.history.length - 1].event, 'reminder sent');
  assert.equal(posts.find((p) => p.id === auto.id).status, 'published');
  // Exactly one container + one publish for the automatic post: the reminder made no Instagram calls.
  const created = env.graph.state.requests.slice(mark).filter((r) => r.method === 'POST' && /\/media$/.test(r.path));
  assert.equal(created.length, 1);

  const pushes = env.pushes.filter((p) => p.path === '/phone');
  const payloads = await Promise.all(pushes.map((p) => readPush(p.body, phone.keys, phone.auth)));
  const remind = payloads.find((p) => p.tag === 'postpilot-reminder');
  assert.ok(remind, 'reminder push sent');
  assert.equal(remind.title, 'Time to post your story');
  assert.equal(remind.body, 'Poll in the story: which glaze next?');
  assert.equal(remind.url, `./#/post-now/${encodeURIComponent(reminder.id)}`);
  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'publish' && /reminder/.test(e.message) && e.data?.postId === reminder.id));

  // Not picked again on the next run.
  const again = await env.run({ only: ['publish'] });
  assert.equal(again.summary.jobs.publish.reminded, undefined);
  assert.equal(env.pushes.filter((p) => p.path === '/phone').length, pushes.length, 'no second reminder');
  assert.equal((await env.read('posts')).posts.find((p) => p.id === reminder.id).status, 'reminded');
});

test('reminders go out while Instagram is disconnected or its login expired; automatic posts wait', async (t) => {
  const off = await startWorkerEnv({ connect: false });
  t.after(() => off.close());
  const asset = await off.addAsset('f03.jpg');
  const reminder = await schedulePost(off, { caption: 'Link sticker to the shop', publishMode: 'reminder', media: [{ assetId: asset.id, kind: 'image' }] });
  const auto = await schedulePost(off, { caption: 'Waits for Instagram', media: [{ assetId: asset.id, kind: 'image' }] });
  const res = await off.run();
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.summary.jobs.publish, { reminded: 1 });
  assert.ok(res.lines.includes('publish: 1 reminded'));
  assert.ok(res.lines.some((l) => /Instagram is not connected/.test(l)), 'the other Instagram jobs still say why they were skipped');
  let posts = (await off.read('posts')).posts;
  assert.equal(posts.find((p) => p.id === reminder.id).status, 'reminded');
  assert.equal(posts.find((p) => p.id === auto.id).status, 'scheduled');
  assert.equal(off.graph.state.requests.length, 0, 'no Instagram calls at all');
  // Nothing left to remind: the job reports the usual skip reason.
  const idle = await off.run();
  assert.equal(idle.summary.jobs.publish.skipped, 'not_connected');

  const env = await startWorkerEnv();
  t.after(() => env.close());
  const a2 = await env.addAsset('f03.jpg');
  const r2 = await schedulePost(env, { caption: 'Music from the library', type: 'reel', publishMode: 'reminder', media: [{ assetId: a2.id, kind: 'image' }] });
  const p2 = await schedulePost(env, { caption: 'Blocked', media: [{ assetId: a2.id, kind: 'image' }] });
  await env.update('settings', (s) => {
    s.ig.token = 'expired-token';
    s.ig.tokenRefreshedAt = new Date(Date.now() - 8 * 864e5).toISOString();
  });
  const expired = await env.run();
  assert.equal(expired.summary.jobs.token.tokenExpired, 1);
  assert.deepEqual(expired.summary.jobs.publish, { reminded: 1 });
  posts = (await env.read('posts')).posts;
  assert.equal(posts.find((p) => p.id === r2.id).status, 'reminded');
  assert.equal(posts.find((p) => p.id === p2.id).status, 'scheduled');
});

test('reminders do not touch the publishing quota', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  env.graph.state.publishLimit = 0; // quota used up: automatic posts would be held back
  const asset = await env.addAsset('f04.jpg');
  const reminder = await schedulePost(env, { caption: 'Quota does not matter', publishMode: 'reminder', media: [{ assetId: asset.id, kind: 'image' }] });
  const mark = env.graph.state.requests.length;
  const res = await env.run({ only: ['publish'] });
  assert.equal(res.summary.jobs.publish.reminded, 1);
  assert.deepEqual(publishingCalls(env, mark), [], 'no quota check, container or publish call');
  assert.equal((await env.read('posts')).posts.find((p) => p.id === reminder.id).status, 'reminded');
});

test('a post whose media is still downloading waits, noted once; a failed or stalled download fails it', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const ready = await env.addAsset('f05.jpg');
  const pendingAsset = await env.addAsset('f06.jpg', { name: 'From the feed', importUrl: 'https://example.com/a.jpg' });
  const brokenAsset = await env.addAsset('f07.jpg', { name: 'Broken link', importUrl: 'https://example.com/b.jpg', importError: 'HTTP 404' });
  // Tried twice already and backing off (the feeds job does not try it again in this run).
  const slowAsset = await env.addAsset('f08.jpg', { name: 'Slow link', importUrl: 'https://example.com/c.jpg', importAttempts: 2, importTriedAt: new Date(Date.now() - 5 * 60e3).toISOString() });
  const waiting = await schedulePost(env, { type: 'carousel', caption: 'Waits for the download', media: [{ assetId: ready.id, kind: 'image' }, { assetId: pendingAsset.id, kind: 'image' }] });
  const broken = await schedulePost(env, { caption: 'Download failed', media: [{ assetId: brokenAsset.id, kind: 'image' }] });
  const longAgo = new Date(Date.now() - 7 * 36e5).toISOString();
  const stalled = await schedulePost(env, { caption: 'Stalled', publishMode: 'reminder', scheduledAt: longAgo, history: [{ at: longAgo, event: 'scheduled' }], media: [{ assetId: slowAsset.id, kind: 'image' }] });
  // Due 7 hours ago too, but its file was never tried (the worker was paused): it waits for this run's download.
  const paused = await schedulePost(env, { caption: 'Due while paused', scheduledAt: longAgo, history: [{ at: longAgo, event: 'scheduled' }], media: [{ assetId: pendingAsset.id, kind: 'image' }] });
  // Scheduled again a minute ago with its old time (after "Try again"): the 6 hours start now.
  const again = await schedulePost(env, { caption: 'Scheduled again', scheduledAt: new Date(Date.now() - 2 * 864e5).toISOString(), history: [{ at: new Date(Date.now() - 60e3).toISOString(), event: 'scheduled' }], media: [{ assetId: slowAsset.id, kind: 'image' }] });
  const before = env.graph.state.publishCount;

  const res = await env.run({ only: ['publish'] });
  assert.equal(res.exitCode, 1, 'failed posts make the run fail so GitHub emails the owner');
  assert.equal(env.graph.state.publishCount, before, 'nothing was attempted');
  assert.equal(res.summary.jobs.publish.failed, 2);
  assert.equal(res.summary.jobs.publish.reminded, undefined);
  let posts = (await env.read('posts')).posts;
  const w = posts.find((p) => p.id === waiting.id);
  assert.equal(w.status, 'scheduled');
  assert.equal(w.attempts, 0);
  assert.equal(w.history.filter((h) => h.event === 'waiting_download').length, 1);
  assert.match(w.history[w.history.length - 1].detail, /"From the feed" from its link/);
  const b = posts.find((p) => p.id === broken.id);
  assert.equal(b.status, 'failed');
  assert.equal(b.lastError.code, 'import_failed');
  assert.equal(b.lastError.permanent, true);
  assert.match(b.lastError.message, /could not download "Broken link" from its link \(HTTP 404\)/);
  const s = posts.find((p) => p.id === stalled.id);
  assert.equal(s.status, 'failed', 'a reminder needs its media too');
  assert.equal(s.lastError.code, 'import_timeout');
  assert.match(s.lastError.message, /6 hours after this post was due/);
  for (const id of [paused.id, again.id]) {
    const p = posts.find((x) => x.id === id);
    assert.equal(p.status, 'scheduled', `${p.caption}: still waiting`);
    assert.equal(p.history[p.history.length - 1].event, 'waiting_download');
  }

  // Next run: still waiting, but not noted (or logged) again.
  await env.run({ only: ['publish'] });
  posts = (await env.read('posts')).posts;
  assert.equal(posts.find((p) => p.id === waiting.id).history.filter((h) => h.event === 'waiting_download').length, 1);
  const log = await env.read('log');
  assert.equal(log.entries.filter((e) => e.data?.postId === waiting.id).length, 1, 'logged once per post');

  // Once the worker has the file, the post publishes.
  await env.update('library', (lib) => {
    const a = lib.assets.find((x) => x.id === pendingAsset.id);
    a.sourceUrl = a.importUrl;
    delete a.importUrl;
  });
  const after = await env.run({ only: ['publish'] });
  assert.equal(after.summary.jobs.publish.published, 2, 'both posts that waited for this file');
  posts = (await env.read('posts')).posts;
  assert.equal(posts.find((p) => p.id === waiting.id).status, 'published');
  assert.equal(posts.find((p) => p.id === paused.id).status, 'published');
  assert.equal(posts.find((p) => p.id === again.id).status, 'scheduled', 'its file is still downloading');
});

test('a post whose file Instagram cannot take fails without offering Try again', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const png = await env.addAsset('f05.jpg', {
    name: 'Banner',
    importUrl: 'https://example.com/banner.png',
    importError: 'This is a PNG image. Instagram only takes JPEG photos and the worker cannot convert images. Download the file and upload it in the Library, which converts it to JPEG.',
    importErrorCode: 'not_jpeg',
  });
  const flaky = await env.addAsset('f06.jpg', { name: 'Flaky', importUrl: 'https://example.com/f.jpg', importError: 'HTTP 503 Tried 5 times.', importErrorCode: 'tries' });
  const refused = await schedulePost(env, { caption: 'PNG from the feed', media: [{ assetId: png.id, kind: 'image' }] });
  // Both kinds in one carousel: the refused file is the one named (trying again cannot help).
  const both = await schedulePost(env, { type: 'carousel', caption: 'Mixed', media: [{ assetId: flaky.id, kind: 'image' }, { assetId: png.id, kind: 'image' }] });
  const retry = await schedulePost(env, { caption: 'Temporary failure', media: [{ assetId: flaky.id, kind: 'image' }] });

  const res = await env.run({ only: ['publish'] });
  assert.equal(res.summary.jobs.publish.failed, 3);
  const posts = (await env.read('posts')).posts;
  for (const id of [refused.id, both.id]) {
    const p = posts.find((x) => x.id === id);
    assert.equal(p.status, 'failed');
    assert.equal(p.lastError.code, 'import_failed');
    assert.equal(
      p.lastError.message,
      'Instagram cannot take "Banner": This is a PNG image. Instagram only takes JPEG photos and the worker cannot convert images. Download the file and upload it in the Library, which converts it to JPEG. Replace the file in this post.',
    );
    assert.doesNotMatch(p.lastError.message, /Try again/);
  }
  const r = posts.find((x) => x.id === retry.id);
  assert.match(r.lastError.message, /could not download "Flaky" from its link \(HTTP 503 Tried 5 times\.\)\. In the Library, choose Try again/);
});

test('a post due hours ago is not failed in the run that downloads its file (publish runs before feeds)', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const jpeg = await fixtureBytes('f05.jpg');
  const site = 'https://feeds.test';
  const asset = await env.addAsset('f06.jpg', { name: 'From the CSV', importUrl: `${site}/img/a.jpg` });
  const longAgo = new Date(Date.now() - 7 * 36e5).toISOString();
  const post = await schedulePost(env, { caption: 'Paused, then resumed', scheduledAt: longAgo, history: [{ at: longAgo, event: 'scheduled' }], media: [{ assetId: asset.id, kind: 'image' }] });
  const site200 = (url) => (url.startsWith(site) ? new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }) : null);

  const first = await runWith(env, site200, { only: ['publish', 'feeds'] });
  assert.equal(first.exitCode, 0);
  assert.equal(first.summary.jobs.feeds.downloaded, 1);
  let saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'scheduled', 'waits for the download instead of failing');
  assert.equal((await env.read('library')).assets.find((a) => a.id === asset.id).importUrl, undefined, 'downloaded in the same run');

  const second = await runWith(env, site200, { only: ['publish', 'feeds'] });
  assert.equal(second.summary.jobs.publish.published, 1);
  saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'published');
});

test('a reminder push goes out right away, not after the run waits for a later post', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await pushDevice(env, 'phone');
  const { generateVapidKeys } = await import('../../core/webpush.js');
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  await env.update('settings', (s) => {
    s.notifications = { vapid, subscriptions: [phone.sub], events: { reminder: true, published: true } };
  });
  const asset = await env.addAsset('f02.jpg');
  const reminder = newPost({ status: 'scheduled', publishMode: 'reminder', scheduledAt: new Date(Date.now() + 1000).toISOString(), caption: 'Reminder first', media: [{ assetId: asset.id, kind: 'image' }] });
  const later = newPost({ status: 'scheduled', scheduledAt: new Date(Date.now() + 6000).toISOString(), caption: 'Automatic later', media: [{ assetId: asset.id, kind: 'image' }] });
  await env.update('posts', (d) => void d.posts.push(reminder, later));
  let reminderPushAt = null;
  const res = await runWith(
    env,
    (url) => {
      if (url.includes('/push/') && reminderPushAt == null) reminderPushAt = Date.now();
      return null;
    },
    { env: { POSTPILOT_MAX_WAIT_SEC: '10', POSTPILOT_WAIT_SLICE_MS: '200' } },
  );
  assert.equal(res.summary.jobs.publish.reminded, 1);
  assert.equal(res.summary.jobs.publish.published, 1);
  const saved = (await env.read('posts')).posts.find((p) => p.id === reminder.id);
  assert.ok(reminderPushAt && reminderPushAt - Date.parse(saved.reminderSentAt) < 3000, 'pushed as soon as it was marked');
  const payloads = await Promise.all(env.pushes.filter((p) => p.path === '/phone').map((p) => readPush(p.body, phone.keys, phone.auth)));
  assert.equal(payloads.filter((p) => p.tag === 'postpilot-reminder').length, 1, 'sent once, not again at the end of the run');
  assert.equal(payloads.filter((p) => p.tag === 'postpilot-published').length, 1, 'other events still go out at the end');
  assert.ok(res.lines.some((l) => l === 'notifications: 1 sent, 0 failed'));
});

test('a reminder with no device to notify says so in the log and history', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f02.jpg');
  const post = await schedulePost(env, { caption: 'Nobody gets a push', publishMode: 'reminder', media: [{ assetId: asset.id, kind: 'image' }] });
  const res = await env.run({ only: ['publish'] });
  assert.equal(res.summary.jobs.publish.reminded, 1);
  assert.equal(env.pushes.length, 0);
  const saved = (await env.read('posts')).posts.find((p) => p.id === post.id);
  assert.equal(saved.status, 'reminded');
  assert.match(saved.history[saved.history.length - 1].detail, /No device gets notifications/);
  const log = await env.read('log');
  const entries = log.entries.filter((e) => e.job === 'publish' && e.data?.postId === post.id);
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, /shows on the Today screen only/);
  assert.ok(!entries.some((e) => /^Sent a reminder/.test(e.message)), 'does not claim a reminder was sent');

  // Instagram disconnected: the app shows only the Setup screen, which lists posts to post by hand.
  const off = await startWorkerEnv({ connect: false });
  t.after(() => off.close());
  const a2 = await off.addAsset('f02.jpg');
  const p2 = await schedulePost(off, { caption: 'Disconnected', publishMode: 'reminder', media: [{ assetId: a2.id, kind: 'image' }] });
  const res2 = await off.run({ only: ['publish'] });
  assert.equal(res2.summary.jobs.publish.reminded, 1);
  const s2 = (await off.read('posts')).posts.find((p) => p.id === p2.id);
  assert.equal(s2.history[s2.history.length - 1].detail, 'No device gets notifications, so it shows on the Setup screen only.');
  const e2 = (await off.read('log')).entries.filter((e) => e.job === 'publish' && e.data?.postId === p2.id);
  assert.equal(e2.length, 1);
  assert.match(e2[0].message, /shows on the Setup screen only/);
  assert.doesNotMatch(e2[0].message, /Today/);
});
