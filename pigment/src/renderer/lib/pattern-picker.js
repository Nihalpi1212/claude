// The pattern picker (patterns package; ARCHITECTURE.md "0.4 features", package 10): the patterns of the library
// (app.patterns, lib/patterns.js) as tiled swatches in collapsible groups. Used by the `pattern` widget's drop-down,
// the Pattern Fill dialog and the Patterns panel. A swatch can be dragged onto the canvas or a layer row
// (application/x-pigment-pattern, a PatternRef with its pixels, L.9) and, inside a picker, onto another swatch or a
// group heading to reorder or regroup it. A right-click menu renames, duplicates and deletes patterns and groups.
//
//   patternPicker(app, { selected, onPick(entry, e), onActivate(entry, e), size, view: 'grid' | 'list', editable,
//                        className }) -> { element, select(id), selected(), setView(view), refresh(), destroy() }
//   the library actions the panel and the widget share: definePattern, renamePattern, duplicatePattern,
//   deletePatterns, newPatternGroup, importPatterns, exportPatterns, resetPatterns
import { PATTERN_KIND, PATTERN_MIME, patternThumbnail } from './patterns.js';
import { presetFormats } from './presets.js';
import { bridge } from './bridge.js';

const PRESET_MIME = 'application/x-pigment-pattern-preset';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Settings of the patterns namespace (rule 5): read with defaults, written as a new object. */
export function patternSettings(app) {
  return app?.settings?.patterns ?? {};
}
export function savePatternSettings(app, patch) {
  app?.saveSettingsSoon?.({ patterns: { ...patternSettings(app), ...patch } });
}

/** Waits for the kind's user file, then runs fn (an edit before that would overwrite the file, presets.js). */
export async function editPatternPresets(app, fn) {
  await app.patterns.ready();
  await app.presets.ready(PATTERN_KIND);
  return fn(app.presets);
}

/**
 * @param {object} app
 * @param {{ selected?: string | null, onPick?: Function, onActivate?: Function, size?: number, editable?: boolean,
 *   view?: 'grid' | 'list', className?: string }} opts
 */
export function patternPicker(app, opts = {}) {
  const size = opts.size ?? 32;
  let selected = opts.selected ?? null;
  const root = el('div', `pattern-picker${opts.className ? ` ${opts.className}` : ''}`);
  root.dataset.view = opts.view ?? 'grid';
  root.setAttribute('role', 'listbox');
  root.setAttribute('aria-label', 'Patterns');

  const collapsed = () => patternSettings(app).collapsed ?? {};
  const toggleGroup = (id) => {
    const c = { ...collapsed() };
    if (c[id]) delete c[id];
    else c[id] = true;
    savePatternSettings(app, { collapsed: c });
    render();
  };

  const markSelected = () => {
    for (const s of root.querySelectorAll('.pp-swatch')) s.setAttribute('aria-selected', String(s.dataset.presetId === selected));
  };

  const swatch = (entry) => {
    const b = el('button', 'pp-swatch');
    b.type = 'button';
    b.dataset.presetId = entry.id;
    b.title = entry.canvas ? `${entry.name} (${entry.width} × ${entry.height} px)` : entry.missing ? `${entry.name}: its pixels are missing` : entry.name;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(entry.id === selected));
    const list = root.dataset.view === 'list';
    const thumb = patternThumbnail(entry.canvas, list ? 24 : size, list ? 24 : size);
    if (entry.missing) b.classList.add('pp-missing');
    b.appendChild(thumb);
    if (list) b.appendChild(el('span', 'pp-name', entry.name));
    b.addEventListener('click', (e) => {
      if (!entry.canvas) return;
      selected = entry.id;
      markSelected();
      opts.onPick?.(entry, e);
    });
    b.addEventListener('dblclick', (e) => opts.onActivate?.(entry, e));
    b.draggable = !!entry.canvas;
    b.addEventListener('dragstart', (e) => {
      const ref = app.patterns.ref(entry);
      if (!ref) return e.preventDefault();
      // other panels and the canvas get the pixels themselves (a stored ref always carries them, L.6)
      e.dataTransfer.setData(PATTERN_MIME, JSON.stringify(ref));
      e.dataTransfer.setData(PRESET_MIME, entry.id);
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    if (opts.editable !== false) {
      b.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes(PRESET_MIME)) e.preventDefault();
      });
      b.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData(PRESET_MIME);
        if (!id || id === entry.id) return;
        e.preventDefault();
        e.stopPropagation();
        editPatternPresets(app, (store) => {
          const members = store.list(PATTERN_KIND, { group: entry.group ?? null }).filter((x) => x.id !== id);
          store.move(PATTERN_KIND, id, { group: entry.group ?? null, index: members.findIndex((x) => x.id === entry.id) });
        });
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        patternMenu(app, entry, { x: e.clientX, y: e.clientY }, b);
      });
    }
    return b;
  };

  function render() {
    const list = app.patterns?.list() ?? [];
    const groups = app.presets?.groups(PATTERN_KIND) ?? [];
    const c = collapsed();
    const parts = [];
    const known = new Set(groups.map((g) => g.id));
    for (const g of groups) {
      const members = list.filter((p) => p.group === g.id);
      const box = el('div', 'pp-group');
      box.dataset.group = g.id;
      const head = el('button', 'pp-group-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(!c[g.id]));
      head.append(el('span', 'pp-caret', c[g.id] ? '▸' : '▾'), el('span', 'pp-group-name', g.name), el('span', 'pp-count muted', String(members.length)));
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
          editPatternPresets(app, (store) => store.move(PATTERN_KIND, id, { group: g.id }));
        });
      }
      box.appendChild(head);
      if (!c[g.id]) {
        const grid = el('div', 'pp-grid');
        for (const p of members) grid.appendChild(swatch(p));
        box.appendChild(grid);
      }
      parts.push(box);
    }
    const loose = list.filter((p) => !p.group || !known.has(p.group));
    if (loose.length) {
      const grid = el('div', 'pp-grid pp-loose');
      for (const p of loose) grid.appendChild(swatch(p));
      parts.push(grid);
    }
    if (!list.length) parts.push(el('div', 'muted pp-empty', 'No patterns. Edit › Define Pattern makes one from the selection; Reset Patterns brings back the built-in ones.'));
    root.replaceChildren(...parts);
  }

  // pixels arrive one pattern at a time after start: redraw once per frame at most
  let raf = 0;
  const later = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  };
  render();
  app.patterns?.ready().then(later).catch(() => {});
  const offs = [
    app.on?.('patterns:changed', later),
    app.on?.('presets:changed', (d) => {
      if (!d || d.kind === PATTERN_KIND) later();
    }),
  ].filter(Boolean);
  return {
    element: root,
    select(id) {
      selected = id ?? null;
      markSelected();
    },
    selected: () => selected,
    setView(view) {
      root.dataset.view = view;
      render();
    },
    refresh: render,
    destroy() {
      cancelAnimationFrame(raf);
      for (const off of offs) off?.();
      root.remove();
    },
  };
}

// ---- library actions -------------------------------------------------------------------------------------------------

/** Rename / Duplicate / Delete of one pattern. */
export function patternMenu(app, entry, at, anchor) {
  app.dialogs.popover(anchor, [
    { label: 'Rename Pattern…', icon: 'edit', onSelect: () => renamePattern(app, entry) },
    { label: 'Duplicate Pattern', icon: 'copy', disabled: !entry.canvas, onSelect: () => duplicatePattern(app, entry) },
    { type: 'separator' },
    { label: 'Delete Pattern', icon: 'trash', onSelect: () => deletePatterns(app, [entry.id]) },
  ], { at });
}

export async function renamePattern(app, entry) {
  const name = await app.dialogs.prompt('Name', { title: 'Rename Pattern', value: entry.name });
  if (name?.trim()) await app.patterns.rename(entry.id, name.trim());
}

/** A copy with its own pixel file (deleting one never takes the other's pixels). */
export async function duplicatePattern(app, entry) {
  const e = await app.patterns.get(entry.id);
  if (!e?.canvas) return null;
  const copy = await app.patterns.define(e.canvas, { name: `${e.name} copy`, group: e.group ?? null });
  return copy;
}

export async function deletePatterns(app, ids, { confirm = false } = {}) {
  if (!ids?.length) return;
  if (confirm && !(await app.dialogs.confirm(ids.length === 1 ? 'Delete this pattern?' : `Delete ${ids.length} patterns?`, { title: 'Delete Pattern', okLabel: 'Delete', danger: true }))) return;
  await app.patterns.remove(ids);
}

/** Rename / Delete of a group, and New Group. */
export function groupMenu(app, group, at, anchor) {
  app.dialogs.popover(anchor, [
    { label: 'New Pattern Group…', icon: 'folder', onSelect: () => newPatternGroup(app) },
    { label: 'Rename Group…', icon: 'edit', onSelect: async () => {
      const name = await app.dialogs.prompt('Name', { title: 'Rename Group', value: group.name });
      if (name?.trim()) await editPatternPresets(app, (s) => s.renameGroup(PATTERN_KIND, group.id, name.trim()));
    } },
    { type: 'separator' },
    { label: 'Delete Group (keep its patterns)', icon: 'trash', onSelect: () => editPatternPresets(app, (s) => s.removeGroup(PATTERN_KIND, group.id, { keepPresets: true })) },
    { label: 'Delete Group and Its Patterns', icon: 'trash', onSelect: () => editPatternPresets(app, (s) => s.removeGroup(PATTERN_KIND, group.id, { keepPresets: false })) },
  ], { at });
}

export async function newPatternGroup(app) {
  const name = await app.dialogs.prompt('Name', { title: 'New Pattern Group', value: 'Group' });
  if (!name?.trim()) return null;
  return editPatternPresets(app, (s) => s.addGroup(PATTERN_KIND, { name: name.trim() }));
}

/** Import Patterns…: a .pigment-presets file, or pictures (each becomes a pattern). */
export async function importPatterns(app, path = null) {
  const formats = presetFormats(PATTERN_KIND);
  let files = path ? [path] : null;
  if (!files) {
    const picked = await bridge.openFileDialog({ title: 'Import Patterns', multiple: true, filters: [{ name: 'Patterns and pictures', extensions: [...new Set(formats.flatMap((f) => f.extensions ?? []))].map((e) => e.replace(/^\./, '')) }] });
    files = Array.isArray(picked) ? picked : picked ? [picked] : [];
  }
  if (!files.length) return null;
  await app.patterns.ready();
  let added = 0;
  const report = [];
  for (const file of files) {
    try {
      const bytes = await bridge.readFile(file);
      const res = await app.presets.importFile(PATTERN_KIND, bytes, { name: String(file).split(/[\\/]/).pop() });
      added += res.added.length;
      report.push(...(res.report ?? []));
    } catch (err) {
      report.push(`${String(file).split(/[\\/]/).pop()}: ${err?.message ?? err}`);
    }
  }
  if (report.length) app.dialogs.toast(report.join(' · '), { kind: added ? 'info' : 'error', timeout: 5000 });
  if (added) app.dialogs.toast(`Imported ${added} pattern${added === 1 ? '' : 's'}`, { kind: 'success', timeout: 2200 });
  return { added };
}

/** Export…: the given patterns (all when ids is null) as a .pigment-presets file, their pixels inside. */
export async function exportPatterns(app, ids = null, path = null) {
  const fmt = presetFormats(PATTERN_KIND).find((f) => f.write) ?? null;
  if (!fmt) return null;
  const target = path ?? await bridge.saveFileDialog({ title: 'Export Patterns', defaultPath: `Patterns.${fmt.extensions[0]}`, filters: [{ name: fmt.name, extensions: fmt.extensions }] });
  if (!target) return null;
  try {
    await app.patterns.ready();
    const { bytes, ext } = await app.presets.exportFile(PATTERN_KIND, ids, fmt.id);
    const file = new RegExp(`\\.${ext}$`, 'i').test(target) ? target : `${target}.${ext}`;
    await bridge.writeFile(file, bytes);
    app.dialogs.toast('Exported the patterns', { kind: 'success', timeout: 1800 });
    return file;
  } catch (err) {
    app.reportError?.(err, 'Could not export the patterns');
    return null;
  }
}

export async function resetPatterns(app) {
  const ok = await app.dialogs.confirm('Replace your patterns with the built-in ones? Patterns you defined or imported are deleted.', { title: 'Reset Patterns', okLabel: 'Reset' });
  if (!ok) return false;
  await app.patterns.ready();
  app.presets.reset(PATTERN_KIND);
  return true;
}
