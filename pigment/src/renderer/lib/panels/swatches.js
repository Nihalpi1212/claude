// Swatches panel (top group): recently used colours and the user's palette (settings.swatches;
// DEFAULT_SWATCHES until the palette is edited). Click = foreground, Alt/Ctrl/Cmd-click = background,
// "+" adds the foreground colour, right-click opens a menu (delete, use as background, reset).
import { icon } from '../icons.js';
import { DEFAULT_SWATCHES } from '../../../shared/defaults.js';
import { normHex } from './color.js';

const RECENT_MAX = 14;

/** Swatch entries are '#rrggbb' strings or { color, name } objects. */
const colorOf = (s) => normHex(typeof s === 'string' ? s : s?.color ?? '#000000');
const nameOf = (s) => (typeof s === 'object' && s?.name ? s.name : '');

export function install(app) {
  const el = document.createElement('div');
  el.className = 'swatches-panel';
  el.innerHTML = `
    <div class="swatch-section-title muted">Recent</div>
    <div class="swatch-grid swatch-recent" role="list" aria-label="Recent colours"></div>
    <div class="swatch-section-title muted">Swatches</div>
    <div class="swatch-grid swatch-main" role="list" aria-label="Swatches"></div>
    <div class="panel-footer">
      <span class="muted swatch-hint">Click: foreground · Alt-click: background</span>
      <span style="flex:1"></span>
      <button class="pbtn" data-act="reset" title="Reset to the default swatches">${icon('refresh')}</button>
      <button class="pbtn" data-act="add" title="New swatch from the foreground colour">${icon('plus')}</button>
    </div>`;
  const recentGrid = el.querySelector('.swatch-recent');
  const mainGrid = el.querySelector('.swatch-main');
  const recentTitle = el.querySelector('.swatch-section-title');

  const palette = () => {
    const s = app.settings.swatches;
    if (app.settings.swatchesEdited || (Array.isArray(s) && s.length)) return Array.isArray(s) ? s.slice() : [];
    return DEFAULT_SWATCHES.slice();
  };
  const savePalette = (list) => app.saveSettingsSoon({ swatches: list.slice(), swatchesEdited: true });

  function apply(hex, e) {
    if (e && (e.altKey || e.ctrlKey || e.metaKey)) app.setColors({ background: hex });
    else app.setColors({ foreground: hex });
  }

  function swatchButton(entry, { index = -1, recent = false } = {}) {
    const hex = colorOf(entry);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'listitem');
    b.style.background = hex;
    const name = nameOf(entry);
    b.title = `${name ? `${name} · ` : ''}${hex}${recent ? ' (recent)' : ''} — click: foreground, Alt-click: background`;
    b.dataset.color = hex;
    b.addEventListener('click', (e) => apply(hex, e));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [
        { label: 'Set Foreground Color', onSelect: () => app.setColors({ foreground: hex }) },
        { label: 'Set Background Color', onSelect: () => app.setColors({ background: hex }) },
        { type: 'separator' },
      ];
      if (recent) {
        items.push({ label: 'Add to Swatches', icon: 'plus', onSelect: () => addSwatch(hex) });
        items.push({ label: 'Clear Recent Colors', icon: 'trash', onSelect: () => {
          app.saveSettingsSoon({ recentColors: [] });
          render();
        } });
      } else {
        items.push({ label: 'Rename Swatch…', icon: 'edit', onSelect: () => renameSwatch(index) });
        items.push({ label: 'Delete Swatch', icon: 'trash', onSelect: () => deleteSwatch(index) });
      }
      app.dialogs.popover(b, items, { at: { x: e.clientX, y: e.clientY } });
    });
    return b;
  }

  function addSwatch(hex = app.settings.foreground) {
    const list = palette();
    list.push(normHex(hex));
    savePalette(list);
    render();
  }

  function deleteSwatch(index) {
    const list = palette();
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    savePalette(list);
    render();
  }

  async function renameSwatch(index) {
    const list = palette();
    const entry = list[index];
    if (entry === undefined) return;
    const name = await app.dialogs.prompt('Swatch name', { title: 'Rename Swatch', value: nameOf(entry) });
    if (name === null) return;
    list[index] = name.trim() ? { color: colorOf(entry), name: name.trim() } : colorOf(entry);
    savePalette(list);
    render();
  }

  async function resetPalette() {
    const ok = await app.dialogs.confirm('Replace your swatches with the default palette?', { title: 'Reset Swatches', okLabel: 'Reset' });
    if (!ok) return;
    app.saveSettingsSoon({ swatches: [], swatchesEdited: false });
    render();
  }

  function render() {
    const recent = (app.settings.recentColors ?? []).slice(0, RECENT_MAX);
    recentGrid.replaceChildren(...recent.map((c) => swatchButton(c, { recent: true })));
    recentGrid.hidden = recentTitle.hidden = !recent.length;
    const list = palette();
    mainGrid.replaceChildren(...list.map((c, i) => swatchButton(c, { index: i })));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'swatch add';
    add.title = 'New swatch from the foreground colour';
    add.innerHTML = icon('plus');
    add.addEventListener('click', () => addSwatch());
    mainGrid.appendChild(add);
    const fg = normHex(app.settings.foreground);
    for (const b of el.querySelectorAll('.swatch[data-color]')) b.classList.toggle('current', b.dataset.color === fg);
  }

  el.querySelector('[data-act="add"]').addEventListener('click', () => addSwatch());
  el.querySelector('[data-act="reset"]').addEventListener('click', resetPalette);

  // recent colours: remember the foreground once it settles (dragging in a picker fires many changes)
  let recentTimer = 0;
  let settingsTimer = 0;
  let lastFg = normHex(app.settings.foreground);
  app.on('color:changed', ({ fg }) => {
    const hex = normHex(fg);
    for (const b of el.querySelectorAll('.swatch[data-color]')) b.classList.toggle('current', b.dataset.color === hex);
    if (hex === lastFg) return;
    lastFg = hex;
    clearTimeout(recentTimer);
    recentTimer = setTimeout(() => remember(hex), 700);
  });
  function remember(hex) {
    const list = (app.settings.recentColors ?? []).map(normHex).filter((c) => c !== hex);
    list.unshift(hex);
    app.saveSettingsSoon({ recentColors: list.slice(0, RECENT_MAX) });
    render();
  }

  app.on('swatches:changed', () => render());
  app.on('settings:changed', (patch) => {
    if (patch && ('swatches' in patch || 'recentColors' in patch)) {
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(render, 0);
    }
  });

  app.panels.register({ id: 'swatches', title: 'Swatches', icon: 'swatches', element: el, group: 'top', onShow: render });
  render();
  return { render, addSwatch };
}
