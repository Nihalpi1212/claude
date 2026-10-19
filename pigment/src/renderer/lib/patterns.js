// Patterns used by layer styles are stored as PNG data URLs (so styles stay plain JSON: they are
// copied, pasted, undone and saved like any other setting); decoded pixels are cached here.
import { createCanvas } from './document.js';

const cache = new Map(); // dataUrl -> ImageData | 'pending'
const waiters = new Map(); // dataUrl -> Set of callbacks to run once decoded

function imageDataOf(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

/** Registers a canvas as a pattern and returns its data URL key. */
export function patternFromCanvas(canvas) {
  const url = canvas.toDataURL('image/png');
  cache.set(url, imageDataOf(canvas));
  return url;
}

/** Pixels for a pattern key, or null while it decodes (onReady fires once it is available). */
export function resolvePattern(url, onReady) {
  if (!url || typeof url !== 'string') return null;
  const v = cache.get(url);
  if (v && v !== 'pending') return v;
  if (onReady) {
    if (!waiters.has(url)) waiters.set(url, new Set());
    waiters.get(url).add(onReady);
  }
  if (!v) {
    cache.set(url, 'pending');
    const img = new Image();
    img.onload = () => {
      const c = createCanvas(img.naturalWidth || 1, img.naturalHeight || 1);
      c.getContext('2d').drawImage(img, 0, 0);
      cache.set(url, imageDataOf(c));
      const list = waiters.get(url);
      waiters.delete(url);
      for (const fn of list ?? []) fn();
    };
    img.onerror = () => {
      cache.delete(url);
      waiters.delete(url);
    };
    img.src = url;
  }
  return null;
}

/** Canvas preview of a pattern key (for swatches). */
export function patternCanvas(url, size = 32) {
  const data = resolvePattern(url);
  const c = createCanvas(size, size);
  if (!data) return c;
  const src = createCanvas(data.width, data.height);
  src.getContext('2d').putImageData(data, 0, 0);
  const ctx = c.getContext('2d');
  ctx.fillStyle = ctx.createPattern(src, 'repeat');
  ctx.fillRect(0, 0, size, size);
  return c;
}
