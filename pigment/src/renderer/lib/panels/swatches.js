// Swatches panel (top group; color-picker-swatches, 0.5): the recent colours (settings.recentColors) and the swatches
// of the preset kind `swatches` (S7.2), in groups (Photoshop's swatch folders), with a search. Click = foreground,
// Alt/Ctrl/Cmd-click = background, double-click renames, a drag onto a group header moves the swatch into it, "+" adds
// the foreground colour. The panel menu: New Swatch / Group, views, Import / Export (S10: .ase, .aco, .pigment-presets),
// Pigment's libraries, the Preset Manager, Reset and Replace. Swatch edits are preset edits, not document history.
import { icon } from '../icons.js';
import { normHex } from './color.js';
import { presetFileMenuItems } from '../preset-formats.js';
import * as M from '../color-picker-model.js';
import { swatchHex, addSwatch as addSwatchValue } from '../color-picker.js';
import { colorLibrariesDialog, bookEntryValue } from '../color-libraries.js';

const RECENT_MAX = 14;
const SWATCH_MIME = 'application/x-pigment-swatch';
const VIEWS = [['small', 'Small Thumbnails'], ['large', 'Large Thumbnails'], ['list', 'Small List']];

const el = (tag, className, html) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export function install(app) {
  const root = el('div', 'swatches-panel');
  root.innerHTML = `
    <div class="swatch-search-row"><input class="input swatch-search" type="search" data-k="swatch-search" placeholder="Search swatches" aria-label="Search swatches"></div>
    <div class="swatch-section-title muted">Recent</div>
    <div class="swatch-grid swatch-recent" role="list" aria-label="Recent colours"></div>
    <div class="swatch-body"></div>
    <div class="panel-footer">
      <span class="muted swatch-hint">Click: foreground · Alt-click: background</span>
      <span style="flex:1"></span>
      <button class="pbtn" data-act="group" title="New swatch group">${icon('folder')}</button>
      <button class="pbtn" data-act="add" title="New swatch from the foreground colour">${icon('plus')}</button>
      <button class="pbtn" data-act="delete" title="Delete the selected swatch">${icon('trash')}</button>
      <button class="pbtn" data-act="menu" title="Swatches panel menu">${icon('more')}</button>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const recentGrid = $('.swatch-recent');
  const recentTitle = $('.swatch-section-title');
  const body = $('.swatch-body');
  const search = $('.swatch-search');
  let selected = null; // the selected swatch's id

  const ui = () => app.settings.colorUI ?? {};
  const saveUI = (patch) => app.saveSettingsSoon({ colorUI: { ...ui(), ...patch } });
  const view = () => (VIEWS.some(([id]) => id === ui().swatchesView) ? ui().swatchesView : 'small');
  // Lab swatches through the active document's profile (S6.5)
  const hexOf = (data) => swatchHex(data, app.doc?.profile ?? null);

  const fgOrBg = (hex, e) => {
    if (e && (e.altKey || e.ctrlKey || e.metaKey)) app.setColors({ background: hex });
    else app.setColors({ foreground: hex });
  };
  const ready = () => app.presets.ready('swatches');
  const list = () => app.presets.list('swatches');
  const groups = () => app.presets.groups('swatches');

  async function addSwatch(hex = app.settings.foreground, { name = null, group = null } = {}) {
    await ready();
    const h = normHex(hex);
    const p = app.presets.add('swatches', { name: name ?? h, data: M.swatchFromHex(h), group });
    selected = p.id;
    render();
    return p;
  }
  async function newSwatchDialog(hex = app.settings.foreground) {
    const name = await app.dialogs.prompt('Name', { title: 'New Swatch', value: normHex(hex) });
    if (name === null) return null;
    return addSwatch(hex, { name: name.trim() || normHex(hex), group: groupOf(selected) });
  }
  const groupOf = (id) => (id ? app.presets.get('swatches', id)?.group ?? null : null);
  async function deleteSwatch(id) {
    await ready();
    if (!id || !app.presets.get('swatches', id)) return;
    app.presets.remove('swatches', [id]);
    if (selected === id) selected = null;
    render();
  }
  async function renameSwatch(id) {
    await ready();
    const p = app.presets.get('swatches', id);
    if (!p) return;
    const name = await app.dialogs.prompt('Swatch name', { title: 'Rename Swatch', value: p.name });
    if (name === null || !name.trim()) return;
    app.presets.update('swatches', id, { name: name.trim() });
    render();
  }
  async function newGroup() {
    await ready();
    const name = await app.dialogs.prompt('Name', { title: 'New Swatch Group', value: 'Swatch Group' });
    if (name === null || !name.trim()) return null;
    const g = app.presets.addGroup('swatches', { name: name.trim() });
    // the selected swatch goes in, as Photoshop's New Group from the selection
    if (selected && app.presets.get('swatches', selected)) app.presets.move('swatches', selected, { group: g.id });
    render();
    return g;
  }
  async function renameGroup(g) {
    const name = await app.dialogs.prompt('Name', { title: 'Rename Swatch Group', value: g.name });
    if (name === null || !name.trim()) return;
    app.presets.renameGroup('swatches', g.id, name.trim());
    render();
  }
  async function deleteGroup(g, keepPresets) {
    if (!keepPresets) {
      const ok = await app.dialogs.confirm(`Delete the group "${g.name}" and its swatches?`, { title: 'Delete Swatch Group', okLabel: 'Delete' });
      if (!ok) return;
    }
    app.presets.removeGroup('swatches', g.id, { keepPresets });
    render();
  }
  function moveTo(id, group) {
    if (!app.presets.get('swatches', id)) return;
    app.presets.move('swatches', id, { group });
    render();
  }
  async function copy(hex, kind) {
    const { copyColorCode } = await import('../tools/nav.js');
    copyColorCode(app, hex, kind);
  }

  function swatchButton(entry, { recent = false } = {}) {
    const hex = recent ? normHex(entry) : hexOf(entry.data) ?? '#000000';
    const b = el('button', 'swatch');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.style.background = hex;
    b.dataset.color = hex;
    const name = recent ? '' : entry.name;
    const book = !recent && entry.data?.book ? ` (${entry.data.book.book})` : '';
    b.title = `${name && name !== hex ? `${name}${book} · ` : ''}${hex}${recent ? ' (recent)' : ''}: click for the foreground, Alt-click for the background`;
    if (!recent) {
      b.dataset.id = entry.id;
      b.setAttribute('aria-label', entry.name);
      b.setAttribute('aria-selected', String(entry.id === selected));
      if (entry.data?.type === 'spot') b.classList.add('spot');
      b.draggable = true;
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(SWATCH_MIME, entry.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      b.addEventListener('dblclick', () => renameSwatch(entry.id));
      if (view() === 'list') b.appendChild(el('span', 'swatch-name', '')).textContent = entry.name;
    }
    b.addEventListener('click', (e) => {
      fgOrBg(hex, e);
      if (!recent) {
        selected = entry.id;
        for (const x of body.querySelectorAll('.swatch[data-id]')) x.setAttribute('aria-selected', String(x.dataset.id === selected));
      }
    });
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
        items.push({ label: 'New Swatch…', icon: 'plus', onSelect: () => newSwatchDialog(app.settings.foreground) });
        items.push({ label: 'Rename Swatch…', icon: 'edit', onSelect: () => renameSwatch(entry.id) });
        items.push({ label: 'Delete Swatch', icon: 'trash', onSelect: () => deleteSwatch(entry.id) });
        const gs = groups();
        if (gs.length || entry.group) {
          items.push({ type: 'separator' });
          if (entry.group) items.push({ label: 'Move Out of Group', onSelect: () => moveTo(entry.id, null) });
          for (const g of gs) if (g.id !== entry.group) items.push({ label: `Move to ${g.name}`, icon: 'folder', onSelect: () => moveTo(entry.id, g.id) });
        }
      }
      items.push({ type: 'separator' });
      items.push({ label: 'Copy Color as HTML', icon: 'copy', onSelect: () => copy(hex, 'html') });
      items.push({ label: 'Copy Color\'s Hex Code', icon: 'copy', onSelect: () => copy(hex, 'hex') });
      app.dialogs.popover(b, items, { at: { x: e.clientX, y: e.clientY } });
    });
    return b;
  }

  const dropInto = (target, group) => {
    target.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes(SWATCH_MIME)) return;
      e.preventDefault();
      target.classList.add('drop-target');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-target'));
    target.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData(SWATCH_MIME);
      target.classList.remove('drop-target');
      if (!id) return;
      e.preventDefault();
      moveTo(id, group);
    });
  };

  function grid(presets, label) {
    const g = el('div', `swatch-grid swatch-main${view() === 'list' ? ' as-list' : ''}${view() === 'large' ? ' large' : ''}`);
    g.setAttribute('role', 'list');
    g.setAttribute('aria-label', label);
    g.append(...presets.map((p) => swatchButton(p)));
    return g;
  }

  function render() {
    const recent = (app.settings.recentColors ?? []).slice(0, RECENT_MAX);
    recentGrid.replaceChildren(...recent.map((c) => swatchButton(c, { recent: true })));
    recentGrid.hidden = recentTitle.hidden = !recent.length;
    const q = search.value;
    const all = M.filterSwatches(list(), q, hexOf);
    const gs = groups();
    const collapsed = ui().swatchesCollapsed ?? {};
    const children = (parent) => gs.filter((g) => (g.parent ?? null) === parent);
    const count = (gid) => all.filter((p) => p.group === gid).length + children(gid).reduce((n, c) => n + count(c.id), 0);
    const nodes = [];
    const loose = all.filter((p) => !p.group || !gs.some((g) => g.id === p.group));
    const top = grid(loose, 'Swatches');
    top.dataset.group = '';
    dropInto(top, null);
    if (!q || loose.length) nodes.push(top);
    const groupNode = (g, depth) => {
      if (q && !count(g.id)) return null;
      const box = el('div', 'swatch-group');
      box.dataset.group = g.id;
      box.style.setProperty('--depth', String(depth));
      const open = q ? true : !collapsed[g.id];
      const headBtn = el('button', 'swatch-group-head', `${icon(open ? 'chevron-down' : 'chevron-right')}${icon('folder')}<span class="swatch-group-name"></span>`);
      headBtn.type = 'button';
      headBtn.querySelector('.swatch-group-name').textContent = g.name;
      headBtn.setAttribute('aria-expanded', String(open));
      headBtn.addEventListener('click', () => {
        const c = { ...(ui().swatchesCollapsed ?? {}) };
        if (c[g.id]) delete c[g.id];
        else c[g.id] = true;
        saveUI({ swatchesCollapsed: c });
        setTimeout(render, 0);
      });
      headBtn.addEventListener('dblclick', () => renameGroup(g));
      headBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        app.dialogs.popover(headBtn, [
          { label: 'Rename Group…', icon: 'edit', onSelect: () => renameGroup(g) },
          { label: 'Ungroup Swatches', onSelect: () => deleteGroup(g, true) },
          { label: 'Delete Group and Swatches…', icon: 'trash', onSelect: () => deleteGroup(g, false) },
        ], { at: { x: e.clientX, y: e.clientY } });
      });
      dropInto(headBtn, g.id);
      box.appendChild(headBtn);
      if (open) {
        const inner = grid(all.filter((p) => p.group === g.id), g.name);
        dropInto(inner, g.id);
        box.appendChild(inner);
        for (const c of children(g.id)) {
          const n = groupNode(c, depth + 1);
          if (n) box.appendChild(n);
        }
      }
      return box;
    };
    for (const g of children(null)) {
      const n = groupNode(g, 0);
      if (n) nodes.push(n);
    }
    // groups whose parent is gone show at the top level
    for (const g of gs) if (g.parent && !gs.some((x) => x.id === g.parent)) {
      const n = groupNode(g, 0);
      if (n) nodes.push(n);
    }
    if (q && !all.length) nodes.push(el('div', 'muted swatch-empty', 'No swatch matches'));
    body.replaceChildren(...nodes);
    const fg = normHex(app.settings.foreground);
    for (const b of root.querySelectorAll('.swatch[data-color]')) b.classList.toggle('current', b.dataset.color === fg);
    $('[data-act="delete"]').disabled = !selected || !app.presets.get('swatches', selected);
  }

  async function menu(anchor) {
    await ready();
    const v = view();
    let libs = [];
    let pm = null;
    try {
      pm = await import('../preset-manager.js');
      libs = typeof pm.pigmentLibraries === 'function' ? await pm.pigmentLibraries('swatches') : [];
    } catch {
      libs = [];
    }
    app.dialogs.popover(anchor, [
      { label: 'New Swatch…', icon: 'plus', onSelect: () => newSwatchDialog(app.settings.foreground) },
      { label: 'New Swatch Group…', icon: 'folder', onSelect: newGroup },
      { type: 'separator' },
      ...VIEWS.map(([id, label]) => ({ label, checked: v === id, onSelect: () => {
        saveUI({ swatchesView: id });
        setTimeout(render, 0);
      } })),
      { type: 'separator' },
      { label: 'Color Libraries…', icon: 'color-book', onSelect: () => colorLibraries() },
      { label: 'Preset Manager…', disabled: !app.commands.isEnabled('edit:preset-manager'), onSelect: () => app.commands.run('edit:preset-manager', { kind: 'swatches' }, 'panel') },
      ...(libs.length ? [{ type: 'separator' }, ...libs.map((l) => ({ label: `Load ${l.name}`, onSelect: () => pm.loadPigmentLibrary(app, l.id) }))] : []),
      { type: 'separator' },
      ...presetFileMenuItems(app, 'swatches', { selectedIds: selected ? [selected] : [] }).map((i) => ({ ...i, label: i.label.replace('…', ' Swatches…') })),
      ...(pm?.replaceKind ? [{ label: 'Replace Swatches…', onSelect: () => pm.replaceKind(app, 'swatches') }] : []),
      { label: 'Reset Swatches…', icon: 'refresh', onSelect: resetSwatches },
    ], { align: 'right' });
  }
  async function colorLibraries() {
    const res = await colorLibrariesDialog(app, { initial: app.settings.foreground });
    if (!res) return;
    const v = bookEntryValue(res.book, res.entry, app.doc);
    app.setColors({ foreground: v.hex });
    const p = await addSwatchValue(app, v);
    selected = p.id;
    render();
  }
  async function resetSwatches() {
    const ok = await app.dialogs.confirm('Replace your swatches with the default swatches?', { title: 'Reset Swatches', okLabel: 'Reset' });
    if (!ok) return;
    app.presets.reset('swatches');
    selected = null;
    render();
  }

  $('[data-act="add"]').addEventListener('click', () => addSwatch());
  $('[data-act="group"]').addEventListener('click', newGroup);
  $('[data-act="delete"]').addEventListener('click', () => deleteSwatch(selected));
  $('[data-act="menu"]').addEventListener('click', (e) => menu(e.currentTarget));
  search.addEventListener('input', () => render());
  // the empty area of the panel takes a swatch out of its group
  dropInto(body, null);

  // recent colours: remember the foreground once it settles (dragging in a picker fires many changes)
  let recentTimer = 0;
  let settingsTimer = 0;
  let lastFg = normHex(app.settings.foreground);
  app.on('color:changed', ({ fg }) => {
    const hex = normHex(fg);
    for (const b of root.querySelectorAll('.swatch[data-color]')) b.classList.toggle('current', b.dataset.color === hex);
    if (hex === lastFg) return;
    lastFg = hex;
    clearTimeout(recentTimer);
    recentTimer = setTimeout(() => remember(hex), 700);
  });
  function remember(hex) {
    app.saveSettingsSoon({ recentColors: M.addRecentColor(app.settings.recentColors, hex, RECENT_MAX) });
    render();
  }

  app.presets.addEventListener('change', (e) => {
    if (e.detail?.kind !== 'swatches') return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(render, 0);
  });
  app.on('swatches:changed', () => render());
  app.on('settings:changed', (patch) => {
    if (patch && ('recentColors' in patch || 'colorUI' in patch)) {
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(render, 0);
    }
  });
  app.on('doc:activated', () => {
    // Lab swatches are drawn in the active document's profile
    if (list().some((p) => p.data?.color?.space === 'lab')) render();
  });

  app.panels.register({ id: 'swatches', title: 'Swatches', icon: 'swatches', element: root, group: 'top', onShow: render });
  ready().then(render, () => render());
  render();
  return { render, addSwatch, newGroup, deleteSwatch, select: (id) => {
    selected = id;
    render();
  } };
}
