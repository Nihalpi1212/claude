// type-fonts' MODULES entry (ARCHITECTURE.md "0.5 features", package 12, S11.1–S11.2). Skeleton stub, replaced by the
// package at the same path:
//   - the stub font catalog (fontCatalog().real === false): 0.4's family list (tools/text.js fontFamilies()) plus the
//     local font records it fetches itself (queryLocalFonts: PostScript name -> family and style, no font bytes);
//     styles are 0.4's synthesised STYLES; styleKey / stylePatch are 0.4's styleOf / styleToFont; fromPostScriptName
//     reads the records, else 0.4's cssFamilyFromPsFont with the weight and italic of the name's suffix; a family is
//     missing when it is in neither fontFamilies(), the records nor fonts.js' metric aliases (never !hasFamily, which
//     stays false until a family's bytes load); missing(doc) is []; addFiles goes to fonts.addFontData. It emits
//     'type:catalog-changed' on app when the family list changes.
//   - the option kinds `font-family` and `font-style` as 0.4's selects (`.opt[data-key="family"] select`,
//     `.opt[data-key="style"] select`; options from spec.options, which tools/text.js fills through setFamilyOptions).
//   - its Type menu commands (S13.3) as disabled stubs.
import { stubCommands } from '../stub.js';
import { registerWidget } from '../fields.js';
import { registerFontCatalog, fontCatalog } from './api.js';
import { addFontData } from './fonts.js';
import { fontFamilies, onFontsChanged, STYLES, styleOf, styleToFont } from '../tools/text.js';
import { cssFamilyFromPsFont } from '../psd/text.js';

// fonts.js' metric-compatible substitutes (its METRIC_ALIASES keys; fonts.js is type-fonts' file and does not export
// them): Canvas text draws these families with a substitute, so they are not missing
const METRIC_ALIAS_FAMILIES = new Set(['arial', 'helvetica', 'times new roman', 'times', 'courier new', 'courier', 'calibri', 'cambria']);

const WEIGHT_WORDS = [
  [/thin|hairline/i, 100], [/extra-?light|ultra-?light/i, 200], [/semi-?bold|demi-?bold/i, 600], [/extra-?bold|ultra-?bold|heavy/i, 800],
  [/black/i, 900], [/bold/i, 700], [/medium/i, 500], [/light/i, 300],
];
/** Weight and italic of a PostScript name's style suffix ("Arial-BoldItalicMT" -> 700, true). */
export function parsePostScriptStyle(name) {
  const suffix = String(name ?? '').includes('-') ? String(name).slice(String(name).lastIndexOf('-') + 1) : '';
  const weight = WEIGHT_WORDS.find(([re]) => re.test(suffix))?.[1] ?? 400;
  return { weight, italic: /italic|oblique|(^|[a-z])It$/i.test(suffix) };
}

const styleEntries = () => STYLES.map(([key, name]) => ({ name, postScriptName: null, ...(({ weight, italic }) => ({ weight, italic }))(styleToFont(key)) }));

/** The stub catalog (S11.1) over 0.4's family list. */
export function createStubCatalog(app = null) {
  let records = null; // postScriptName -> { family, style }
  let loading = null;
  const recordFamilies = () => new Set([...(records?.values() ?? [])].map((r) => r.family.toLowerCase()));
  const known = (family) => {
    const f = String(family ?? '').toLowerCase();
    return !!f && (fontFamilies().some((x) => x.toLowerCase() === f) || recordFamilies().has(f) || METRIC_ALIAS_FAMILIES.has(f));
  };
  const entry = (name) => ({ name, styles: styleEntries(), classification: null, source: 'system', variable: false });
  async function fetchRecords() {
    const out = new Map();
    try {
      if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return out;
      // without a granted permission the browser would prompt from a user gesture only: ask nothing then
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
      if (favourites || (Array.isArray(classes) && classes.length)) return []; // no favourites, no classification
      const q = String(search ?? '').trim().toLowerCase();
      const names = new Set(fontFamilies());
      for (const r of records?.values() ?? []) names.add(r.family);
      return [...names].filter((n) => !q || n.toLowerCase().includes(q)).map(entry);
    },
    family: (name) => (known(name) ? entry(fontFamilies().find((x) => x.toLowerCase() === String(name).toLowerCase()) ?? name) : null),
    styles: () => styleEntries(),
    resolve: (st) => ({
      family: st?.fontFamily ?? null,
      postScriptName: st?.postScriptName ?? null,
      weight: Number(st?.fontWeight ?? 400) || 400,
      italic: !!st?.fontItalic,
      axes: { ...(st?.axes ?? {}) },
      synthetic: { bold: false, italic: false },
      missing: !known(st?.fontFamily),
      substitute: null,
    }),
    fromPostScriptName(name) {
      if (!name) return null;
      const rec = records?.get(name);
      const family = rec?.family ?? cssFamilyFromPsFont(name);
      const { weight, italic } = parsePostScriptStyle(rec ? `x-${rec.style ?? ''}` : name);
      return { family, style: { name: rec?.style ?? styleEntries().find((s) => s.weight === weight && s.italic === italic)?.name ?? 'Regular', postScriptName: name, weight, italic }, missing: !known(family) };
    },
    styleKey: (st) => styleOf({ weight: st?.fontWeight ?? 400, italic: !!st?.fontItalic }),
    stylePatch(family, key) {
      const { weight, italic } = styleToFont(key);
      return { fontFamily: family, fontWeight: weight, fontItalic: italic, postScriptName: null, axes: {} };
    },
    axes: () => Promise.resolve([]),
    async addFiles(files) {
      const faces = [];
      for (const f of files ?? []) faces.push(...((await addFontData(f.bytes, { name: f.name })) ?? []));
      app?.emit('type:catalog-changed', { catalog });
      return [...new Set(faces.map((x) => x.family))].map(entry);
    },
    missing: () => [],
    favourites: { list: () => [], toggle() {} },
    recent: { list: () => [], push() {} },
  };
  return catalog;
}

/** A 0.4 select over spec.options (the stub font widgets). */
function selectWidget(spec, { value, onChange }) {
  const select = document.createElement('select');
  select.className = 'select';
  for (const [v, label] of spec.options ?? []) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = label;
    select.appendChild(o);
  }
  select.value = String(value ?? spec.default ?? '');
  select.addEventListener('change', () => onChange(select.value));
  return {
    element: select,
    get: () => select.value,
    set: (v) => {
      select.value = String(v ?? '');
    },
    setDisabled: (b) => {
      select.disabled = !!b;
    },
    destroy: () => select.remove(),
  };
}

export function install(app) {
  registerWidget('font-family', selectWidget);
  registerWidget('font-style', selectWidget);
  // a catalog type-fonts registered first is kept
  if (!fontCatalog().real) registerFontCatalog(createStubCatalog(app));
  onFontsChanged(() => app.emit('type:catalog-changed', { catalog: fontCatalog() }));
  stubCommands(app, ['type:add-fonts', 'type:font-preview-size', 'type:manage-missing-fonts', 'type:replace-missing-fonts']);
}
