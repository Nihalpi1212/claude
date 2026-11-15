// presets-panels' MODULES entry (ARCHITECTURE.md "0.5 features", package 9; S10.5, S12.1, S13.3). It re-registers the
// three preset kinds this package owns (`styles`, `shapes`, `tool-presets`) with thumbnails, registers the commands
// that replace the skeleton's stubs and puts the tool preset picker in the options bar's title slot:
//
//   tool:preset (a `tool-presets` id, or S10.5's data)  activates the tool, then its options, brush, type and colour
//                                                       (S12.1); the replay argument is the data with its brush tip
//   tool:reset (a tool id; default the active tool)     Reset Tool: the tool's defaults (app.tools.resetOptions)
//   tool:reset-all                                      Reset All Tools (asks first unless run from code)
//   layer:style-preset (a `styles` id, or { styles, blending?, opacity?, fillOpacity?, blend?, add? })
//                                                       one "Apply Style" entry; pattern refs resolved (S10.5)
//   edit:define-custom-shape ({ name, path, width, height } replays without asking)
//
// The Styles, Shapes and Tool Presets panels (lib/panels/styles.js, shapes.js, tool-presets.js) and the Layer Style
// dialog's Styles page (lib/style-ui.js) use the helpers exported here. Settings: settings.presetPanels (rule 5).
import { registerPresetKind } from './presets.js';
import { normalizeToolPreset } from './preset-kinds.js';
import { exportPresetsDialog, importPresetFiles } from './preset-formats.js';
import { CUSTOM_SHAPES, customPath, clonePath, definableShape, currentPathTarget, createShapeLayer, shapeStyle } from './tools/vector.js';
import { livePath } from './path-ops.js';
import { toolBrush, setToolBrush, supportsBrush, withSampleData } from './brush/tool-brush.js';
import { typeDefaults, setTypeDefaults } from './type/target.js';
import { setLayerProps } from './layer-ops.js';
import { isStyleable } from './blending-options.js';
import { hasEnabledStyles } from '../../shared/pixels/styles.js';
import { formDialog } from './form.js';
import { icon, registerIcons } from './icons.js';
import {
  normalizeShapeData, normalizeStyleData, stylePatternRefs, resolveStyle, addStyle, capturedOptions, nextPresetName,
  visibleToolPresets, sortedByTool, dropShapeBox,
} from './presets-panels-model.js';
import {
  presetGrid, styleThumbnail, shapeThumbnail, toolPresetThumbnail, panelPrefs, savePanelPrefs, renamePresetDialog,
  deletePresetsAction, VIEWS,
} from './presets-panels-ui.js';

registerIcons({
  'tool-preset': '<path d="M4 20l6-6"/><path d="M14.5 4.5l5 5-7 7-5-5z"/><path d="M17 3l4 4"/>',
  'style-none': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M5 19L19 5"/>',
});

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const esc = (s) => String(s ?? '').replace(/[<&>"]/g, (c) => `&#${c.charCodeAt(0)};`);
let appRef = null; // the kinds' thumbnails resolve patterns and tool icons through the app

// ---- the three kinds (S10.5) --------------------------------------------------------------------------------------

/** Photoshop's "Basics" group of the Styles panel, as Pigment's built-in styles (each a single effect). */
export const BUILTIN_STYLES = Object.freeze([
  { id: 'basic-drop-shadow', name: 'Drop Shadow', data: { styles: { dropShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 5, spread: 0, size: 5 } } } },
  { id: 'basic-inner-shadow', name: 'Inner Shadow', data: { styles: { innerShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 5, spread: 0, size: 5 } } } },
  { id: 'basic-bevel', name: 'Bevel and Emboss', data: { styles: { bevel: { enabled: true, style: 'inner-bevel', technique: 'smooth', depth: 100, direction: 'up', size: 5, soften: 0 } } } },
  { id: 'basic-outer-glow', name: 'Outer Glow', data: { styles: { outerGlow: { enabled: true, blend: 'screen', color: '#ffffbe', opacity: 0.75, spread: 0, size: 5 } } } },
  { id: 'basic-stroke', name: 'Stroke', data: { styles: { stroke: { enabled: true, size: 3, position: 'outside', blend: 'normal', opacity: 1, color: '#000000' } } } },
  { id: 'basic-color-overlay', name: 'Color Overlay', data: { styles: { colorOverlay: { enabled: true, blend: 'normal', color: '#ff0000', opacity: 1 } } } },
]);

/** Re-registers `styles`, `shapes` and `tool-presets` with their full definitions (the user's entries are kept). */
export function registerPresetsPanelsKinds() {
  registerPresetKind('styles', {
    title: 'Styles',
    version: 1,
    builtins: () => ({ groups: [{ id: 'basics', name: 'Basics' }], presets: BUILTIN_STYLES.map((s) => ({ ...s, group: 'basics', data: clone(s.data) })) }),
    normalize: (data) => normalizeStyleData(data),
    thumbnail: (preset, size) => styleThumbnail(appRef, preset.data, size),
  });
  registerPresetKind('shapes', {
    title: 'Shapes',
    version: 1,
    // 0.3's custom shapes under their 0.4 ids, as paths in a 0..1 box
    builtins: () => ({ presets: Object.entries(CUSTOM_SHAPES).map(([id, s]) => ({ id, name: s.name, data: { path: customPath(id, 0, 0, 1, 1) } })) }),
    normalize: (data) => normalizeShapeData(data),
    thumbnail: (preset, size) => shapeThumbnail(preset.data, size),
  });
  registerPresetKind('tool-presets', {
    title: 'Tool Presets',
    version: 1,
    builtins: () => ({ presets: [] }),
    normalize: (data) => normalizeToolPreset(data),
    thumbnail: (preset, size) => toolPresetThumbnail(appRef, preset.data, size),
  });
}

// ---- tool presets (S10.5, S12.1) ----------------------------------------------------------------------------------

/** True for the Type tools (and the Type Mask tools once they exist): their presets carry the type defaults. */
export const isTypeTool = (app, tool) => !!tool && (app.typeTools?.() ?? []).includes(tool);
/** True for tools of the toolbox (a session's own tool, such as Content-Aware Scale, has no presets). */
export const inToolbox = (app, tool) => !!tool && app.tools.slots.some((s) => s.tools.includes(tool.id));
/** The toolbox's tool ids in order (Sort by Tool). */
const toolOrder = (app) => app.tools.slots.flatMap((s) => s.tools);

/**
 * A tool's current settings as a tool preset's data (S10.5): every option it shows (defaults included) and what is
 * stored for it, the tool's brush for painting tools, the type defaults for the type tools, the foreground colour
 * with `includeColor`.
 */
export function captureToolPreset(app, toolId, { includeColor = false } = {}) {
  const tool = app.tools.get(toolId);
  if (!tool) return null;
  const stored = app.settings.tools?.[toolId] ?? {};
  const options = capturedOptions(tool.options, stored, (k) => app.tools.opt(toolId, k));
  const data = { tool: toolId, options };
  if (supportsBrush(tool)) data.brush = toolBrush(app, toolId).preset;
  if (isTypeTool(app, tool)) {
    const t = typeDefaults(app);
    data.type = { char: { ...t.char }, para: { ...t.para } };
    // the text colour is the foreground: kept only with Include Color, as for every tool
    if (!includeColor) {
      delete data.type.char.color;
      delete options.color;
    }
  }
  if (includeColor) data.color = app.settings.foreground;
  return normalizeToolPreset(data);
}

/**
 * Applying a tool preset (S12.1): the tool is activated first (so syncFromLayer cannot overwrite the preset), then
 * setOptions, the brush (no locks, no captured tool settings), the type defaults and the colour. No layer changes: a
 * type preset picked with a text layer active edits nothing (setOptions never calls onOptionChanged).
 */
export function applyToolPreset(app, data) {
  const d = normalizeToolPreset(data);
  if (!d) return false;
  const tool = app.tools.get(d.tool);
  if (!tool) {
    app.dialogs.toast(`This tool preset is for a tool Pigment does not have (${d.tool})`, { kind: 'error', timeout: 2500 });
    return false;
  }
  app.tools.activate(d.tool);
  app.tools.setOptions(d.tool, d.options);
  // the incoming brush may carry its tip as a data URL (a replay): setToolBrush writes it into `brushes`
  if (d.brush && supportsBrush(tool)) setToolBrush(app, d.tool, isObject(data.brush) ? data.brush : d.brush, { respectLocks: false, includeTool: false });
  if (d.type) setTypeDefaults(app, d.type);
  if (d.color) app.setColors({ foreground: d.color });
  return true;
}

/** New Tool Preset…: Photoshop's dialog (Name, Include Color); adds the current tool's preset. */
export async function newToolPresetDialog(app, toolId = app.tools.active?.id) {
  const tool = app.tools.get(toolId);
  if (!tool || !inToolbox(app, tool)) return null;
  await app.presets.ready('tool-presets');
  const names = app.presets.list('tool-presets').map((p) => p.name);
  const v = await formDialog(app, {
    title: 'New Tool Preset',
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: nextPresetName(tool.name, names), autofocus: true },
      { key: 'includeColor', label: 'Include Color', type: 'checkbox', value: false },
    ],
  });
  if (!v || !String(v.name ?? '').trim()) return null;
  const data = captureToolPreset(app, toolId, { includeColor: !!v.includeColor });
  return app.presets.add('tool-presets', { name: String(v.name).trim(), data });
}

async function toolPresetCommand(app, arg, ctx) {
  let data = null;
  const id = typeof arg === 'string' ? arg : isObject(arg) && typeof arg.id === 'string' && typeof arg.tool !== 'string' ? arg.id : null;
  if (id) {
    await app.presets.ready('tool-presets');
    data = app.presets.get('tool-presets', id)?.data ?? null;
  } else if (isObject(arg) && typeof arg.tool === 'string') data = arg;
  const norm = data ? normalizeToolPreset(data) : null;
  if (!norm) {
    app.dialogs.toast('That tool preset no longer exists', { kind: 'error', timeout: 2000 });
    ctx?.cancel?.();
    return false;
  }
  // actions: the step carries the preset's data and its brush tip, so it replays where the preset is gone
  const replay = clone(norm);
  if (norm.brush) replay.brush = await withSampleData(app, isObject(data.brush) ? data.brush : norm.brush);
  ctx?.setReplayArg?.(replay);
  return applyToolPreset(app, replay);
}

async function resetAllTools(app, arg, ctx) {
  const quiet = arg === true || (isObject(arg) && arg.confirm === false) || ['api', 'action', 'assistant', 'repeat'].includes(ctx?.source);
  if (!quiet && !(await app.dialogs.confirm('Reset all tools to their default settings?', { title: 'Reset All Tools' }))) {
    ctx?.cancel?.();
    return false;
  }
  app.tools.resetOptions('*');
  return true;
}

/** The tool presets a list shows now: the active tool's with Current Tool Only (settings.presetPanels). */
export const toolPresetFilter = (app) => (p) => visibleToolPresets([p], app.tools.active?.id, panelPrefs(app).currentToolOnly !== false).length > 0;

/** Sort by Tool: the presets reordered in the store by the toolbox's order. */
export async function sortToolPresets(app) {
  await app.presets.ready('tool-presets');
  const list = app.presets.list('tool-presets');
  const ids = sortedByTool(list, toolOrder(app));
  // a preset in a group stays in it: the order is the one inside each group
  ids.forEach((id, i) => {
    const p = list.find((x) => x.id === id);
    const members = ids.slice(0, i).filter((x) => (list.find((q) => q.id === x)?.group ?? null) === (p.group ?? null));
    app.presets.move('tool-presets', id, { group: p.group ?? null, index: members.length });
  });
}

/** The menu of the Tool Presets panel and of the picker's gear (the same items, as in Photoshop). */
export function toolPresetMenuItems(app, { selected = [], view = null, setView = null, rename = null } = {}) {
  const p = selected.length === 1 ? app.presets.get('tool-presets', selected[0]) : null;
  const prefs = panelPrefs(app);
  const tool = app.tools.active;
  return [
    { label: 'New Tool Preset…', icon: 'plus', disabled: !inToolbox(app, tool), onSelect: () => newToolPresetDialog(app) },
    { label: 'Rename Tool Preset…', icon: 'edit', disabled: !p, onSelect: () => (rename ? rename(p) : renamePresetDialog(app, 'tool-presets', p)) },
    { label: 'Delete Tool Preset', icon: 'trash', disabled: !selected.length, onSelect: () => deletePresetsAction(app, 'tool-presets', selected) },
    { type: 'separator' },
    { label: 'Sort by Tool', onSelect: () => sortToolPresets(app) },
    { label: 'Show All Tool Presets', checked: prefs.currentToolOnly === false, onSelect: () => savePanelPrefs(app, { currentToolOnly: false }) },
    { label: 'Show Current Tool Presets', checked: prefs.currentToolOnly !== false, onSelect: () => savePanelPrefs(app, { currentToolOnly: true }) },
    ...(setView ? [{ type: 'separator' }, ...VIEWS.filter(([id]) => id !== 'large').map(([id, label]) => ({ label, checked: view === id, onSelect: () => setView(id) }))] : []),
    { type: 'separator' },
    { label: 'Reset Tool', disabled: !tool, onSelect: () => app.commands.run('tool:reset', tool?.id, 'panel') },
    { label: 'Reset All Tools', onSelect: () => app.commands.run('tool:reset-all', undefined, 'panel') },
    { type: 'separator' },
    { label: 'Preset Manager…', disabled: !app.commands.isEnabled('edit:preset-manager'), onSelect: () => app.commands.run('edit:preset-manager', { kind: 'tool-presets' }, 'panel') },
    { label: 'Reset Tool Presets…', onSelect: () => resetToolPresets(app) },
    { label: 'Import Tool Presets…', onSelect: () => importPresetFiles(app, { kinds: ['tool-presets'] }) },
    { label: 'Export Selected Tool Presets…', disabled: !selected.length, onSelect: () => exportPresetsDialog(app, 'tool-presets', selected) },
    { label: 'Export All Tool Presets…', onSelect: () => exportPresetsDialog(app, 'tool-presets', null) },
    { label: 'Replace Tool Presets…', onSelect: () => replaceKind(app, 'tool-presets') },
  ];
}

/** Reset / Replace through the Preset Manager's helpers when preset-files-manager has landed, else the store's own. */
export async function resetKind(app, kind) {
  const m = await import('./preset-manager.js').catch(() => ({}));
  if (typeof m.resetKind === 'function') return m.resetKind(app, kind);
  if (!(await app.dialogs.confirm(`Replace the current ${kind} with the defaults? Your own presets are removed.`, { title: 'Reset' }))) return false;
  await app.presets.ready(kind);
  app.presets.reset(kind);
  return true;
}
export async function replaceKind(app, kind) {
  const m = await import('./preset-manager.js').catch(() => ({}));
  if (typeof m.replaceKind === 'function') return m.replaceKind(app, kind);
  return importPresetFiles(app, { kinds: [kind] });
}
const resetToolPresets = (app) => resetKind(app, 'tool-presets');

/** The options bar's title slot (S12.1): the tool's icon and name as a button that opens the tool preset picker. */
function pickerButton(app, tool) {
  if (!inToolbox(app, tool)) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'options-title pset-tool-picker';
  b.dataset.tool = tool.id;
  b.title = 'Tool presets';
  b.setAttribute('aria-haspopup', 'true');
  b.innerHTML = `${icon(tool.icon)}<span>${esc(tool.name)}</span><span class="pset-caret" aria-hidden="true">${icon('chevron-down')}</span>`;
  b.addEventListener('click', () => openToolPresetPicker(app, b));
  return b;
}

/** The tool preset picker: Current Tool Only, the list, New Tool Preset and the gear menu. */
export function openToolPresetPicker(app, anchor) {
  const box = document.createElement('div');
  box.className = 'pset-picker';
  const head = document.createElement('div');
  head.className = 'pset-picker-head';
  const only = document.createElement('label');
  only.className = 'pset-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.k = 'currentToolOnly';
  cb.checked = panelPrefs(app).currentToolOnly !== false;
  only.append(cb, document.createTextNode(' Current Tool Only'));
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pbtn';
  add.dataset.act = 'new';
  add.title = 'New Tool Preset';
  add.setAttribute('aria-label', 'New Tool Preset');
  add.innerHTML = icon('plus');
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'pbtn';
  gear.dataset.act = 'menu';
  gear.title = 'Tool preset menu';
  gear.setAttribute('aria-label', 'Tool preset menu');
  gear.innerHTML = icon('settings');
  head.append(only, spacer, add, gear);
  const grid = presetGrid(app, 'tool-presets', {
    view: () => panelPrefs(app).pickerView ?? 'list',
    className: 'pset-tool-list',
    label: 'Tool presets',
    filter: toolPresetFilter(app),
    draggable: false,
    empty: 'No tool presets for this tool',
    thumb: (p, size) => toolPresetThumbnail(app, p.data, size),
    onPick: (p) => {
      app.dialogs.closePopover();
      app.commands.run('tool:preset', p.id, 'toolbar');
    },
    onActivate: (p) => renamePresetDialog(app, 'tool-presets', p),
  });
  box.append(head, grid.element);
  cb.addEventListener('change', () => {
    savePanelPrefs(app, { currentToolOnly: cb.checked });
    // the filter reads the setting when it renders
    queueMicrotask(() => grid.refresh());
  });
  add.addEventListener('click', async () => {
    app.dialogs.closePopover();
    await newToolPresetDialog(app);
  });
  gear.addEventListener('click', () => {
    const selected = grid.selection();
    app.dialogs.popover(anchor, toolPresetMenuItems(app, {
      selected,
      view: panelPrefs(app).pickerView ?? 'list',
      setView: (v) => savePanelPrefs(app, { pickerView: v }),
    }), { align: 'left' });
  });
  const pop = app.dialogs.popover(anchor, [{ type: 'custom', element: box }], { align: 'left' });
  pop.classList.add('pset-popover');
  const obs = new MutationObserver(() => {
    if (!pop.isConnected) {
      grid.destroy();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
  return { element: pop, grid };
}

// ---- styles (S10.5) -----------------------------------------------------------------------------------------------

/**
 * A style for the store: pattern references that name a pattern preset keep { presetId, name }; a pattern the
 * `patterns` kind lacks (pixels only, as layer data holds them) is defined there first (New Style, S10.5). The current
 * pattern stays what it was.
 */
export async function styleForStore(app, data) {
  const out = clone(data);
  const defined = new Map(); // dataUrl -> PatternRef
  for (const { ref } of stylePatternRefs(out.styles)) {
    if (ref.presetId && app.presets.get('patterns', ref.presetId)) {
      delete ref.dataUrl;
      continue;
    }
    if (typeof ref.dataUrl !== 'string' || !app.patterns) continue;
    let made = defined.get(ref.dataUrl);
    if (!made) {
      const canvas = await app.patterns.canvasOf({ dataUrl: ref.dataUrl }).catch(() => null);
      if (!canvas) continue;
      const before = app.patterns.currentId?.() ?? null;
      const entry = await app.patterns.define(canvas, { name: ref.name || 'Pattern' });
      if (before && before !== entry?.id) app.patterns.setCurrent(before);
      made = entry ? { presetId: entry.id, name: entry.name } : null;
      if (made) defined.set(ref.dataUrl, made);
    }
    if (made) {
      delete ref.dataUrl;
      Object.assign(ref, made);
    }
  }
  return normalizeStyleData(out);
}

/** What New Style takes from a layer: its effects and its blending options. */
export const layerStyleSource = (layer) => ({
  styles: clone(layer?.styles ?? {}) ?? {},
  blending: clone(layer?.blending ?? null),
  opacity: layer?.opacity ?? 1,
  fillOpacity: layer?.fillOpacity ?? 1,
  blend: layer?.blend ?? 'normal',
});

/**
 * New Style…: Photoshop's dialog (Name, Include Layer Effects, Include Layer Blending Options); adds a `styles` preset
 * from `source` ({ styles, blending, opacity, fillOpacity, blend }). Resolves with the preset or null.
 */
export async function newStyleDialog(app, source) {
  await app.presets.ready('styles');
  const names = app.presets.list('styles').map((p) => p.name);
  const v = await formDialog(app, {
    title: 'New Style',
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: nextPresetName('Style', names), autofocus: true },
      { key: 'effects', label: 'Include Layer Effects', type: 'checkbox', value: true },
      { key: 'blending', label: 'Include Layer Blending Options', type: 'checkbox', value: false },
    ],
  });
  if (!v || !String(v.name ?? '').trim()) return null;
  return addStylePreset(app, source, { name: String(v.name).trim(), effects: v.effects !== false, blending: !!v.blending });
}

/** The New Style result without the dialog (tests, the Layer Style dialog): { name, effects, blending } as ticked. */
export async function addStylePreset(app, source, { name, effects = true, blending = false } = {}) {
  await app.presets.ready('styles');
  const data = { styles: effects ? clone(source?.styles ?? {}) ?? {} : {} };
  if (blending) {
    data.blending = clone(source?.blending ?? null);
    for (const k of ['opacity', 'fillOpacity', 'blend']) if (source?.[k] !== undefined) data[k] = source[k];
  }
  const stored = await styleForStore(app, data);
  if (!stored) return null;
  return app.presets.add('styles', { name: name || 'Style', data: stored });
}

/**
 * layer:style-preset: a `styles` preset (by id) or style data applied to the active layer as one "Apply Style" entry.
 * Each pattern reference is resolved through app.patterns.refFor into the L.6 form (with its pixels); a missing
 * pattern turns that effect off, with one toast. `add: true` (Shift-click) adds the effects to the layer's.
 */
async function styleCommand(app, arg, ctx) {
  const doc = app.doc;
  const layer = doc?.active;
  if (!layer || !isStyleable(layer, app)) {
    app.dialogs.toast(layer ? `"${layer.name}" takes no layer style` : 'Open a document first', { kind: 'error', timeout: 2000 });
    ctx?.cancel?.();
    return false;
  }
  let data = null;
  const id = typeof arg === 'string' ? arg : isObject(arg) && typeof arg.id === 'string' && !isObject(arg.styles) ? arg.id : null;
  if (id) {
    await app.presets.ready('styles');
    data = app.presets.get('styles', id)?.data ?? null;
  } else if (isObject(arg) && isObject(arg.styles)) data = clone(arg); // a replay keeps its pixels (no normalising away)
  if (!data) {
    app.dialogs.toast('That style no longer exists', { kind: 'error', timeout: 2000 });
    ctx?.cancel?.();
    return false;
  }
  const add = isObject(arg) && arg.add === true;
  const resolved = new Map();
  for (const { ref } of stylePatternRefs(data.styles)) {
    if (!ref.presetId || resolved.has(ref.presetId)) continue;
    let full = null;
    try {
      full = (await app.patterns?.refFor?.(ref.presetId)) ?? null;
    } catch {
      full = null;
    }
    resolved.set(ref.presetId, full);
  }
  const { styles, missing } = resolveStyle(data.styles, resolved);
  if (missing.length) {
    const names = missing.map((n) => `"${n}"`).join(', ');
    app.dialogs.toast(`The pattern ${names} ${missing.length === 1 ? 'is' : 'are'} missing: ${missing.length === 1 ? 'its effect is' : 'their effects are'} off`, { kind: 'error', timeout: 3000 });
  }
  if (app.doc !== doc || doc.active !== layer || !layer.parent) {
    ctx?.cancel?.();
    return false;
  }
  const next = add ? addStyle(layer.styles, styles) : styles;
  const patch = { styles: hasEnabledStyles({ ...next, hidden: false }) ? next : null };
  const replay = { styles };
  if (!add) {
    if ('blending' in data) patch.blending = replay.blending = clone(data.blending ?? null);
    for (const k of ['opacity', 'fillOpacity', 'blend']) if (data[k] !== undefined) patch[k] = replay[k] = data[k];
  } else replay.add = true;
  ctx?.setReplayArg?.(replay);
  setLayerProps(app, layer, patch, 'Apply Style');
  return true;
}

/** A style dropped from the Styles panel ({ id } JSON) on a layer row (that layer) or the canvas (the layer there). */
export async function dropStyle(app, json, target = null) {
  let id = null;
  try {
    id = JSON.parse(json)?.id ?? null;
  } catch {
    id = null;
  }
  if (!id || !app.doc) return false;
  if (target && app.doc.find?.(target.id) === target) app.doc.setActive(target);
  return app.commands.run('layer:style-preset', id, 'drop');
}

// ---- custom shapes (S10.5) ----------------------------------------------------------------------------------------

/** edit:define-custom-shape: the current path (or its selected components) as a new `shapes` preset. */
async function defineCustomShape(app, arg, ctx) {
  let data = isObject(arg) && isObject(arg.path) ? normalizeShapeData(arg) : null;
  let name = isObject(arg) && typeof arg.name === 'string' ? arg.name.trim() : typeof arg === 'string' ? arg.trim() : '';
  if (!data) data = definableShape(app);
  if (!data) {
    app.dialogs.toast('Choose a path with an area first: a work path, a saved path or a shape layer', { kind: 'error', timeout: 2500 });
    ctx?.cancel?.();
    return null;
  }
  await app.presets.ready('shapes');
  if (!name) {
    const asked = await app.dialogs.prompt('Name', { title: 'Shape Name', value: nextPresetName('Shape', app.presets.list('shapes').map((p) => p.name)) });
    if (asked === null || !asked.trim()) {
      ctx?.cancel?.();
      return null;
    }
    name = asked.trim();
  }
  const keep = { path: data.path, ...(data.width ? { width: data.width, height: data.height } : {}) };
  ctx?.setReplayArg?.({ name, ...clone(keep) });
  const preset = app.presets.add('shapes', { name, data: keep });
  // the new shape becomes the Custom Shape tool's (as Photoshop does)
  if (app.tools.get('shape-custom')) app.tools.setOpt('shape-custom', 'shape', preset.id);
  app.dialogs.toast(`Shape "${name}" defined`, { kind: 'success', timeout: 1800 });
  return preset;
}

/**
 * A shape dropped from the Shapes panel ({ id } JSON): a new shape layer with the Custom Shape tool's fill and
 * stroke, centred on the drop point (the document's centre for a layer row, above that layer), its own proportions,
 * its outline in shapeProps.unit. One history entry (structural, through createShapeLayer).
 */
export async function dropShape(app, json, at = null, target = null) {
  const doc = app.doc;
  if (!doc) return null;
  let id = null;
  try {
    id = JSON.parse(json)?.id ?? null;
  } catch {
    id = null;
  }
  await app.presets.ready('shapes');
  const preset = id ? app.presets.get('shapes', id) : null;
  if (!preset) return null;
  if (target && doc.find?.(target.id) === target) doc.setActive(target);
  const point = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : { x: doc.width / 2, y: doc.height / 2 };
  const box = dropShapeBox(preset.data, point, doc);
  const props = { ...box, angle: 0, shape: preset.id, unit: clonePath(preset.data.path) };
  const path = livePath('custom', props);
  if (!path) return null;
  const tool = app.tools.get('shape-custom');
  const style = tool ? shapeStyle(tool) : { fill: { type: 'solid', color: app.settings.foreground }, stroke: null };
  return createShapeLayer(app, path, { name: preset.name, label: 'Custom Shape', style, kind: 'custom', props });
}

// ---- install ------------------------------------------------------------------------------------------------------

export function install(app) {
  appRef = app;
  registerPresetsPanelsKinds();
  app.commands.registerAll({
    'tool:preset': { label: 'Tool Preset', record: true, run: (arg, ctx) => toolPresetCommand(app, arg, ctx) },
    'tool:reset': {
      label: 'Reset Tool',
      record: false,
      enabled: () => !!app.tools.active,
      run: (arg) => {
        const id = typeof arg === 'string' && app.tools.get(arg) ? arg : app.tools.active?.id;
        if (!id) return false;
        app.tools.resetOptions(id);
        return true;
      },
    },
    'tool:reset-all': { label: 'Reset All Tools', record: false, run: (arg, ctx) => resetAllTools(app, arg, ctx) },
    'layer:style-preset': { label: 'Apply Style', enabled: () => isStyleable(app.doc?.active, app), run: (arg, ctx) => styleCommand(app, arg, ctx) },
    'edit:define-custom-shape': { label: 'Define Custom Shape…', dialog: true, enabled: () => !!app.doc && !!currentPathTarget(app), run: (arg, ctx) => defineCustomShape(app, arg, ctx) },
  });
  // the tool preset picker replaces the tool's icon and name (S12.1)
  app.tools.registerOptionsSlot({ id: 'presets-panels:tool-preset', place: 'title', order: 0, render: (tool) => pickerButton(app, tool) });
  // the kinds' files are read early, so the panels, the picker and the Custom Shape picker show the user's presets
  for (const k of ['styles', 'shapes', 'tool-presets']) app.presets?.ready?.(k)?.catch?.(() => {});
}

