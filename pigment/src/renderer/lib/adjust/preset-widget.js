// The `preset` field widget (ARCHITECTURE.md "0.4 features", H; owned by adjust-tonal). It replaces the skeleton's
// stub: a menu of the presets of one preset-store kind (groups as option groups, Photoshop's "Default" and "Custom"
// entries) and an options menu with Save Preset…, Load Preset… / Save to File… through the kind's file formats
// (.alv, .acv, .pigment-presets…), Rename…, Delete Current Preset and Reset Presets…. The adjustment frame
// (lib/adjust/frame.js) shows it above every adjustment editor whose kind has presets; any form, panel or options
// bar may use it.
//
//   createWidget('preset', spec, { value, onInput, onChange, app })   value: a preset id or null ("Custom")
//   spec: { kind, onPick(preset), getData() (enables Save), defaults?() (adds "Default"), noneLabel?, defaultName?,
//           title? (file dialog titles), manage? (false: no options menu) }
//   widget: { element, get(), set(id, { silent }), setDisabled(b), destroy(), changed(data) }
// `changed(data)` tells the widget the edited settings: when they no longer equal the picked preset it shows
// "Custom" again (Photoshop's behaviour). onPick receives the preset (built-ins and user presets alike; "Default"
// passes { id: null, name: 'Default', data: spec.defaults() }).
//
// The options menu opens inline (a popover sits under a dialog's backdrop, H): `.preset-menu` with buttons
// `[data-act="save" | "load" | "export" | "rename" | "delete" | "reset"]`.
import { registerWidget } from '../fields.js';
import { presetFormats } from '../presets.js';
import { bridge } from '../bridge.js';
import { icon } from '../icons.js';

const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const DEFAULT_ID = '__default';

/** Stable JSON (sorted keys) for comparing settings with a preset's data. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** True when `data` (edited settings) still matches `preset` data on every key the preset sets. */
export function sameSettings(data, presetData) {
  if (!data || !presetData) return false;
  for (const k of Object.keys(presetData)) if (stable(data[k] ?? null) !== stable(presetData[k] ?? null)) return false;
  return true;
}

/** The extensions a kind's formats read, without dots. */
const extensionsOf = (kind) => [...new Set(presetFormats(kind).flatMap((f) => f.extensions ?? []).map((e) => e.replace(/^\./, '')))];

/**
 * Load Preset…: reads a preset file (path given, else a file dialog) into the kind's presets. Resolves with the
 * presets added (empty when nothing was read).
 */
export async function loadPresetFile(app, kind, path = null, { title = 'Load Preset' } = {}) {
  let file = path;
  if (!file) {
    const picked = await bridge.openFileDialog({ title, filters: [{ name: 'Presets', extensions: extensionsOf(kind) }] });
    file = Array.isArray(picked) ? picked[0] : picked;
  }
  if (!file) return [];
  try {
    const bytes = await bridge.readFile(file);
    const res = await app.presets.importFile(kind, bytes, { name: String(file).split(/[\\/]/).pop() });
    if (res.report?.length) app.dialogs.toast(res.report.join(' · '), { kind: res.added.length ? 'info' : 'error', timeout: 5000 });
    return res.added;
  } catch (err) {
    app.reportError?.(err, 'Could not load the preset');
    return [];
  }
}

/**
 * Save to File…: writes settings (not a stored preset) in the kind's own format (.alv, .acv), else a stored preset
 * through the first format that writes. Resolves with the file written, or null.
 */
export async function savePresetFile(app, kind, { data = null, presetId = null, name = 'Preset', path = null, title = 'Save Preset' } = {}) {
  const formats = presetFormats(kind);
  const own = data ? formats.find((f) => typeof f.writeParams === 'function') : null;
  const fmt = own ?? formats.find((f) => typeof f.write === 'function');
  if (!fmt) return null;
  const ext = String(fmt.extensions?.[0] ?? 'preset').replace(/^\./, '');
  const target = path ?? await bridge.saveFileDialog({ title, defaultPath: `${name}.${ext}`, filters: [{ name: fmt.name, extensions: [ext] }] });
  if (!target) return null;
  try {
    let bytes;
    if (own) bytes = own.writeParams(clone(data));
    else {
      let id = presetId;
      if (!id && data) {
        // a store format writes stored presets: write the settings through a preset that is removed again
        await app.presets.ready(kind);
        id = app.presets.add(kind, { name, data: clone(data) }).id;
        try {
          bytes = (await app.presets.exportFile(kind, [id], fmt.id)).bytes;
        } finally {
          app.presets.remove(kind, id);
        }
      } else bytes = (await app.presets.exportFile(kind, id ? [id] : null, fmt.id)).bytes;
    }
    const file = new RegExp(`\\.${ext}$`, 'i').test(target) ? target : `${target}.${ext}`;
    await bridge.writeFile(file, bytes);
    app.dialogs.toast('Saved the preset', { kind: 'success', timeout: 1800 });
    return file;
  } catch (err) {
    app.reportError?.(err, 'Could not save the preset');
    return null;
  }
}

export function presetWidget(spec = {}, { value = null, onInput = () => {}, onChange = () => {}, app = null } = {}) {
  const kind = spec.kind ?? '';
  let current = value ?? null;
  const wrap = document.createElement('span');
  wrap.className = 'field-preset preset-widget';
  const select = document.createElement('select');
  select.className = 'select';
  select.dataset.presetKind = kind;
  select.title = 'Preset';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'pbtn preset-more';
  more.title = 'Preset options';
  more.setAttribute('aria-expanded', 'false');
  more.innerHTML = icon('more');
  if (!more.innerHTML.trim()) more.textContent = '⋯';
  const menu = document.createElement('div');
  menu.className = 'preset-menu';
  menu.hidden = true;
  wrap.append(select, ...(spec.manage === false ? [] : [more]));
  if (spec.manage !== false) wrap.appendChild(menu);

  const store = () => app?.presets ?? null;
  const list = () => {
    try {
      return store()?.list?.(kind) ?? [];
    } catch {
      return [];
    }
  };
  const groups = () => {
    try {
      return store()?.groups?.(kind) ?? [];
    } catch {
      return [];
    }
  };
  const fill = () => {
    select.replaceChildren(new Option(spec.noneLabel ?? 'Custom', ''));
    if (typeof spec.defaults === 'function') select.add(new Option('Default', DEFAULT_ID));
    const all = list();
    const byGroup = new Map();
    for (const p of all) {
      const g = p.group ?? null;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    }
    for (const p of byGroup.get(null) ?? []) select.add(new Option(p.name, p.id));
    for (const g of groups()) {
      const items = byGroup.get(g.id);
      if (!items?.length) continue;
      const og = document.createElement('optgroup');
      og.label = g.name;
      for (const p of items) og.appendChild(new Option(p.name, p.id));
      select.appendChild(og);
    }
    select.value = current ?? '';
    if (select.value !== (current ?? '')) select.value = '';
    syncMenu();
  };

  const emit = () => {
    onInput(current);
    onChange(current);
  };
  const pick = (id) => {
    current = id || null;
    if (id === DEFAULT_ID) spec.onPick?.({ id: null, name: 'Default', data: clone(spec.defaults()), builtin: true });
    else {
      const preset = current ? store()?.get?.(kind, current) : null;
      if (preset) spec.onPick?.(preset);
    }
    fill();
    emit();
  };
  select.addEventListener('change', () => pick(select.value));

  // ---- the options menu (inline)
  const item = (act, label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset-menu-item';
    b.dataset.act = act;
    b.textContent = label;
    b.addEventListener('click', async () => {
      closeMenu();
      try {
        await fn();
      } catch (err) {
        app?.reportError?.(err, `${label.replace(/…$/, '')} failed`);
      }
    });
    menu.appendChild(b);
    return b;
  };
  const selectedPreset = () => (current && current !== DEFAULT_ID ? store()?.get?.(kind, current) ?? null : null);
  const save = item('save', 'Save Preset…', async () => {
    if (!store() || typeof spec.getData !== 'function') return;
    const name = await app.dialogs.prompt('Name', { title: 'Save Preset', value: spec.defaultName ?? 'Preset' });
    if (!name?.trim()) return;
    await store().ready(kind); // editing before the user file is read would overwrite it (presets.js)
    const preset = store().add(kind, { name: name.trim(), data: clone(spec.getData()) });
    current = preset.id;
    fill();
    emit();
  });
  const load = item('load', 'Load Preset…', async () => {
    if (!store()) return;
    await store().ready(kind);
    const added = await loadPresetFile(app, kind, null, { title: spec.title ? `Load ${spec.title} Preset` : 'Load Preset' });
    if (added.length) pick(added[0].id);
  });
  const exportBtn = item('export', 'Save to File…', async () => {
    if (!store() || typeof spec.getData !== 'function') return;
    await savePresetFile(app, kind, { data: spec.getData(), name: selectedPreset()?.name ?? spec.defaultName ?? 'Preset', title: spec.title ? `Save ${spec.title} Preset` : 'Save Preset' });
  });
  const rename = item('rename', 'Rename Preset…', async () => {
    const p = selectedPreset();
    if (!p) return;
    const name = await app.dialogs.prompt('Name', { title: 'Rename Preset', value: p.name });
    if (!name?.trim()) return;
    await store().ready(kind);
    store().update(kind, p.id, { name: name.trim() });
    fill();
  });
  const del = item('delete', 'Delete Current Preset', async () => {
    const p = selectedPreset();
    if (!p) return;
    const ok = await app.dialogs.confirm(`Delete the preset “${p.name}”?`, { title: 'Delete Preset', okLabel: 'Delete', danger: true });
    if (!ok) return;
    await store().ready(kind);
    store().remove(kind, p.id);
    current = null;
    fill();
    emit();
  });
  const reset = item('reset', 'Reset Presets…', async () => {
    const ok = await app.dialogs.confirm('Replace the presets with the built-in ones?', { title: 'Reset Presets', detail: 'Presets you saved are removed.', okLabel: 'Reset' });
    if (!ok) return;
    await store().ready(kind);
    store().reset(kind);
    current = null;
    fill();
    emit();
  });
  function syncMenu() {
    const canSave = typeof spec.getData === 'function' && !!store();
    save.hidden = !canSave;
    exportBtn.hidden = !canSave || !presetFormats(kind).some((f) => typeof f.writeParams === 'function' || typeof f.write === 'function');
    load.hidden = !store() || !extensionsOf(kind).length;
    const sel = selectedPreset();
    rename.disabled = del.disabled = !sel;
    reset.hidden = !store();
  }
  function closeMenu() {
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
  }
  // a click elsewhere closes the menu (listening only while it is open)
  const onDocDown = (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) closeMenu();
  };
  more.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    more.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) {
      syncMenu();
      document.addEventListener('pointerdown', onDocDown, true);
    } else document.removeEventListener('pointerdown', onDocDown, true);
  });

  // the kind's file loads once; until then list() gives the built-ins (an unknown kind has no presets)
  fill();
  try {
    store()?.ready?.(kind)?.then(fill).catch(() => {});
  } catch {
    /* not a registered kind */
  }
  // follows changes made elsewhere (another dialog, the Adjustments panel); a widget whose element left the page
  // stops listening (forms do not always destroy their widgets)
  let attached = false;
  const onPresets = (e) => {
    if (wrap.isConnected) attached = true;
    else if (attached) return off?.();
    if (!e || e.kind === kind) fill();
  };
  const off = app?.on?.('presets:changed', onPresets);

  return {
    element: wrap,
    get: () => (current === DEFAULT_ID ? null : current),
    set(v, { silent = true } = {}) {
      current = v ?? null;
      fill();
      if (!silent) emit();
    },
    setDisabled(b) {
      select.disabled = more.disabled = !!b;
      if (b) closeMenu();
    },
    /** The edited settings: "Custom" again once they differ from the picked preset. */
    changed(data) {
      if (!current) return;
      const preset = current === DEFAULT_ID ? { data: spec.defaults?.() } : store()?.get?.(kind, current);
      if (!preset || !sameSettings(data, preset.data)) {
        current = null;
        select.value = '';
        syncMenu();
      }
    },
    destroy() {
      document.removeEventListener('pointerdown', onDocDown, true);
      if (typeof off === 'function') off();
      wrap.remove();
    },
  };
}

registerWidget('preset', (spec, opts) => presetWidget(spec, opts));
