// masks-vector-masks (package 12, ARCHITECTURE.md "0.4 features (contracts)", Packages; K.1, K.1b, J.1, L.4, L.15):
// vector masks, mask density and feather, the mask overlay.
//
//   layer:vector-mask   'reveal-all' | 'hide-all' | 'current-path' | 'delete' | 'toggle' | 'link' | 'rasterize' |
//                       'target' (the vector mask becomes the active path target, edited with the path tools) |
//                       'select' (load as a selection); an object { op, path?, mode? } replays exactly
//   layer:mask-properties { part: 'raster' | 'vector', density?: 0..1, feather?: px, merge? } (Properties sliders)
//   layer:mask-overlay  the rubylith over the targeted mask (\); true / false sets it
//   layer:mask-overlay-options { color, opacity } or a dialog (settings.masks)
//   path:make-mask      the current path as the active layer's vector mask (the path tools' Mask button)
//   path:make-shape     the current path as a new shape layer (the Shape button; createShapeLayer, L.4)
//
// The 'vector-mask' path target kind (L.4) makes the vector mask of the active layer a path the vector tools show
// and edit: the preview writes layer.vectorMask.path, as the shape target writes layer.path. What the masks look like
// is lib/mask-render.js (K.1); the views are lib/mask-view.js (K.1b); the Properties section lib/properties/mask.js.
import { registerPathTargetKind, registerPathButton, createShapeLayer, setActivePath, currentPathTarget, isEmptyPath, clonePath, pathTargetKinds } from './tools/vector.js';
import { setLayerProps } from './layer-ops.js';
import { maskCanvasFor } from './mask-render.js';
import { Selection } from './selection.js';
import { formDialog } from './form.js';
import { registerIcons } from './icons.js';
import { createCanvas, DEFAULT_VECTOR_MASK } from './document.js';
import { maskDensity, maskFeather, isPlainMask, refineMask, intersectAlpha } from '../../shared/pixels/mask-math.js';

export const KIND = 'vector-mask';
export const OVERLAY_DEFAULTS = Object.freeze({ overlayColor: '#ff0000', overlayOpacity: 0.5 });
const HEX = /^#[0-9a-f]{6}$/i;
const VECTOR_OPS = ['reveal-all', 'hide-all', 'current-path', 'delete', 'toggle', 'link', 'rasterize', 'target', 'select'];
const EMPTY = Object.freeze({ subpaths: Object.freeze([]) });

/** The mask overlay settings (settings.masks merged over the defaults). */
export function overlaySettings(app) {
  const m = { ...OVERLAY_DEFAULTS, ...(app?.settings?.masks ?? {}) };
  const color = typeof m.overlayColor === 'string' && HEX.test(m.overlayColor) ? m.overlayColor.toLowerCase() : OVERLAY_DEFAULTS.overlayColor;
  const o = Number(m.overlayOpacity);
  return { overlayColor: color, overlayOpacity: Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : OVERLAY_DEFAULTS.overlayOpacity };
}

/** True when the Background rules (L.13) lock `prop` ('mask' or 'vectorMask') on the layer. */
export function maskLocked(app, layer, prop) {
  try {
    return !!layer && (app.backgroundRules?.lockedProps?.(layer) ?? []).includes(prop);
  } catch {
    return false;
  }
}

function refuseLocked(app, layer, prop) {
  if (!maskLocked(app, layer, prop)) return false;
  app.dialogs.toast(`"${layer.name}" cannot take ${prop === 'vectorMask' ? 'a vector mask' : 'mask changes'}: it is the Background`, { kind: 'error', timeout: 2200 });
  return true;
}

// ---- the 'vector-mask' path target (L.4) ----------------------------------------------------------------------

/** The path target of a layer's vector mask: get / commit / preview like the shape target. */
export function vectorMaskTarget(app, layer) {
  let base = null; // the vector mask before the preview started (restored exactly by endPreview)
  return {
    kind: KIND,
    key: `${KIND}:${layer.id}`,
    layer,
    doc: app.doc,
    get label() {
      return `${layer.name} Vector Mask`;
    },
    get: () => layer.vectorMask?.path ?? EMPTY,
    valid: () => !!layer.parent && !!layer.vectorMask,
    commit(path, label = 'Edit Vector Mask') {
      if (!layer.vectorMask || refuseLocked(app, layer, 'vectorMask')) return;
      setLayerProps(app, layer, { vectorMask: { ...layer.vectorMask, path: clonePath(path) } }, label);
    },
    preview(draft) {
      if (!layer.vectorMask) return;
      base ??= layer.vectorMask;
      layer.vectorMask = { ...base, path: draft };
      layer.touch();
      app.doc?.changed('pixels', { layer });
    },
    endPreview(original) {
      if (base) layer.vectorMask = base;
      else if (layer.vectorMask && original) layer.vectorMask = { ...layer.vectorMask, path: original };
      base = null;
      layer.touch();
      app.doc?.changed('pixels', { layer });
    },
  };
}

function registerTargetKind() {
  if (pathTargetKinds().some(([k]) => k === KIND)) return;
  registerPathTargetKind(KIND, {
    fromRef(app, ref) {
      const doc = app.doc;
      const layer = doc?.find(ref.layerId);
      return layer?.vectorMask && layer === doc.active ? vectorMaskTarget(app, layer) : null;
    },
    // the vector mask of the active layer is shown and editable by the path tools, as a shape layer's path is
    fromActive(app, doc) {
      const layer = doc?.active;
      return layer?.vectorMask ? vectorMaskTarget(app, layer) : null;
    },
    rows(app, doc) {
      const layer = doc?.active;
      if (!layer?.vectorMask) return [];
      return [{ key: `${KIND}:${layer.id}`, ap: { kind: KIND, layerId: layer.id }, name: `${layer.name} Vector Mask`, path: layer.vectorMask.path ?? EMPTY, italic: true, vectorMask: true }];
    },
    remove(app, target) {
      deleteVectorMask(app, target.layer);
    },
    // the row's name is the layer's: renaming it renames the layer
    rename(app, target, name) {
      if (name && name !== target.layer.name) setLayerProps(app, target.layer, { name }, 'Rename Layer');
    },
    toSaved(app, target) {
      return { name: null, path: clonePath(target.get()) };
    },
  });
}

// ---- vector mask operations ----------------------------------------------------------------------------------

function newVectorMask(initialFill, path = EMPTY) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_VECTOR_MASK)), path: clonePath(path), initialFill };
}

/** The path the "current path" commands take: the chosen path, else the work path, else the active shape's path. */
function sourcePath(app) {
  const t = currentPathTarget(app);
  if (!t || t.kind === KIND) {
    // the vector mask itself is no source; look at the work path and saved paths only
    const doc = app.doc;
    if (doc?.workPath && !isEmptyPath(doc.workPath)) return doc.workPath;
    return null;
  }
  const p = t.get();
  return isEmptyPath(p) ? null : p;
}

function addVectorMask(app, layer, vm, label) {
  if (refuseLocked(app, layer, 'vectorMask')) return false;
  if (layer.vectorMask) {
    app.dialogs.toast(`"${layer.name}" already has a vector mask`, { kind: 'error', timeout: 2000 });
    return false;
  }
  setLayerProps(app, layer, { vectorMask: vm }, label);
  return true;
}

function deleteVectorMask(app, layer) {
  if (!layer?.vectorMask || refuseLocked(app, layer, 'vectorMask')) return;
  if (app.ui.activePath?.kind === KIND && app.ui.activePath.layerId === layer.id) setActivePath(app, null);
  setLayerProps(app, layer, { vectorMask: null }, 'Delete Vector Mask');
}

/** The alpha plane of a canvas (document sized). */
function alphaPlane(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const a = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
  return a;
}

function planeCanvas(alpha, w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
    img.data[j + 3] = alpha[i];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * The raster mask that rasterising the vector mask leaves: the vector part (initialFill, operations, density,
 * feather) intersected with the layer mask as it shows. A layer mask at 100 % density and no feather keeps its
 * pixels and settings; otherwise its density and feather are baked in too, so the layer looks the same. A disabled
 * layer mask is replaced by the vector part alone (what the layer showed), as image-ops.js bakeVectorMask does.
 */
export function rasterizedMask(layer, doc) {
  const W = doc.width, H = doc.height;
  const vec = maskCanvasFor(layer, doc, { purpose: 'bake', parts: 'vector' }); // mask (K.1)
  const V = vec ? alphaPlane(vec) : new Uint8ClampedArray(W * H).fill(255);
  const m = layer.mask;
  if (!m?.canvas || !m.enabled) return { canvas: planeCanvas(V, W, H), enabled: true, linked: layer.vectorMask?.linked !== false };
  const R = alphaPlane(m.canvas);
  const plain = isPlainMask(m);
  if (!plain) refineMask(R, W, H, m);
  const out = { ...m, canvas: planeCanvas(intersectAlpha(R, V), W, H), enabled: true };
  if (!plain) {
    delete out.density;
    delete out.feather;
  }
  return out;
}

function vectorMaskOp(app, arg, ctx) {
  const doc = app.doc;
  const layer = doc?.active;
  if (!layer) return;
  const op = typeof arg === 'string' ? arg : arg?.op;
  if (!VECTOR_OPS.includes(op)) return;
  const vm = layer.vectorMask;
  const needs = () => {
    if (vm) return true;
    app.dialogs.toast(`"${layer.name}" has no vector mask`, { kind: 'error', timeout: 1800 });
    return false;
  };
  switch (op) {
    case 'reveal-all':
    case 'hide-all':
      addVectorMask(app, layer, newVectorMask(op === 'reveal-all' ? 'reveal' : 'hide'), 'Add Vector Mask');
      return;
    case 'current-path': {
      const path = arg?.path ?? sourcePath(app);
      if (!path || isEmptyPath(path)) return app.dialogs.toast('Draw or choose a path first', { kind: 'error', timeout: 2000 });
      // the replay carries the path itself: the paths of another document are not this one's
      ctx?.setReplayArg?.({ op: 'current-path', path: clonePath(path) });
      addVectorMask(app, layer, newVectorMask('hide', path), 'Add Vector Mask');
      return;
    }
    case 'delete':
      if (needs()) deleteVectorMask(app, layer);
      return;
    case 'toggle':
      if (!needs() || refuseLocked(app, layer, 'vectorMask')) return;
      setLayerProps(app, layer, { vectorMask: { ...vm, enabled: vm.enabled === false } }, vm.enabled === false ? 'Enable Vector Mask' : 'Disable Vector Mask');
      return;
    case 'link':
      if (!needs()) return;
      setLayerProps(app, layer, { vectorMask: { ...vm, linked: vm.linked === false } }, vm.linked === false ? 'Link Vector Mask' : 'Unlink Vector Mask');
      return;
    case 'rasterize': {
      if (!needs() || refuseLocked(app, layer, 'vectorMask') || refuseLocked(app, layer, 'mask')) return;
      if (vm.enabled === false) return app.dialogs.toast('Enable the vector mask before rasterizing it', { kind: 'error', timeout: 2200 });
      if (app.ui.activePath?.kind === KIND) setActivePath(app, null);
      setLayerProps(app, layer, { mask: rasterizedMask(layer, doc), vectorMask: null }, 'Rasterize Vector Mask');
      return;
    }
    case 'target':
      if (!needs()) return;
      app.setEditingMask(false);
      setActivePath(app, { kind: KIND, layerId: layer.id });
      return;
    case 'select': {
      if (!needs()) return;
      const mode = ['add', 'subtract', 'intersect'].includes(arg?.mode) ? arg.mode : 'replace';
      // the path area as Photoshop loads it: the vector part whether or not it is enabled, without density or feather
      const shape = maskCanvasFor({ vectorMask: { ...vm, enabled: true, density: 1, feather: 0 }, version: -1 }, doc, { purpose: 'bake', parts: 'vector' }); // mask (K.1)
      const mask = shape ? alphaPlane(shape) : new Uint8ClampedArray(doc.width * doc.height).fill(255);
      app.applySelection(Selection.fromMask(doc.width, doc.height, mask), mode, 'Load Vector Mask');
      return;
    }
  }
}

/** Density and feather of the layer mask ('raster') or the vector mask ('vector'): one entry per slider drag. */
function maskProperties(app, arg) {
  const doc = app.doc;
  const layer = (arg?.layerId && doc?.find(arg.layerId)) || doc?.active;
  if (!layer || !arg || typeof arg !== 'object') return;
  const part = arg.part === 'vector' ? 'vector' : 'raster';
  const key = part === 'vector' ? 'vectorMask' : 'mask';
  const m = layer[key];
  if (!m) return;
  if (refuseLocked(app, layer, key)) return;
  if (part === 'raster' && arg.invert) return invertMask(app, layer, doc);
  if (part === 'raster' && arg.fromSelection) return maskFromSelection(app, layer, doc);
  const next = { ...m };
  if (arg.density !== undefined) next.density = maskDensity({ density: arg.density });
  if (arg.feather !== undefined) next.feather = maskFeather({ feather: arg.feather });
  if (next.density === maskDensity(m) && next.feather === maskFeather(m) && 'density' in m === 'density' in next && 'feather' in m === 'feather' in next) return;
  const what = arg.density !== undefined && arg.feather === undefined ? 'Density' : arg.feather !== undefined && arg.density === undefined ? 'Feather' : 'Properties';
  setLayerProps(app, layer, { [key]: next }, `${part === 'vector' ? 'Vector Mask' : 'Mask'} ${what}`, { merge: !!arg.merge });
}

/** Inverts the layer mask's pixels (Properties > Invert): one pixel entry. */
function invertMask(app, layer, doc) {
  const canvas = layer.mask?.canvas;
  if (!canvas) return;
  doc.history.pixels('Invert Mask', canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height }, (ctx) => {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = 255 - d[i + 3];
    }
    ctx.putImageData(img, 0, 0);
  }, { layer, kind: 'mask' });
  doc.changed('props', { layer });
}

/** The selection replaces the layer mask's pixels (Properties > Color Range…), and the selection is dropped. */
function maskFromSelection(app, layer, doc) {
  const sel = doc.selection;
  if (!sel || sel.isEmpty || !layer.mask) return;
  const W = doc.width, H = doc.height;
  const plane = new Uint8ClampedArray(W * H);
  const sm = sel.mask;
  if (sel.width === W && sel.height === H && sm?.length === plane.length) plane.set(sm);
  else for (let y = 0; y < Math.min(H, sel.height); y++) for (let x = 0; x < Math.min(W, sel.width); x++) plane[y * W + x] = sm[y * sel.width + x];
  doc.history.group('Mask from Color Range', () => {
    setLayerProps(app, layer, { mask: { ...layer.mask, canvas: planeCanvas(plane, W, H) } }, 'Mask from Color Range');
    app.applySelection(null, 'replace', 'Deselect');
  });
}

function makeMaskFromPath(app, ctx) {
  const layer = app.doc?.active;
  if (!layer) return app.dialogs.toast('Select a layer first', { kind: 'error', timeout: 1800 });
  const path = sourcePath(app);
  if (!path) return app.dialogs.toast('Draw or choose a path first', { kind: 'error', timeout: 2000 });
  ctx?.setReplayCommand?.('layer:vector-mask', { op: 'current-path', path: clonePath(path) });
  addVectorMask(app, layer, newVectorMask('hide', path), 'Add Vector Mask');
}

function makeShapeFromPath(app) {
  const path = sourcePath(app);
  if (!path || !app.doc) return app.dialogs.toast('Draw or choose a path first', { kind: 'error', timeout: 2000 });
  createShapeLayer(app, path, { name: 'Shape', label: 'New Shape Layer', style: { fill: { type: 'solid', color: app.settings.foreground }, stroke: null }, kind: 'path' });
}

async function overlayOptions(app, arg, ctx) {
  let v = arg && typeof arg === 'object' ? arg : null;
  const cur = overlaySettings(app);
  if (!v) {
    const values = await formDialog(app, {
      title: 'Layer Mask Display Options',
      fields: [
        { key: 'color', label: 'Colour', type: 'color', value: cur.overlayColor },
        { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, value: Math.round(cur.overlayOpacity * 100), unit: '%' },
      ],
    });
    if (!values) return ctx?.cancel?.();
    v = { color: values.color, opacity: Number(values.opacity) / 100 };
    ctx?.setReplayArg?.(v);
  }
  const color = typeof v.color === 'string' && HEX.test(v.color) ? v.color.toLowerCase() : cur.overlayColor;
  const o = Number(v.opacity);
  const opacity = Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : cur.overlayOpacity;
  await app.saveSettings({ masks: { ...(app.settings.masks ?? {}), overlayColor: color, overlayOpacity: opacity } });
  app.view?.invalidate();
}

// ---- preferences (L.2) ----------------------------------------------------------------------------------------

/** The 'masks' Preferences section: the colour and opacity of the mask overlay (settings.masks). */
export const masksPreferences = {
  id: 'masks',
  title: 'Masks',
  order: 60,
  fields: [
    { key: 'maskOverlayColor', label: 'Mask overlay colour', type: 'color' },
    { key: 'maskOverlayOpacity', label: 'Mask overlay opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
  ],
  read(s) {
    const o = overlaySettings({ settings: s });
    return { maskOverlayColor: o.overlayColor, maskOverlayOpacity: Math.round(o.overlayOpacity * 100) };
  },
  write(v, s) {
    const cur = overlaySettings({ settings: s });
    const color = typeof v.maskOverlayColor === 'string' && HEX.test(v.maskOverlayColor) ? v.maskOverlayColor.toLowerCase() : cur.overlayColor;
    const n = Number(v.maskOverlayOpacity);
    const opacity = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : cur.overlayOpacity;
    if (color === cur.overlayColor && opacity === cur.overlayOpacity) return {};
    return { masks: { ...(s.masks ?? {}), overlayColor: color, overlayOpacity: opacity } };
  },
};

// ---- icons ---------------------------------------------------------------------------------------------------

const ICONS = {
  'vector-mask': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 16l4-8 4 8z"/>',
  'mask-overlay': '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="4.5" fill="currentColor" fill-opacity="0.35"/>',
};

// ---- install -------------------------------------------------------------------------------------------------

export function install(app) {
  registerIcons(ICONS);
  registerTargetKind();
  registerPathButton({ key: 'makeMask', label: 'Mask', icon: 'mask', run: (a) => a.commands.run('path:make-mask', undefined, 'toolbar') });
  registerPathButton({ key: 'makeShape', label: 'Shape', icon: 'shape', run: (a) => a.commands.run('path:make-shape', undefined, 'toolbar') });

  const active = () => app.doc?.active ?? null;
  app.commands.registerAll({
    'layer:vector-mask': { enabled: () => !!active(), label: 'Vector Mask', run: (arg, ctx) => vectorMaskOp(app, arg, ctx) },
    'layer:mask-properties': { enabled: () => !!(active()?.mask || active()?.vectorMask), label: 'Mask Properties', run: (arg) => maskProperties(app, arg) },
    'layer:mask-overlay': {
      enabled: () => !!(active()?.mask || active()?.vectorMask),
      label: 'Mask Overlay',
      record: false,
      run: (arg) => {
        app.ui.showMaskOverlay = typeof arg === 'boolean' ? arg : !app.ui.showMaskOverlay;
        app.emit('mask:overlay', app.ui.showMaskOverlay);
        app.view?.invalidate();
        app.properties?.render?.();
      },
    },
    'layer:mask-overlay-options': { enabled: () => true, dialog: true, record: false, label: 'Mask Overlay Options…', run: (arg, ctx) => overlayOptions(app, arg, ctx) },
    'path:make-mask': { enabled: () => !!active() && !!sourcePath(app), label: 'Make Vector Mask', run: (arg, ctx) => makeMaskFromPath(app, ctx) },
    'path:make-shape': { enabled: () => !!app.doc && !!sourcePath(app), label: 'Make Shape Layer', run: () => makeShapeFromPath(app) },
  });

  app.preferences?.registerSection(masksPreferences);

  // the vector mask chosen as a path belongs to its layer: choosing another layer drops it (as for shape paths)
  app.on('layer:activated', ({ layer } = {}) => {
    const ap = app.ui.activePath;
    if (ap?.kind === KIND && ap.layerId !== layer?.id) setActivePath(app, null);
  });
  // the overlay is a view of the active layer's mask: it goes away with the last mask
  app.on('doc:change', (e) => {
    if (app.ui.showMaskOverlay && (e.kind === 'props' || e.kind === 'active' || e.kind === 'history') && !(app.doc?.active?.mask || app.doc?.active?.vectorMask)) app.ui.showMaskOverlay = false;
  });
}
