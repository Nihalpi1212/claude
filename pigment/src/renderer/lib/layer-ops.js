// Layer commands (Layer menu, Layers panel buttons, shortcuts). Structural changes record a
// snapshot of the tree so undo restores it exactly; layer pixels are never mutated by structural
// operations (merges create new layers), so the snapshots stay valid.
import { RasterLayer, GroupLayer, FillLayer, AdjustmentLayer, createCanvas, copyCanvas, intersectRect, unionRect, BLEND_LABELS, newId } from './document.js';
import { Compositor } from './compositor.js';
import { contentBounds } from '../../shared/pixels/core.js';
import { offsetEach } from './layer-move.js';
import { Selection } from './selection.js';
import { maskCanvasFor } from './mask-render.js';
import { createPaint, resolvePaint, paintEditor } from './paint-editors.js';

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
export function structural(app, label, mutate, doc = app.doc, { bytes = 0 } = {}) {
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
  doc.history.push({ label, undo: () => apply(before, extraBefore), redo: () => apply(after, extraAfter), bytes: typeof bytes === 'function' ? bytes() : bytes, at: Date.now() });
  restoreTree(doc, after);
  doc.changed('history');
  return result;
}

// a text layer's 0.3 views (`text`, `font`) and the 0.4 fields they are computed from (ARCHITECTURE.md "0.4", A)
/** Layer > Distribute's edge arguments (finish-layer-menu); 0.3 knows only 'horizontal' and 'vertical'. */
const DISTRIBUTE_EDGES = new Set(['top', 'vcenter', 'bottom', 'left', 'hcenter', 'right']);
const TEXT_VIEWS = new Set(['font', 'text', 'content']);
const TEXT_FIELDS = new Set(['font', 'text', 'content', 'typeOptions', 'height']);

/**
 * Undoable property change on a layer: patch is { key: value } (nested objects replaced whole). A text layer patch
 * with `font`, `text` or `content` records `content`, `typeOptions` and `height` before and after, so undo restores
 * the formatting exactly whatever the patch was (assigning `font` or `text` rewrites the content).
 */
export function setLayerProps(app, layer, patch, label = 'Layer properties', { merge = false } = {}) {
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
  // consecutive changes of the same property (slider drags) merge into one entry
  const key = `${layer.id}:${keys.join(',')}`;
  const last = doc.history.entries[doc.history.index];
  if (merge && last?.mergeKey === key && Date.now() - last.at < 1500) {
    doc.history.merge(() => apply(after));
    return;
  }
  doc.history.push({ label, undo: () => apply(before), redo: () => apply(after), bytes: 0, at: Date.now(), mergeKey: key });
}

/**
 * The same property change on several layers (M.3): one history entry. patchOrFn is a patch or (layer) -> patch.
 * Landed by the 0.4 skeleton as a loop of setLayerProps inside history.group; finish-layer-menu makes it one entry whose
 * merge key is the sorted ids plus the patch keys (a scrubby Opacity drag over three layers merges).
 */
export function setLayersProps(app, layers, patchOrFn, label = 'Layer properties', { merge = false } = {}) {
  const doc = app.doc;
  const list = (layers ?? []).filter(Boolean);
  if (!doc || !list.length) return;
  const patchFor = (l) => (typeof patchOrFn === 'function' ? patchOrFn(l) : patchOrFn);
  if (list.length === 1) {
    const patch = patchFor(list[0]);
    if (patch) setLayerProps(app, list[0], patch, label, { merge });
    return;
  }
  doc.history.group(label, () => {
    for (const l of list) {
      const patch = patchFor(l);
      if (patch) setLayerProps(app, l, patch, label);
    }
  });
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
    const saved = { opacity: layer.opacity, blend: layer.blend, vectorMask: layer.vectorMask ?? null };
    if (!layer.isGroup) {
      layer.opacity = 1;
      layer.blend = 'normal';
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
  const out = new RasterLayer({ name: layer.name, canvas, x, y, opacity: layer.isGroup ? 1 : layer.opacity, blend: layer.isGroup ? 'normal' : layer.blend, visible: layer.visible, clip: layer.clip, styles: bakeStyles ? null : layer.styles, fillOpacity: bakeStyles ? 1 : layer.fillOpacity });
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

// ---- install ------------------------------------------------------------------------------------------------

export function install(app) {
  const has = () => !!app.doc;
  const hasLayer = () => !!app.doc?.active;
  const doc = () => app.doc;

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
    app.commands.run('layer:rasterize', undefined, 'api');
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
      mergeLayers([below, top], below.name, 'Merge down', { keepBase: true });
    },
  };

  app.commands.registerAll({
    'layer:new': {
      enabled: has,
      run: async (arg, ctx) => {
        const d = doc();
        let name = arg?.name ?? nextLayerName(d);
        if (arg?.dialog) {
          const n = await app.dialogs.prompt('Name', { title: 'New Layer', value: name, okLabel: 'Create' });
          if (n === null) return ctx?.cancel(); // actions (lib/actions.js)
          name = n || name;
          ctx?.setReplayArg({ name }); // actions (lib/actions.js): the chosen name replays without the prompt
        }
        const layer = newRaster(name);
        structural(app, 'New layer', () => {
          d.add(layer);
          d.setActive(layer);
        });
        app.setEditingMask(false);
      },
    },
    'layer:new-group': {
      enabled: has,
      run: () => {
        const d = doc();
        const g = new GroupLayer({ name: nextLayerName(d, 'Group') });
        structural(app, 'New group', () => {
          const target = d.active && !d.active.isGroup ? d.active : null;
          if (target) d.add(g, target.parent, target.parent.children.indexOf(target) + 1);
          else d.add(g, d.root, d.root.children.length);
          d.setActive(g);
        });
      },
    },
    'layer:via-copy': { enabled: hasLayer, run: () => viaCopy(false) },
    'layer:via-cut': { enabled: hasLayer, run: () => viaCopy(true) },
    'layer:duplicate': {
      enabled: hasLayer,
      run: () => {
        const d = doc();
        const layers = selectedOrActive(d);
        structural(app, layers.length > 1 ? 'Duplicate layers' : 'Duplicate layer', () => {
          const copies = layers.map((l) => {
            const c = cloneLayer(l, { relink: false });
            d.add(c, l.parent, l.parent.children.indexOf(l) + 1);
            return c;
          });
          relinkCopies(copies); // linked layers duplicated together stay linked, to each other
          d.selected.clear();
          copies.forEach((c) => d.selected.add(c));
          d.active = copies[0];
        });
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
        setLayerProps(app, layer, { name }, 'Rename layer');
      },
    },
    'layer:visibility': {
      enabled: hasLayer,
      run: (id) => {
        const d = doc();
        const layer = typeof id === 'string' ? d.find(id) : d.active;
        if (layer) setLayerProps(app, layer, { visible: !layer.visible }, layer.visible ? 'Hide layer' : 'Show layer');
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
    'layer:opacity': {
      enabled: hasLayer,
      run: (value) => {
        const layer = doc().active;
        const v = Math.max(0, Math.min(100, Number(value))) / 100;
        if (Number.isFinite(v) && v !== layer.opacity) setLayerProps(app, layer, { opacity: v }, 'Opacity', { merge: true });
      },
    },
    'layer:fill-opacity': {
      enabled: hasLayer,
      run: (value) => {
        const layer = doc().active;
        const v = Math.max(0, Math.min(100, Number(value))) / 100;
        if (Number.isFinite(v) && v !== layer.fillOpacity) setLayerProps(app, layer, { fillOpacity: v }, 'Fill opacity', { merge: true });
      },
    },
    'layer:blend': {
      enabled: hasLayer,
      run: (mode) => {
        const layer = doc().active;
        if (mode && mode !== layer.blend && (BLEND_LABELS[mode] || mode === 'pass-through')) setLayerProps(app, layer, { blend: mode }, `Blend mode: ${BLEND_LABELS[mode] ?? mode}`);
      },
    },
    'layer:lock': {
      enabled: hasLayer,
      run: (kind) => {
        const layer = doc().active;
        if (!kind || !(kind in layer.locked)) return;
        setLayerProps(app, layer, { locked: { ...layer.locked, [kind]: !layer.locked[kind] } }, 'Lock');
      },
    },
    'layer:clip': {
      enabled: () => !!doc()?.active && doc().indexOf(doc().active) > 0,
      run: () => {
        const layer = doc().active;
        if (layer.parent.children.indexOf(layer) === 0 && !layer.clip) return app.dialogs.toast('A clipping mask needs a layer below it', { kind: 'error' });
        setLayerProps(app, layer, { clip: !layer.clip }, layer.clip ? 'Release clipping mask' : 'Create clipping mask');
      },
    },
    'layer:group': {
      enabled: hasLayer,
      run: () => {
        const d = doc();
        const picked = selectedOrActive(d);
        // a layer whose group is also selected moves with its group
        const layers = picked.filter((l) => !picked.some((o) => o !== l && isAncestor(o, l)));
        if (!layers.length) return;
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
    'layer:distribute': {
      enabled: () => (doc()?.selected.size ?? 0) > 2,
      run: (axis) => {
        // the edge arguments of the 0.4 menu belong to finish-layer-menu; until it lands they must not fall
        // through to 0.3's horizontal-centres default (M.3)
        if (DISTRIBUTE_EDGES.has(axis)) return app.dialogs.toast('Not available yet', { timeout: 2000 });
        return distribute(axis);
      },
    },
    'layer:merge-down': mergeDown,
    // Ctrl+E (M.6): the skeleton's working placeholder runs Merge Down and reports it, so actions record
    // layer:merge-down; finish-layer-menu re-registers it to dispatch by context (Merge Layers, Merge Group)
    'layer:merge': {
      enabled: () => mergeDown.enabled(),
      run: (_arg, ctx) => {
        ctx?.setReplayCommand?.('layer:merge-down');
        return mergeDown.run();
      },
    },
    'layer:merge-selected': { enabled: () => (doc()?.selected.size ?? 0) > 1, run: () => mergeLayers(selectedOrActive(doc()), null, 'Merge layers') },
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
      run: () => {
        const d = doc();
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
      },
    },
    'layer:rasterize': {
      enabled: () => {
        const l = doc()?.active;
        return !!l && l.type !== 'raster' && l.type !== 'adjustment';
      },
      run: () => {
        const d = doc();
        const layer = d.active;
        const r = rasterizeLayer(layer, d);
        if (!r) return;
        r.name = layer.name;
        structural(app, 'Rasterize layer', () => {
          const parent = layer.parent, i = parent.children.indexOf(layer);
          d.remove(layer);
          d.add(r, parent, i);
          d.setActive(r);
        });
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
        setLayerProps(app, layer, { name }, 'Rename layer');
      },
    },
    'layer:copy-style': {
      enabled: () => !!doc()?.active?.styles,
      run: () => {
        app.copiedStyle = JSON.parse(JSON.stringify(doc().active.styles));
        app.dialogs.toast('Layer style copied', { timeout: 1200 });
      },
    },
    'layer:paste-style': {
      enabled: () => !!app.copiedStyle && hasLayer(),
      run: () => {
        const d = doc();
        d.history.group('Paste layer style', () => {
          for (const l of selectedOrActive(d)) setLayerProps(app, l, { styles: JSON.parse(JSON.stringify(app.copiedStyle)) });
        });
      },
    },
    'layer:clear-style': {
      enabled: () => !!doc()?.active?.styles,
      run: () => setLayerProps(app, doc().active, { styles: null }, 'Clear layer style'),
    },
    'layer:new-fill': {
      enabled: has,
      dialog: true, // actions (lib/actions.js)
      run: async (arg = 'solid', ctx) => {
        const d = doc();
        // actions (lib/actions.js): a recorded step is { kind, paint } and makes the layer without asking
        const kind = arg && typeof arg === 'object' ? arg.kind : arg;
        const recorded = arg && typeof arg === 'object' && arg.paint ? JSON.parse(JSON.stringify(arg.paint)) : null;
        // the first dialog is the paint editor's (lib/paint-editors.js, G.5); a recorded paint is resolved too, as
        // createPaint resolves what it returns: stored data never holds colour references (G.1)
        const paint = recorded ? resolvePaint(app, recorded) : await createPaint(app, kind, { doc: d });
        if (!paint) return ctx?.cancel(); // actions (lib/actions.js)
        const layer = new FillLayer({ name: nextLayerName(d, kind === 'solid' ? 'Color Fill' : kind === 'gradient' ? 'Gradient Fill' : 'Pattern Fill'), paint, docWidth: d.width, docHeight: d.height });
        if (d.selection && !d.selection.isEmpty) layer.mask = { canvas: maskFromSelection(d), enabled: true, linked: true };
        structural(app, 'New fill layer', () => {
          d.add(layer);
          d.setActive(layer);
        });
        // 0.3's Gradient Fill flow: the new layer is edited live on the canvas (editAfterCreate, paint-editors.js)
        if (!recorded && paintEditor(kind)?.editAfterCreate) await app.commands.run('layer:edit-fill', layer.id, 'api');
        if (kind !== 'pattern') ctx?.setReplayArg({ kind, paint: JSON.parse(JSON.stringify(layer.paint)) }); // actions (lib/actions.js): patterns replay from the current pattern
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

  function arrange(where) {
    const d = doc();
    const layer = d.active;
    const parent = layer.parent;
    const i = parent.children.indexOf(layer);
    const n = parent.children.length;
    let target = { front: n - 1, back: 0, forward: Math.min(n - 1, i + 1), backward: Math.max(0, i - 1) }[where];
    if (target === undefined || target === i) return;
    structural(app, 'Arrange', () => {
      parent.children.splice(i, 1);
      parent.children.splice(target, 0, layer);
      releaseOrphanClips(d);
      layer.touch();
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
    return l.bounds() ?? null;
  }

  function align(edge) {
    const d = doc();
    const layers = selectedOrActive(d).filter((l) => !l.locked.position && !l.locked.all && layerBox(l));
    if (!layers.length) return;
    const sel = d.selection && !d.selection.isEmpty ? d.selection.bounds : null;
    const ref = sel ?? (layers.length > 1 ? layers.map(layerBox).reduce(unionRect) : d.bounds);
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
    offsetEach(d, moves, 'Align');
  }

  function distribute(axis = 'horizontal') {
    const d = doc();
    const layers = selectedOrActive(d).filter((l) => layerBox(l));
    if (layers.length < 3) return;
    const key = axis === 'vertical' ? 'y' : 'x', size = axis === 'vertical' ? 'height' : 'width';
    const items = layers.map((l) => ({ l, b: layerBox(l), x: l.x ?? 0, y: l.y ?? 0 })).sort((a, b) => a.b[key] + a.b[size] / 2 - (b.b[key] + b.b[size] / 2));
    const first = items[0].b[key] + items[0].b[size] / 2, last = items[items.length - 1].b[key] + items[items.length - 1].b[size] / 2;
    const step = (last - first) / (items.length - 1);
    const moves = items.map((it, i) => {
      const c = it.b[key] + it.b[size] / 2;
      const delta = Math.round(first + step * i - c);
      return axis === 'vertical' ? { layer: it.l, dx: 0, dy: delta } : { layer: it.l, dx: delta, dy: 0 };
    });
    offsetEach(d, moves, 'Distribute');
  }

  function mergeLayers(layers, name, label, { keepBase = false } = {}) {
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
    const keep = keepBase ? { blend: base.blend, opacity: base.opacity } : { blend: 'normal', opacity: 1 };
    if (keepBase) {
      Object.assign(base, { blend: 'normal', opacity: 1 });
      base.touch();
    }
    let flat;
    try {
      flat = renderLayersFlat(d, layers, { dest: top.parent });
    } finally {
      if (keepBase) {
        Object.assign(base, keep);
        base.touch();
      }
    }
    // clipped layers merged among themselves stay clipped to their base; merging onto the base releases the clip
    // a result that carries on as the lowest layer (Merge Down, Merge Visible: `name` is that layer's) keeps its
    // locks too: the Background made by Background from Layer still cannot move or turn transparent afterwards
    const merged = new RasterLayer({ name: name ?? top.name, canvas: flat, x: 0, y: 0, clip: layers.every((l) => l.clip), blend: keep.blend, opacity: keep.opacity, ...(name === base.name ? { locked: { ...base.locked } } : {}) });
    structural(app, label, () => {
      const parent = top.parent;
      const index = parent.children.indexOf(top);
      parent.children.splice(index + 1, 0, merged);
      merged.parent = parent;
      for (const l of layers) d.remove(l);
      d.setActive(merged);
    });
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
