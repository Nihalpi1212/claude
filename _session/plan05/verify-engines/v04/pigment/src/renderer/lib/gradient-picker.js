// The gradient picker (gradients package): the presets of the `gradients` kind (lib/presets.js, C) as swatches in
// collapsible groups. Used by the gradient widget's drop-down, the Gradient Editor's Presets area and the Gradients
// panel. Swatches can be dragged onto the canvas or a layer row (application/x-pigment-gradient, L.9, a resolved def)
// and, inside a picker, onto another swatch or a group heading to reorder or regroup them. A right-click menu renames,
// duplicates and deletes presets and groups (when `editable`).
import { gradientThumbnail, GRADIENT_KIND } from './gradient-presets.js';
import { normalizeGradient } from '../../shared/pixels/gradient-model.js';

export const GRADIENT_MIME = 'application/x-pigment-gradient';
const PRESET_MIME = 'application/x-pigment-gradient-preset';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Settings of the gradients namespace (rule 5): read with defaults, written as a new object. */
export function gradientSettings(app) {
  return app?.settings?.gradients ?? {};
}
export function saveGradientSettings(app, patch) {
  app?.saveSettingsSoon?.({ gradients: { ...gradientSettings(app), ...patch } });
}

/** The colours { ref } stops resolve with. */
export const appColors = (app) => ({ fg: app?.settings?.foreground ?? '#000000', bg: app?.settings?.background ?? '#ffffff' });

/** A preset's data with its colour references resolved (what layer data may hold, G.1). */
export function resolvedPresetData(app, preset) {
  return normalizeGradient(preset?.data, appColors(app));
}

/** Waits for the kind's user file, then runs fn (an edit before that would overwrite the file, presets.js). */
export async function editPresets(app, fn) {
  await app.presets.ready(GRADIENT_KIND);
  return fn(app.presets);
}

/**
 * @param {object} app
 * @param {{ selected?: string | null, onPick?: (preset, e) => void, onActivate?: (preset, e) => void, size?: number,
 *   editable?: boolean, view?: 'grid' | 'list', className?: string }} opts
 * @returns {{ element: HTMLElement, select(id): void, selected(): string | null, refresh(): void, destroy(): void }}
 */
export function gradientPicker(app, opts = {}) {
  const size = opts.size ?? 32;
  let selected = opts.selected ?? null;
  const root = el('div', `gradient-picker${opts.className ? ` ${opts.className}` : ''}`);
  root.dataset.view = opts.view ?? 'grid';
  root.setAttribute('role', 'listbox');
  root.setAttribute('aria-label', 'Gradient presets');

  const collapsed = () => gradientSettings(app).collapsed ?? {};
  const toggleGroup = (id) => {
    const c = { ...collapsed() };
    if (c[id]) delete c[id];
    else c[id] = true;
    saveGradientSettings(app, { collapsed: c });
    render();
  };

  const swatch = (p) => {
    const b = el('button', 'gp-swatch');
    b.type = 'button';
    b.dataset.presetId = p.id;
    b.title = p.name;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(p.id === selected));
    const colors = appColors(app);
    b.appendChild(gradientThumbnail(p, root.dataset.view === 'list' ? 48 : size, { ...colors, height: root.dataset.view === 'list' ? 16 : size }));
    if (root.dataset.view === 'list') b.appendChild(el('span', 'gp-name', p.name));
    b.addEventListener('click', (e) => {
      selected = p.id;
      for (const s of root.querySelectorAll('.gp-swatch')) s.setAttribute('aria-selected', String(s.dataset.presetId === selected));
      opts.onPick?.(p, e);
    });
    b.addEventListener('dblclick', (e) => opts.onActivate?.(p, e));
    b.draggable = true;
    b.addEventListener('dragstart', (e) => {
      // other panels and the canvas get a resolved def (stored data never holds colour references, G.1)
      e.dataTransfer.setData(GRADIENT_MIME, JSON.stringify(resolvedPresetData(app, p)));
      e.dataTransfer.setData(PRESET_MIME, p.id);
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    if (opts.editable !== false) {
      b.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes(PRESET_MIME)) e.preventDefault();
      });
      b.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData(PRESET_MIME);
        if (!id || id === p.id) return;
        e.preventDefault();
        e.stopPropagation();
        editPresets(app, (store) => {
          const members = store.list(GRADIENT_KIND, { group: p.group ?? null }).filter((x) => x.id !== id);
          store.move(GRADIENT_KIND, id, { group: p.group ?? null, index: members.findIndex((x) => x.id === p.id) });
        });
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        presetMenu(app, p, { x: e.clientX, y: e.clientY }, b);
      });
    }
    return b;
  };

  function render() {
    const list = app.presets?.list(GRADIENT_KIND) ?? [];
    const groups = app.presets?.groups(GRADIENT_KIND) ?? [];
    const c = collapsed();
    const parts = [];
    const known = new Set(groups.map((g) => g.id));
    for (const g of groups) {
      const members = list.filter((p) => p.group === g.id);
      const box = el('div', 'gp-group');
      box.dataset.group = g.id;
      const head = el('button', 'gp-group-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(!c[g.id]));
      head.append(el('span', 'gp-caret', c[g.id] ? '▸' : '▾'), el('span', 'gp-group-name', g.name), el('span', 'gp-count muted', String(members.length)));
      head.addEventListener('click', () => toggleGroup(g.id));
      if (opts.editable !== false) {
        head.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          groupMenu(app, g, { x: e.clientX, y: e.clientY }, head);
        });
        head.addEventListener('dragover', (e) => {
          if (e.dataTransfer.types.includes(PRESET_MIME)) e.preventDefault();
        });
        head.addEventListener('drop', (e) => {
          const id = e.dataTransfer.getData(PRESET_MIME);
          if (!id) return;
          e.preventDefault();
          editPresets(app, (store) => store.move(GRADIENT_KIND, id, { group: g.id }));
        });
      }
      box.appendChild(head);
      if (!c[g.id]) {
        const grid = el('div', 'gp-grid');
        for (const p of members) grid.appendChild(swatch(p));
        box.appendChild(grid);
      }
      parts.push(box);
    }
    const loose = list.filter((p) => !p.group || !known.has(p.group));
    if (loose.length) {
      const grid = el('div', 'gp-grid gp-loose');
      for (const p of loose) grid.appendChild(swatch(p));
      parts.push(grid);
    }
    if (!list.length) parts.push(el('div', 'muted gp-empty', 'No gradients. Reset Gradients brings back the built-in ones.'));
    root.replaceChildren(...parts);
  }

  render();
  // the user's file loads once; until then the list holds the built-ins
  app.presets?.ready(GRADIENT_KIND).then(render).catch(() => {});
  const offs = [
    app.on?.('presets:changed', (d) => {
      if (!d || d.kind === GRADIENT_KIND) render();
    }),
    // swatches with colour references follow the foreground and background colours
    app.on?.('color:changed', () => render()),
  ].filter(Boolean);
  return {
    element: root,
    select(id) {
      selected = id ?? null;
      for (const s of root.querySelectorAll('.gp-swatch')) s.setAttribute('aria-selected', String(s.dataset.presetId === selected));
    },
    selected: () => selected,
    setView(view) {
      root.dataset.view = view;
      render();
    },
    refresh: render,
    destroy() {
      for (const off of offs) off();
      root.remove();
    },
  };
}

/** Rename / Duplicate / Delete of one preset. */
export function presetMenu(app, preset, at, anchor) {
  app.dialogs.popover(anchor, [
    { label: 'Rename Gradient…', icon: 'edit', onSelect: () => renamePreset(app, preset) },
    { label: 'Duplicate Gradient', icon: 'copy', onSelect: () => editPresets(app, (s) => s.add(GRADIENT_KIND, { name: `${preset.name} copy`, data: preset.data, group: preset.group ?? null })) },
    { type: 'separator' },
    { label: 'Delete Gradient', icon: 'trash', onSelect: () => editPresets(app, (s) => s.remove(GRADIENT_KIND, preset.id)) },
  ], { at });
}

export async function renamePreset(app, preset) {
  const name = await app.dialogs.prompt('Name', { title: 'Rename Gradient', value: preset.name });
  if (!name?.trim()) return;
  await editPresets(app, (s) => s.update(GRADIENT_KIND, preset.id, { name: name.trim() }));
}

/** Rename / Delete of a group, and New Group. */
export function groupMenu(app, group, at, anchor) {
  app.dialogs.popover(anchor, [
    { label: 'New Group…', icon: 'folder', onSelect: () => newGroup(app) },
    { label: 'Rename Group…', icon: 'edit', onSelect: async () => {
      const name = await app.dialogs.prompt('Name', { title: 'Rename Group', value: group.name });
      if (name?.trim()) await editPresets(app, (s) => s.renameGroup(GRADIENT_KIND, group.id, name.trim()));
    } },
    { type: 'separator' },
    { label: 'Delete Group (keep its gradients)', icon: 'trash', onSelect: () => editPresets(app, (s) => s.removeGroup(GRADIENT_KIND, group.id, { keepPresets: true })) },
    { label: 'Delete Group and Its Gradients', icon: 'trash', onSelect: () => editPresets(app, (s) => s.removeGroup(GRADIENT_KIND, group.id, { keepPresets: false })) },
  ], { at });
}

export async function newGroup(app) {
  const name = await app.dialogs.prompt('Name', { title: 'New Gradient Group', value: 'Group' });
  if (!name?.trim()) return null;
  return editPresets(app, (s) => s.addGroup(GRADIENT_KIND, { name: name.trim() }));
}
