// The Patterns panel and the patterns package's entry module (ARCHITECTURE.md "0.4 features", package 10; group
// 'top'). The panel shows the pattern library (app.patterns, lib/patterns.js) in collapsible groups. Click a pattern
// to make it the current pattern (Fill, the Paint Bucket, the Pattern Stamp and new Pattern Fill layers use it) and,
// when the active layer is a Pattern Fill, to put it in that layer; double-click to rename; drag one onto the canvas
// or a layer row to make a Pattern Fill layer there (application/x-pigment-pattern, L.9), or onto another pattern or a
// group heading to reorder it. The footer adds a group, defines a pattern from the selection and deletes the selected
// one; the menu has the views, Import / Export and Reset.
//
// install() also registers what the package provides to the rest of the app: the 'pattern' paint renderer and paint
// editor and the drop handler (lib/pattern-paint.js) and View > Pattern Preview (lib/pattern-preview.js). The
// `pattern` widget registers itself when lib/pattern-widget.js loads (lib/tools/bucket.js imports it early, so it is
// in place before any form or options bar is built). Registering the panel registers 'window:panel-patterns'
// (lib/panels.js), which takes the skeleton stub's place.
import { icon, registerIcons } from '../icons.js';
import { PATTERN_KIND } from '../patterns.js';
import { patternPicker, patternSettings, savePatternSettings, renamePattern, deletePatterns, newPatternGroup, importPatterns, exportPatterns, resetPatterns } from '../pattern-picker.js';
import { installPatternPaint, makePatternPaint } from '../pattern-paint.js';
import { installPatternPreview } from '../pattern-preview.js';
import { setLayerProps } from '../layer-ops.js';
import '../pattern-widget.js';

registerIcons({
  pattern: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
});

const VIEWS = [['small', 'Small Thumbnails', 28], ['large', 'Large Thumbnails', 48], ['list', 'List', 24]];

/** Applies a library pattern: to the active Pattern Fill layer (one history entry, its placement kept), and as the current pattern. */
export async function applyPattern(app, entry) {
  const e = entry?.canvas ? entry : await app.patterns.get(entry?.id);
  if (!e?.canvas) return null;
  app.patterns.setCurrent(e.id);
  const layer = app.doc?.active;
  if (layer?.type === 'fill' && layer.paint?.type === 'pattern' && !layer.locked?.all && layer.paint.pattern?.canvas !== e.canvas) {
    const p = layer.paint.pattern ?? {};
    setLayerProps(app, layer, { paint: makePatternPaint(e.canvas, { scale: p.scale ?? 1, angle: p.angle ?? 0, link: p.link !== false, origin: p.origin ?? [0, 0], presetId: e.id, name: e.name }) }, 'Apply pattern');
    return 'layer';
  }
  return 'current';
}

export function install(app) {
  installPatternPaint(app);
  installPatternPreview(app);
  app.patterns?.ready?.(); // reads the library in the background

  const el = document.createElement('div');
  el.className = 'patterns-panel';
  const viewOf = () => VIEWS.find((v) => v[0] === patternSettings(app).view) ?? VIEWS[0];
  let picker = null;
  const body = document.createElement('div');
  body.className = 'patterns-body';
  const footer = document.createElement('div');
  footer.className = 'panel-footer';
  footer.innerHTML = `
    <span class="muted patterns-hint">Click: use · drag: new Pattern Fill</span>
    <span style="flex:1"></span>
    <button class="pbtn" data-act="group" title="New group">${icon('folder')}</button>
    <button class="pbtn" data-act="new" title="New pattern from the selection (Edit › Define Pattern)">${icon('plus')}</button>
    <button class="pbtn" data-act="delete" title="Delete the selected pattern">${icon('trash')}</button>
    <button class="pbtn" data-act="menu" title="Patterns panel menu">${icon('more')}</button>`;
  el.append(body, footer);

  const selectedEntry = () => (picker?.selected() ? app.patterns.list().find((e) => e.id === picker.selected()) ?? null : null);

  function build() {
    picker?.destroy();
    const [view, , size] = viewOf();
    picker = patternPicker(app, {
      size,
      view: view === 'list' ? 'list' : 'grid',
      selected: app.patterns.currentId?.() ?? null,
      onPick: (p) => applyPattern(app, p),
      onActivate: (p) => renamePattern(app, p),
    });
    body.replaceChildren(picker.element);
  }

  const definePattern = () => (app.doc ? app.commands.run('edit:define-pattern', { dialog: true }, 'panel') : app.dialogs.toast('Open a document to define a pattern from it', { kind: 'info', timeout: 2000 }));

  async function deleteSelected() {
    const p = selectedEntry();
    if (!p) {
      app.dialogs.toast('Select a pattern first', { kind: 'info', timeout: 1800 });
      return;
    }
    await deletePatterns(app, [p.id]);
  }

  function menu(anchor) {
    const [view] = viewOf();
    const p = selectedEntry();
    app.dialogs.popover(anchor, [
      { label: 'New Pattern…', icon: 'plus', disabled: !app.doc, onSelect: definePattern },
      { label: 'New Pattern Group…', icon: 'folder', onSelect: () => newPatternGroup(app) },
      { label: 'Rename Pattern…', icon: 'edit', disabled: !p, onSelect: () => p && renamePattern(app, p) },
      { label: 'Delete Pattern', icon: 'trash', disabled: !p, onSelect: deleteSelected },
      { type: 'separator' },
      ...VIEWS.map(([id, label]) => ({ label, checked: view === id, onSelect: () => {
        savePatternSettings(app, { view: id });
        build();
      } })),
      { type: 'separator' },
      { label: 'Import Patterns…', onSelect: () => importPatterns(app) },
      { label: 'Export Selected Patterns…', disabled: !p, onSelect: () => p && exportPatterns(app, [p.id]) },
      { label: 'Export All Patterns…', onSelect: () => exportPatterns(app, null) },
      { type: 'separator' },
      { label: 'Reset Patterns…', icon: 'refresh', onSelect: () => resetPatterns(app) },
    ], { align: 'right' });
  }

  footer.querySelector('[data-act="group"]').addEventListener('click', () => newPatternGroup(app));
  footer.querySelector('[data-act="new"]').addEventListener('click', () => definePattern());
  footer.querySelector('[data-act="delete"]').addEventListener('click', () => deleteSelected());
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => menu(e.currentTarget));

  build();
  app.panels.register({ id: 'patterns', title: 'Patterns', icon: 'pattern', element: el, group: 'top', onShow: () => picker?.refresh() });
  // the current pattern is selected in the panel (Define Pattern, a pick elsewhere)
  app.on('patterns:changed', (d) => {
    if (d?.reason === 'current' || d?.reason === 'define') picker?.select(app.patterns.currentId?.() ?? null);
  });
  return { el, applyPattern: (p) => applyPattern(app, p), kind: PATTERN_KIND };
}
