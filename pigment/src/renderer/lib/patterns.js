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

// ---- the pattern library (ARCHITECTURE.md "0.4 features", L.6; E16) -------------------------------------------------
// app.patterns: the patterns Edit > Define Pattern made and the current one. Stub by the skeleton: 0.3 behaviour (the
// patterns defined in this session, in memory, the last one current; 0.3 kept the last 24). Owned by patterns, which
// replaces it with a library backed by the preset store and keeps installPatterns and this API:
//   current() -> { id, name, canvas, width, height } | null;  setCurrent(id);  define(canvas, { name }) -> Promise<entry>
//   list() -> entry[];  get(id) -> Promise<entry | null>;  ref(entry) -> PatternRef { dataUrl, presetId, name }
//   resolve(ref | dataUrl) -> ImageData | null (the embedded pixels; null while a data URL decodes)
// A PatternRef stored in layer data always carries dataUrl: the pixels survive a deleted preset, another machine,
// Copy / Paste Layer Style, actions and .pigment.

const KEEP = 24;

export function installPatterns(app) {
  const entries = [];
  let currentId = null;
  let counter = 0;
  const changed = (reason) => app.emit?.('patterns:changed', { reason });
  app.patterns = {
    current() {
      return entries.find((e) => e.id === currentId) ?? null;
    },
    setCurrent(id) {
      if (!entries.some((e) => e.id === id) || id === currentId) return;
      currentId = id;
      changed('current');
    },
    // async in the API (the library writes the preset store); the stub finishes synchronously, so the pattern is
    // current as soon as Define Pattern returns
    async define(canvas, { name } = {}) {
      const entry = { id: `pat-${Date.now().toString(36)}-${++counter}`, name: name || `Pattern ${counter}`, canvas, width: canvas.width, height: canvas.height };
      entries.push(entry);
      if (entries.length > KEEP) entries.splice(0, entries.length - KEEP);
      currentId = entry.id;
      changed('define');
      return entry;
    },
    list() {
      return entries.slice();
    },
    async get(id) {
      return entries.find((e) => e.id === id) ?? null;
    },
    ref(entry) {
      if (!entry?.canvas) return null;
      entry.dataUrl ??= patternFromCanvas(entry.canvas);
      return { dataUrl: entry.dataUrl, presetId: entry.id, name: entry.name };
    },
    resolve(ref) {
      return resolvePattern(typeof ref === 'string' ? ref : ref?.dataUrl ?? null);
    },
  };
  return app.patterns;
}
