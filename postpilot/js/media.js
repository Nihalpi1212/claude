// Browser media pipeline: probe, crop/convert to JPEG, thumbnails, encrypted upload, object-URL cache.

import { LIMITS, newAsset } from '../core/model.js';
import { stripMp4Metadata } from '../core/mp4.js';
import { getStore, transact } from './data.js';

export const ASPECTS = {
  original: null,
  square: 1,
  portrait: 4 / 5,
  landscape: 1.91,
  story: 9 / 16,
};

export const ASPECT_LABELS = {
  original: 'Original',
  square: 'Square 1:1',
  portrait: 'Portrait 4:5',
  landscape: 'Landscape 1.91:1',
  story: 'Story 9:16',
};

const MAX_IMAGE_SIDE = 1440;
const THUMB_SIDE = 480;

export function isVideoFile(file) {
  return /^video\//.test(file.type) || /\.(mp4|mov|m4v)$/i.test(file.name || '');
}

export function isImageFile(file) {
  return /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif|avif)$/i.test(file.name || '');
}

/** Decode an image file into an ImageBitmap (falls back to <img>). */
export async function loadBitmap(blob) {
  if ('createImageBitmap' in globalThis) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fall through (e.g. HEIC on some browsers) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('This image format cannot be opened in your browser. Convert it to JPEG or PNG first.');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function dims(src) {
  return { w: src.naturalWidth || src.videoWidth || src.width, h: src.naturalHeight || src.videoHeight || src.height };
}

/**
 * Compute the crop rectangle for a target aspect ratio.
 * focus: {x, y} in 0..1 (center of interest), zoom >= 1.
 */
export function cropRect(w, h, aspect, focus = { x: 0.5, y: 0.5 }, zoom = 1) {
  let cw = w;
  let ch = h;
  if (aspect) {
    if (w / h > aspect) cw = h * aspect;
    else ch = w / aspect;
  }
  cw /= zoom;
  ch /= zoom;
  const x = Math.min(Math.max(focus.x * w - cw / 2, 0), w - cw);
  const y = Math.min(Math.max(focus.y * h - ch / 2, 0), h - ch);
  return { x, y, w: cw, h: ch };
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), 'image/jpeg', quality),
  );
}

/**
 * Render (crop + scale) an image source to a JPEG blob.
 * opts: { aspect, focus, zoom, maxSide, quality, background }
 */
export async function renderJpeg(src, { aspect = null, focus, zoom = 1, maxSide = MAX_IMAGE_SIDE, quality = 0.9, background = '#ffffff' } = {}) {
  const { w, h } = dims(src);
  const r = cropRect(w, h, aspect, focus, zoom);
  const scale = Math.min(1, maxSide / Math.max(r.w, r.h));
  const outW = Math.max(1, Math.round(r.w * scale));
  const outH = Math.max(1, Math.round(r.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const g = canvas.getContext('2d');
  g.fillStyle = background; // JPEG has no alpha: flatten transparent PNGs onto white
  g.fillRect(0, 0, outW, outH);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, outW, outH);
  const blob = await canvasToBlob(canvas, quality);
  return { blob, width: outW, height: outH };
}

/** Probe a video file: { width, height, durationSec, posterBlob } */
export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This video cannot be read in your browser. Use an MP4 (H.264) or MOV file.'));
    };
    video.onerror = fail;
    video.onloadedmetadata = () => {
      const durationSec = Number.isFinite(video.duration) ? video.duration : null;
      video.currentTime = Math.min(1, (durationSec || 1) / 3);
    };
    video.onseeked = async () => {
      try {
        const { blob } = await renderJpeg(video, { maxSide: THUMB_SIDE, quality: 0.8 });
        resolve({ width: video.videoWidth, height: video.videoHeight, durationSec: video.duration, posterBlob: blob });
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
  });
}

/** Grab a frame of a video at timeMs as a JPEG blob (for reel covers). */
export function videoFrame(blob, timeMs, maxSide = MAX_IMAGE_SIDE) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    video.onerror = () => (URL.revokeObjectURL(url), reject(new Error('Could not read the video.')));
    video.onloadedmetadata = () => (video.currentTime = Math.min(video.duration || 0, Math.max(0, timeMs / 1000)));
    video.onseeked = async () => {
      try {
        resolve(await renderJpeg(video, { maxSide }));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
  });
}

export async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function blobToBase64(blob) {
  const bytes = await blobBytes(blob);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Prepare a File for upload. Images are converted to JPEG (cropped when aspect is given),
 * videos are kept as-is. Returns { kind, blob, thumbBlob, width, height, durationSec, mime, name }.
 */
export async function prepareFile(file, { aspect = null, focus, zoom } = {}) {
  if (isVideoFile(file)) {
    if (file.size > LIMITS.videoMaxBytes) {
      throw new Error(`"${file.name}" is ${(file.size / 1048576).toFixed(0)} MB. Videos must be under ${LIMITS.videoMaxBytes / 1048576} MB to store on GitHub. Compress it first.`);
    }
    const meta = await probeVideo(file);
    // Drop GPS/device metadata boxes before the file is stored (and, at publish time, made public).
    const bytes = new Uint8Array(await file.arrayBuffer());
    stripMp4Metadata(bytes);
    return {
      kind: 'video',
      blob: new Blob([bytes], { type: file.type || 'video/mp4' }),
      thumbBlob: meta.posterBlob,
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
      mime: file.type || 'video/mp4',
      name: file.name,
    };
  }
  if (!isImageFile(file)) throw new Error(`"${file.name}" is not a photo or video.`);
  const bmp = await loadBitmap(file);
  const main = await renderJpeg(bmp, { aspect, focus, zoom });
  if (main.blob.size > LIMITS.imageMaxBytes) {
    const again = await renderJpeg(bmp, { aspect, focus, zoom, quality: 0.78 });
    Object.assign(main, again);
  }
  const thumb = await renderJpeg(bmp, { aspect, focus, zoom, maxSide: THUMB_SIDE, quality: 0.8 });
  if (bmp.close) bmp.close();
  return { kind: 'image', blob: main.blob, thumbBlob: thumb.blob, width: main.width, height: main.height, durationSec: null, mime: 'image/jpeg', name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}

/**
 * Upload prepared media as one encrypted commit and register it in the library.
 * Returns the new Asset.
 */
export async function uploadPrepared(prepared, { folderId = null, tags = [], autopilot = false, captionHint = '', notes = '' } = {}) {
  const asset = newAsset({
    kind: prepared.kind,
    name: prepared.name,
    mime: prepared.mime,
    bytes: prepared.blob.size,
    width: prepared.width,
    height: prepared.height,
    durationSec: prepared.durationSec,
    folderId,
    tags,
    autopilot,
    captionHint,
    notes,
  });
  const [bytes, thumb] = [await blobBytes(prepared.blob), await blobBytes(prepared.thumbBlob)];
  await transact(
    async (tx) => {
      tx.writeBytes(asset.path, bytes);
      tx.writeBytes(asset.thumbPath, thumb);
      const lib = await tx.read('library');
      if (!lib.assets.some((a) => a.id === asset.id)) lib.assets.unshift(asset);
      tx.write('library', lib);
    },
    { message: `upload ${asset.kind}` },
  );
  primeUrl(asset.thumbPath, prepared.thumbBlob);
  primeUrl(asset.path, prepared.blob);
  return asset;
}

/** Convenience: prepare + upload many files, reporting progress. */
export async function uploadFiles(files, opts = {}, onProgress = () => {}) {
  const out = [];
  let i = 0;
  for (const file of files) {
    onProgress({ index: i, total: files.length, name: file.name, phase: 'processing' });
    const prepared = await prepareFile(file, opts);
    onProgress({ index: i, total: files.length, name: file.name, phase: 'uploading' });
    out.push(await uploadPrepared(prepared, opts));
    i++;
  }
  onProgress({ index: files.length, total: files.length, phase: 'done' });
  return out;
}

/**
 * Statuses of posts that may still publish, so their media must stay ('failed' posts can be retried;
 * 'reminded' posts wait for the owner to save the files and post them by hand).
 */
const LIVE_POST_STATUSES = ['scheduled', 'publishing', 'draft', 'failed', 'reminded'];

/** Ids of assets that posts which may still publish, or queue items, use. */
export function assetsInUse(posts, lists) {
  const ids = new Set();
  for (const p of (posts && posts.posts) || []) {
    if (!LIVE_POST_STATUSES.includes(p.status)) continue;
    for (const m of p.media || []) ids.add(m.assetId);
    if (p.coverAssetId) ids.add(p.coverAssetId);
  }
  for (const l of (lists && lists.lists) || []) for (const it of l.items || []) for (const m of it.media || []) ids.add(m.assetId);
  return ids;
}

/** Remove assets (and their files) from the library. Keeps assets that scheduled, draft or failed posts or a queue still use. */
export async function deleteAssets(ids) {
  return transact(
    async (tx) => {
      const lib = await tx.read('library');
      const blocked = assetsInUse(await tx.read('posts'), await tx.read('lists'));
      const removed = [];
      lib.assets = lib.assets.filter((a) => {
        if (!ids.includes(a.id)) return true;
        if (blocked.has(a.id)) return true;
        tx.delete(a.path);
        tx.delete(a.thumbPath);
        removed.push(a.id);
        return false;
      });
      tx.write('library', lib);
      return { removed, kept: ids.filter((id) => !removed.includes(id)) };
    },
    { message: 'delete media' },
  );
}

// ---- Object URL cache (decrypted media) ----
//
// Every cached URL keeps a decrypted Blob alive, so the cache is bounded: thumbnails by count, originals
// (up to ~95 MB each) by count and total size. Least recently used URLs are revoked first, but never
// while an element on the page still shows them. Reads run a few at a time, so a big contact sheet
// does not fire one GitHub request per asset at once.

const READ_CONCURRENCY = 4;
const MAX_THUMB_URLS = 300;
const MAX_ORIGINAL_URLS = 20;
const MAX_ORIGINAL_BYTES = 200 * 1024 * 1024;

const urlCache = new Map(); // path -> { promise: Promise<string>, url, size, original }, least recently used first
const revokeListeners = new Set();
let reading = 0;
const readQueue = [];
let trimTimer = null;

/** Run a media read when fewer than READ_CONCURRENCY are in flight. */
function limited(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      reading++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          reading--;
          if (readQueue.length) readQueue.shift()();
        });
    };
    if (reading < READ_CONCURRENCY) start();
    else readQueue.push(start);
  });
}

const isOriginal = (path) => !path.endsWith('.thumb');

function cacheUrl(entry, blob) {
  entry.url = URL.createObjectURL(blob);
  entry.size = blob.size;
  if (!trimTimer) trimTimer = setTimeout(trimMediaUrls, 1000);
  return entry.url;
}

function primeUrl(path, blob) {
  const entry = { url: null, size: 0, original: isOriginal(path) };
  entry.promise = Promise.resolve(cacheUrl(entry, blob));
  urlCache.delete(path);
  urlCache.set(path, entry);
}

/** Called with (path, url) whenever a cached object URL is revoked, so other caches can drop it. */
export function onMediaUrlRevoked(fn) {
  revokeListeners.add(fn);
  return () => revokeListeners.delete(fn);
}

/** Object URLs that elements on the page currently show (src, poster or href). */
function urlsInUse() {
  const used = new Set();
  const doc = globalThis.document;
  if (!doc || !doc.querySelectorAll) return used;
  for (const el of doc.querySelectorAll('[src^="blob:"], [poster^="blob:"], [href^="blob:"]')) {
    for (const attr of ['src', 'poster', 'href']) {
      const v = el.getAttribute(attr);
      if (v) used.add(v);
    }
  }
  return used;
}

/** Revoke least recently used object URLs beyond the cache limits, skipping any still on the page. */
export function trimMediaUrls() {
  clearTimeout(trimTimer);
  trimTimer = null;
  let thumbs = 0;
  let originals = 0;
  let originalBytes = 0;
  for (const e of urlCache.values()) {
    if (!e.url) continue;
    if (e.original) {
      originals++;
      originalBytes += e.size;
    } else thumbs++;
  }
  const over = (e) => (e.original ? originals > MAX_ORIGINAL_URLS || originalBytes > MAX_ORIGINAL_BYTES : thumbs > MAX_THUMB_URLS);
  if (![...urlCache.values()].some((e) => e.url && over(e))) return;
  const used = urlsInUse();
  for (const [path, e] of urlCache) {
    if (!e.url || !over(e) || used.has(e.url)) continue;
    urlCache.delete(path);
    URL.revokeObjectURL(e.url);
    if (e.original) {
      originals--;
      originalBytes -= e.size;
    } else thumbs--;
    for (const fn of revokeListeners) fn(path, e.url);
  }
}

/** Object URL for an encrypted file (thumbnail or original). */
export function mediaUrl(path, mime = 'image/jpeg') {
  const hit = urlCache.get(path);
  if (hit) {
    urlCache.delete(path); // mark as recently used
    urlCache.set(path, hit);
    return hit.promise;
  }
  const entry = { url: null, size: 0, original: isOriginal(path) };
  entry.promise = limited(() => getStore().readBytes(path)).then((bytes) => {
    if (!bytes) throw new Error('Media file is missing.');
    return cacheUrl(entry, new Blob([bytes], { type: mime }));
  });
  entry.promise.catch(() => urlCache.get(path) === entry && urlCache.delete(path));
  urlCache.set(path, entry);
  return entry.promise;
}

/**
 * 'pending' while the worker still has to download the file from its link (asset.importUrl),
 * 'failed' when that download failed (importError), else null. Such assets have no bytes yet.
 */
export function importState(asset) {
  if (!asset || !asset.importUrl) return null;
  return asset.importError ? 'failed' : 'pending';
}

/**
 * True when the asset has a thumbnail image to show. Files downloaded by the worker double as their
 * own thumbnail (thumbPath === path): fine for photos, but a video has no picture then.
 */
export function hasThumb(asset) {
  if (!asset || importState(asset)) return false;
  if (asset.thumbPath !== asset.path) return true;
  // Its own thumbnail: none for a video, and gone once "Free up space" removed the original.
  return asset.kind !== 'video' && !asset.originalRemovedAt;
}

const NO_FILE = (what) => Promise.reject(new Error(what));

export function thumbUrl(asset) {
  if (importState(asset)) return NO_FILE('This file is still being downloaded from its link.');
  if (!hasThumb(asset)) return NO_FILE('This video has no thumbnail.');
  return mediaUrl(asset.thumbPath, 'image/jpeg');
}

export function originalUrl(asset) {
  if (importState(asset)) return NO_FILE('This file is still being downloaded from its link.');
  return mediaUrl(asset.path, asset.mime || (asset.kind === 'video' ? 'video/mp4' : 'image/jpeg'));
}

/** Read a thumbnail as base64 (for AI captioning); null when there is none (or it is too large for Claude). */
export async function thumbBase64(asset) {
  if (!hasThumb(asset) || (asset.thumbPath === asset.path && asset.bytes > 3.5 * 1024 * 1024)) return null;
  const bytes = await getStore().readBytes(asset.thumbPath);
  if (!bytes) return null;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Download a Blob as a file (works on GitHub Pages). */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
