// The Shapes panel (presets-panels, ARCHITECTURE.md "0.5 features", package 9; group 'top'). The `shapes` presets as
// thumbnails in collapsible groups: click makes a shape the Custom Shape tool's, double-click renames; drag one onto
// the canvas to make a shape layer there (application/x-pigment-shape: the Custom Shape tool's fill and stroke, the
// shape's own proportions, one history entry), or onto a layer row to make it above that layer. The footer adds a
// group, defines a shape from the current path (Edit > Define Custom Shape) and deletes; the menu has the views, the
// libraries, Import / Export (.csh and .pigment-presets, S10.2) and Reset. Registering the panel registers
// window:panel-shapes (lib/panels.js), which takes the skeleton stub's place.
import { icon } from '../icons.js';
import { SHAPE_MIME } from '../presets-panels-model.js';
import {
  presetGrid, shapeThumbnail, panelPrefs, savePanelPrefs, VIEWS, renamePresetDialog, newGroupDialog, renameGroupDialog,
  deletePresetsAction, deleteGroupAction, libraryMenuItems,
} from '../presets-panels-ui.js';
import { dropShape, resetKind, replaceKind } from '../tool-presets.js';
import { presetFileMenuItems } from '../preset-formats.js';

export function install(app) {
  const el = document.createElement('div');
  el.className = 'pset-panel shapes-panel';
  const body = document.createElement('div');
  body.className = 'pset-body';
  const footer = document.createElement('div');
  footer.className = 'panel-footer';
  footer.innerHTML = `
    <span class="muted pset-hint">Drag a shape onto the canvas</span>
    <span style="flex:1"></span>
    <button class="pbtn" data-act="group" title="New group">${icon('folder')}</button>
    <button class="pbtn" data-act="new" title="New shape from the current path (Edit › Define Custom Shape)">${icon('plus')}</button>
    <button class="pbtn" data-act="delete" title="Delete the selected shapes">${icon('trash')}</button>
    <button class="pbtn" data-act="menu" title="Shapes panel menu">${icon('more')}</button>`;
  el.append(body, footer);

  const view = () => panelPrefs(app).shapesView ?? 'large';
  const current = () => app.tools.opt('shape-custom', 'shape') ?? null;
  const grid = presetGrid(app, 'shapes', {
    view,
    label: 'Shapes',
    mime: SHAPE_MIME,
    selected: current() ? [current()] : [],
    thumb: (p, size) => shapeThumbnail(p.data, size),
    onPick: (p) => {
      if (app.tools.get('shape-custom')) app.tools.setOpt('shape-custom', 'shape', p.id);
    },
    onActivate: (p) => renamePresetDialog(app, 'shapes', p),
    onContext: (p, e) => app.dialogs.popover(e.currentTarget, items(), { at: { x: e.clientX, y: e.clientY } }),
    onGroupActivate: (g) => renameGroupDialog(app, 'shapes', g),
    onGroupContext: (g, e) => app.dialogs.popover(e.currentTarget, [
      { label: 'Rename Group…', icon: 'edit', onSelect: () => renameGroupDialog(app, 'shapes', g) },
      { label: 'Delete Group…', icon: 'trash', onSelect: () => deleteGroupAction(app, 'shapes', g) },
    ], { at: { x: e.clientX, y: e.clientY } }),
  });
  body.appendChild(grid.element);

  const define = () => {
    if (app.commands.isEnabled('edit:define-custom-shape')) app.commands.run('edit:define-custom-shape', undefined, 'panel');
    else app.dialogs.toast('Draw or choose a path first (a work path, a saved path or a shape layer)', { kind: 'info', timeout: 2200 });
  };
  function items() {
    const sel = grid.selection();
    const one = sel.length === 1 ? app.presets.get('shapes', sel[0]) : null;
    return [
      { label: 'New Shape…', icon: 'plus', disabled: !app.commands.isEnabled('edit:define-custom-shape'), onSelect: define },
      { label: 'New Shape Group…', icon: 'folder', onSelect: () => newGroupDialog(app, 'shapes') },
      { label: 'Rename Shape…', icon: 'edit', disabled: !one, onSelect: () => renamePresetDialog(app, 'shapes', one) },
      { label: 'Delete Shape', icon: 'trash', disabled: !sel.length, onSelect: () => deletePresetsAction(app, 'shapes', sel) },
    ];
  }
  async function menu(anchor) {
    const v = view();
    const libs = await libraryMenuItems(app, 'shapes');
    app.dialogs.popover(anchor, [
      ...items(),
      { type: 'separator' },
      ...VIEWS.map(([id, label]) => ({ label, checked: v === id, onSelect: () => savePanelPrefs(app, { shapesView: id }) })),
      { type: 'separator' },
      { label: 'Preset Manager…', disabled: !app.commands.isEnabled('edit:preset-manager'), onSelect: () => app.commands.run('edit:preset-manager', { kind: 'shapes' }, 'panel') },
      ...(libs.length ? [{ type: 'separator' }, ...libs] : []),
      { type: 'separator' },
      ...presetFileMenuItems(app, 'shapes', { selectedIds: grid.selection() }).map((i) => ({ ...i, label: i.label.replace('…', ' Shapes…') })),
      { label: 'Replace Shapes…', onSelect: () => replaceKind(app, 'shapes') },
      { label: 'Reset Shapes…', icon: 'refresh', onSelect: () => resetKind(app, 'shapes') },
    ], { align: 'right' });
  }

  footer.querySelector('[data-act="group"]').addEventListener('click', () => newGroupDialog(app, 'shapes'));
  footer.querySelector('[data-act="new"]').addEventListener('click', define);
  footer.querySelector('[data-act="delete"]').addEventListener('click', () => deletePresetsAction(app, 'shapes', grid.selection()));
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => menu(e.currentTarget));

  // drops (E25): a shape onto the canvas is a shape layer there; onto a layer row, one above that layer
  app.registerDropHandler?.(SHAPE_MIME, {
    canvas: (data, p) => dropShape(app, data, p),
    layer: (data, layer) => dropShape(app, data, null, layer),
  });
  // the Custom Shape tool's shape is the one selected here
  app.on('tool:options', (e) => {
    if (e?.tool === 'shape-custom' && (e.key === 'shape' || e.key === '*')) grid.select(current() ? [current()] : []);
  });
  app.on('settings:changed', (patch) => {
    if (patch?.presetPanels) grid.refresh();
  });
  app.panels.register({ id: 'shapes', title: 'Shapes', icon: 'shape-custom', element: el, group: 'top', onShow: () => grid.refresh() });
  return { el, grid };
}
