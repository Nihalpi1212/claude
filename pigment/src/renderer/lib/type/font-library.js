// The font catalog (type-fonts, ARCHITECTURE.md "0.5 features", package 12; S11.1, S11.2). MODULES entry; replaces
// the skeleton's stub at this path and keeps its exports (createStubCatalog, parsePostScriptStyle, install).
//
// The catalog knows every family the font menu lists and each family's real styles:
//   - the installed fonts: queryLocalFonts records (names, no bytes) where the platform allows it (Electron grants
//     'local-fonts'; the browser build only when the permission is already granted), else 0.4's family list
//     (tools/text.js fontFamilies(): common families the browser draws), whose styles are 0.4's synthesised ones;
//   - the bundled OFL families of src/renderer/fonts/ (index.json describes them; their files load when a layer or
//     the fallback needs them: a fonts.js face source);
//   - the fonts added with Type > Add Fonts… (the `fonts` preset kind: each file kept as a blob, loaded at ready());
//   - every face loaded in this session (faces a test or another module added through fonts.addFontData).
// A family's styles are its real faces (static faces, and the named instances of a variable face), weight then slant.
// Style keys (the options bar's and the Character panel's style values) are PostScript names; a family whose faces
// Pigment cannot list (0.4's detected families) keeps 0.4's keys ('400', '700i'). A key may carry axis values after a
// '|' ('SourceSans3VF-Regular|wght=650') when the style's axes differ from the named instance's.
//
// Classification (the menu's filters: Serif, Sans Serif, Slab Serif, Script, Handwritten, Monospace, Decorative,
// Blackletter) comes from OS/2 sFamilyClass, PANOSE and post's fixed pitch (font-tables.js), for installed fonts read
// in the background from slices of their files and kept in IndexedDB ('pigment-fonts', rebuilt when missing); until a
// family is read, its name decides when it can.
//
// Favourites and recently used families are settings.typeFonts.favourites / recent (rule 5). The catalog emits
// 'type:catalog-changed' on app when its families change.
import { registerFontCatalog, fontCatalog } from './api.js';
import * as fonts from './fonts.js';
import { fontFamilies, onFontsChanged, STYLES, styleOf, styleToFont } from '../tools/text.js';
import { cssFamilyFromPsFont } from '../psd/text.js';
import { registerPresetKind } from '../presets.js';
import { bridge } from '../bridge.js';
import { fontInfo, faceCountOf, isFontFile, classifyName, similarity, infoTableSpans, infoFromTables, FONT_CLASSES, parsePostScriptStyle, parseStyleName, nearestStyle, axesSuffix, parseStyleKey } from './font-tables.js';
import { runsIn } from './model.js';
import { installPicker } from './font-picker.js';
import { installMissingFonts } from './missing-fonts.js';

// parsePostScriptStyle is the stub's export (S15); the others are the style-key helpers of font-tables.js
export { FONT_CLASSES, parsePostScriptStyle, parseStyleName, nearestStyle, axesSuffix, parseStyleKey };

// fonts.js' metric-compatible substitutes: Canvas text draws these families with a substitute, so they are not missing
const METRIC_ALIAS_FAMILIES = new Set(['arial', 'helvetica', 'times new roman', 'times', 'courier new', 'courier', 'calibri', 'cambria']);
const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'cursive', 'fantasy']);

const LEGACY_KEY = /^\d{3}i?$/;
const familyKey = (f) => String(f ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
const legacyStyles = () => STYLES.map(([key, name]) => ({ name, postScriptName: null, ...(({ weight, italic }) => ({ weight, italic }))(styleToFont(key)) }));
const styleOrder = (a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic) || (a.stretch ?? 5) - (b.stretch ?? 5) || a.name.localeCompare(b.name);

// ---- the classification cache (IndexedDB) -----------------------------------------------------------------------

const DB_NAME = 'pigment-fonts';
function openDb() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('info');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function dbAll(db) {
  if (!db) return new Map();
  return new Promise((resolve) => {
    const out = new Map();
    try {
      const req = db.transaction('info').objectStore('info').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.set(c.key, c.value);
        c.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}
function dbPut(db, entries) {
  if (!db || !entries.length) return;
  try {
    const tx = db.transaction('info', 'readwrite');
    const store = tx.objectStore('info');
    for (const [k, v] of entries) store.put(v, k);
  } catch {
    // the cache is rebuilt next time
  }
}

/** The info the classification cache keeps of a face: { classification, metrics, weight, italic, stretch }. */
const cacheInfo = (i) => ({ classification: i.classification ?? null, metrics: i.metrics ?? null, weight: i.weight, italic: !!i.italic, stretch: i.stretch ?? 5 });

// ---- the catalog ------------------------------------------------------------------------------------------------------

const timeout = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));
const RECENT_MAX = 10;

export class FontLibrary {
  constructor(app = null, { manifestUrl = new URL('../../fonts/index.json', import.meta.url).href } = {}) {
    this.app = app;
    this.real = true;
    this.manifestUrl = manifestUrl;
    this.manifest = null; // src/renderer/fonts/index.json
    this.records = new Map(); // installed: postScriptName -> { family, style, fullName, data: FontData }
    this.info = new Map(); // postScriptName -> cacheInfo (installed fonts read in the background)
    this.user = []; // the `fonts` presets
    this.entries = null; // lower-case family -> FamilyEntry (rebuilt when dirty)
    this.byPs = null; // postScriptName -> { family, style }
    this.loadingReady = null;
    this.db = null;
    this.classifying = false;
    this.listeners = new Set();
    const self = this;
    this.favourites = {
      list: () => self.setting('favourites').filter((f) => typeof f === 'string'),
      toggle(family) {
        const list = self.favourites.list();
        const i = list.findIndex((f) => familyKey(f) === familyKey(family));
        if (i >= 0) list.splice(i, 1);
        else if (family) list.push(String(family));
        self.writeSetting({ favourites: list });
      },
      has: (family) => self.favourites.list().some((f) => familyKey(f) === familyKey(family)),
    };
    this.recent = {
      list: () => self.setting('recent').filter((f) => typeof f === 'string'),
      push(family) {
        if (!family) return;
        const list = [String(family), ...self.recent.list().filter((f) => familyKey(f) !== familyKey(family))].slice(0, RECENT_MAX);
        self.writeSetting({ recent: list });
      },
    };
  }

  // ---- settings (rule 5: settings.typeFonts) ----
  setting(key) {
    const v = this.app?.settings?.typeFonts?.[key];
    return Array.isArray(v) ? v.slice() : [];
  }
  writeSetting(patch) {
    if (!this.app) return;
    this.app.saveSettingsSoon({ typeFonts: { ...(this.app.settings.typeFonts ?? {}), ...patch } });
    this.changed();
  }

  // ---- change notification ----
  changed() {
    this.entries = null;
    this.byPs = null;
    this.app?.emit('type:catalog-changed', { catalog: this });
  }

  // ---- loading (ready) ----
  ready() {
    this.loadingReady ??= (async () => {
      // each part is bounded: the menu works with what arrived (0.4's list at least)
      await Promise.all([
        Promise.race([this.loadRecords(), timeout(3000)]),
        this.loadManifest(),
        Promise.race([this.loadUserFonts(), timeout(5000)]),
        Promise.race([this.loadInfoCache(), timeout(2000)]),
      ]);
      this.changed();
      // classification of installed fonts the cache does not know (background, a few files at a time)
      setTimeout(() => this.classifyInBackground(), 500);
    })();
    return this.loadingReady;
  }

  async loadManifest() {
    if (this.manifest) return;
    try {
      const res = await fetch(this.manifestUrl);
      if (res.ok) this.manifest = await res.json();
    } catch {
      this.manifest = null;
    }
    if (this.manifest?.format !== 'pigment-fonts') this.manifest = { families: [] };
    const base = this.manifestUrl;
    const families = this.manifest.families ?? [];
    // the bundled files load when a layer, the fallback or a preview needs them (fonts.js face source)
    fonts.registerFaceSource({
      has: (family) => families.some((f) => familyKey(f.name) === familyKey(family)),
      load: async (family) => {
        const fam = families.find((f) => familyKey(f.name) === familyKey(family));
        if (!fam) return null;
        const out = [];
        for (const face of fam.faces ?? []) {
          try {
            const res = await fetch(new URL(face.file, base).href);
            if (res.ok) out.push({ bytes: new Uint8Array(await res.arrayBuffer()), meta: { family: fam.name } });
          } catch {
            // a missing file: the family draws with what loaded
          }
        }
        return out;
      },
    });
    this.applyFallback();
  }

  /** The bundled default family (missing glyph protection, Replace All Missing Fonts), or null. */
  get defaultFamily() {
    return this.manifest?.default ?? this.manifest?.families?.[0]?.name ?? null;
  }

  /** Missing glyph protection: the bundled default family first (settings.typeFonts.glyphProtection, default on). */
  applyFallback() {
    const enabled = this.app?.settings?.typeFonts?.glyphProtection !== false;
    const def = this.defaultFamily;
    fonts.setFallbackFamilies(def ? [def] : [], { enabled });
    // the default family's faces load once HarfBuzz is there, so a missing glyph finds them
    if (enabled && def) fonts.requestFamily(def).catch(() => {});
  }

  async loadRecords() {
    try {
      if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return;
      // without a granted permission the browser would prompt from a user gesture only: ask nothing then
      if (!window.pigment) {
        const st = await navigator.permissions?.query?.({ name: 'local-fonts' });
        if (st?.state !== 'granted') return;
      }
      const list = await window.queryLocalFonts();
      for (const fd of list) if (fd.postscriptName) this.records.set(fd.postscriptName, { family: fd.family, style: fd.style, fullName: fd.fullName, data: fd });
    } catch {
      // no installed-font list: 0.4's detected families stay
    }
  }

  async loadInfoCache() {
    this.db ??= await openDb();
    for (const [k, v] of await dbAll(this.db)) if (!this.info.has(k)) this.info.set(k, v);
  }

  async loadUserFonts() {
    const presets = this.app?.presets;
    if (!presets) return;
    try {
      await presets.ready('fonts');
    } catch {
      return;
    }
    this.user = presets.list('fonts');
    for (const p of this.user) {
      if (fonts.loadedFaces().some((f) => f.postScriptName && f.postScriptName === p.data.postScriptName)) continue;
      try {
        const bytes = await presets.readBlob('fonts', p.data.blob);
        if (bytes) await fonts.addFontData(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { name: p.name });
      } catch (err) {
        console.warn(`[fonts] could not load the added font "${p.name}":`, err?.message ?? err);
      }
    }
  }

  /** Reads the classification of installed fonts the cache lacks, a few at a time, then announces the result. */
  async classifyInBackground() {
    if (this.classifying) return;
    this.classifying = true;
    try {
      // one face per family is enough for its class (the regular one when there is one)
      const byFamily = new Map();
      for (const [ps, r] of this.records) {
        const k = familyKey(r.family);
        const cur = byFamily.get(k);
        if (!cur || /regular|book|normal|roman/i.test(r.style ?? '')) byFamily.set(k, ps);
      }
      const todo = [...byFamily.values()].filter((ps) => !this.info.has(ps));
      let done = [];
      for (let i = 0; i < todo.length; i++) {
        const ps = todo[i];
        const info = await this.readInstalledInfo(this.records.get(ps)?.data).catch(() => null);
        this.info.set(ps, info ? cacheInfo(info) : { classification: classifyName(this.records.get(ps)?.family), metrics: null });
        done.push([ps, this.info.get(ps)]);
        if (done.length >= 25 || i === todo.length - 1) {
          dbPut(this.db, done);
          done = [];
          this.changed();
          await timeout(30);
        }
      }
    } finally {
      this.classifying = false;
    }
  }

  /** fontInfo of an installed face from slices of its file (the directory, then only the tables it reads). */
  async readInstalledInfo(fd) {
    if (!fd?.blob) return null;
    const blob = await fd.blob();
    const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    let index = 0;
    if (faceCountOf(head) > 1) {
      // a collection: the face whose PostScript name the record names
      index = -1;
      for (let i = 0; i < faceCountOf(head) && index < 0; i++) {
        const spans = infoTableSpans(head, i);
        const nameSpan = spans?.find((s) => s.tag === 'name');
        if (!nameSpan) continue;
        const nb = new Uint8Array(await blob.slice(nameSpan.offset, nameSpan.offset + nameSpan.length).arrayBuffer());
        const info = infoFromTables((t) => (t === 'name' ? nb : null));
        if (info.postScriptName === fd.postscriptName) index = i;
      }
      if (index < 0) index = 0;
    }
    const spans = infoTableSpans(head, index);
    if (!spans) return null;
    const tables = new Map();
    for (const s of spans) tables.set(s.tag, new Uint8Array(await blob.slice(s.offset, s.offset + s.length).arrayBuffer()));
    return infoFromTables((t) => tables.get(t) ?? null);
  }

  // ---- the family list ----
  build() {
    if (this.entries) return this.entries;
    const entries = new Map();
    const byPs = new Map();
    const add = (name, source) => {
      const k = familyKey(name);
      let e = entries.get(k);
      if (!e) {
        e = { name, styles: [], classification: null, source, variable: false, synthetic: false };
        entries.set(k, e);
      }
      return e;
    };
    const pushStyle = (e, st) => {
      if (st.postScriptName && e.styles.some((s) => s.postScriptName === st.postScriptName)) return;
      e.styles.push(st);
      if (st.postScriptName) byPs.set(st.postScriptName, { family: e.name, style: st });
    };
    // faces loaded in this session: their real styles win
    const userPs = new Set(this.user.map((p) => p.data?.postScriptName).filter(Boolean));
    const bundledKeys = new Set((this.manifest?.families ?? []).map((f) => familyKey(f.name)));
    const recordFamilies = new Set([...this.records.values()].map((r) => familyKey(r.family)));
    for (const f of fonts.loadedFaces()) {
      const k = familyKey(f.family);
      const source = bundledKeys.has(k) ? 'bundled' : userPs.has(f.postScriptName) ? 'user' : recordFamilies.has(k) ? 'system' : 'user';
      const e = add(f.family, source);
      e.loaded = true;
      e.classification ??= f.classification;
      e.metrics ??= f.metrics;
      if (f.cssFamily && !e.cssFamily) e.cssFamily = f.cssFamily;
      if (f.variable && f.instances.length) {
        e.variable = true;
        for (const i of f.instances) pushStyle(e, { name: i.name, postScriptName: i.postScriptName, weight: i.weight, italic: !!i.italic, instance: { ...i.coords } });
      } else {
        if (f.variable) e.variable = true;
        pushStyle(e, { name: f.style || 'Regular', postScriptName: f.postScriptName || null, weight: f.weight, italic: !!f.italic });
      }
    }
    // the bundled families (styles from the manifest until their files load)
    for (const fam of this.manifest?.families ?? []) {
      const e = add(fam.name, 'bundled');
      e.source = 'bundled';
      e.classification ??= fam.classification ?? null;
      e.variable ||= !!fam.variable;
      for (const face of fam.faces ?? []) {
        e.metrics ??= face.metrics ?? null;
        if (face.instances?.length) for (const i of face.instances) pushStyle(e, { name: i.name, postScriptName: i.postScriptName, weight: i.weight, italic: !!i.italic, instance: { ...i.coords } });
        else pushStyle(e, { name: face.style ?? 'Regular', postScriptName: face.postScriptName, weight: face.weight, italic: !!face.italic });
      }
    }
    // installed fonts (records: names, weight from the style name or the classification cache)
    for (const [ps, r] of this.records) {
      const e = add(r.family, 'system');
      const cached = this.info.get(ps);
      const parsed = parseStyleName(r.style);
      if (!e.loaded) pushStyle(e, { name: r.style || 'Regular', postScriptName: ps, weight: cached?.weight ?? parsed.weight, italic: cached ? !!cached.italic : parsed.italic, stretch: cached?.stretch });
      else if (!byPs.has(ps)) byPs.set(ps, { family: e.name, style: { name: r.style || 'Regular', postScriptName: ps, ...parsed } });
      if (cached?.classification && !e.classification) e.classification = cached.classification;
      if (cached?.metrics && !e.metrics) e.metrics = cached.metrics;
    }
    // 0.4's detected families: no faces Pigment can list, so 0.4's synthesised styles
    for (const name of fontFamilies()) {
      if (GENERIC_FAMILIES.has(name)) continue;
      const k = familyKey(name);
      if (entries.has(k)) continue;
      const e = add(name, 'system');
      e.synthetic = true;
      e.styles = legacyStyles();
    }
    for (const e of entries.values()) {
      e.styles.sort(styleOrder);
      if (!e.classification) e.classification = classifyName(e.name);
      if (!e.styles.length) {
        e.synthetic = true;
        e.styles = legacyStyles();
      }
    }
    this.entries = entries;
    this.byPs = byPs;
    return entries;
  }

  /** FamilyEntry copies for the outside (S11.1). */
  publicEntry(e) {
    if (!e) return null;
    const out = { name: e.name, styles: e.styles.map((s) => ({ ...s, ...(s.instance ? { instance: { ...s.instance } } : {}) })), classification: e.classification ?? null, source: e.source, variable: !!e.variable };
    if (e.cssFamily) out.cssFamily = e.cssFamily;
    if (e.synthetic) out.synthetic = true;
    return out;
  }

  families({ search = '', classes = null, favourites = false } = {}) {
    const q = String(search ?? '').trim().toLowerCase();
    const cls = Array.isArray(classes) && classes.length ? new Set(classes) : null;
    const fav = favourites ? new Set(this.favourites.list().map(familyKey)) : null;
    const out = [];
    for (const e of this.build().values()) {
      if (q && !e.name.toLowerCase().includes(q) && !e.styles.some((s) => `${e.name} ${s.name}`.toLowerCase().includes(q))) continue;
      if (cls && !cls.has(e.classification)) continue;
      if (fav && !fav.has(familyKey(e.name))) continue;
      out.push(e);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return out.map((e) => this.publicEntry(e));
  }

  family(name) {
    return this.publicEntry(this.build().get(familyKey(name)) ?? null);
  }

  styles(family) {
    return this.family(family)?.styles ?? [];
  }

  /** Families that look like `family` (classification and metrics), most alike first. */
  similar(family, { limit = 12 } = {}) {
    const entries = this.build();
    const me = entries.get(familyKey(family));
    if (!me) return [];
    const a = { classification: me.classification, metrics: me.metrics, weight: 400 };
    const scored = [];
    for (const e of entries.values()) {
      if (e === me) continue;
      scored.push([similarity(a, { classification: e.classification, metrics: e.metrics, weight: 400 }), e]);
    }
    return scored.sort((x, y) => y[0] - x[0] || x[1].name.localeCompare(y[1].name)).slice(0, limit).filter(([s]) => s > 0.35).map(([, e]) => this.publicEntry(e));
  }

  /** True when the family draws with something Pigment has (the catalog, a loaded face, a metric substitute). */
  known(family) {
    const k = familyKey(family);
    if (!k) return false;
    return this.build().has(k) || METRIC_ALIAS_FAMILIES.has(k) || GENERIC_FAMILIES.has(k) || fonts.hasFamily(family);
  }

  /** The catalog's style of a family that matches a character style: its PostScript name, else the nearest. */
  matchStyle(e, st) {
    if (!e) return null;
    const ps = st?.postScriptName;
    if (ps) {
      const hit = e.styles.find((s) => s.postScriptName === ps);
      if (hit) return hit;
    }
    return nearestStyle(e.styles, Number(st?.fontWeight ?? 400) || 400, !!st?.fontItalic);
  }

  resolve(st) {
    const family = st?.fontFamily ?? null;
    const e = this.build().get(familyKey(family)) ?? null;
    const psKnown = !!st?.postScriptName && !!this.build() && this.byPs.has(st.postScriptName);
    const missing = !psKnown && !this.known(family);
    const weight = Number(st?.fontWeight ?? 400) || 400;
    const italic = !!st?.fontItalic;
    let rec = null;
    try {
      rec = fonts.faceFor({ ...st, fontWeight: weight, fontItalic: italic });
    } catch {
      rec = null;
    }
    const style = e && !e.synthetic ? this.matchStyle(e, st) : null;
    const axes = { ...(rec?.coords ?? {}), ...(st?.axes ?? {}) };
    const faceWeight = rec?.weight ?? style?.weight ?? weight;
    const faceItalic = rec ? !!rec.italic : style ? !!style.italic : italic;
    return {
      family,
      postScriptName: rec?.postScriptName || style?.postScriptName || st?.postScriptName || null,
      weight: faceWeight,
      italic: faceItalic,
      axes,
      synthetic: { bold: weight >= 600 && faceWeight < 600, italic: italic && !faceItalic },
      missing,
      substitute: missing ? this.defaultFamily ?? 'Arial' : null,
    };
  }

  fromPostScriptName(name) {
    if (!name) return null;
    this.build();
    const hit = this.byPs.get(name);
    if (hit) return { family: hit.family, style: { ...hit.style }, missing: false };
    const family = cssFamilyFromPsFont(name);
    const { weight, italic } = parsePostScriptStyle(name);
    const e = this.build().get(familyKey(family));
    const near = e && !e.synthetic ? nearestStyle(e.styles, weight, italic) : null;
    return { family: e?.name ?? family, style: { name: near?.name ?? legacyStyles().find((s) => s.weight === weight && s.italic === italic)?.name ?? 'Regular', postScriptName: name, weight, italic }, missing: !this.known(family) };
  }

  styleKey(st) {
    const e = this.build().get(familyKey(st?.fontFamily)) ?? null;
    const weight = Number(st?.fontWeight ?? 400) || 400;
    if (!e || e.synthetic) return styleOf({ weight, italic: !!st?.fontItalic });
    const style = this.matchStyle(e, st);
    if (!style?.postScriptName) return styleOf({ weight, italic: !!st?.fontItalic });
    // a variable family: the axis values that differ from the named instance (the weight is the wght axis)
    let extra = '';
    if (e.variable && style.instance) {
      const want = { ...(Number.isFinite(style.instance.wght) ? { wght: weight } : {}), ...(st?.axes ?? {}) };
      extra = axesSuffix(want, style.instance);
    }
    return extra ? `${style.postScriptName}|${extra}` : style.postScriptName;
  }

  stylePatch(family, key) {
    const e = this.build().get(familyKey(family)) ?? null;
    const { key: k, axes } = parseStyleKey(key);
    const plain = (weight, italic) => ({ fontFamily: family, fontWeight: weight, fontItalic: !!italic, postScriptName: null, axes: {} });
    if (LEGACY_KEY.test(k) || !k) {
      const { weight, italic } = styleToFont(k || '400');
      if (!e || e.synthetic) return plain(weight, italic);
      const s = nearestStyle(e.styles, weight, italic);
      return s?.postScriptName ? { fontFamily: family, fontWeight: s.weight, fontItalic: !!s.italic, postScriptName: s.postScriptName, axes: {} } : plain(weight, italic);
    }
    const own = e?.styles.find((s) => s.postScriptName === k);
    if (own) return { fontFamily: family, fontWeight: Number.isFinite(axes.wght) ? Math.round(axes.wght) : own.weight, fontItalic: !!own.italic, postScriptName: own.postScriptName, axes: { ...axes } };
    // a key of another family (the family changed): that style's weight and slant, the face left to the new family
    const other = this.byPs.get(k)?.style ?? parsePostScriptStyle(k);
    if (e && !e.synthetic) {
      const s = nearestStyle(e.styles, other.weight, other.italic);
      if (s) return { fontFamily: family, fontWeight: s.weight, fontItalic: !!s.italic, postScriptName: null, axes: {} };
    }
    return plain(other.weight ?? 400, other.italic);
  }

  async axes(psOrFamily) {
    this.build();
    const hit = this.byPs.get(psOrFamily);
    const family = hit?.family ?? this.build().get(familyKey(psOrFamily))?.name ?? null;
    if (!family) return [];
    await fonts.requestFamily(family).catch(() => false);
    const recs = fonts.facesOf(family);
    const rec = recs.find((r) => r.postScriptName === psOrFamily || r.instances?.some((i) => i.postScriptName === psOrFamily)) ?? recs.find((r) => !r.italic) ?? recs[0];
    let axes = rec?.axes ?? null;
    if (!axes?.length) {
      const fam = this.manifest?.families?.find((f) => familyKey(f.name) === familyKey(family));
      axes = fam?.faces?.[0]?.axes ?? [];
    }
    return (axes ?? []).filter((a) => !a.hidden).map(({ tag, name, min, max, default: d }) => ({ tag, name, min, max, default: d }));
  }

  /**
   * Type > Add Fonts…: each file's faces join the catalog for this session and are kept (the `fonts` preset kind, the
   * file as its blob) for the next ones. Returns the families added; `report` lists the files that were not fonts.
   */
  async addFiles(files, { report = [] } = {}) {
    const added = new Map();
    for (const f of files ?? []) {
      const bytes = f?.bytes instanceof Uint8Array ? f.bytes : f?.bytes ? new Uint8Array(f.bytes) : null;
      const name = String(f?.name ?? 'font');
      if (!bytes || !isFontFile(bytes)) {
        report.push(`${name}: not a font file Pigment can read (TrueType, OpenType or a collection)`);
        continue;
      }
      let faces = [];
      try {
        faces = (await fonts.addFontData(bytes, { name })) ?? [];
      } catch (err) {
        report.push(`${name}: ${err?.message ?? err}`);
        continue;
      }
      if (!faces.length) {
        report.push(`${name}: no faces`);
        continue;
      }
      for (const face of faces) added.set(familyKey(face.family), face.family);
      await this.keepFile(bytes, name, faces[0]).catch((err) => report.push(`${name}: not kept for the next session (${err?.message ?? err})`));
    }
    this.changed();
    return [...added.values()].map((fam) => this.family(fam)).filter(Boolean);
  }

  async keepFile(bytes, name, face) {
    const presets = this.app?.presets;
    if (!presets) return;
    await presets.ready('fonts');
    const ext = (/\.(ttf|otf|ttc|otc)$/i.exec(name)?.[1] ?? (faceCountOf(bytes) > 1 ? 'ttc' : 'ttf')).toLowerCase();
    const blob = `font-${await sha1(bytes)}.${ext}`;
    if (presets.list('fonts').some((p) => p.data.blob === blob)) return;
    await presets.writeBlob('fonts', blob, bytes);
    const info = fontInfo(bytes);
    presets.add('fonts', { name: face.family, data: { family: face.family, postScriptName: face.postScriptName, blob, classification: info?.classification ?? null } });
    this.user = presets.list('fonts');
  }

  /** The fonts of a document's text that Pigment does not have: [{ family, postScriptName, layers }], by PostScript name first. */
  missing(doc) {
    const out = new Map();
    for (const layer of textLayersOf(doc)) {
      for (const st of styleListOf(layer)) {
        if (this.resolve(st).missing === false) continue;
        const key = st.postScriptName ? `ps:${st.postScriptName}` : `f:${familyKey(st.fontFamily)}`;
        let m = out.get(key);
        if (!m) out.set(key, (m = { family: st.fontFamily, postScriptName: st.postScriptName ?? null, layers: [] }));
        if (!m.layers.includes(layer)) m.layers.push(layer);
      }
    }
    return [...out.values()];
  }
}

/** Every text layer of a document, groups included. */
export function textLayersOf(doc) {
  if (!doc) return [];
  try {
    return doc.layers().filter((l) => l.type === 'text');
  } catch {
    return [];
  }
}
/** The resolved character styles a text layer uses (its runs; the insertion style of an empty layer). */
export function styleListOf(layer) {
  const c = layer.content;
  if (!c) return [];
  const len = c.text?.length ?? 0;
  const runs = c.runs ?? [];
  if (!len) return runs.length ? [runs[0].style] : [];
  return layerRuns(layer).map((r) => r.style);
}
const layerRuns = (layer) => runsIn(layer.content, 0, layer.content.text.length);

async function sha1(bytes) {
  if (globalThis.crypto?.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // FNV-1a over the bytes (a fallback where SubtleCrypto is missing; the name only has to be stable)
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0') + bytes.length.toString(16);
}

// ---- the skeleton's stub catalog (kept: S15 lists its export) ---------------------------------------------------------

/** The stub catalog (S11.1) over 0.4's family list (kept for tests and as the fallback when the real one cannot load). */
export function createStubCatalog(app = null) {
  let records = null; // postScriptName -> { family, style }
  let loading = null;
  const recordFamilies = () => new Set([...(records?.values() ?? [])].map((r) => r.family.toLowerCase()));
  const known = (family) => {
    const f = String(family ?? '').toLowerCase();
    return !!f && (fontFamilies().some((x) => x.toLowerCase() === f) || recordFamilies().has(f) || METRIC_ALIAS_FAMILIES.has(f));
  };
  const entry = (name) => ({ name, styles: legacyStyles(), classification: null, source: 'system', variable: false });
  async function fetchRecords() {
    const out = new Map();
    try {
      if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return out;
      if (!window.pigment) {
        const st = await navigator.permissions?.query?.({ name: 'local-fonts' });
        if (st?.state !== 'granted') return out;
      }
      for (const fd of await window.queryLocalFonts()) if (fd.postscriptName) out.set(fd.postscriptName, { family: fd.family, style: fd.style });
    } catch {
      // no local fonts: the family list stays 0.4's
    }
    return out;
  }
  const catalog = {
    real: false,
    ready() {
      if (records) return Promise.resolve();
      loading ??= Promise.race([fetchRecords(), new Promise((r) => setTimeout(() => r(new Map()), 3000))]).then((m) => {
        records = m;
      });
      return loading;
    },
    families({ search = '', classes = null, favourites = false } = {}) {
      if (favourites || (Array.isArray(classes) && classes.length)) return [];
      const q = String(search ?? '').trim().toLowerCase();
      const names = new Set(fontFamilies());
      for (const r of records?.values() ?? []) names.add(r.family);
      return [...names].filter((n) => !q || n.toLowerCase().includes(q)).map(entry);
    },
    family: (name) => (known(name) ? entry(fontFamilies().find((x) => x.toLowerCase() === String(name).toLowerCase()) ?? name) : null),
    styles: () => legacyStyles(),
    resolve: (st) => ({ family: st?.fontFamily ?? null, postScriptName: st?.postScriptName ?? null, weight: Number(st?.fontWeight ?? 400) || 400, italic: !!st?.fontItalic, axes: { ...(st?.axes ?? {}) }, synthetic: { bold: false, italic: false }, missing: !known(st?.fontFamily), substitute: null }),
    fromPostScriptName(name) {
      if (!name) return null;
      const rec = records?.get(name);
      const family = rec?.family ?? cssFamilyFromPsFont(name);
      const { weight, italic } = parsePostScriptStyle(rec ? `x-${rec.style ?? ''}` : name);
      return { family, style: { name: rec?.style ?? legacyStyles().find((s) => s.weight === weight && s.italic === italic)?.name ?? 'Regular', postScriptName: name, weight, italic }, missing: !known(family) };
    },
    styleKey: (st) => styleOf({ weight: st?.fontWeight ?? 400, italic: !!st?.fontItalic }),
    stylePatch(family, key) {
      const { weight, italic } = styleToFont(key);
      return { fontFamily: family, fontWeight: weight, fontItalic: italic, postScriptName: null, axes: {} };
    },
    axes: () => Promise.resolve([]),
    async addFiles(files) {
      const faces = [];
      for (const f of files ?? []) faces.push(...((await fonts.addFontData(f.bytes, { name: f.name })) ?? []));
      app?.emit('type:catalog-changed', { catalog });
      return [...new Set(faces.map((x) => x.family))].map(entry);
    },
    missing: () => [],
    favourites: { list: () => [], toggle() {} },
    recent: { list: () => [], push() {} },
  };
  return catalog;
}

// ---- install ------------------------------------------------------------------------------------------------------------

/** Reads the files of `paths` (Type > Add Fonts…), through the bridge. */
async function readPaths(paths) {
  const out = [];
  for (const p of paths ?? []) {
    try {
      out.push({ name: String(p).split(/[\\/]/).pop(), bytes: await bridge.readFile(p) });
    } catch (err) {
      out.push({ name: String(p).split(/[\\/]/).pop(), bytes: null, error: err?.message ?? String(err) });
    }
  }
  return out;
}

const FONT_FILE_FILTERS = [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc', 'otc'] }, { name: 'All files', extensions: ['*'] }];

export function install(app) {
  const catalog = new FontLibrary(app);
  // the `fonts` kind (S10.5) with its full definition: one preset per added file, the file as the blob
  registerPresetKind('fonts', {
    title: 'Fonts',
    version: 1,
    builtins: () => ({ presets: [] }),
    normalize: (data) => (data && typeof data === 'object' && typeof data.family === 'string' && data.family && typeof data.blob === 'string' && /^font-[0-9a-f]+\.(ttf|otf|ttc|otc)$/i.test(data.blob)
      ? { family: data.family, postScriptName: typeof data.postScriptName === 'string' ? data.postScriptName : null, blob: data.blob, classification: FONT_CLASSES.includes(data.classification) ? data.classification : null }
      : null),
    blobs: (data) => (typeof data?.blob === 'string' ? [data.blob] : []),
  });
  registerFontCatalog(catalog);
  // faces arrive (a layer's family, an added file, the bundled default): the catalog lists them
  onFontsChanged(() => catalog.changed());
  app.on('type:fonts-changed', () => {
    catalog.entries = null;
    catalog.byPs = null;
  });
  app.on('settings:changed', (patch) => {
    if (patch && 'typeFonts' in patch) catalog.applyFallback();
  });
  catalog.ready().catch((err) => console.warn('[fonts] the font catalog did not load:', err?.message ?? err));

  // the font widgets and the Character panel's family and style rows (font-picker.js)
  installPicker(app, catalog);

  app.commands.register('type:add-fonts', {
    label: 'Add Fonts…',
    record: false,
    // { paths } or { files: [{ name, bytes }] } adds those files without the dialog
    run: async (arg) => {
      let files = Array.isArray(arg?.files) ? arg.files : null;
      if (!files) {
        const paths = Array.isArray(arg?.paths) ? arg.paths : await bridge.openFileDialog({ multiple: true, filters: FONT_FILE_FILTERS, title: 'Add Fonts' });
        if (!paths?.length) return null;
        files = await readPaths(paths);
      }
      const report = files.filter((f) => !f.bytes).map((f) => `${f.name}: ${f.error ?? 'could not be read'}`);
      const added = await app.busy('Adding fonts…', () => catalog.addFiles(files.filter((f) => f.bytes), { report }), { gate: false });
      if (added.length) app.dialogs.toast(added.length === 1 ? `Added the font family ${added[0].name}` : `Added ${added.length} font families: ${added.map((f) => f.name).join(', ')}`, { timeout: 4000 });
      if (report.length) app.dialogs.alert(added.length ? 'Some files were not added.' : 'No fonts were added.', { title: 'Add Fonts', detail: report.join('\n') });
      return { added: added.map((f) => f.name), report };
    },
  });

  const SIZES = ['none', 'small', 'medium', 'large', 'xlarge', 'huge'];
  // Preferences > Fonts (E20, a new section id beside the built-in Type section): Photoshop's Type preferences for the
  // font menu, missing glyph protection and the preview size
  app.preferences?.registerSection({
    id: 'type-fonts',
    title: 'Fonts',
    order: 36,
    fields: [
      { key: 'typeFontsGlyphProtection', label: 'Enable missing glyph protection', type: 'checkbox', span: true },
      { key: 'typeFontsPreviewSize', label: 'Font preview size', type: 'select', options: [['none', 'None'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra Large'], ['huge', 'Huge']] },
    ],
    read: (s) => ({ typeFontsGlyphProtection: s.typeFonts?.glyphProtection !== false, typeFontsPreviewSize: SIZES.includes(s.typeFonts?.previewSize) ? s.typeFonts.previewSize : 'medium' }),
    write: (values, s) => {
      const cur = s.typeFonts ?? {};
      const on = !!values.typeFontsGlyphProtection;
      const size = SIZES.includes(values.typeFontsPreviewSize) ? values.typeFontsPreviewSize : 'medium';
      if (on === (cur.glyphProtection !== false) && size === (cur.previewSize ?? 'medium')) return {};
      return { typeFonts: { ...cur, glyphProtection: on, previewSize: size } };
    },
  });
  app.commands.register('type:font-preview-size', {
    label: 'Font Preview Size',
    record: false,
    run: (size) => {
      if (!SIZES.includes(size)) return;
      app.saveSettingsSoon({ typeFonts: { ...(app.settings.typeFonts ?? {}), previewSize: size } });
    },
  });

  // Manage Missing Fonts…, Replace All Missing Fonts and the open hook (missing-fonts.js)
  installMissingFonts(app, catalog);
}

export { fontCatalog };
