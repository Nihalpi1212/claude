import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from '../helpers/servers.mjs';
import { createMockGraph } from '../../dev/mock-graph.mjs';
import { createIg, IgError, PublishPendingError } from '../../core/ig.js';
import { publishPost, classifyError } from '../../core/publish.js';
import { newAsset, newPost } from '../../core/model.js';

const FIXTURES = new URL('../../dev/fixtures/', import.meta.url);
const fixture = (name) => readFile(new URL(name, FIXTURES)).then((b) => new Uint8Array(b));

// A tiny PNG (not accepted by Instagram's feed API).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function setup(t, opts = {}) {
  const graph = createMockGraph({ imageProcessingMs: 40, videoProcessingMs: 80, ...opts });
  const files = new Map(); // public path -> {bytes, type}
  const srv = await startServer({
    '/mock/ig': (req, res, path, body, url) => graph.handle(req, res, path, body, url),
    '/mock/rupload': (req, res, path, body) => graph.handleRupload(req, res, path, body),
    '/public/': (req, res, path) => {
      const f = files.get(path.split('?')[0]);
      res.writeHead(f ? 200 : 404, { 'Content-Type': f ? f.type : 'text/plain' });
      res.end(f ? Buffer.from(f.bytes) : 'not found');
      return true;
    },
  });
  t.after(() => srv.close());
  const ig = createIg({ token: 'tok', igBase: `${srv.url}/mock/ig`, ruploadBase: `${srv.url}/mock/rupload`, retryDelayMs: 1 });
  await ig.me();

  const assets = new Map();
  const bytesOf = new Map();
  async function addAsset(kind, file, extra = {}) {
    const bytes = file instanceof Uint8Array ? file : await fixture(file);
    const a = newAsset({ kind, mime: kind === 'video' ? 'video/mp4' : 'image/jpeg', bytes: bytes.length, ...extra });
    assets.set(a.id, a);
    bytesOf.set(a.id, bytes);
    return a;
  }
  const exposed = [];
  const exposeMedia = async (asset) => {
    const name = `${asset.id}.${asset.kind === 'video' ? 'mp4' : 'jpg'}`;
    files.set(name, { bytes: bytesOf.get(asset.id), type: asset.mime });
    exposed.push(name);
    return { url: `${srv.url}/public/${name}`, path: `public/tmp/${name}` };
  };
  const readMedia = async (asset) => bytesOf.get(asset.id);
  const saved = [];
  const base = {
    ig,
    assets,
    exposeMedia,
    readMedia,
    onContainers: async (c) => saved.push(c),
    pollIntervalMs: 15,
    maxWaitMs: 5000,
  };
  return { graph, srv, ig, assets, addAsset, base, saved, exposed, files };
}

const lastCreate = (graph) => graph.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/media')).at(-1).params;
const creates = (graph) => graph.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/media')).length;

test('feed image: params, publish, permalink, first comment', async (t) => {
  const { graph, addAsset, base, saved } = await setup(t);
  const img = await addAsset('image', 'f01.jpg', { width: 1080, height: 1350 });
  const post = newPost({
    type: 'feed',
    caption: 'Fresh out of the kiln ✨ #ceramics',
    media: [{ assetId: img.id, kind: 'image', altText: 'Three mugs on a shelf' }],
    collaborators: ['@friend.one', ''],
    userTags: [{ username: '@mara.lens', x: 0.3, y: 1.4, mediaIndex: 0 }],
    location: { id: '110843418940484', name: 'Lisbon' },
    firstComment: '#handmade #pottery',
  });
  const res = await publishPost({ ...base, post });
  assert.ok(res.igMediaId);
  assert.deepEqual(res.warnings, []);
  assert.match(res.permalink, /^https:\/\/www\.instagram\.com\/p\/[\w-]+\/$/);
  assert.ok(res.firstCommentId);
  assert.equal(res.exposed.length, 1);

  const p = lastCreate(graph);
  assert.equal(p.caption, post.caption);
  assert.equal(p.alt_text, 'Three mugs on a shelf');
  assert.equal(p.location_id, '110843418940484');
  assert.deepEqual(JSON.parse(p.collaborators), ['friend.one']);
  assert.deepEqual(JSON.parse(p.user_tags), [{ username: 'mara.lens', x: 0.3, y: 1 }]);
  assert.equal(p.media_type, undefined);
  assert.equal(p.share_to_feed, undefined);

  const m = graph.state.media[0];
  assert.equal(m.id, res.igMediaId);
  assert.equal(m.media_type, 'IMAGE');
  assert.equal(m.caption, post.caption);
  assert.equal(graph.state.publishCount, 1);
  const first = graph.state.comments.get(res.firstCommentId);
  assert.equal(first.text, '#handmade #pottery');
  assert.equal(first.username, 'studio.north');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].parent, res.containers.parent);
  assert.ok(saved[0].createdAt);
});

test('carousel: children with alt text, polled, then a CAROUSEL parent', async (t) => {
  const { graph, addAsset, base, saved } = await setup(t);
  const a = await addAsset('image', 'f02.jpg');
  const b = await addAsset('image', 'f03.jpg');
  const c = await addAsset('video', 'clip.mp4');
  const post = newPost({
    type: 'carousel',
    caption: 'Swipe for the process',
    media: [
      { assetId: a.id, kind: 'image', altText: 'Raw clay' },
      { assetId: b.id, kind: 'image' },
      { assetId: c.id, kind: 'video' },
    ],
    userTags: [{ username: 'theo.builds', x: 0.5, y: 0.5, mediaIndex: 1 }],
    collaborators: ['atelier.kin'],
  });
  const res = await publishPost({ ...base, post, tryResumable: false });
  assert.equal(res.containers.children.length, 3);
  const childReqs = graph.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/media') && r.params.is_carousel_item === 'true');
  assert.equal(childReqs.length, 3);
  assert.equal(childReqs[0].params.alt_text, 'Raw clay');
  assert.equal(childReqs[1].params.alt_text, undefined);
  assert.deepEqual(JSON.parse(childReqs[1].params.user_tags), [{ username: 'theo.builds', x: 0.5, y: 0.5 }]);
  assert.equal(childReqs[2].params.media_type, 'VIDEO');
  assert.ok(childReqs[2].params.video_url);
  assert.equal(childReqs[0].params.collaborators, undefined, 'collaborators only on the parent');
  const parent = lastCreate(graph);
  assert.equal(parent.media_type, 'CAROUSEL');
  assert.equal(parent.children, res.containers.children.join(','));
  assert.deepEqual(JSON.parse(parent.collaborators), ['atelier.kin']);
  const m = graph.state.media[0];
  assert.equal(m.media_type, 'CAROUSEL_ALBUM');
  assert.equal(m.children.length, 3);
  assert.equal(saved.length, 2, 'children saved, then the parent');
  assert.equal(saved[0].parent, null);
  assert.equal(saved[1].parent, res.containers.parent);
});

test('reel via resumable upload with a cover image', async (t) => {
  const { graph, addAsset, base, exposed } = await setup(t);
  const video = await addAsset('video', 'clip.mp4', { durationSec: 5 });
  const cover = await addAsset('image', 'story01.jpg');
  const post = newPost({ type: 'reel', caption: 'Trimming day', media: [{ assetId: video.id, kind: 'video' }], coverAssetId: cover.id, shareToFeed: false, collaborators: ['lumen.ceramics'], userTags: [{ username: 'mara.lens', x: 0.1, y: 0.2 }] });
  const res = await publishPost({ ...base, post });
  const p = lastCreate(graph);
  assert.equal(p.media_type, 'REELS');
  assert.equal(p.upload_type, 'resumable');
  assert.equal(p.share_to_feed, 'false');
  assert.equal(p.video_url, undefined);
  assert.ok(p.cover_url.includes(cover.id));
  assert.deepEqual(JSON.parse(p.user_tags), [{ username: 'mara.lens' }]);
  assert.equal(p.alt_text, undefined);
  assert.equal(graph.state.uploads.get(res.containers.parent), (await fixture('clip.mp4')).length);
  assert.deepEqual(exposed, [`${cover.id}.jpg`], 'only the cover needed a public link');
  const m = graph.state.media[0];
  assert.equal(m.media_type, 'VIDEO');
  assert.equal(m.media_product_type, 'REELS');
  assert.match(res.permalink, /instagram\.com\/reel\//);
});

test('reel falls back to a public video_url when resumable upload is unsupported', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  const video = await addAsset('video', 'clip.mp4');
  graph.state.faults.push({ method: 'POST', path: /\/media$/, when: (p) => p.upload_type === 'resumable', times: 1, error: { status: 400, code: 100, message: '(#100) Param upload_type is not supported for this app' } });
  const post = newPost({ type: 'reel', caption: 'Glaze reveal', media: [{ assetId: video.id, kind: 'video' }], thumbOffsetMs: 1500 });
  const res = await publishPost({ ...base, post });
  const p = lastCreate(graph);
  assert.ok(p.video_url.endsWith(`${video.id}.mp4`));
  assert.equal(p.upload_type, undefined);
  assert.equal(p.thumb_offset, '1500');
  assert.equal(p.share_to_feed, 'true');
  assert.equal(graph.state.uploads.size, 0);
  assert.equal(graph.state.media[0].id, res.igMediaId);
});

test('story image and story video: no caption, no first comment', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  const img = await addAsset('image', 'story01.jpg');
  const post = newPost({ type: 'story', caption: 'ignored', firstComment: 'ignored too', media: [{ assetId: img.id, kind: 'image' }], userTags: [{ username: 'junie.makes' }] });
  const res = await publishPost({ ...base, post });
  const p = lastCreate(graph);
  assert.equal(p.media_type, 'STORIES');
  assert.equal(p.caption, undefined);
  assert.deepEqual(JSON.parse(p.user_tags), [{ username: 'junie.makes' }]);
  assert.equal(res.firstCommentId, null);
  assert.equal(graph.state.stories[0].id, res.igMediaId);
  assert.equal(graph.state.stories[0].media_product_type, 'STORY');

  const vid = await addAsset('video', 'clip.mp4');
  const res2 = await publishPost({ ...base, post: newPost({ type: 'story', media: [{ assetId: vid.id, kind: 'video' }] }) });
  assert.equal(graph.state.stories[0].id, res2.igMediaId);
  assert.equal(graph.state.stories[0].media_type, 'VIDEO');
});

test('a failing first comment becomes a warning, not a failure', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  const img = await addAsset('image', 'f09.jpg');
  graph.state.faults.push({ method: 'POST', path: /\/comments$/, times: 1, error: { status: 400, code: 100, message: '(#100) Comments are turned off for this media.' } });
  const res = await publishPost({ ...base, post: newPost({ caption: 'Square', media: [{ assetId: img.id, kind: 'image' }], firstComment: '#tags' }) });
  assert.ok(res.igMediaId);
  assert.equal(res.firstCommentId, null);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /first comment/);
});

test('resume: a FINISHED container is published without creating a new one', async (t) => {
  const { graph, ig, addAsset, base, files, srv } = await setup(t);
  const img = await addAsset('image', 'f04.jpg');
  files.set('pre.jpg', { bytes: await fixture('f04.jpg'), type: 'image/jpeg' });
  const { id } = await ig.createContainer({ image_url: `${srv.url}/public/pre.jpg`, caption: 'Resumed' });
  for (let i = 0; i < 100 && (await ig.containerStatus(id)).statusCode !== 'FINISHED'; i++) await new Promise((r) => setTimeout(r, 15));
  const before = creates(graph);
  const post = newPost({ caption: 'Resumed', media: [{ assetId: img.id, kind: 'image' }], containers: { parent: id, children: [], createdAt: new Date().toISOString() } });
  const res = await publishPost({ ...base, post });
  assert.equal(creates(graph), before);
  assert.equal(res.containers.parent, id);
  assert.equal(graph.state.media[0].id, res.igMediaId);
  assert.equal(graph.state.media[0].caption, 'Resumed');
});

test('resume: a PUBLISHED container is located instead of published twice', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  const img = await addAsset('image', 'f05.jpg');
  const startedAt = new Date().toISOString();
  const post = newPost({ caption: 'Only once please', media: [{ assetId: img.id, kind: 'image' }], firstComment: 'first!' });
  const first = await publishPost({ ...base, post });
  const again = await publishPost({ ...base, post: { ...post, containers: first.containers, publishStartedAt: startedAt } });
  assert.equal(again.igMediaId, first.igMediaId);
  assert.equal(again.permalink, first.permalink);
  assert.equal(graph.state.publishCount, 1);
  const firsts = [...graph.state.comments.values()].filter((c) => c.mediaId === first.igMediaId && c.text === 'first!');
  assert.equal(firsts.length, 1, 'first comment not duplicated');
  assert.equal(again.firstCommentId, first.firstCommentId);
});

test('expired containers are recreated once (on resume and while waiting)', async (t) => {
  const { graph, ig, addAsset, base, files, srv } = await setup(t);
  const img = await addAsset('image', 'f06.jpg');
  files.set('old.jpg', { bytes: await fixture('f06.jpg'), type: 'image/jpeg' });
  const { id } = await ig.createContainer({ image_url: `${srv.url}/public/old.jpg` });
  graph.state.containers.get(id).forceStatus = 'EXPIRED';
  const res = await publishPost({ ...base, post: newPost({ caption: 'Retry', media: [{ assetId: img.id, kind: 'image' }], containers: { parent: id, children: [] } }) });
  assert.notEqual(res.containers.parent, id);
  assert.equal(graph.state.media[0].id, res.igMediaId);

  let expiredOnce = false;
  const res2 = await publishPost({
    ...base,
    onContainers: async (c) => {
      if (!expiredOnce) {
        expiredOnce = true;
        graph.state.containers.get(c.parent).forceStatus = 'EXPIRED';
      }
    },
    post: newPost({ caption: 'Expires mid-wait', media: [{ assetId: img.id, kind: 'image' }] }),
  });
  assert.ok(expiredOnce);
  assert.equal(graph.state.media[0].id, res2.igMediaId);
  assert.equal(graph.state.media[0].caption, 'Expires mid-wait');
});

test('slow video: PublishPendingError carries containers and the next run finishes', async (t) => {
  const { graph, addAsset, base } = await setup(t, { videoProcessingMs: 60_000 });
  const video = await addAsset('video', 'clip.mp4');
  const post = newPost({ type: 'reel', caption: 'Slow one', media: [{ assetId: video.id, kind: 'video' }] });
  let pending;
  await assert.rejects(publishPost({ ...base, post, maxWaitMs: 60 }), (err) => {
    assert.ok(err instanceof PublishPendingError);
    assert.ok(err.containers.parent);
    pending = err;
    return true;
  });
  assert.equal(classifyError(pending).permanent, false);
  assert.equal(classifyError(pending).pending, true);
  graph.state.containers.get(pending.containers.parent).readyAt = Date.now() - 1;
  const before = creates(graph);
  const res = await publishPost({ ...base, post: { ...post, containers: pending.containers } });
  assert.equal(creates(graph), before);
  assert.equal(graph.state.media[0].id, res.igMediaId);
});

test('daily publishing limit stops before creating containers (retry next run)', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  graph.state.publishLimit = 0;
  const img = await addAsset('image', 'f07.jpg');
  const before = creates(graph);
  await assert.rejects(publishPost({ ...base, post: newPost({ caption: 'x', media: [{ assetId: img.id, kind: 'image' }] }) }), (err) => {
    assert.ok(err instanceof IgError);
    assert.ok(err.isRateLimit);
    assert.equal(err.isPermanent, false);
    assert.match(err.userMessage, /^Instagram daily publishing limit reached/);
    assert.equal(classifyError(err).permanent, false);
    return true;
  });
  assert.equal(creates(graph), before);
});

test('container ERROR (unsupported image) is a permanent failure with a plain message', async (t) => {
  const { addAsset, base } = await setup(t);
  const bad = await addAsset('image', PNG);
  await assert.rejects(publishPost({ ...base, post: newPost({ caption: 'png', media: [{ assetId: bad.id, kind: 'image' }] }) }), (err) => {
    assert.ok(err instanceof IgError);
    assert.equal(err.isPermanent, true);
    assert.match(err.userMessage, /JPEG/);
    const c = classifyError(err);
    assert.equal(c.permanent, true);
    assert.equal(c.subcode, 2207005);
    return true;
  });
});

test('feed photos outside 4:5..1.91:1 are rejected by Instagram', async (t) => {
  const { addAsset, base } = await setup(t);
  const tall = await addAsset('image', 'story01.jpg');
  await assert.rejects(publishPost({ ...base, post: newPost({ caption: 'tall', media: [{ assetId: tall.id, kind: 'image' }] }) }), (err) => err.subcode === 2207009 && err.isPermanent);
});

test('missing assets and generic errors are classified', async (t) => {
  const { base } = await setup(t);
  await assert.rejects(publishPost({ ...base, post: newPost({ media: [{ assetId: 'a_gone', kind: 'image' }] }) }), (err) => err.code === 'missing_media' && err.isPermanent);
  assert.equal(classifyError(new TypeError('x is undefined')).permanent, true);
  assert.equal(classifyError(new Error('GitHub is down')).permanent, false);
  assert.equal(classifyError(new IgError('expired', { code: 190, subcode: 463 })).auth, true);
});

test('trial reels and the AI label are sent only where Instagram accepts them', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  const video = await addAsset('video', 'clip.mp4', { durationSec: 5 });
  await publishPost({ ...base, post: newPost({ type: 'reel', caption: 'Trial', media: [{ assetId: video.id, kind: 'video' }], trialReel: 'SS_PERFORMANCE', aiGenerated: true }) });
  let p = lastCreate(graph);
  assert.deepEqual(JSON.parse(p.trial_params), { graduation_strategy: 'SS_PERFORMANCE' });
  assert.equal(p.is_ai_generated, 'true');

  const a = await addAsset('image', 'f01.jpg');
  const b = await addAsset('image', 'f02.jpg');
  await publishPost({ ...base, post: newPost({ type: 'carousel', caption: 'Two', media: [{ assetId: a.id }, { assetId: b.id }], aiGenerated: true }) });
  const creates = graph.state.requests.filter((r) => r.method === 'POST' && /\/media$/.test(r.path)).map((r) => r.params);
  const children = creates.filter((c) => c.is_carousel_item === 'true');
  assert.ok(children.length >= 2 && children.every((c) => c.is_ai_generated === undefined), 'never on carousel items');
  p = lastCreate(graph);
  assert.equal(p.media_type, 'CAROUSEL');
  assert.equal(p.is_ai_generated, 'true');
  assert.equal(p.trial_params, undefined);
});

// A client whose methods can be swapped per test (getters such as userId keep working).
const withIg = (ig, overrides) => Object.assign(Object.create(ig), overrides);
const commentsOn = (graph, mediaId, text) => [...graph.state.comments.values()].filter((c) => c.mediaId === mediaId && c.text === text);

test('a lost media_publish response is recognised as published, not failed', async (t) => {
  const { graph, ig, addAsset, base } = await setup(t);
  const img = await addAsset('image', 'f04.jpg');

  // The first response is lost and the retry hits the already-published container (100/2207006).
  const retried = withIg(ig, {
    publishContainer: async (id) => {
      await ig.publishContainer(id);
      return ig.publishContainer(id);
    },
  });
  const before = creates(graph);
  const post = newPost({ caption: 'Lost response', media: [{ assetId: img.id, kind: 'image' }], firstComment: 'first!' });
  const res = await publishPost({ ...base, ig: retried, post });
  assert.equal(graph.state.publishCount, 1);
  assert.equal(creates(graph), before + 1, 'no new containers');
  assert.equal(res.igMediaId, graph.state.media[0].id);
  assert.ok(res.permalink);
  assert.equal(commentsOn(graph, res.igMediaId, 'first!').length, 1);

  // A dropped connection after the request may have reached Instagram is checked the same way.
  const dropped = withIg(ig, {
    publishContainer: async (id) => {
      await ig.publishContainer(id);
      throw new IgError('Could not reach Instagram (socket hang up).', { code: 'network', status: 0, maybeSent: true });
    },
  });
  const res2 = await publishPost({ ...base, ig: dropped, post: newPost({ caption: 'Dropped', media: [{ assetId: img.id, kind: 'image' }] }) });
  assert.equal(graph.state.publishCount, 2);
  assert.equal(res2.igMediaId, graph.state.media[0].id);
});

test('resume: a PUBLISHED story is not failed when the stories lookup is unavailable', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  const img = await addAsset('image', 'story01.jpg');
  const post = newPost({ type: 'story', media: [{ assetId: img.id, kind: 'image' }] });
  const first = await publishPost({ ...base, post });
  graph.state.faults.push({ method: 'GET', path: /\/stories$/, error: { status: 400, code: 100, message: '(#100) Tried accessing nonexisting field (stories) on node type (User)' } });
  const again = await publishPost({ ...base, post: { ...post, containers: first.containers } });
  assert.equal(again.igMediaId, null);
  assert.equal(again.warnings.length, 1);
  assert.match(again.warnings[0], /published/);
  assert.equal(graph.state.publishCount, 1);

  // A login problem is still reported, so the worker keeps the containers and resumes later.
  graph.state.faults.length = 0;
  graph.state.faults.push({ method: 'GET', path: /\/stories$/, error: { status: 400, code: 190, subcode: 463, message: 'Error validating access token' } });
  await assert.rejects(publishPost({ ...base, post: { ...post, containers: first.containers } }), (err) => err.isAuth);
  assert.equal(graph.state.publishCount, 1);
});

test('resume: an edited post is uploaded again instead of publishing the old container', async (t) => {
  const { graph, addAsset, base, saved } = await setup(t);
  const oldImg = await addAsset('image', 'f06.jpg');
  const newImg = await addAsset('image', 'f07.jpg');
  // Daily quota hit at media_publish: the post goes back to 'scheduled' with a FINISHED container.
  const quota = () => graph.state.faults.push({ method: 'POST', path: /\/media_publish$/, times: 1, error: { status: 400, code: 9, subcode: 2207042, message: 'Application request limit reached' } });

  const kept = newPost({ caption: 'Unchanged', media: [{ assetId: oldImg.id, kind: 'image' }] });
  quota();
  await assert.rejects(publishPost({ ...base, post: kept }), (err) => err.isRateLimit);
  const keptContainers = saved.at(-1);
  let before = creates(graph);
  const res1 = await publishPost({ ...base, post: { ...kept, scheduledAt: new Date().toISOString(), containers: keptContainers } });
  assert.equal(creates(graph), before, 'an unchanged post reuses its container');
  assert.equal(res1.containers.parent, keptContainers.parent);

  const post = newPost({ caption: 'Fresh out of the klin', media: [{ assetId: oldImg.id, kind: 'image' }] });
  quota();
  await assert.rejects(publishPost({ ...base, post }), (err) => err.isRateLimit);
  const oldContainers = saved.at(-1);
  before = creates(graph);
  const edited = { ...post, caption: 'Fresh out of the kiln', media: [{ assetId: newImg.id, kind: 'image' }], containers: oldContainers };
  const res = await publishPost({ ...base, post: edited });
  assert.equal(creates(graph), before + 1, 'a new container is created');
  assert.notEqual(res.containers.parent, oldContainers.parent);
  const m = graph.state.media[0];
  assert.equal(m.id, res.igMediaId);
  assert.equal(m.caption, 'Fresh out of the kiln');
  assert.ok(lastCreate(graph).image_url.includes(newImg.id));
  assert.equal(graph.state.publishCount, 2);
});

test('a failed media download (2207052) and retryable publishing subcodes are retried, not failed for good', async (t) => {
  const { addAsset, base, srv } = await setup(t);
  const img = await addAsset('image', 'f08.jpg');
  const exposeMedia = async () => ({ url: `${srv.url}/public/missing.jpg`, path: 'public/tmp/missing.jpg' });
  await assert.rejects(publishPost({ ...base, exposeMedia, post: newPost({ caption: 'Download fails', media: [{ assetId: img.id, kind: 'image' }] }) }), (err) => {
    assert.ok(err instanceof IgError);
    assert.equal(err.subcode, 2207052);
    assert.equal(err.isPermanent, false);
    assert.match(err.userMessage, /will try again/);
    assert.equal(classifyError(err).permanent, false);
    return true;
  });
  for (const [code, subcode] of [[-1, 2207001], [-2, 2207003], [24, 2207006], [24, 2207008], [-2, 2207020], [-1, 2207032], [9004, 2207052]]) {
    assert.equal(classifyError(new IgError('Publishing failed', { code, subcode, status: 400 })).permanent, false, String(subcode));
  }
  assert.equal(classifyError(new IgError('Bad format', { code: 36001, subcode: 2207005, status: 400 })).permanent, true);
  assert.equal(classifyError(new IgError('Caption too long', { code: 100, subcode: 2207010, status: 400 })).permanent, true);
});

test('resume: a captionless post is never matched to some other recent post', async (t) => {
  const { graph, addAsset, base } = await setup(t);
  const img = await addAsset('image', 'f05.jpg');
  const other = await addAsset('image', 'f09.jpg');
  const startedAt = new Date().toISOString();
  const post = newPost({ caption: '', media: [{ assetId: img.id, kind: 'image' }], firstComment: 'first!' });
  const first = await publishPost({ ...base, post });
  // Another post goes live in the same window before the resume.
  const busy = await publishPost({ ...base, post: newPost({ caption: 'Posted from the phone', media: [{ assetId: other.id, kind: 'image' }] }) });
  const again = await publishPost({ ...base, post: { ...post, containers: first.containers, publishStartedAt: startedAt } });
  assert.equal(again.igMediaId, first.igMediaId);
  assert.notEqual(again.igMediaId, busy.igMediaId);
  assert.equal(commentsOn(graph, busy.igMediaId, 'first!').length, 0);
  assert.equal(commentsOn(graph, first.igMediaId, 'first!').length, 1);

  // Two captionless candidates: no guess and no first comment.
  const twin = await publishPost({ ...base, post: newPost({ caption: '', media: [{ assetId: other.id, kind: 'image' }] }) });
  const third = await publishPost({ ...base, post: { ...post, containers: first.containers, publishStartedAt: startedAt } });
  assert.equal(third.igMediaId, null);
  assert.equal(third.warnings.length, 1);
  assert.equal(commentsOn(graph, twin.igMediaId, 'first!').length, 0);
  assert.equal(graph.state.publishCount, 3);
});
