// Export/Import Presets (S10.7): the .pigment-bundle file, every kind's presets, groups and side files, plus the plain
// settings keys of BUNDLE_SETTINGS (preset-formats.js). preset-files-manager's file; pure and Node-safe (the bridge and
// the dialogs are preset-manager.js's).
//
// The file is a ZIP (shared/zip.js): `bundle.json` = { format: 'pigment-bundle', version: 1, created, kinds: { [kind]:
// { kindVersion, groups: [{ id, name, parent }], items: [{ id, name, group, data }] } }, settings?: { [key]: value } }
// and `blobs/<kind>/<name>` for the side files blobRefs names. A bundle holds the user's presets and the built-ins
// they changed; the built-ins every Pigment has are not repeated.
//
// Importing (the format's read, S10.1): items go to their kinds through the skeleton's importer (groups, side files).
// Side files whose names are not content hashes (pattern pixels) get fresh names, so a preset imported twice never
// shares a file another preset deletes; a preset the library already holds (same kind, name and data) is skipped, so
// importing a bundle again, or migrating twice, adds nothing. Settings are applied only by Edit > Presets > Export/
// Import Presets and Migrate Presets (importBundleSettings), never by opening or dropping the file.
//
//   writeBundle(source, { kinds, settings }) → Uint8Array     source: { list(kind), groups(kind), readBlob(kind, name) }
//   readBundle(bytes) → { kinds, settings, blobs: Map('kind/name' → bytes), report }
//   bundleItems(parsed, { kinds, existing }) → { items, groups, report }   the format's read over a parsed bundle
//   bundleSettingsPatch(settings) → the patch of BUNDLE_SETTINGS keys a bundle carries
//   registerBundleFormat(app) → unregister
import { writeZip, readZip, streamCodecs, findEntry } from '../../../shared/zip.js';
import { BUNDLE_SETTINGS, blobRefs, registerPresetFileFormat } from '../preset-formats.js';
import { presetKind, presetKinds, BLOB_NAME_RE } from '../presets.js';
import { tooLarge, asBytes, baseName } from './bytes.js';

export const BUNDLE_FORMAT = 'pigment-bundle';
export const BUNDLE_EXTENSION = 'pigment-bundle';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const clone = (v) => JSON.parse(JSON.stringify(v));
// content-addressed side files (tip-<sha1>.png, icc-<sha1>.icc, font-<sha1>.ttf …) keep their names on import
const HASHED = /-[0-9a-f]{40}\.[a-z0-9]+$/i;

/** The presets of a kind a bundle carries: the user's own and the built-ins they changed. */
const carried = (list) => list.filter((p) => !p.builtin || p.modified);

/**
 * The bundle's bytes. `kinds` (default: every registered kind) picks the kinds, `settings` (an object or null) the
 * settings to carry (only BUNDLE_SETTINGS keys are written).
 */
export async function writeBundle(source, { kinds = null, settings = null } = {}) {
  const manifest = { format: BUNDLE_FORMAT, version: 1, created: new Date().toISOString(), kinds: {} };
  const files = [];
  const seen = new Set();
  for (const kind of kinds ?? presetKinds()) {
    const def = presetKind(kind);
    if (!def) continue;
    await source.ready?.(kind);
    const presets = carried(source.list(kind) ?? []);
    if (!presets.length) continue;
    const used = new Set(presets.map((p) => p.group).filter(Boolean));
    const all = source.groups?.(kind) ?? [];
    // a group's parents come with it
    for (let changed = true; changed;) {
      changed = false;
      for (const g of all) if (used.has(g.id) && g.parent && !used.has(g.parent)) {
        used.add(g.parent);
        changed = true;
      }
    }
    manifest.kinds[kind] = {
      kindVersion: def.version ?? 1,
      groups: all.filter((g) => used.has(g.id) && !g.builtin).map((g) => ({ id: g.id, name: g.name, parent: g.parent ?? null })),
      items: presets.map((p) => ({ id: p.id, name: p.name, group: p.group ?? null, data: clone(p.data) })),
    };
    for (const p of presets) {
      for (const ref of blobRefs(kind, p.data)) {
        const key = `${ref.kind}/${ref.name}`;
        if (seen.has(key) || !BLOB_NAME_RE.test(ref.name)) continue;
        seen.add(key);
        const bytes = await Promise.resolve(source.readBlob(ref.kind, ref.name)).catch(() => null);
        if (bytes?.length) files.push({ name: `blobs/${key}`, data: asBytes(bytes), compress: true });
      }
    }
  }
  if (isObject(settings)) {
    const carriedSettings = {};
    for (const k of BUNDLE_SETTINGS) if (settings[k] !== undefined) carriedSettings[k] = clone(settings[k]);
    if (Object.keys(carriedSettings).length) manifest.settings = carriedSettings;
  }
  return writeZip([{ name: 'bundle.json', data: enc(JSON.stringify(manifest)), compress: true }, ...files], { deflate: streamCodecs.deflate });
}

/** A bundle's contents: { kinds, settings, blobs, report }. Never throws (a damaged bundle reports and gives nothing). */
export async function readBundle(input) {
  const bytes = asBytes(input);
  const out = { kinds: {}, settings: null, blobs: new Map(), report: [] };
  const big = tooLarge(bytes);
  if (big) {
    out.report.push(big);
    return out;
  }
  let entries;
  try {
    entries = await readZip(bytes, { inflate: streamCodecs.inflate });
  } catch (err) {
    out.report.push(`not a Pigment bundle, or a damaged one (${err?.message ?? err})`);
    return out;
  }
  const main = findEntry(entries, 'bundle.json');
  let json = null;
  try {
    json = main ? JSON.parse(dec(main.data)) : null;
  } catch {
    json = null;
  }
  if (!json || json.format !== BUNDLE_FORMAT || !isObject(json.kinds)) {
    out.report.push('not a Pigment bundle (bundle.json is missing or damaged)');
    return out;
  }
  if (json.version > 1) out.report.push(`the bundle was written by a later Pigment (version ${json.version}): what this one knows is read`);
  for (const e of entries) {
    const m = /^blobs\/([^/]+)\/([^/]+)$/.exec(e.name);
    if (m && BLOB_NAME_RE.test(m[2])) out.blobs.set(`${m[1]}/${m[2]}`, e.data);
  }
  out.kinds = json.kinds;
  out.settings = isObject(json.settings) ? json.settings : null;
  return out;
}

/** Every string in v equal to a key of `names` replaced by its value (deep; a copy). */
function renameStrings(v, names) {
  if (typeof v === 'string') return names.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => renameStrings(x, names));
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renameStrings(x, names)]));
}

/** The data as the kind stores it (its normalize), or the data itself. */
function normalized(kind, data) {
  try {
    const def = presetKind(kind);
    const n = def?.normalize ? def.normalize(clone(data), { version: def.version }) : data;
    return n ?? data;
  } catch {
    return data;
  }
}

/** The data of a preset with its side file names masked, for the "already in the library" test. */
function fingerprint(kind, name, data) {
  const d = normalized(kind, data);
  const masked = new Map(blobRefs(kind, d).map((r) => [r.name, '<blob>']));
  return `${kind}|${name}|${JSON.stringify(renameStrings(d, masked))}`;
}

const fresh = (name) => {
  const ext = /\.[a-z0-9]+$/i.exec(name)?.[0] ?? '';
  return `b-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}${ext}`;
};

/**
 * The format's read over a parsed bundle (S10.1's { items, groups, report }). `kinds` keeps only those kinds;
 * `existing(kind)` lists the presets the library already holds (they are skipped when the bundle repeats them).
 */
export function bundleItems(parsed, { kinds = null, existing = null } = {}) {
  const items = [];
  const groups = [];
  const report = [...(parsed?.report ?? [])];
  let skipped = 0;
  for (const [kind, entry] of Object.entries(parsed?.kinds ?? {})) {
    if (kinds && !kinds.includes(kind)) continue;
    if (!presetKind(kind)) {
      report.push(`the bundle's ${kind} presets were skipped: this Pigment has no presets of that kind`);
      continue;
    }
    const have = new Set((existing?.(kind) ?? []).map((p) => fingerprint(kind, p.name, p.data)));
    const kept = [];
    for (const it of Array.isArray(entry?.items) ? entry.items : []) {
      if (!isObject(it) || it.data === undefined) continue;
      if (have.has(fingerprint(kind, it.name, it.data))) {
        skipped++;
        continue;
      }
      const refs = blobRefs(kind, it.data);
      const names = new Map();
      const blobs = {};
      for (const r of refs) {
        const bytes = parsed.blobs.get(`${r.kind}/${r.name}`);
        if (!bytes) {
          report.push(`"${it.name}": its side file ${r.name} is missing from the bundle`);
          continue;
        }
        const target = HASHED.test(r.name) ? r.name : fresh(r.name);
        if (target !== r.name) names.set(r.name, target);
        blobs[target] = bytes;
      }
      const data = names.size ? renameStrings(it.data, names) : it.data;
      kept.push({ kind, name: String(it.name ?? 'Preset'), group: it.group ?? null, data, ...(Object.keys(blobs).length ? { blobs } : {}) });
    }
    // only the groups that hold something imported (and their parents)
    const list = Array.isArray(entry?.groups) ? entry.groups.filter((g) => isObject(g) && typeof g.id === 'string') : [];
    const used = new Set(kept.map((it) => it.group).filter(Boolean));
    for (let changed = true; changed;) {
      changed = false;
      for (const g of list) if (used.has(g.id) && g.parent && !used.has(g.parent) && list.some((x) => x.id === g.parent)) {
        used.add(g.parent);
        changed = true;
      }
    }
    const known = new Set(list.map((g) => g.id));
    for (const g of list) if (used.has(g.id)) groups.push({ kind, id: g.id, name: String(g.name ?? 'Group'), parent: g.parent && known.has(g.parent) ? g.parent : null });
    // an item of a built-in group (the bundle carries only user groups) goes to the top level
    for (const it of kept) if (it.group && !known.has(it.group)) it.group = null;
    items.push(...kept);
  }
  if (skipped) report.push(`${skipped} ${skipped === 1 ? 'preset was' : 'presets were'} already in the library and ${skipped === 1 ? 'was' : 'were'} skipped`);
  return { items, groups, report };
}

/** The settings patch a bundle carries (BUNDLE_SETTINGS keys only), or null. */
export function bundleSettingsPatch(settings) {
  if (!isObject(settings)) return null;
  const patch = {};
  for (const k of BUNDLE_SETTINGS) if (settings[k] !== undefined) patch[k] = clone(settings[k]);
  return Object.keys(patch).length ? patch : null;
}

// the kinds the next read keeps (Export/Import Presets imports the kinds the user ticked through the skeleton's
// importer, which gives a format no options)
let nextFilter = null;
/** Runs fn with the bundle read limited to `kinds` (the import dialog's choice). */
export async function withBundleKinds(kinds, fn) {
  const prev = nextFilter;
  nextFilter = Array.isArray(kinds) ? kinds.slice() : null;
  try {
    return await fn();
  } finally {
    nextFilter = prev;
  }
}

/** Registers .pigment-bundle (every kind) with the preset files of S10.1. Returns the unregister function. */
export function registerBundleFormat(app) {
  return registerPresetFileFormat({
    id: BUNDLE_FORMAT,
    name: 'Pigment Bundle',
    extensions: [BUNDLE_EXTENSION],
    kinds: ['*'],
    async read(bytes, ctx = {}) {
      const parsed = await readBundle(bytes);
      const kinds = Object.keys(parsed.kinds ?? {}).filter((k) => !nextFilter || nextFilter.includes(k));
      for (const k of kinds) if (presetKind(k)) await app?.presets?.ready?.(k);
      const res = bundleItems(parsed, { kinds: nextFilter, existing: (k) => app?.presets?.list?.(k) ?? [] });
      if (parsed.settings && !nextFilter) res.report.push('The bundle also holds settings: Edit > Presets > Export/Import Presets imports them');
      res.report = res.report.map((l) => `${baseName(ctx.name, 'Bundle')}: ${l}`);
      return res;
    },
    async write(selection, ctx) {
      // a bundle of the presets given (an Export Selected… of one panel): no settings
      const byKind = new Map((selection ?? []).map((s) => [s.kind, s.presets ?? []]));
      return writeBundle({
        list: (kind) => (byKind.get(kind) ?? []).map((p) => ({ ...p, builtin: false })),
        groups: (kind) => app?.presets?.groups?.(kind) ?? [],
        readBlob: (kind, name) => ctx.readBlob(kind, name),
      }, { kinds: [...byKind.keys()] });
    },
  });
}
