// The pattern library behind app.patterns (patterns package; ARCHITECTURE.md "0.4 features", L.6, E16) and the
// pixel cache of pattern data URLs.
//
// Data URLs. A pattern stored in layer data (a style's pattern overlay, the Bevel texture, stroke and shape pattern
// fills, a recorded Fill) is a PatternRef { dataUrl, presetId?, name? } whose dataUrl holds the pixels as a PNG, so
// styles stay plain JSON (copied, pasted, undone, saved like any other value) and a ref survives a deleted preset,
// another machine and .pigment files. 0.3 stored the bare data URL string; both are read. Decoded pixels are cached
// here (resolvePattern), keyed by the data URL.
//
// The library. app.patterns lists the presets of the `patterns` kind (lib/presets.js, C): the built-ins of
// lib/pattern-builtins.js and the patterns the user defined or imported, whose pixels are PNG side files of the
// preset store (<userData>/presets/patterns/<blob>, IndexedDB in the browser build), so they persist across restarts.
// The current pattern's preset id is settings.patterns.current (J.7); without one, the first pattern of the library
// is current, as Photoshop always has one.
//
//   app.patterns.current() -> entry | null        entry: { id, name, group, width, height, canvas, builtin }
//   app.patterns.setCurrent(id)                   app.patterns.define(canvas, { name }) -> Promise<entry>
//   app.patterns.list() -> entry[]                app.patterns.get(id) -> Promise<entry | null>
//   app.patterns.ref(entry) -> PatternRef         app.patterns.resolve(ref | dataUrl, onReady?) -> ImageData | null
//   extras: ready() -> Promise, remove(ids), rename(id, name), refFor(id) -> Promise<PatternRef | null>,
//           canvasOf(ref) -> Promise<HTMLCanvasElement | null>
//
// list() is synchronous: an entry's `canvas` is null until its pixels have loaded (get() waits for them), and
// current() answers null until the current pattern has loaded (a moment after start). Every change emits
// 'patterns:changed' { reason: 'load' | 'define' | 'current' | 'presets', ids? } on app.
import { createCanvas } from './document.js';
import { registerPresetKind, registerPresetFormat, presetFormats } from './presets.js';
import { patternBuiltins, builtinPattern } from './pattern-builtins.js';

export const PATTERN_KIND = 'patterns';
/** The in-app drag type of a pattern (a PatternRef as JSON, L.9). */
export const PATTERN_MIME = 'application/x-pigment-pattern';

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
      const list = waiters.get(url);
      waiters.delete(url);
      // a broken data URL settles its waiters too (they read null again)
      for (const fn of list ?? []) fn();
    };
    img.src = url;
  }
  return null;
}

/** The pixels of a pattern key once decoded: Promise<ImageData | null>. */
export function decodePattern(url) {
  if (!url || typeof url !== 'string') return Promise.resolve(null);
  const now = resolvePattern(url);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    resolvePattern(url, () => resolve(resolvePattern(url)));
  });
}

/** A canvas holding ImageData-like pixels. */
export function canvasFromPixels(data) {
  const c = createCanvas(data.width, data.height);
  const ctx = c.getContext('2d');
  if (data instanceof ImageData) ctx.putImageData(data, 0, 0);
  else {
    const img = ctx.createImageData(data.width, data.height);
    img.data.set(data.data);
    ctx.putImageData(img, 0, 0);
  }
  return c;
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

/** A tiled thumbnail of a pattern canvas: whole tiles when they fit, else the tile scaled down to the swatch. */
export function patternThumbnail(canvas, size = 32, height = size) {
  const c = createCanvas(size, height);
  if (!canvas) return c;
  const ctx = c.getContext('2d');
  const k = Math.min(1, size / canvas.width, height / canvas.height) < 0.25 ? Math.min(size / canvas.width, height / canvas.height) : 1;
  if (k === 1) {
    const p = ctx.createPattern(canvas, 'repeat');
    if (p) {
      ctx.fillStyle = p;
      ctx.fillRect(0, 0, size, height);
    }
  } else {
    ctx.imageSmoothingQuality = 'high';
    const w = canvas.width * k, h = canvas.height * k;
    ctx.drawImage(canvas, (size - w) / 2, (height - h) / 2, w, h);
  }
  return c;
}

const toPngBytes = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob(async (b) => {
    if (!b) return reject(new Error('Could not encode the pattern as PNG'));
    resolve(new Uint8Array(await b.arrayBuffer()));
  }, 'image/png');
});

async function decodeBytes(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const c = createCanvas(bitmap.width, bitmap.height);
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return c;
}

const randomName = () => `p-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const size = (v) => (Number.isFinite(v) && v >= 1 ? Math.round(v) : null);

/** Normalises a `patterns` preset's data: { width, height, blob | builtin, mode }, or null. */
export function normalizePatternData(data) {
  if (!isObject(data)) return null;
  const width = size(data.width), height = size(data.height);
  if (!width || !height) return null;
  if (typeof data.blob === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(data.blob)) return { width, height, blob: data.blob, mode: data.mode ?? 'rgb' };
  if (typeof data.builtin === 'string') return { width, height, builtin: data.builtin, mode: 'rgb' };
  return null;
}

let kindRegistered = false;
/** Registers the `patterns` preset kind with its built-ins and the image file format (the later registration wins). */
export function registerPatternKind() {
  registerPresetKind(PATTERN_KIND, {
    title: 'Patterns',
    version: 1,
    builtins: patternBuiltins,
    normalize: (data) => normalizePatternData(data),
    blobs: (data) => (typeof data?.blob === 'string' ? [data.blob] : []),
  });
  if (kindRegistered) return;
  kindRegistered = true;
  // .pigment-presets files of patterns: the store's own format, except that imported pixel files get new names, so an
  // imported pattern never shares (and, deleted, takes away) the pixel file of one already in the library
  const base = () => presetFormats('*').find((f) => f.id === 'pigment-presets');
  registerPresetFormat(PATTERN_KIND, {
    id: 'pigment-presets',
    name: 'Pigment Presets',
    extensions: ['pigment-presets'],
    async read(bytes, info) {
      const res = await base().read(bytes, info);
      const renamed = new Map();
      const blobs = {};
      for (const [name, data] of Object.entries(res.blobs ?? {})) {
        const fresh = `${randomName()}.png`;
        renamed.set(name, fresh);
        blobs[fresh] = data;
      }
      const presets = (res.presets ?? []).map((p) => (renamed.has(p.data?.blob) ? { ...p, data: { ...p.data, blob: renamed.get(p.data.blob) } } : p));
      return { ...res, presets, blobs };
    },
    write: (presets, info) => base().write(presets, info),
  });
  // Import Patterns also takes image files: each picture becomes a pattern (Photoshop defines one from an open image)
  registerPresetFormat(PATTERN_KIND, {
    id: 'image',
    name: 'Images',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
    async read(bytes, { name = 'Pattern' } = {}) {
      const canvas = await decodeBytes(bytes);
      const blob = `${randomName()}.png`;
      return {
        presets: [{ name: String(name).replace(/\.[^.]+$/, '') || 'Pattern', data: { width: canvas.width, height: canvas.height, blob, mode: 'rgb' } }],
        blobs: { [blob]: await toPngBytes(canvas) },
        report: [],
      };
    },
  });
}

/**
 * Installs app.patterns. app.js start() calls this before MODULES, when the preset store does not exist yet: the
 * library attaches to it on first use (or when a module calls app.patterns.ready()).
 */
export function installPatterns(app) {
  const entries = new Map(); // preset id -> entry (the same object for as long as the preset keeps its pixels)
  let order = [];
  let memoryCurrent = null;
  let attached = null;
  const seeded = new Map(); // blob name -> canvas of a pattern defined in this session (no need to decode it again)
  const changed = (reason, ids) => app.emit?.('patterns:changed', { reason, ...(ids ? { ids } : {}) });

  const store = () => app.presets ?? null;
  const settingCurrent = () => app.settings?.patterns?.current ?? null;

  function load(entry, data) {
    entry.ready = (async () => {
      try {
        if (data.builtin) {
          const px = builtinPattern(data.builtin);
          entry.canvas = px ? canvasFromPixels(px) : null;
        } else if (seeded.has(data.blob)) {
          entry.canvas = seeded.get(data.blob);
        } else {
          const bytes = await store()?.readBlob(PATTERN_KIND, data.blob);
          entry.canvas = bytes?.length ? await decodeBytes(bytes) : null;
        }
      } catch (err) {
        console.warn(`pattern ${entry.name} could not be read`, err);
        entry.canvas = null;
      }
      entry.missing = !entry.canvas;
      if (entry.canvas) {
        entry.width = entry.canvas.width;
        entry.height = entry.canvas.height;
      }
      if (entries.get(entry.id) === entry) changed('load', [entry.id]);
      return entry;
    })();
  }

  /** Rebuilds the entries from the preset store (kept objects for presets whose pixels did not change). */
  function sync() {
    const s = store();
    if (!s) return;
    const list = s.list(PATTERN_KIND);
    const seen = new Set();
    order = [];
    for (const p of list) {
      const data = normalizePatternData(p.data);
      if (!data) continue;
      const key = data.builtin ? `b:${data.builtin}` : `f:${data.blob}`;
      let e = entries.get(p.id);
      if (!e || e.key !== key) {
        e = { id: p.id, key, name: p.name, group: p.group ?? null, width: data.width, height: data.height, canvas: null, builtin: !!p.builtin, missing: false, ready: null };
        entries.set(p.id, e);
        load(e, data);
      }
      e.name = p.name;
      e.group = p.group ?? null;
      e.builtin = !!p.builtin;
      seen.add(p.id);
      order.push(e);
    }
    for (const id of [...entries.keys()]) if (!seen.has(id)) entries.delete(id);
  }

  /** Attaches to the preset store once it exists: registers the kind, reads the user's file and loads the pixels. */
  function attach() {
    if (attached) return attached;
    const s = store();
    if (!s) return Promise.resolve();
    registerPatternKind();
    s.addEventListener('change', (e) => {
      if (e.detail?.kind !== PATTERN_KIND) return;
      sync();
      changed('presets', e.detail.ids);
    });
    sync();
    attached = s.ready(PATTERN_KIND).then(() => {
      sync();
      changed('presets');
    }).catch((err) => console.warn('patterns could not be read', err));
    return attached;
  }

  const currentId = () => {
    const wanted = memoryCurrent ?? settingCurrent();
    if (wanted && entries.has(wanted)) return wanted;
    return order.find((e) => !e.missing)?.id ?? null;
  };

  const api = {
    current() {
      attach();
      const e = entries.get(currentId());
      return e?.canvas ? e : null;
    },
    /** The id the library treats as current (its pixels may still be loading). */
    currentId() {
      attach();
      return currentId();
    },
    setCurrent(id) {
      attach();
      if (!entries.has(id) || id === currentId() && (memoryCurrent ?? settingCurrent()) === id) return;
      memoryCurrent = id;
      app.saveSettingsSoon?.({ patterns: { ...(app.settings?.patterns ?? {}), current: id } });
      changed('current', [id]);
    },
    async define(canvas, { name, group = null } = {}) {
      await attach();
      const s = store();
      const copy = createCanvas(canvas.width, canvas.height);
      copy.getContext('2d').drawImage(canvas, 0, 0);
      const blob = `${randomName()}.png`;
      seeded.set(blob, copy);
      if (!s) throw new Error('The preset store is not ready');
      await s.ready(PATTERN_KIND);
      try {
        await s.writeBlob(PATTERN_KIND, blob, await toPngBytes(copy));
      } catch (err) {
        // reported by the store (app.reportWriteFailure); the pattern stays usable for this session
        console.warn('the pattern pixels could not be saved', err);
      }
      const preset = s.add(PATTERN_KIND, { name: name || `Pattern ${order.length + 1}`, group, data: { width: copy.width, height: copy.height, blob, mode: 'rgb' } });
      sync();
      const entry = entries.get(preset.id);
      await entry?.ready;
      memoryCurrent = preset.id;
      app.saveSettingsSoon?.({ patterns: { ...(app.settings?.patterns ?? {}), current: preset.id } });
      changed('define', [preset.id]);
      return entry;
    },
    list() {
      attach();
      return order.slice();
    },
    async get(id) {
      await attach();
      const e = entries.get(id);
      if (!e) return null;
      await e.ready;
      return e;
    },
    ref(entry) {
      if (!entry?.canvas) return null;
      entry.dataUrl ??= patternFromCanvas(entry.canvas);
      return { dataUrl: entry.dataUrl, ...(entry.id ? { presetId: entry.id } : {}), ...(entry.name ? { name: entry.name } : {}) };
    },
    async refFor(id) {
      return api.ref(await api.get(id));
    },
    resolve(ref, onReady) {
      if (typeof ref === 'string') return resolvePattern(ref, onReady);
      if (ref?.dataUrl) return resolvePattern(ref.dataUrl, onReady);
      // a ref without pixels (not written by Pigment: stored refs always carry them) falls back to its preset
      const e = ref?.presetId ? entries.get(ref.presetId) : null;
      return e?.canvas ? imageDataOf(e.canvas) : null;
    },
    /** A canvas of a ref's pixels, once decoded. */
    async canvasOf(ref) {
      if (!ref) return null;
      const url = typeof ref === 'string' ? ref : ref.dataUrl;
      if (url) {
        const data = await decodePattern(url);
        return data ? canvasFromPixels(data) : null;
      }
      const e = ref.presetId ? await api.get(ref.presetId) : null;
      return e?.canvas ?? null;
    },
    ready() {
      return Promise.resolve(attach()).then(() => Promise.all(order.map((e) => e.ready))).then(() => undefined);
    },
    async remove(ids) {
      await attach();
      const s = store();
      const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => entries.has(id));
      if (!list.length) return;
      const blobs = list.map((id) => s.get(PATTERN_KIND, id)?.data?.blob).filter(Boolean);
      s.remove(PATTERN_KIND, list);
      if (list.includes(memoryCurrent)) memoryCurrent = null;
      // the pixels go with the preset; layer data keeps its own copy (refs carry data URLs)
      for (const b of blobs) {
        seeded.delete(b);
        Promise.resolve(s.backend?.removeBlob?.(PATTERN_KIND, b)).catch(() => {});
      }
    },
    async rename(id, name) {
      await attach();
      if (!entries.has(id) || !String(name ?? '').trim()) return;
      store().update(PATTERN_KIND, id, { name: String(name).trim() });
    },
  };
  app.patterns = api;
  return api;
}
