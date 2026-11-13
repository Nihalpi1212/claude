// The Gradients panel (gradients package, ARCHITECTURE.md "0.4 features", package 9; group 'top', after Swatches):
// the presets of the `gradients` kind in collapsible groups. Click a gradient to apply it to the active Gradient Fill
// layer, or otherwise make it the Gradient tool's gradient; double-click to rename; drag one onto the canvas or a
// layer row to make a Gradient Fill layer there (application/x-pigment-gradient, L.9), or onto another gradient or a
// group heading to reorder it. The footer adds a group, adds the current gradient and deletes the selected one; the
// menu has the views, Import / Export and Reset.
//
// This file replaces the skeleton's stub at the same path; registering the panel registers 'window:panel-gradients'
// (lib/panels.js), which takes the stub's place.
import { icon } from '../icons.js';
import { gradientPicker, gradientSettings, saveGradientSettings, editPresets, newGroup, renamePreset, resolvedPresetData, appColors } from '../gradient-picker.js';
import { GRADIENT_KIND } from '../gradient-presets.js';
import { importPresets, exportPresets } from '../gradient-editor.js';
import { isLiveGradient } from '../tools/fill.js';
import { setLayerProps } from '../layer-ops.js';
import { normalizeGradient, PLACEMENT_KEYS } from '../../../shared/pixels/gradient-model.js';

const VIEWS = [['small', 'Small Thumbnails', 24], ['large', 'Large Thumbnails', 40], ['list', 'List', 32]];

/** Applies a preset: to the active Gradient Fill layer (one history entry), else as the Gradient tool's gradient. */
export function applyGradientPreset(app, preset) {
  const layer = app.doc?.active;
  if (layer?.type === 'fill' && layer.paint?.type === 'gradient' && !layer.locked?.all) {
    const old = layer.paint.gradient ?? {};
    const keep = {};
    for (const k of PLACEMENT_KEYS) if (old[k] !== undefined) keep[k] = old[k];
    setLayerProps(app, layer, { paint: { type: 'gradient', gradient: { ...resolvedPresetData(app, preset), ...keep } } }, 'Apply gradient preset');
    return 'layer';
  }
  app.tools.setOpt('gradient', 'gradient', JSON.parse(JSON.stringify(preset.data)));
  app.tools.setOpt('gradient', 'preset', preset.id);
  return 'tool';
}

/** The gradient a new preset is made from: the active Gradient Fill layer's, else the Gradient tool's. */
function currentGradient(app) {
  const layer = app.doc?.active;
  if (layer?.type === 'fill' && layer.paint?.type === 'gradient') return normalizeGradient(layer.paint.gradient, appColors(app));
  const tool = app.tools?.tools?.get?.('gradient');
  return normalizeGradient(tool?.currentGradient?.() ?? {}, { keepRefs: true });
}

export function install(app) {
  const el = document.createElement('div');
  el.className = 'gradients-panel';
  const viewOf = () => VIEWS.find((v) => v[0] === gradientSettings(app).view) ?? VIEWS[0];
  let picker = null;
  const body = document.createElement('div');
  body.className = 'gradients-body';
  const footer = document.createElement('div');
  footer.className = 'panel-footer';
  footer.innerHTML = `
    <span class="muted gradients-hint">Click: apply · drag: new Gradient Fill</span>
    <span style="flex:1"></span>
    <button class="pbtn" data-act="group" title="New group">${icon('folder')}</button>
    <button class="pbtn" data-act="new" title="New gradient from the current one">${icon('plus')}</button>
    <button class="pbtn" data-act="delete" title="Delete the selected gradient">${icon('trash')}</button>
    <button class="pbtn" data-act="menu" title="Gradients panel menu">${icon('more')}</button>`;
  el.append(body, footer);

  const selected = () => (picker?.selected() ? app.presets.get(GRADIENT_KIND, picker.selected()) : null);

  function build() {
    picker?.destroy();
    const [view, , size] = viewOf();
    picker = gradientPicker(app, {
      size,
      view: view === 'list' ? 'list' : 'grid',
      selected: app.tools?.tools?.get?.('gradient')?.presetId?.() ?? null,
      onPick: (p) => applyGradientPreset(app, p),
      onActivate: (p) => renamePreset(app, p),
    });
    body.replaceChildren(picker.element);
  }

  async function newPreset() {
    const name = await app.dialogs.prompt('Name', { title: 'New Gradient Preset', value: 'Custom' });
    if (!name?.trim()) return null;
    const group = selected()?.group ?? null;
    const p = await editPresets(app, (s) => s.add(GRADIENT_KIND, { name: name.trim(), data: currentGradient(app), group }));
    picker?.select(p.id);
    return p;
  }

  async function deleteSelected() {
    const p = selected();
    if (!p) {
      app.dialogs.toast('Select a gradient first', { kind: 'info', timeout: 1800 });
      return;
    }
    await editPresets(app, (s) => s.remove(GRADIENT_KIND, p.id));
  }

  async function resetAll() {
    const ok = await app.dialogs.confirm('Replace your gradients with the built-in ones? Gradients you added are deleted.', { title: 'Reset Gradients', okLabel: 'Reset' });
    if (ok) app.presets.reset(GRADIENT_KIND);
  }

  function menu(anchor) {
    const [view] = viewOf();
    const p = selected();
    app.dialogs.popover(anchor, [
      { label: 'New Gradient Preset…', icon: 'plus', onSelect: newPreset },
      { label: 'New Gradient Group…', icon: 'folder', onSelect: () => newGroup(app) },
      { label: 'Rename Gradient…', icon: 'edit', disabled: !p, onSelect: () => p && renamePreset(app, p) },
      { label: 'Delete Gradient', icon: 'trash', disabled: !p, onSelect: deleteSelected },
      { type: 'separator' },
      ...VIEWS.map(([id, label]) => ({ label, checked: view === id, onSelect: () => {
        saveGradientSettings(app, { view: id });
        build();
      } })),
      { type: 'separator' },
      { label: 'Import Gradients…', onSelect: () => importPresets(app) },
      { label: 'Export Selected Gradients…', disabled: !p, onSelect: () => p && exportPresets(app, [p.id]) },
      { label: 'Export All Gradients…', onSelect: () => exportPresets(app, null) },
      { type: 'separator' },
      { label: 'Reset Gradients…', icon: 'refresh', onSelect: resetAll },
    ], { align: 'right' });
  }

  footer.querySelector('[data-act="group"]').addEventListener('click', () => newGroup(app));
  footer.querySelector('[data-act="new"]').addEventListener('click', () => newPreset());
  footer.querySelector('[data-act="delete"]').addEventListener('click', () => deleteSelected());
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => menu(e.currentTarget));

  build();
  app.panels.register({ id: 'gradients', title: 'Gradients', icon: 'gradient', element: el, group: 'top', onShow: () => picker?.refresh() });
  // the Gradient tool's preset is selected in the panel
  app.on('tool:options', ({ tool, key, value }) => {
    if (tool === 'gradient' && key === 'preset') picker?.select(value);
  });
  return { el, applyGradientPreset: (p) => applyGradientPreset(app, p), newPreset, isLiveGradient };
}
