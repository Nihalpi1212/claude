// Preset store (ARCHITECTURE.md "0.4 features", C): named presets per kind, in groups, kept as
// files under <userData>/presets/ (never in settings.json). The core is pure: a backend object is
// injected (Electron: the preload's pigment.presets.*, browser: IndexedDB, tests: memory), so Node
// unit tests run it. Owned by the skeleton; packages register kinds and formats, never edit it.
//
// Backend: { read(kind) -> object | null, write(kind, object | null) (null deletes the file),
//            readBlob(kind, name) -> Uint8Array | null, writeBlob(kind, name, bytes), removeBlob(kind, name) },
// every method may return a promise.
//
// File (<kind>.json): { format: 'pigment-presets', version: 1, kind, kindVersion, groups, items, hidden }:
// items keep the order, built-ins as { ref: id }, user presets and modified built-ins in full;
// groups hold user groups and built-in groups that were renamed or removed; hidden lists removed
// built-ins. Built-ins the file does not mention (added by a later release) are appended to their
// group on load. Nothing is written until something changes; writes are debounced per kind.

export const PRESET_KIND_RE = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/;
export const BLOB_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const FILE_FORMAT = 'pigment-presets';

const KINDS = new Map();
const FORMATS = new Map(); // kind | '*' -> Map(id -> format)
const STORES = new Set();

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o) && !ArrayBuffer.isView(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const randomId = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/**
 * Registers (or re-registers: the later wins) a preset kind.
 * @param {string} kind
 * @param {{ title: string, version: number, builtins(): { groups?: object[], presets: { id: string, name: string, group?: string, data: any }[] },
 *   normalize(data: any, info: { version: number }): any, thumbnail?(preset: object, size: number): any, blobs?(data: any): string[] }} def
 */
export function registerPresetKind(kind, def) {
  if (!PRESET_KIND_RE.test(kind)) throw new Error(`Invalid preset kind: ${kind}`);
  KINDS.set(kind, def);
  for (const store of STORES) store.kindChanged(kind);
}

export function presetKind(kind) {
  return KINDS.get(kind) ?? null;
}

export function presetKinds() {
  return [...KINDS.keys()];
}

/**
 * Registers a file format for a kind, or for every kind with '*'.
 * read(bytes, { name }) -> { presets: { name, group?, data }[], groups?: PresetGroup[], report: string[], blobs?: { [name]: Uint8Array } }
 * write?(presets, { kind, kindVersion, def, groups, readBlob(name) }) -> Uint8Array
 */
export function registerPresetFormat(kind, fmt) {
  if (!FORMATS.has(kind)) FORMATS.set(kind, new Map());
  FORMATS.get(kind).set(fmt.id, fmt);
}

export function presetFormats(kind) {
  return [...(FORMATS.get(kind)?.values() ?? []), ...(FORMATS.get('*')?.values() ?? [])];
}

function normalizeData(def, data, version) {
  try {
    const n = def.normalize ? def.normalize(clone(data), { version }) : clone(data);
    return n === undefined ? null : n;
  } catch {
    return null;
  }
}

function builtinsOf(def) {
  let b;
  try {
    b = def.builtins ? def.builtins() : null;
  } catch {
    b = null;
  }
  const groups = (Array.isArray(b?.groups) ? b.groups : []).map((g) => ({ id: g.id, name: g.name, parent: g.parent ?? null, builtin: true }));
  const presets = [];
  for (const p of Array.isArray(b?.presets) ? b.presets : []) {
    if (!p || typeof p.id !== 'string') continue;
    const data = normalizeData(def, p.data, def.version);
    if (data === null) continue;
    presets.push(freezeDeep({ id: p.id, name: String(p.name ?? p.id), group: p.group ?? null, data, builtin: true }));
  }
  return { groups, presets, byId: new Map(presets.map((p) => [p.id, p])) };
}

export class PresetStore extends EventTarget {
  /**
   * @param {{ backend: object, onWriteError?: (err: Error, info: { kind: string }) => void, delay?: number }} opts
   */
  constructor({ backend, onWriteError = null, delay = 300 } = {}) {
    super();
    this.backend = backend;
    this.onWriteError = onWriteError;
    this.delay = delay;
    this.states = new Map();
    STORES.add(this);
  }

  /** Stops listening to kind registrations (tests). */
  dispose() {
    STORES.delete(this);
    for (const s of this.states.values()) clearTimeout(s.timer);
  }

  state(kind) {
    const def = KINDS.get(kind);
    if (!def) throw new Error(`Unknown preset kind: ${kind}`);
    let s = this.states.get(kind);
    if (!s) {
      s = { kind, def: null, built: null, loaded: false, loading: null, order: [], hidden: new Set(), groups: [], dirty: false, timer: null, writing: null };
      this.states.set(kind, s);
    }
    if (s.def !== def) {
      s.def = def;
      s.built = builtinsOf(def);
      if (s.loaded) this.mergeBuiltins(s);
    }
    return s;
  }

  /** A kind was (re-)registered: its built-ins are read again (user entries kept). */
  kindChanged(kind) {
    if (this.states.has(kind)) this.state(kind);
  }

  emit(kind, reason, ids = []) {
    const ev = new Event('change');
    ev.detail = { kind, reason, ids };
    this.dispatchEvent(ev);
  }

  /** Loads the kind's file once. */
  ready(kind) {
    const s = this.state(kind);
    if (s.loaded) return Promise.resolve();
    if (!s.loading) {
      s.loading = (async () => {
        let file = null;
        try {
          file = await this.backend?.read?.(kind);
        } catch {
          file = null;
        }
        this.load(s, file);
        s.loaded = true;
        this.emit(kind, 'load', []);
      })();
    }
    return s.loading;
  }

  load(s, file) {
    s.order = [];
    s.hidden = new Set();
    s.groups = [];
    const def = s.def;
    const ok = file && typeof file === 'object' && file.format === FILE_FORMAT && (!file.kind || file.kind === s.kind) && Array.isArray(file.items);
    if (ok) {
      const version = Number.isFinite(file.kindVersion) ? file.kindVersion : def.version;
      for (const id of Array.isArray(file.hidden) ? file.hidden : []) if (typeof id === 'string') s.hidden.add(id);
      for (const g of Array.isArray(file.groups) ? file.groups : []) {
        if (g && typeof g.id === 'string') s.groups.push({ id: g.id, name: String(g.name ?? ''), parent: g.parent ?? null, builtin: !!g.builtin, ...(g.hidden ? { hidden: true } : {}) });
      }
      const seen = new Set();
      for (const it of file.items) {
        if (!it || typeof it !== 'object') continue;
        if (typeof it.ref === 'string') {
          if (seen.has(it.ref)) continue;
          seen.add(it.ref);
          s.order.push({ ref: it.ref });
          continue;
        }
        if (typeof it.id !== 'string' || seen.has(it.id)) continue;
        const data = normalizeData(def, it.data, version);
        if (data === null) continue;
        seen.add(it.id);
        const p = { id: it.id, name: String(it.name ?? ''), group: it.group ?? null, data, builtin: !!it.builtin };
        if (p.builtin) p.modified = true;
        s.order.push({ preset: freezeDeep(p) });
      }
    }
    this.mergeBuiltins(s);
  }

  /** Built-ins neither in the order nor hidden are appended after the last entry of their group. */
  mergeBuiltins(s) {
    const mentioned = new Set(s.order.map((e) => e.ref ?? e.preset.id));
    for (const b of s.built.presets) {
      if (mentioned.has(b.id) || s.hidden.has(b.id)) continue;
      let at = -1;
      s.order.forEach((e, i) => {
        if (this.entryPreset(s, e)?.group === b.group) at = i;
      });
      s.order.splice(at < 0 ? s.order.length : at + 1, 0, { ref: b.id });
    }
  }

  entryPreset(s, e) {
    if (e.preset) return e.preset;
    if (s.hidden.has(e.ref)) return null;
    return s.built.byId.get(e.ref) ?? null;
  }

  /** Presets in order (synchronous: the built-ins until ready() resolved); `group` filters. */
  list(kind, { group } = {}) {
    if (!KINDS.has(kind)) return [];
    const s = this.state(kind);
    const all = s.loaded ? s.order.map((e) => this.entryPreset(s, e)).filter(Boolean) : s.built.presets.slice();
    return group === undefined ? all : all.filter((p) => (p.group ?? null) === group);
  }

  groups(kind) {
    if (!KINDS.has(kind)) return [];
    const s = this.state(kind);
    const over = new Map(s.groups.map((g) => [g.id, g]));
    const out = [];
    for (const g of s.built.groups) {
      const o = over.get(g.id);
      if (o?.hidden) continue;
      out.push(o ? { ...g, name: o.name, parent: o.parent ?? g.parent } : { ...g });
    }
    const builtinIds = new Set(s.built.groups.map((g) => g.id));
    for (const g of s.groups) if (!builtinIds.has(g.id) && !g.hidden) out.push({ id: g.id, name: g.name, parent: g.parent ?? null, builtin: false });
    return out;
  }

  get(kind, id) {
    return this.list(kind).find((p) => p.id === id) ?? null;
  }

  changedState(s, reason, ids) {
    s.dirty = true;
    this.schedule(s);
    this.emit(s.kind, reason, ids);
  }

  requireLoaded(s) {
    // an edit before the user's file was read would overwrite it with the built-ins plus that edit: refuse it
    if (!s.loaded) throw new Error(`Presets of kind ${s.kind} are not loaded yet: await ready('${s.kind}') first`);
  }

  add(kind, { name, data, group = null } = {}) {
    const s = this.state(kind);
    this.requireLoaded(s);
    const d = normalizeData(s.def, data, s.def.version);
    if (d === null) throw new Error(`Invalid ${kind} preset data`);
    const p = freezeDeep({ id: randomId('u-'), name: String(name ?? 'Preset'), group: group ?? null, data: d, builtin: false });
    s.order.push({ preset: p });
    this.changedState(s, 'add', [p.id]);
    return p;
  }

  /** Updating a built-in stores a modified copy under its id. */
  update(kind, id, patch = {}) {
    const s = this.state(kind);
    this.requireLoaded(s);
    const i = s.order.findIndex((e) => (e.ref ?? e.preset.id) === id);
    if (i < 0) throw new Error(`No ${kind} preset ${id}`);
    const cur = this.entryPreset(s, s.order[i]);
    if (!cur) throw new Error(`No ${kind} preset ${id}`);
    const next = { ...cur };
    if (patch.name !== undefined) next.name = String(patch.name);
    if (patch.group !== undefined) next.group = patch.group ?? null;
    if (patch.data !== undefined) {
      const d = normalizeData(s.def, patch.data, s.def.version);
      if (d === null) throw new Error(`Invalid ${kind} preset data`);
      next.data = d;
    }
    if (cur.builtin) next.modified = true;
    s.order[i] = { preset: freezeDeep(next) };
    this.changedState(s, 'update', [id]);
    return s.order[i].preset;
  }

  /** Removes presets; a removed built-in is hidden (reset() brings it back). */
  remove(kind, ids) {
    const s = this.state(kind);
    this.requireLoaded(s);
    const drop = new Set(Array.isArray(ids) ? ids : [ids]);
    const removed = [];
    s.order = s.order.filter((e) => {
      const id = e.ref ?? e.preset.id;
      if (!drop.has(id)) return true;
      removed.push(id);
      if (s.built.byId.has(id)) s.hidden.add(id);
      return false;
    });
    if (removed.length) this.changedState(s, 'remove', removed);
  }

  /** Moves a preset into `group` (null: no group) at `index` among that group's presets. */
  move(kind, id, { group, index } = {}) {
    const s = this.state(kind);
    this.requireLoaded(s);
    const i = s.order.findIndex((e) => (e.ref ?? e.preset.id) === id);
    if (i < 0) return;
    let entry = s.order[i];
    const cur = this.entryPreset(s, entry);
    if (!cur) return;
    const target = group === undefined ? cur.group ?? null : group ?? null;
    if ((cur.group ?? null) !== target) {
      const next = { ...cur, group: target };
      if (cur.builtin) next.modified = true;
      entry = { preset: freezeDeep(next) };
    }
    s.order.splice(i, 1);
    const members = [];
    s.order.forEach((e, k) => {
      if ((this.entryPreset(s, e)?.group ?? null) === target) members.push(k);
    });
    const n = Number.isFinite(index) ? Math.max(0, Math.min(members.length, Math.trunc(index))) : members.length;
    const at = members.length === 0 ? s.order.length : n < members.length ? members[n] : members[members.length - 1] + 1;
    s.order.splice(at, 0, entry);
    this.changedState(s, 'move', [id]);
  }

  addGroup(kind, { name, parent = null } = {}) {
    const s = this.state(kind);
    this.requireLoaded(s);
    const g = { id: randomId('g-'), name: String(name ?? 'Group'), parent: parent ?? null, builtin: false };
    s.groups.push(g);
    this.changedState(s, 'group', [g.id]);
    return { ...g };
  }

  renameGroup(kind, id, name) {
    const s = this.state(kind);
    this.requireLoaded(s);
    const own = s.groups.find((g) => g.id === id);
    if (own) own.name = String(name);
    else {
      const b = s.built.groups.find((g) => g.id === id);
      if (!b) return;
      s.groups.push({ id, name: String(name), parent: b.parent, builtin: true });
    }
    this.changedState(s, 'group', [id]);
  }

  /** Removes a group; its presets move to the group's parent with keepPresets, else go too. */
  removeGroup(kind, id, { keepPresets = false } = {}) {
    const s = this.state(kind);
    this.requireLoaded(s);
    const all = this.groups(kind);
    const g = all.find((x) => x.id === id);
    if (!g) return;
    const parent = g.parent ?? null;
    // child groups move up
    for (const c of all) {
      if (c.parent !== id) continue;
      const own = s.groups.find((x) => x.id === c.id);
      if (own) own.parent = parent;
      else s.groups.push({ id: c.id, name: c.name, parent, builtin: true });
    }
    const members = this.list(kind, { group: id }).map((p) => p.id);
    if (keepPresets) {
      for (const pid of members) {
        const i = s.order.findIndex((e) => (e.ref ?? e.preset.id) === pid);
        const cur = this.entryPreset(s, s.order[i]);
        const next = { ...cur, group: parent };
        if (cur.builtin) next.modified = true;
        s.order[i] = { preset: freezeDeep(next) };
      }
    } else {
      for (const pid of members) if (s.built.byId.has(pid)) s.hidden.add(pid);
      const drop = new Set(members);
      s.order = s.order.filter((e) => !drop.has(e.ref ?? e.preset.id));
    }
    const own = s.groups.find((x) => x.id === id);
    if (g.builtin) {
      if (own) own.hidden = true;
      else s.groups.push({ id, name: g.name, parent, builtin: true, hidden: true });
    } else s.groups = s.groups.filter((x) => x.id !== id);
    this.changedState(s, 'group', [id, ...members]);
  }

  /** Back to the built-ins: the user file is deleted. */
  reset(kind) {
    const s = this.state(kind);
    clearTimeout(s.timer);
    s.timer = null;
    this.load(s, null);
    s.loaded = true;
    s.loading = Promise.resolve();
    s.dirty = false;
    s.writing = Promise.resolve(this.backend?.write?.(kind, null)).catch((err) => this.reportWriteError(err, kind));
    this.emit(kind, 'reset', []);
  }

  readBlob(kind, name) {
    if (!BLOB_NAME_RE.test(name)) return Promise.reject(new Error(`Invalid blob name: ${name}`));
    return Promise.resolve(this.backend?.readBlob?.(kind, name) ?? null);
  }

  async writeBlob(kind, name, bytes) {
    if (!BLOB_NAME_RE.test(name)) throw new Error(`Invalid blob name: ${name}`);
    try {
      await this.backend?.writeBlob?.(kind, name, bytes);
    } catch (err) {
      this.reportWriteError(err, kind);
      throw err;
    }
  }

  /** Imports a preset file; the format is chosen by the file name's extension. */
  async importFile(kind, bytes, { name = '' } = {}) {
    const s = this.state(kind);
    await this.ready(kind);
    const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();
    const fmt = presetFormats(kind).find((f) => (f.extensions ?? []).some((e) => e.replace(/^\./, '').toLowerCase() === ext));
    if (!fmt) return { added: [], report: [`No preset format reads .${ext || '?'} files for ${kind}`] };
    let res;
    try {
      res = await fmt.read(bytes, { name, kind });
    } catch (err) {
      return { added: [], report: [`The file could not be read: ${err?.message ?? err}`] };
    }
    const report = Array.isArray(res?.report) ? res.report.slice() : [];
    for (const [blobName, data] of Object.entries(res?.blobs ?? {})) {
      if (BLOB_NAME_RE.test(blobName)) await this.writeBlob(kind, blobName, data);
    }
    const groupMap = new Map();
    for (const g of Array.isArray(res?.groups) ? res.groups : []) {
      const ng = { id: randomId('g-'), name: String(g.name ?? 'Group'), parent: null, builtin: false };
      groupMap.set(g.id, ng);
      s.groups.push(ng);
    }
    for (const g of Array.isArray(res?.groups) ? res.groups : []) {
      if (g.parent && groupMap.has(g.parent)) groupMap.get(g.id).parent = groupMap.get(g.parent).id;
    }
    const added = [];
    for (const p of Array.isArray(res?.presets) ? res.presets : []) {
      const data = normalizeData(s.def, p.data, Number.isFinite(res?.kindVersion) ? res.kindVersion : s.def.version);
      if (data === null) {
        report.push(`Skipped "${p.name ?? '?'}": its data is not valid`);
        continue;
      }
      const preset = freezeDeep({ id: randomId('u-'), name: String(p.name ?? 'Preset'), group: p.group && groupMap.has(p.group) ? groupMap.get(p.group).id : null, data, builtin: false });
      s.order.push({ preset });
      added.push(preset);
    }
    if (added.length || groupMap.size) this.changedState(s, 'import', added.map((p) => p.id));
    return { added, report };
  }

  /** Exports presets through a format; returns the bytes and the file extension. */
  async exportFile(kind, ids, formatId) {
    const s = this.state(kind);
    await this.ready(kind);
    const fmt = presetFormats(kind).find((f) => f.id === formatId);
    if (!fmt?.write) throw new Error(`No format ${formatId} writes ${kind} presets`);
    const want = new Set(ids ?? []);
    const presets = this.list(kind).filter((p) => !ids || want.has(p.id));
    const bytes = await fmt.write(presets, { kind, kindVersion: s.def.version, def: s.def, groups: this.groups(kind), readBlob: (n) => this.readBlob(kind, n) });
    return { bytes, ext: (fmt.extensions?.[0] ?? '').replace(/^\./, '') };
  }

  fileOf(s) {
    const builtinGroupIds = new Set(s.built.groups.map((g) => g.id));
    return {
      format: FILE_FORMAT,
      version: 1,
      kind: s.kind,
      kindVersion: s.def.version,
      groups: s.groups.map((g) => ({ id: g.id, name: g.name, parent: g.parent ?? null, builtin: builtinGroupIds.has(g.id), ...(g.hidden ? { hidden: true } : {}) })),
      items: s.order.map((e) => (e.ref ? { ref: e.ref } : clone(e.preset))),
      hidden: [...s.hidden],
    };
  }

  schedule(s) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      this.writeNow(s);
    }, this.delay);
  }

  reportWriteError(err, kind) {
    try {
      this.onWriteError?.(err, { kind });
    } catch {
      // a broken reporter must not break the store
    }
  }

  writeNow(s) {
    if (!s.dirty) return s.writing ?? Promise.resolve();
    s.dirty = false;
    const file = this.fileOf(s);
    const prev = s.writing ?? Promise.resolve();
    s.writing = prev.then(() => this.backend?.write?.(s.kind, file)).catch((err) => {
      s.dirty = true; // memory keeps the change; the next change or flush retries
      this.reportWriteError(err, s.kind);
    });
    return s.writing;
  }

  /** Writes every pending change now (before-close). */
  async flush() {
    const waits = [];
    for (const s of this.states.values()) {
      clearTimeout(s.timer);
      s.timer = null;
      waits.push(this.writeNow(s));
    }
    await Promise.all(waits);
  }
}

// ---- the built-in file format, for every kind -------------------------------------------------

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

registerPresetFormat('*', {
  id: 'pigment-presets',
  name: 'Pigment Presets',
  extensions: ['pigment-presets'],
  async read(bytes, { kind } = {}) {
    const json = JSON.parse(dec(bytes));
    if (!json || json.format !== FILE_FORMAT || !Array.isArray(json.items)) throw new Error('not a Pigment presets file');
    const report = [];
    if (kind && json.kind && json.kind !== kind) throw new Error(`the file holds ${json.kind} presets`);
    const blobs = {};
    for (const [name, b64] of Object.entries(json.blobs ?? {})) {
      try {
        blobs[name] = fromBase64(b64);
      } catch {
        report.push(`Skipped the damaged side file ${name}`);
      }
    }
    return {
      presets: json.items.filter((p) => p && typeof p === 'object' && !p.ref).map((p) => ({ name: p.name, group: p.group ?? null, data: p.data })),
      groups: Array.isArray(json.groups) ? json.groups : [],
      kindVersion: json.kindVersion,
      blobs,
      report,
    };
  },
  async write(presets, { kind, kindVersion, def, groups = [], readBlob } = {}) {
    const blobs = {};
    const names = new Set();
    for (const p of presets) for (const n of def?.blobs?.(p.data) ?? []) names.add(n);
    for (const n of names) {
      const b = await readBlob?.(n);
      if (b) blobs[n] = toBase64(b);
    }
    const groupIds = new Set(presets.map((p) => p.group).filter(Boolean));
    const file = {
      format: FILE_FORMAT,
      version: 1,
      kind,
      kindVersion,
      groups: [...groupIds].map((id) => ({ id, name: groups.find((g) => g.id === id)?.name ?? id, parent: null })),
      items: presets.map((p) => ({ id: p.id, name: p.name, group: p.group ?? null, data: p.data })),
      hidden: [],
      blobs,
    };
    return enc(JSON.stringify(file));
  },
});
