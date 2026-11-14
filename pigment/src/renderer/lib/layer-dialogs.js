// finish-layer-menu (package 15, ARCHITECTURE.md "0.4 features (contracts)", Packages; M.3, M.4, L.12, L.13).
//
// - The New Layer, New Group, Duplicate Layer and Lock Layers dialogs, published as app.layerDialogs for
//   lib/layer-ops.js, which owns the commands that open them (layer:new, layer:new-group, layer:duplicate,
//   layer:new-fill). They open only under M.3's rule (the menu or a key without an argument, or { dialog: true }).
// - The commands without a menu place: New Layer without the dialog, Lock Layers… / Lock All Layers in Group…, the
//   `/` transparency lock, layer navigation (Alt+[ ] , . and Shift+Alt+[ ]), Select > Similar Layers, the opacity and
//   fill digits, the blend-mode keys and Shift+= / Shift+-; Stamp Visible and Stamp Layers come from
//   lib/layers-extras/stamp.js.
//
// The digit, `/` and blend-mode keys never act while a text field has focus (shortcuts.js skips plain keys there and
// app.js drops Shift+Alt keys main.js forwards); the digits leave the layer alone while a painting tool is active
// (tool-traits.js paints(): the tool's own opacity keys come with 0.5).
import { BLEND_MODES, BLEND_LABELS } from './document.js';
import { formDialog } from './form.js';
import { labelOptions } from './layers-extras/tags.js';
import { setLayersProps, lockedProp } from './layer-ops.js';
import { paints } from './tool-traits.js';
import { BLEND_MODE_KEYS } from '../../shared/keymap.js';
import { neutralFill, neutralName, digitPercent, cycleBlend, panelRows, navigateRow } from './layer-menu-model.js';
import { installStamp } from './layers-extras/stamp.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const LOCK_KEYS = ['transparency', 'pixels', 'position', 'all'];
/** How quickly a second digit must follow the first to make a two-digit opacity (settings.layerMenu.digitPairMs). */
export const DIGIT_PAIR_MS = 600;

const layerModes = () => BLEND_MODES.filter(Boolean).map(([id, label]) => [id, label]);
const groupModes = () => [['pass-through', 'Pass Through'], ...layerModes()];
const MODE_ORDER = () => BLEND_MODES.filter(Boolean).map(([id]) => id);

function neutralLabel(mode) {
  const name = neutralName(mode);
  return name ? `Fill with ${BLEND_LABELS[mode] ?? mode}-neutral color (${name})` : 'Fill with neutral color';
}

/**
 * New Layer (Layer > New > Layer…, and the first dialog of Layer > New Fill Layer when `fill` names the paint kind):
 * resolves with { name, clip, color, blend, opacity (percent), neutral } or null.
 */
export async function newLayerDialog(app, { doc, values = {}, fill = null } = {}) {
  const v = {
    name: values.name ?? '',
    clip: !!values.clip,
    color: values.color ?? 'none',
    blend: values.blend && values.blend !== 'pass-through' ? values.blend : 'normal',
    opacity: values.opacity ?? 100,
    neutral: !!values.neutral,
  };
  if (!v.name) v.name = doc ? nextName(doc) : 'Layer 1';
  const fields = [
    { key: 'name', label: 'Name', type: 'text', value: v.name },
    { key: 'clip', label: 'Use Previous Layer to Create Clipping Mask', type: 'checkbox', value: v.clip, span: true },
    { key: 'color', label: 'Color', type: 'select', value: v.color, options: labelOptions() },
    { key: 'blend', label: 'Mode', type: 'select', value: v.blend, options: layerModes() },
    { key: 'opacity', label: 'Opacity', type: 'slider', value: v.opacity, min: 0, max: 100, unit: '%' },
  ];
  // a fill layer is filled by its paint: no neutral colour
  if (!fill) fields.push({ key: 'neutral', label: neutralLabel(v.blend), type: 'checkbox', value: v.neutral, span: true, disabled: (x) => !neutralFill(x.blend) });
  const syncNeutral = (dialog, values) => {
    const input = dialog?.querySelector?.('input[data-key="neutral"]');
    const label = input?.closest('label');
    if (label?.lastChild?.nodeType === 3) label.lastChild.textContent = neutralLabel(values.blend);
  };
  let dialogEl = null;
  const r = await formDialog(app, {
    title: 'New Layer',
    className: 'layer-dialog new-layer-dialog',
    fields,
    okLabel: 'OK',
    onOpen: (dialog, form) => {
      dialogEl = dialog;
      syncNeutral(dialog, form.values);
    },
    onChange: (values, key) => {
      if (key === 'blend') syncNeutral(dialogEl, values);
    },
  });
  if (!r) return null;
  const out = {
    name: String(r.name ?? '').trim() || v.name,
    clip: !!r.clip,
    color: r.color,
    blend: r.blend,
    opacity: Math.max(0, Math.min(100, Number(r.opacity))),
  };
  if (!fill && r.neutral && neutralFill(r.blend)) out.neutral = true;
  return out;
}

/** New Group (Layer > New > Group…): resolves with { name, color, blend, opacity (percent) } or null. */
export async function newGroupDialog(app, { doc, values = {} } = {}) {
  const name = values.name ?? (doc ? nextName(doc, 'Group') : 'Group 1');
  const r = await formDialog(app, {
    title: 'New Group',
    className: 'layer-dialog new-group-dialog',
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: name },
      { key: 'color', label: 'Color', type: 'select', value: values.color ?? 'none', options: labelOptions() },
      { key: 'blend', label: 'Mode', type: 'select', value: values.blend ?? 'pass-through', options: groupModes() },
      { key: 'opacity', label: 'Opacity', type: 'slider', value: values.opacity ?? 100, min: 0, max: 100, unit: '%' },
    ],
  });
  if (!r) return null;
  return { name: String(r.name ?? '').trim() || name, color: r.color, blend: r.blend, opacity: Math.max(0, Math.min(100, Number(r.opacity))) };
}

/**
 * Duplicate Layer(s): As (one layer), the destination document (an open one or a new one) and the new document's
 * name. Resolves with { name?, destination (a document id or 'new'), documentName? } or null.
 */
export async function duplicateDialog(app, { doc, layers = [], values = {} } = {}) {
  const single = layers.length === 1;
  const docs = app.docs?.docs ?? (doc ? [doc] : []);
  const r = await formDialog(app, {
    title: single ? 'Duplicate Layer' : 'Duplicate Layers',
    className: 'layer-dialog duplicate-layer-dialog',
    intro: single ? `Duplicate: ${layers[0].name}` : `Duplicate: ${layers.length} layers`,
    fields: [
      ...(single ? [{ key: 'name', label: 'As', type: 'text', value: values.name ?? `${layers[0].name}${app.settings?.layersPanel?.addCopy === false ? '' : ' copy'}` }] : []),
      { key: 'section', label: 'Destination', type: 'section' },
      { key: 'destination', label: 'Document', type: 'select', value: doc?.id ?? 'new', options: [...docs.map((x) => [x.id, x.name]), ['new', 'New']] },
      { key: 'documentName', label: 'Name', type: 'text', value: values.documentName ?? 'Untitled', when: (x) => x.destination === 'new' },
    ],
  });
  if (!r) return null;
  const out = { destination: r.destination };
  if (single) out.name = String(r.name ?? '').trim() || layers[0].name;
  if (r.destination === 'new') out.documentName = String(r.documentName ?? '').trim() || 'Untitled';
  return out;
}

/** Lock Layers… / Lock All Layers in Group…: resolves with { transparency, pixels, position, all } or null. */
export async function lockDialog(app, { title = 'Lock Layers', values = {}, intro } = {}) {
  const r = await formDialog(app, {
    title,
    intro,
    className: 'layer-dialog lock-layers-dialog',
    fields: [
      { key: 'transparency', label: 'Transparency', type: 'checkbox', value: !!values.transparency },
      { key: 'pixels', label: 'Image', type: 'checkbox', value: !!values.pixels },
      { key: 'position', label: 'Position', type: 'checkbox', value: !!values.position },
      { key: 'all', label: 'All', type: 'checkbox', value: !!values.all },
    ],
  });
  if (!r) return null;
  return Object.fromEntries(LOCK_KEYS.map((k) => [k, !!r[k]]));
}

function nextName(doc, base = 'Layer') {
  const used = new Set(doc.layers().map((l) => l.name));
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

function selectedOrActive(d) {
  const sel = d.selectedLayers();
  return sel.length ? sel : d.active ? [d.active] : [];
}

const isAncestor = (a, l) => {
  for (let p = l.parent; p; p = p.parent) if (p === a) return true;
  return false;
};

/** A lock argument: { ids?, transparency?, pixels?, position?, all? } with at least one boolean, else null. */
function lockArg(arg) {
  if (!arg || typeof arg !== 'object') return null;
  const set = Object.fromEntries(LOCK_KEYS.filter((k) => typeof arg[k] === 'boolean').map((k) => [k, arg[k]]));
  return Object.keys(set).length ? set : null;
}

export function install(app) {
  const doc = () => app.doc;
  const hasLayer = () => !!app.doc?.active;
  const run = (id, arg, ctx) => {
    const def = app.commands.commands.get(id);
    return def && app.commands.isEnabled(id) ? def.run(arg, ctx) : undefined;
  };

  app.layerDialogs = {
    newLayer: (opts) => newLayerDialog(app, opts),
    newGroup: (opts) => newGroupDialog(app, opts),
    duplicate: (opts) => duplicateDialog(app, opts),
    lock: (opts) => lockDialog(app, opts),
  };

  // ---- locks ---------------------------------------------------------------------------------------------------
  async function lockLayers(layers, arg, ctx, { title, intro }) {
    if (!layers.length) return ctx?.cancel();
    let set = lockArg(arg);
    if (!set) {
      const lead = layers.includes(doc().active) ? doc().active : layers[0];
      set = await lockDialog(app, { title, intro, values: lead.locked });
      if (!set) return ctx?.cancel(); // actions (lib/actions.js)
    }
    ctx?.setReplayArg({ ...set }); // actions (lib/actions.js)
    setLayersProps(app, layers, (l) => (Object.entries(set).every(([k, v]) => !!l.locked[k] === v) ? null : { locked: { ...l.locked, ...set } }), 'Lock');
  }

  // ---- the digit keys ------------------------------------------------------------------------------------------
  let lastDigit = null; // { prop, digit, at, ids }: the digit that may pair with the next one
  function digit(prop, d, ctx) {
    const document = doc();
    if (!document?.active || paints(app.tools?.active)) return;
    const layers = selectedOrActive(document).filter((l) => !lockedProp(app, l, prop));
    if (!layers.length) return;
    const ids = layers.map((l) => l.id).sort().join(',');
    const now = performance.now();
    const pairMs = Number(app.settings?.layerMenu?.digitPairMs) || DIGIT_PAIR_MS;
    const pairs = !!lastDigit && lastDigit.prop === prop && lastDigit.ids === ids && now - lastDigit.at < pairMs;
    const percent = digitPercent(pairs ? lastDigit.digit : null, d);
    // after a pair the next digit starts afresh (Photoshop reads two digits at most)
    lastDigit = pairs ? null : { prop, digit: d, at: now, ids };
    const v = percent / 100;
    const change = layers.filter((l) => l[prop] !== v);
    // the second digit of a pair amends the first one's entry: one step in the history
    setLayersProps(app, change, { [prop]: v }, prop === 'opacity' ? 'Opacity' : 'Fill opacity', { merge: pairs });
    ctx?.setReplayCommand?.(prop === 'opacity' ? 'layer:opacity' : 'layer:fill-opacity', percent); // actions record the value
  }

  // ---- blend modes ---------------------------------------------------------------------------------------------
  function setBlend(mode, ctx) {
    ctx?.setReplayCommand?.('layer:blend', mode);
    return run('layer:blend', mode, ctx);
  }
  function stepBlend(dir, ctx) {
    const d = doc();
    const a = d?.active;
    if (!a) return;
    const next = cycleBlend(MODE_ORDER(), a.blend, dir, { group: a.isGroup });
    if (next && next !== a.blend) setBlend(next, ctx);
  }

  // ---- navigation ----------------------------------------------------------------------------------------------
  function navigate(dir, { add = false } = {}) {
    const d = doc();
    if (!d) return;
    const rows = panelRows(d.root);
    const target = navigateRow(rows, d.active, dir, { wrap: !add });
    if (!target || (target === d.active && !add)) return;
    if (add) {
      const keep = new Set(d.selected);
      if (d.active) keep.add(d.active);
      d.setActive(target, { additive: true });
      for (const l of keep) d.selected.add(l);
      d.changed('active', { layer: target });
    } else d.setActive(target);
    app.setEditingMask?.(false);
  }

  function selectSimilar() {
    const d = doc();
    const a = d?.active;
    if (!a) return;
    const like = d.layers().filter((l) => l.type === a.type);
    d.selected = new Set(like);
    d.changed('active', { layer: a });
  }

  const defs = {
    'layer:new-no-dialog': {
      enabled: () => !!app.doc,
      run: (arg, ctx) => {
        ctx?.setReplayCommand?.('layer:new', {});
        return run('layer:new', arg && typeof arg === 'object' ? { ...arg, dialog: false } : {}, ctx);
      },
    },
    'layer:lock-dialog': {
      enabled: hasLayer,
      dialog: true, // actions (lib/actions.js)
      run: (arg, ctx) => {
        const d = doc();
        const layers = Array.isArray(arg?.ids) ? arg.ids.map((id) => d.find(id)).filter(Boolean) : selectedOrActive(d);
        return lockLayers(layers, arg, ctx, { title: 'Lock Layers' });
      },
    },
    'layer:lock-group': {
      enabled: () => !!app.doc?.active?.isGroup && app.doc.active.children.length > 0,
      dialog: true, // actions (lib/actions.js)
      run: (arg, ctx) => {
        const d = doc();
        const g = d.active;
        if (!g?.isGroup) return ctx?.cancel();
        const layers = d.layers().filter((l) => isAncestor(g, l));
        return lockLayers(layers, arg, ctx, { title: 'Lock All Layers in Group', intro: `Locks every layer inside “${g.name}”.` });
      },
    },
    'layer:lock-transparency-toggle': {
      enabled: hasLayer,
      run: (_arg, ctx) => {
        ctx?.setReplayCommand?.('layer:lock', 'transparency');
        return run('layer:lock', 'transparency', ctx);
      },
    },
    'layer:select-forward': { enabled: hasLayer, run: () => navigate('forward') },
    'layer:select-backward': { enabled: hasLayer, run: () => navigate('backward') },
    'layer:select-front': { enabled: () => !!app.doc?.root.children.length, run: () => navigate('front') },
    'layer:select-back': { enabled: () => !!app.doc?.root.children.length, run: () => navigate('back') },
    'layer:select-add-forward': { enabled: hasLayer, run: () => navigate('forward', { add: true }) },
    'layer:select-add-backward': { enabled: hasLayer, run: () => navigate('backward', { add: true }) },
    'layer:select-similar': { enabled: hasLayer, run: selectSimilar, label: 'Similar Layers' },
    'layer:blend-next': { enabled: hasLayer, run: (_a, ctx) => stepBlend(1, ctx) },
    'layer:blend-prev': { enabled: hasLayer, run: (_a, ctx) => stepBlend(-1, ctx) },
  };
  for (const d of DIGITS) {
    defs[`layer:opacity-digit-${d}`] = { enabled: () => hasLayer() && !paints(app.tools?.active), run: (_a, ctx) => digit('opacity', d, ctx) };
    defs[`layer:fill-digit-${d}`] = { enabled: () => hasLayer() && !paints(app.tools?.active), run: (_a, ctx) => digit('fillOpacity', d, ctx) };
  }
  for (const [mode] of BLEND_MODE_KEYS) {
    // Pass Through is a group's mode only; every other layer keeps its own
    defs[`layer:blend-mode-${mode}`] = { enabled: () => hasLayer() && (mode !== 'pass-through' || !!app.doc.active.isGroup), run: (_a, ctx) => setBlend(mode, ctx) };
  }
  app.commands.registerAll(defs);
  installStamp(app);
}
