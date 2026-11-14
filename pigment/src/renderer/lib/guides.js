// guides-snapping (package 11, ARCHITECTURE.md "0.4 features (contracts)", Packages; F, L.10, E12, E20, E27, E31):
// guides as document-store objects, the View > Guides commands, Snap To, Smart Guides, the ruler commands and the
// "Guides, Grid & Slices" preferences. The canvas side (drawing, ruler drags, the ruler corner and its menu) is in
// canvas-view.js, the Move tool's guide picking in tools/move.js, the snapping in snap.js and the rulers in rulers.js.
//
// Guides are { id, axis: 'x' | 'y', pos (document px), color? } in doc.store 'guides' (D): every change is one
// history entry through the store. Selected guides are view state (view.selectedGuides, a Set of ids). Every command
// that changes the document declares changesDocument (E31): it is refused while a slow operation runs and inside the
// on-canvas workspaces (Blur Gallery, Select and Mask, Content-Aware Scale), it commits a running Free Transform
// first, and the actions recorder records it with its argument.
import { formDialog } from './form.js';
import { layerContentBounds } from './properties/ui.js';
import { pathBounds } from './document.js';
import { UNITS, UNIT_LABEL, UNIT_NAMES, roundForUnit } from './rulers.js';
import { SNAP_TO_KEYS, snapToState } from './snap.js';
import { guideLayout, guidesFromBounds, mergeGuides, normalizeLayout } from './guide-layout.js';
import { DEFAULT_SETTINGS } from '../../shared/defaults.js';

/** Photoshop's guide colours (the New Guide and Edit Selected Guides menus). */
export const GUIDE_COLORS = [
  ['#1ec8ff', 'Cyan'],
  ['#7fb2ff', 'Light Blue'],
  ['#ff7f7f', 'Light Red'],
  ['#00c800', 'Green'],
  ['#3c5aff', 'Medium Blue'],
  ['#ffff00', 'Yellow'],
  ['#ff00ff', 'Magenta'],
  ['#c0c0c0', 'Light Gray'],
  ['#000000', 'Black'],
];
export const GUIDE_STYLES = [['lines', 'Lines'], ['dashed', 'Dashed Lines']];
export const GRID_STYLES = [['lines', 'Lines'], ['dashed', 'Dashed Lines'], ['dots', 'Dots']];
const GUIDE_DEFAULTS = DEFAULT_SETTINGS.guides ?? {};
const HEX = /^#[0-9a-f]{6}$/i;

/** settings.guides with every sub-key (the stored object may predate a key). */
export function guideSettings(app) {
  return { ...GUIDE_DEFAULTS, ...(app.settings?.guides ?? {}) };
}

/** Writes sub-keys of settings.guides (a new object: the defaults are shared references, never mutated). */
export function saveGuideSettings(app, patch) {
  return app.saveSettings({ guides: { ...guideSettings(app), ...patch } });
}

/** The colour a guide is drawn in: its own, else the preference colour. */
export function guideColor(app, g) {
  return g?.color ?? guideSettings(app).color ?? '#1ec8ff';
}

/** The view's selected guide ids that still exist (view state; the Move tool selects). */
export function selectedGuides(view) {
  const doc = view?.doc;
  if (!doc || !view.selectedGuides?.size) return [];
  return doc.guides.filter((g) => view.selectedGuides.has(g.id));
}

/** Replaces the view's guide selection. */
export function selectGuides(app, view, ids) {
  if (!view) return;
  view.selectedGuides = new Set(ids);
  view.invalidate?.();
  app.commands?.invalidate?.();
}

/** The guide under a document point within `tol` screen pixels (nearest first), or null. */
export function guideAt(view, p, tol = 4) {
  const doc = view?.doc;
  if (!doc?.guides?.length) return null;
  let best = null;
  for (const g of doc.guides) {
    const s = g.axis === 'x' ? view.toScreen(g.pos, p.y) : view.toScreen(p.x, g.pos);
    const at = view.toScreen(p.x, p.y);
    const d = Math.hypot(s.x - at.x, s.y - at.y);
    if (d <= tol && (!best || d < best.d)) best = { g, d };
  }
  return best?.g ?? null;
}

/** True while guides can be picked and moved with the Move tool (shown and not locked). */
export function guidesEditable(app) {
  return app.settings?.showGuides !== false && !guideSettings(app).lock;
}

/** Turns View > Show > Guides on (making a guide shows them, as in Photoshop). */
function showGuides(app) {
  if (app.settings?.showGuides !== false) return;
  app.saveSettings({ showGuides: true });
  app.view?.invalidate();
}

/** A guide of the document matching a recorded one: by id, else by axis and position (another document). */
function findGuide(doc, ref) {
  if (!ref) return null;
  return doc.guides.find((g) => g.id === ref.id) ?? doc.guides.find((g) => g.axis === ref.axis && Math.abs(g.pos - (ref.pos ?? ref.from)) < 0.005) ?? null;
}

const round2 = (v) => Math.round(v * 100) / 100;
const plainGuide = (g) => ({ axis: g.axis, pos: g.pos, ...(g.color ? { color: g.color } : {}) });

/** The colour menu of the guide dialogs: Default (the preference), Photoshop's colours, Custom. */
function colorFields(current, { defaultLabel = 'Default' } = {}) {
  const known = !current || GUIDE_COLORS.some(([c]) => c === current);
  return {
    fields: [
      { key: 'color', label: 'Color', type: 'select', options: [['default', defaultLabel], ...GUIDE_COLORS, ['custom', 'Custom…']] },
      { key: 'customColor', label: 'Custom color', type: 'color', when: (v) => v.color === 'custom' },
    ],
    values: { color: !current ? 'default' : known ? current : 'custom', customColor: current && !known ? current : '#1ec8ff' },
  };
}

function chosenColor(values) {
  if (values.color === 'default') return null;
  const c = values.color === 'custom' ? values.customColor : values.color;
  return typeof c === 'string' && HEX.test(c) ? c.toLowerCase() : null;
}

/** "h40" / "v12 cm" / "40": { axis (or null), text } of a typed guide position. */
export function splitAxisPrefix(text) {
  const m = /^\s*([hv])\s*(.*)$/i.exec(String(text ?? ''));
  return m ? { axis: m[1].toLowerCase() === 'h' ? 'y' : 'x', text: m[2] } : { axis: null, text: String(text ?? '') };
}

// ---- dialogs -----------------------------------------------------------------------------------------------------

async function newGuideDialog(app, doc) {
  const r = app.rulers;
  const unit = r.unit(doc);
  const col = colorFields(null);
  const values = await formDialog(app, {
    title: 'New Guide',
    className: 'guide-dialog',
    fields: [
      { key: 'position', label: 'Position', type: 'text', autofocus: true, help: `${UNIT_NAMES[unit]} from the ruler origin. Type a unit (px, in, cm, mm, pt, %) to use another; "h" in front makes a horizontal guide.` },
      { key: 'orientation', label: 'Orientation', type: 'segment', options: [['y', 'Horizontal'], ['x', 'Vertical']] },
      ...col.fields,
    ],
    values: { position: String(roundForUnit(r.toRuler(doc, 'x', doc.width / 2), unit)), orientation: 'x', ...col.values },
    validate: (v) => {
      const { axis, text } = splitAxisPrefix(v.position);
      const ok = r.parse(doc, axis ?? v.orientation, text) !== null;
      if (!ok) app.dialogs.toast('Type a position, such as 120 or 2.5 cm', { kind: 'error', timeout: 2500 });
      return ok;
    },
  });
  if (!values) return null;
  const { axis: typed, text } = splitAxisPrefix(values.position);
  const axis = typed ?? values.orientation;
  const pos = r.parse(doc, axis, text);
  if (pos === null) return null;
  const color = chosenColor(values);
  return { axis, pos: round2(pos), ...(color ? { color } : {}) };
}

/** The New Guide Layout dialog's fields: values in ruler units (Width and Height may stay empty). */
function layoutFields(unit) {
  const u = UNIT_LABEL[unit];
  const n = (key, label, extra = {}) => ({ key, label, type: 'number', min: 0, max: 100000, step: unit === 'px' ? 1 : 0.01, unit: u, ...extra });
  return [
    { key: 'columns', label: 'Columns', type: 'checkbox', span: true },
    { key: 'colNumber', label: 'Number', type: 'number', min: 1, max: 500, disabled: (v) => !v.columns },
    { key: 'colWidth', label: 'Width', type: 'text', placeholder: 'Fill', disabled: (v) => !v.columns, help: 'Empty: the columns share the width' },
    n('colGutter', 'Gutter', { disabled: (v) => !v.columns }),
    { key: 'rows', label: 'Rows', type: 'checkbox', span: true },
    { key: 'rowNumber', label: 'Number', type: 'number', min: 1, max: 500, disabled: (v) => !v.rows },
    { key: 'rowHeight', label: 'Height', type: 'text', placeholder: 'Fill', disabled: (v) => !v.rows },
    n('rowGutter', 'Gutter', { disabled: (v) => !v.rows }),
    { key: 'margin', label: 'Margin', type: 'checkbox', span: true },
    n('top', 'Top', { disabled: (v) => !v.margin }),
    n('left', 'Left', { disabled: (v) => !v.margin }),
    n('bottom', 'Bottom', { disabled: (v) => !v.margin }),
    n('right', 'Right', { disabled: (v) => !v.margin }),
    { key: 'center', label: 'Center columns', type: 'checkbox', span: true },
    { key: 'clear', label: 'Clear existing guides', type: 'checkbox', span: true },
  ];
}

/** The dialog's values (ruler units) as a layout spec in document px. */
function layoutSpecFrom(app, doc, v) {
  const r = app.rulers;
  const len = (axis, x) => {
    if (x === '' || x === null || x === undefined) return null;
    const px = typeof x === 'number' ? r.fromRuler(doc, axis, x, { length: true }) : r.parse(doc, axis, x, { length: true });
    return px === null || !Number.isFinite(px) ? null : round2(px);
  };
  return {
    columns: { enabled: !!v.columns, number: Number(v.colNumber) || 1, width: len('x', v.colWidth), gutter: len('x', Number(v.colGutter) || 0) ?? 0 },
    rows: { enabled: !!v.rows, number: Number(v.rowNumber) || 1, height: len('y', v.rowHeight), gutter: len('y', Number(v.rowGutter) || 0) ?? 0 },
    margin: { enabled: !!v.margin, top: len('y', Number(v.top) || 0) ?? 0, left: len('x', Number(v.left) || 0) ?? 0, bottom: len('y', Number(v.bottom) || 0) ?? 0, right: len('x', Number(v.right) || 0) ?? 0 },
    center: !!v.center,
  };
}

async function guideLayoutDialog(app, doc) {
  const unit = app.rulers.unit(doc);
  const col = colorFields(null);
  const view = doc.view;
  const preview = (v) => {
    if (!view) return;
    const spec = layoutSpecFrom(app, doc, v);
    const color = chosenColor(v);
    view.guidePreview = guideLayout(spec, doc).map((g) => ({ ...g, ...(color ? { color } : {}) }));
    view.guidePreviewClears = !!v.clear;
    view.invalidate();
  };
  const values = await formDialog(app, {
    title: 'New Guide Layout',
    className: 'guide-dialog guide-layout-dialog',
    width: 460,
    intro: `Sizes in ${UNIT_NAMES[unit].toLowerCase()}. The guides show on the canvas while the dialog is open.`,
    fields: [...layoutFields(unit), ...col.fields],
    values: { columns: true, colNumber: 8, colWidth: '', colGutter: unit === 'px' ? 20 : 0, rows: false, rowNumber: 1, rowHeight: '', rowGutter: 0, margin: false, top: 0, left: 0, bottom: 0, right: 0, center: true, clear: true, ...col.values },
    onChange: (v) => preview(v),
    onOpen: (dialog, form) => preview(form.values),
  }).finally(() => {
    if (view) {
      view.guidePreview = null;
      view.guidePreviewClears = false;
      view.invalidate();
    }
  });
  if (!values) return null;
  const color = chosenColor(values);
  return { ...layoutSpecFrom(app, doc, values), clear: !!values.clear, ...(color ? { color } : {}) };
}

async function editGuidesDialog(app, doc, list) {
  const r = app.rulers;
  const one = list.length === 1 ? list[0] : null;
  const shared = list.every((g) => (g.color ?? null) === (list[0].color ?? null)) ? list[0].color ?? null : null;
  const col = colorFields(shared);
  const unit = r.unit(doc);
  const values = await formDialog(app, {
    title: 'Edit Selected Guides',
    className: 'guide-dialog',
    intro: one ? null : `${list.length} guides are selected: the colour applies to all of them.`,
    fields: [
      ...(one ? [
        { key: 'position', label: 'Position', type: 'text', help: `${UNIT_NAMES[unit]} from the ruler origin` },
        { key: 'orientation', label: 'Orientation', type: 'segment', options: [['y', 'Horizontal'], ['x', 'Vertical']] },
      ] : []),
      ...col.fields,
    ],
    values: { ...(one ? { position: String(roundForUnit(r.toRuler(doc, one.axis, one.pos), unit)), orientation: one.axis } : {}), ...col.values },
    validate: (v) => !one || r.parse(doc, v.orientation, v.position) !== null,
  });
  if (!values) return null;
  const color = chosenColor(values);
  const out = { guides: list.map((g) => ({ id: g.id, axis: g.axis, pos: g.pos })), color };
  if (one) {
    const pos = r.parse(doc, values.orientation, values.position);
    if (pos !== null) out.to = { axis: values.orientation, pos: round2(pos) };
  }
  return out;
}

// ---- preferences (E20) ------------------------------------------------------------------------------------------

/** The "Guides, Grid & Slices" preferences section (replaces the skeleton's built-in one). */
export const guidesPreferences = {
  id: 'guides',
  title: 'Guides, Grid & Slices',
  order: 40,
  fields: [
    { key: 'guideColor', label: 'Guide colour', type: 'color' },
    { key: 'guideStyle', label: 'Guide style', type: 'select', options: GUIDE_STYLES },
    { key: 'smartGuideColor', label: 'Smart Guides colour', type: 'color' },
    { key: 'gridColor', label: 'Grid colour', type: 'color' },
    { key: 'gridStyle', label: 'Grid style', type: 'select', options: GRID_STYLES },
    { key: 'gridSize', label: 'Gridline every', type: 'number', min: 0.01, max: 100000, step: 0.01 },
    { key: 'gridUnit', label: 'Gridline unit', type: 'select', options: UNITS.map((u) => [u, UNIT_NAMES[u]]) },
    { key: 'gridSubdivisions', label: 'Subdivisions', type: 'number', min: 1, max: 100 },
  ],
  read(s) {
    const g = { ...GUIDE_DEFAULTS, ...(s.guides ?? {}) };
    return {
      guideColor: g.color, guideStyle: g.style, smartGuideColor: g.smartColor, gridColor: g.gridColor, gridStyle: g.gridStyle,
      gridSize: Number(s.gridSize ?? DEFAULT_SETTINGS.gridSize), gridUnit: UNIT_LABEL[g.gridUnit] ? g.gridUnit : 'px',
      gridSubdivisions: Number(s.gridSubdivisions ?? DEFAULT_SETTINGS.gridSubdivisions),
    };
  },
  write(v, s) {
    const g = { ...GUIDE_DEFAULTS, ...(s.guides ?? {}) };
    const hex = (c, d) => (typeof c === 'string' && HEX.test(c) ? c.toLowerCase() : d);
    const next = {
      ...g,
      color: hex(v.guideColor, g.color), style: GUIDE_STYLES.some(([k]) => k === v.guideStyle) ? v.guideStyle : g.style,
      smartColor: hex(v.smartGuideColor, g.smartColor), gridColor: hex(v.gridColor, g.gridColor),
      gridStyle: GRID_STYLES.some(([k]) => k === v.gridStyle) ? v.gridStyle : g.gridStyle, gridUnit: UNITS.includes(v.gridUnit) ? v.gridUnit : g.gridUnit,
    };
    const patch = {};
    if (Object.keys(next).some((k) => next[k] !== g[k])) patch.guides = next;
    const size = Number(v.gridSize);
    if (Number.isFinite(size) && size > 0 && size !== s.gridSize) patch.gridSize = size;
    const sub = Math.round(Number(v.gridSubdivisions));
    if (Number.isFinite(sub) && sub >= 1 && sub !== s.gridSubdivisions) patch.gridSubdivisions = Math.min(100, sub);
    return patch;
  },
};

// ---- install ---------------------------------------------------------------------------------------------------

export function install(app) {
  // layer snap targets are the layers' content boxes (what you see), as the Move tool moves them
  if (app.snap) app.snap.boundsOf = (layer) => layerContentBounds(layer);
  app.preferences?.registerSection(guidesPreferences);

  const has = () => !!app.doc;
  const viewOf = () => app.doc?.view ?? app.view ?? null;
  const store = () => app.doc.store;
  const canvasGuides = (doc) => doc.guides.filter((g) => !g.artboard);
  const toggleGuideSetting = (key) => {
    saveGuideSettings(app, { [key]: !guideSettings(app)[key] });
    app.view?.invalidate();
    app.commands.invalidate();
  };

  app.commands.registerAll({
    'view:new-guide': {
      label: 'New Guide…',
      enabled: has,
      changesDocument: true,
      run: async (arg, ctx) => {
        const doc = app.doc;
        let g = arg && typeof arg === 'object' ? arg : null;
        if (!g) {
          g = await newGuideDialog(app, doc);
          if (!g) return ctx?.cancel();
          ctx?.setReplayArg(plainGuide(g));
        }
        if (app.doc !== doc || !Number.isFinite(Number(g.pos))) return undefined;
        const stored = doc.store.add('guides', { axis: g.axis === 'y' ? 'y' : 'x', pos: round2(Number(g.pos)), ...(typeof g.color === 'string' && HEX.test(g.color) ? { color: g.color } : {}) }, { label: 'New Guide' });
        showGuides(app);
        return stored ? null : undefined;
      },
    },
    'view:clear-guides': {
      label: 'Clear Canvas Guides',
      enabled: () => !!app.doc && canvasGuides(app.doc).length > 0,
      changesDocument: true,
      run: () => {
        const doc = app.doc;
        doc.store.set('guides', doc.guides.filter((g) => g.artboard), { label: 'Clear Guides' });
        viewOf()?.selectedGuides?.clear();
      },
    },
    'view:clear-selected-guides': {
      label: 'Clear Selected Guides',
      enabled: () => !!app.doc?.guides.length,
      changesDocument: true,
      run: (arg, ctx) => {
        const doc = app.doc;
        const view = viewOf();
        const list = Array.isArray(arg?.guides) ? arg.guides.map((ref) => findGuide(doc, ref)).filter(Boolean) : selectedGuides(view);
        if (!list.length) {
          ctx?.cancel();
          return false;
        }
        if (!arg) ctx?.setReplayArg({ guides: list.map((g) => ({ id: g.id, axis: g.axis, pos: g.pos })) });
        doc.store.remove('guides', list.map((g) => g.id), { label: list.length > 1 ? 'Delete Guides' : 'Delete Guide' });
        if (view?.selectedGuides) for (const g of list) view.selectedGuides.delete(g.id);
        app.commands.invalidate();
        return true;
      },
    },
    'view:clear-artboard-guides': {
      label: 'Clear Selected Artboard Guides',
      // artboards arrive in a later release: guides carry `artboard` (a layer id) only then
      enabled: () => {
        const doc = app.doc;
        if (!doc) return false;
        const ids = new Set([...(doc.selected ?? [])].map((l) => l?.id ?? l));
        return doc.guides.some((g) => g.artboard && ids.has(g.artboard));
      },
      changesDocument: true,
      run: () => {
        const doc = app.doc;
        const ids = new Set([...(doc.selected ?? [])].map((l) => l?.id ?? l));
        doc.store.set('guides', doc.guides.filter((g) => !(g.artboard && ids.has(g.artboard))), { label: 'Clear Artboard Guides' });
      },
    },
    'view:move-guide': {
      label: 'Move Guide',
      enabled: () => !!app.doc?.guides.length,
      changesDocument: true,
      run: (arg) => {
        const doc = app.doc;
        const moves = (Array.isArray(arg?.moves) ? arg.moves : []).map((m) => ({ g: findGuide(doc, { id: m.id, axis: m.axis, pos: m.from }), to: Number(m.to), axis: m.axis }));
        const by = new Map(moves.filter((m) => m.g && Number.isFinite(m.to)).map((m) => [m.g.id, m]));
        if (!by.size) return false;
        doc.store.set('guides', doc.guides.map((g) => (by.has(g.id) ? { ...g, pos: round2(by.get(g.id).to) } : g)), { label: by.size > 1 ? 'Move Guides' : 'Move Guide' });
        return true;
      },
    },
    'view:edit-selected-guides': {
      label: 'Edit Selected Guides…',
      enabled: () => selectedGuides(viewOf()).length > 0,
      changesDocument: true,
      run: async (arg, ctx) => {
        const doc = app.doc;
        let spec = arg && typeof arg === 'object' ? arg : null;
        if (!spec) {
          spec = await editGuidesDialog(app, doc, selectedGuides(viewOf()));
          if (!spec) return ctx?.cancel();
          ctx?.setReplayArg(spec);
        }
        if (app.doc !== doc) return undefined;
        const list = (spec.guides ?? []).map((ref) => findGuide(doc, ref)).filter(Boolean);
        if (!list.length) return false;
        const ids = new Set(list.map((g) => g.id));
        const color = typeof spec.color === 'string' && HEX.test(spec.color) ? spec.color.toLowerCase() : null;
        const next = doc.guides.map((g) => {
          if (!ids.has(g.id)) return g;
          const out = { id: g.id, axis: g.axis, pos: g.pos, ...(g.artboard ? { artboard: g.artboard } : {}) };
          if (color) out.color = color;
          if (spec.to && list.length === 1) {
            out.axis = spec.to.axis === 'y' ? 'y' : 'x';
            out.pos = round2(Number(spec.to.pos));
          }
          return out;
        });
        doc.store.set('guides', next, { label: 'Edit Guides' });
        return true;
      },
    },
    'view:new-guide-layout': {
      label: 'New Guide Layout…',
      enabled: has,
      changesDocument: true,
      run: async (arg, ctx) => {
        const doc = app.doc;
        let spec = arg && typeof arg === 'object' ? arg : null;
        if (!spec) {
          spec = await guideLayoutDialog(app, doc);
          if (!spec) return ctx?.cancel();
          ctx?.setReplayArg(spec);
        }
        if (app.doc !== doc) return undefined;
        const color = typeof spec.color === 'string' && HEX.test(spec.color) ? spec.color.toLowerCase() : null;
        const added = guideLayout(normalizeLayout(spec), doc).map((g) => ({ ...g, ...(color ? { color } : {}) }));
        const base = spec.clear ? doc.guides.filter((g) => g.artboard) : doc.guides;
        doc.store.set('guides', mergeGuides(base, added), { label: 'New Guide Layout' });
        showGuides(app);
        return true;
      },
    },
    'view:guides-from-shape': {
      label: 'New Guides From Shape',
      enabled: () => !!shapeBox(app.doc?.active),
      changesDocument: true,
      run: () => {
        const doc = app.doc;
        const b = shapeBox(doc.active);
        if (!b) return false;
        doc.store.set('guides', mergeGuides(doc.guides, guidesFromBounds(b)), { label: 'New Guides From Shape' });
        showGuides(app);
        return true;
      },
    },
    'view:lock-guides': {
      label: 'Lock Guides',
      checked: () => !!guideSettings(app).lock,
      run: () => {
        toggleGuideSetting('lock');
        if (guideSettings(app).lock) selectGuides(app, viewOf(), []);
      },
    },
    'view:smart-guides': {
      label: 'Smart Guides',
      checked: () => guideSettings(app).smartGuides !== false,
      run: () => toggleGuideSetting('smartGuides'),
    },
    'view:snap-to': {
      label: 'Snap To',
      run: (key) => {
        const cur = snapToState(app.settings);
        let next;
        if (key === 'all' || key === 'none') next = Object.fromEntries(SNAP_TO_KEYS.map((k) => [k, key === 'all']));
        else if (SNAP_TO_KEYS.includes(key)) next = { ...cur, [key]: !cur[key] };
        else return false;
        saveGuideSettings(app, { snapTo: next });
        app.commands.invalidate();
        return true;
      },
    },
    'view:ruler-unit': {
      label: 'Ruler Units',
      run: (unit) => {
        if (!UNITS.includes(unit)) return false;
        app.saveSettings({ rulerUnit: unit });
        app.view?.invalidate();
        return true;
      },
    },
    'view:ruler-origin': {
      label: 'Ruler Origin',
      enabled: has,
      changesDocument: true,
      run: (p) => (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) ? app.rulers.setOrigin(app.doc, { x: Number(p.x), y: Number(p.y) }) : false),
    },
    'view:ruler-origin-reset': {
      label: 'Reset Ruler Origin',
      enabled: () => {
        const o = app.doc ? app.rulers.origin(app.doc) : null;
        return !!o && (o.x !== 0 || o.y !== 0);
      },
      changesDocument: true,
      run: () => app.rulers.resetOrigin(app.doc),
    },
  });

  // Ctrl/Cmd released: the Move tool's hover measurement goes away
  window.addEventListener('keyup', (e) => {
    if ((e.key === 'Control' || e.key === 'Meta') && app.snap?.overlay?.measure) app.snap.end();
  });
}

/** The box New Guides From Shape uses: a shape layer's path (or a layer's vector mask path), in document px. */
export function shapeBox(layer) {
  if (!layer) return null;
  const path = layer.type === 'shape' ? layer.path : layer.vectorMask?.path ?? null;
  if (!path) return null;
  const b = pathBounds(path);
  if (!b) return null;
  // a transformed shape layer draws its path through the transform: use what it draws
  if (layer.type === 'shape' && layer.transform) return layerContentBounds(layer);
  return b;
}
