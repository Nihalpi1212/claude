// Feeds job: RSS/Atom feeds into queues and linked media downloads, against an injected fetch that
// plays the other sites (https://feeds.test/...). GitHub, Instagram and Claude are the usual mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureBytes, startWorkerEnv, visibleLines } from '../helpers/worker-env.mjs';
import { runWorker } from '../../worker/run.mjs';
import { checkFeed, feedBacklogCap, feedOnlyAssets, fetchCapped, FetchError, MAX_DOWNLOAD_TRIES, SEEN_CAP } from '../../worker/jobs/feeds.mjs';
import { brokenAssetIds, planList } from '../../worker/jobs/evergreen.mjs';
import { newAsset, newList, newPost } from '../../core/model.js';

const SITE = 'https://feeds.test';
const HOUR = 36e5;

/** A fake web: routes[url] = () => Response | Promise<Response>; everything else goes to the real mocks. */
function fakeWeb() {
  const routes = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(SITE)) return globalThis.fetch(url, init);
    calls.push({ url: u, headers: init.headers || {} });
    const route = routes.get(u.split('#')[0]);
    if (!route) return new Response('Not found', { status: 404 });
    return route(init);
  };
  return { routes, calls, fetchImpl, hits: (path) => calls.filter((c) => c.url === `${SITE}${path}`).length };
}

const ok = (body, type, headers = {}) => () => new Response(body, { status: 200, headers: { 'Content-Type': type, ...headers } });

function rss(items, title = 'Studio Journal') {
  const body = items
    .map(
      (it) => `<item><title>${it.title}</title><link>${it.link || `${SITE}/post/${it.id}`}</link><guid>${it.id}</guid>` +
        `<pubDate>${new Date(it.at).toUTCString()}</pubDate><description><![CDATA[<p>${it.summary || 'Summary'}</p>]]></description>` +
        `${it.media ? `<media:content url="${it.media}" medium="image"/>` : ''}${it.enclosure ? `<enclosure url="${it.enclosure}" type="${it.type || 'image/jpeg'}" length="1"/>` : ''}</item>`,
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${title}</title><link>${SITE}/</link>${body}</channel></rss>`;
}

/** JPEG fixture with an EXIF segment (orientation + GPS text) inserted after SOI. */
async function jpegWithExif(name = 'f05.jpg', orientation = 1) {
  const src = await fixtureBytes(name);
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const tiff = [...ascii('MM'), 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const body = [...ascii('Exif'), 0, 0, ...tiff, ...ascii('GPS 40.7128 N 74.0060 W')];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([...src.subarray(0, 2), ...app1, ...src.subarray(2)]);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** A fixture JPEG with its SOF size rewritten to w x h (enough for the size checks). */
async function jpegSized(w, h, name = 'f05.jpg') {
  const b = new Uint8Array(await fixtureBytes(name));
  for (let i = 2; i < b.length - 9; ) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) {
      b.set([h >> 8, h & 255, w >> 8, w & 255], i + 5);
      break;
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return b;
}

async function run(env, web, opts = {}) {
  const lines = [];
  const res = await runWorker({ env: env.env, only: opts.only || ['feeds'], now: opts.now, fetchImpl: web.fetchImpl, log: (l) => lines.push(String(l)) });
  return { ...res, lines };
}

async function addQueueWithFeed(env, feed = {}, list = {}) {
  const l = newList({ id: 'l_blog', name: 'From the blog', items: [], slots: [{ weekday: 3, time: '12:00' }], feeds: [{ id: 'fd_1', url: `${SITE}/feed.xml`, title: '', disabled: false, addedAt: new Date().toISOString(), checkedAt: null, error: null, seen: [], added: 0, ...feed }], ...list });
  await env.update('lists', (d) => void d.lists.push(l));
  return l;
}

test('first check adds the newest 3 items with a usable image; JPEGs are downloaded without metadata, PNG is refused', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const now = Date.now();
  web.routes.set(`${SITE}/feed.xml`, ok(rss([
    { id: 'g5', title: 'Newest with media', at: now - 1 * HOUR, media: `${SITE}/img/one.jpg`, summary: 'Two new glazes.' },
    { id: 'g4', title: 'Only an og image', at: now - 2 * HOUR, link: `${SITE}/post/og` },
    // Declared as a PNG: the worker could only refuse it, so the item is skipped and the next one taken.
    { id: 'g3', title: 'A PNG enclosure', at: now - 3 * HOUR, enclosure: `${SITE}/img/swatch.png`, type: 'image/png' },
    // Nothing tells that this one is a PNG until it is downloaded.
    { id: 'g2', title: 'Older one', at: now - 4 * HOUR, media: `${SITE}/img/two` },
    { id: 'g1', title: 'Oldest', at: now - 5 * HOUR },
  ]), 'application/rss+xml; charset=utf-8'));
  web.routes.set(`${SITE}/post/og`, ok(`<html><head><meta property="og:image" content="/img/og.jpg"></head></html>`, 'text/html'));
  web.routes.set(`${SITE}/img/one.jpg`, ok(await jpegWithExif('f05.jpg'), 'image/jpeg'));
  web.routes.set(`${SITE}/img/og.jpg`, ok(await fixtureBytes('f09.jpg'), 'image/jpeg'));
  web.routes.set(`${SITE}/img/two`, ok(PNG, 'image/png'));
  await addQueueWithFeed(env);

  const res = await run(env, web);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.summary.jobs.feeds, { feedsChecked: 1, feedItems: 3, downloaded: 2, downloadFailed: 1 });

  const list = (await env.read('lists')).lists[0];
  const feed = list.feeds[0];
  assert.equal(feed.title, 'Studio Journal');
  assert.equal(feed.error, null);
  assert.ok(feed.checkedAt);
  assert.equal(feed.added, 3);
  assert.deepEqual([...feed.seen].sort(), ['g1', 'g2', 'g3', 'g4', 'g5'], 'everything shown on the first check counts as seen');
  // Added oldest first, so the queue keeps the feed's order.
  assert.deepEqual(list.items.map((it) => it.caption.split('\n')[0]), ['Older one', 'Only an og image', 'Newest with media']);
  assert.equal(web.hits('/img/swatch.png'), 0, 'a declared PNG is not downloaded');
  const newest = list.items[2];
  assert.equal(newest.caption, 'Newest with media\n\nTwo new glazes.');
  assert.equal(newest.source, 'rss');
  assert.equal(newest.link, `${SITE}/post/g5`);
  assert.equal(newest.feedId, 'fd_1');
  assert.equal(newest.type, 'feed');
  assert.equal(newest.timesUsed, 0);

  const lib = (await env.read('library')).assets;
  const byItem = (it) => lib.find((a) => a.id === it.media[0].assetId);
  const one = byItem(newest);
  assert.equal(one.importUrl, undefined);
  assert.equal(one.sourceUrl, `${SITE}/img/one.jpg`);
  assert.equal(one.thumbPath, one.path);
  assert.equal(one.kind, 'image');
  assert.equal(one.mime, 'image/jpeg');
  assert.equal(one.width, 1080);
  assert.equal(one.height, 1350);
  assert.equal(one.name, 'Newest with media');
  assert.ok(one.tags.includes('feed'));
  const stored = await env.store.readBytes(one.path);
  assert.equal(stored[0], 0xff);
  assert.equal(stored.length, one.bytes);
  assert.ok(!Buffer.from(stored).toString('latin1').includes('GPS 40.7128'), 'EXIF/GPS removed before storing');
  assert.equal(byItem(list.items[1]).sourceUrl, `${SITE}/img/og.jpg`, 'og:image of the item page');
  const png = byItem(list.items[0]);
  assert.equal(png.importUrl, `${SITE}/img/two`);
  assert.match(png.importError, /PNG image\. Instagram only takes JPEG photos.*upload it in the Library/);
  assert.equal(png.importErrorCode, 'not_jpeg');

  // Public console: counts only.
  const out = visibleLines(res.lines).join('\n');
  assert.match(out, /feeds: 1 feeds checked, 3 feed items, 2 downloaded, 1 download failed/);
  assert.doesNotMatch(out, /feeds\.test|Journal|Newest|glaze|swatch/i);
  const log = (await env.read('log')).entries;
  assert.ok(log.some((e) => e.job === 'feeds' && /Added 3 items from the feed "Studio Journal"/.test(e.message)));
  assert.ok(log.some((e) => e.job === 'feeds' && /Skipped 1 new item of the feed "Studio Journal" whose image is not a JPEG/.test(e.message)));
  assert.ok(log.some((e) => e.job === 'feeds' && e.level === 'warn' && /PNG/.test(e.message)));
});

test('later checks: at most hourly, up to 5 new items, conditional GET; disabled feeds and paused queues wait', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  const items = [{ id: 'a1', title: 'First', at: t0 - HOUR, media: `${SITE}/img/a.jpg` }];
  let etag = '"v1"';
  web.routes.set(`${SITE}/feed.xml`, (init) =>
    init.headers['If-None-Match'] === etag ? new Response(null, { status: 304 }) : new Response(rss(items), { status: 200, headers: { 'Content-Type': 'application/rss+xml', ETag: etag } }),
  );
  web.routes.set(`${SITE}/img/a.jpg`, ok(await fixtureBytes('f01.jpg'), 'image/jpeg'));
  await addQueueWithFeed(env);
  const iso = (ms) => new Date(ms).toISOString();

  await run(env, web, { now: iso(t0) });
  assert.equal((await env.read('lists')).lists[0].items.length, 1);

  // Within the hour: not fetched again.
  const soon = await run(env, web, { now: iso(t0 + 30 * 60e3) });
  assert.equal(soon.summary.jobs.feeds.skipped, 'nothing_due');
  assert.equal(web.hits('/feed.xml'), 1);

  // Unchanged feed: 304 with the stored ETag, nothing added, no error.
  await run(env, web, { now: iso(t0 + 2 * HOUR) });
  assert.equal(web.hits('/feed.xml'), 2);
  assert.equal(web.calls.filter((c) => c.url.endsWith('/feed.xml'))[1].headers['If-None-Match'], '"v1"');
  let feed = (await env.read('lists')).lists[0].feeds[0];
  assert.equal(feed.error, null);
  assert.equal(feed.added, 1);

  // Seven new posts at once: the newest 5 are added, the 2 older new ones are skipped for good.
  etag = '"v2"';
  for (let i = 2; i <= 8; i++) items.unshift({ id: `a${i}`, title: `Post ${i}`, at: t0 + i * 60e3, media: `${SITE}/img/a.jpg` });
  const many = await run(env, web, { now: iso(t0 + 4 * HOUR) });
  assert.equal(many.summary.jobs.feeds.feedItems, 5);
  let list = (await env.read('lists')).lists[0];
  assert.deepEqual(list.items.map((it) => it.caption.split('\n')[0]), ['First', 'Post 4', 'Post 5', 'Post 6', 'Post 7', 'Post 8']);
  assert.equal(list.feeds[0].added, 6);
  assert.ok(['a2', 'a3'].every((g) => list.feeds[0].seen.includes(g)));
  const again = await run(env, web, { now: iso(t0 + 6 * HOUR) });
  assert.equal(again.summary.jobs.feeds.feedItems, 0, 'skipped older items are not added later');

  // Disabled feed, then a paused queue: no requests.
  const hits = web.hits('/feed.xml');
  await env.update('lists', (d) => void (d.lists[0].feeds[0].disabled = true));
  await run(env, web, { now: iso(t0 + 9 * HOUR) });
  await env.update('lists', (d) => {
    d.lists[0].feeds[0].disabled = false;
    d.lists[0].enabled = false;
  });
  await run(env, web, { now: iso(t0 + 12 * HOUR) });
  assert.equal(web.hits('/feed.xml'), hits);
  feed = (await env.read('lists')).lists[0].feeds[0];
  assert.ok(Date.parse(feed.checkedAt) < t0 + 9 * HOUR);
});

test('feed errors are recorded on the feed (logged once) and checked again an hour later', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  await addQueueWithFeed(env, { url: `${SITE}/missing.xml` });
  await run(env, web, { now: new Date(t0).toISOString() });
  let feed = (await env.read('lists')).lists[0].feeds[0];
  assert.equal(feed.error, 'The link answered 404 Not Found.');
  assert.ok(feed.checkedAt);
  await run(env, web, { now: new Date(t0 + 2 * HOUR).toISOString() });
  const warns = (await env.read('log')).entries.filter((e) => e.job === 'feeds' && e.level === 'warn');
  assert.equal(warns.length, 1, 'same error is not logged again');

  // A web page instead of a feed.
  web.routes.set(`${SITE}/missing.xml`, ok('<!doctype html><html><head></head><body>Blog</body></html>', 'text/html'));
  await run(env, web, { now: new Date(t0 + 4 * HOUR).toISOString() });
  feed = (await env.read('lists')).lists[0].feeds[0];
  assert.match(feed.error, /web page, not a feed/);
  web.routes.set(`${SITE}/missing.xml`, ok(rss([]), 'application/rss+xml'));
  await run(env, web, { now: new Date(t0 + 6 * HOUR).toISOString() });
  assert.equal((await env.read('lists')).lists[0].feeds[0].error, null);
});

test('downloads: server errors retried with backoff then given up; pages followed to og:image; videos stripped; rotated photos refused', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  const clip = await fixtureBytes('clip.mp4');
  // Put GPS text into a 'udta' box at the end of the file (phones store location there).
  const udta = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('udta'), Buffer.from('+40.7128-074.0060/'.padEnd(24, ' '))]);
  const video = new Uint8Array(Buffer.concat([Buffer.from(clip), udta]));
  web.routes.set(`${SITE}/busy.jpg`, () => new Response('busy', { status: 503 }));
  web.routes.set(`${SITE}/page`, ok('<html><head><meta property="og:image" content="https://feeds.test/real.jpg"></head></html>', 'text/html; charset=utf-8'));
  web.routes.set(`${SITE}/real.jpg`, ok(await fixtureBytes('f02.jpg'), 'image/jpeg'));
  web.routes.set(`${SITE}/clip.mp4`, ok(video, 'video/mp4'));
  web.routes.set(`${SITE}/turned.jpg`, ok(await jpegWithExif('f03.jpg', 6), 'image/jpeg'));
  web.routes.set(`${SITE}/huge.mp4`, () => new Response('x', { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(200 * 1024 * 1024) } }));
  const add = (id, url, extra = {}) => newAsset({ id, name: id, importUrl: url, createdAt: new Date(t0 - 1000).toISOString(), ...extra });
  await env.update('library', (d) => {
    d.assets.push(add('busy', `${SITE}/busy.jpg`), add('page', `${SITE}/page`), add('video', `${SITE}/clip.mp4`, { kind: 'video' }), add('turned', `${SITE}/turned.jpg`), add('huge', `${SITE}/huge.mp4`));
  });
  const at = (ms) => new Date(ms).toISOString();
  const asset = async (id) => (await env.read('library')).assets.find((a) => a.id === id);

  const first = await run(env, web, { now: at(t0) });
  assert.deepEqual(first.summary.jobs.feeds, { downloaded: 2, downloadRetries: 1, downloadFailed: 2 });
  const page = await asset('page');
  assert.equal(page.sourceUrl, `${SITE}/page`);
  assert.equal(page.width, 1080);
  const v = await asset('video');
  assert.equal(v.kind, 'video');
  assert.equal(v.mime, 'video/mp4');
  assert.equal(v.width, 720);
  assert.equal(v.height, 1280);
  assert.equal(v.durationSec, 5);
  assert.equal(v.thumbPath, v.path);
  const vb = Buffer.from(await env.store.readBytes(v.path)).toString('latin1');
  assert.ok(!vb.includes('+40.7128') && !vb.includes('udta'), 'location box zeroed and renamed');
  assert.match((await asset('turned')).importError, /sideways/);
  assert.match((await asset('huge')).importError, /200 MB/);

  let busy = await asset('busy');
  assert.equal(busy.importAttempts, 1);
  assert.equal(busy.importError, undefined);
  assert.equal(busy.importLastError, 'The site had a server error (503).', 'the reason is kept for the app while it waits');
  assert.equal((await asset('turned')).importErrorCode, 'rotated');
  assert.equal((await asset('huge')).importErrorCode, 'too_big');
  // Backoff: not tried again 5 minutes later; tried after 10, 20, 40 and 80 minutes.
  const soon = await run(env, web, { now: at(t0 + 5 * 60e3) });
  assert.equal(soon.summary.jobs.feeds.skipped, 'nothing_due');
  let clock = t0;
  for (let i = 1; i < MAX_DOWNLOAD_TRIES; i++) {
    clock += 10 * 60e3 * 2 ** (i - 1) + 1000;
    await run(env, web, { now: at(clock) });
  }
  busy = await asset('busy');
  assert.equal(busy.importAttempts, undefined);
  assert.equal(busy.importLastError, undefined);
  assert.equal(busy.importErrorCode, 'tries');
  assert.match(busy.importError, /server error \(503\)\. Tried 5 times\./);
  assert.equal(web.hits('/busy.jpg'), MAX_DOWNLOAD_TRIES);
  // "Try again" in the Library clears importError: the next run downloads it from scratch.
  web.routes.set(`${SITE}/busy.jpg`, ok(await fixtureBytes('f04.jpg'), 'image/jpeg'));
  await env.update('library', (d) => void delete d.assets.find((a) => a.id === 'busy').importError);
  await run(env, web, { now: at(clock + 60e3) });
  busy = await asset('busy');
  assert.equal(busy.importUrl, undefined);
  assert.equal(busy.sourceUrl, `${SITE}/busy.jpg`);
});

test('fetchCapped: timeouts are temporary, size caps and bad links are not', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(fetchCapped(hang, 'https://slow.example/a.jpg', { maxBytes: 10, timeoutMs: 30 }), (err) => err instanceof FetchError && err.transient && err.code === 'timeout');
  const stream = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8)); c.enqueue(new Uint8Array(8)); c.close(); } }), { status: 200 });
  await assert.rejects(fetchCapped(stream, 'https://big.example/a.jpg', { maxBytes: 10, timeoutMs: 1000 }), (err) => err.code === 'too_big' && !err.transient);
  const small = await fetchCapped(stream, 'https://big.example/a.jpg', { maxBytes: 100, timeoutMs: 1000 });
  assert.equal(small.bytes.length, 16);
  await assert.rejects(fetchCapped(stream, 'file:///etc/passwd', { maxBytes: 10, timeoutMs: 100 }), (err) => err.code === 'bad_url');
  const down = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  await assert.rejects(fetchCapped(down, 'https://nowhere.example/', { maxBytes: 10, timeoutMs: 100 }), (err) => err.transient && /could not be found/.test(err.message));
  const gone = () => new Response('', { status: 404 });
  await assert.rejects(fetchCapped(gone, 'https://x.example/', { maxBytes: 10, timeoutMs: 100 }), (err) => !err.transient && err.status === 404);
});

test('evergreen: items whose download failed are skipped, items still downloading are scheduled', () => {
  const list = newList({
    id: 'l1',
    slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: '12:00' })),
    horizonDays: 3,
    items: [
      { id: 'bad', type: 'feed', caption: 'Bad', media: [{ assetId: 'a_bad', kind: 'image' }] },
      { id: 'wait', type: 'feed', caption: 'Wait', media: [{ assetId: 'a_wait', kind: 'image' }] },
    ],
  });
  const plan = planList(list, { posts: [], assetIds: new Set(['a_bad', 'a_wait']), brokenIds: new Set(['a_bad']), tz: 'UTC', now: Date.parse('2026-10-12T08:00:00Z'), nowIso: '2026-10-12T08:00:00Z' });
  assert.ok(plan.posts.length >= 2);
  assert.ok(plan.posts.every((p) => p.listItemId === 'wait'));
  assert.deepEqual(plan.missing, [], 'a failed download is not "missing from the library"');
});

test('photos for the feed must fit 4:5 to 1.91:1: a wide feed image is refused and never scheduled; a story keeps its wide photo', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  web.routes.set(`${SITE}/feed.xml`, ok(rss([{ id: 'w1', title: 'Wide hero', at: t0 - HOUR, media: `${SITE}/img/wide.jpg` }]), 'application/rss+xml'));
  web.routes.set(`${SITE}/img/wide.jpg`, ok(await jpegSized(1200, 600), 'image/jpeg'));
  web.routes.set(`${SITE}/img/wide-story.jpg`, ok(await jpegSized(1200, 600), 'image/jpeg'));
  const slots = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: '12:00' }));
  await addQueueWithFeed(env, {}, { slots });
  // The same kind of photo in a story (CSV import) is fine: stories take any shape.
  await env.update('library', (d) => void d.assets.push(newAsset({ id: 'a_story', name: 'wide-story.jpg', importUrl: `${SITE}/img/wide-story.jpg` })));
  await env.update('posts', (d) => void d.posts.push(newPost({ id: 'p_story', type: 'story', status: 'draft', media: [{ assetId: 'a_story', kind: 'image' }] })));

  const res = await runWorker({ env: env.env, only: ['feeds', 'evergreen'], now: new Date(t0).toISOString(), fetchImpl: web.fetchImpl, log: () => {} });
  assert.deepEqual(res.summary.jobs.feeds, { feedsChecked: 1, feedItems: 1, downloaded: 1, downloadFailed: 1 });
  const lib = (await env.read('library')).assets;
  const list = (await env.read('lists')).lists[0];
  const wide = lib.find((a) => a.id === list.items[0].media[0].assetId);
  assert.equal(wide.importErrorCode, 'shape');
  assert.match(wide.importError, /^The photo is 1200x600, wider than Instagram allows in the feed \(between 4:5 and 1\.91:1\)/);
  const story = lib.find((a) => a.id === 'a_story');
  assert.equal(story.importUrl, undefined);
  assert.equal(story.width, 1200);
  // Evergreen schedules nothing from the refused item (Instagram would refuse every post: 2207009).
  assert.equal(res.summary.jobs.evergreen.evergreenCreated, 0);
  assert.equal((await env.read('posts')).posts.filter((p) => p.listId === list.id).length, 0);
});

test('evergreen skips items with a photo outside the feed range that is already in the library', () => {
  const assets = [
    newAsset({ id: 'tall', kind: 'image', width: 1080, height: 1920 }),
    newAsset({ id: 'ok', kind: 'image', width: 1080, height: 1350 }),
    newAsset({ id: 'og', kind: 'image', width: 1200, height: 630 }), // 1.905:1, the usual share-image size
    newAsset({ id: 'v', kind: 'video', width: 1080, height: 1920 }),
    newAsset({ id: 'fail', importUrl: 'https://x.example/a.jpg', importError: 'gone' }),
  ];
  assert.deepEqual([...brokenAssetIds(assets)].sort(), ['fail', 'tall']);
  const list = newList({
    id: 'l1',
    slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: '12:00' })),
    horizonDays: 3,
    items: ['tall', 'ok', 'og', 'v'].map((id) => ({ id: `i_${id}`, type: id === 'v' ? 'reel' : 'feed', media: [{ assetId: id, kind: id === 'v' ? 'video' : 'image' }] })),
  });
  const plan = planList(list, { posts: [], assetIds: new Set(assets.map((a) => a.id)), brokenIds: brokenAssetIds(assets), tz: 'UTC', now: Date.parse('2026-10-12T08:00:00Z'), nowIso: '2026-10-12T08:00:00Z' });
  assert.ok(plan.posts.length >= 3);
  assert.ok(plan.posts.every((p) => p.listItemId !== 'i_tall'));
});

test('feedOnlyAssets: queue items and feed posts need the feed shape, unless a story uses the file too', () => {
  const lists = { lists: [newList({ items: [{ id: 'i1', media: [{ assetId: 'q' }] }, { id: 'i2', media: [{ assetId: 'both' }] }] })] };
  const posts = [
    newPost({ type: 'feed', status: 'scheduled', media: [{ assetId: 'f' }] }),
    newPost({ type: 'carousel', status: 'draft', media: [{ assetId: 'c1' }, { assetId: 'c2' }] }),
    newPost({ type: 'story', status: 'draft', media: [{ assetId: 'both' }, { assetId: 's' }] }),
    newPost({ type: 'feed', status: 'canceled', media: [{ assetId: 'gone' }] }),
  ];
  assert.deepEqual([...feedOnlyAssets(lists, posts)].sort(), ['c1', 'c2', 'f', 'q']);
});

test('a feed listing more items than the seen list holds never brings old items back', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  const items = [];
  for (let i = 600; i >= 1; i--) items.push({ id: `g${i}`, title: `Post ${i}`, at: t0 - (601 - i) * HOUR, media: `${SITE}/img/${i}.jpg` });
  web.routes.set(`${SITE}/feed.xml`, () => new Response(rss(items), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } }));
  const counts = [];
  await addQueueWithFeed(env);
  for (let k = 0; k < 4; k++) {
    const res = await runWorker({ env: env.env, only: ['feeds'], now: new Date(t0 + k * 2 * HOUR).toISOString(), fetchImpl: web.fetchImpl, log: () => {} });
    counts.push(res.summary.jobs.feeds.feedItems);
  }
  assert.deepEqual(counts, [3, 0, 0, 0]);
  const feed = (await env.read('lists')).lists[0].feeds[0];
  assert.equal(feed.seen.length, SEEN_CAP);
  assert.ok(feed.seen.includes('g600') && feed.seen.includes('g101'));
  // A new post still comes through.
  items.unshift({ id: 'g601', title: 'Post 601', at: t0 + 10 * HOUR, media: `${SITE}/img/601.jpg` });
  const res = await runWorker({ env: env.env, only: ['feeds'], now: new Date(t0 + 12 * HOUR).toISOString(), fetchImpl: web.fetchImpl, log: () => {} });
  assert.equal(res.summary.jobs.feeds.feedItems, 1);
});

test('a queue holds a bounded backlog from a busy feed; new posts wait until it has used some', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  const items = [];
  let next = 1;
  const publish = (n) => {
    for (let k = 0; k < n; k++, next++) items.unshift({ id: `b${next}`, title: `Busy ${next}`, at: t0 + next * 60e3, media: `${SITE}/img/b.jpg` });
  };
  web.routes.set(`${SITE}/feed.xml`, () => new Response(rss(items), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } }));
  web.routes.set(`${SITE}/img/b.jpg`, ok(await fixtureBytes('f01.jpg'), 'image/jpeg'));
  const list = await addQueueWithFeed(env, {}, { slots: [{ weekday: 3, time: '12:00' }], horizonDays: 14 });
  const cap = feedBacklogCap(list);
  assert.equal(cap, 10, 'one slot a week, 14 days: the minimum of 10');
  assert.equal(feedBacklogCap({ slots: [1, 3, 5].map((weekday) => ({ weekday, time: '12:00' })), horizonDays: 14 }), 12, 'two rounds of 3 slots a week over 14 days');
  assert.equal(feedBacklogCap({ slots: Array.from({ length: 14 }, (_, i) => ({ weekday: i % 7, time: `${10 + (i % 2)}:00` })), horizonDays: 30 }), 50, 'at most 50');

  publish(3);
  let hour = 0;
  const check = async () => {
    hour += 2;
    return runWorker({ env: env.env, only: ['feeds'], now: new Date(t0 + hour * HOUR).toISOString(), fetchImpl: web.fetchImpl, log: () => {} });
  };
  await check();
  for (let k = 0; k < 4; k++) {
    publish(5);
    await check();
  }
  let doc = (await env.read('lists')).lists[0];
  const fromFeed = () => doc.items.filter((it) => it.feedId === 'fd_1');
  assert.equal(fromFeed().length, cap, 'never more unused items than the cap');
  assert.equal(doc.feeds[0].full, true);
  // 3 on the first check, then 5 and the 2 newest of the next check fill the 10; later posts wait.
  assert.deepEqual(fromFeed().map((it) => it.caption.split('\n')[0]), [1, 2, 3, 4, 5, 6, 7, 8, 12, 13].map((n) => `Busy ${n}`));
  const logged = (await env.read('log')).entries.filter((e) => e.job === 'feeds' && /so new posts are skipped until it has used some/.test(e.message));
  assert.equal(logged.length, 1, 'logged once when the queue fills up');

  // The queue uses two items: two of the next new posts come in.
  await env.update('lists', (d) => {
    for (const it of d.lists[0].items.slice(0, 2)) it.timesUsed = 1;
  });
  publish(5);
  await check();
  doc = (await env.read('lists')).lists[0];
  assert.equal(fromFeed().filter((it) => !it.timesUsed).length, cap);
  assert.deepEqual(fromFeed().slice(-2).map((it) => it.caption.split('\n')[0]), [`Busy ${next - 2}`, `Busy ${next - 1}`], 'the newest ones');
  assert.equal(doc.feeds[0].full, true);
});

test('one broken feed does not stop the other feeds or the downloads', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  // 20,000 unclosed tags in a title, then 120 KB of unclosed comments in a description.
  const hostile = `<rss><channel><title>T</title><item><title>${'<b>'.repeat(20000)}x</title><guid>1</guid><description><![CDATA[${'<!--'.repeat(30000)}]]></description></item></channel></rss>`;
  web.routes.set(`${SITE}/bad.xml`, ok(hostile, 'application/rss+xml'));
  web.routes.set(`${SITE}/feed.xml`, ok(rss([{ id: 'n1', title: 'Fine', at: t0 - HOUR, media: `${SITE}/img/fine.jpg` }]), 'application/rss+xml'));
  web.routes.set(`${SITE}/img/fine.jpg`, ok(await fixtureBytes('f02.jpg'), 'image/jpeg'));
  web.routes.set(`${SITE}/img/csv.jpg`, ok(await fixtureBytes('f03.jpg'), 'image/jpeg'));
  await addQueueWithFeed(env, {}, { feeds: [
    { id: 'fd_bad', url: `${SITE}/bad.xml`, title: '', disabled: false, checkedAt: null, error: null, seen: [], added: 0 },
    { id: 'fd_ok', url: `${SITE}/feed.xml`, title: '', disabled: false, checkedAt: null, error: null, seen: [], added: 0 },
  ] });
  await env.update('library', (d) => void d.assets.push(newAsset({ id: 'a_csv', name: 'csv.jpg', importUrl: `${SITE}/img/csv.jpg` })));
  const started = Date.now();
  const res = await run(env, web, { now: new Date(t0).toISOString() });
  assert.ok(Date.now() - started < 10_000, 'hostile markup is cheap to read');
  assert.equal(res.exitCode, 0);
  assert.equal(res.summary.jobs.feeds.feedsChecked, 2);
  const feeds = (await env.read('lists')).lists[0].feeds;
  assert.ok(feeds.every((f) => f.checkedAt));
  assert.equal(feeds.find((f) => f.id === 'fd_ok').added, 1);
  assert.equal((await env.read('library')).assets.find((a) => a.id === 'a_csv').importUrl, undefined, 'the CSV link was downloaded');
});

test('og:image is found in the head of a long article page; a page link takes the image name', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  const web = fakeWeb();
  const page = `<!doctype html><html><head><meta property="og:image" content="${SITE}/img/hero.jpg"></head><body>${'<div class="c">article text</div>'.repeat(40000)}</body></html>`;
  assert.ok(page.length > 1024 * 1024);
  web.routes.set(`${SITE}/news/a`, ok(page, 'text/html'));
  web.routes.set(`${SITE}/feed.xml`, ok(`<rss><channel><title>News</title><item><title>No image in the feed</title><link>${SITE}/news/a</link><guid>a1</guid></item></channel></rss>`, 'application/rss+xml'));
  const r = await checkFeed(web.fetchImpl, { url: `${SITE}/feed.xml`, seen: [] });
  assert.equal(r.noImage, 0);
  assert.equal(r.items[0].imageUrl, `${SITE}/img/hero.jpg`);

  // A CSV link to a page: the asset is named after the image it ends up with; sourceUrl stays the link.
  web.routes.set(`${SITE}/img/hero.jpg`, ok(await fixtureBytes('f10.jpg'), 'image/jpeg'));
  web.routes.set(`${SITE}/kiln-opening.html`, ok(page, 'text/html'));
  await env.update('library', (d) => void d.assets.push(newAsset({ id: 'a_page', name: 'kiln-opening.html', importUrl: `${SITE}/kiln-opening.html` })));
  await run(env, web);
  const a = (await env.read('library')).assets.find((x) => x.id === 'a_page');
  assert.equal(a.importUrl, undefined);
  assert.equal(a.name, 'hero.jpg');
  assert.equal(a.sourceUrl, `${SITE}/kiln-opening.html`);
});

test('fetchCapped: truncate keeps the first bytes of a larger response', async () => {
  const stream = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8).fill(1)); c.enqueue(new Uint8Array(8).fill(2)); c.close(); } }), { status: 200, headers: { 'Content-Length': '16' } });
  const r = await fetchCapped(stream, 'https://big.example/page', { maxBytes: 10, timeoutMs: 1000, truncate: true });
  assert.deepEqual([...r.bytes], [1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
});
