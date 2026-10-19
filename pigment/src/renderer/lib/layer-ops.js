// Layer commands (Layer menu, Layers panel buttons, shortcuts). Structural changes record a
// snapshot of the tree so undo restores it exactly; layer pixels are never mutated by structural
// operations (merges create new layers), so the snapshots stay valid.
import { RasterLayer, GroupLayer, FillLayer, AdjustmentLayer, createCanvas, copyCanvas, intersectRect, unionRect, BLEND_LABELS } from './document.js';
import { Compositor } from './compositor.js';
import { Selection } from './selection.js';

// ---- snapshots ----------------------------------------------------------------------------------------------

export function snapshotTree(doc) {
  const groups = [];
  const walk = (g) => {
    groups.push([g, g.children.slice()]);
    for (const c of g.children) if (c.isGroup) walk(c);
  };
  walk(doc.root);
  return { root: doc.root, groups, active: doc.active, selected: [...doc.selected], width: doc.width, height: doc.height };
}

export function restoreTree(doc, snap) {
  doc.root = snap.root;
  for (const [g, children] of snap.groups) {
    g.children = children.slice();
    for (const c of g.children) c.parent = g;
    g.touch();
  }
  doc.root.parent = null;
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

/** Runs a structural mutation as one undoable entry. */
export function structural(app, label, mutate, doc = app.doc) {
  const before = snapshotTree(doc);
  const extraBefore = { selection: doc.selection, guides: doc.guides.slice(), channels: doc.channels.slice() };
  const result = mutate();
  if (result === false) return false;
  const after = snapshotTree(doc);
  const extraAfter = { selection: doc.selection, guides: doc.guides.slice(), channels: doc.channels.slice() };
  const apply = (snap, extra) => {
    restoreTree(doc, snap);
    doc.selection = extra.selection;
    doc.guides = extra.guides.slice();
    doc.channels = extra.channels.slice();
    doc.changed('selection');
  };
  doc.history.push({ label, undo: () => apply(before, extraBefore), redo: () => apply(after, extraAfter), bytes: 0, at: Date.now() });
  restoreTree(doc, after);
  doc.changed('history');
  return result;
}

/** Undoable property change on a layer: patch is { key: value } (nested objects replaced whole). */
export function setLayerProps(app, layer, patch, label = 'Layer properties', { merge = false } = {}) {
  const doc = app.doc;
  const before = {};
  for (const k of Object.keys(patch)) before[k] = clone(layer[k]);
  const apply = (values) => {
    for (const [k, v] of Object.entries(values)) layer[k] = clone(v);
    layer.touch();
    doc.changed('props', { layer });
  };
  apply(patch);
  // consecutive changes of the same property (slider drags) merge into one entry
  const last = doc.history.entries[doc.history.index];
  if (merge && last?.mergeKey === `${layer.id}:${Object.keys(patch).join(',')}` && Date.now() - last.at < 1500) {
    last.redo = () => apply(patch);
    last.at = Date.now();
    return;
  }
  doc.history.push({ label, undo: () => apply(before), redo: () => apply(patch), bytes: 0, at: Date.now(), mergeKey: `${layer.id}:${Object.keys(patch).join(',')}` });
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof HTMLCanvasElement) return v;
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
export function cloneLayer(layer, { name } = {}) {
  const props = { name: name ?? `${layer.name} copy`, visible: layer.visible, opacity: layer.opacity, fillOpacity: layer.fillOpacity, blend: layer.blend, locked: { ...layer.locked, all: false }, clip: layer.clip, styles: layer.styles ? JSON.parse(JSON.stringify(layer.styles)) : null };
  let copy;
  switch (layer.type) {
    case 'raster':
      copy = new RasterLayer({ ...props, canvas: copyCanvas(layer.canvas), x: layer.x, y: layer.y });
      break;
    case 'group':
      copy = new GroupLayer({ ...props, expanded: layer.expanded });
      for (const c of layer.children) {
        const cc = cloneLayer(c, { name: c.name });
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
  return copy;
}

/** Renders any non-group layer to a raster layer in document space (styles baked in when asked). */
export function rasterizeLayer(layer, doc, { bakeStyles = false } = {}) {
  let canvas, x, y;
  if (layer.type === 'raster') {
    canvas = copyCanvas(layer.canvas);
    x = layer.x;
    y = layer.y;
  } else if (layer.isGroup || bakeStyles) {
    canvas = renderLayersFlat(doc, [layer]);
    x = 0;
    y = 0;
  } else if (layer.render) {
    const r = layer.render();
    canvas = copyCanvas(r.canvas);
    x = r.x;
    y = r.y;
  } else return null;
  const out = new RasterLayer({ name: layer.name, canvas, x, y, opacity: layer.isGroup || bakeStyles ? 1 : layer.opacity, blend: layer.isGroup || bakeStyles ? 'normal' : layer.blend, visible: layer.visible, clip: layer.clip, styles: bakeStyles ? null : layer.styles, fillOpacity: bakeStyles ? 1 : layer.fillOpacity });
  if (layer.mask && !bakeStyles && !layer.isGroup) out.mask = { ...layer.mask, canvas: copyCanvas(layer.mask.canvas) };
  return out;
}

/** Composites the given layers (in document order) into one document-sized canvas. */
export function renderLayersFlat(doc, layers) {
  const set = new Set();
  const addWithChildren = (l) => {
    set.add(l);
    if (l.isGroup) l.children.forEach(addWithChildren);
  };
  layers.forEach(addWithChildren);
  // include ancestors so the tree walk reaches them
  for (const l of [...set]) for (let p = l.parent; p && p !== doc.root; p = p.parent) set.add(p);
  const skip = new Set(doc.layers().filter((l) => !set.has(l)));
  const comp = new Compositor();
  const c = comp.composite(doc, { skip });
  return copyCanvas(c);
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

  app.commands.registerAll({
    'layer:new': {
      enabled: has,
      run: async (arg) => {
        const d = doc();
        let name = nextLayerName(d);
        if (arg?.dialog) {
          const n = await app.dialogs.prompt('Name', { title: 'New Layer', value: name, okLabel: 'Create' });
          if (n === null) return;
          name = n || name;
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
            const c = cloneLayer(l);
            d.add(c, l.parent, l.parent.children.indexOf(l) + 1);
            return c;
          });
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
        });
        app.setEditingMask(false);
      },
    },
    'layer:rename': {
      enabled: hasLayer,
      run: async (arg) => {
        const d = doc();
        const layer = arg?.id ? d.find(arg.id) : d.active;
        if (!layer) return;
        let name = arg?.name;
        if (!name) {
          name = await app.dialogs.prompt('Layer name', { title: 'Rename Layer', value: layer.name });
          if (!name) return;
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
        const others = d.layers().filter((l) => l !== layer && !isAncestor(l, layer));
        const allHidden = others.every((l) => !l.visible || l.isGroup);
        d.history.group('Show only this layer', () => {
          if (allHidden) for (const l of others) setLayerProps(app, l, { visible: true });
          else {
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
      run: ({ id, target, mode, duplicate } = {}) => {
        const d = doc();
        const layer = d.find(id), t = d.find(target);
        if (!layer || !t || layer === t) return;
        if (isDescendant(t, layer)) return app.dialogs.toast('A group cannot be moved into itself', { kind: 'error' });
        structural(app, duplicate ? 'Duplicate layer' : 'Move layer', () => {
          const subject = duplicate ? cloneLayer(layer) : layer;
          if (duplicate) d.add(subject, layer.parent, layer.parent.children.length);
          if (mode === 'into' && t.isGroup) d.move(subject, t, t.children.length);
          else {
            const parent = t.parent;
            const idx = parent.children.indexOf(t) + (mode === 'above' ? 1 : 0);
            d.move(subject, parent, idx);
          }
          d.setActive(subject);
        });
      },
    },
    'layer:align': { enabled: hasLayer, run: (edge) => align(edge) },
    'layer:distribute': { enabled: () => (doc()?.selected.size ?? 0) > 2, run: (axis) => distribute(axis) },
    'layer:merge-down': {
      enabled: () => {
        const l = doc()?.active;
        return !!l && l.parent && l.parent.children.indexOf(l) > 0;
      },
      run: () => {
        const d = doc();
        const top = d.active;
        const below = top.parent.children[top.parent.children.indexOf(top) - 1];
        if (!below || below.type === 'adjustment' && top.type !== 'adjustment') return app.dialogs.toast('Nothing to merge into', { kind: 'error' });
        mergeLayers([below, top], below.name, 'Merge down');
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
        const layer = new RasterLayer({ name: 'Background', canvas: bg, x: 0, y: 0 });
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
      run: async (id) => {
        const d = doc();
        const layer = (typeof id === 'string' && d.find(id)) || d.active;
        if (!layer) return;
        if (layer.type === 'adjustment') return app.commands.run('layer:edit-adjustment', layer.id, 'api');
        if (layer.type === 'fill') return app.commands.run('layer:edit-fill', layer.id, 'api');
        const name = await app.dialogs.prompt('Name', { title: 'Layer Properties', value: layer.name });
        if (name && name !== layer.name) setLayerProps(app, layer, { name }, 'Rename layer');
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
      run: async (kind = 'solid') => {
        const d = doc();
        let paint;
        if (kind === 'solid') {
          const color = await app.pickColor?.(app.settings.foreground, { title: 'Solid Color Fill' });
          if (!color) return;
          paint = { type: 'solid', color };
        } else if (kind === 'gradient') paint = { type: 'gradient', gradient: { kind: 'linear', stops: [{ pos: 0, color: app.settings.foreground }, { pos: 1, color: app.settings.background }], from: [0, d.height / 2], to: [d.width, d.height / 2] } };
        else {
          if (!app.currentPattern) return app.dialogs.toast('Define a pattern first (Edit › Define Pattern)', { kind: 'error' });
          paint = { type: 'pattern', pattern: { canvas: app.currentPattern, scale: 1 } };
        }
        const layer = new FillLayer({ name: nextLayerName(d, kind === 'solid' ? 'Color Fill' : kind === 'gradient' ? 'Gradient Fill' : 'Pattern Fill'), paint, docWidth: d.width, docHeight: d.height });
        if (d.selection && !d.selection.isEmpty) layer.mask = { canvas: maskFromSelection(d), enabled: true, linked: true };
        structural(app, 'New fill layer', () => {
          d.add(layer);
          d.setActive(layer);
        });
        if (kind === 'gradient') app.commands.run('layer:edit-fill', layer.id, 'api');
      },
    },
    'layer:new-adjustment': {
      enabled: has,
      run: (kind) => {
        const d = doc();
        const def = app.adjustments?.[kind];
        if (!def) return;
        const layer = new AdjustmentLayer({ name: def.name, kind, params: JSON.parse(JSON.stringify(def.defaults ?? {})) });
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
      layer.touch();
      d.changed('tree');
    });
  }

  function layerBox(l) {
    return l.bounds() ?? null;
  }

  function align(edge) {
    const d = doc();
    const layers = selectedOrActive(d).filter((l) => !l.locked.position && !l.locked.all && layerBox(l));
    if (!layers.length) return;
    const sel = d.selection && !d.selection.isEmpty ? d.selection.bounds : null;
    const ref = sel ?? (layers.length > 1 ? layers.map(layerBox).reduce(unionRect) : d.bounds);
    const move = app.tools.get('move');
    const origin = layers.map((l) => ({ l, x: l.x ?? 0, y: l.y ?? 0, b: layerBox(l) }));
    const target = (o) => {
      const b = o.b;
      let dx = 0, dy = 0;
      if (edge === 'left') dx = ref.x - b.x;
      if (edge === 'right') dx = ref.x + ref.width - (b.x + b.width);
      if (edge === 'hcenter') dx = Math.round(ref.x + ref.width / 2 - (b.x + b.width / 2));
      if (edge === 'top') dy = ref.y - b.y;
      if (edge === 'bottom') dy = ref.y + ref.height - (b.y + b.height);
      if (edge === 'vcenter') dy = Math.round(ref.y + ref.height / 2 - (b.y + b.height / 2));
      return { x: o.x + dx, y: o.y + dy };
    };
    const apply = (to) => {
      for (const o of origin) {
        const t = to(o);
        move.offsetLayer(o.l, t.x, t.y);
        delete o.l._dragX;
        delete o.l._dragY;
        delete o.l._maskX;
        delete o.l._maskY;
      }
      d.changed('props');
    };
    apply(target);
    d.history.push({ label: 'Align', undo: () => apply((o) => ({ x: o.x, y: o.y })), redo: () => apply(target), bytes: 0, at: Date.now() });
  }

  function distribute(axis = 'horizontal') {
    const d = doc();
    const layers = selectedOrActive(d).filter((l) => layerBox(l));
    if (layers.length < 3) return;
    const key = axis === 'vertical' ? 'y' : 'x', size = axis === 'vertical' ? 'height' : 'width';
    const items = layers.map((l) => ({ l, b: layerBox(l), x: l.x ?? 0, y: l.y ?? 0 })).sort((a, b) => a.b[key] + a.b[size] / 2 - (b.b[key] + b.b[size] / 2));
    const first = items[0].b[key] + items[0].b[size] / 2, last = items[items.length - 1].b[key] + items[items.length - 1].b[size] / 2;
    const step = (last - first) / (items.length - 1);
    const move = app.tools.get('move');
    const targets = items.map((it, i) => {
      const c = it.b[key] + it.b[size] / 2;
      const delta = Math.round(first + step * i - c);
      return axis === 'vertical' ? { x: it.x, y: it.y + delta } : { x: it.x + delta, y: it.y };
    });
    const apply = (list) => {
      items.forEach((it, i) => {
        move.offsetLayer(it.l, list[i].x, list[i].y);
        delete it.l._dragX;
        delete it.l._dragY;
      });
      d.changed('props');
    };
    apply(targets);
    d.history.push({ label: 'Distribute', undo: () => apply(items.map((it) => ({ x: it.x, y: it.y }))), redo: () => apply(targets), bytes: 0, at: Date.now() });
  }

  function mergeLayers(layers, name, label) {
    const d = doc();
    const order = d.layers();
    layers = layers.filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (layers.length < 2) return;
    const flat = renderLayersFlat(d, layers.filter((l) => l.visible));
    const merged = new RasterLayer({ name: name ?? layers[layers.length - 1].name, canvas: flat, x: 0, y: 0 });
    // trim to content to keep memory down
    const top = layers[layers.length - 1];
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
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(layer.mask.canvas, -layer.x, -layer.y);
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
