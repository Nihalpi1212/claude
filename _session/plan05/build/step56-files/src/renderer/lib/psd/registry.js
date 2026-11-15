// The PSD mapper registries (ARCHITECTURE.md "0.5 features", S4.2), skeleton file; no package edits it. The PSD
// reader (read.js) and writer (write.js) are loops over what is registered here: layer kinds (which record or layer
// a layer becomes), aspects (what every layer carries), document resources, ag-psd options and notices. 0.4's mapping
// is registered by builtin.js and the stub mapper files; psd-layers and psd-text register from their own files.
//
// Rules: the same id registered twice, the later wins; a `{ builtin: true }` registration never replaces one made
// before it (so a package's file may load before or after builtin.js). Node-safe.

const kinds = [];
const aspects = [];
const resources = [];
const optionHooks = [];
const notices = new Map(); // code -> { code, when, text, timeout, order }
const featureSets = []; // the PSD_FEATURES objects of the mapper files

function place(list, def, builtin, what) {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error(`${what} needs an id`);
  if (!Number.isFinite(def.order)) throw new Error(`${what} ${def.id} needs a numeric order`);
  const at = list.findIndex((d) => d.id === def.id);
  if (at >= 0) {
    if (builtin) return () => {};
    list.splice(at, 1);
  }
  const entry = { ...def, builtin: !!builtin };
  list.push(entry);
  // stable by order: registrations with the same order keep their registration order
  list.sort((a, b) => a.order - b.order);
  return () => {
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
  };
}

const builtinOf = (def, opts) => !!(opts?.builtin ?? def?.builtin);

/**
 * A layer kind: `test(pl, ctx)` / `read(pl, ctx) → Layer` on open (the first kind by order whose test passes builds
 * the layer), `match(layer, ctx)` / `write(layer, ctx) → record | null` on save (the first kind whose match passes and
 * whose write returns a record writes it; null declines, and the next kind is asked). Returns an unregister function.
 */
export const registerPsdLayerKind = (def, opts) => place(kinds, def, builtinOf(def, opts), 'registerPsdLayerKind');

/** An aspect of every layer: `read(pl, layer, ctx)`, `write(layer, rec, ctx)`, by order (a group's after its children). */
export const registerPsdAspect = (def, opts) => place(aspects, def, builtinOf(def, opts), 'registerPsdAspect');

/** A document-level resource: `read(psd, doc, ctx)`, `write(doc, psd, ctx)`; order < 500 runs before the layers. */
export const registerPsdResource = (def, opts) => place(resources, def, builtinOf(def, opts), 'registerPsdResource');

/** ag-psd options: `read(opts) → opts` for readPsd, `write(opts) → opts` for writePsd, in registration order. */
export function registerPsdOptions(def) {
  if (!def || (typeof def.read !== 'function' && typeof def.write !== 'function')) throw new Error('registerPsdOptions needs read() or write()');
  optionHooks.push(def);
  return () => {
    const i = optionHooks.indexOf(def);
    if (i >= 0) optionHooks.splice(i, 1);
  };
}

/**
 * A notice: `when` 'save' (a toast after writePsdDocument, one per code) or 'open' (a line of `doc.openNotices`, shown
 * by documents.js after the document opens); `text(count, details)` gives the line. The same code again: the later
 * wins (a builtin never replaces an earlier one). Notices are shown in registration order.
 */
export function registerPsdNotice(code, def, opts) {
  if (!code || typeof def?.text !== 'function') throw new Error('registerPsdNotice needs a code and text()');
  const builtin = builtinOf(def, opts);
  const prev = notices.get(code);
  if (prev && builtin) return () => {};
  const entry = { code, when: def.when === 'open' ? 'open' : 'save', text: def.text, timeout: def.timeout ?? 4000, order: prev?.order ?? notices.size, builtin };
  notices.set(code, entry);
  return () => {
    if (notices.get(code) === entry) notices.delete(code);
  };
}

/**
 * Declares a mapper file's PSD_FEATURES flags (S15): `{ effects: false, … }`. psdFeatures() merges every file's flags;
 * a flag is true when any file says true.
 */
export function registerPsdFeatures(flags) {
  if (flags && typeof flags === 'object') featureSets.push(flags);
}

/** The merged PSD_FEATURES flags of the mapper files: what psd-layers and psd-text have landed (S15). */
export function psdFeatures() {
  const out = {};
  for (const set of featureSets) for (const [k, v] of Object.entries(set)) out[k] = out[k] === true || v === true;
  return out;
}

/** The registered kinds, aspects and resources, in order (read.js and write.js loop over them). */
export const psdLayerKinds = () => kinds.slice();
export const psdAspects = () => aspects.slice();
export const psdResources = () => resources.slice();
export const psdNotice = (code) => notices.get(code) ?? null;
export const psdNotices = () => [...notices.values()].sort((a, b) => a.order - b.order);

/** ag-psd options after every registered hook of that direction. */
export function psdOptions(direction, base) {
  let opts = { ...base };
  for (const h of optionHooks) {
    const fn = direction === 'read' ? h.read : h.write;
    if (typeof fn !== 'function') continue;
    const next = fn({ ...opts });
    if (next && typeof next === 'object') opts = next;
  }
  return opts;
}
