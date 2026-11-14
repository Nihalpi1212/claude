// Layer commands (Layer menu, Layers panel buttons, shortcuts). Structural changes record a
// snapshot of the tree so undo restores it exactly; layer pixels are never mutated by structural
// operations (merges create new layers), so the snapshots stay valid.
import { RasterLayer, GroupLayer, FillLayer, AdjustmentLayer, createCanvas, copyCanvas, intersectRect, unionRect, BLEND_LABELS, newId, isDefaultBlending, effectiveBlending } from './document.js';
import { Compositor } from './compositor.js';
import { contentBounds } from '../../shared/pixels/core.js';
import { isDefaultBlendIf, restrictsChannels } from '../../shared/pixels/blend-if.js';
import { hasEnabledStyles } from '../../shared/pixels/styles.js';
import { offsetEach, positionLocked } from './layer-move.js';
import { Selection } from './selection.js';
import { maskCanvasFor } from './mask-render.js';
import { createPaint, resolvePaint, paintEditor } from './paint-editors.js';
import { normaliseLabel } from './layers-extras/tags.js';
import { neutralFill, arrangeChildren, distributeMoves, clippedAbove } from './layer-menu-model.js';
import { shapeContentBounds } from './path-ops.js';

// ---- snapshots ----------------------------------------------------------------------------------------------

export function snapshotTree(doc) {
  const groups = [];
  const walk = (g) => {
    // transform previews and the quick mask layer are never part of a recorded state
    groups.push([g, g.children.filter((c) => !c.preview && !c.quickMask)]);
    for (const c of g.children) if (c.isGroup) walk(c);
  };
  walk(doc.root);
  // the clip flag is the one property structural commands change (a moved layer loses its base)
  const clips = groups.flatMap(([, children]) => children.map((c) => [c, c.clip]));
  return { root: doc.root, groups, clips, active: doc.active, selected: [...doc.selected], width: doc.width, height: doc.height };
}

export function restoreTree(doc, snap) {
  doc.root = snap.root;
  for (const [g, children] of snap.groups) {
    g.children = children.slice();
    for (const c of g.children) c.parent = g;
    g.touch();
  }
  doc.root.parent = null;
  for (const [l, clip] of snap.clips ?? []) l.clip = clip;
  const sizeChanged = doc.width !== snap.width || doc.height !== snap.height;
  doc.width = snap.width;
  doc.height = snap.height;
  for (const l of doc.layers()) {
    if (l.type === 'fill') {
      l.docWidth = doc.width;
      l.docHeight = doc.height;
    }
    l.touch();
  }
  doc.active = snap.active;
  doc.selected = new Set(snap.selected);
  doc.changed(sizeChanged ? 'canvas' : 'tree');
}

/**
 * Runs a structural mutation as one undoable entry. opts.bytes (number or function evaluated after
 * the mutation) tells the history how much memory the entry keeps alive.
 */
// `made`: the layer a tool (not a command) made with this entry: the actions recorder then waits for the tool's
// 'layer:made' event to record it as a step, instead of calling it a tool stroke (lib/actions.js)
export function structural(app, label, mutate, doc = app.doc, { bytes = 0, made = null } = {}) {
  const before = snapshotTree(doc);
  const extras = () => ({ selection: doc.selection, savedSelection: doc.savedSelection ?? null, store: doc.store.snapshot(), channels: doc.channels.slice(), paths: doc.paths.slice(), workPath: doc.workPath ?? null, dpi: doc.dpi });
  const extraBefore = extras();
  const result = mutate();
  if (result === false) return false;
  const after = snapshotTree(doc);
  const extraAfter = extras();
  const apply = (snap, extra) => {
    restoreTree(doc, snap);
    doc.selection = extra.selection;
    doc.savedSelection = extra.savedSelection;
    doc.store.restore(extra.store);
    doc.channels = extra.channels.slice();
    doc.paths = extra.paths.slice();
    doc.workPath = extra.workPath;
    doc.dpi = extra.dpi;
    doc.changed('selection');
  };
  doc.history.push({ label, undo: () => apply(before, extraBefore), redo: () => apply(after, extraAfter), bytes: typeof bytes === 'function' ? bytes() : bytes, at: Date.now(), ...(made ? { made } : {}) });
  restoreTree(doc, after);
  doc.changed('history');
  return result;
}

// a text layer's 0.3 views (`text`, `font`) and the 0.4 fields they are computed from (ARCHITECTURE.md "0.4", A)
/** Layer > Distribute's arguments (0.3 knew only 'horizontal' and 'vertical'). */
const DISTRIBUTE_EDGES = new Set(['top', 'vcenter', 'bottom', 'left', 'hcenter', 'right', 'horizontal', 'vertical']);
/** Layer > Layer Mask items that add a mask (the Background turns into a layer first). */
const ADD_MASK_OPS = new Set(['reveal-all', 'hide-all', 'reveal-selection', 'hide-selection', 'from-transparency']);
/** Layer > Rasterize's arguments: which layers each item rasterizes. */
const RASTER_KINDS = { type: (l) => l.type === 'text', shape: (l) => l.type === 'shape', fill: (l) => l.type === 'fill', smart: (l) => l.type === 'smart' };
const TEXT_VIEWS = new Set(['font', 'text', 'content']);
const TEXT_FIELDS = new Set(['font', 'text', 'content', 'typeOptions', 'height']);

/**
 * Undoable property change on a layer: patch is { key: value } (nested objects replaced whole). A text layer patch
 * with `font`, `text` or `content` records `content`, `typeOptions` and `height` before and after, so undo restores
 * the formatting exactly whatever the patch was (assigning `font` or `text` rewrites the content).
 */
export function setLayerProps(app, layer, patch, label = 'Layer properties', { merge = false, mergeKey = null } = {}) {
  const doc = app.doc;
  const keys = Object.keys(patch);
  const textual = layer.type === 'text' && keys.some((k) => TEXT_VIEWS.has(k));
  const recorded = textual ? [...keys.filter((k) => !TEXT_FIELDS.has(k)), 'content', 'typeOptions', 'height'] : keys;
  const before = {};
  for (const k of recorded) before[k] = clone(layer[k]);
  const apply = (values) => {
    for (const [k, v] of Object.entries(values)) layer[k] = clone(v);
    layer.touch();
    doc.changed('props', { layer });
  };
  apply(patch);
  let after = patch;
  if (textual) {
    after = {};
    for (const k of recorded) after[k] = clone(layer[k]);
  }
  // consecutive changes of the same property (slider drags) merge into one entry; a caller whose patch key holds
  // several settings (a mask's density, feather and path all live in `vectorMask`) names the setting in mergeKey
  const key = `${layer.id}:${keys.join(',')}${mergeKey ? `:${mergeKey}` : ''}`;
  const last = doc.history.entries[doc.history.index];
  if (merge && !doc.history.batch && last?.mergeKey === key && Date.now() - last.at < 1500) {
    doc.history.merge(() => apply(after));
    return;
  }
  doc.history.push({ label, undo: () => apply(before), redo: () => apply(after), bytes: 0, at: Date.now(), mergeKey: key });
}

/**
 * The same property change on several layers (M.3): one history entry. patchOrFn is a patch or (layer) -> patch
 * (null skips that layer). The merge key is the sorted ids plus the patch keys, so a scrubby Opacity drag over three
 * selected layers is one entry, as it is for one layer (setLayerProps' key is `${id}:${keys}`, the same form).
 */
export function setLayersProps(app, layers, patchOrFn, label = 'Layer properties', { merge = false } = {}) {
  const doc = app.doc;
  const list = [...new Set((layers ?? []).filter(Boolean))];
  if (!doc || !list.length) return;
  const patchFor = (l) => (typeof patchOrFn === 'function' ? patchOrFn(l) : patchOrFn);
  const work = list.map((l) => [l, patchFor(l)]).filter(([, p]) => p && Object.keys(p).length);
  if (!work.length) return;
  if (work.length === 1) {
    setLayerProps(app, work[0][0], work[0][1], label, { merge });
    return;
  }
  const items = work.map(([layer, patch]) => {
    const keys = Object.keys(patch);
    const textual = layer.type === 'text' && keys.some((k) => TEXT_VIEWS.has(k));
    const recorded = textual ? [...keys.filter((k) => !TEXT_FIELDS.has(k)), 'content', 'typeOptions', 'height'] : keys;
    const before = {};
    for (const k of recorded) before[k] = clone(layer[k]);
    return { layer, patch, keys, textual, recorded, before, after: patch };
  });
  const apply = (which) => {
    for (const it of items) {
      for (const [k, v] of Object.entries(it[which])) it.layer[k] = clone(v);
      it.layer.touch();
    }
    for (const it of items) doc.changed('props', { layer: it.layer });
  };
  apply('patch');
  for (const it of items) {
    if (!it.textual) continue;
    it.after = {};
    for (const k of it.recorded) it.after[k] = clone(it.layer[k]);
  }
  const keyNames = [...new Set(items.flatMap((it) => it.keys))].sort();
  const key = `${items.map((it) => it.layer.id).sort().join(',')}:${keyNames.join(',')}`;
  const last = doc.history.entries[doc.history.index];
  // inside a history group the last entry is not this command's: never merge into it
  if (merge && !doc.history.batch && last?.mergeKey === key && Date.now() - last.at < 1500) {
    doc.history.merge(() => apply('after'));
    return;
  }
  doc.history.push({ label, undo: () => apply('before'), redo: () => apply('after'), bytes: 0, at: Date.now(), mergeKey: key });
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof HTMLCanvasElement) return v;
  // frozen values (the rich-text content of a text layer) are immutable: shared, never copied
  if (Object.isFrozen(v)) return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = x instanceof HTMLCanvasElement ? x : clone(x);
  return out;
}

// ---- helpers --------------------------------------------------------------------------------------------------

export function nextLayerName(doc, base = 'Layer') {
  const used = new Set(doc.layers().map((l) => l.name));
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Deep copy of a layer (pixels, mask, styles, children). */
/** The Photoshop "Background": the bottom layer of the document, a raster layer named Background (lib/layers-extras/structure.js). */
const isBackground = (layer) => layer.type === 'raster' && layer.name === 'Background' && !!layer.parent && !layer.parent.parent && layer.parent.children[0] === layer;

/**
 * Layer links (layer.linked, lib/layers-extras/tags.js) of layers that were copied together: the copies are linked
 * to each other under new set ids, never to their originals; a copy whose partners were not copied is not linked.
 */
export function relinkCopies(copies) {
  const all = [];
  const walk = (l) => {
    all.push(l);
    if (l.isGroup) l.children.forEach(walk);
  };
  copies.forEach(walk);
  const count = new Map();
  for (const l of all) if (l.linked) count.set(l.linked, (count.get(l.linked) ?? 0) + 1);
  const fresh = new Map();
  for (const l of all) {
    if (!l.linked) continue;
    if (count.get(l.linked) < 2) l.linked = null;
    else l.linked = fresh.get(l.linked) ?? fresh.set(l.linked, newId('K')).get(l.linked);
  }
  return copies;
}

/**
 * @param {{ name?: string, relink?: boolean }} opts  relink: false when several layers are cloned as one set; the
 *   caller then passes all the copies to relinkCopies() so links between them survive
 */
export function cloneLayer(layer, { name, relink = true } = {}) {
  // a copy of the Background is an ordinary layer: it does not inherit the locks that pin the Background down
  const locked = isBackground(layer) ? { ...layer.locked, position: false, transparency: false, all: false } : { ...layer.locked, all: false };
  const props = { name: name ?? `${layer.name} copy`, visible: layer.visible, opacity: layer.opacity, fillOpacity: layer.fillOpacity, blend: layer.blend, locked, clip: layer.clip, styles: layer.styles ? JSON.parse(JSON.stringify(layer.styles)) : null,
    // 0.4 fields (J.1): deep copies, so editing the copy's vector mask or blending never reaches the original
    vectorMask: layer.vectorMask ? JSON.parse(JSON.stringify(layer.vectorMask)) : null, blending: layer.blending ? JSON.parse(JSON.stringify(layer.blending)) : null };
  let copy;
  switch (layer.type) {
    case 'raster':
      copy = new RasterLayer({ ...props, canvas: copyCanvas(layer.canvas), x: layer.x, y: layer.y });
      if (layer.deep) copy.deep = { type: layer.deep.type, data: layer.deep.data.slice() }; // 16/32-bit pixels (lib/depth.js)
      break;
    case 'group':
      copy = new GroupLayer({ ...props, expanded: layer.expanded });
      for (const c of layer.children) {
        const cc = cloneLayer(c, { name: c.name, relink: false });
        cc.parent = copy;
        copy.children.push(cc);
      }
      break;
    default: {
      const desc = JSON.parse(JSON.stringify({ ...layer, parent: undefined, mask: undefined, _cache: undefined, canvas: undefined, frame: undefined }));
      copy = new layer.constructor({ ...desc, ...props, id: undefined });
      if (layer.type === 'fill' && layer.paint?.pattern?.canvas) copy.paint = { ...layer.paint, pattern: { ...layer.paint.pattern } };
      if (layer.type === 'shape') copy.path = JSON.parse(JSON.stringify(layer.path));
    }
  }
  if (layer.mask) copy.mask = { ...layer.mask, canvas: copyCanvas(layer.mask.canvas) };
  // the colour label and the link set (lib/layers-extras/tags.js) are not constructor properties
  copy.color = layer.color ?? null;
  copy.linked = layer.linked ?? null;
  copy.loneLink = null; // tags.js' memory of a dissolved link belongs to the original alone
  if (relink) relinkCopies([copy]);
  return copy;
}

/** Renders any non-group layer to a raster layer in document space (styles baked in when asked). */
export function rasterizeLayer(layer, doc, { bakeStyles = false } = {}) {
  let canvas, x, y;
  if (layer.isGroup || bakeStyles) {
    // styles are baked with neutral opacity/blend (those stay live on the new layer); the mask shapes the
    // effects, so it is rendered in and not kept
    // the bake renders the raster mask only (K.1 parts 'raster'): the vector mask stays live on the result // mask (K.1)
    const saved = { opacity: layer.opacity, blend: layer.blend, vectorMask: layer.vectorMask ?? null, blending: layer.blending ?? null };
    if (!layer.isGroup) {
      layer.opacity = 1;
      layer.blend = 'normal';
      // knockout, Blend If and the channels work against what lies below, which a bake against transparency cannot
      // see: they are left out of the bake and stay live on the result (the options the effects consume stay in)
      if (layer.blending) layer.blending = { ...layer.blending, knockout: 'none', blendIf: null, channels: null };
    }
    layer.vectorMask = null;
    layer.touch();
    try {
      canvas = renderLayersFlat(doc, [layer], { dest: layer.parent });
    } finally {
      if (!layer.isGroup) Object.assign(layer, saved);
      else layer.vectorMask = saved.vectorMask;
      layer.touch();
    }
    x = 0;
    y = 0;
  } else if (layer.type === 'raster') {
    canvas = copyCanvas(layer.canvas);
    x = layer.x;
    y = layer.y;
  } else if (layer.render) {
    // the whole layer, canvas edges included (a smart object's view render is clipped to the canvas)
    const r = layer.render({ full: true });
    canvas = copyCanvas(r.canvas);
    x = r.x;
    y = r.y;
  } else return null;
  // the advanced blending options stay with the layer (a group's are baked by renderLayersFlat, like its opacity)
  const blending = layer.isGroup ? null : layer.blending;
  const out = new RasterLayer({ name: layer.name, canvas, x, y, opacity: layer.isGroup ? 1 : layer.opacity, blend: layer.isGroup ? 'normal' : layer.blend, visible: layer.visible, clip: layer.clip, styles: bakeStyles ? null : layer.styles, fillOpacity: bakeStyles ? 1 : layer.fillOpacity, blending });
  if (layer.mask && !layer.isGroup && !bakeStyles) out.mask = { ...layer.mask, canvas: copyCanvas(layer.mask.canvas) };
  // the vector mask stays live, also when the styles and the raster mask are baked (K.1: bakes use parts 'raster')
  if (layer.vectorMask) out.vectorMask = JSON.parse(JSON.stringify(layer.vectorMask));
  return out;
}

/**
 * Composites the given layers (in document order) into one document-sized canvas. Groups above
 * `dest` (where the result will live) are neutral: their opacity, blend, mask and styles keep
 * applying to the result once it is placed; other groups' properties are baked in.
 */
export function renderLayersFlat(doc, layers, { dest = null } = {}) {
  const set = new Set();
  const addWithChildren = (l) => {
    set.add(l);
    if (l.isGroup) l.children.forEach(addWithChildren);
  };
  layers.forEach(addWithChildren);
  const target = dest ?? layers[0]?.parent ?? doc.root;
  const ancestors = [];
  for (const l of [...set]) for (let p = l.parent; p && p !== doc.root; p = p.parent) if (!set.has(p)) {
    set.add(p);
    if (p === target || isAncestor(p, target)) ancestors.push(p);
  }
  // a clipped layer whose base is not rendered keeps its pixels (drawn unclipped)
  const baseOf = (l) => {
    const k = l.parent?.children ?? [];
    let i = k.indexOf(l) - 1;
    while (i >= 0 && k[i].clip) i--;
    return k[i] ?? null;
  };
  const orphans = [...set].filter((l) => l.clip && !ancestors.includes(l) && !set.has(baseOf(l)));
  // the 0.4 vector mask and blending options of those groups keep applying too (J.1)
  const saved = ancestors.map((g) => ({ g, opacity: g.opacity, blend: g.blend, mask: g.mask, styles: g.styles, vectorMask: g.vectorMask, blending: g.blending }));
  for (const g of ancestors) Object.assign(g, { opacity: 1, blend: 'pass-through', mask: null, styles: null, vectorMask: null, blending: null });
  for (const l of orphans) l.clip = false;
  try {
    const skip = new Set(doc.layers().filter((l) => !set.has(l)));
    return copyCanvas(new Compositor().composite(doc, { skip }));
  } finally {
    for (const s of saved) Object.assign(s.g, { opacity: s.opacity, blend: s.blend, mask: s.mask, styles: s.styles, vectorMask: s.vectorMask, blending: s.blending });
    for (const l of orphans) l.clip = true;
  }
}

/** Clears the clip flag of layers that no longer have a base below them (Photoshop releases such clipping masks). */
export function releaseOrphanClips(doc) {
  const walk = (group) => {
    let base = false;
    for (const l of group.children) {
      if (l.clip && !base) l.clip = false;
      if (!l.clip) base = true;
      if (l.isGroup) walk(l);
    }
  };
  walk(doc.root);
}

function selectedOrActive(doc) {
  const sel = doc.selectedLayers();
  return sel.length ? sel : doc.active ? [doc.active] : [];
}

/** The picked layers without those inside another picked group (they go with their group). */
function topLevel(layers) {
  return layers.filter((l) => !layers.some((o) => o !== l && isAncestor(o, l)));
}

/** True when the Background rules (app.backgroundRules, L.13) or Lock All lock `prop` on the layer. */
export function lockedProp(app, layer, prop) {
  return !!layer && (app.backgroundRules?.lockedProps?.(layer) ?? []).includes(prop);
}

/** True when the layer has effects or blending options that differ from a plain layer's (what Copy Layer Style takes). */
function hasLayerStyle(layer) {
  if (!layer || layer.type === 'adjustment') return false;
  return !!layer.styles || (layer.fillOpacity ?? 1) < 1 || !isDefaultBlending(layer.blending) || !['normal', 'pass-through'].includes(layer.blend ?? 'normal');
}

/** Where the layer dialogs open (M.3): only from the menu or a key without an argument, or with { dialog: true }. */
const DIALOG_SOURCES = new Set(['menu', 'menu-key', 'key']);
export function wantsDialog(arg, ctx) {
  if (arg && typeof arg === 'object') return arg.dialog === true;
  return arg === undefined && DIALOG_SOURCES.has(ctx?.source);
}

const clampPercent = (v, fallback = 100) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
};
const LAYER_BLENDS = new Set(Object.keys(BLEND_LABELS).filter((m) => m !== 'pass-through'));
/** A blend mode the layer can take: 'pass-through' only for groups. */
const blendFits = (layer, mode) => (mode === 'pass-through' ? !!layer?.isGroup : LAYER_BLENDS.has(mode));

// ---- install ------------------------------------------------------------------------------------------------

export function install(app) {
  const has = () => !!app.doc;
  const hasLayer = () => !!app.doc?.active;
  const doc = () => app.doc;
  // which layers take effects and blending options (blending-options.js isStyleable: not adjustment layers, not the Background)
  const takesStyle = (l) => !!l?.parent && l.type !== 'adjustment' && !lockedProp(app, l, 'styles');

  app.duplicateLayer = (layer, { select = true } = {}) => {
    const d = doc();
    const copy = cloneLayer(layer);
    const parent = layer.parent, index = parent.children.indexOf(layer) + 1;
    structural(app, 'Duplicate layer', () => {
      d.add(copy, parent, index);
      if (select) d.setActive(copy);
    });
    return copy;
  };

  app.rasterizePrompt = async (layer) => {
    const kind = { text: 'type', shape: 'shape', fill: 'fill', adjustment: 'adjustment' }[layer.type] ?? layer.type;
    if (layer.type === 'adjustment' || layer.isGroup) {
      app.dialogs.toast(layer.isGroup ? 'Select a layer inside the group to paint on' : 'Adjustment layers have no pixels: paint on their mask instead', { kind: 'error', timeout: 2500 });
      return false;
    }
    const ok = await app.dialogs.confirm(`This ${kind} layer must be rasterized before you can paint on it. It will no longer be editable as ${kind}.`, { title: 'Rasterize layer', okLabel: 'Rasterize' });
    if (!ok) return false;
    app.commands.run('layer:rasterize', { ids: [layer.id] }, 'api');
    return true;
  };

  const newRaster = (name) => {
    const d = doc();
    return new RasterLayer({ name: name ?? nextLayerName(d), width: d.width, height: d.height, x: 0, y: 0 });
  };

  // 0.3's Merge Down, shared by layer:merge-down and the skeleton's layer:merge (Ctrl+E)
  const mergeDown = {
    enabled: () => {
      const l = doc()?.active;
      return !!l && l.parent && l.parent.children.indexOf(l) > 0;
    },
    run: () => {
      const d = doc();
      const top = d.active;
      const below = top.parent.children[top.parent.children.indexOf(top) - 1];
      if (!below || below.type === 'adjustment') return app.dialogs.toast('Nothing to merge into: the layer below is an adjustment layer', { kind: 'error' });
      if (!top.visible || !below.visible) return app.dialogs.toast('Show both layers before merging', { kind: 'error' });
      // the result replaces the lower layer's pixels: a pixel lock on it refuses the merge (Photoshop: "the target layer
      // is locked"), as painting, filters and Fill refuse it
      if (pixelsLocked(below)) return app.dialogs.toast('Could not merge down: the layer below is locked', { kind: 'error', timeout: 2400 });
      mergeLayers([below, top], below.name, 'Merge down', { keepBase: true });
    },
  };

  // Merge Clipping Mask (what Ctrl+E does on the base of a clipping mask): the base and the layers clipped to it become
  // one layer in the base's place, keeping its name, blend mode and opacity, so the picture does not change
  const mergeClipping = {
    enabled: () => clippedAbove(doc()?.active).length > 0,
    run: () => {
      const d = doc();
      const base = d.active;
      const clipped = clippedAbove(base);
      if (!clipped.length) return;
      // an adjustment layer has no pixels to merge into: the merge would turn it into an empty layer and its
      // adjustment would stop acting on the layers below (Merge Down refuses an adjustment layer below the same way)
      if (base.type === 'adjustment') return app.dialogs.toast('Could not merge the clipping mask: the base layer is an adjustment layer', { kind: 'error', timeout: 2400 });
      if (pixelsLocked(base)) return app.dialogs.toast('Could not merge the clipping mask: the base layer is locked', { kind: 'error', timeout: 2400 });
      // the base's knockout, Blend If and channels stay live on the result (mergeLayers keepBlending). They act on the
      // whole clipping group already, so the picture stays the same, except where they also reach what the merge
      // renders in: the exterior effects (which Blend If leaves alone), clipped layers blended outside the group, and
      // a knockout under reduced fill
      const bl = effectiveBlending(base);
      const blendIf = !isDefaultBlendIf(bl.blendIf);
      const outside = bl.clippedAsGroup === false && (blendIf || restrictsChannels(bl.channels));
      const changes = outside || (blendIf && hasEnabledStyles(base.styles)) || (bl.knockout !== 'none' && (base.fillOpacity ?? 1) < 1);
      mergeLayers([base, ...clipped], base.name, 'Merge clipping mask', { keepBase: true, keepBlending: true });
      // (a refused merge, such as one with hidden layers, leaves the base active)
      if (changes && d.active !== base) app.dialogs.toast('The merged layer keeps the Blend If, knockout and channel settings of the base, which now also act on the clipped layers and effects, so the image can change', { timeout: 4000 });
    },
  };
  /** A pixel lock (or Lock All) on the layer a merge would write into. */
  const pixelsLocked = (l) => !!(l?.locked?.pixels || l?.locked?.all);

  app.commands.registerAll({
    // New Layer, New Group and Duplicate Layer (M.3): their dialogs (lib/layer-dialogs.js) open only from the menu or a
    // key without an argument, or with { dialog: true }; the API, actions and the Layers panel create without asking.
    // A dialog reports the fields it applied through ctx.setReplayArg, so an action replays them without asking.
    'layer:new': {
      enabled: has,
      run: async (arg, ctx) => {
        let o = arg && typeof arg === 'object' ? { ...arg } : {};
        if (wantsDialog(arg, ctx)) {
          const r = await askLayer('newLayer', { doc: doc(), values: o });
          if (!r) return ctx?.cancel(); // actions (lib/actions.js)
          o = { ...o, ...r };
          ctx?.setReplayArg(newLayerArg(o)); // actions (lib/actions.js): the chosen fields replay without the dialog
        }
        return createLayer(o);
      },
    },
    'layer:new-group': {
      enabled: has,
      run: async (arg, ctx) => {
        let o = arg && typeof arg === 'object' ? { ...arg } : {};
        if (wantsDialog(arg, ctx)) {
          const r = await askLayer('newGroup', { doc: doc(), values: o });
          if (!r) return ctx?.cancel(); // actions (lib/actions.js)
          o = { ...o, ...r };
          ctx?.setReplayArg(newGroupArg(o)); // actions (lib/actions.js)
        }
        return createGroup(o);
      },
    },
    'layer:via-copy': { enabled: hasLayer, run: () => viaCopy(false) },
    'layer:via-cut': { enabled: hasLayer, run: () => viaCopy(true) },
    'layer:duplicate': {
      enabled: hasLayer,
      run: async (arg, ctx) => {
        const d = doc();
        const layers = topLevel(selectedOrActive(d));
        if (!layers.length) return ctx?.cancel();
        let o = arg && typeof arg === 'object' ? { ...arg } : {};
        if (wantsDialog(arg, ctx)) {
          const r = await askLayer('duplicate', { doc: d, layers, values: o });
          if (!r) return ctx?.cancel(); // actions (lib/actions.js)
          o = { ...o, ...r };
          ctx?.setReplayArg(duplicateArg(o, d)); // actions (lib/actions.js)
        }
        return duplicateLayers(d, layers, o, ctx);
      },
    },
    'layer:delete': {
      enabled: hasLayer,
      run: () => {
        const d = doc();
        const layers = selectedOrActive(d);
        if (!layers.length) return;
        structural(app, layers.length > 1 ? 'Delete layers' : 'Delete layer', () => {
          for (const l of layers) if (l.parent) d.remove(l);
          releaseOrphanClips(d);
        });
        app.setEditingMask(false);
      },
    },
    'layer:rename': {
      enabled: hasLayer,
      dialog: true, // actions (lib/actions.js)
      run: async (arg, ctx) => {
        const d = doc();
        // actions (lib/actions.js): a recorded { id, name } replays on the active layer of another document
        const layer = arg?.id ? d.find(arg.id) ?? (ctx?.source === 'action' ? d.active : null) : d.active;
        if (!layer) return ctx?.cancel();
        let name = arg?.name;
        if (!name) {
          name = await app.dialogs.prompt('Layer name', { title: 'Rename Layer', value: layer.name });
          if (!name) return ctx?.cancel(); // actions (lib/actions.js)
          ctx?.setReplayArg({ name }); // actions (lib/actions.js)
        }
        setLayerProps(app, layer, renamePatch(layer, name), 'Rename layer');
      },
    },
    // Hide / Show Layers (Ctrl+,) on every selected layer: they all take the opposite of the active layer's state.
    // A layer id (the Layers panel's eye) toggles that layer alone, as in 0.3; { ids?, visible } says it exactly.
    'layer:visibility': {
      enabled: hasLayer,
      run: (arg) => {
        const d = doc();
        if (typeof arg === 'string') {
          const layer = d.find(arg);
          if (layer) setLayerProps(app, layer, { visible: !layer.visible }, layer.visible ? 'Hide layer' : 'Show layer');
          return;
        }
        const o = arg && typeof arg === 'object' ? arg : {};
        const layers = targets(o.ids);
        if (!layers.length) return;
        const lead = layers.includes(d.active) ? d.active : layers[0];
        const visible = typeof o.visible === 'boolean' ? o.visible : !lead.visible;
        const change = layers.filter((l) => l.visible !== visible);
        const several = change.length > 1;
        setLayersProps(app, change, { visible }, visible ? (several ? 'Show layers' : 'Show layer') : several ? 'Hide layers' : 'Hide layer');
      },
    },
    'layer:solo': {
      enabled: hasLayer,
      run: (id) => {
        const d = doc();
        const layer = d.find(id) ?? d.active;
        const others = d.layers().filter((l) => l !== layer && !isAncestor(l, layer) && !isAncestor(layer, l));
        const allHidden = others.every((l) => !l.visible || l.isGroup);
        d.history.group('Show only this layer', () => {
          if (allHidden) {
            // un-solo: back to what was visible before the solo (layers hidden by the user stay hidden)
            const remembered = d.soloState?.layer === layer ? d.soloState.visible : null;
            for (const l of others) setLayerProps(app, l, { visible: remembered?.has(l) ? remembered.get(l) : true });
            d.soloState = null;
          } else {
            d.soloState = { layer, visible: new Map(others.map((l) => [l, l.visible])) };
            for (const l of others) if (l.visible && !l.isGroup) setLayerProps(app, l, { visible: false });
            setLayerProps(app, layer, { visible: true });
          }
        });
      },
    },
    // Opacity, Fill, blend mode, locks and clipping (M.3): on the selected layers by default; { ids?, value } names
    // them (the Layers panel passes its ids); a plain value keeps its 0.3 meaning. One history entry, merging while a
    // slider or a scrubby label is dragged. The Background's rules (L.13) keep its opacity, fill and blend mode.
    'layer:opacity': {
      enabled: hasLayer,
      run: (arg) => setPercent(arg, 'opacity', 'Opacity'),
    },
    'layer:fill-opacity': {
      enabled: hasLayer,
      run: (arg) => setPercent(arg, 'fillOpacity', 'Fill opacity'),
    },
    'layer:blend': {
      enabled: hasLayer,
      run: (arg) => {
        const { layers, value: mode } = targetsAndValue(arg);
        if (!mode || !(BLEND_LABELS[mode] || mode === 'pass-through')) return;
        const free = refuseLocked(layers, 'blend');
        setLayersProps(app, free.filter((l) => l.blend !== mode && blendFits(l, mode)), { blend: mode }, `Blend mode: ${BLEND_LABELS[mode] ?? mode}`);
      },
    },
    'layer:lock': {
      enabled: hasLayer,
      run: (arg) => {
        const d = doc();
        const { layers, value } = targetsAndValue(arg);
        if (!layers.length) return;
        let patchFor;
        if (typeof value === 'string') {
          // a toggle: every layer takes the opposite of the active layer's lock
          const lead = layers.includes(d.active) ? d.active : layers[0];
          if (!(value in lead.locked)) return;
          const on = !lead.locked[value];
          patchFor = (l) => (!!l.locked[value] === on ? null : { locked: { ...l.locked, [value]: on } });
        } else if (value && typeof value === 'object') {
          const set = Object.fromEntries(Object.entries(value).filter(([k, v]) => ['pixels', 'position', 'transparency', 'all'].includes(k) && typeof v === 'boolean'));
          patchFor = (l) => (Object.entries(set).every(([k, v]) => !!l.locked[k] === v) ? null : { locked: { ...l.locked, ...set } });
        } else return;
        setLayersProps(app, layers, patchFor, 'Lock');
      },
    },
    'layer:clip': {
      enabled: () => !!doc()?.active && doc().indexOf(doc().active) > 0,
      run: (arg) => {
        const d = doc();
        const layer = (arg && typeof arg === 'object' && arg.id ? d.find(arg.id) : null) ?? d.active;
        if (!layer) return;
        if (layer.parent.children.indexOf(layer) === 0 && !layer.clip) return app.dialogs.toast('A clipping mask needs a layer below it', { kind: 'error' });
        setLayerProps(app, layer, { clip: !layer.clip }, layer.clip ? 'Release clipping mask' : 'Create clipping mask');
      },
    },
    'layer:group': {
      enabled: hasLayer,
      run: () => {
        const d = doc();
        const picked = selectedOrActive(d);
        // a layer whose group is also selected moves with its group; the Background never goes into a group (L.13)
        const all = topLevel(picked);
        const layers = all.filter((l) => !isBackground(l));
        if (!layers.length) {
          if (all.length) app.dialogs.toast('The Background layer cannot go into a group: use Layer from Background first', { kind: 'error', timeout: 2600 });
          return;
        }
        // keep document order (bottom -> top) and insert the group where the topmost was
        const order = d.layers();
        layers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const top = layers[layers.length - 1];
        const g = new GroupLayer({ name: nextLayerName(d, 'Group') });
        structural(app, 'Group layers', () => {
          const parent = top.parent;
          const index = parent.children.indexOf(top) + 1;
          d.add(g, parent, index);
          for (const l of layers) d.move(l, g, g.children.length);
          releaseOrphanClips(d);
          d.setActive(g);
        });
      },
    },
    'layer:ungroup': {
      enabled: () => !!doc()?.active?.isGroup,
      run: () => {
        const d = doc();
        const g = d.active;
        structural(app, 'Ungroup layers', () => {
          const parent = g.parent;
          let index = parent.children.indexOf(g);
          const kids = g.children.slice();
          for (const c of kids) d.move(c, parent, index++);
          d.remove(g);
          releaseOrphanClips(d);
          d.selected.clear();
          kids.forEach((k) => d.selected.add(k));
          d.active = kids[kids.length - 1] ?? null;
        });
      },
    },
    'layer:arrange': { enabled: hasLayer, run: (where) => arrange(where) },
    'layer:arrange-front': { enabled: hasLayer, run: () => arrange('front') },
    'layer:arrange-forward': { enabled: hasLayer, run: () => arrange('forward') },
    'layer:arrange-backward': { enabled: hasLayer, run: () => arrange('backward') },
    'layer:arrange-back': { enabled: hasLayer, run: () => arrange('back') },
    'layer:arrange-reverse': {
      enabled: () => (doc()?.selected.size ?? 0) > 1,
      run: () => arrange('reverse'),
    },
    'layer:move-to': {
      enabled: has,
      // { id, target, mode, duplicate } (0.3) or { ids: [...], target, mode, duplicate } (0.4, M.3: several layers in one
      // entry, their stacking order kept)
      run: ({ id, ids, target, mode, duplicate } = {}) => {
        const d = doc();
        const t = d.find(target);
        if (!t) return;
        const order = d.layers();
        const wanted = (Array.isArray(ids) ? ids : [id]).map((x) => d.find(x)).filter((l) => l && l !== t);
        // a layer inside another moved group moves with it; bottom first, so the stack keeps its order
        const layers = [...new Set(wanted)].filter((l) => !wanted.some((o) => o !== l && isDescendant(l, o))).sort((a, b) => order.indexOf(a) - order.indexOf(b));
        if (!layers.length) return;
        if (layers.some((l) => isDescendant(t, l))) return app.dialogs.toast('A group cannot be moved into itself', { kind: 'error' });
        // the Background stays at the bottom (L.13): it does not move, nothing goes below it (a copy of it may)
        const place = mode === 'into' ? 'inside' : mode === 'below' ? 'below' : 'above';
        if (app.backgroundRules?.canPlace?.(d, duplicate ? [] : layers, t, place) === false) {
          return app.dialogs.toast('The Background layer stays at the bottom of the stack: use Layer from Background to move it', { kind: 'error', timeout: 2600 });
        }
        const several = layers.length > 1;
        structural(app, duplicate ? (several ? 'Duplicate layers' : 'Duplicate layer') : several ? 'Move layers' : 'Move layer', () => {
          const subjects = layers.map((layer) => {
            const subject = duplicate ? cloneLayer(layer) : layer;
            if (duplicate) d.add(subject, layer.parent, layer.parent.children.length);
            return subject;
          });
          // each subject goes right above the one placed before it (the first: above, below or into the target)
          const into = mode === 'into' && t.isGroup;
          const parent = into ? t : t.parent;
          let anchor = null;
          for (const subject of subjects) {
            const at = into ? t.children.length : anchor ? parent.children.indexOf(anchor) + 1 : parent.children.indexOf(t) + (mode === 'above' ? 1 : 0);
            d.move(subject, parent, at);
            anchor = subject;
          }
          releaseOrphanClips(d);
          d.setActive(subjects[subjects.length - 1]);
          if (several) for (const s of subjects) d.selected.add(s);
        });
      },
    },
    'layer:align': { enabled: hasLayer, run: (edge) => align(edge) },
    // Layer > Distribute: the six edges and centres, and Horizontally / Vertically (equal gaps, Photoshop 2020); 0.3's
    // default without an argument was horizontal centres and stays so
    'layer:distribute': {
      enabled: () => (doc()?.selected.size ?? 0) > 2,
      run: (axis) => distribute(axis ?? 'hcenter'),
    },
    'layer:merge-down': mergeDown,
    'layer:merge-clipping': mergeClipping,
    // Ctrl+E (M.3, M.6): Merge Layers with several layers selected, Merge Group with a group, else Merge Down. The run
    // goes through the concrete command's current definition (lib/depth.js wraps them for 16/32 bits) and is reported
    // with setReplayCommand, so actions record layer:merge-selected, layer:merge-group or layer:merge-down.
    'layer:merge': {
      enabled: () => app.commands.isEnabled(mergeTarget()),
      run: (arg, ctx) => {
        const id = mergeTarget();
        const def = app.commands.commands.get(id);
        if (!def || !app.commands.isEnabled(id)) return;
        ctx?.setReplayCommand?.(id);
        return def.run(arg, ctx);
      },
    },
    'layer:merge-selected': { enabled: () => (doc()?.selected.size ?? 0) > 1, run: () => mergeLayers(selectedOrActive(doc()), null, 'Merge layers') },
    'layer:merge-group': {
      enabled: () => !!doc()?.active?.isGroup,
      run: () => {
        const d = doc();
        const g = d.active;
        if (!g?.isGroup) return;
        if (!g.children.some((c) => c.visible)) return app.dialogs.toast('The group has no visible layers to merge', { kind: 'error', timeout: 2200 });
        return mergeGroup(g);
      },
    },
    'layer:merge-visible': {
      enabled: has,
      run: () => {
        const d = doc();
        const vis = d.root.children.filter((l) => l.visible);
        if (vis.length < 2) return;
        mergeLayers(vis, vis[0].name, 'Merge visible');
      },
    },
    'image:flatten': {
      enabled: has,
      run: (_arg, ctx) => {
        const d = doc();
        // hidden layers do not survive a flatten: asked by the user (menu, key, Layers panel), Photoshop asks first.
        // Code and recorded steps flatten at once (callers rely on the synchronous run).
        const asks = DIALOG_SOURCES.has(ctx?.source) || ctx?.source === 'panel';
        if (asks && d.layers().some((l) => !l.visible)) {
          return app.dialogs.confirm('Discard hidden layers?', { title: 'Flatten Image', okLabel: 'OK' }).then((ok) => {
            if (!ok || doc() !== d) return ctx?.cancel?.();
            return flattenImage(d);
          });
        }
        return flattenImage(d);
      },
    },
    // Layer > Rasterize: 'type', 'shape', 'fill' (Type, Shape, Fill Content) rasterize the selected layers of that
    // kind, nothing (Layer) every selected layer that is not pixels already; { ids, kind } names the layers. The
    // vector mask stays live (Fill Content keeps it, as Photoshop does), the layer mask, locks, label and link too.
    'layer:rasterize': {
      enabled: () => {
        const l = doc()?.active;
        return !!l && l.type !== 'raster' && l.type !== 'adjustment';
      },
      run: (arg) => {
        const d = doc();
        const o = arg && typeof arg === 'object' ? arg : { kind: typeof arg === 'string' ? arg : undefined };
        const fits = RASTER_KINDS[o.kind] ?? ((l) => l.type !== 'raster' && l.type !== 'adjustment');
        const picked = Array.isArray(o.ids) ? o.ids.map((id) => d.find(id)).filter(Boolean) : topLevel(selectedOrActive(d));
        const pairs = [];
        for (const layer of picked.filter(fits)) {
          const r = rasterizeLayer(layer, d);
          if (!r) continue;
          r.name = layer.name;
          r.locked = { ...layer.locked };
          if (layer.color) r.color = layer.color;
          if (layer.linked) r.linked = layer.linked;
          pairs.push([layer, r]);
        }
        if (!pairs.length) return;
        const bytes = pairs.reduce((n, [, r]) => n + r.canvas.width * r.canvas.height * 4, 0);
        structural(app, pairs.length > 1 ? 'Rasterize layers' : 'Rasterize layer', () => {
          const wasActive = d.active;
          const selected = new Set(d.selected);
          for (const [layer, r] of pairs) {
            const parent = layer.parent, i = parent.children.indexOf(layer);
            d.remove(layer);
            d.add(r, parent, i);
          }
          // the rasterized layers take the place of the originals in the selection
          const swap = new Map(pairs);
          d.selected = new Set([...selected].map((l) => swap.get(l) ?? l).filter((l) => l.parent));
          d.active = swap.get(wasActive) ?? (wasActive?.parent ? wasActive : pairs[pairs.length - 1][1]);
          d.selected.add(d.active);
          d.changed('active', { layer: d.active });
        }, d, { bytes });
      },
    },
    'layer:rasterize-style': {
      enabled: () => !!doc()?.active?.styles,
      run: () => {
        const d = doc();
        const layer = d.active;
        const r = rasterizeLayer(layer, d, { bakeStyles: true });
        structural(app, 'Rasterize layer style', () => {
          const parent = layer.parent, i = parent.children.indexOf(layer);
          d.remove(layer);
          d.add(r, parent, i);
          d.setActive(r);
        });
        // Blend If leaves live effects alone and knockout follows the fill; once baked, both act on the effects too
        const bl = layer.blending;
        if (bl && (!isDefaultBlendIf(bl.blendIf) || (bl.knockout && bl.knockout !== 'none' && layer.fillOpacity < 1))) {
          app.dialogs.toast('The layer keeps its Blend If and knockout settings, which now also act on the rasterized effects, so the image can change', { timeout: 4000 });
        }
      },
    },
    'layer:select': {
      enabled: has,
      run: (arg) => {
        const d = doc();
        const order = d.layers();
        if (arg === 'all') {
          d.selected = new Set(order.filter((l) => !l.isGroup || true));
          d.changed('active', { layer: d.active });
          return;
        }
        if (arg === 'none') {
          d.selected.clear();
          d.changed('active', { layer: d.active });
          return;
        }
        if (arg === 'next' || arg === 'prev') {
          const i = order.indexOf(d.active);
          const next = order[Math.max(0, Math.min(order.length - 1, i + (arg === 'next' ? 1 : -1)))];
          if (next) d.setActive(next);
          return;
        }
        const l = d.find(arg);
        if (l) d.setActive(l);
      },
    },
    'layer:select-all': { enabled: has, run: () => app.commands.run('layer:select', 'all', 'api') },
    'layer:properties': {
      enabled: hasLayer,
      dialog: true, // actions (lib/actions.js)
      run: async (id, ctx) => {
        const d = doc();
        const layer = (typeof id === 'string' && d.find(id)) || d.active;
        if (!layer) return ctx?.cancel();
        if (layer.type === 'adjustment') return app.commands.run('layer:edit-adjustment', layer.id, 'api');
        if (layer.type === 'fill') return app.commands.run('layer:edit-fill', layer.id, 'api');
        // actions (lib/actions.js): a recorded step carries { name } and skips the prompt
        const name = id?.name ?? (await app.dialogs.prompt('Name', { title: 'Layer Properties', value: layer.name }));
        if (!name || name === layer.name) return ctx?.cancel(); // actions (lib/actions.js)
        ctx?.setReplayArg({ name }); // actions (lib/actions.js)
        setLayerProps(app, layer, renamePatch(layer, name), 'Rename layer');
      },
    },
    // a layer style is the effects with the blending options (mode, fill opacity, advanced blending), as in Photoshop:
    // app.copiedStyle is { styles, blend, fillOpacity, blending }
    'layer:copy-style': {
      enabled: () => hasLayerStyle(doc()?.active),
      run: () => {
        const l = doc().active;
        app.copiedStyle = { styles: clone(l.styles ?? null), blend: l.blend, fillOpacity: l.fillOpacity ?? 1, blending: clone(l.blending ?? null) };
        app.dialogs.toast('Layer style copied', { timeout: 1200 });
      },
    },
    'layer:paste-style': {
      enabled: () => !!app.copiedStyle && hasLayer() && selectedOrActive(doc()).some(takesStyle),
      run: () => {
        const d = doc();
        // the Background (Background rules) and adjustment layers take no style: skipped, as effect-row drags do
        const targets = selectedOrActive(d).filter(takesStyle);
        if (!targets.length) return app.dialogs.toast('The Background, adjustment layers and locked layers cannot take a layer style', { kind: 'error', timeout: 2500 });
        const c = app.copiedStyle;
        d.history.group('Paste layer style', () => {
          for (const l of targets) {
            // Pass Through is a group's mode only
            const blend = c.blend === 'pass-through' && !l.isGroup ? 'normal' : c.blend ?? l.blend;
            setLayerProps(app, l, { styles: clone(c.styles ?? null), blend, fillOpacity: c.fillOpacity ?? 1, blending: clone(c.blending ?? null) }, 'Paste layer style');
          }
        });
      },
    },
    'layer:clear-style': {
      // Lock All keeps the effects (lockedProp 'styles'), as it keeps the blend mode and Fill this also resets
      enabled: () => hasLayerStyle(doc()?.active) && !lockedProp(app, doc().active, 'styles'),
      run: () => {
        const l = doc().active;
        setLayerProps(app, l, { styles: null, blend: l.isGroup ? 'pass-through' : 'normal', fillOpacity: 1, blending: null }, 'Clear layer style');
      },
    },
    // New Fill Layer: from the menu the New Layer dialog comes first (name, clipping, colour, mode, opacity; G.5),
    // then the paint editor (createPaint). A recorded step is { kind, paint, name?, clip?, color?, blend?, opacity? }
    // ({ kind: 'pattern', pattern: { presetId, scale, angle, link, origin } } for a pattern) and asks nothing.
    'layer:new-fill': {
      enabled: has,
      dialog: true, // actions (lib/actions.js)
      run: async (arg = 'solid', ctx) => {
        const d = doc();
        const o = arg && typeof arg === 'object' ? { ...arg } : { kind: arg };
        const kind = o.kind ?? 'solid';
        const base = kind === 'solid' ? 'Color Fill' : kind === 'gradient' ? 'Gradient Fill' : 'Pattern Fill';
        const asks = (typeof arg === 'string' && DIALOG_SOURCES.has(ctx?.source)) || o.dialog === true;
        let props = layerFields(o);
        if (asks) {
          const r = await askLayer('newLayer', { doc: d, values: { name: nextLayerName(d, base), ...props }, fill: kind });
          if (!r) return ctx?.cancel(); // actions (lib/actions.js)
          props = layerFields(r);
        }
        // actions (lib/actions.js): a recorded step is { kind, paint } and makes the layer without asking
        // a pattern paint holds a live canvas, which a JSON copy would turn into {} (a layer that draws nothing and
        // cannot be saved): its canvas is kept, and one without a usable canvas is rebuilt from the library like `pattern`
        const patternIn = o.paint?.type === 'pattern' ? o.paint.pattern ?? {} : null;
        let recorded = patternIn ? (isDrawable(patternIn.canvas) ? patternPaintWith(patternIn) : await patternPaintFrom(patternIn)) : o.paint ? JSON.parse(JSON.stringify(o.paint)) : null;
        if (!recorded && kind === 'pattern' && o.pattern && typeof o.pattern === 'object') recorded = await patternPaintFrom(o.pattern);
        // the first dialog is the paint editor's (lib/paint-editors.js, G.5); a recorded paint is resolved too, as
        // createPaint resolves what it returns: stored data never holds colour references (G.1)
        const paint = recorded ? (isDrawable(recorded.pattern?.canvas) ? recorded : resolvePaint(app, recorded)) : await createPaint(app, kind, { doc: d });
        if (!paint) return ctx?.cancel(); // actions (lib/actions.js)
        const layer = new FillLayer({ name: props.name || nextLayerName(d, base), paint, docWidth: d.width, docHeight: d.height });
        applyLayerFields(layer, props);
        if (d.selection && !d.selection.isEmpty) layer.mask = { canvas: maskFromSelection(d), enabled: true, linked: true };
        const mark = d.history.mark();
        structural(app, 'New fill layer', () => {
          d.add(layer);
          if (props.clip) layer.clip = layer.parent.children.indexOf(layer) > 0;
          d.setActive(layer);
        });
        // 0.3's Gradient Fill flow: the new layer is edited live on the canvas (editAfterCreate, paint-editors.js).
        // Cancel there cancels the whole New Fill Layer, as Cancel in the Solid Color picker does: the layer goes and
        // leaves no history entry
        if (!recorded && paintEditor(kind)?.editAfterCreate && (await app.commands.run('layer:edit-fill', layer.id, 'api')) === false) {
          if (d.history.index > mark.index) d.history.undo();
          d.history.rollback(mark);
          return ctx?.cancel(); // actions (lib/actions.js)
        }
        const fields = asks ? newLayerArg({ ...props, name: layer.name }) : {};
        delete fields.neutral;
        if (kind !== 'pattern') ctx?.setReplayArg({ kind, paint: JSON.parse(JSON.stringify(layer.paint)), ...fields }); // actions (lib/actions.js)
        else {
          // a pattern replays from its library entry (patterns, L.6); one that is not in the library replays from the
          // current pattern, as 0.3 did
          const p = layer.paint?.pattern ?? {};
          ctx?.setReplayArg({ kind, ...(p.presetId ? { pattern: { presetId: p.presetId, scale: p.scale ?? 1, angle: p.angle ?? 0, link: p.link !== false, origin: Array.isArray(p.origin) ? [...p.origin] : [0, 0] } } : {}), ...fields });
        }
      },
    },
    'layer:new-adjustment': {
      enabled: has,
      run: (arg) => {
        const d = doc();
        // actions (lib/actions.js): besides a kind, { kind, params } makes the layer with settings (recorded and built-in actions)
        const kind = arg && typeof arg === 'object' ? arg.kind : arg;
        const def = app.adjustments?.[kind];
        if (!def) return;
        const layer = new AdjustmentLayer({ name: def.name, kind, params: JSON.parse(JSON.stringify({ ...(def.defaults ?? {}), ...(arg?.params ?? {}) })) });
        layer.mask = { canvas: d.selection && !d.selection.isEmpty ? maskFromSelection(d) : solidMask(d, true), enabled: true, linked: true };
        structural(app, `New ${def.name} layer`, () => {
          d.add(layer);
          d.setActive(layer);
        });
        app.panels.show('properties', { reveal: true });
      },
    },
    'layer:mask': { enabled: hasLayer, run: (op) => maskOp(op ?? 'auto') },
    'layer:mask-toggle-view': {
      enabled: () => !!doc()?.active?.mask,
      run: () => {
        app.view.maskView = !app.view.maskView;
        app.view.invalidate();
      },
    },
  });

  // ---- implementations ---------------------------------------------------------------------------------------

  function viaCopy(cut) {
    const d = doc();
    const layer = d.active;
    if (!layer || layer.isGroup) return;
    const sel = d.selection && !d.selection.isEmpty ? d.selection : null;
    if (!sel) {
      if (!cut) return app.commands.run('layer:duplicate', undefined, 'api');
      return app.dialogs.toast('Make a selection first', { kind: 'error' });
    }
    if (layer.type !== 'raster') return app.rasterizePrompt(layer).then((ok) => ok && viaCopy(cut));
    const b = sel.bounds;
    const canvas = createCanvas(b.width, b.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(layer.canvas, layer.x - b.x, layer.y - b.y);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(sel.toCanvas(), -b.x, -b.y);
    const copy = new RasterLayer({ name: nextLayerName(d), canvas, x: b.x, y: b.y });
    d.history.group(cut ? 'Layer via cut' : 'Layer via copy', () => {
      if (cut) {
        const local = { x: b.x - layer.x, y: b.y - layer.y, width: b.width, height: b.height };
        d.history.pixels('Cut', layer.canvas, local, (lctx) => {
          lctx.save();
          lctx.globalCompositeOperation = 'destination-out';
          lctx.drawImage(sel.toCanvas(), -layer.x, -layer.y);
          lctx.restore();
        }, { layer });
      }
      structural(app, 'New layer', () => {
        d.add(copy, layer.parent, layer.parent.children.indexOf(layer) + 1);
        d.setActive(copy);
      });
    });
  }

  /**
   * Layer > Arrange on every selected layer (each within its own group; several layers move together and keep their
   * order; Reverse turns their order round). Nothing goes below the Background, which itself never moves (L.13).
   */
  function arrange(where) {
    const d = doc();
    if (!d?.active) return;
    const picked = new Set(topLevel(selectedOrActive(d)).filter((l) => !isBackground(l)));
    if (!picked.size) {
      if (isBackground(d.active)) app.dialogs.toast('The Background layer stays at the bottom of the stack: use Layer from Background to move it', { kind: 'error', timeout: 2600 });
      return;
    }
    const parents = [...new Set([...picked].map((l) => l.parent))];
    const plans = parents.map((parent) => {
      const floor = parent === d.root && isBackground(parent.children[0]) ? 1 : 0;
      return [parent, arrangeChildren(parent.children, (c) => picked.has(c), where, floor)];
    }).filter(([parent, next]) => next !== parent.children);
    if (!plans.length) return;
    structural(app, where === 'reverse' ? 'Reverse layers' : 'Arrange', () => {
      for (const [parent, next] of plans) {
        parent.children = next;
        for (const c of next) c.touch();
        parent.touch();
      }
      releaseOrphanClips(d);
      d.changed('tree');
    });
  }

  /** Box used by align/distribute: the painted pixels of a raster layer (not its canvas), the union for a group. */
  function layerBox(l) {
    if (l.type === 'raster') {
      if (!l.canvas?.width || !l.canvas?.height) return null;
      const img = l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, l.canvas.width, l.canvas.height);
      const cb = contentBounds(img);
      return cb ? { x: l.x + cb.x, y: l.y + cb.y, width: cb.width, height: cb.height } : null;
    }
    if (l.isGroup) return l.children.map(layerBox).filter(Boolean).reduce((a, b) => (a ? unionRect(a, b) : b), null);
    // a shape aligns by its drawn content (path plus stroke): bounds() is its render box, padded 1 px left/top, 2 right/bottom
    if (l.type === 'shape') return shapeContentBounds(l);
    return l.bounds() ?? null;
  }

  /** A layer Align and Distribute may move: not locked in position (nor a group holding such a layer), not the Background (L.13). */
  const movable = (l) => !positionLocked(l) && !lockedProp(app, l, 'position');

  /**
   * The moves of the layers linked to the moved ones (lib/layers-extras/tags.js): a linked layer that was not picked
   * follows the first picked member of its set by the same amount, as linked layers move together with the Move tool.
   */
  function withLinked(moves) {
    const moving = new Set(moves.map((m) => m.layer));
    const out = moves.slice();
    for (const m of moves) {
      if (!m.layer.linked || !app.linkedLayers) continue;
      for (const partner of app.linkedLayers([m.layer])) {
        if (moving.has(partner) || !movable(partner)) continue;
        // a partner inside a moved group moves with it already
        if ([...moving].some((o) => o.isGroup && isAncestor(o, partner))) continue;
        moving.add(partner);
        out.push({ layer: partner, dx: m.dx, dy: m.dy });
      }
    }
    return out;
  }

  function align(edge) {
    const d = doc();
    const picked = topLevel(selectedOrActive(d)).filter((l) => layerBox(l));
    const layers = picked.filter(movable);
    if (!layers.length) return;
    const sel = d.selection && !d.selection.isEmpty ? d.selection.bounds : null;
    // the locked layers among the picked ones stay where they are but still count in the box the others align to
    const ref = sel ?? (picked.length > 1 ? picked.map(layerBox).reduce(unionRect) : d.bounds);
    const moves = layers.map((l) => {
      const b = layerBox(l);
      let dx = 0, dy = 0;
      if (edge === 'left') dx = ref.x - b.x;
      if (edge === 'right') dx = ref.x + ref.width - (b.x + b.width);
      if (edge === 'hcenter') dx = Math.round(ref.x + ref.width / 2 - (b.x + b.width / 2));
      if (edge === 'top') dy = ref.y - b.y;
      if (edge === 'bottom') dy = ref.y + ref.height - (b.y + b.height);
      if (edge === 'vcenter') dy = Math.round(ref.y + ref.height / 2 - (b.y + b.height / 2));
      return { layer: l, dx: Math.round(dx), dy: Math.round(dy) };
    });
    offsetEach(d, withLinked(moves), 'Align');
  }

  function distribute(edge = 'hcenter') {
    const d = doc();
    if (!DISTRIBUTE_EDGES.has(edge)) return;
    const layers = topLevel(selectedOrActive(d)).filter((l) => movable(l) && layerBox(l));
    if (layers.length < 3) return;
    const items = layers.map((l) => ({ layer: l, box: layerBox(l) }));
    const moves = distributeMoves(items, edge).map((m, i) => ({ layer: items[i].layer, ...m }));
    offsetEach(d, withLinked(moves), 'Distribute');
  }

  /** Flatten Image: the visible layers composited over white become the Background; hidden layers are dropped. */
  function flattenImage(d) {
    const flat = renderLayersFlat(d, d.root.children.filter((l) => l.visible));
    const bg = createCanvas(d.width, d.height);
    const ctx = bg.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, d.width, d.height);
    ctx.drawImage(flat, 0, 0);
    // a Background that cannot move or turn transparent (Background from Layer) stays one when the image is flattened
    const bottom = d.root.children[0];
    const locked = bottom && isBackground(bottom) ? { position: !!bottom.locked.position, transparency: !!bottom.locked.transparency } : {};
    const layer = new RasterLayer({ name: 'Background', canvas: bg, x: 0, y: 0, locked });
    structural(app, 'Flatten image', () => {
      for (const l of d.root.children.slice()) d.remove(l);
      d.add(layer, d.root, 0);
      d.setActive(layer);
    });
  }

  /** What Ctrl+E does now (M.3): Merge Layers, Merge Group, Merge Clipping Mask or Merge Down. */
  function mergeTarget() {
    const d = doc();
    if (!d) return 'layer:merge-down';
    if (d.selectedLayers().filter((l) => l !== d.root).length > 1) return 'layer:merge-selected';
    if (d.active?.isGroup) return 'layer:merge-group';
    // a clipping base merges with its clipped layers: merging it down would leave them clipped to a bigger layer
    if (clippedAbove(d.active).length) return 'layer:merge-clipping';
    return 'layer:merge-down';
  }

  /**
   * Merge Group: the group's visible layers become one layer in its place, named after it. The group's blend mode
   * (Normal for Pass Through) and opacity stay live on the result; its mask and effects are rendered in. Hidden layers
   * inside it are dropped, as Photoshop drops them.
   */
  function mergeGroup(g) {
    const d = doc();
    for (let p = g; p && p !== d.root; p = p.parent) if (!p.visible) return app.dialogs.toast('Hidden layers cannot be merged: show the group first', { kind: 'error' });
    const saved = { opacity: g.opacity, blend: g.blend };
    Object.assign(g, { opacity: 1, blend: 'pass-through' });
    g.touch();
    let flat;
    try {
      flat = renderLayersFlat(d, [g], { dest: g.parent });
    } finally {
      Object.assign(g, saved);
      g.touch();
    }
    const merged = new RasterLayer({ name: g.name, canvas: flat, x: 0, y: 0, clip: g.clip, blend: g.blend === 'pass-through' ? 'normal' : g.blend, opacity: g.opacity, locked: { ...g.locked, all: false } });
    if (g.color) merged.color = g.color;
    if (g.linked) merged.linked = g.linked;
    structural(app, 'Merge group', () => {
      const parent = g.parent, i = parent.children.indexOf(g);
      d.remove(g);
      d.add(merged, parent, i);
      d.setActive(merged);
    }, d, { bytes: flat.width * flat.height * 4 });
    return merged;
  }

  function mergeLayers(layers, name, label, { keepBase = false, keepBlending = false } = {}) {
    const d = doc();
    const order = d.layers();
    layers = layers.filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (layers.length < 2) return;
    // a layer inside a hidden group is hidden as well: the composite skips the group with everything in it, so the
    // merge would swap the layers for an empty one
    const hidden = (l) => {
      for (let p = l; p && p !== d.root; p = p.parent) if (!p.visible) return true;
      return false;
    };
    if (layers.some(hidden)) return app.dialogs.toast('Hidden layers cannot be merged: show or deselect them first', { kind: 'error' });
    const top = layers[layers.length - 1];
    // Merge Down keeps the lower layer's blend mode and opacity (rendered neutral, applied by the result)
    const base = layers[0];
    // layers merged with the Background become the Background (L.13: it stays at the bottom, it keeps its name)
    const intoBackground = isBackground(base);
    if (intoBackground) name = base.name;
    const keep = keepBase ? { blend: base.blend, opacity: base.opacity } : { blend: 'normal', opacity: 1 };
    // keepBlending (Merge Clipping Mask): knockout, Blend If and the channels work against what lies below, which a
    // render against transparency cannot see: left out of the render and kept live on the result, as rasterizeLayer
    // does (the options the render consumes, such as Blend Clipped Layers as Group, stay in)
    const blending = keepBase && keepBlending && !isDefaultBlending(base.blending) ? base.blending : null;
    if (keepBase) {
      Object.assign(base, { blend: 'normal', opacity: 1 });
      if (blending) base.blending = { ...blending, knockout: 'none', blendIf: null, channels: null };
      base.touch();
    }
    let flat;
    try {
      flat = renderLayersFlat(d, layers, { dest: intoBackground ? d.root : top.parent });
    } finally {
      if (keepBase) {
        Object.assign(base, keep);
        if (blending) base.blending = blending;
        base.touch();
      }
    }
    // clipped layers merged among themselves stay clipped to their base; merging onto the base releases the clip
    // a result that carries on as the lowest layer (Merge Down, Merge Visible: `name` is that layer's) keeps its
    // locks too: the Background made by Background from Layer still cannot move or turn transparent afterwards
    const merged = new RasterLayer({ name: name ?? top.name, canvas: flat, x: 0, y: 0, clip: !intoBackground && layers.every((l) => l.clip), blend: keep.blend, opacity: keep.opacity, blending: blending ? clone(blending) : null, ...(name === base.name ? { locked: { ...base.locked } } : {}) });
    structural(app, label, () => {
      const parent = intoBackground ? d.root : top.parent;
      const index = intoBackground ? 0 : parent.children.indexOf(top) + 1;
      parent.children.splice(index, 0, merged);
      merged.parent = parent;
      for (const l of layers) d.remove(l);
      releaseOrphanClips(d);
      d.setActive(merged);
    });
  }

  // ---- New Layer, New Group, Duplicate Layer ---------------------------------------------------------------------

  /** Opens one of lib/layer-dialogs.js's dialogs (app.layerDialogs); without that module, 0.3's name prompt. */
  async function askLayer(which, opts) {
    const dialogs = app.layerDialogs;
    if (dialogs?.[which]) return dialogs[which](opts);
    if (which === 'duplicate') return {};
    const value = opts.values?.name ?? nextLayerName(opts.doc, which === 'newGroup' ? 'Group' : 'Layer');
    const name = await app.dialogs.prompt('Name', { title: which === 'newGroup' ? 'New Group' : 'New Layer', value, okLabel: 'OK' });
    return name === null ? null : { name: name || value };
  }

  /** The fields a new layer takes from an argument or a dialog: { name, clip, color, blend, opacity (percent), neutral }. */
  function layerFields(o = {}) {
    const out = {};
    if (typeof o.name === 'string' && o.name.trim()) out.name = o.name.trim();
    if (o.clip) out.clip = true;
    const color = normaliseLabel(o.color);
    if (color) out.color = color;
    if (typeof o.blend === 'string' && (LAYER_BLENDS.has(o.blend) || o.blend === 'pass-through')) out.blend = o.blend;
    if (o.opacity !== undefined && o.opacity !== null) out.opacity = clampPercent(o.opacity);
    if (o.neutral) out.neutral = true;
    if (o.below) out.below = true;
    return out;
  }

  function applyLayerFields(layer, f) {
    if (f.blend && blendFits(layer, f.blend)) layer.blend = f.blend;
    if (f.opacity !== undefined) layer.opacity = f.opacity / 100;
    if (f.color) layer.color = f.color;
  }

  /** The replay argument of New Layer: what the dialog set, defaults left out. */
  function newLayerArg(o) {
    const f = layerFields(o);
    const out = { name: f.name ?? o.name };
    if (f.clip) out.clip = true;
    if (f.color) out.color = f.color;
    if (f.blend && f.blend !== 'normal') out.blend = f.blend;
    if (f.opacity !== undefined && f.opacity !== 100) out.opacity = f.opacity;
    if (f.neutral && neutralFill(f.blend)) out.neutral = true;
    if (f.below) out.below = true;
    return out;
  }

  function newGroupArg(o) {
    const f = layerFields(o);
    const out = { name: f.name ?? o.name };
    if (f.color) out.color = f.color;
    if (f.blend && f.blend !== 'pass-through') out.blend = f.blend;
    if (f.opacity !== undefined && f.opacity !== 100) out.opacity = f.opacity;
    return out;
  }

  /** layer:new: { name?, below?, clip?, color?, blend?, opacity? (percent), neutral? } */
  function createLayer(o = {}) {
    const d = doc();
    const f = layerFields(o);
    const layer = newRaster(f.name ?? nextLayerName(d));
    applyLayerFields(layer, f);
    const fill = f.neutral ? neutralFill(layer.blend) : null;
    if (fill) {
      const ctx = layer.canvas.getContext('2d');
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
    }
    const a = d.active;
    structural(app, 'New layer', () => {
      if (f.below && a?.parent) {
        // below the active layer (Ctrl-click on the panel's New Layer button); never below the Background (L.13)
        const i = a.parent.children.indexOf(a);
        d.add(layer, a.parent, isBackground(a) ? i + 1 : i);
      } else d.add(layer);
      if (f.clip) layer.clip = layer.parent.children.indexOf(layer) > 0;
      d.setActive(layer);
    }, d, { bytes: fill ? d.width * d.height * 4 : 0 });
    app.setEditingMask(false);
    return layer;
  }

  /** layer:new-group: { name?, color?, blend?, opacity? (percent) } */
  function createGroup(o = {}) {
    const d = doc();
    const f = layerFields(o);
    const g = new GroupLayer({ name: f.name ?? nextLayerName(d, 'Group') });
    applyLayerFields(g, f);
    structural(app, 'New group', () => {
      const target = d.active && !d.active.isGroup ? d.active : null;
      if (target) d.add(g, target.parent, target.parent.children.indexOf(target) + 1);
      else d.add(g, d.root, d.root.children.length);
      d.setActive(g);
    });
    return g;
  }

  /** A document named by Duplicate Layer's destination: 'new', an open document's id or name; null = not found. */
  function destinationOf(dest, d) {
    if (dest === undefined || dest === null || dest === '' || dest === d.id) return d;
    if (dest === 'new') return 'new';
    const docs = app.docs?.docs ?? [];
    return docs.find((x) => x.id === dest) ?? docs.find((x) => x.name === dest) ?? null;
  }

  function duplicateArg(o, d) {
    const out = {};
    if (typeof o.name === 'string' && o.name.trim()) out.name = o.name.trim();
    const dest = destinationOf(o.destination, d);
    if (dest === 'new') {
      out.destination = 'new';
      if (o.documentName) out.documentName = String(o.documentName);
    } else if (dest && dest !== d) out.destination = dest.name;
    return out;
  }

  /**
   * layer:duplicate: { name?, destination?, documentName? }. The copies go right above their originals, or on top of
   * another open document's stack ('new': a new document of this size holding only the copies).
   */
  function duplicateLayers(d, layers, o, ctx) {
    const dest = destinationOf(o.destination, d);
    if (!dest) {
      app.dialogs.toast(`There is no open document called "${o.destination}"`, { kind: 'error', timeout: 2400 });
      return ctx?.cancel();
    }
    const order = d.layers();
    layers = layers.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const single = layers.length === 1 && typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
    const addCopy = app.settings?.layersPanel?.addCopy !== false;
    const nameOf = (l) => single ?? (dest === d && addCopy ? `${l.name} copy` : l.name);
    if (dest === d) {
      structural(app, layers.length > 1 ? 'Duplicate layers' : 'Duplicate layer', () => {
        const copies = layers.map((l) => {
          const c = cloneLayer(l, { relink: false, name: nameOf(l) });
          d.add(c, l.parent, l.parent.children.indexOf(l) + 1);
          return c;
        });
        relinkCopies(copies); // linked layers duplicated together stay linked, to each other
        d.selected.clear();
        copies.forEach((c) => d.selected.add(c));
        d.active = copies[0];
      });
      return;
    }
    // into another document: masks are document-sized canvases, deep pixels belong to a depth
    const target = dest === 'new' ? newDocumentFor(d, o.documentName) : dest;
    const copies = layers.map((l) => fitInto(cloneLayer(l, { relink: false, name: nameOf(l) }), d, target));
    relinkCopies(copies);
    const place = () => {
      for (const c of copies) target.add(c, target.root, target.root.children.length);
      target.setActive(copies[copies.length - 1]);
      for (const c of copies) target.selected.add(c);
    };
    if (dest === 'new') {
      // a new document holds nothing but the copies: its own empty layer goes, and there is nothing to undo. It was
      // never saved, so closing it asks (as for New Document from a selection or Select and Mask's new document)
      for (const l of target.root.children.slice()) target.remove(l);
      place();
      target.history.savedIndex = -2;
      target.history.onChange?.();
    } else structural(app, layers.length > 1 ? 'Duplicate layers' : 'Duplicate layer', place, target);
    app.deep?.sync?.(target);
    target.view?.invalidate?.();
  }

  function newDocumentFor(d, name) {
    const nd = app.newDocument({ width: d.width, height: d.height, dpi: d.dpi, name: String(name ?? '').trim() || 'Untitled', background: 'transparent', mode: d.mode, depth: d.depth });
    if (d.colorTable) nd.colorTable = d.colorTable.map((c) => c.slice());
    if (d.duotone) nd.duotone = JSON.parse(JSON.stringify(d.duotone));
    return nd;
  }

  /** A copy made in `from` made fit `to`: document-sized masks resized, deep pixels dropped across depths. */
  function fitInto(layer, from, to) {
    const walk = (l) => {
      if (l.deep && from.depth !== to.depth) l.deep = null;
      if (l.mask?.canvas && (from.width !== to.width || from.height !== to.height)) l.mask = { ...l.mask, canvas: resizeMask(l.mask.canvas, to.width, to.height) };
      if (l.type === 'fill') {
        l.docWidth = to.width;
        l.docHeight = to.height;
      }
      if (l.isGroup) l.children.forEach(walk);
    };
    walk(layer);
    return layer;
  }

  /** A mask canvas on a canvas of another size: what it does not cover takes the mask's corner (its background). */
  function resizeMask(mask, W, H) {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    let corner = 255;
    try {
      corner = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3];
    } catch {
      /* unreadable: reveal */
    }
    if (corner > 0) {
      ctx.fillStyle = `rgba(255,255,255,${corner / 255})`;
      ctx.fillRect(0, 0, W, H);
      ctx.clearRect(0, 0, mask.width, mask.height);
    }
    ctx.drawImage(mask, 0, 0);
    return c;
  }

  /** Whether `c` is something createPattern can draw (a canvas or a bitmap), not a JSON copy of one. */
  function isDrawable(c) {
    return !!c && (typeof c.getContext === 'function' || (typeof ImageBitmap !== 'undefined' && c instanceof ImageBitmap));
  }

  /** A copy of a pattern paint's fields (a fresh origin array) around the same canvas. */
  function patternPaintWith(p) {
    const origin = Array.isArray(p.origin) ? [Number(p.origin[0]) || 0, Number(p.origin[1]) || 0] : [0, 0];
    const extra = JSON.parse(JSON.stringify({ ...p, canvas: undefined, origin: undefined }));
    return { type: 'pattern', pattern: { ...extra, canvas: p.canvas, scale: Number(p.scale) || 1, angle: Number(p.angle) || 0, link: p.link !== false, origin } };
  }

  /** A Pattern Fill's paint from a recorded { presetId, scale, angle, link, origin } (the library entry, else the current pattern). */
  async function patternPaintFrom(p) {
    const entry = p.presetId ? await app.patterns?.get?.(p.presetId).catch(() => null) : null;
    const canvas = entry?.canvas ?? app.patterns?.current?.()?.canvas ?? null;
    if (!canvas) return null;
    const { makePatternPaint } = await import('./pattern-paint.js');
    const origin = Array.isArray(p.origin) ? p.origin : [0, 0];
    return makePatternPaint(canvas, { scale: Number(p.scale) || 1, angle: Number(p.angle) || 0, link: p.link !== false, origin, presetId: entry?.id, name: entry?.name });
  }

  // ---- property commands on several layers -------------------------------------------------------------------------

  /** The layers a property command acts on: the ids given, else the selected layers (or the active one). */
  function targets(ids) {
    const d = doc();
    if (Array.isArray(ids)) return ids.map((id) => d.find(id)).filter(Boolean);
    return selectedOrActive(d);
  }

  /** { layers, value } of a property command's argument: a plain value (0.3) or { ids?, value }. */
  function targetsAndValue(arg) {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) return { layers: targets(arg.ids), value: arg.value };
    return { layers: targets(), value: arg };
  }

  let lockToastAt = 0;
  /** The layers whose `prop` the Background rules do not lock; says why when none is left. */
  function refuseLocked(layers, prop) {
    const free = layers.filter((l) => !lockedProp(app, l, prop));
    if (!free.length && layers.length && performance.now() - lockToastAt > 2500) {
      lockToastAt = performance.now();
      const what = { opacity: 'opacity', fillOpacity: 'fill opacity', blend: 'blend mode' }[prop] ?? prop;
      const background = layers.some(isBackground);
      app.dialogs.toast(background ? `The Background layer's ${what} is locked: use Layer from Background to unlock it` : `The layer is locked: turn off Lock All to change its ${what}`, { kind: 'error', timeout: 2600 });
    }
    return free;
  }

  function setPercent(arg, prop, label) {
    const { layers, value } = targetsAndValue(arg);
    const v = clampPercent(value, NaN) / 100;
    if (!Number.isFinite(v)) return;
    const free = refuseLocked(layers, prop).filter((l) => l[prop] !== v);
    // consecutive changes merge (a slider drag) unless the caller says this one starts a new gesture ({ merge: false }:
    // the Layers panel's typed entries and the first step of a scrub)
    const merge = !(arg && typeof arg === 'object' && arg.merge === false);
    setLayersProps(app, free, { [prop]: v }, label, { merge });
  }

  /** Renaming lifts the Background's locks (L.13): it becomes an ordinary layer, as with Layer from Background. */
  function renamePatch(layer, name) {
    if (isBackground(layer) && name !== layer.name) return { name, locked: { ...layer.locked, position: false, transparency: false, all: false } };
    return { name };
  }

  function solidMask(d, white) {
    const c = createCanvas(d.width, d.height);
    if (white) {
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, d.width, d.height);
    }
    return c;
  }

  function maskFromSelection(d, invert = false) {
    const sel = invert ? d.selection.invert() : d.selection;
    return copyCanvas(sel.toCanvas());
  }

  function maskOp(op) {
    const d = doc();
    const layer = d.active;
    if (!layer) return;
    const hasSel = d.selection && !d.selection.isEmpty;
    if (op === 'auto') op = layer.mask ? 'none' : hasSel ? 'reveal-selection' : 'reveal-all';
    if (op === 'none') return;
    // the Background takes no mask (L.13): adding one turns it into an ordinary layer first, as Photoshop does
    // ("Layer 0", its locks lifted), in the same history entry
    if (ADD_MASK_OPS.has(op) && lockedProp(app, layer, 'mask')) {
      if (op === 'from-transparency') return;
      return d.history.group('Add layer mask', () => {
        setLayerProps(app, layer, { name: 'Layer 0', locked: { pixels: false, position: false, transparency: false, all: false } }, 'Layer from background');
        maskOp(op);
      });
    }
    const set = (mask, label) => setLayerProps(app, layer, { mask }, label);
    switch (op) {
      case 'reveal-all':
        if (layer.isGroup && false) return;
        set({ canvas: solidMask(d, true), enabled: true, linked: true }, 'Add layer mask');
        app.setEditingMask(true);
        break;
      case 'hide-all':
        set({ canvas: solidMask(d, false), enabled: true, linked: true }, 'Add layer mask');
        app.setEditingMask(true);
        break;
      case 'reveal-selection':
        if (!hasSel) return maskOp('reveal-all');
        set({ canvas: maskFromSelection(d), enabled: true, linked: true }, 'Add layer mask');
        app.setEditingMask(true);
        break;
      case 'hide-selection':
        if (!hasSel) return maskOp('hide-all');
        set({ canvas: maskFromSelection(d, true), enabled: true, linked: true }, 'Add layer mask');
        app.setEditingMask(true);
        break;
      case 'from-transparency': {
        if (layer.type !== 'raster') return;
        const c = createCanvas(d.width, d.height);
        c.getContext('2d').drawImage(layer.canvas, layer.x, layer.y);
        const ctx = c.getContext('2d');
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, d.width, d.height);
        set({ canvas: c, enabled: true, linked: true }, 'Mask from transparency');
        break;
      }
      case 'delete':
        if (!layer.mask) return;
        set(null, 'Delete layer mask');
        app.setEditingMask(false);
        break;
      case 'toggle':
        if (!layer.mask) return;
        set({ ...layer.mask, enabled: !layer.mask.enabled }, layer.mask.enabled ? 'Disable layer mask' : 'Enable layer mask');
        break;
      case 'link':
        if (!layer.mask) return;
        set({ ...layer.mask, linked: layer.mask.linked === false }, 'Link mask');
        break;
      case 'apply': {
        if (!layer.mask || layer.type !== 'raster') return;
        const canvas = copyCanvas(layer.canvas);
        const ctx = canvas.getContext('2d');
        // Photoshop applies only the pixel mask (density and feather included); the vector mask stays on the layer
        const maskCanvas = maskCanvasFor(layer, d, { purpose: 'bake', parts: 'raster' }) ?? layer.mask.canvas; // mask (K.1)
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskCanvas, -layer.x, -layer.y);
        const before = { canvas: layer.canvas, mask: layer.mask };
        const after = { canvas, mask: null };
        const apply = (s) => {
          layer.canvas = s.canvas;
          layer.mask = s.mask;
          layer.touch();
          d.changed('props', { layer });
        };
        apply(after);
        d.history.push({ label: 'Apply layer mask', undo: () => apply(before), redo: () => apply(after), bytes: canvas.width * canvas.height * 4, at: Date.now() });
        app.setEditingMask(false);
        break;
      }
      case 'select': {
        if (!layer.mask) return;
        const img = layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
        const mask = new Uint8ClampedArray(d.width * d.height);
        for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4 + 3];
        app.applySelection(Selection.fromMask(d.width, d.height, mask), 'replace', 'Load mask');
        break;
      }
    }
  }
}

function isAncestor(maybeAncestor, layer) {
  for (let p = layer.parent; p; p = p.parent) if (p === maybeAncestor) return true;
  return false;
}
function isDescendant(layer, group) {
  return isAncestor(group, layer);
}

export { intersectRect };
