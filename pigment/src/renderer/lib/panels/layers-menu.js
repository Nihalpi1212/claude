// layers-panel-depth (package 14, ARCHITECTURE.md "0.4 features (contracts)", Packages): the Layers panel menu,
// Panel Options, Collapse All Groups and the effect-row command. This file is the package's MODULES entry (it comes
// after lib/panels/info.js); the panel itself is lib/panels/layers.js, which imports panelMenuItems from here.
//
//   layer:collapse-all-groups  every group of the document collapsed in the panel (a view: no history, record: false)
//   layer:panel-options        the Panel Options dialog; writes settings.layersPanel (record: false)
//   layer:effect               the effect rows' operations (lib/panels/layers-effects.js)
//
// settings.layersPanel (J.7): thumbSize 'none' | 'small' | 'medium' | 'large', thumbBounds 'layer' | 'document',
// showEffects, expandEffects, addCopy (read by layer-ops.js Duplicate), fillDefaultMasks (declared by the skeleton; see
// docs/0.4/layers-panel-depth.md, known gaps).
import { formDialog } from '../form.js';
import { registerEffectCommands } from './layers-effects.js';
import { groupsIn } from './layers-model.js';

export const PANEL_DEFAULTS = Object.freeze({ thumbSize: 'medium', thumbBounds: 'layer', showEffects: true, expandEffects: true, fillDefaultMasks: true, addCopy: true });

/** settings.layersPanel with every sub-key present. */
export function panelSettings(app) {
  return { ...PANEL_DEFAULTS, ...(app.settings?.layersPanel ?? {}) };
}

/** Tells the Layers panel that its view changed (groups collapsed, options): it redraws. */
export function panelViewChanged(app) {
  app.emit('layers-panel:view', {});
}

/** The Layers panel menu (the ☰ button at the top right of the panel), in Photoshop's order. */
export function panelMenuItems(app) {
  const d = app.doc;
  const state = app.uiState ?? {};
  const item = (label, id, arg) => ({ label, disabled: !app.commands.has(id) || !app.commands.isEnabled(id), onSelect: () => app.commands.run(id, arg, 'panel') });
  const layer = d?.active ?? null;
  const several = (state.selectedCount ?? d?.selected.size ?? 0) > 1;
  const mergeLabel = several ? 'Merge Layers' : layer?.isGroup ? 'Merge Group' : 'Merge Down';
  return [
    item('New Layer…', 'layer:new', { dialog: true }),
    item(several ? 'Duplicate Layers…' : 'Duplicate Layer…', 'layer:duplicate', { dialog: true }),
    item(several ? 'Delete Layers' : 'Delete Layer', 'layer:delete'),
    item('Delete Hidden Layers', 'layer:delete-hidden'),
    { type: 'separator' },
    item('Quick Export as PNG', 'layer:export-quick'),
    item('Export As…', 'layer:export-as'),
    { type: 'separator' },
    item('New Group…', 'layer:new-group', { dialog: true }),
    item('New Group from Layers…', 'layer:group-from-layers'),
    item('Collapse All Groups', 'layer:collapse-all-groups'),
    { type: 'separator' },
    item('Lock Layers…', 'layer:lock-dialog'),
    item('Lock All Layers in Group…', 'layer:lock-group'),
    { type: 'separator' },
    item('Convert to Smart Object', 'layer:smart-convert'),
    item('Edit Contents', 'layer:smart-edit', layer?.id),
    { type: 'separator' },
    item('Blending Options…', 'layer:style', 'dialog'),
    ...(layer?.type === 'adjustment' || layer?.type === 'fill' ? [item(layer.type === 'fill' ? 'Edit Fill…' : 'Edit Adjustment…', 'layer:properties', layer.id)] : []),
    { type: 'separator' },
    item(layer?.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', 'layer:clip'),
    { type: 'separator' },
    item('Link Layers', 'layer:link'),
    item('Select Linked Layers', 'layer:select-linked'),
    { type: 'separator' },
    item(mergeLabel, 'layer:merge'),
    item('Merge Visible', 'layer:merge-visible'),
    item('Flatten Image', 'image:flatten'),
    { type: 'separator' },
    item('Panel Options…', 'layer:panel-options'),
  ];
}

function collapseAll(app) {
  const d = app.doc;
  if (!d) return;
  for (const g of groupsIn(d.root)) g.expanded = false;
  panelViewChanged(app);
}

async function panelOptions(app, arg) {
  const cur = panelSettings(app);
  let values = null;
  if (arg && typeof arg === 'object') values = arg; // the API and the assistant set them without the dialog
  else {
    values = await formDialog(app, {
      title: 'Layers Panel Options',
      className: 'layers-panel-options',
      width: 400,
      fields: [
        { key: 'thumbSize', label: 'Thumbnail Size', type: 'segment', options: [['none', 'None'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], value: cur.thumbSize },
        { key: 'thumbBounds', label: 'Thumbnail Contents', type: 'select', options: [['layer', 'Layer Bounds'], ['document', 'Entire Document']], value: cur.thumbBounds },
        { type: 'section', label: 'Effects' },
        { key: 'showEffects', label: 'Show effects under the layers', type: 'checkbox', value: cur.showEffects },
        { key: 'expandEffects', label: 'Expand new effects', type: 'checkbox', value: cur.expandEffects },
        { type: 'section', label: 'Layers' },
        { key: 'addCopy', label: 'Add “copy” to copied layers and groups', type: 'checkbox', value: cur.addCopy },
      ],
    });
  }
  if (!values) return;
  const next = { ...cur };
  if (['none', 'small', 'medium', 'large'].includes(values.thumbSize)) next.thumbSize = values.thumbSize;
  if (['layer', 'document'].includes(values.thumbBounds)) next.thumbBounds = values.thumbBounds;
  for (const k of ['showEffects', 'expandEffects', 'addCopy', 'fillDefaultMasks']) if (typeof values[k] === 'boolean') next[k] = values[k];
  // J.7: write a new object, never the shared default in place
  await app.saveSettings({ layersPanel: next });
  panelViewChanged(app);
}

export function install(app) {
  registerEffectCommands(app);
  app.commands.registerAll({
    'layer:collapse-all-groups': {
      enabled: () => !!app.doc && groupsIn(app.doc.root).length > 0,
      run: () => collapseAll(app),
      record: false,
      label: 'Collapse All Groups',
    },
    'layer:panel-options': {
      enabled: () => true,
      run: (arg) => panelOptions(app, arg),
      record: false,
      label: 'Panel Options…',
    },
  });
}
