// Stamp Visible (Alt+Shift+Ctrl+E) and Stamp Layers (Alt+Ctrl+E), finish-layer-menu (ARCHITECTURE.md "0.4 features",
// package 15). Both leave the layers they read as they are and add the merged picture as a new layer, as Photoshop
// does: Merge Visible and Merge Layers that keep the originals.
// - Stamp Visible: everything visible, merged, on a new layer above the active one.
// - Stamp Layers with several layers selected: those layers merged on a new layer above the topmost ("… (merged)").
// - Stamp Layers with one layer selected ("stamp down"): a copy of it is merged into the layer below, which must be a
//   pixel layer; the layer itself stays.
// Like the merges, the stamps render through the 8-bit compositor (lib/depth.js resamples a 16/32-bit document's new
// pixels from it).
import { RasterLayer } from '../document.js';
import { structural, renderLayersFlat, nextLayerName } from '../layer-ops.js';

const isAncestor = (a, l) => {
  for (let p = l.parent; p; p = p.parent) if (p === a) return true;
  return false;
};
const hiddenIn = (d, l) => {
  for (let p = l; p && p !== d.root; p = p.parent) if (!p.visible) return true;
  return false;
};

export function installStamp(app) {
  const doc = () => app.doc;

  /** Puts a new layer right above `anchor` (in its group), or on top without one, and makes it active. */
  function placeAbove(d, layer, anchor, label) {
    structural(app, label, () => {
      if (anchor?.parent) d.add(layer, anchor.parent, anchor.parent.children.indexOf(anchor) + 1);
      else d.add(layer, d.root, d.root.children.length);
      d.setActive(layer);
    }, d, { bytes: layer.canvas.width * layer.canvas.height * 4 });
    app.setEditingMask?.(false);
    return layer;
  }

  function stampVisible() {
    const d = doc();
    const visible = d.root.children.filter((l) => l.visible && !l.preview && !l.quickMask);
    if (!visible.length) return app.dialogs.toast('Nothing is visible to stamp', { kind: 'error', timeout: 2200 });
    const flat = renderLayersFlat(d, visible);
    return placeAbove(d, new RasterLayer({ name: nextLayerName(d), canvas: flat, x: 0, y: 0 }), d.active, 'Stamp visible');
  }

  function stampSelected() {
    const d = doc();
    const order = d.layers();
    const picked = d.selectedLayers().filter((l) => l !== d.root);
    const layers = (picked.length ? picked : d.active ? [d.active] : []).filter((l, _i, all) => !all.some((o) => o !== l && isAncestor(o, l)));
    layers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (layers.length > 1) {
      const shown = layers.filter((l) => !hiddenIn(d, l));
      if (!shown.length) return app.dialogs.toast('The selected layers are hidden: there is nothing to stamp', { kind: 'error', timeout: 2200 });
      const top = layers[layers.length - 1];
      const flat = renderLayersFlat(d, shown, { dest: top.parent });
      return placeAbove(d, new RasterLayer({ name: `${top.name} (merged)`, canvas: flat, x: 0, y: 0 }), top, 'Stamp layers');
    }
    return stampDown(d, layers[0]);
  }

  /** One layer: a copy of it merged into the pixel layer below (Merge Down that keeps the layer). */
  function stampDown(d, top) {
    if (!top) return;
    const below = top.parent?.children[top.parent.children.indexOf(top) - 1];
    if (!below || below.type !== 'raster') return app.dialogs.toast('Stamp Layers needs a pixel layer below the selected one, or several selected layers', { kind: 'error', timeout: 2600 });
    if (hiddenIn(d, top) || hiddenIn(d, below)) return app.dialogs.toast('Show both layers before stamping', { kind: 'error' });
    // the layer below keeps its blend mode and opacity: it is rendered neutral and they stay live on the result
    const keep = { blend: below.blend, opacity: below.opacity };
    Object.assign(below, { blend: 'normal', opacity: 1 });
    below.touch();
    let flat;
    try {
      flat = renderLayersFlat(d, [below, top], { dest: top.parent });
    } finally {
      Object.assign(below, keep);
      below.touch();
    }
    const merged = new RasterLayer({ name: below.name, canvas: flat, x: 0, y: 0, clip: below.clip, blend: keep.blend, opacity: keep.opacity, visible: below.visible, locked: { ...below.locked } });
    if (below.color) merged.color = below.color;
    if (below.linked) merged.linked = below.linked;
    structural(app, 'Stamp down', () => {
      const parent = below.parent, i = parent.children.indexOf(below);
      const selected = d.selected.has(below);
      d.remove(below);
      d.add(merged, parent, i);
      if (selected) d.selected.add(merged);
      d.setActive(top);
    }, d, { bytes: flat.width * flat.height * 4 });
    return merged;
  }

  app.commands.registerAll({
    'layer:stamp-visible': { enabled: () => !!app.doc?.root.children.length, run: stampVisible, label: 'Stamp Visible' },
    'layer:stamp-selected': { enabled: () => !!app.doc?.active, run: stampSelected, label: 'Stamp Layers' },
  });
}
