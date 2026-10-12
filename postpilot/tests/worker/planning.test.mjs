import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv } from '../helpers/worker-env.mjs';
import { newList, newPost } from '../../core/model.js';

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
