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
