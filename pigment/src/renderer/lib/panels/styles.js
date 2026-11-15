// The Styles panel (presets-panels, ARCHITECTURE.md "0.5 features", package 9; group 'top'). The `styles` presets as
// thumbnails in collapsible groups: click applies a style to the active layer (layer:style-preset, one "Apply Style"
// entry), Shift-click adds its effects to the layer's, double-click renames; drag one onto a layer row (that layer) or
// onto the canvas (the layer under the pointer, else the active one) to apply it there (application/x-pigment-style).
// The footer clears the layer's style, adds a group, makes a New Style from the active layer and deletes; the menu
// has the views, the libraries, Import / Export (every format registered for `styles`, S10.2) and Reset.
// Registering the panel registers window:panel-styles (lib/panels.js), which takes the skeleton stub's place.
import { icon } from '../icons.js';
import { STYLE_MIME } from '../presets-panels-model.js';
import {
  presetGrid, styleThumbnail, styleTitle, panelPrefs, savePanelPrefs, VIEWS, renamePresetDialog, newGroupDialog,
  renameGroupDialog, deletePresetsAction, deleteGroupAction, libraryMenuItems,
} from '../presets-panels-ui.js';
import { newStyleDialog, layerStyleSource, dropStyle, resetKind, replaceKind } from '../tool-presets.js';
import { presetFileMenuItems } from '../preset-formats.js';
import { isStyleable } from '../blending-options.js';

export function install(app) {
  const el = document.createElement('div');
  el.className = 'pset-panel styles-panel';
  const body = document.createElement('div');
  body.className = 'pset-body';
  const footer = document.createElement('div');
  footer.className = 'panel-footer';
  footer.innerHTML = `
    <button class="pbtn" data-act="clear" title="Clear Style (the active layer's effects and blending options)">${icon('style-none')}</button>
    <span style="flex:1"></span>
    <button class="pbtn" data-act="group" title="New group">${icon('folder')}</button>
    <button class="pbtn" data-act="new" title="New Style from the active layer">${icon('plus')}</button>
    <button class="pbtn" data-act="delete" title="Delete the selected styles">${icon('trash')}</button>
    <button class="pbtn" data-act="menu" title="Styles panel menu">${icon('more')}</button>`;
  el.append(body, footer);

  const view = () => panelPrefs(app).stylesView ?? 'small';
  const pick = (p, e) => {
    if (!app.doc) return app.dialogs.toast('Open a document to apply a style', { kind: 'info', timeout: 1800 });
    app.commands.run('layer:style-preset', e?.shiftKey ? { id: p.id, add: true } : p.id, 'panel');
  };
  const grid = presetGrid(app, 'styles', {
    view,
    label: 'Styles',
    mime: STYLE_MIME,
    shiftSelects: false, // Shift-click adds the style (Photoshop)
    empty: 'No styles: make one with New Style',
    thumb: (p, size, { onReady } = {}) => styleThumbnail(app, p.data, size, { onReady }),
    title: (p) => styleTitle(p),
    onPick: pick,
    onActivate: (p) => renamePresetDialog(app, 'styles', p),
    onContext: (p, e) => contextMenu(e),
    onGroupActivate: (g) => renameGroupDialog(app, 'styles', g),
    onGroupContext: (g, e) => app.dialogs.popover(e.currentTarget, [
      { label: 'Rename Group…', icon: 'edit', onSelect: () => renameGroupDialog(app, 'styles', g) },
      { label: 'Delete Group…', icon: 'trash', onSelect: () => deleteGroupAction(app, 'styles', g) },
    ], { at: { x: e.clientX, y: e.clientY } }),
  });
  body.appendChild(grid.element);

  const activeLayer = () => app.doc?.active ?? null;
  async function newStyle() {
    const layer = activeLayer();
    if (!layer || !isStyleable(layer, app)) return app.dialogs.toast('Select a layer with a style to make a new style from it', { kind: 'info', timeout: 2000 });
    const p = await newStyleDialog(app, layerStyleSource(layer));
    if (p) grid.select([p.id]);
  }
  const clearStyle = () => {
    if (app.commands.isEnabled('layer:clear-style')) app.commands.run('layer:clear-style', undefined, 'panel');
  };

  function items() {
    const sel = grid.selection();
    const one = sel.length === 1 ? app.presets.get('styles', sel[0]) : null;
    return [
      { label: 'New Style…', icon: 'plus', disabled: !isStyleable(activeLayer(), app), onSelect: newStyle },
      { label: 'New Style Group…', icon: 'folder', onSelect: () => newGroupDialog(app, 'styles') },
      { label: 'Rename Style…', icon: 'edit', disabled: !one, onSelect: () => renamePresetDialog(app, 'styles', one) },
      { label: 'Delete Style', icon: 'trash', disabled: !sel.length, onSelect: () => deletePresetsAction(app, 'styles', sel) },
      { label: 'Clear Style', disabled: !app.commands.isEnabled('layer:clear-style'), onSelect: clearStyle },
    ];
  }
  const contextMenu = (e) => app.dialogs.popover(e.currentTarget, items(), { at: { x: e.clientX, y: e.clientY } });

  async function menu(anchor) {
    const v = view();
    const libs = await libraryMenuItems(app, 'styles');
    app.dialogs.popover(anchor, [
      ...items(),
      { type: 'separator' },
      ...VIEWS.map(([id, label]) => ({ label, checked: v === id, onSelect: () => savePanelPrefs(app, { stylesView: id }) })),
      { type: 'separator' },
      { label: 'Preset Manager…', disabled: !app.commands.isEnabled('edit:preset-manager'), onSelect: () => app.commands.run('edit:preset-manager', { kind: 'styles' }, 'panel') },
      ...(libs.length ? [{ type: 'separator' }, ...libs] : []),
      { type: 'separator' },
      ...presetFileMenuItems(app, 'styles', { selectedIds: grid.selection() }).map((i) => ({ ...i, label: i.label.replace('…', ' Styles…') })),
      { label: 'Replace Styles…', onSelect: () => replaceKind(app, 'styles') },
      { label: 'Reset Styles…', icon: 'refresh', onSelect: () => resetKind(app, 'styles') },
    ], { align: 'right' });
  }

  footer.querySelector('[data-act="clear"]').addEventListener('click', clearStyle);
  footer.querySelector('[data-act="group"]').addEventListener('click', () => newGroupDialog(app, 'styles'));
  footer.querySelector('[data-act="new"]').addEventListener('click', newStyle);
  footer.querySelector('[data-act="delete"]').addEventListener('click', () => deletePresetsAction(app, 'styles', grid.selection()));
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => menu(e.currentTarget));

  // drops (E25): a style onto a layer row applies it to that layer; onto the canvas, to the layer under the pointer
  app.registerDropHandler?.(STYLE_MIME, {
    canvas: (data, p) => dropStyle(app, data, (p && app.tools.get('move')?.hitTest?.(p)) || null),
    layer: (data, layer) => dropStyle(app, data, layer),
  });
  app.on('settings:changed', (patch) => {
    if (patch?.presetPanels) grid.refresh();
  });
  app.panels.register({ id: 'styles', title: 'Styles', icon: 'fx', element: el, group: 'top', onShow: () => grid.refresh() });
  return { el, grid };
}
