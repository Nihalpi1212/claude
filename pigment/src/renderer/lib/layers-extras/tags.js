// Layer colour labels (layer.color) and layer links (layer.linked: the id of a link set). Linked
// layers move together (the Move tool asks app.linkedLayers); labels tint the Layers panel row.
//
// lib/document.js does not describe these two properties, so they are mirrored into
// doc.meta.layerTags = { [layerId]: { color?, linked? } } (doc.meta is saved in .pigment files) on
// every tree or property change, and put back on the layers when a document is opened.
import { newId } from '../document.js';
import { setLayerProps } from '../layer-ops.js';
import { icon } from '../icons.js';

/** [value, label, css colour] in Photoshop's order. */
export const LABEL_COLORS = [
  ['none', 'No Color', 'transparent'],
  ['red', 'Red', '#e5534b'],
  ['orange', 'Orange', '#e8913a'],
  ['yellow', 'Yellow', '#e3c93c'],
  ['green', 'Green', '#57ab5a'],
  ['blue', 'Blue', '#4f81ff'],
  ['violet', 'Violet', '#986ee2'],
  ['gray', 'Gray', '#8b949e'],
];
const VALID = new Set(LABEL_COLORS.map((c) => c[0]));
export const labelOptions = () => LABEL_COLORS.map(([value, label]) => [value, label]);
export const normaliseLabel = (c) => (VALID.has(c) && c !== 'none' ? c : null);
export const labelOf = (layer) => normaliseLabel(layer?.color) ?? 'none';

/** Rebuilds doc.meta.layerTags from the tree (only when it differs, so nothing churns during drags). */
export function syncTags(doc) {
  if (!doc?.root) return;
  const tags = {};
  for (const l of doc.layers()) {
    const color = normaliseLabel(l.color);
    const linked = typeof l.linked === 'string' && l.linked ? l.linked : null;
    if (color || linked) tags[l.id] = { ...(color ? { color } : {}), ...(linked ? { linked } : {}) };
  }
  const had = doc.meta?.layerTags;
  const empty = !Object.keys(tags).length;
  if (empty && !had) return;
  if (!empty && had && JSON.stringify(had) === JSON.stringify(tags)) return;
  const meta = { ...(doc.meta ?? {}) };
  if (empty) delete meta.layerTags;
  else meta.layerTags = tags;
  doc.meta = meta;
}

/** Puts the saved labels and links back on a freshly opened document's layers. */
export function applyTags(doc) {
  const tags = doc?.meta?.layerTags;
  if (!tags || typeof tags !== 'object') return;
  for (const l of doc.layers()) {
    const t = tags[l.id];
    if (!t) continue;
    if (l.color === undefined && normaliseLabel(t.color)) l.color = t.color;
    if (l.linked === undefined && typeof t.linked === 'string') l.linked = t.linked;
  }
  // a link set needs two members: a lone survivor (its partner was not saved) is not linked to anything
  dropLoneLinks(doc);
}

function dropLoneLinks(doc) {
  const count = new Map();
  for (const l of doc.layers()) if (l.linked) count.set(l.linked, (count.get(l.linked) ?? 0) + 1);
  for (const l of doc.layers()) if (l.linked && count.get(l.linked) < 2) l.linked = null;
}

/**
 * Keeps link sets whole while the tree changes. A layer whose partners are gone (deleted, merged, converted to a
 * smart object) is not linked to anything: its link is taken off, and remembered (layer.loneLink), because the
 * change was not this module's to record: when Undo brings a partner back, the remembered link returns with it
 * (set ids are never reused, so nothing but Undo can make a remembered set whole again).
 * layer.loneLink is a list: a layer can lose a second set (linked again, then that partner deleted too) while the
 * first is still remembered, and Undo walking back past both must find the first one again.
 * Returns true when a layer changed.
 */
export function settleLinks(doc) {
  if (!doc?.root) return false;
  const layers = doc.layers();
  const remembered = (l) => (Array.isArray(l.loneLink) ? l.loneLink : l.loneLink ? [l.loneLink] : []);
  // members of a set: the layers linked to it, and the unlinked ones that remember it (they can take it back)
  const count = new Map();
  const add = (id) => count.set(id, (count.get(id) ?? 0) + 1);
  for (const l of layers) {
    if (l.linked) add(l.linked);
    else for (const id of new Set(remembered(l))) add(id);
  }
  let changed = false;
  for (const l of layers) {
    const lone = remembered(l);
    if (l.linked && count.get(l.linked) < 2) {
      l.loneLink = [...lone.filter((id) => id !== l.linked), l.linked];
      l.linked = null;
      changed = true;
    } else if (!l.linked && lone.length) {
      // the most recently dissolved set that is whole again
      const back = lone.findLast((id) => count.get(id) >= 2);
      if (!back) continue;
      l.linked = back;
      const rest = lone.filter((id) => id !== back);
      l.loneLink = rest.length ? rest : null;
      changed = true;
    }
  }
  return changed;
}

const docOf = (app, layer) => {
  let root = layer;
  while (root?.parent) root = root.parent;
  return app.docs?.docs.find((d) => d.root === root) ?? app.doc;
};

export function installTags(app) {
  const doc = () => app.doc;
  const selectedOrActive = (d) => {
    const sel = d.selectedLayers();
    return sel.length ? sel : d.active ? [d.active] : [];
  };

  /** Every layer linked with the given layer(s), the given ones included (document order of the input first). */
  app.linkedLayers = (layers) => {
    const list = (Array.isArray(layers) ? layers : [layers]).filter(Boolean);
    const ids = new Set(list.map((l) => l.linked).filter(Boolean));
    if (!ids.size) return list;
    const out = new Set(list);
    const d = docOf(app, list[0]);
    for (const l of d?.layers() ?? []) if (l.linked && ids.has(l.linked)) out.add(l);
    return [...out];
  };

  /** Layers panel rows (the one hook in lib/panels/layers.js row()): label tint, link badge, label menu on the eye. */
  app.decorateLayerRow = (li, layer) => {
    const color = labelOf(layer);
    if (color !== 'none') li.dataset.color = color;
    if (layer.linked) {
      li.dataset.linked = 'true';
      const badge = document.createElement('span');
      badge.className = 'layer-linked-badge';
      badge.title = 'Linked with other layers: they move together (Layer › Link Layers unlinks)';
      badge.innerHTML = icon('link');
      li.querySelector('.layer-badges')?.appendChild(badge);
    }
    // Photoshop keeps the colour labels on the eye column's context menu
    li.querySelector('.eye')?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const d = doc();
      if (d && !d.selected.has(layer)) d.setActive(layer);
      app.dialogs.popover(li, LABEL_COLORS.map(([value, label]) => ({ label, checked: labelOf(layer) === value, onSelect: () => app.commands.run('layer:color', value, 'panel') })), { at: { x: e.clientX, y: e.clientY } });
    });
  };

  function setColor(arg) {
    const d = doc();
    const value = normaliseLabel(typeof arg === 'object' && arg ? arg.color : arg);
    const layers = selectedOrActive(d).filter((l) => normaliseLabel(l.color) !== value);
    if (!layers.length) return;
    d.history.group('Layer color', () => {
      for (const l of layers) setLayerProps(app, l, { color: value }, 'Layer color');
    });
  }

  function link() {
    const d = doc();
    const sel = selectedOrActive(d);
    if (!sel.length) return;
    const all = d.layers();
    const patch = new Map(); // layer -> new link id (null = unlinked)
    const sets = new Set(sel.map((l) => l.linked).filter(Boolean));
    const fullyLinked = sel.every((l) => l.linked) && sets.size === 1;
    let label;
    if (sel.length === 1 || fullyLinked) {
      // one linked layer, or layers that already share a set: take them out of it
      if (!sel.some((l) => l.linked)) return app.dialogs.toast('Select two or more layers to link them', { kind: 'info', timeout: 2200 });
      for (const l of sel) patch.set(l, null);
      label = 'Unlink layers';
    } else {
      // the selection joins one set; sets some of the selected layers already belonged to merge into it
      const id = [...sets][0] ?? newId('K');
      for (const l of all) if ((l.linked && sets.has(l.linked)) || sel.includes(l)) patch.set(l, id);
      label = 'Link layers';
    }
    // a set left with a single member is no link at all
    const after = new Map(all.map((l) => [l, patch.has(l) ? patch.get(l) : l.linked ?? null]));
    const count = new Map();
    for (const id of after.values()) if (id) count.set(id, (count.get(id) ?? 0) + 1);
    for (const [l, id] of after) if (id && count.get(id) < 2) patch.set(l, null);
    const changes = [...patch].filter(([l, id]) => (l.linked ?? null) !== id);
    if (!changes.length) return;
    d.history.group(label, () => {
      for (const [l, id] of changes) setLayerProps(app, l, { linked: id }, label);
    });
  }

  function selectLinked() {
    const d = doc();
    if (!anyLinked()) return app.dialogs.toast('The selected layer is not linked to other layers', { kind: 'info', timeout: 2200 });
    const linked = app.linkedLayers(selectedOrActive(d));
    d.selected = new Set(linked);
    if (!d.active || !d.selected.has(d.active)) d.active = linked[0] ?? d.active;
    d.changed('active', { layer: d.active });
  }

  const anyLinked = () => selectedOrActive(doc()).some((l) => l.linked);
  app.commands.registerAll({
    // enabled whenever a layer is targeted (the native menu and the panel button are): a lone, unlinked layer gets told why nothing happens
    'layer:link': { enabled: () => !!doc()?.active || (doc()?.selected.size ?? 0) > 0, checked: () => !!doc() && anyLinked(), run: link, label: 'Link Layers' },
    'layer:select-linked': { enabled: () => !!doc()?.active || (doc()?.selected.size ?? 0) > 0, run: selectLinked, label: 'Select Linked Layers' },
    'layer:color': { enabled: () => !!doc()?.active, run: setColor, label: 'Layer Color' },
  });

  // persistence through doc.meta (see the header)
  app.on('doc:opened', (d) => {
    applyTags(d);
    // a document built from copies (Image › Duplicate) has its labels and links on the layers, under new ids
    settleLinks(d);
    syncTags(d);
  });
  app.on('doc:change', (e) => {
    if (e.kind !== 'tree' && e.kind !== 'props' && e.kind !== 'canvas' && e.kind !== 'history') return;
    // a delete, merge or conversion may have left one layer of a link set behind. Not while a history group is
    // open (Link / Unlink set one layer after the other): settling between them would take a partner's link off
    // before its own change records it, and Undo would restore that wrong 'before'. The group's closing 'history'
    // change settles
    if (!e.doc.history?.batch && settleLinks(e.doc)) app.commands.invalidate();
    syncTags(e.doc);
  });
  for (const d of app.docs?.docs ?? []) applyTags(d);
}
