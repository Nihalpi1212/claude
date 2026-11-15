// Link-in-bio job: daily image refresh, and posts deleted from Instagram leave the public grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv } from '../helpers/worker-env.mjs';
import { newPost } from '../../core/model.js';

const tile = (id, igMediaId, extra = {}) => ({ id, igMediaId, imageUrl: `https://old.example/${id}.jpg`, url: '', permalink: '', alt: '', ...extra });

test('bio: deleted posts leave the grid and public/bio.json; the rest get fresh images', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  const [kept, flagged, vanished, archived, viaApp] = [st.media[0], st.media[1], st.media[2], st.media[3], st.media[4]];
  await env.update('bio', (d) => {
    d.published = true;
    d.grid = [
      tile('g1', kept.id),
      tile('g2', flagged.id),
      tile('g3', vanished.id),
      tile('g4', archived.id),
      tile('g5', viaApp.id),
      { id: 'g6', imageUrl: 'https://shop.example/a.jpg', url: 'https://shop.example/' }, // not an Instagram post
    ];
  });
  // Flagged by the analytics job; deleted in Instagram (not in the listing, not found); archived
  // (not in the listing, still found).
  await env.update('analytics-media', (d) => void (d.media[flagged.id] = { id: flagged.id, timestamp: flagged.timestamp, deletedAt: new Date().toISOString(), metrics: {} }));
  st.media = st.media.filter((m) => m.id !== vanished.id && m.id !== archived.id);
  st.nodes.delete(vanished.id);

  const res = await env.run({ only: ['bio'] });
  assert.deepEqual(res.summary.jobs.bio, { bioImages: 6, bioRemoved: 2 }, 'an image and a permalink for each of the 3 tiles left');
  let doc = await env.read('bio');
  assert.deepEqual(doc.grid.map((g) => g.id), ['g1', 'g4', 'g5', 'g6']);
  for (const g of doc.grid.filter((x) => x.igMediaId)) {
    assert.doesNotMatch(g.imageUrl, /old\.example/, `${g.id}: image refreshed`);
    assert.match(g.permalink, /instagram\.com/);
  }
  assert.equal(doc.grid[3].imageUrl, 'https://shop.example/a.jpg');
  // public/bio.json itself (plaintext, what the bio page reads).
  const ref = env.ghMock.refs.get('postpilot-data');
  const blob = env.ghMock.blobs.get(env.ghMock.trees.get(env.ghMock.commits.get(ref).tree).get('public/bio.json'));
  const pub = JSON.parse(Buffer.from(blob).toString('utf8'));
  assert.ok(!JSON.stringify(pub).includes(flagged.id) && !JSON.stringify(pub).includes(vanished.id));
  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'bio' && /Removed 2 posts deleted from Instagram/.test(e.message)));

  // Later the same day: "Delete from Instagram" in the app takes its tile out on the next run,
  // without any Instagram call.
  await env.update('posts', (d) => void d.posts.push(newPost({ status: 'canceled', igMediaId: viaApp.id, deletedFromInstagramAt: new Date().toISOString() })));
  const mark = st.requests.length;
  const again = await env.run({ only: ['bio'] });
  assert.deepEqual(again.summary.jobs.bio, { bioImages: 0, bioRemoved: 1 });
  assert.equal(st.requests.length, mark, 'no Instagram calls');
  doc = await env.read('bio');
  assert.deepEqual(doc.grid.map((g) => g.id), ['g1', 'g4', 'g6']);

  // Nothing new: no write, no calls.
  const head = env.ghMock.refs.get('postpilot-data');
  const idle = await env.run({ only: ['bio'] });
  assert.equal(idle.summary.jobs.bio.skipped, 'not_due');
  assert.equal(st.requests.length, mark);
  assert.equal(env.ghMock.refs.get('postpilot-data'), head, 'no commit');
});
