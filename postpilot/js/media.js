// Browser media pipeline: probe, crop/convert to JPEG, thumbnails, encrypted upload, object-URL cache.

import { LIMITS, newAsset } from '../core/model.js';
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
    return {
      kind: 'video',
      blob: file,
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

/** Remove assets (and their files) from the library. Refuses assets used by scheduled posts. */
export async function deleteAssets(ids) {
  return transact(
    async (tx) => {
      const lib = await tx.read('library');
      const posts = await tx.read('posts');
      const blocked = new Set(
        posts.posts
          .filter((p) => ['scheduled', 'publishing', 'draft'].includes(p.status))
          .flatMap((p) => p.media.map((m) => m.assetId).concat(p.coverAssetId ? [p.coverAssetId] : [])),
      );
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

const urlCache = new Map(); // path -> Promise<string>

function primeUrl(path, blob) {
  urlCache.set(path, Promise.resolve(URL.createObjectURL(blob)));
}

/** Object URL for an encrypted file (thumbnail or original). */
export function mediaUrl(path, mime = 'image/jpeg') {
  if (!urlCache.has(path)) {
    const p = getStore()
      .readBytes(path)
      .then((bytes) => {
        if (!bytes) throw new Error('Media file is missing.');
        return URL.createObjectURL(new Blob([bytes], { type: mime }));
      });
    p.catch(() => urlCache.delete(path));
    urlCache.set(path, p);
  }
  return urlCache.get(path);
}

export function thumbUrl(asset) {
  return mediaUrl(asset.thumbPath, 'image/jpeg');
}

export function originalUrl(asset) {
  return mediaUrl(asset.path, asset.mime || (asset.kind === 'video' ? 'video/mp4' : 'image/jpeg'));
}

/** Read a thumbnail as base64 (for AI captioning). */
export async function thumbBase64(asset) {
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
