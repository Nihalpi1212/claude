// Feeds and linked media (runs before evergreen, so new queue items can be scheduled in the same run).
//
// 1. RSS / Atom feeds of enabled queues (lists[].feeds[], disabled feeds skipped), each checked at
//    most hourly (feed.checkedAt; from its third failed check in a row, a feed waits twice as long
//    each time, up to a day: feed.errorCount, see feedInterval), at most 10 feeds per run, 2 MB per feed,
//    conditional GET with ETag / Last-Modified. The feed is parsed in a worker thread with a memory
//    and time limit, so a hostile feed can only fail its own check. Items the feed has not shown
//    before (guid not in feed.seen) become queue items with a new library asset that the worker
//    downloads (asset.importUrl):
//      - only the newest 500 items of a feed count (feed.seen keeps their guids, so a long feed never
//        brings old items back);
//      - the first check of a feed adds only its newest 3 usable items (the rest are marked as seen),
//        later checks at most 5 per feed per run (older new ones are skipped, so a burst does not
//        flood the queue with stale posts);
//      - a queue holds at most feedBacklogCap() unused items from one feed (about two weeks of its
//        slots): while it is full, new posts are marked as seen and skipped. Items that can never be
//        posted (download failed or refused, media deleted: core/feed.js brokenAssetIds) do not count,
//        and of those the queue keeps only the newest feedBacklogCap() per feed (older ones are removed
//        with their file-less library assets), so refused images can neither clog the feed nor grow
//        the queue without bound;
//      - the image comes from the feed (core/feed.js pickImage), else the item page's og:image (the
//        first 1 MB of the page); items without an image, or whose image is known not to be a JPEG
//        (PNG, WebP, GIF...: the worker cannot post them), are skipped;
//      - captions come from feed.template ({title}, {summary}, {link}; default title + summary),
//        clipped to Instagram's caption limit. Links are not clickable on Instagram, so the link is
//        only in the caption when the owner's template asks for it.
//    One feed failing (network, bad markup) never stops the other feeds or the downloads.
// 2. Linked media downloads (CSV imports and feed items: the browser cannot fetch other sites because
//    of the page's Content-Security-Policy). At most 8 per run, 30 s each, http(s) only.
//      - Links to private or local network addresses (and redirects to them) are refused, as are ports
//        other than 80 and 443 (ctx.fetchLinks, worker/context.mjs): a feed author picks these URLs.
//      - JPEG photos (up to 8 MB once stripped) are stored without their metadata (EXIF/XMP, and
//        whatever follows the image: secondary images, motion-photo videos); width and height come
//        from the SOF marker. A photo whose EXIF orientation tag rotates it is refused: stripping
//        the tag would turn it sideways, and whether Instagram honours the tag is not documented.
//      - A photo only feed posts use (queue items, feed and carousel posts) must be between 4:5 and
//        1.91:1, or Instagram refuses it at publish (2207009): other shapes are refused here.
//      - MP4 / MOV videos (up to 95 MB) get the same metadata stripping as browser uploads
//        (core/mp4.js); size and duration come from the 'tkhd' / 'mvhd' boxes.
//      - PNG, WebP, GIF, HEIC and AVIF cannot be published from the worker (Instagram takes JPEG and
//        the worker has no image encoder): the asset gets an importError asking the owner to upload
//        the file in the Library, which converts it.
//      - A link that opens a web page is followed once to the page's og:image (and the asset is
//        renamed after the image when it still has the page's file name).
//      - Server errors, timeouts and network failures are retried on later runs (backing off 10, 20,
//        40, 80 minutes; the last reason is kept in asset.importLastError); after 5 failed tries, or
//        on any other error, the asset gets importError (and importErrorCode, see IMPORT_REFUSED).
//    The file is written encrypted at asset.path and also serves as the thumbnail (thumbPath = path).
//
// Time: feed checks stop after 3 minutes and new downloads after 4 (the rest wait for the next run),
// and nothing runs past RUN_DEADLINE_MS from the start of the run, which may have spent most of its
// time publishing: the workflow's 20-minute timeout would cancel the run and lose its record. A
// request cut short by that deadline does not count as a failure (the feed or file stays due).
//
// Console output stays counts only: feed URLs, titles and file names go to the encrypted log.

import { Worker } from 'node:worker_threads';
import {
  DOWNLOAD_RETRY_BASE_MS,
  DOWNLOADS_PER_RUN,
  FEED_TEMPLATE,
  MAX_DOWNLOAD_TRIES,
  brokenAssetIds,
  feedBacklogCap,
  feedCaption,
  fitsFeed,
  isHttpUrl,
  jpegInfo,
  nameFromUrl,
  newestFirst,
  nonJpegFormat,
  ogImage,
  parseFeed,
  sniffMedia,
  stripJpegMetadata,
} from '../../core/feed.js';
import { mp4Info, stripMp4Metadata } from '../../core/mp4.js';
import { LIMITS, newAsset, uid } from '../../core/model.js';
import { describeError } from '../context.mjs';
import { clip } from './shared.mjs';

export const FEED_EVERY_MS = 60 * 60e3;
export const FEED_MAX_EVERY_MS = 24 * 60 * 60e3; // a feed that keeps failing is checked at least daily
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_MAX_BYTES = 1024 * 1024;
export const FIRST_CHECK_ITEMS = 3;
export const ITEMS_PER_CHECK = 5;
export const SEEN_CAP = 500;
export const MAX_FEEDS_PER_RUN = 10;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
export { DOWNLOADS_PER_RUN, MAX_DOWNLOAD_TRIES, feedBacklogCap };
const FEED_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 15_000;
const EXTRA_PAGE_LOOKUPS = 2; // og:image lookups per check beyond the items it may add
const FEED_BUDGET_MS = 3 * 60e3; // stop checking more feeds after this (they stay due for the next run)
const JOB_BUDGET_MS = 4 * 60e3; // stop starting new downloads after this (the next run continues)
// Nothing runs later than this after the start of the run (publish may use its first 14 minutes; the
// workflow cancels the run at 20), and the job is skipped when less than MIN_TIME_LEFT_MS is left.
export const RUN_DEADLINE_MS = 15.5 * 60e3;
const MIN_TIME_LEFT_MS = 60e3;
const PARSE_TIMEOUT_MS = 20_000;
const PARSE_HEAP_MB = 512;
const FLUSH_BYTES = 64 * 1024 * 1024; // commit downloaded files in batches to bound memory
const USER_AGENT = 'Mozilla/5.0 (compatible; Postpilot feed reader)';
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';
const FORMAT_NAMES = { png: 'PNG', webp: 'WebP', gif: 'GIF', heic: 'HEIC', avif: 'AVIF' };

/**
 * A failed fetch or download. `transient`: worth trying again on a later run. code 'deadline': cut
 * short by the run's time limit (not the site's fault: nothing is recorded, the next run tries again).
 */
export class FetchError extends Error {
  constructor(message, { transient = false, status = null, code = null } = {}) {
    super(message);
    this.name = 'FetchError';
    this.transient = transient;
    this.status = status;
    this.code = code;
  }
}

// Other sites: ctx.fetchLinks refuses private addresses (worker/context.mjs); tests inject ctx.fetch.
const fetchOf = (ctx) => ctx.fetchLinks || ctx.fetch || globalThis.fetch.bind(globalThis);
const mb = (n) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

function httpMessage(status) {
  if (status === 404) return 'The link answered 404 Not Found.';
  if (status === 410) return 'The link answered 410 Gone: the file was removed.';
  if (status === 401 || status === 403) return `The site refused the download (${status}). The file may need a login or block downloads.`;
  if (status === 429) return 'The site is limiting requests (429). Postpilot will try again later.';
  if (status >= 500) return `The site had a server error (${status}).`;
  return `The link answered with status ${status}.`;
}

/**
 * fetch with a timeout and a size cap (http and https only). Returns {status, bytes, contentType,
 * url (after redirects), etag, lastModified}; status 304 comes back without bytes. `truncate`: keep
 * the first maxBytes of a larger response instead of failing (for reading a page's <head>).
 * `deadline` (epoch ms, Date.now() clock): the request is cut short then (FetchError code 'deadline').
 * @throws {FetchError}
 */
export async function fetchCapped(fetchImpl, url, { maxBytes, timeoutMs, accept = '*/*', headers = {}, tooBig, truncate = false, deadline = Infinity } = {}) {
  if (!isHttpUrl(url)) throw new FetchError('The link is not a web address (it must start with http:// or https://).', { code: 'bad_url' });
  const left = deadline - Date.now();
  const outOfTime = () => new FetchError('The run ran out of time; the next run tries again.', { transient: true, code: 'deadline' });
  if (left <= 0) throw outOfTime();
  const cut = left < timeoutMs; // the run's deadline comes before the site's timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cut ? left : timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: accept, ...headers } });
    } catch (err) {
      if (controller.signal.aborted && cut) throw outOfTime();
      if (controller.signal.aborted) throw new FetchError(`The site did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, { transient: true, code: 'timeout' });
      if (err && err.blocked) throw new FetchError(err.message, { code: 'blocked' }); // a private address (ctx.fetchLinks)
      const cause = String(err?.cause?.code || err?.code || '');
      throw new FetchError(cause === 'ENOTFOUND' ? 'The site could not be found. Check the address.' : 'Could not connect to the site.', { transient: true, code: cause || 'network' });
    }
    const meta = {
      status: res.status,
      url: res.url || url,
      contentType: String(res.headers?.get?.('content-type') || ''),
      etag: res.headers?.get?.('etag') || null,
      lastModified: res.headers?.get?.('last-modified') || null,
    };
    if (res.status === 304) return { ...meta, bytes: null };
    if (!res.ok) throw new FetchError(httpMessage(res.status), { transient: res.status >= 500 || res.status === 408 || res.status === 429, status: res.status, code: 'http' });
    const declared = Number(res.headers?.get?.('content-length'));
    if (!truncate && Number.isFinite(declared) && declared > maxBytes) throw new FetchError(tooBig ? tooBig(declared) : `The file is ${mb(declared)}, more than the ${mb(maxBytes)} limit.`, { code: 'too_big' });
    const tooLarge = (n) => new FetchError(tooBig ? tooBig(n) : `The file is more than the ${mb(maxBytes)} limit.`, { code: 'too_big' });
    const chunks = [];
    let total = 0;
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (total + value.byteLength > maxBytes) {
            reader.cancel().catch(() => {});
            if (!truncate) throw tooLarge(total + value.byteLength);
            chunks.push(value.subarray(0, maxBytes - total));
            total = maxBytes;
            break;
          }
          total += value.byteLength;
          chunks.push(value);
        }
      } else {
        let buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > maxBytes) {
          if (!truncate) throw tooLarge(buf.length);
          buf = buf.subarray(0, maxBytes);
        }
        chunks.push(buf);
        total = buf.length;
      }
    } catch (err) {
      if (err instanceof FetchError) throw err;
      if (controller.signal.aborted && cut) throw outOfTime();
      if (controller.signal.aborted) throw new FetchError(`The download did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, { transient: true, code: 'timeout' });
      throw new FetchError('The connection broke off during the download.', { transient: true, code: 'network' });
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { ...meta, bytes };
  } finally {
    clearTimeout(timer);
  }
}

/** Text of a response: charset from Content-Type, else the XML declaration, else UTF-8. */
export function decodeText(bytes, contentType = '') {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
  const label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] || /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Feeds

/** An unused item of a feed that can never be posted: its file failed or was refused, or was deleted from the library. */
function isBrokenItem(it, brokenIds) {
  return !!it.mediaMissing || (it.media || []).some((m) => m && brokenIds && brokenIds.has(m.assetId));
}

/**
 * Unused items a feed has in its queue that the queue can still post (broken ones are skipped by
 * evergreen, so they would hold the feed's room for good). brokenIds: core/feed.js brokenAssetIds.
 */
export function feedBacklog(list, feedId, brokenIds = null) {
  return (list.items || []).filter((it) => it && it.feedId === feedId && !(it.timesUsed > 0) && !isBrokenItem(it, brokenIds)).length;
}

/**
 * How long a feed waits between checks: an hour, also after one or two failed checks in a row (a
 * site that is down for a while); from the third (feed.errorCount, missing on older docs = 1 while
 * feed.error is set) twice as long each time, up to a day.
 */
export function feedInterval(feed) {
  const errors = feed && feed.error ? Math.max(1, Number(feed.errorCount) || 1) : 0;
  return errors <= 2 ? FEED_EVERY_MS : Math.min(FEED_MAX_EVERY_MS, FEED_EVERY_MS * 2 ** (errors - 2));
}

/** Feeds that are due for a check, never-checked first: [{listId, listName, feed, last, room}]. Exported for tests. */
export function dueFeeds(listsDoc, nowMs, brokenIds = null) {
  const out = [];
  for (const list of listsDoc.lists || []) {
    if (list.enabled === false) continue;
    for (const feed of list.feeds || []) {
      if (!feed || feed.disabled || !isHttpUrl(feed.url)) continue;
      const last = Date.parse(feed.checkedAt || '');
      if (Number.isFinite(last) && nowMs - last < feedInterval(feed) && nowMs >= last) continue;
      const room = Math.max(0, feedBacklogCap(list) - feedBacklog(list, feed.id, brokenIds));
      out.push({ listId: list.id, listName: list.name || 'Queue', feed, last: Number.isFinite(last) ? last : -Infinity, room });
    }
  }
  return out.sort((a, b) => a.last - b.last).slice(0, MAX_FEEDS_PER_RUN);
}

/**
 * Remove a feed's oldest unused broken items beyond the newest `keep` (see isBrokenItem), with their
 * library assets when the worker never stored a file for them and nothing else uses them. Returns
 * how many items were removed.
 */
function pruneBrokenItems(list, feedId, { lib, posts, lists, brokenIds, keep }) {
  const broken = (list.items || []).filter((it) => it && it.feedId === feedId && !(it.timesUsed > 0) && isBrokenItem(it, brokenIds));
  const drop = new Set(broken.slice(0, Math.max(0, broken.length - keep)));
  if (!drop.size) return 0;
  list.items = list.items.filter((it) => !drop.has(it));
  const inUse = new Set();
  for (const p of posts || []) for (const id of [...(p.media || []).map((m) => m && m.assetId), p.coverAssetId]) if (id) inUse.add(id);
  for (const l of lists || []) for (const it of l.items || []) for (const m of (it && it.media) || []) if (m) inUse.add(m.assetId);
  const gone = new Set();
  for (const it of drop) for (const m of it.media || []) if (m && !inUse.has(m.assetId)) gone.add(m.assetId);
  lib.assets = (lib.assets || []).filter((a) => !(gone.has(a.id) && a.importUrl && a.importError && !(a.usedBy || []).length));
  return drop.size;
}

const TOO_COMPLEX = 'The feed could not be read: it is too large or too complex. Use a feed that lists fewer items.';
// Runs in a worker thread (CommonJS eval: it loads core/feed.js with a dynamic import).
const PARSE_SCRIPT = `const { parentPort, workerData } = require('node:worker_threads');
import(workerData.module)
  .then((m) => parentPort.postMessage({ result: m.parseFeed(workerData.xml, { url: workerData.url }) }))
  .catch((err) => parentPort.postMessage({ failed: String((err && err.message) || err) }));`;
const FEED_MODULE = new URL('../../core/feed.js', import.meta.url).href;

/**
 * parseFeed in a worker thread with a heap limit and a time limit: a hostile feed (or a parser bug)
 * can only fail its own check, never block or crash the run. Falls back to parsing here when a
 * thread cannot be started. Resolves to parseFeed's result ({error} when it could not finish).
 */
export function parseFeedIsolated(xml, url, { timeoutMs = PARSE_TIMEOUT_MS, heapMb = PARSE_HEAP_MB } = {}) {
  let worker;
  try {
    worker = new Worker(PARSE_SCRIPT, { eval: true, workerData: { module: FEED_MODULE, xml, url }, resourceLimits: { maxOldGenerationSizeMb: heapMb }, stdout: true, stderr: true });
  } catch {
    return Promise.resolve(parseFeed(xml, { url }));
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: TOO_COMPLEX }), timeoutMs);
    worker.on('message', (m) => finish(m && m.result ? m.result : { error: 'The feed could not be read: its markup is broken.' }));
    worker.on('error', () => finish({ error: TOO_COMPLEX })); // out of memory, among others
    worker.on('exit', () => finish({ error: TOO_COMPLEX }));
  });
}

/**
 * Read one feed and work out what to add (no data writes; never throws). `limit`: how many items the
 * queue has room for (FIRST_CHECK_ITEMS / ITEMS_PER_CHECK apply on top). `deadline`: see fetchCapped.
 * Returns {notModified} | {error} | {deferred} (the run's time ran out: check again next run) |
 * {title, items: [{guid, title, link, summary, published, imageUrl}] (oldest first),
 *  current: [guid] (the newest SEEN_CAP items the feed lists now, newest first), fresh, noImage, notJpeg, etag, lastModified}.
 */
export async function checkFeed(fetchImpl, feed, { limit = Infinity, deadline = Infinity } = {}) {
  const seenBefore = new Set(Array.isArray(feed.seen) ? feed.seen : []);
  const first = !seenBefore.size;
  const max = Math.max(0, Math.min(first ? FIRST_CHECK_ITEMS : ITEMS_PER_CHECK, limit));
  const headers = {};
  if (!first && feed.etag) headers['If-None-Match'] = feed.etag;
  if (!first && feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;
  let res;
  try {
    res = await fetchCapped(fetchImpl, feed.url, {
      maxBytes: FEED_MAX_BYTES,
      timeoutMs: FEED_TIMEOUT_MS,
      accept: FEED_ACCEPT,
      headers,
      tooBig: () => 'The feed is larger than 2 MB. Use a feed that lists fewer items.',
      deadline,
    });
  } catch (err) {
    if (err instanceof FetchError && err.code === 'deadline') return { deferred: true };
    return { error: err instanceof FetchError ? err.message : describeError(err) };
  }
  if (res.status === 304) return { notModified: true, etag: res.etag || feed.etag || null, lastModified: res.lastModified || feed.lastModified || null };
  let parsed;
  try {
    parsed = await parseFeedIsolated(decodeText(res.bytes, res.contentType), res.url);
  } catch {
    parsed = { error: 'The feed could not be read: its markup is broken.' }; // parseFeed is tolerant; just in case
  }
  if (parsed.error) return { error: parsed.error };
  // Only the newest SEEN_CAP items count: older ones are never new, so `seen` never has to rotate.
  const items = newestFirst(parsed.items).filter((it) => it.guid).slice(0, SEEN_CAP);
  const fresh = items.filter((it) => !seenBefore.has(it.guid));
  // New items newest first until `max` have an image the worker can post. The ones after that are
  // older and skipped on purpose (they still count as seen).
  let noImage = 0;
  let notJpeg = 0;
  let lookups = 0;
  const out = [];
  for (const it of fresh) {
    if (out.length >= max) break;
    let imageUrl = it.imageUrl;
    let format = it.imageFormat || '';
    if (!imageUrl && it.link && lookups < max + EXTRA_PAGE_LOOKUPS) {
      lookups++;
      try {
        // og:image is in the <head>: the first 1 MB of a long article page is enough.
        const page = await fetchCapped(fetchImpl, it.link, { maxBytes: PAGE_MAX_BYTES, timeoutMs: PAGE_TIMEOUT_MS, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', truncate: true, deadline });
        imageUrl = ogImage(decodeText(page.bytes, page.contentType), page.url);
        format = nonJpegFormat(imageUrl);
      } catch (err) {
        // Out of time: nothing is marked as seen, the next run checks the feed again.
        if (err instanceof FetchError && err.code === 'deadline') return { deferred: true };
        imageUrl = '';
      }
    }
    if (!imageUrl) noImage++;
    else if (format) notJpeg++; // PNG, WebP, GIF...: the worker could only refuse it after downloading
    else out.push({ guid: it.guid, title: it.title, link: it.link, summary: it.summary, published: it.published, imageUrl });
  }
  return {
    title: parsed.title || '',
    items: out.reverse(),
    current: items.map((it) => it.guid),
    fresh: fresh.length,
    noImage,
    notJpeg,
    etag: res.etag,
    lastModified: res.lastModified,
  };
}

/** The queue item and library asset for one new feed item (ids fixed before the transaction). */
export function feedEntry(it, { feed, nowIso }) {
  const asset = newAsset({
    kind: 'image',
    name: clip(it.title || nameFromUrl(it.imageUrl), 80),
    mime: 'image/jpeg',
    importUrl: it.imageUrl,
    tags: ['feed'],
    notes: [feed.title ? `From the feed "${feed.title}".` : 'From a feed.', it.link || ''].filter(Boolean).join(' '),
    autopilot: false,
    createdAt: nowIso,
  });
  const item = {
    id: uid('li_'),
    type: 'feed',
    caption: feedCaption(it, feed.template || FEED_TEMPLATE, LIMITS.captionChars),
    firstComment: '',
    media: [{ assetId: asset.id, kind: 'image', altText: '' }],
    timesUsed: 0,
    lastUsedAt: null,
    source: 'rss',
    link: it.link || '',
    feedId: feed.id,
    addedAt: nowIso,
  };
  return { asset, item };
}

/**
 * Check the due feeds (until `until`, no request past `deadline`; Date.now() clock) and add their new
 * items in one commit. Exported for tests.
 */
export async function runFeeds(ctx, due, result, { until = Infinity, deadline = Infinity } = {}) {
  const nowIso = ctx.nowIso();
  const checks = [];
  for (const d of due) {
    if (Date.now() >= until) break;
    let r;
    try {
      r = await checkFeed(fetchOf(ctx), d.feed, { limit: d.room, deadline });
    } catch (err) {
      r = { error: `The feed could not be read: ${describeError(err)}` }; // one bad feed never stops the others
    }
    if (r.deferred) break; // out of time: this feed and the rest stay due for the next run
    const entries = (r.items || []).map((it) => ({ guid: it.guid, ...feedEntry(it, { feed: { ...d.feed, title: d.feed.title || r.title }, nowIso }) }));
    checks.push({ ...d, r, entries });
  }
  result.feedsChecked = checks.length;
  if (!checks.length) return;
  let added = 0;
  let notes = [];
  await ctx.store.transact(
    async (tx) => {
      added = 0;
      notes = [];
      const doc = await tx.read('lists');
      const lib = await tx.read('library');
      const posts = (await tx.read('posts')).posts;
      const brokenIds = brokenAssetIds(lib.assets);
      let libChanged = false;
      let changed = false;
      for (const c of checks) {
        const list = (doc.lists || []).find((l) => l.id === c.listId);
        const feed = list && (list.feeds || []).find((f) => f.id === c.feed.id);
        if (!feed || feed.url !== c.feed.url) continue; // removed or changed in the app meanwhile
        changed = true;
        feed.checkedAt = nowIso;
        const { r } = c;
        if (r.error) {
          if (feed.error !== r.error) notes.push({ level: 'warn', message: `The feed ${feed.title ? `"${feed.title}"` : feed.url} in the queue "${list.name}" could not be read: ${r.error}` });
          // Failed checks in a row space out the next ones (feedInterval); a new URL starts again at 1.
          feed.errorCount = feed.error ? Math.max(1, Number(feed.errorCount) || 1) + 1 : 1;
          feed.error = r.error;
          continue;
        }
        feed.error = null;
        delete feed.errorCount;
        if (r.etag !== undefined) feed.etag = r.etag || null;
        if (r.lastModified !== undefined) feed.lastModified = r.lastModified || null;
        list.items = list.items || [];
        const cap = feedBacklogCap(list);
        if (r.notModified) {
          if (feed.full && feedBacklog(list, feed.id, brokenIds) < cap) delete feed.full; // room came back meanwhile
          continue;
        }
        if (r.title) feed.title = r.title;
        const name = feed.title || feed.url;
        const seen = new Set(Array.isArray(feed.seen) ? feed.seen : []);
        // Items that can never be posted: only the newest `cap` are kept (they do not take room).
        const pruned = pruneBrokenItems(list, feed.id, { lib, posts, lists: doc.lists, brokenIds, keep: cap });
        if (pruned) {
          libChanged = true;
          notes.push({ level: 'info', message: `Removed ${pruned} older item${pruned === 1 ? '' : 's'} of the feed "${name}" from the queue "${list.name}": ${pruned === 1 ? 'its picture' : 'their pictures'} could not be downloaded or Instagram cannot take ${pruned === 1 ? 'it' : 'them'}.` });
        }
        // Room left now (items may have been added or used since the check started); newest first.
        const room = Math.max(0, cap - feedBacklog(list, feed.id, brokenIds));
        const take = c.entries.filter((e) => !seen.has(e.guid) && !list.items.some((it) => it.id === e.item.id));
        let n = 0;
        for (const e of take.slice(Math.max(0, take.length - room))) {
          if (!lib.assets.some((a) => a.id === e.asset.id)) lib.assets.unshift(structuredClone(e.asset));
          list.items.push(structuredClone(e.item));
          libChanged = true;
          n++;
        }
        // Every item the feed lists now is seen (also the ones skipped above), plus older guids up to the cap.
        feed.seen = [...new Set([...(r.current || []), ...seen])].slice(0, SEEN_CAP);
        if (n) {
          feed.added = (feed.added || 0) + n;
          feed.lastAddedAt = nowIso;
          notes.push({ level: 'info', message: `Added ${n} item${n === 1 ? '' : 's'} from the feed "${name}" to the queue "${list.name}".` });
        }
        // feed.full: the queue has no room for more items from this feed (new posts are skipped).
        const left = room - n;
        if (!left && !feed.full) {
          notes.push({ level: 'info', message: `The queue "${list.name}" has ${feedBacklog(list, feed.id, brokenIds)} unused items from the feed "${name}", so new posts are skipped until it has used some.` });
        }
        if (!left) feed.full = true;
        else delete feed.full;
        if (r.noImage) notes.push({ level: 'info', message: `Skipped ${r.noImage} new item${r.noImage === 1 ? '' : 's'} of the feed "${name}" without an image.` });
        if (r.notJpeg) notes.push({ level: 'info', message: `Skipped ${r.notJpeg} new item${r.notJpeg === 1 ? '' : 's'} of the feed "${name}" whose image is not a JPEG (PNG, WebP or GIF), which the worker cannot post.` });
        added += n;
      }
      if (changed) tx.write('lists', doc);
      if (libChanged) tx.write('library', lib);
    },
    { message: 'feeds: check queue feeds' },
  );
  for (const n of notes) ctx.log('feeds', n.level, n.message);
  result.feedItems = added;
}

// ---------------------------------------------------------------------------
// Linked media downloads

/**
 * Assets waiting for a download whose retry delay has passed, most urgent first (used by the
 * soonest scheduled post, then oldest). Exported for tests.
 */
export function pendingDownloads(library, posts, nowMs) {
  const soonest = new Map();
  for (const p of posts || []) {
    if (!['scheduled', 'draft', 'publishing', 'reminded'].includes(p.status)) continue;
    const t = Date.parse(p.scheduledAt || '');
    const at = Number.isFinite(t) ? t : Infinity;
    for (const id of [...(p.media || []).map((m) => m && m.assetId), p.coverAssetId]) if (id && !(soonest.get(id) <= at)) soonest.set(id, at);
  }
  return (library.assets || [])
    .filter((a) => a.importUrl && !a.importError)
    .filter((a) => {
      const tried = Date.parse(a.importTriedAt || '');
      const tries = a.importAttempts || 0;
      return !tries || !Number.isFinite(tried) || nowMs - tried >= DOWNLOAD_RETRY_BASE_MS * 2 ** (tries - 1);
    })
    .sort((a, b) => (soonest.get(a.id) ?? Infinity) - (soonest.get(b.id) ?? Infinity) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Assets that only feed posts use: queue items (always feed posts, carousels or reels) and upcoming
 * feed and carousel posts, unless a story uses them too. Their photos must fit the feed's 4:5 to
 * 1.91:1 range. Exported for tests.
 */
export function feedOnlyAssets(listsDoc, posts) {
  const feed = new Set();
  const story = new Set();
  for (const l of (listsDoc && listsDoc.lists) || []) for (const it of l.items || []) for (const m of (it && it.media) || []) if (m && m.assetId) feed.add(m.assetId);
  for (const p of posts || []) {
    if (p.status === 'canceled' || p.status === 'published') continue;
    const target = p.type === 'story' ? story : p.type === 'feed' || p.type === 'carousel' ? feed : null;
    if (target) for (const m of p.media || []) if (m && m.assetId) target.add(m.assetId);
  }
  for (const id of story) feed.delete(id);
  return feed;
}

/** Why a photo of w x h cannot go in the feed (for importError). */
function shapeMessage(w, h) {
  const side = w / h > LIMITS.feedAspectMax ? 'wider' : 'taller';
  return `The photo is ${w}x${h}, ${side} than Instagram allows in the feed (between 4:5 and 1.91:1). Pick another photo, or download this one and crop it when you add it in the Composer.`;
}

/**
 * Download and check one linked file. Returns {bytes, kind, mime, width, height, durationSec, url,
 * fromPage (true when the link was a web page and its og:image was downloaded)}.
 * `feedOnly`: the photo will only be posted to the feed, so its shape must fit (see fitsFeed).
 * `deadline`: see fetchCapped.
 * @throws {FetchError} (transient: try again on a later run)
 */
export async function downloadMedia(fetchImpl, url, { followPage = true, feedOnly = false, deadline = Infinity } = {}) {
  const res = await fetchCapped(fetchImpl, url, {
    maxBytes: LIMITS.videoMaxBytes,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    accept: 'image/jpeg,image/*;q=0.9,video/mp4,video/*;q=0.8,*/*;q=0.5',
    tooBig: (n) => `The file is ${mb(n)}. Videos can be at most ${mb(LIMITS.videoMaxBytes)} and photos ${mb(LIMITS.imageMaxBytes)}.`,
    deadline,
  });
  let bytes = res.bytes;
  const type = sniffMedia(bytes);
  if (type.format === 'html') {
    const og = followPage ? ogImage(decodeText(bytes, res.contentType), res.url) : '';
    if (og) return { ...(await downloadMedia(fetchImpl, og, { followPage: false, feedOnly, deadline })), fromPage: true };
    throw new FetchError('The link opens a web page, not a photo or video. Use the direct link to the image or video file.', { code: 'not_media' });
  }
  if (type.format === 'jpeg') {
    const info = jpegInfo(bytes);
    if (!info) throw new FetchError('The photo could not be read (damaged or unusual JPEG). Upload it in the Library instead.', { code: 'bad_jpeg' });
    if (info.orientation !== 1) {
      throw new FetchError('The photo is stored sideways with a rotation tag, which Instagram may ignore. Download it and upload it in the Library, which turns it upright.', { code: 'rotated' });
    }
    // Instagram refuses feed photos outside 4:5 to 1.91:1 at publish time (2207009, research_1.md).
    if (feedOnly && !fitsFeed(info.width, info.height)) throw new FetchError(shapeMessage(info.width, info.height), { code: 'shape' });
    // Metadata and whatever follows the image (a phone's motion-photo video, secondary images) go
    // before the size check: what is stored and posted is what has to fit.
    bytes = stripJpegMetadata(bytes);
    if (bytes.length > LIMITS.imageMaxBytes) throw new FetchError(`The photo is ${mb(bytes.length)}. Instagram accepts photos up to ${mb(LIMITS.imageMaxBytes)}. Make it smaller and upload it in the Library.`, { code: 'too_big' });
    return { bytes, kind: 'image', mime: 'image/jpeg', width: info.width, height: info.height, durationSec: null, url: res.url, fromPage: false };
  }
  if (type.kind === 'image') {
    throw new FetchError(
      `This is a ${FORMAT_NAMES[type.format] || type.format} image. Instagram only takes JPEG photos and the worker cannot convert images. Download the file and upload it in the Library, which converts it to JPEG.`,
      { code: 'not_jpeg' },
    );
  }
  if (type.kind === 'video') {
    stripMp4Metadata(bytes); // in place: GPS and device boxes are zeroed and renamed 'free'
    const info = mp4Info(bytes);
    return { bytes, kind: 'video', mime: type.mime, width: info.width || 0, height: info.height || 0, durationSec: info.durationSec, url: res.url, fromPage: false };
  }
  throw new FetchError('The link does not point to a JPEG photo or an MP4/MOV video.', { code: 'not_media' });
}

/** Download pending linked files (until `until`, no request past `deadline`). Exported for tests. */
export async function runDownloads(ctx, result, { until = Infinity, deadline = Infinity } = {}) {
  const [library, postsDoc, listsDoc] = [await ctx.store.read('library'), await ctx.store.read('posts'), await ctx.store.read('lists')];
  const queue = pendingDownloads(library, postsDoc.posts, ctx.nowMs()).slice(0, DOWNLOADS_PER_RUN);
  if (!queue.length) return;
  const feedOnly = feedOnlyAssets(listsDoc, postsDoc.posts);
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const items = batch;
    batch = [];
    batchBytes = 0;
    await saveDownloads(ctx, items, result);
  };
  for (const a of queue) {
    if (Date.now() >= until) break;
    try {
      const file = await downloadMedia(fetchOf(ctx), a.importUrl, { feedOnly: feedOnly.has(a.id), deadline });
      batch.push({ id: a.id, url: a.importUrl, name: a.name, ok: true, file });
      batchBytes += file.bytes.length;
    } catch (err) {
      if (err instanceof FetchError && err.code === 'deadline') break; // not a try: the next run downloads it
      const fe = err instanceof FetchError ? err : new FetchError(describeError(err), { transient: false });
      batch.push({ id: a.id, url: a.importUrl, name: a.name, ok: false, message: fe.message, transient: fe.transient, code: fe.code || 'error' });
    }
    if (batchBytes >= FLUSH_BYTES) await flush();
  }
  await flush();
}

async function saveDownloads(ctx, items, result) {
  let outcome = [];
  await ctx.store.transact(
    async (tx) => {
      outcome = [];
      const lib = await tx.read('library');
      const nowIso = ctx.nowIso();
      for (const it of items) {
        const a = (lib.assets || []).find((x) => x.id === it.id);
        // Deleted, given another link or already failed meanwhile: nothing to do.
        if (!a || a.importUrl !== it.url || a.importError) continue;
        if (it.ok) {
          const f = it.file;
          a.path = a.path || `media/${a.id}`;
          tx.writeBytes(a.path, f.bytes);
          a.thumbPath = a.path; // no separate thumbnail for downloaded files
          // sourceUrl stays the link the owner gave (a re-import of the same link finds this file).
          Object.assign(a, { kind: f.kind, mime: f.mime, bytes: f.bytes.length, width: f.width || 0, height: f.height || 0, durationSec: f.durationSec ?? null, sourceUrl: it.url });
          // A web page's link named the file after the page ("kiln-opening.html"): use the image's name.
          if (f.fromPage && a.name === nameFromUrl(it.url)) a.name = nameFromUrl(f.url);
          for (const k of ['importUrl', 'importError', 'importErrorCode', 'importLastError', 'importAttempts', 'importTriedAt']) delete a[k];
          outcome.push({ it, state: 'done' });
          continue;
        }
        const tries = (a.importAttempts || 0) + 1;
        a.importTriedAt = nowIso;
        if (it.transient && tries < MAX_DOWNLOAD_TRIES) {
          a.importAttempts = tries;
          a.importLastError = it.message; // shown while the file waits for the next try
          outcome.push({ it, state: 'retry', tries });
        } else {
          a.importError = it.transient ? `${it.message} Tried ${tries} times.` : it.message;
          a.importErrorCode = it.transient ? 'tries' : it.code;
          delete a.importAttempts;
          delete a.importLastError;
          outcome.push({ it, state: 'failed' });
        }
      }
      if (outcome.length) tx.write('library', lib);
    },
    { message: 'feeds: linked media downloads' },
  );
  for (const o of outcome) {
    const name = `"${clip(o.it.name || 'a file', 60)}"`;
    if (o.state === 'done') {
      result.downloaded = (result.downloaded || 0) + 1;
      ctx.log('feeds', 'info', `Downloaded ${name} from its link.`, { assetId: o.it.id });
    } else if (o.state === 'retry') {
      result.downloadRetries = (result.downloadRetries || 0) + 1;
      ctx.log('feeds', 'info', `Could not download ${name} yet (try ${o.tries} of ${MAX_DOWNLOAD_TRIES}): ${o.it.message}`, { assetId: o.it.id });
    } else {
      result.downloadFailed = (result.downloadFailed || 0) + 1;
      ctx.log('feeds', 'warn', `Could not download ${name}: ${o.it.message}`, { assetId: o.it.id });
    }
  }
}

// ---------------------------------------------------------------------------

/** Time this run has left for the job (ms, run clock): RUN_DEADLINE_MS from the run's start. Exported for tests. */
export function runTimeLeft(ctx) {
  return Number.isFinite(ctx.startedAtMs) ? ctx.startedAtMs + RUN_DEADLINE_MS - ctx.nowMs() : Infinity;
}

export default async function feeds(ctx) {
  const startedAt = Date.now();
  const left = runTimeLeft(ctx);
  const listsDoc = await ctx.store.read('lists');
  const library = await ctx.store.read('library');
  const due = dueFeeds(listsDoc, ctx.nowMs(), brokenAssetIds(library.assets));
  const waiting = (library.assets || []).some((a) => a.importUrl && !a.importError);
  if (!due.length && !waiting) return { skipped: 'nothing_due' };
  // Publishing used most of the run: leave feeds and downloads to the next run.
  if (left < MIN_TIME_LEFT_MS) return { skipped: 'no_time' };
  // Deadlines on the Date.now() clock (fetchCapped): the job's budgets, never past the run's deadline.
  const deadline = startedAt + left;
  const result = {};
  // Downloads (CSV links too) do not depend on the feeds: they run even when saving the feeds failed.
  let feedsError = null;
  if (due.length) {
    try {
      await runFeeds(ctx, due, result, { until: Math.min(startedAt + FEED_BUDGET_MS, deadline), deadline });
    } catch (err) {
      feedsError = err;
    }
  }
  await runDownloads(ctx, result, { until: Math.min(startedAt + JOB_BUDGET_MS, deadline), deadline });
  if (feedsError) throw feedsError;
  if (!Object.keys(result).length) return { skipped: 'nothing_due' }; // downloads waiting to be retried later
  // Public line: counts only, zero counts left out (feedItems always shown when feeds were checked).
  return Object.fromEntries(Object.entries(result).filter(([k, v]) => v || k === 'feedItems'));
}
