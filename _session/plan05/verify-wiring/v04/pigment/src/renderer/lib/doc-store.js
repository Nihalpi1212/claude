// Document store (ARCHITECTURE.md "0.4 features", D): history-aware document-level collections
// saved in .pigment (guides, the ruler origin; later comps, slices, notes, samplers ...). Pure: it
// reaches history through doc.history.push and the listeners through doc.changed, so Node unit
// tests run it with a fake document. Owned by the skeleton.
//
// Values handed out are frozen (a mutation throws instead of corrupting the store and its history
// entries, which share them). Collections nobody registered (a newer file opened here) are kept as
// their JSON and written back unchanged; a later registerCollection() of that name takes them over.

/** @typedef {{ kind: 'list' | 'value', version: number, initial(): any, normalize(v: any): any,
 *   transform?(current: any, m: number[], spec: object): any, save?: boolean,
 *   read?(json: any, info: { version: number }): any, write?(value: any): any, label?: string }} CollectionSpec */

const COLLECTIONS = new Map();
const MERGE_MS = 1500;

let nextId = 1;
/** Same shape as document.js newId (this module stays free of DOM imports). */
const newId = (prefix = 'S') => `${prefix}${(nextId++).toString(36)}${Date.now().toString(36).slice(-3)}`;

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
}

const jsonClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Registers a collection. The same name registered twice: the later registration wins.
 * @param {string} name
 * @param {CollectionSpec} spec
 */
export function registerCollection(name, spec) {
  COLLECTIONS.set(name, { save: true, ...spec });
}

/** The registered spec of a collection, or null. */
export function collectionSpec(name) {
  return COLLECTIONS.get(name) ?? null;
}

/** Names of the registered collections. */
export function collections() {
  return [...COLLECTIONS.keys()];
}

function specOf(name) {
  const spec = COLLECTIONS.get(name);
  if (!spec) throw new Error(`Unknown document collection: ${name}`);
  return spec;
}

/** A collection value in its stored form: list items normalised (ids added, nulls dropped), frozen. */
function clean(spec, value) {
  if (spec.kind === 'list') {
    const out = [];
    for (const item of Array.isArray(value) ? value : []) {
      const n = spec.normalize(item);
      if (n === null || n === undefined) continue;
      out.push(n && typeof n === 'object' && !n.id ? { id: newId('S'), ...n } : n);
    }
    return freezeDeep(out);
  }
  const n = spec.normalize(value);
  return freezeDeep(n === null || n === undefined ? spec.initial() : n);
}

export class DocStore {
  /**
   * @param {{ history?: { push(entry: object): object, entries?: object[], index?: number, merge?(redo: Function): object }, changed?(kind: string, detail?: object): void }} doc
   * @param {{ clock?: () => number }} [opts]
   */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.data = new Map(); // name -> frozen value (registered collections)
    this.raw = new Map(); // name -> { v, data } as read (collections nobody registered)
    this.clock = opts.clock ?? (() => Date.now());
    this.lastEntry = null; // { entry, name, at } of the last set() (merging)
  }

  /** Moves raw JSON of a collection registered since into its typed form. */
  adopt(name) {
    const spec = COLLECTIONS.get(name);
    if (!spec || !this.raw.has(name)) return;
    const json = this.raw.get(name);
    this.raw.delete(name);
    let value;
    try {
      value = spec.read ? spec.read(json?.data, { version: json?.v ?? spec.version }) : jsonClone(json?.data);
    } catch {
      value = spec.initial();
    }
    this.data.set(name, clean(spec, value));
  }

  ensure(name) {
    this.adopt(name);
    if (!this.data.has(name)) this.data.set(name, clean(specOf(name), specOf(name).initial()));
    return this.data.get(name);
  }

  /** The collection's value: a frozen array (list) or a frozen value. */
  get(name) {
    return this.ensure(name);
  }

  emit(name) {
    this.doc?.changed?.('store', { collection: name });
    if (name === 'guides') this.doc?.changed?.('guides');
  }

  assign(name, value) {
    this.data.set(name, value);
    this.emit(name);
  }

  /** Replaces a collection without history (inside another entry: structural(), remapDocument). */
  setRaw(name, next) {
    const spec = specOf(name);
    this.adopt(name);
    this.assign(name, clean(spec, next));
  }

  /**
   * Replaces a collection as one undoable entry. merge folds consecutive sets of the same
   * collection within 1.5 s into the first one's entry (guide drags).
   */
  set(name, next, { label, merge = false } = {}) {
    const spec = specOf(name);
    const before = this.ensure(name);
    const after = clean(spec, next);
    this.assign(name, after);
    const now = this.clock();
    const h = this.doc?.history;
    const last = this.lastEntry;
    const top = h?.entries ? h.entries[h.index] : last?.entry;
    if (merge && last && last.name === name && top === last.entry && now - last.at < MERGE_MS) {
      const redo = () => this.assign(name, after);
      if (h?.merge && h.entries) h.merge(redo);
      else {
        last.entry.redo = redo;
        last.entry.at = now;
      }
      last.at = now;
      return;
    }
    const entry = {
      label: label ?? spec.label ?? name,
      undo: () => this.assign(name, before),
      redo: () => this.assign(name, after),
      bytes: 0,
      at: now,
      mergeKey: `store:${name}`,
    };
    h?.push(entry);
    this.lastEntry = { entry, name, at: now };
  }

  /** Adds an item to a list collection; returns it as stored (with its id). */
  add(name, item, { label } = {}) {
    const spec = specOf(name);
    if (spec.kind !== 'list') throw new Error(`${name} is not a list`);
    const n = spec.normalize(item);
    if (n === null || n === undefined) return null;
    const stored = freezeDeep(n && typeof n === 'object' && !n.id ? { id: newId('S'), ...n } : n);
    this.set(name, [...this.ensure(name), stored], { label: label ?? `New ${spec.label ?? name}` });
    return stored;
  }

  /** Patches the list item with that id (a field set to undefined is removed). */
  update(name, id, patch, { label, merge = false } = {}) {
    const cur = this.ensure(name);
    if (!cur.some((it) => it?.id === id)) return;
    const next = cur.map((it) => {
      if (it?.id !== id) return it;
      const out = { ...it, ...patch, id };
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
      return out;
    });
    this.set(name, next, { label: label ?? `Edit ${specOf(name).label ?? name}`, merge });
  }

  /** Removes the list items with these ids. */
  remove(name, ids, { label } = {}) {
    const drop = new Set(Array.isArray(ids) ? ids : [ids]);
    const cur = this.ensure(name);
    if (!cur.some((it) => drop.has(it?.id))) return;
    this.set(name, cur.filter((it) => !drop.has(it?.id)), { label: label ?? `Delete ${specOf(name).label ?? name}` });
  }

  /** Every collection as it is (values are frozen, so the snapshot shares them). */
  snapshot() {
    return { data: new Map(this.data), raw: new Map(this.raw) };
  }

  restore(snap) {
    const names = new Set([...this.data.keys(), ...snap.data.keys()]);
    const old = this.data;
    this.data = new Map(snap.data);
    this.raw = new Map(snap.raw);
    for (const name of names) if (old.get(name) !== this.data.get(name)) this.emit(name);
  }

  /** Maps every collection that declares transform (old -> new document matrix); no history. */
  transformAll(m, spec) {
    for (const name of [...this.data.keys(), ...this.raw.keys()]) this.adopt(name);
    for (const [name, value] of [...this.data]) {
      const c = COLLECTIONS.get(name);
      if (!c?.transform) continue;
      const next = clean(c, c.transform(value, m, spec));
      if (next !== value) this.assign(name, next);
    }
  }

  /** A copy for another document (Image > Duplicate). */
  clone(doc) {
    const out = new DocStore(doc, { clock: this.clock });
    out.data = new Map(this.data);
    out.raw = new Map([...this.raw].map(([k, v]) => [k, jsonClone(v)]));
    return out;
  }

  /** { [name]: { v, data } } of every saved collection, unregistered ones verbatim. */
  toJSON() {
    const out = {};
    for (const [name, json] of this.raw) out[name] = jsonClone(json);
    for (const [name, value] of this.data) {
      const spec = COLLECTIONS.get(name);
      if (!spec || spec.save === false) continue;
      out[name] = { v: spec.version, data: spec.write ? spec.write(value) : jsonClone(value) };
    }
    return out;
  }

  /**
   * The store of a document read from .pigment: version 3 files carry `store`; a version 2 file's
   * top-level guides come in through legacy.guides (ids added).
   */
  static fromJSON(doc, json, legacy = {}) {
    const store = new DocStore(doc);
    if (json && typeof json === 'object') {
      for (const [name, entry] of Object.entries(json)) {
        store.raw.set(name, jsonClone(entry));
        store.adopt(name);
      }
    }
    if (!store.data.has('guides') && !store.raw.has('guides') && Array.isArray(legacy?.guides)) {
      store.data.set('guides', clean(specOf('guides'), legacy.guides));
    }
    return store;
  }
}

// ---- built-in collections ----------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A guide: { id, axis, pos, color?, artboard? }; optional fields only when set. */
function normalizeGuide(g) {
  if (!g || typeof g !== 'object') return null;
  if (g.axis !== 'x' && g.axis !== 'y') return null;
  if (!finite(g.pos)) return null;
  const out = {};
  if (typeof g.id === 'string' && g.id) out.id = g.id;
  out.axis = g.axis;
  out.pos = g.pos;
  if (typeof g.color === 'string' && HEX.test(g.color)) out.color = g.color.toLowerCase();
  if (typeof g.artboard === 'string' && g.artboard) out.artboard = g.artboard;
  return out;
}

/** 0.3's mapGuide (image-ops.js remapDocument): guides that become oblique are dropped. */
function transformGuides(list, m) {
  const out = [];
  for (const g of list) {
    const dir = g.axis === 'x' ? [m[2], m[3]] : [m[0], m[1]];
    if (Math.abs(dir[0]) > 1e-9 && Math.abs(dir[1]) > 1e-9) continue;
    const [px, py] = g.axis === 'x' ? [g.pos, 0] : [0, g.pos];
    const p = [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
    const axis = Math.abs(dir[0]) > Math.abs(dir[1]) ? 'y' : 'x';
    out.push({ ...g, axis, pos: Math.round((axis === 'x' ? p[0] : p[1]) * 100) / 100 });
  }
  return out;
}

registerCollection('guides', {
  kind: 'list',
  version: 1,
  label: 'Guide',
  initial: () => [],
  normalize: normalizeGuide,
  transform: transformGuides,
});

registerCollection('rulerOrigin', {
  kind: 'value',
  version: 1,
  label: 'Ruler Origin',
  initial: () => ({ x: 0, y: 0 }),
  normalize: (v) => (v && finite(v.x) && finite(v.y) ? { x: v.x, y: v.y } : null),
  transform: (v, m) => ({ x: m[0] * v.x + m[2] * v.y + m[4], y: m[1] * v.x + m[3] * v.y + m[5] }),
});
