import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv } from '../helpers/worker-env.mjs';
import { newAsset, newList, newPost } from '../../core/model.js';

test('evergreen lists create scheduled posts idempotently', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const a1 = await env.addAsset('f01.jpg');
  const a2 = await env.addAsset('f02.jpg');
  const list = newList({
    id: 'l_tbt',
    name: 'Daily throwback',
    slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: '12:00' })),
    horizonDays: 7,
    items: [
      { id: 'i1', type: 'feed', caption: 'Throwback one', firstComment: '', media: [{ assetId: a1.id, kind: 'image', altText: '' }], timesUsed: 0, lastUsedAt: null },
      { id: 'i2', type: 'feed', caption: 'Throwback two', firstComment: '', media: [{ assetId: a2.id, kind: 'image', altText: '' }], timesUsed: 0, lastUsedAt: null },
    ],
  });
  await env.update('lists', (d) => void d.lists.push(list));

  const first = await env.run({ only: ['evergreen'] });
  const posts = (await env.read('posts')).posts.filter((p) => p.listId === 'l_tbt');
  assert.ok(posts.length >= 6 && posts.length <= 8, `one post per day for a week (${posts.length})`);
  assert.equal(first.summary.jobs.evergreen.evergreenCreated, posts.length);
  for (const p of posts) {
    assert.equal(p.status, 'scheduled');
    assert.equal(p.source, 'evergreen');
    assert.equal(p.needsApproval, false);
    assert.ok(['i1', 'i2'].includes(p.listItemId));
    assert.ok(Date.parse(p.scheduledAt) > Date.now());
  }
  // Items alternate.
  const sorted = posts.slice().sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  assert.notEqual(sorted[0].listItemId, sorted[1].listItemId);
  const saved = (await env.read('lists')).lists[0];
  assert.equal(saved.nextIndex, posts.length % 2);

  const second = await env.run({ only: ['evergreen'] });
  assert.equal(second.summary.jobs.evergreen.evergreenCreated, 0);
  assert.equal((await env.read('posts')).posts.filter((p) => p.listId === 'l_tbt').length, posts.length);
});

test('evergreen: moving a queue post or changing the time zone does not refill its slot', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const a1 = await env.addAsset('f01.jpg');
  const a2 = await env.addAsset('f02.jpg');
  const list = newList({
    id: 'l_daily',
    slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: '12:00' })),
    horizonDays: 7,
    items: [
      { id: 'i1', type: 'feed', caption: 'One', media: [{ assetId: a1.id, kind: 'image', altText: '' }], timesUsed: 0 },
      { id: 'i2', type: 'feed', caption: 'Two', media: [{ assetId: a2.id, kind: 'image', altText: '' }], timesUsed: 0 },
    ],
  });
  await env.update('lists', (d) => void d.lists.push(list));
  const now = '2026-10-12T08:00:00Z'; // Monday
  const listPosts = async () => (await env.read('posts')).posts.filter((p) => p.listId === 'l_daily');

  await env.run({ only: ['evergreen'], now });
  const posts = await listPosts();
  assert.deepEqual(posts.map((p) => p.listSlot).sort(), ['12', '13', '14', '15', '16', '17', '18'].map((d) => `2026-10-${d}@12:00`));

  // Drag Wednesday's post to Thursday evening and shift Friday's by two days (planner moves).
  await env.update('posts', (d) => {
    d.posts.find((p) => p.listSlot === '2026-10-14@12:00').scheduledAt = '2026-10-15T18:00:00.000Z';
    const fri = d.posts.find((p) => p.listSlot === '2026-10-16@12:00');
    fri.scheduledAt = new Date(Date.parse(fri.scheduledAt) + 2 * 864e5).toISOString();
  });
  const moved = await env.run({ only: ['evergreen'], now });
  assert.equal(moved.summary.jobs.evergreen.evergreenCreated, 0);

  // Time zone changes: the same local slots are already filled.
  for (const zone of ['Europe/Berlin', 'America/New_York']) {
    await env.update('settings', (s) => void (s.timezone = zone));
    const res = await env.run({ only: ['evergreen'], now });
    assert.equal(res.summary.jobs.evergreen.evergreenCreated, 0, zone);
  }
  assert.equal((await listPosts()).length, 7);
});

test('publishing an evergreen post counts the use; non-repeating lists drop the item', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const a1 = await env.addAsset('f03.jpg');
  const list = newList({ id: 'l_once', repeat: false, slots: [{ weekday: 1, time: '09:00' }], items: [{ id: 'once', type: 'feed', caption: 'Only once', media: [{ assetId: a1.id, kind: 'image', altText: '' }], timesUsed: 0 }] });
  const list2 = newList({ id: 'l_rep', slots: [{ weekday: 1, time: '09:00' }], items: [{ id: 'rep', type: 'feed', caption: 'Again and again', media: [{ assetId: a1.id, kind: 'image', altText: '' }], timesUsed: 3 }] });
  await env.update('lists', (d) => void d.lists.push(list, list2));
  const due = new Date(Date.now() - 1000).toISOString();
  await env.update('posts', (d) => {
    d.posts.push(newPost({ status: 'scheduled', scheduledAt: due, caption: 'Only once', listId: 'l_once', listItemId: 'once', source: 'evergreen', media: [{ assetId: a1.id, kind: 'image' }] }));
    d.posts.push(newPost({ status: 'scheduled', scheduledAt: due, caption: 'Again and again', listId: 'l_rep', listItemId: 'rep', source: 'evergreen', media: [{ assetId: a1.id, kind: 'image' }] }));
  });
  await env.run({ only: ['publish'] });
  const lists = (await env.read('lists')).lists;
  assert.equal(lists.find((l) => l.id === 'l_once').items.length, 0);
  const rep = lists.find((l) => l.id === 'l_rep').items[0];
  assert.equal(rep.timesUsed, 4);
  assert.ok(rep.lastUsedAt);
});

test('autopilot in review mode creates drafts with AI captions', async (t) => {
  const env = await startWorkerEnv({ settings: { ai: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5-5', voice: 'Warm', language: 'English', emoji: 'some', enabled: true } } });
  t.after(() => env.close());
  const assets = [];
  for (const f of ['f01.jpg', 'f02.jpg', 'f03.jpg']) assets.push(await env.addAsset(f, { autopilot: true, captionHint: `Hint for ${f}` }));
  await env.update('hashtags', (h) => void h.sets.push({ id: 'hs1', name: 'Clay', tags: ['#ceramics', '#pottery'] }));
  await env.update('autopilot', (a) => Object.assign(a, { enabled: true, mode: 'review', postsPerWeek: 7, horizonDays: 7, useAi: true, hashtagSetIds: ['hs1'], allowedTypes: ['feed'] }));

  const res = await env.run({ only: ['autopilot'] });
  assert.equal(res.exitCode, 0);
  const created = (await env.read('posts')).posts.filter((p) => p.source === 'autopilot');
  assert.equal(created.length, 3);
  for (const p of created) {
    assert.equal(p.status, 'draft');
    assert.equal(p.needsApproval, true);
    assert.ok(p.caption.length > 10);
    assert.ok(Date.parse(p.scheduledAt) > Date.now());
  }
  assert.equal(env.anthropic.state.requests.length, 3);
  const req = env.anthropic.state.requests[0];
  assert.ok(req.messages[0].content.some((b) => b.type === 'image'), 'thumbnail sent to Claude');
  const lib = await env.read('library');
  for (const a of assets) assert.equal(lib.assets.find((x) => x.id === a.id).usedBy.length, 1);
  const ap = await env.read('autopilot');
  assert.ok(ap.lastRunAt);
  assert.equal(ap.lastResult.created, 3);
  assert.equal(res.summary.jobs.autopilot.aiCaptions, 3);

  // Next run: nothing left to plan with.
  const again = await env.run({ only: ['autopilot'] });
  assert.equal(again.summary.jobs.autopilot.autopilotCreated, 0);
});

test('autopilot without AI uses caption hints and hashtag sets; auto mode schedules', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.addAsset('f05.jpg', { autopilot: true, captionHint: 'Fresh from the kiln.' });
  await env.update('hashtags', (h) => void h.sets.push({ id: 'hs1', name: 'Clay', tags: ['#ceramics', 'pottery'] }));
  await env.update('autopilot', (a) => Object.assign(a, { enabled: true, mode: 'auto', postsPerWeek: 3, horizonDays: 7, useAi: true, hashtagSetIds: ['hs1'] }));
  await env.run({ only: ['autopilot'] });
  const [p] = (await env.read('posts')).posts;
  assert.equal(p.status, 'scheduled');
  assert.equal(p.needsApproval, false);
  assert.equal(p.caption, 'Fresh from the kiln.\n\n#ceramics #pottery');
});

test('autopilot does not draft media again after its draft was rejected (use any unused media on)', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f04.jpg', { captionHint: 'Glaze test.' });
  await env.update('autopilot', (a) => Object.assign(a, { enabled: true, mode: 'review', postsPerWeek: 3, horizonDays: 7, useAi: false, useAllUnused: true }));
  await env.run({ only: ['autopilot'] });
  const [draft] = (await env.read('posts')).posts.filter((p) => p.source === 'autopilot');
  assert.equal(draft.media[0].assetId, asset.id);

  // Reject it the way the app does.
  await env.update('posts', (d) => {
    const p = d.posts.find((x) => x.id === draft.id);
    p.status = 'canceled';
    p.needsApproval = false;
    p.history.push({ at: new Date().toISOString(), event: 'rejected', detail: 'Rejected in the app.' });
  });
  const again = await env.run({ only: ['autopilot'] });
  assert.equal(again.summary.jobs.autopilot.autopilotCreated, 0);
  assert.equal((await env.read('posts')).posts.filter((p) => p.source === 'autopilot' && p.status !== 'canceled').length, 0);
  assert.equal((await env.read('autopilot')).lastResult.code, 'no_assets');
});

test('autopilot leaves queue media and files still downloading to others (use any unused media on)', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const queued = await env.addAsset('f04.jpg', { captionHint: 'From the blog.' });
  const free = await env.addAsset('f05.jpg', { captionHint: 'Free to use.' });
  await env.update('library', (d) => {
    d.assets.push(newAsset({ id: 'a_wait', name: 'wait.jpg', importUrl: 'https://feeds.test/wait.jpg' }));
    d.assets.push(newAsset({ id: 'a_png', name: 'chart.png', importUrl: 'https://feeds.test/chart.png', importError: 'This is a PNG image.' }));
  });
  await env.update('lists', (d) => void d.lists.push(newList({ id: 'l_blog', name: 'Blog', enabled: false, items: [{ id: 'li_1', type: 'feed', caption: 'x', media: [{ assetId: queued.id, kind: 'image' }] }], slots: [{ weekday: 3, time: '12:00' }] })));
  await env.update('autopilot', (a) => Object.assign(a, { enabled: true, mode: 'review', postsPerWeek: 7, horizonDays: 7, useAi: false, useAllUnused: true }));
  await env.run({ only: ['autopilot'] });
  const drafted = (await env.read('posts')).posts.filter((p) => p.source === 'autopilot').flatMap((p) => p.media.map((m) => m.assetId));
  assert.deepEqual(drafted, [free.id]);
});

test('autopilot reposts a top post when recycling is on (review mode drafts it, copying caption and media)', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const asset = await env.addAsset('f06.jpg');
  const old = new Date(Date.now() - 200 * 864e5).toISOString();
  const original = newPost({
    id: 'p_top',
    status: 'published',
    caption: 'Our most loved vase.\n\n#ceramics',
    firstComment: 'Restocks every Friday.',
    media: [{ assetId: asset.id, kind: 'image', altText: 'A blue vase' }],
    scheduledAt: old,
    publishedAt: old,
    igMediaId: 'ig_top',
  });
  await env.update('posts-archive', (d) => void d.posts.push(original));
  await env.update('analytics-media', (d) => {
    d.media.ig_top = { id: 'ig_top', productType: 'FEED', mediaType: 'IMAGE', timestamp: old, metrics: { reach: 1000, totalInteractions: 300 } };
    d.media.ig_other = { id: 'ig_other', productType: 'FEED', mediaType: 'IMAGE', timestamp: old, metrics: { reach: 1000, totalInteractions: 500 } }; // not from Postpilot
  });
  await env.update('autopilot', (a) => Object.assign(a, { enabled: true, mode: 'review', postsPerWeek: 3, horizonDays: 7, useAi: true, recycleTopPosts: true, recycleAfterDays: 120 }));

  const res = await env.run({ only: ['autopilot'] });
  assert.equal(res.summary.jobs.autopilot.autopilotCreated, 1);
  assert.equal(res.summary.jobs.autopilot.reposts, 1);
  const [repost] = (await env.read('posts')).posts;
  assert.equal(repost.source, 'recycle');
  assert.equal(repost.recycleOf, 'ig_top');
  assert.equal(repost.status, 'draft');
  assert.equal(repost.needsApproval, true);
  assert.equal(repost.caption, original.caption);
  assert.equal(repost.firstComment, 'Restocks every Friday.');
  assert.deepEqual(repost.media, original.media);
  assert.ok(Date.parse(repost.scheduledAt) > Date.now());
  assert.equal(env.anthropic.state.requests.length, 0, 'a repost keeps its caption: no AI call');
  assert.match((await env.read('autopilot')).lastResult.reason, /a repost of a top post/);

  // Not planned twice; once rejected, not suggested again.
  const again = await env.run({ only: ['autopilot'] });
  assert.equal(again.summary.jobs.autopilot.autopilotCreated, 0);
  await env.update('posts', (d) => {
    const p = d.posts[0];
    p.status = 'canceled';
    p.history.push({ at: new Date().toISOString(), event: 'rejected' });
    p.updatedAt = new Date().toISOString();
  });
  const afterReject = await env.run({ only: ['autopilot'] });
  assert.equal(afterReject.summary.jobs.autopilot.autopilotCreated, 0);
  assert.equal((await env.read('posts')).posts.filter((p) => p.status !== 'canceled').length, 0);

  // Auto mode schedules the repost; its media must still be in the library.
  await env.update('posts', (d) => void (d.posts = []));
  await env.update('autopilot', (a) => void (a.mode = 'auto'));
  await env.run({ only: ['autopilot'] });
  const [scheduled] = (await env.read('posts')).posts;
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.needsApproval, false);
  await env.update('posts', (d) => void (d.posts = []));
  await env.update('library', (d) => void (d.assets = []));
  const gone = await env.run({ only: ['autopilot'] });
  assert.equal(gone.summary.jobs.autopilot.autopilotCreated, 0);
  assert.equal((await env.read('autopilot')).lastResult.code, 'no_assets');
});
