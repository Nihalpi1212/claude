// Smart objects (see ARCHITECTURE.md "Smart objects"): a SmartLayer keeps its source (a nested
// Document or an image) untouched and renders it through an affine matrix, so Free Transform
// resamples the original pixels at the final size instead of scaling a scaled bitmap. Smart
// filters (filters and adjustments appended to `layer.filters`) run on the rendered pixels at
// render time and stay editable. Every command here records its change through structural() /
// setLayerProps() (or one explicit history entry where a source object cannot be cloned).
import { Layer, Document, RasterLayer, createCanvas, copyCanvas, registerLayerType, intersectRect, unionRect, newId } from './document.js';
import { Compositor, flattenDocument } from './compositor.js';
import { structural, setLayerProps, cloneLayer, releaseOrphanClips } from './layer-ops.js';
import { applyFilter, FILTERS } from '../../shared/pixels/filters.js';
import { applyAdjustment, ADJUSTMENTS } from '../../shared/pixels/adjust.js';
import { transformBounds, IDENTITY } from '../../shared/pixels/transform.js';
import { stylePadding } from '../../shared/pixels/styles.js';
import { bridge } from './bridge.js';
import { decodeImage, openDocument, writePigment, baseName, extOf, OPEN_FILTERS, canvasToPng } from './io.js';
import { buildAdjustmentEditor } from './adjust-ui.js';
import { frameThrottle } from './form.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---- sources --------------------------------------------------------------------------------------------------

/**
 * Source objects are shared by reference between a layer and its structural copies (image/canvas
 * size rebuild layers with Object.assign, cloneLayer goes through JSON). JSON cannot carry a
 * Document, so a source serialises to { kind, ref } and the constructor resolves the ref here.
 */
const SOURCES = new Map(); // id -> WeakRef<source>
const forgetSource = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((id) => SOURCES.delete(id)) : null;

export function makeSource({ kind, doc = null, canvas = null, name = null }) {
  if (kind === 'document' && !(doc instanceof Document)) throw new Error('A document source needs a Document');
  if (kind !== 'document' && !canvas) throw new Error('An image source needs a canvas');
  const src = { kind: kind === 'document' ? 'document' : 'image', doc: kind === 'document' ? doc : null, canvas: kind === 'document' ? null : canvas, name, id: newId('S'), version: 0 };
  Object.defineProperty(src, 'toJSON', { value: () => ({ kind: src.kind, ref: src.id, width: sourceWidth(src), height: sourceHeight(src), name: src.name }), enumerable: false });
  SOURCES.set(src.id, new WeakRef(src));
  forgetSource?.register(src, src.id);
  return src;
}

const sourceWidth = (s) => (s.kind === 'document' ? s.doc.width : s.canvas.width);
const sourceHeight = (s) => (s.kind === 'document' ? s.doc.height : s.canvas.height);

function resolveSource(s) {
  if (s && s.id && SOURCES.has(s.id) && (s.doc instanceof Document || s.canvas)) return s; // already a live source
  if (s?.ref) {
    const live = SOURCES.get(s.ref)?.deref();
    if (live) return live;
  }
  if (s?.kind === 'document' && s.doc instanceof Document) return makeSource(s);
  if (s?.canvas) return makeSource({ kind: 'image', canvas: s.canvas, name: s.name ?? null });
  // a description from a file (io.js fills the pixels in afterwards) or a lost reference: a blank placeholder
  return makeSource({ kind: 'image', canvas: createCanvas(Math.max(1, s?.width ?? 1), Math.max(1, s?.height ?? 1)), name: s?.name ?? null });
}

/** Deep copy of a source (New Smart Object via Copy). */
export function copySource(src) {
  if (src.kind === 'document') return makeSource({ kind: 'document', doc: cloneDocument(src.doc), name: src.name });
  return makeSource({ kind: 'image', canvas: copyCanvas(src.canvas), name: src.name });
}

/** Copies a document's layer tree (and guides, paths, meta) into a new Document with fresh layer ids. */
export function cloneDocument(doc) {
  const out = new Document({ width: doc.width, height: doc.height, dpi: doc.dpi, name: doc.name });
  for (const child of doc.root.children) {
    if (child.quickMask || child.preview) continue;
    const c = cloneLayer(child, { name: child.name });
    c.locked = { ...child.locked };
    out.add(c, out.root, out.root.children.length);
  }
  out.guides = clone(doc.guides ?? []);
  out.paths = clone(doc.paths ?? []);
  out.meta = clone(doc.meta ?? {});
  if (doc.globalLight) out.globalLight = { ...doc.globalLight };
  out.active = out.root.children[out.root.children.length - 1] ?? null;
  out.selected = new Set(out.active ? [out.active] : []);
  return out;
}

/** A one-layer document holding an image (editing the contents of an image source). */
function documentFromImage(src, name) {
  const doc = new Document({ width: src.canvas.width, height: src.canvas.height, name });
  const layer = new RasterLayer({ name: src.name ?? 'Image', canvas: copyCanvas(src.canvas), x: 0, y: 0 });
  doc.add(layer, doc.root, 0);
  doc.active = layer;
  doc.selected = new Set([layer]);
  return doc;
}

// ---- smart filters: pixel work ----------------------------------------------------------------------------

/** Filter kinds registered by other modules (Camera Raw): kind -> { name, apply(img, params), editor?, defaults? }. */
const EXTRA_KINDS = new Map();
const warned = new Set();

/** Parameters the engine expects (filter-ui keeps a __bend convenience field for Shear). */
function runParams(kind, params) {
  const p = clone(params ?? {}) ?? {};
  if (kind === 'shear' && '__bend' in p) {
    p.points = [[0, 0], [0.5, (p.__bend ?? 0) / 100], [1, 0]];
    delete p.__bend;
  }
  return p;
}

/** Applies one smart filter entry to img in place. */
export function applySmartFilter(img, f) {
  const kind = f.kind;
  if (kind.startsWith('adjust:')) {
    const k = kind.slice(7);
    if (ADJUSTMENTS[k]) return applyAdjustment(img, k, f.params ?? {});
  } else if (EXTRA_KINDS.has(kind)) return EXTRA_KINDS.get(kind).apply(img, f.params ?? {});
  else if (FILTERS[kind]) return applyFilter(img, kind, runParams(kind, f.params));
  if (!warned.has(kind)) {
    warned.add(kind);
    console.warn(`Smart filter "${kind}" is not available in this build; it is skipped`);
  }
  return img;
}

/** Pixels a chain of filters can spread beyond the layer's content (blurs, maxima, offsets). */
/** Filters whose result depends on where the image centre and edges are: they must see the whole object, not the host-clipped part. */
const GEOMETRIC_FILTERS = new Set(['twirl', 'pinch', 'spherize', 'ripple', 'wave', 'zigzag', 'polar', 'shear', 'radial-blur', 'lens-flare', 'vignette', 'clouds', 'difference-clouds', 'offset', 'camera-raw']);
export const isGeometricFilter = (f) => GEOMETRIC_FILTERS.has(f.kind) || !!EXTRA_KINDS.get(f.kind)?.geometric;
/** The largest render a smart object may allocate (pixels, and per side): a 40× scale must never ask for gigabytes. */
const RENDER_BUDGET = 25_000_000;
const RENDER_MAX_SIDE = 16_384;

export function filterPadding(filters) {
  let pad = 0;
  for (const f of filters) {
    if (f.enabled === false || f.kind.startsWith('adjust:')) continue;
    const p = f.params ?? {};
    const r = Number(p.radius ?? p.distance ?? p.size ?? 0) || 0;
    let n = 0;
    if (['gaussian-blur', 'unsharp-mask', 'high-pass', 'smart-sharpen'].includes(f.kind)) n = Math.ceil(r * 3);
    else if (['box-blur', 'motion-blur', 'surface-blur', 'median', 'dust-scratches', 'maximum', 'minimum', 'mosaic', 'crystallize', 'pointillize', 'oil-paint', 'diffuse', 'emboss', 'glowing-edges'].includes(f.kind)) n = Math.ceil(r * 2 + 2);
    else if (f.kind === 'offset') n = Math.ceil(Math.max(Math.abs(p.dx ?? 0), Math.abs(p.dy ?? 0)));
    else if (['twirl', 'pinch', 'spherize', 'ripple', 'wave', 'zigzag', 'polar', 'shear', 'radial-blur'].includes(f.kind)) n = 64;
    else if (EXTRA_KINDS.get(f.kind)?.padding) n = EXTRA_KINDS.get(f.kind).padding(p);
    pad = Math.max(pad, Math.min(400, n));
  }
  return pad;
}

const normaliseFilter = (f) => ({ kind: String(f.kind), params: clone(f.params ?? {}) ?? {}, enabled: f.enabled !== false });

// ---- the layer ------------------------------------------------------------------------------------------------

const compositors = new WeakMap(); // layer -> Compositor for its document source
const hosts = new WeakMap(); // layer -> the Document it lives in (render clips to it)
/** Above this many output pixels, filters are skipped while a Free Transform drags the layer. */
const PREVIEW_FILTER_LIMIT = 5e5;

export class SmartLayer extends Layer {
  constructor(props = {}) {
    super('smart', { name: props.name ?? 'Smart Object', ...props });
    this.usesMatrixTransform = true; // image-ops.js transforms it like a text layer (a matrix, never pixels)
    this.transform = Array.isArray(props.transform) && props.transform.length === 6 ? props.transform.map(Number) : null;
    this.filters = Array.isArray(props.filters) ? props.filters.map(normaliseFilter) : [];
    this.filtersEnabled = props.filtersEnabled !== false;
    this.source = resolveSource(props.source);
    this._cache = null;
  }
  /** Set at install: () => true while a transform is being dragged (filters are skipped on big renders). */
  static previewing = null;
  /** Set at install: (layer) => the open Document holding the layer, for render clipping when the WeakMap has no entry. */
  static findHost = null;

  // The Move tool and alignment offset layers through x/y: for a smart object they are the
  // translation part of its matrix (base space maps to document space through `transform`).
  get x() {
    return this.transform?.[4] ?? 0;
  }
  set x(v) {
    const m = this.transform ? this.transform.slice() : IDENTITY.slice();
    m[4] = v;
    this.transform = m;
  }
  get y() {
    return this.transform?.[5] ?? 0;
  }
  set y(v) {
    const m = this.transform ? this.transform.slice() : IDENTITY.slice();
    m[5] = v;
    this.transform = m;
  }
  get sourceWidth() {
    return sourceWidth(this.source);
  }
  get sourceHeight() {
    return sourceHeight(this.source);
  }
  /** Replaces the source (io.js after reading a file, Replace Contents, write-back). */
  setSource(src, host = null) {
    this.source = resolveSource(src);
    if (host) hosts.set(this, host);
    // a replacement document can carry the same version numbers as the old one: never reuse its compositor
    compositors.delete(this);
    this._cache = null;
    this.touch();
  }
  sourceVersion() {
    const s = this.source;
    return s.kind === 'document' ? `${s.id}:${s.doc.version}:${s.doc.root.version}` : `${s.id}:${s.version}`;
  }
  baseRect() {
    return { x: 0, y: 0, width: this.sourceWidth, height: this.sourceHeight };
  }
  bounds() {
    const b = this.baseRect();
    return this.transform ? transformBounds(this.transform, b) : b;
  }
  /** The source pixels in base space (the document source composited, cached per version). */
  sourceCanvas() {
    const s = this.source;
    if (s.kind !== 'document') return s.canvas;
    let c = compositors.get(this);
    if (!c) {
      c = new Compositor();
      compositors.set(this, c);
    }
    return c.composite(s.doc);
  }
  activeFilters() {
    return this.filtersEnabled ? this.filters.filter((f) => f.enabled !== false) : [];
  }
  /**
   * Rasterises the source through the matrix at the final size (the source stays sharp), then runs
   * the smart filters on the result. Cached on layer version, source version, matrix and filters.
   */
  render({ full = false } = {}) {
    const m = this.transform ?? IDENTITY;
    const base = this.baseRect();
    const out = transformBounds(m, base);
    let filters = this.activeFilters();
    const previewing = filters.length > 0 && SmartLayer.previewing?.() === true && out.width * out.height > PREVIEW_FILTER_LIMIT;
    if (previewing) filters = [];
    const pad = filterPadding(filters);
    let rect = { x: out.x - pad, y: out.y - pad, width: out.width + pad * 2, height: out.height + pad * 2 };
    // geometry filters (vignette, spherize, ...) see the whole object so moving it, even off the canvas, cannot change
    // their result; rasterising wants the whole object too. Either way the render stays within a pixel budget
    const withinBudget = rect.width * rect.height <= RENDER_BUDGET && rect.width <= RENDER_MAX_SIDE && rect.height <= RENDER_MAX_SIDE;
    const whole = (full || filters.some(isGeometricFilter)) && withinBudget;
    // not keyed on layer.version: opacity, visibility or mask edits must not re-rasterise the source
    const key = `${this.sourceVersion()}|${m.join(',')}|${filters.length ? JSON.stringify(filters) : ''}|${whole ? 'whole' : 'clipped'}`;
    if (this._cache?.key === key) return this._cache;
    // only what can reach the host canvas is rendered: a 40× scale must not allocate a gigantic canvas. The host is
    // learnt from tree changes; after a whole-document remap (Image Size, Crop, ...) the layer objects are new, so it is
    // looked up again
    let host = hosts.get(this);
    if (!host) {
      host = SmartLayer.findHost?.(this) ?? null;
      if (host) hosts.set(this, host);
    }
    if (host && !whole) rect = intersectRect(rect, { x: -pad, y: -pad, width: host.width + pad * 2, height: host.height + pad * 2 });
    else if (!host && !withinBudget) rect = intersectRect(rect, { x: -pad, y: -pad, width: 8192 + pad * 2, height: 8192 + pad * 2 });
    if (!rect || rect.width < 1 || rect.height < 1) {
      this._cache = { key, canvas: createCanvas(1, 1), x: out.x, y: out.y, version: this.version };
      return this._cache;
    }
    const canvas = createCanvas(rect.width, rect.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - rect.x, m[5] - rect.y);
    ctx.drawImage(this.sourceCanvas(), 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (filters.length) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const work = { width: img.width, height: img.height, data: img.data };
      for (const f of filters) applySmartFilter(work, f);
      ctx.putImageData(img, 0, 0);
    }
    this._cache = { key, canvas, x: rect.x, y: rect.y, version: this.version };
    return this._cache;
  }
}

registerLayerType('smart', SmartLayer, {
  describe: (l) => ({
    transform: l.transform ? l.transform.slice() : null,
    filters: clone(l.filters),
    filtersEnabled: l.filtersEnabled !== false,
    source: { kind: l.source.kind, width: l.sourceWidth, height: l.sourceHeight, name: l.source.name ?? null },
  }),
});

/** Marks the document a smart layer belongs to (its render is clipped to that canvas). */
export function attachHost(layer, doc) {
  hosts.set(layer, doc);
}

// ---- converting layers: the box around them and moving them into it ------------------------------------------

/** Integer box around what the layers draw (layer styles included); the document when nothing is drawn. */
function contentBox(layers, doc) {
  let b = null;
  for (const l of layers) {
    const lb = l.bounds?.();
    if (!lb) continue;
    const pad = l.styles ? stylePadding(l.styles) : 0;
    const r = { x: Math.floor(lb.x - pad), y: Math.floor(lb.y - pad), width: Math.ceil(lb.width + pad * 2), height: Math.ceil(lb.height + pad * 2) };
    b = b ? unionRect(b, r) : r;
  }
  if (!b || b.width < 1 || b.height < 1) return { x: 0, y: 0, width: doc.width, height: doc.height };
  return b;
}

/** Moves a (cloned) layer by dx/dy into a w × h canvas: positions, paths, gradients and document-sized masks. */
function shiftLayer(l, dx, dy, w, h) {
  if (l.isGroup) for (const c of l.children) shiftLayer(c, dx, dy, w, h);
  else if (l.type === 'text') {
    if (l.transform) {
      l.transform = l.transform.slice();
      l.transform[4] += dx;
      l.transform[5] += dy;
    } else {
      l.x += dx;
      l.y += dy;
    }
    if (l.pathText?.path) l.pathText = { ...l.pathText, path: shiftPath(l.pathText.path, dx, dy) };
  } else if (l.type === 'shape') l.path = shiftPath(l.path, dx, dy);
  else if (l.type === 'fill') {
    const g = l.paint?.gradient;
    if (g?.from && g?.to) l.paint = { ...l.paint, gradient: { ...g, from: [g.from[0] + dx, g.from[1] + dy], to: [g.to[0] + dx, g.to[1] + dy] } };
  } else if (l.type === 'raster' || l.type === 'smart') {
    l.x += dx;
    l.y += dy;
  }
  if (l.mask?.canvas) {
    const m = createCanvas(w, h);
    const ctx = m.getContext('2d');
    let bg = 255;
    try {
      bg = l.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3];
    } catch {
      /* ignore */
    }
    if (bg) {
      ctx.fillStyle = `rgba(255,255,255,${bg / 255})`;
      ctx.fillRect(0, 0, w, h);
      ctx.clearRect(dx, dy, l.mask.canvas.width, l.mask.canvas.height);
    }
    ctx.drawImage(l.mask.canvas, dx, dy);
    l.mask = { ...l.mask, canvas: m };
  }
  l._cache = null;
  l.touch();
}

function shiftPath(path, dx, dy) {
  const p = clone(path);
  for (const sp of p?.subpaths ?? []) for (const pt of sp.points ?? []) {
    pt.x += dx;
    pt.y += dy;
    if (pt.inX !== undefined) pt.inX += dx;
    if (pt.inY !== undefined) pt.inY += dy;
    if (pt.outX !== undefined) pt.outX += dx;
    if (pt.outY !== undefined) pt.outY += dy;
  }
  return p;
}

// ---- install --------------------------------------------------------------------------------------------------

export function install(app) {
  const doc = () => app.doc;
  const active = () => app.doc?.active ?? null;
  const isSmart = (l) => !!l && l.type === 'smart';
  const hasSmart = () => isSmart(active());
  const NO_PARAMS = new Set(['invert', 'desaturate', 'equalize']);

  SmartLayer.previewing = () => !!app.transformTool?.session && !app.transformTool.committing;
  SmartLayer.findHost = (layer) => app.docs?.docs.find((d) => d.find(layer.id) === layer) ?? null;

  /** Document that holds a layer (the active one unless the layer lives in another open document). */
  const docOf = (layer) => (app.doc && app.doc.find(layer.id) === layer ? app.doc : app.docs.docs.find((d) => d.find(layer.id) === layer) ?? app.doc);

  function selectedOrActive(d) {
    const sel = d.selectedLayers();
    return sel.length ? sel : d.active ? [d.active] : [];
  }
  const isAncestor = (a, l) => {
    for (let p = l.parent; p; p = p.parent) if (p === a) return true;
    return false;
  };

  /**
   * Replaces a layer's source as one undo entry (sources hold Documents, which setLayerProps cannot clone).
   * Instances made by Duplicate Layer share one source: every layer holding it is updated together, as
   * in Photoshop (New Smart Object via Copy is the way to get an independent copy).
   */
  function setSmartSource(hostDoc, layer, source, label) {
    const before = layer.source;
    const targets = hostDoc.layers().filter((l) => isSmart(l) && l.source === before);
    if (!targets.includes(layer)) targets.push(layer);
    const apply = (s) => {
      for (const t of targets) {
        t.setSource(s, hostDoc);
        hostDoc.changed('props', { layer: t });
      }
    };
    apply(source);
    const bytes = sourceWidth(source) * sourceHeight(source) * 4;
    hostDoc.history.push({ label, undo: () => apply(before), redo: () => apply(source), bytes, at: Date.now() });
    hostDoc.changed('history');
  }

  // ---- convert / copy / rasterize -------------------------------------------------------------------------
  function convert() {
    const d = doc();
    const picked = selectedOrActive(d).filter((l) => l !== d.root);
    const layers = picked.filter((l) => !picked.some((o) => o !== l && isAncestor(o, l)));
    if (!layers.length) return;
    const order = d.layers();
    layers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const top = layers[layers.length - 1];
    // like Photoshop, the smart object's canvas is the box around the converted layers (effects included),
    // so the transform box hugs the content; the matrix puts it back where it was
    const box = contentBox(layers, d);
    const src = new Document({ width: box.width, height: box.height, dpi: d.dpi, name: top.name });
    for (const l of layers) {
      const c = cloneLayer(l, { name: l.name });
      c.locked = { ...l.locked };
      shiftLayer(c, -box.x, -box.y, box.width, box.height);
      src.add(c, src.root, src.root.children.length);
    }
    releaseOrphanClips(src);
    src.active = src.root.children[src.root.children.length - 1] ?? null;
    src.selected = new Set(src.active ? [src.active] : []);
    // a clipped bottom layer whose base stays behind keeps clipping to it (the composite must not change)
    const bottom = layers[0];
    const siblings = bottom.parent.children;
    const bi = siblings.indexOf(bottom);
    // only for one contiguous run of clipped layers directly over the same base (a mixed selection cannot keep
    // its composite whichever way it goes, and stays unclipped as before)
    const run = layers.every((l, i) => l.parent === bottom.parent && l.clip && siblings.indexOf(l) === bi + i);
    const keepClip = run && bi > 0 && !layers.includes(siblings[bi - 1]);
    const smart = new SmartLayer({ name: top.name, clip: keepClip, source: makeSource({ kind: 'document', doc: src, name: top.name }), transform: box.x || box.y ? [1, 0, 0, 1, box.x, box.y] : null });
    hosts.set(smart, d);
    structural(app, layers.length > 1 ? 'Convert layers to smart object' : 'Convert to smart object', () => {
      // the smart object takes the top layer's place, or sits right above its clip base when it stays clipped
      const anchor = keepClip ? bottom : top;
      const parent = anchor.parent;
      const index = parent.children.indexOf(anchor);
      d.add(smart, parent, keepClip ? index : index + 1);
      for (const l of layers) d.remove(l);
      releaseOrphanClips(d);
      d.setActive(smart);
    });
    app.setEditingMask(false);
  }

  function viaCopy() {
    const d = doc();
    const layer = active();
    if (!isSmart(layer)) return;
    const copy = cloneLayer(layer);
    copy.setSource(copySource(layer.source), d);
    structural(app, 'New smart object via copy', () => {
      d.add(copy, layer.parent, layer.parent.children.indexOf(layer) + 1);
      d.setActive(copy);
    });
  }

  // ---- edit contents (a tab) and write-back ---------------------------------------------------------------
  function editContents(id) {
    const d = doc();
    const layer = (typeof id === 'string' && d.find(id)) || active();
    if (!isSmart(layer)) return;
    const open = app.docs.docs.find((x) => x.smartHost?.layer === layer);
    if (open) return app.docs.activate(open);
    const src = layer.source;
    const edit = src.kind === 'document' ? cloneDocument(src.doc) : documentFromImage(src, layer.name);
    edit.name = `${layer.name} (smart object)`;
    edit.smartHost = { hostDoc: d, layerId: layer.id, layer, kind: src.kind };
    app.docs.add(edit);
    edit.history.markSaved(flattenDocument(edit, edit.view.compositor));
    app.dialogs.toast('Edit the contents, then File › Save to update the smart object', { timeout: 3200 });
  }

  /** File › Save in an "Edit Contents" tab: the edited document becomes the layer's source. */
  function writeBack(edit) {
    const { hostDoc, layerId, kind } = edit.smartHost;
    if (!app.docs.docs.includes(hostDoc)) {
      app.dialogs.toast('The document this smart object belongs to is closed: use Save As to keep the contents', { kind: 'error', timeout: 4000 });
      return false;
    }
    const layer = hostDoc.find(layerId);
    if (!isSmart(layer)) {
      app.dialogs.toast('The smart object no longer exists in its document', { kind: 'error', timeout: 4000 });
      return false;
    }
    app.tools.active?.commit?.();
    let source;
    const only = edit.root.children.length === 1 ? edit.root.children[0] : null;
    const plain = only && only.type === 'raster' && !only.mask && !only.styles && only.opacity === 1 && only.blend === 'normal' && only.visible && only.x === 0 && only.y === 0 && only.canvas.width === edit.width && only.canvas.height === edit.height;
    // an image stays an image while its document is a single plain layer; anything else needs a document source
    if (kind === 'image' && plain) source = makeSource({ kind: 'image', canvas: copyCanvas(only.canvas), name: layer.source.name });
    else source = makeSource({ kind: 'document', doc: cloneDocument(edit), name: layer.source.name });
    setSmartSource(hostDoc, layer, source, 'Edit smart object contents');
    edit.history.markSaved(flattenDocument(edit, edit.view.compositor));
    app.docs.renderTabs();
    app.dialogs.toast(`Updated "${layer.name}"`, { kind: 'success', timeout: 1600 });
    app.emit('doc:saved', edit);
    return true;
  }
  // Save (and the "save before closing" question) of an edit tab writes back instead of asking for a file
  const docs = app.docs;
  const baseSave = docs.save.bind(docs);
  docs.save = (d = docs.active) => (d?.smartHost ? Promise.resolve(writeBack(d)) : baseSave(d));

  // ---- replace / export ------------------------------------------------------------------------------------
  async function sourceFromFile(path) {
    if (window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
    const bytes = await bridge.readFile(path);
    const ext = extOf(path);
    if (['pigment', 'psd', 'psb'].includes(ext)) {
      const d = await openDocument(bytes, { name: path.split(/[\\/]/).pop(), path: null });
      return makeSource({ kind: 'document', doc: d, name: baseName(path) });
    }
    return makeSource({ kind: 'image', canvas: await decodeImage(bytes, path), name: baseName(path) });
  }

  async function replaceContents(pathArg) {
    const d = doc();
    const layer = active();
    if (!isSmart(layer)) return;
    let path = pathArg;
    if (!path) {
      [path] = await bridge.openFileDialog({ filters: OPEN_FILTERS, title: 'Replace Contents' });
      if (!path) return;
    }
    try {
      const source = await app.busy('Replacing contents…', () => sourceFromFile(path));
      setSmartSource(d, layer, source, 'Replace contents');
    } catch (err) {
      app.reportError(err, 'Could not replace the contents');
    }
  }

  async function exportContents() {
    const layer = active();
    if (!isSmart(layer)) return;
    const src = layer.source;
    const isDoc = src.kind === 'document';
    const target = await bridge.saveFileDialog({
      defaultPath: `${layer.name.replace(/[\\/:*?"<>|]+/g, '_')}.${isDoc ? 'pigment' : 'png'}`,
      filters: isDoc ? [{ name: 'Pigment document', extensions: ['pigment'] }, { name: 'PNG image', extensions: ['png'] }] : [{ name: 'PNG image', extensions: ['png'] }, { name: 'Pigment document', extensions: ['pigment'] }],
      title: 'Export Contents',
    });
    if (!target) return;
    const path = extOf(target) ? target : `${target}.${isDoc ? 'pigment' : 'png'}`;
    try {
      const bytes = await app.busy('Exporting contents…', async () => {
        if (extOf(path) === 'pigment') return writePigment(isDoc ? src.doc : documentFromImage(src, layer.name));
        return canvasToPng(isDoc ? flattenDocument(src.doc) : src.canvas);
      });
      await bridge.writeFile(path, bytes);
      app.dialogs.toast(`Exported ${path.split(/[\\/]/).pop()}`, { kind: 'success', timeout: 1600 });
    } catch (err) {
      app.reportError(err, 'Could not export the contents');
    }
  }

  // ---- place as a smart object ------------------------------------------------------------------------------
  const rasterPlace = app.commands.commands.get('file:place'); // edit-ops.js: places a raster layer
  async function place(pathArg) {
    const d = doc();
    if (!d) return;
    let path = pathArg;
    if (!path) {
      [path] = await bridge.openFileDialog({ filters: OPEN_FILTERS, title: 'Place' });
      if (!path) return;
    }
    try {
      const source = await app.busy('Placing…', () => sourceFromFile(path));
      const w = sourceWidth(source), h = sourceHeight(source);
      // fit inside the canvas when larger, like Photoshop's Place; the source keeps its full resolution
      const scale = Math.min(1, d.width / w, d.height / h);
      const tx = Math.round((d.width - w * scale) / 2), ty = Math.round((d.height - h * scale) / 2);
      const layer = new SmartLayer({ name: baseName(path), source, transform: scale !== 1 || tx || ty ? [scale, 0, 0, scale, tx, ty] : null });
      hosts.set(layer, d);
      structural(app, 'Place', () => {
        d.add(layer);
        d.setActive(layer);
      });
      app.setEditingMask(false);
      app.tools.activate('move');
    } catch (err) {
      app.reportError(err, 'Could not place the file');
    }
  }

  // ---- smart filters ----------------------------------------------------------------------------------------
  /** What a filter kind is called and how it is edited; null for kinds this build cannot run. */
  function describeKind(kind) {
    if (kind.startsWith('adjust:')) {
      const k = kind.slice(7);
      if (!ADJUSTMENTS[k]) return null;
      return {
        name: ADJUSTMENTS[k].name,
        defaults: () => clone(app.adjustments?.[k]?.defaults ?? ADJUSTMENTS[k].defaults ?? {}),
        hasEditor: !NO_PARAMS.has(k),
        editor: (params, onChange, layer) => buildAdjustmentEditor(k, params, onChange, { source: histogramSource(layer) }),
      };
    }
    const extra = EXTRA_KINDS.get(kind);
    if (extra) return { name: extra.name ?? kind, defaults: () => clone(extra.defaults?.() ?? {}), hasEditor: !!extra.editor, editor: extra.editor ? (p, on) => extra.editor(p, on) : null };
    if (!FILTERS[kind]) return null;
    const ui = app.filterEditor; // hook exported by filter-ui.js
    return {
      name: FILTERS[kind].name,
      defaults: () => clone(ui?.defaults(kind) ?? FILTERS[kind].defaults ?? {}),
      hasEditor: !!ui?.hasFields(kind),
      editor: ui ? (p, on) => ui.editor(kind, p, on) : null,
    };
  }
  const kindName = (kind) => describeKind(kind)?.name ?? kind;

  /** Downscaled render of the layer for the Levels/Curves histograms. */
  function histogramSource(layer) {
    try {
      const r = layer.render();
      const s = Math.min(1, 512 / Math.max(r.canvas.width, r.canvas.height));
      const c = createCanvas(Math.max(1, Math.round(r.canvas.width * s)), Math.max(1, Math.round(r.canvas.height * s)));
      c.getContext('2d').drawImage(r.canvas, 0, 0, c.width, c.height);
      return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
    } catch {
      return null;
    }
  }

  function rememberLastFilter(kind, params) {
    if (kind.startsWith('adjust:') || !FILTERS[kind]) return;
    app.settings.lastFilter = { kind, name: FILTERS[kind].name, params: clone(params) };
    app.saveSettingsSoon();
    app.syncUiState();
    app.commands.invalidate();
    app.menuRefresh?.();
  }

  function setFilters(layer, filters, label) {
    setLayerProps(app, layer, { filters }, label);
  }

  function addFilter(layer, kind, params, label) {
    setFilters(layer, [...layer.filters, { kind, params: clone(params ?? {}) ?? {}, enabled: true }], `Smart filter: ${label ?? kindName(kind)}`);
    rememberLastFilter(kind, params);
  }

  /** Dialog adding (index < 0) or re-editing a smart filter, previewing live on the layer. */
  async function filterDialog(layer, kind, index = -1, params = null) {
    const def = describeKind(kind);
    if (!def) return null;
    const d = docOf(layer);
    const original = layer.filters;
    const start = clone(params ?? (index >= 0 ? original[index]?.params : def.defaults())) ?? {};
    if (!def.hasEditor || !def.editor) {
      if (index < 0) addFilter(layer, kind, start, def.name);
      return start;
    }
    let current = start;
    let preview = app.settings.dialogPreview !== false;
    let done = false;
    const withParams = (p) => {
      const list = original.map((f) => ({ ...f }));
      if (index >= 0) list[index] = { ...list[index], params: clone(p) };
      else list.push({ kind, params: clone(p), enabled: true });
      return list;
    };
    const show = (list) => {
      layer.filters = list;
      layer.touch();
      d.changed('props', { layer });
    };
    const refresh = frameThrottle(() => {
      if (done) return;
      show(preview ? withParams(current) : original);
    });
    const ed = def.editor(start, (p) => {
      current = p;
      refresh();
    }, layer);
    const content = document.createElement('div');
    content.appendChild(ed.element);
    const pv = document.createElement('label');
    pv.className = 'checkbox';
    const pvInput = document.createElement('input');
    pvInput.type = 'checkbox';
    pvInput.checked = preview;
    pvInput.dataset.key = '__preview';
    pvInput.addEventListener('change', () => {
      preview = pvInput.checked;
      app.settings.dialogPreview = preview;
      app.saveSettingsSoon();
      refresh();
    });
    pv.append(pvInput, document.createTextNode('Preview'));
    content.appendChild(pv);
    const note = document.createElement('p');
    note.className = 'muted smart-filter-note';
    note.textContent = index >= 0 ? 'Editing a smart filter: the change stays non-destructive.' : 'Applied as a smart filter: it can be edited, hidden or removed later from the Layers panel.';
    content.appendChild(note);
    const ok = await app.dialogs.open({
      title: def.name,
      content,
      width: 440,
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
      onOpen: () => refresh(),
    });
    done = true;
    refresh.cancel();
    show(original);
    if (!ok) return null;
    setFilters(layer, withParams(current), `${index >= 0 ? 'Edit smart filter' : 'Smart filter'}: ${def.name}`);
    if (index < 0) rememberLastFilter(kind, current);
    return current;
  }

  app.smartFilters = {
    /**
     * Called by filter-ui.js / adjust-ui.js before a pixel edit: true when the layer is a smart object
     * and the edit was taken over as a smart filter (with a dialog when params is null).
     */
    intercept(layer, kind, params, label) {
      if (!isSmart(layer)) return false;
      if (app.ui.editingMask && layer.mask) return false; // the mask is ordinary pixels
      if (!describeKind(kind)) return false;
      if (layer.locked.all || layer.locked.pixels) {
        app.dialogs.toast(`"${layer.name}" is locked`, { kind: 'error' });
        return true;
      }
      if (params && typeof params === 'object') addFilter(layer, kind, params, label);
      else filterDialog(layer, kind, -1, null).catch((err) => app.reportError(err, `${label ?? kind} failed`));
      return true;
    },
    /** Other modules (Camera Raw) make their filter kind available as a smart filter. */
    registerKind(kind, def) {
      EXTRA_KINDS.set(kind, def);
    },
    kindName,
    apply: applySmartFilter,
    padding: filterPadding,
    edit: (layer, index) => filterDialog(layer, layer.filters[index]?.kind, index),
  };

  function filterOp({ id, index, op } = {}) {
    const d = doc();
    const layer = (typeof id === 'string' && d?.find(id)) || active();
    if (!isSmart(layer)) return;
    const f = layer.filters[index];
    if (!f) return;
    if (op === 'toggle') {
      const list = layer.filters.map((x, i) => (i === index ? { ...x, enabled: x.enabled === false } : x));
      setFilters(layer, list, f.enabled === false ? `Show smart filter: ${kindName(f.kind)}` : `Hide smart filter: ${kindName(f.kind)}`);
    } else if (op === 'delete') setFilters(layer, layer.filters.filter((_, i) => i !== index), `Delete smart filter: ${kindName(f.kind)}`);
    else if (op === 'edit') return filterDialog(layer, f.kind, index);
    else if (op === 'up' || op === 'down') {
      const j = op === 'up' ? index + 1 : index - 1;
      if (j < 0 || j >= layer.filters.length) return;
      const list = layer.filters.slice();
      [list[index], list[j]] = [list[j], list[index]];
      setFilters(layer, list, 'Reorder smart filters');
    }
  }

  // ---- commands ---------------------------------------------------------------------------------------------
  const layerOf = (id) => (typeof id === 'string' && doc()?.find(id)) || active();
  app.commands.registerAll({
    'layer:smart-convert': { enabled: () => !!active() && active() !== doc()?.root, run: convert, label: 'Convert to Smart Object' },
    'layer:smart-via-copy': { enabled: hasSmart, run: viaCopy, label: 'New Smart Object via Copy' },
    'layer:smart-edit': { enabled: hasSmart, run: (id) => editContents(id), label: 'Edit Contents' },
    'layer:smart-replace': { enabled: hasSmart, run: (path) => replaceContents(typeof path === 'string' ? path : null), label: 'Replace Contents…' },
    'layer:smart-export': { enabled: hasSmart, run: exportContents, label: 'Export Contents…' },
    'layer:smart-reset': {
      enabled: () => hasSmart() && !!active().transform,
      run: (id) => {
        const layer = layerOf(id);
        if (isSmart(layer) && layer.transform) setLayerProps(app, layer, { transform: null }, 'Reset smart object transform');
      },
      label: 'Reset Transform',
    },
    'layer:smart-rasterize': {
      enabled: hasSmart,
      run: (id) => {
        const layer = layerOf(id);
        if (!isSmart(layer)) return;
        if (doc().active !== layer) doc().setActive(layer);
        app.commands.run('layer:rasterize', undefined, 'api'); // layer-ops.js rasterises any layer with render()
      },
      label: 'Rasterize',
    },
    'layer:smart-filters-toggle': {
      enabled: () => hasSmart() && active().filters.length > 0,
      checked: () => hasSmart() && active().filtersEnabled !== false,
      run: (id) => {
        const layer = layerOf(id);
        if (isSmart(layer)) setLayerProps(app, layer, { filtersEnabled: layer.filtersEnabled === false }, layer.filtersEnabled === false ? 'Enable smart filters' : 'Disable smart filters');
      },
      label: 'Enable / Disable Smart Filters',
    },
    'layer:smart-filters-clear': {
      enabled: () => hasSmart() && active().filters.length > 0,
      run: (id) => {
        const layer = layerOf(id);
        if (isSmart(layer) && layer.filters.length) setFilters(layer, [], 'Clear smart filters');
      },
      label: 'Clear Smart Filters',
    },
    'layer:smart-filter': { enabled: hasSmart, run: (arg) => filterOp(arg ?? {}) },
    // File › Place creates a smart object unless Preferences turned that off (settings.placeAsSmart)
    'file:place': {
      enabled: () => !!doc(),
      run: (path) => (app.settings.placeAsSmart === false && rasterPlace ? rasterPlace.run(path) : place(typeof path === 'string' ? path : null)),
      label: 'Place…',
    },
  });

  // smart layers opened from files or made by other modules get their host document for render clipping
  app.on('doc:opened', (d) => {
    for (const l of d.layers()) if (isSmart(l)) hosts.set(l, d);
  });
  app.on('doc:change', (e) => {
    if (e.kind === 'tree' && isSmart(e.layer) && !hosts.has(e.layer)) hosts.set(e.layer, e.doc);
    // a whole-document remap (Image Size, Canvas Size, Rotate, Flip, Crop) replaces the layer objects under a 'canvas' change
    else if ((e.kind === 'canvas' || e.kind === 'tree') && e.doc) for (const l of e.doc.layers()) if (isSmart(l) && !hosts.has(l)) hosts.set(l, e.doc);
  });

  app.smartObjects = { SmartLayer, makeSource, cloneDocument, writeBack, convert, editContents };
}
