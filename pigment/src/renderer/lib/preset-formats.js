// Preset files (ARCHITECTURE.md "0.5 features", S10): every format that reads or writes presets, from both registries,
// and the import, export, opening and dropping of preset files. Skeleton file; packages register formats here
// (registerPresetFileFormat) or with 0.4's registerPresetFormat (presets.js, C), never edit this file.
//
// Two registries. A one-kind format a 0.4 panel imports registers with 0.4's registerPresetFormat(kind, fmt), so that
// panel's Import, app.presets.importFile and presetFormats(kind) list it with no panel edit (.pat, .grd, .aco / .ase,
// .csh). A format with several kinds, with blobs of another kind, or with no store kind registers here (.abr, .asl,
// .tpl, .pigment-bundle, .acb, .cube, .kys, .atn). presetFileFormats() lists both as one shape:
//   { id, name, extensions: string[] (no dot), kinds: string[] ('*' = every kind), store: boolean, read?, write?,
//     import?, def }  (`store`: a format of 0.4's registry, read and written through app.presets; `def`: the
//   registered object)
//
// Links between the items of one file: an item may carry a file-local `ref`, and its data may hold
// { $presetRef: { kind, ref } } anywhere; the importer adds the referenced items first and puts { presetId, name } in
// the placeholder's place. An item's blobs go to the kind blobRefs(kind, data) names for them, else to the item's kind.
//
// Node-safe: the file dialogs and file reads import the bridge only when they run.
import { presetFormats, presetKind, presetKinds, BLOB_NAME_RE, FILE_FORMAT } from './presets.js';
import { blobsOf } from './brush/preset.js';
import { OPEN_EXTENSIONS } from './io.js';

/** The plain settings keys an Export/Import Presets bundle carries (S10.7; review decision 14). */
export const BUNDLE_SETTINGS = Object.freeze(['tools', 'brushes', 'painting', 'colorUI', 'typeFonts', 'keymap']);

const FILE_FORMATS = new Map(); // id -> def (registerPresetFileFormat)
const BLOB_REFS = new Map(); // kind -> fn(data) -> { kind, name }[]

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const extList = (exts) => (Array.isArray(exts) ? exts : []).map((e) => String(e).replace(/^\./, '').toLowerCase()).filter(Boolean);
const lastName = (path) => String(path ?? '').split(/[\\/]/).pop();

/**
 * Registers (or re-registers: the same id, the later wins) a preset file format of several kinds, of blobs of another
 * kind, or of no store kind (S10.1). read(bytes, { name }) → { items: { kind, ref?, name, group?, data, blobs? }[],
 * groups?: { kind, id, name, parent? }[], report: string[] }; write(selection: { kind, presets }[], { readBlob(kind,
 * name) }) → Uint8Array; import(app, bytes, { name }) → { added: number, report } for formats outside the preset store.
 */
export function registerPresetFileFormat(def) {
  if (!def?.id || !Array.isArray(def.extensions) || !def.extensions.length) throw new Error('registerPresetFileFormat needs an id and extensions');
  if (typeof def.read !== 'function' && typeof def.write !== 'function' && typeof def.import !== 'function') throw new Error(`Preset file format ${def.id} needs read, write or import`);
  FILE_FORMATS.set(def.id, def);
  return () => {
    if (FILE_FORMATS.get(def.id) === def) FILE_FORMATS.delete(def.id);
  };
}

function wrapFile(def) {
  return {
    id: def.id,
    name: def.name ?? def.id,
    extensions: extList(def.extensions),
    kinds: Array.isArray(def.kinds) && def.kinds.length ? def.kinds.slice() : [],
    store: false,
    read: typeof def.read === 'function' ? def.read : null,
    write: typeof def.write === 'function' ? def.write : null,
    import: typeof def.import === 'function' ? def.import : null,
    def,
  };
}

function wrapStore(fmt, kind) {
  return {
    id: fmt.id,
    name: fmt.name ?? fmt.id,
    extensions: extList(fmt.extensions),
    kinds: [kind],
    store: true,
    read: typeof fmt.read === 'function' ? fmt.read : null,
    write: typeof fmt.write === 'function' ? fmt.write : null,
    import: null,
    def: fmt,
  };
}

/** Every format of both registries: this registry's, then 0.4's per kind, then 0.4's '*' (.pigment-presets) last. */
function allFormats() {
  const star = presetFormats('*');
  const starSet = new Set(star);
  const out = [...FILE_FORMATS.values()].map(wrapFile);
  for (const kind of presetKinds()) {
    for (const fmt of presetFormats(kind)) {
      // a kind's own variant of the store's file (patterns renames its pixel files) is the '*' format's file type:
      // listed once, as '*'; app.presets reads and writes it with the kind's variant
      if (starSet.has(fmt) || fmt.id === 'pigment-presets') continue;
      out.push(wrapStore(fmt, kind));
    }
  }
  const seen = new Set();
  for (const fmt of star) {
    if (seen.has(fmt)) continue; // presetFormats('*') lists the '*' formats twice
    seen.add(fmt);
    out.push(wrapStore(fmt, '*'));
  }
  return out;
}

const forKind = (f, kind) => f.kinds.includes(kind) || f.kinds.includes('*');
const isStar = (f) => f.kinds.includes('*');

/**
 * The formats of both registries, kind formats first and '*' formats (.pigment-presets) last; `kind` keeps those that
 * hold that kind, `write: true` those that write.
 */
export function presetFileFormats({ kind, write } = {}) {
  let list = allFormats();
  if (kind) list = list.filter((f) => forKind(f, kind));
  if (write) list = list.filter((f) => typeof f.write === 'function');
  return [...list.filter((f) => !isStar(f)), ...list.filter((f) => isStar(f) && !f.store), ...list.filter((f) => isStar(f) && f.store)];
}

/** The registered extension a file name ends with (the longest that matches: 'pigment-presets', not 'presets'). */
function extensionOf(name, formats) {
  const s = String(name ?? '').toLowerCase();
  let best = '';
  for (const f of formats) for (const e of f.extensions) if (e.length > best.length && (s === e || s.endsWith(`.${e}`))) best = e;
  return best;
}

/**
 * The format that reads a file of this name or extension, from both registries, or null. A `.pigment-presets` file
 * goes to the store's own format (it names its kind inside); `kinds` prefers the formats of those kinds.
 */
export function presetFileFormatFor(nameOrExt, { kinds = null } = {}) {
  const formats = allFormats().filter((f) => f.read || f.import);
  const ext = extensionOf(nameOrExt, formats);
  if (!ext) return null;
  const matching = formats.filter((f) => f.extensions.includes(ext));
  const storeStar = matching.find((f) => f.store && isStar(f));
  if (storeStar) return storeStar;
  if (Array.isArray(kinds) && kinds.length) {
    const preferred = matching.find((f) => kinds.some((k) => forKind(f, k)));
    if (preferred) return preferred;
  }
  return matching[0] ?? null;
}

/**
 * True when Open and drop send this file to importPresetFiles (S10.4): a preset file format reads its extension and
 * no open format does. Extra (not in S10): documents.js and app.js share the test.
 */
export function opensAsPresets(path) {
  const fmt = presetFileFormatFor(lastName(path));
  if (!fmt) return false;
  const ext = extensionOf(lastName(path), [fmt]);
  return !OPEN_EXTENSIONS.includes(ext);
}

/** The extensions of every preset file format that reads (the Open dialog's "Presets" filter, S10.4). */
export function presetFileExtensions({ kinds = null } = {}) {
  const formats = allFormats().filter((f) => (f.read || f.import) && (!kinds?.length || kinds.some((k) => forKind(f, k))));
  return [...new Set(formats.flatMap((f) => f.extensions))];
}

// ---- blob references --------------------------------------------------------------------------------------------

/** The blobs a preset of `kind` names, and the kind that keeps each (S10.1): fn(data) → { kind, name }[]. */
export function registerBlobRefs(kind, fn) {
  if (typeof fn === 'function') BLOB_REFS.set(kind, fn);
  else BLOB_REFS.delete(kind);
}

/** The blobs a preset's data names: the registered function's answer, else the kind's own blobs(data). */
export function blobRefs(kind, data) {
  try {
    const fn = BLOB_REFS.get(kind);
    if (fn) return (fn(data) ?? []).filter((r) => r && typeof r.name === 'string' && typeof r.kind === 'string');
    const names = presetKind(kind)?.blobs?.(data) ?? [];
    return names.filter((n) => typeof n === 'string').map((name) => ({ kind, name }));
  } catch {
    return [];
  }
}

/**
 * start(): the skeleton's blob references (`brushes`: the preset's sample tips; `tool-presets`: the tips of its brush,
 * kept in `brushes`). A package that re-registers one later wins.
 */
export function installPresetFormats(app) {
  void app;
  registerBlobRefs('brushes', (data) => (isObject(data) ? blobsOf(data) : []).map((name) => ({ kind: 'brushes', name })));
  registerBlobRefs('tool-presets', (data) => (isObject(data?.brush) ? blobsOf(data.brush) : []).map((name) => ({ kind: 'brushes', name })));
}

// ---- bytes ----------------------------------------------------------------------------------------------------------

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kindTitle = (kind) => presetKind(kind)?.title ?? kind;

// ---- import (S10.2) -----------------------------------------------------------------------------------------------

/** Replaces every { $presetRef: { kind, ref } } in data by resolve(kind, ref) (deep; a copy). */
function resolveRefs(data, resolve) {
  if (Array.isArray(data)) return data.map((v) => resolveRefs(v, resolve));
  if (!isObject(data)) return data;
  if (isObject(data.$presetRef) && Object.keys(data).length === 1) return resolve(String(data.$presetRef.kind ?? ''), String(data.$presetRef.ref ?? ''));
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, resolveRefs(v, resolve)]));
}

/** A .pigment-presets file: its kind's store import, plus its `extraBlobs` (S10.3). */
async function importStoreFile(app, bytes, name, added, report) {
  let json;
  try {
    json = JSON.parse(dec(bytes));
  } catch {
    report.push(`${name}: not a Pigment presets file`);
    return;
  }
  const kind = typeof json?.kind === 'string' ? json.kind : '';
  if (json?.format !== FILE_FORMAT || !kind || !presetKind(kind)) {
    report.push(`${name}: ${kind ? `Pigment has no presets of kind "${kind}"` : 'not a Pigment presets file'}`);
    return;
  }
  await app.presets.ready(kind);
  for (const [blobKind, blobs] of Object.entries(isObject(json.extraBlobs) ? json.extraBlobs : {})) {
    if (!presetKind(blobKind) || !isObject(blobs)) continue;
    for (const [blobName, b64] of Object.entries(blobs)) {
      if (!BLOB_NAME_RE.test(blobName) || typeof b64 !== 'string') continue;
      try {
        await app.presets.writeBlob(blobKind, blobName, fromBase64(b64));
      } catch {
        report.push(`${name}: the side file ${blobName} could not be stored`);
      }
    }
  }
  const res = await app.presets.importFile(kind, bytes, { name });
  added[kind] = (added[kind] ?? 0) + (res.added?.length ?? 0);
  report.push(...(res.report ?? []));
}

/** A file of this registry's `read`: groups, linked items in dependency order, blobs to their kinds. */
async function importItems(app, res, name, added, report) {
  report.push(...(Array.isArray(res?.report) ? res.report : []));
  const items = (Array.isArray(res?.items) ? res.items : []).filter((it) => isObject(it));
  const kinds = new Set();
  for (const it of items) {
    if (presetKind(it.kind)) kinds.add(it.kind);
    else report.push(`${name}: skipped "${it.name ?? '?'}": Pigment has no presets of kind "${it.kind}"`);
  }
  for (const kind of kinds) await app.presets.ready(kind);
  // groups: parents first; a group whose parent never appears goes to the top level
  const groupIds = new Map(); // `${kind}|${file id}` -> store group id
  let pendingGroups = (Array.isArray(res?.groups) ? res.groups : []).filter((g) => isObject(g) && kinds.has(g.kind));
  while (pendingGroups.length) {
    const ready = pendingGroups.filter((g) => !g.parent || groupIds.has(`${g.kind}|${g.parent}`) || !pendingGroups.some((o) => o !== g && o.kind === g.kind && o.id === g.parent));
    const batch = ready.length ? ready : pendingGroups;
    for (const g of batch) {
      const parent = g.parent ? groupIds.get(`${g.kind}|${g.parent}`) ?? null : null;
      groupIds.set(`${g.kind}|${g.id}`, app.presets.addGroup(g.kind, { name: String(g.name ?? 'Group'), parent }).id);
    }
    pendingGroups = pendingGroups.filter((g) => !batch.includes(g));
  }
  const byRef = new Map();
  for (const it of items) if (typeof it.ref === 'string' && it.ref) byRef.set(`${it.kind}|${it.ref}`, it);
  const done = new Map(); // item -> preset | null
  const busy = new Set();
  const add = async (it) => {
    if (done.has(it)) return done.get(it);
    if (busy.has(it) || !kinds.has(it.kind)) return null; // a cycle, or a kind Pigment lacks
    busy.add(it);
    let preset = null;
    try {
      const wanted = [];
      resolveRefs(it.data, (kind, ref) => {
        wanted.push([kind, ref]);
        return null;
      });
      const resolved = new Map();
      for (const [kind, ref] of wanted) {
        const target = byRef.get(`${kind}|${ref}`);
        const p = target ? await add(target) : null;
        if (!p) report.push(`${name}: "${it.name ?? '?'}" refers to a ${kind} preset the file does not hold`);
        resolved.set(`${kind}|${ref}`, p ? { presetId: p.id, name: p.name } : null);
      }
      const data = resolveRefs(it.data, (kind, ref) => resolved.get(`${kind}|${ref}`) ?? null);
      const refs = blobRefs(it.kind, data);
      for (const [blobName, bytes] of Object.entries(isObject(it.blobs) ? it.blobs : {})) {
        if (!BLOB_NAME_RE.test(blobName) || !(bytes instanceof Uint8Array)) {
          report.push(`${name}: skipped the side file ${blobName}`);
          continue;
        }
        let blobKind = refs.find((r) => r.name === blobName)?.kind ?? it.kind;
        if (!presetKind(blobKind)) blobKind = it.kind;
        await app.presets.writeBlob(blobKind, blobName, bytes);
      }
      const group = it.group != null ? groupIds.get(`${it.kind}|${it.group}`) ?? null : null;
      try {
        preset = app.presets.add(it.kind, { name: String(it.name ?? 'Preset'), data, group });
        added[it.kind] = (added[it.kind] ?? 0) + 1;
      } catch {
        report.push(`${name}: skipped "${it.name ?? '?'}": its data is not valid`);
      }
    } finally {
      busy.delete(it);
    }
    done.set(it, preset);
    return preset;
  };
  for (const it of items) await add(it);
}

/**
 * Imports preset files given as bytes (extra, not in S10.2: importPresetFiles reads the files and calls it; Node tests
 * call it directly): [{ name, bytes }] → { added: { [kind]: number }, report }. Never throws.
 */
export async function importPresetBytes(app, files, { kinds = null } = {}) {
  const added = {};
  const report = [];
  for (const { name: rawName, bytes } of files ?? []) {
    const name = lastName(rawName);
    try {
      const fmt = presetFileFormatFor(name, { kinds });
      if (!fmt) {
        report.push(`${name}: no preset format reads this file`);
        continue;
      }
      if (fmt.store && isStar(fmt)) await importStoreFile(app, bytes, name, added, report);
      else if (fmt.store) {
        const kind = fmt.kinds[0];
        await app.presets.ready(kind);
        const res = await app.presets.importFile(kind, bytes, { name });
        added[kind] = (added[kind] ?? 0) + (res.added?.length ?? 0);
        report.push(...(res.report ?? []));
      } else if (fmt.import) {
        const res = await fmt.import(app, bytes, { name });
        const key = fmt.kinds.find((k) => k !== '*') ?? fmt.id;
        added[key] = (added[key] ?? 0) + (Number(res?.added) || 0);
        report.push(...(Array.isArray(res?.report) ? res.report : []));
      } else if (fmt.read) {
        await importItems(app, await fmt.read(bytes, { name }), name, added, report);
      }
    } catch (err) {
      report.push(`${name}: ${err?.message ?? err}`);
    }
  }
  return { added, report };
}

/**
 * Import… (S10.2): without paths the open dialog, filtered by the registered extensions (all, or those of `kinds`);
 * each file to its format, its items to their kinds. A toast lists what was added, a dialog the report.
 */
export async function importPresetFiles(app, { paths = null, kinds = null } = {}) {
  const { bridge } = await import('./bridge.js');
  let list = Array.isArray(paths) ? paths : paths ? [paths] : null;
  if (!list) {
    const picked = await bridge.openFileDialog({ title: 'Import Presets', multiple: true, filters: [{ name: 'Presets', extensions: presetFileExtensions({ kinds }) }] });
    list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  }
  if (!list.length) return { added: {}, report: [] };
  const files = [];
  const report = [];
  for (const path of list) {
    try {
      if (typeof window !== 'undefined' && window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
      files.push({ name: lastName(path), bytes: await bridge.readFile(path) });
    } catch (err) {
      report.push(`${lastName(path)}: ${err?.message ?? err}`);
    }
  }
  const res = await importPresetBytes(app, files, { kinds });
  res.report.unshift(...report);
  const counts = Object.entries(res.added).filter(([, n]) => n > 0);
  if (counts.length) {
    const total = counts.reduce((s, [, n]) => s + n, 0);
    app.dialogs?.toast?.(`Imported ${plural(total, 'preset')}: ${counts.map(([k, n]) => `${kindTitle(k)} ${n}`).join(', ')}`, { kind: 'success', timeout: 3000 });
  }
  if (res.report.length) app.dialogs?.alert?.(counts.length ? 'Some presets were not imported' : 'No presets were imported', { title: 'Import Presets', detail: res.report.join('\n') });
  return res;
}

/** The popover items of a panel menu: Import…, Export Selected…, Export All… (S10.2). */
export function presetFileMenuItems(app, kind, { selectedIds = [] } = {}) {
  const ids = Array.isArray(selectedIds) ? selectedIds.filter(Boolean) : [];
  return [
    { label: 'Import…', onSelect: () => importPresetFiles(app, { kinds: [kind] }) },
    { label: 'Export Selected…', disabled: !ids.length, onSelect: () => ids.length && exportPresetsDialog(app, kind, ids) },
    { label: 'Export All…', onSelect: () => exportPresetsDialog(app, kind, null) },
  ];
}

// ---- export (S10.3) -----------------------------------------------------------------------------------------------

/** The formats Export offers for a kind: every one that writes it, `.pigment-presets` first (0.4's default). */
function exportFormats(kind) {
  const list = presetFileFormats({ kind, write: true });
  const own = list.filter((f) => f.store && isStar(f));
  return [...own, ...list.filter((f) => !own.includes(f))];
}

/**
 * The bytes of an export (extra, not in S10.3: exportPresetsDialog calls it; Node tests call it directly):
 * { bytes, ext }. `format` is a format of presetFileFormats or its id. A `.pigment-presets` file is the store's JSON
 * plus `extraBlobs` for the blobs blobRefs names in other kinds (0.4 readers ignore the key).
 */
export async function exportPresetBytes(app, kind, ids = null, format = 'pigment-presets') {
  const fmt = typeof format === 'string' ? exportFormats(kind).find((f) => f.id === format) : format;
  if (!fmt?.write) throw new Error(`No format writes ${kindTitle(kind)} presets`);
  await app.presets.ready(kind);
  const ext = fmt.extensions[0] ?? '';
  if (fmt.store) {
    const out = await app.presets.exportFile(kind, ids, fmt.id);
    if (!isStar(fmt)) return { bytes: out.bytes, ext };
    const want = ids ? new Set(ids) : null;
    const extra = {};
    for (const p of app.presets.list(kind).filter((x) => !want || want.has(x.id))) {
      for (const r of blobRefs(kind, p.data)) {
        if (r.kind === kind || extra[r.kind]?.[r.name] || !presetKind(r.kind)) continue;
        const b = await app.presets.readBlob(r.kind, r.name).catch(() => null);
        if (b) (extra[r.kind] ??= {})[r.name] = toBase64(b instanceof Uint8Array ? b : new Uint8Array(b));
      }
    }
    if (!Object.keys(extra).length) return { bytes: out.bytes, ext }; // 0.4's bytes exactly
    const json = JSON.parse(dec(out.bytes));
    json.extraBlobs = extra;
    return { bytes: enc(JSON.stringify(json)), ext };
  }
  const want = ids ? new Set(ids) : null;
  const presets = app.presets.list(kind).filter((p) => !want || want.has(p.id));
  const bytes = await fmt.write([{ kind, presets }], { readBlob: (k, n) => app.presets.readBlob(k, n) });
  return { bytes, ext };
}

/**
 * Export Selected… / Export All… (S10.3): the save dialog offers every format that writes `kind`, `.pigment-presets`
 * first; the typed extension picks the format (none: `.pigment-presets`, added to the name). `path` (extra) skips the
 * dialog, as 0.4's exportPresets(app, ids, path) did. Returns the written path or null.
 */
export async function exportPresetsDialog(app, kind, ids = null, { title = null, path = null, defaultName = null } = {}) {
  const { bridge } = await import('./bridge.js');
  const formats = exportFormats(kind);
  if (!formats.length) return null;
  const label = kindTitle(kind);
  const target = path ?? await bridge.saveFileDialog({
    title: title ?? `Export ${label}`,
    defaultPath: `${defaultName ?? label}.${formats[0].extensions[0]}`,
    filters: formats.map((f) => ({ name: f.name, extensions: f.extensions })),
  });
  if (!target) return null;
  const ext = extensionOf(lastName(target), formats);
  const fmt = (ext && formats.find((f) => f.extensions.includes(ext))) || formats[0];
  try {
    const out = await exportPresetBytes(app, kind, ids, fmt);
    const file = ext && fmt.extensions.includes(ext) ? target : `${target}.${out.ext}`;
    await bridge.writeFile(file, out.bytes);
    app.dialogs?.toast?.(`Exported the ${label.toLowerCase()}`, { kind: 'success', timeout: 1800 });
    return file;
  } catch (err) {
    app.reportError?.(err, `Could not export the ${label.toLowerCase()}`);
    return null;
  }
}
