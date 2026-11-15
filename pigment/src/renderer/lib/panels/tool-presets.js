// The Tool Presets panel (presets-panels, ARCHITECTURE.md "0.5 features", package 9; group 'middle'). The
// `tool-presets` presets with their tools' icons: click picks one (tool:preset: the tool, its options, brush, type
// settings and colour, S12.1), double-click renames. Current Tool Only (settings.presetPanels.currentToolOnly, shared
// with the options bar's picker) lists the active tool's presets alone. The footer makes a New Tool Preset from the
// active tool and deletes; the menu sorts, switches the list, resets the tools, imports and exports (.tpl and
// .pigment-presets), replaces and resets the presets. Registering the panel registers window:panel-tool-presets
// (lib/panels.js), which takes the skeleton stub's place.
import { icon } from '../icons.js';
import { presetGrid, toolPresetThumbnail, panelPrefs, savePanelPrefs, renamePresetDialog, deletePresetsAction } from '../presets-panels-ui.js';
import { newToolPresetDialog, toolPresetFilter, toolPresetMenuItems, inToolbox } from '../tool-presets.js';

export function install(app) {
  const el = document.createElement('div');
  el.className = 'pset-panel tool-presets-panel';
  const body = document.createElement('div');
  body.className = 'pset-body';
  const footer = document.createElement('div');
  footer.className = 'panel-footer';
  footer.innerHTML = `
    <label class="pset-check"><input type="checkbox" data-k="currentToolOnly"> Current Tool Only</label>
    <span style="flex:1"></span>
    <button class="pbtn" data-act="new" title="New Tool Preset from the active tool">${icon('plus')}</button>
    <button class="pbtn" data-act="delete" title="Delete the selected tool presets">${icon('trash')}</button>
    <button class="pbtn" data-act="menu" title="Tool Presets panel menu">${icon('more')}</button>`;
  el.append(body, footer);
  const only = footer.querySelector('[data-k="currentToolOnly"]');

  const view = () => panelPrefs(app).toolPresetsView ?? 'list';
  const grid = presetGrid(app, 'tool-presets', {
    view,
    label: 'Tool presets',
    filter: toolPresetFilter(app),
    empty: 'No tool presets (for this tool)',
    thumb: (p, size) => toolPresetThumbnail(app, p.data, size || 20),
    title: (p) => `${p.name} (${app.tools.get(p.data?.tool)?.name ?? p.data?.tool})`,
    onPick: (p) => app.commands.run('tool:preset', p.id, 'panel'),
    onActivate: (p) => renamePresetDialog(app, 'tool-presets', p),
    onContext: (p, e) => app.dialogs.popover(e.currentTarget, toolPresetMenuItems(app, { selected: grid.selection() }).slice(0, 3), { at: { x: e.clientX, y: e.clientY } }),
  });
  body.appendChild(grid.element);
  // the filter reads Current Tool Only and the active tool each time the list renders
  const refresh = () => {
    only.checked = panelPrefs(app).currentToolOnly !== false;
    footer.querySelector('[data-act="new"]').disabled = !inToolbox(app, app.tools.active);
    grid.refresh();
  };

  only.addEventListener('change', () => savePanelPrefs(app, { currentToolOnly: only.checked }));
  footer.querySelector('[data-act="new"]').addEventListener('click', () => newToolPresetDialog(app));
  footer.querySelector('[data-act="delete"]').addEventListener('click', () => deletePresetsAction(app, 'tool-presets', grid.selection()));
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => app.dialogs.popover(e.currentTarget, toolPresetMenuItems(app, {
    selected: grid.selection(),
    view: view(),
    setView: (v) => savePanelPrefs(app, { toolPresetsView: v }),
  }), { align: 'right' }));

  app.on('tool:changed', () => refresh());
  app.on('settings:changed', (patch) => {
    if (patch?.presetPanels) refresh();
  });
  refresh();
  app.panels.register({ id: 'tool-presets', title: 'Tool Presets', icon: 'tool-preset', element: el, group: 'middle', onShow: refresh });
  return { el, grid };
}
