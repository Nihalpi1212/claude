// The Preset Manager and Photoshop's preset files (ARCHITECTURE.md "0.5 features", package 10, preset-files-manager's
// MODULES entry). install(app) registers the file formats of lib/preset-files/ and the three commands of Edit >
// Presets:
//   edit:preset-manager        one dialog over every preset kind: thumbnails or names, select (Shift / Ctrl-click),
//                              drag to reorder, Load…, Save Set…, Rename…, Delete, Reset, Replace, Pigment libraries.
//   edit:export-import-presets Export Presets (a .pigment-bundle of the kinds ticked, with the settings of
//                              BUNDLE_SETTINGS) and Import Presets (the kinds and settings of a bundle, S10.7).
//   edit:migrate-presets       presets from a bundle or from an older Pigment's presets folder.
// None changes a document: they are not history entries and not recorded in actions (record: false). Arguments for
// scripts and tests: edit:preset-manager { kind }, edit:export-import-presets { mode: 'export' | 'import', path,
// kinds?, settings? } (no dialog), edit:migrate-presets { path } (a bundle or a folder; no dialog).
//
// Pigment-made libraries (S10.5): .pigment-presets files under src/renderer/presets/, listed in its index.json and
// offered by the Preset Manager's menu; pigmentLibraries(kind) and loadPigmentLibrary(app, id) are exported for the
// panels' menus.
import { presetKind, presetKinds } from './presets.js';
import { importPresetFiles, importPresetBytes, exportPresetsDialog, BUNDLE_SETTINGS } from './preset-formats.js';
import { registerSwatchFormats } from './preset-files/aco-ase.js';
import { registerPatFormat } from './preset-files/pat.js';
import { registerGrdFormat } from './preset-files/grd.js';
import { registerCshFormat } from './preset-files/csh.js';
import { registerAslFormat } from './preset-files/asl.js';
import { registerTplFormat } from './preset-files/tpl.js';
import { writeBundle, readBundle, bundleSettingsPatch, withBundleKinds, registerBundleFormat, BUNDLE_EXTENSION } from './preset-files/bundle.js';
import { folderBundle } from './preset-files/migrate.js';
import { icon, registerIcons } from './icons.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const lastName = (p) => String(p ?? '').split(/[\\/]/).pop();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** fn under app.busy (a busy cursor and status) when the app has it. */
const busy = (app, label, fn) => (typeof app.busy === 'function' ? app.busy(label, fn) : fn());

/** Photoshop's Preset Manager types first, then every other kind by title. */
const KIND_ORDER = ['brushes', 'swatches', 'gradients', 'styles', 'patterns', 'contours', 'shapes', 'tool-presets'];
const VIEWS = [
  ['text', 'Text Only'],
  ['small-thumbs', 'Small Thumbnail'],
  ['large-thumbs', 'Large Thumbnail'],
  ['small-list', 'Small List'],
  ['large-list', 'Large List'],
];
const THUMB = { 'small-thumbs': 32, 'large-thumbs': 64, 'small-list': 20, 'large-list': 36, text: 0 };
const SETTINGS_LABELS = { tools: 'tool options', brushes: 'brush settings', painting: 'painting', colorUI: 'colour picker', typeFonts: 'fonts', keymap: 'keyboard shortcuts' };

registerIcons({
  presets: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="3.5"/><path d="M3 21l3.5-7 3.5 7z"/><path d="M14 14h7v7h-7z" stroke-dasharray="2 1.5"/>',
});

/** The kinds the Preset Manager lists, in its order. */
export function managerKinds() {
  const all = presetKinds().filter((k) => presetKind(k));
  const first = KIND_ORDER.filter((k) => all.includes(k));
  const rest = all.filter((k) => !first.includes(k)).sort((a, b) => kindTitle(a).localeCompare(kindTitle(b)));
  return [...first, ...rest];
}
const kindTitle = (kind) => presetKind(kind)?.title ?? kind;

const prefs = (app) => (isObject(app.settings?.presetManager) ? app.settings.presetManager : {});
const savePrefs = (app, patch) => app.saveSettingsSoon?.({ presetManager: { ...prefs(app), ...patch } });

// ---- Pigment-made libraries -----------------------------------------------------------------------------------------

let libraryIndex = null;
const libraryUrl = (file) => new URL(`../presets/${file}`, import.meta.url).href;

/** The Pigment-made libraries (src/renderer/presets/index.json): [{ id, file, kind, name }]. */
export async function loadLibraryIndex() {
  if (libraryIndex) return libraryIndex;
  try {
    const res = await fetch(libraryUrl('index.json'));
    const json = res.ok ? await res.json() : null;
    libraryIndex = (Array.isArray(json?.libraries) ? json.libraries : []).filter((l) => l && typeof l.file === 'string' && typeof l.kind === 'string');
  } catch {
    libraryIndex = [];
  }
  return libraryIndex;
}

/** The Pigment-made libraries of a kind (all with no kind). */
export async function pigmentLibraries(kind = null) {
  return (await loadLibraryIndex()).filter((l) => !kind || l.kind === kind);
}

/** Loads a Pigment-made library into its kind: { added, report } as importPresetBytes gives it. */
export async function loadPigmentLibrary(app, id) {
  const lib = (await loadLibraryIndex()).find((l) => l.id === id || l.file === id);
  if (!lib) return { added: {}, report: [`Pigment has no library ${id}`] };
  let bytes;
  try {
    const res = await fetch(libraryUrl(lib.file));
    if (!res.ok) throw new Error(`${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    return { added: {}, report: [`${lib.name} could not be read (${err?.message ?? err})`] };
  }
  const res = await importPresetBytes(app, [{ name: lib.file, bytes }], { kinds: [lib.kind] });
  const n = Object.values(res.added).reduce((s, v) => s + v, 0);
  if (n) app.dialogs?.toast?.(`Loaded ${lib.name}: ${plural(n, 'preset')}`, { kind: 'success', timeout: 2500 });
  if (res.report.length) app.dialogs?.alert?.(n ? `Some presets of ${lib.name} were not loaded` : `${lib.name} was not loaded`, { title: 'Presets', detail: res.report.join('\n') });
  return res;
}

// ---- thumbnails ------------------------------------------------------------------------------------------------------

function canvasOf(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** A thumbnail element for a preset of a kind, or null (the kind's own thumbnail first). */
async function thumbnailFor(app, kind, preset, size) {
  const def = presetKind(kind);
  try {
    const own = def?.thumbnail?.(preset, size);
    if (own instanceof HTMLElement) return own;
  } catch {
    // a kind's broken thumbnail falls back to the generic ones
  }
  const data = preset.data;
  if (kind === 'swatches') {
    const { swatchHex } = await import('./color-picker.js');
    const c = canvasOf(size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = swatchHex(data) ?? '#000000';
    ctx.fillRect(0, 0, size, size);
    return c;
  }
  if (kind === 'patterns') {
    const e = await app.patterns?.get?.(preset.id);
    if (!e?.canvas) return null;
    const { patternThumbnail } = await import('./patterns.js');
    return patternThumbnail(e.canvas, size);
  }
  if (kind === 'contours') {
    const { contourThumbnail } = await import('./contour-editor.js');
    return contourThumbnail(data, size);
  }
  if (kind === 'shapes' && data?.path?.subpaths) {
    const c = canvasOf(size);
    const ctx = c.getContext('2d');
    const pad = Math.max(2, size * 0.1), s = size - pad * 2;
    ctx.beginPath();
    for (const sp of data.path.subpaths) {
      const pts = sp.points ?? [];
      if (!pts.length) continue;
      ctx.moveTo(pad + pts[0].x * s, pad + pts[0].y * s);
      const seg = (a, b) => ctx.bezierCurveTo(pad + (a.outX ?? a.x) * s, pad + (a.outY ?? a.y) * s, pad + (b.inX ?? b.x) * s, pad + (b.inY ?? b.y) * s, pad + b.x * s, pad + b.y * s);
      for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
      if (sp.closed !== false) {
        seg(pts[pts.length - 1], pts[0]);
        ctx.closePath();
      }
    }
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#222';
    ctx.fill('evenodd');
    return c;
  }
  if (kind === 'tool-presets') {
    const tool = app.tools?.get?.(data?.tool);
    const span = document.createElement('span');
    span.className = 'pm-icon';
    span.innerHTML = icon(tool?.icon ?? 'brush');
    return span;
  }
  if (kind === 'styles') {
    const span = document.createElement('span');
    span.className = 'pm-icon pm-style';
    span.innerHTML = icon('fx');
    return span;
  }
  return null;
}

// ---- the Preset Manager ----------------------------------------------------------------------------------------------

/** Opens the Preset Manager on `kind` (default: the last one shown). Resolves when it closes. */
export async function presetManagerDialog(app, { kind = null } = {}) {
  const kinds = managerKinds();
  let current = kinds.includes(kind) ? kind : kinds.includes(prefs(app).kind) ? prefs(app).kind : kinds[0];
  let view = VIEWS.some(([v]) => v === prefs(app).view) ? prefs(app).view : 'small-thumbs';
  const selected = new Set();
  let anchor = null;
  let order = [];

  const root = document.createElement('div');
  root.className = 'preset-manager';
  root.innerHTML = `
    <div class="pm-top">
      <label>Preset Type: <select data-k="kind"></select></label>
      <button class="btn pm-menu" type="button" title="Preset Manager menu" aria-label="Preset Manager menu" data-act="menu">${icon('menu')}</button>
    </div>
    <div class="pm-body">
      <div class="pm-list" tabindex="0" role="listbox" aria-multiselectable="true" aria-label="Presets"></div>
      <div class="pm-actions">
        <button class="btn" type="button" data-act="load">Load…</button>
        <button class="btn" type="button" data-act="save">Save Set…</button>
        <button class="btn" type="button" data-act="rename">Rename…</button>
        <button class="btn" type="button" data-act="delete">Delete</button>
      </div>
    </div>
    <div class="pm-status muted"></div>`;
  const select = root.querySelector('[data-k="kind"]');
  for (const k of kinds) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = kindTitle(k);
    select.appendChild(o);
  }
  select.value = current;
  const list = root.querySelector('.pm-list');
  const status = root.querySelector('.pm-status');

  const presets = () => app.presets.list(current);
  const updateButtons = () => {
    const n = selected.size;
    root.querySelector('[data-act="rename"]').disabled = n === 0;
    root.querySelector('[data-act="delete"]').disabled = n === 0;
    root.querySelector('[data-act="save"]').textContent = n ? 'Save Set…' : 'Save All…';
    status.textContent = `${plural(presets().length, 'preset')}${n ? `, ${n} selected` : ''}`;
    for (const el of list.querySelectorAll('.pm-item')) {
      const on = selected.has(el.dataset.id);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
    }
  };

  let renderToken = 0;
  const render = async () => {
    const token = ++renderToken;
    await app.presets.ready(current);
    if (current === 'patterns') await app.patterns?.ready?.();
    if (token !== renderToken) return;
    list.dataset.view = view;
    list.replaceChildren();
    const all = presets();
    for (const id of [...selected]) if (!all.some((p) => p.id === id)) selected.delete(id);
    order = [];
    const groups = app.presets.groups(current);
    const byGroup = new Map([[null, []]]);
    for (const g of groups) byGroup.set(g.id, []);
    for (const p of all) (byGroup.get(p.group ?? null) ?? byGroup.get(null)).push(p);
    const size = THUMB[view];
    const sections = [[null, null], ...groups.map((g) => [g.id, g.name])];
    for (const [gid, name] of sections) {
      const items = byGroup.get(gid) ?? [];
      if (!items.length) continue;
      if (name) {
        const h = document.createElement('div');
        h.className = 'pm-group';
        h.textContent = name;
        list.appendChild(h);
      }
      for (const p of items) {
        order.push(p.id);
        const el = document.createElement('div');
        el.className = 'pm-item';
        el.dataset.id = p.id;
        el.setAttribute('role', 'option');
        el.draggable = true;
        el.title = p.name;
        const thumb = document.createElement('span');
        thumb.className = 'pm-thumb';
        const label = document.createElement('span');
        label.className = 'pm-name';
        label.textContent = p.name;
        el.append(thumb, label);
        list.appendChild(el);
        if (size) {
          thumbnailFor(app, current, p, size).then((t) => {
            if (t && token === renderToken) thumb.appendChild(t);
          }).catch(() => {});
        }
      }
    }
    if (!all.length) {
      const empty = document.createElement('div');
      empty.className = 'pm-empty muted';
      empty.textContent = `No ${kindTitle(current).toLowerCase()} presets`;
      list.appendChild(empty);
    }
    updateButtons();
  };

  const onStore = (e) => {
    if (e.detail?.kind === current) render();
  };
  app.presets.addEventListener('change', onStore);

  select.addEventListener('change', () => {
    current = select.value;
    selected.clear();
    anchor = null;
    savePrefs(app, { kind: current });
    render();
  });

  list.addEventListener('click', (event) => {
    const el = event.target.closest('.pm-item');
    if (!el) {
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) selected.clear();
      updateButtons();
      return;
    }
    const id = el.dataset.id;
    if (event.shiftKey && anchor && order.includes(anchor)) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
      if (!event.ctrlKey && !event.metaKey) selected.clear();
      for (let i = a; i <= b; i++) selected.add(order[i]);
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    } else {
      selected.clear();
      selected.add(id);
      anchor = id;
    }
    updateButtons();
  });
  list.addEventListener('dblclick', (event) => {
    const el = event.target.closest('.pm-item');
    if (!el) return;
    selected.clear();
    selected.add(el.dataset.id);
    updateButtons();
    renameSelected();
  });
  list.addEventListener('keydown', (event) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size) {
      event.preventDefault();
      event.stopPropagation();
      deleteSelected();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      event.stopPropagation();
      for (const id of order) selected.add(id);
      updateButtons();
    }
  });

  // drag to reorder: the dragged presets go before the preset dropped on (into its group)
  let dragging = null;
  list.addEventListener('dragstart', (event) => {
    const el = event.target.closest('.pm-item');
    if (!el) return;
    if (!selected.has(el.dataset.id)) {
      selected.clear();
      selected.add(el.dataset.id);
      updateButtons();
    }
    dragging = order.filter((id) => selected.has(id));
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragging.join(','));
  });
  list.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();
    for (const el of list.querySelectorAll('.drop-before')) el.classList.remove('drop-before');
    event.target.closest('.pm-item')?.classList.add('drop-before');
  });
  list.addEventListener('dragend', () => {
    dragging = null;
    for (const el of list.querySelectorAll('.drop-before')) el.classList.remove('drop-before');
  });
  list.addEventListener('drop', (event) => {
    if (!dragging) return;
    event.preventDefault();
    const target = event.target.closest('.pm-item')?.dataset.id ?? null;
    const ids = dragging;
    dragging = null;
    movePresets(app, current, ids, target);
  });

  const renameSelected = async () => {
    for (const id of order.filter((x) => selected.has(x))) {
      const p = app.presets.get(current, id);
      if (!p) continue;
      const name = await app.dialogs.prompt('Name:', { title: `Rename ${kindTitle(current).replace(/s$/, '')}`, value: p.name });
      if (name === null) return;
      if (String(name).trim()) renamePreset(app, current, id, String(name).trim());
    }
  };
  const deleteSelected = async () => {
    const ids = order.filter((x) => selected.has(x));
    if (!ids.length) return;
    await deletePresets(app, current, ids);
    selected.clear();
    updateButtons();
  };

  root.querySelector('[data-act="load"]').addEventListener('click', () => importPresetFiles(app, { kinds: [current] }));
  root.querySelector('[data-act="save"]').addEventListener('click', () => {
    const ids = order.filter((x) => selected.has(x));
    exportPresetsDialog(app, current, ids.length ? ids : null, { title: `Save ${kindTitle(current)}` });
  });
  root.querySelector('[data-act="rename"]').addEventListener('click', renameSelected);
  root.querySelector('[data-act="delete"]').addEventListener('click', deleteSelected);
  root.querySelector('[data-act="menu"]').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const libs = await pigmentLibraries(current);
    const items = [
      ...VIEWS.map(([v, label]) => ({ label, checked: view === v, onSelect: () => {
        view = v;
        savePrefs(app, { view });
        render();
      } })),
      { type: 'separator' },
      { label: `Reset ${kindTitle(current)}…`, onSelect: () => resetKind(app, current) },
      { label: `Replace ${kindTitle(current)}…`, onSelect: () => replaceKind(app, current) },
    ];
    if (libs.length) {
      items.push({ type: 'separator' }, { type: 'title', label: 'Pigment libraries' });
      for (const l of libs) items.push({ label: l.name, onSelect: () => loadPigmentLibrary(app, l.id) });
    }
    // above the dialog it belongs to (popovers sit below dialogs otherwise)
    app.dialogs.popover(btn, items, { align: 'right' })?.classList.add('pm-popover');
  });

  const done = app.dialogs.open({
    title: 'Preset Manager',
    content: root,
    width: 640,
    className: 'preset-manager-dialog',
    buttons: [{ label: 'Done', value: true, primary: true }],
    onOpen: () => list.focus(),
  });
  render();
  try {
    return await done;
  } finally {
    app.presets.removeEventListener('change', onStore);
  }
}

/** Moves presets before `beforeId` (into its group), or to the end of the ungrouped presets. */
export function movePresets(app, kind, ids, beforeId = null) {
  const target = beforeId ? app.presets.get(kind, beforeId) : null;
  const group = target ? target.group ?? null : null;
  for (const id of ids) {
    if (id === beforeId) continue;
    const members = app.presets.list(kind, { group }).filter((p) => p.id !== id);
    const index = target ? members.findIndex((p) => p.id === beforeId) : members.length;
    app.presets.move(kind, id, { group, index: index < 0 ? members.length : index });
  }
}

export function renamePreset(app, kind, id, name) {
  if (kind === 'patterns' && app.patterns?.rename) return app.patterns.rename(id, name);
  return app.presets.update(kind, id, { name });
}

/** Deletes presets (a pattern's pixel file goes with it, as the Patterns panel deletes). */
export async function deletePresets(app, kind, ids) {
  if (kind === 'patterns' && app.patterns?.remove) await app.patterns.remove(ids);
  else app.presets.remove(kind, ids);
}

/** Reset <kind>: back to the built-ins, after a confirmation. */
export async function resetKind(app, kind, { confirm = true } = {}) {
  if (confirm) {
    const ok = await app.dialogs.open({
      title: 'Preset Manager',
      content: `<p>Replace the current ${kindTitle(kind).toLowerCase()} with the default ${kindTitle(kind).toLowerCase()}? Your own ${kindTitle(kind).toLowerCase()} presets are removed.</p>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    });
    if (!ok) return false;
  }
  await app.presets.ready(kind);
  app.presets.reset(kind);
  return true;
}

/** Replace <kind>: the presets of a file in place of every current one. */
export async function replaceKind(app, kind, { path = null } = {}) {
  const { bridge } = await import('./bridge.js');
  const { presetFileExtensions } = await import('./preset-formats.js');
  let file = path;
  if (!file) {
    const picked = await bridge.openFileDialog({ title: `Replace ${kindTitle(kind)}`, filters: [{ name: kindTitle(kind), extensions: presetFileExtensions({ kinds: [kind] }) }] });
    file = Array.isArray(picked) ? picked[0] : picked;
  }
  if (!file) return null;
  let bytes;
  try {
    bytes = await bridge.readFile(file);
  } catch (err) {
    app.reportError?.(err, 'Could not read the file');
    return null;
  }
  await app.presets.ready(kind);
  const before = app.presets.list(kind).map((p) => p.id);
  const res = await importPresetBytes(app, [{ name: lastName(file), bytes }], { kinds: [kind] });
  if (!(res.added[kind] > 0)) {
    app.dialogs?.alert?.(`No ${kindTitle(kind).toLowerCase()} were found in the file, so nothing was replaced`, { title: `Replace ${kindTitle(kind)}`, detail: res.report.join('\n') });
    return res;
  }
  await deletePresets(app, kind, before);
  if (res.report.length) app.dialogs?.alert?.(`Some ${kindTitle(kind).toLowerCase()} were not loaded`, { title: `Replace ${kindTitle(kind)}`, detail: res.report.join('\n') });
  return res;
}

// ---- Export/Import Presets (S10.7) -------------------------------------------------------------------------------

/** The kinds that hold something a bundle would carry (the user's presets or changed built-ins), with their counts. */
async function exportableKinds(app) {
  const out = [];
  for (const kind of managerKinds()) {
    await app.presets.ready(kind);
    const n = app.presets.list(kind).filter((p) => !p.builtin || p.modified).length;
    if (n) out.push({ kind, count: n });
  }
  return out;
}

/** The settings patch of BUNDLE_SETTINGS keys the app has. */
function currentSettings(app) {
  const out = {};
  for (const k of BUNDLE_SETTINGS) if (app.settings?.[k] !== undefined) out[k] = app.settings[k];
  return out;
}

/** Writes a bundle of `kinds` (default: every kind) and, with settings, the BUNDLE_SETTINGS keys. → the bytes. */
export async function exportBundleBytes(app, { kinds = null, settings = true } = {}) {
  return writeBundle({
    ready: (k) => app.presets.ready(k),
    list: (k) => app.presets.list(k),
    groups: (k) => app.presets.groups(k),
    readBlob: (k, n) => app.presets.readBlob(k, n),
  }, { kinds: kinds ?? managerKinds(), settings: settings ? currentSettings(app) : null });
}

/** Export Presets: a .pigment-bundle at `path` (or chosen in the save dialog). Returns the path or null. */
export async function exportPresetsBundle(app, { path = null, kinds = null, settings = true } = {}) {
  const { bridge } = await import('./bridge.js');
  const target = path ?? await bridge.saveFileDialog({ title: 'Export Presets', defaultPath: `Pigment Presets.${BUNDLE_EXTENSION}`, filters: [{ name: 'Pigment Bundle', extensions: [BUNDLE_EXTENSION] }] });
  if (!target) return null;
  const file = new RegExp(`\\.${BUNDLE_EXTENSION}$`, 'i').test(target) ? target : `${target}.${BUNDLE_EXTENSION}`;
  try {
    const bytes = await busy(app, 'Exporting presets…', () => exportBundleBytes(app, { kinds, settings }));
    await bridge.writeFile(file, bytes);
    app.dialogs?.toast?.('Exported the presets', { kind: 'success', timeout: 2000 });
    return file;
  } catch (err) {
    app.reportError?.(err, 'Could not export the presets');
    return null;
  }
}

/**
 * Import Presets: the kinds of a bundle (all, or `kinds`) and, with settings, its settings (one saveSettingsSoon, then
 * "Restart Pigment to apply the imported settings"). → { added, report, settings: boolean }.
 */
export async function importPresetsBundle(app, { path = null, bytes = null, kinds = null, settings = true, name = null } = {}) {
  const { bridge } = await import('./bridge.js');
  let data = bytes;
  if (!data) {
    try {
      if (typeof window !== 'undefined' && window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
      data = await bridge.readFile(path);
    } catch (err) {
      const report = [`${lastName(path)}: ${err?.message ?? err}`];
      app.dialogs?.alert?.('No presets were imported', { title: 'Import Presets', detail: report.join('\n') });
      return { added: {}, report, settings: false };
    }
  }
  const fileName = name ?? (lastName(path) || `presets.${BUNDLE_EXTENSION}`);
  const run = async () => {
    const res = await withBundleKinds(kinds ?? Object.keys((await readBundle(data)).kinds ?? {}), () => importPresetBytes(app, [{ name: /\.pigment-bundle$/i.test(fileName) ? fileName : `${fileName}.${BUNDLE_EXTENSION}`, bytes: data }]));
    let applied = false;
    if (settings) {
      const parsed = await readBundle(data);
      const patch = bundleSettingsPatch(parsed.settings);
      if (patch) {
        app.saveSettingsSoon?.(patch);
        applied = true;
      }
    }
    return { ...res, settings: applied };
  };
  const res = await busy(app, 'Importing presets…', run);
  const counts = Object.entries(res.added).filter(([, n]) => n > 0);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  if (total) app.dialogs?.toast?.(`Imported ${plural(total, 'preset')}: ${counts.map(([k, n]) => `${kindTitle(k)} ${n}`).join(', ')}`, { kind: 'success', timeout: 3000 });
  if (res.settings) app.dialogs?.alert?.('Restart Pigment to apply the imported settings', { title: 'Import Presets', detail: res.report.join('\n') || undefined });
  else if (res.report.length) app.dialogs?.alert?.(total ? 'Some presets were not imported' : 'No presets were imported', { title: 'Import Presets', detail: res.report.join('\n') });
  return res;
}

function checkList(rows) {
  const box = document.createElement('div');
  box.className = 'pm-checks';
  for (const r of rows) {
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox" checked> <span></span>';
    label.querySelector('input').dataset.key = r.key;
    label.querySelector('span').textContent = r.label;
    box.appendChild(label);
  }
  return box;
}
const checked = (box) => [...box.querySelectorAll('input:checked')].map((i) => i.dataset.key);

/** The Export/Import Presets dialog (two tabs, as Photoshop's). */
export async function exportImportDialog(app) {
  const root = document.createElement('div');
  root.className = 'pm-exim';
  root.innerHTML = `
    <div class="pm-tabs" role="tablist">
      <button class="seg-button active" type="button" role="tab" data-tab="export">Export Presets</button>
      <button class="seg-button" type="button" role="tab" data-tab="import">Import Presets</button>
    </div>
    <div class="pm-pane" data-pane="export">
      <p class="muted">Your own presets (and the built-ins you changed) of the types ticked, in one file. Use it to move them to another computer or keep a copy.</p>
      <div class="pm-export-kinds"></div>
      <div class="pm-row"><button class="btn primary" type="button" data-act="export">Export Presets…</button></div>
    </div>
    <div class="pm-pane" data-pane="import" hidden>
      <p class="muted">Presets and settings from a Pigment bundle (.pigment-bundle).</p>
      <div class="pm-row"><button class="btn" type="button" data-act="choose">Choose File…</button> <span class="pm-file muted">No file chosen</span></div>
      <div class="pm-import-kinds"></div>
      <div class="pm-row"><button class="btn primary" type="button" data-act="import" disabled>Import Presets</button></div>
    </div>`;
  const tabs = root.querySelectorAll('[data-tab]');
  for (const t of tabs) {
    t.addEventListener('click', () => {
      for (const x of tabs) x.classList.toggle('active', x === t);
      for (const p of root.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== t.dataset.tab;
    });
  }
  const exportable = await exportableKinds(app);
  const exportBox = checkList([
    ...exportable.map(({ kind, count }) => ({ key: kind, label: `${kindTitle(kind)} (${count})` })),
    { key: '$settings', label: `Settings: ${BUNDLE_SETTINGS.map((k) => SETTINGS_LABELS[k] ?? k).join(', ')}` },
  ]);
  root.querySelector('.pm-export-kinds').appendChild(exportBox);
  root.querySelector('[data-act="export"]').addEventListener('click', async () => {
    const keys = checked(exportBox);
    const kinds = keys.filter((k) => k !== '$settings');
    await exportPresetsBundle(app, { kinds, settings: keys.includes('$settings') });
  });
  let chosen = null;
  let importBox = null;
  root.querySelector('[data-act="choose"]').addEventListener('click', async () => {
    const { bridge } = await import('./bridge.js');
    const picked = await bridge.openFileDialog({ title: 'Import Presets', filters: [{ name: 'Pigment Bundle', extensions: [BUNDLE_EXTENSION] }] });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      if (window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
      const bytes = await bridge.readFile(path);
      const parsed = await readBundle(bytes);
      chosen = { path, bytes };
      root.querySelector('.pm-file').textContent = lastName(path);
      const rows = Object.entries(parsed.kinds).filter(([k]) => presetKind(k)).map(([k, v]) => ({ key: k, label: `${kindTitle(k)} (${Array.isArray(v?.items) ? v.items.length : 0})` }));
      if (bundleSettingsPatch(parsed.settings)) rows.push({ key: '$settings', label: `Settings: ${Object.keys(bundleSettingsPatch(parsed.settings)).map((k) => SETTINGS_LABELS[k] ?? k).join(', ')}` });
      importBox = checkList(rows);
      root.querySelector('.pm-import-kinds').replaceChildren(importBox);
      if (!rows.length) root.querySelector('.pm-import-kinds').textContent = parsed.report[0] ?? 'The file holds no presets';
      root.querySelector('[data-act="import"]').disabled = !rows.length;
    } catch (err) {
      app.reportError?.(err, 'Could not read the file');
    }
  });
  root.querySelector('[data-act="import"]').addEventListener('click', async () => {
    if (!chosen || !importBox) return;
    const keys = checked(importBox);
    await importPresetsBundle(app, { path: chosen.path, bytes: chosen.bytes, kinds: keys.filter((k) => k !== '$settings'), settings: keys.includes('$settings') });
  });
  return app.dialogs.open({ title: 'Export/Import Presets', content: root, width: 520, className: 'preset-manager-dialog', buttons: [{ label: 'Done', value: true, primary: true }] });
}

// ---- Migrate Presets -------------------------------------------------------------------------------------------------

/** Migrate Presets from `path`: a .pigment-bundle (its presets and settings) or an older Pigment's presets folder. */
export async function migrateFrom(app, path) {
  const { bridge } = await import('./bridge.js');
  if (new RegExp(`\\.${BUNDLE_EXTENSION}$`, 'i').test(path)) return importPresetsBundle(app, { path, settings: true });
  const run = async () => {
    const { bytes, report, found } = await folderBundle(bridge, path, managerKinds());
    if (!found) return { added: {}, report: report.length ? report : [`${lastName(path) || path}: no Pigment presets were found in this folder`], settings: false };
    const res = await withBundleKinds(null, () => importPresetBytes(app, [{ name: `${lastName(path) || 'presets'}.${BUNDLE_EXTENSION}`, bytes }]));
    return { ...res, report: [...report, ...res.report], settings: false };
  };
  const res = await busy(app, 'Migrating presets…', run);
  const total = Object.values(res.added).reduce((s, n) => s + n, 0);
  if (total) app.dialogs?.toast?.(`Migrated ${plural(total, 'preset')}`, { kind: 'success', timeout: 3000 });
  if (res.report.length || !total) app.dialogs?.alert?.(total ? 'Some presets were not migrated' : 'No presets were migrated', { title: 'Migrate Presets', detail: res.report.join('\n') || 'Every preset of the folder is already in the library.' });
  return res;
}

/** The Migrate Presets dialog: choose a bundle or a folder. */
export async function migrateDialog(app) {
  const { bridge } = await import('./bridge.js');
  const choice = await app.dialogs.open({
    title: 'Migrate Presets',
    content: '<p>Bring presets from an older Pigment: choose a Pigment bundle it exported (Edit &gt; Presets &gt; Export/Import Presets), or its presets folder (the <code>presets</code> folder in its settings folder).</p><p class="muted">Presets already in your library are not added again.</p>',
    width: 480,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Choose Folder…', value: 'folder' }, { label: 'Choose Bundle…', value: 'bundle', primary: true }],
  });
  if (!choice) return null;
  let path = null;
  if (choice === 'bundle') {
    const picked = await bridge.openFileDialog({ title: 'Migrate Presets', filters: [{ name: 'Pigment Bundle', extensions: [BUNDLE_EXTENSION] }] });
    path = Array.isArray(picked) ? picked[0] : picked;
  } else {
    path = await bridge.openDirectoryDialog({ title: 'Migrate Presets' });
  }
  if (!path) return null;
  return migrateFrom(app, path);
}

// ---- install --------------------------------------------------------------------------------------------------------

export function install(app) {
  registerSwatchFormats();
  registerPatFormat();
  registerGrdFormat();
  registerCshFormat();
  registerAslFormat(app);
  registerTplFormat(app);
  registerBundleFormat(app);

  app.commands.register('edit:preset-manager', {
    label: 'Preset Manager…',
    record: false,
    enabled: () => !!app.presets,
    run: (arg) => {
      presetManagerDialog(app, { kind: typeof arg === 'string' ? arg : arg?.kind ?? null });
    },
  });
  app.commands.register('edit:export-import-presets', {
    label: 'Export/Import Presets…',
    record: false,
    enabled: () => !!app.presets,
    run: (arg) => {
      if (isObject(arg) && arg.mode === 'export') return exportPresetsBundle(app, { path: arg.path ?? null, kinds: Array.isArray(arg.kinds) ? arg.kinds : null, settings: arg.settings !== false });
      if (isObject(arg) && arg.mode === 'import' && arg.path) return importPresetsBundle(app, { path: arg.path, kinds: Array.isArray(arg.kinds) ? arg.kinds : null, settings: arg.settings !== false });
      exportImportDialog(app);
      return undefined;
    },
  });
  app.commands.register('edit:migrate-presets', {
    label: 'Migrate Presets',
    record: false,
    enabled: () => !!app.presets,
    run: (arg) => {
      if (typeof arg === 'string' || (isObject(arg) && arg.path)) return migrateFrom(app, typeof arg === 'string' ? arg : arg.path);
      migrateDialog(app);
      return undefined;
    },
  });
}
