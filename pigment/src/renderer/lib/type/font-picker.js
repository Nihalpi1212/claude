// The font menu (type-fonts, ARCHITECTURE.md "0.5 features", package 12; S11.1, S11.2, E7, E26, E52).
//
// One picker serves the options bar's `font-family` option and the Character panel's family row (and so the
// Properties text section, which shares the panel's controls): a field showing the family in its own face; a click (or
// typing into it) opens the menu: a search field (substring of family and style names), filters by classification,
// favourites (★) and similar fonts (≈), and a list with the recently used families first, each row WYSIWYG (a sample
// in the family's face at Type > Font Preview Size, the sample text chosen in the menu's footer). Hovering a row (or
// moving through the list with the arrow keys) previews that family on the targeted text on the canvas: a text render
// stage (S11.1) draws a detached copy of each layer with the family, without a history entry; it ends when the menu
// closes (a choice, Escape, a click outside, the window losing focus) and when the document closes.
//
// The style option is the family's real styles (`font-style`: a select of style keys); the Character panel's style row
// is replaced the same way (it keeps a `select[data-k="style"]`, the one the 0.4 spec drives). A variable family adds
// axis sliders after the panel's controls (the CharStyle `axes`, S11.4).
import { registerWidget } from '../fields.js';
import { registerTypeSection } from './sections.js';
import { registerTextRenderStage, renderBase, textBounds } from './api.js';
import { typeTargets } from './target.js';
import * as M from './model.js';
import * as fonts from './fonts.js';
import { TextLayer } from '../document.js';
import { FONT_CLASSES } from './font-tables.js';
import { registerIcons, icon } from '../icons.js';

registerIcons({
  'font-star': '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  'font-similar': '<path d="M4 9c2-2 4-2 6 0s4 2 6 0 3-2 4-1"/><path d="M4 15c2-2 4-2 6 0s4 2 6 0 3-2 4-1"/>',
});

export const CLASS_LABELS = { serif: 'Serif', 'sans-serif': 'Sans Serif', 'slab-serif': 'Slab Serif', script: 'Script', handwritten: 'Handwritten', monospace: 'Monospace', decorative: 'Decorative', blackletter: 'Blackletter' };
/** Type > Font Preview Size: the sample's size in px (none: no sample). */
export const PREVIEW_PX = { none: 0, small: 11, medium: 15, large: 20, xlarge: 26, huge: 34 };
const SAMPLES = [['Sample', 'Sample'], ['Aa', 'Aa'], ['Abc', 'Abc'], ['The quick brown fox', 'The quick brown fox'], ['$selection', 'Selected text']];
const RECENT_SHOWN = 5;

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const quote = (f) => `"${String(f).replace(/["\\]/g, '')}"`;
const familyKey = (f) => String(f ?? '').trim().toLowerCase();

/** The CSS font-family that draws a family's sample: its loaded face, else its name (installed fonts), else the UI font. */
export function cssFamilyOf(entry) {
  if (!entry) return 'inherit';
  return `${entry.cssFamily ? `"${entry.cssFamily}", ` : ''}${quote(entry.name)}, var(--font)`;
}

// ---- the hover preview (S11.1: a text render stage) -------------------------------------------------------------------

/**
 * Previews a family on the targeted text: start(app, family) draws each targeted layer as a copy in that family (its
 * styles mapped through the catalog: a run's weight and slant kept); stop() draws them as they are again. No history
 * entry, no dirty mark: starting and stopping touch the layers and send a canvas change.
 */
export function createHoverPreview(app, catalog) {
  const state = { family: null, layers: new Map(), clones: new WeakMap() }; // layer -> { doc, range }
  const patchFor = (family, style) => {
    const p = catalog.stylePatch(family, catalog.styleKey(style));
    return { ...p, fontFamily: family };
  };
  const cloneOf = (layer) => {
    const hit = state.clones.get(layer);
    if (hit && hit.content === layer.content && hit.family === state.family && hit.version === layer.version) return hit.clone;
    const info = state.layers.get(layer);
    let content = layer.content;
    const family = state.family;
    if (info?.range && info.range[1] > info.range[0]) {
      const at = M.charAttrs(content, info.range[0], info.range[0] + 1);
      content = M.applyChar(content, info.range[0], info.range[1], patchFor(family, at));
    } else content = M.mapChar(content, (style, resolved) => ({ ...style, ...patchFor(family, resolved) }));
    const clone = new TextLayer({ content, typeOptions: layer.typeOptions, x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation, pathText: layer.pathText });
    state.clones.set(layer, { clone, content: layer.content, family, version: layer.version });
    return clone;
  };
  const off = registerTextRenderStage({
    id: 'type-fonts-hover',
    order: 0,
    whileEditing: 'apply',
    extensions: true,
    test: (layer) => !!state.family && state.layers.has(layer),
    // renderBase, not renderText: the stages outside this one (warp, anti-alias) apply once, to the copy's pixels
    render: (layer) => renderBase(cloneOf(layer)),
    bounds: (layer) => textBounds(cloneOf(layer)),
  });
  const redraw = (layers) => {
    const docs = new Set();
    for (const [layer, info] of layers) {
      layer.touch?.();
      if (info.doc) docs.add(info.doc);
    }
    for (const d of docs) d.changed('canvas');
  };
  const api = {
    get family() {
      return state.family;
    },
    get layers() {
      return [...state.layers.keys()];
    },
    start(family) {
      if (!family) return api.stop();
      const t = typeTargets(app);
      const doc = app.doc;
      if (!doc || !t.layers.length) return api.stop();
      // the family's faces load in the background; the preview draws again when they arrive
      fonts.requestFamily(family);
      const prev = new Map(state.layers);
      state.layers.clear();
      for (const l of t.layers) state.layers.set(l, { doc, range: t.editing && t.from !== t.to ? [t.from, t.to] : null });
      if (state.family === family && prev.size === state.layers.size && [...prev.keys()].every((l) => state.layers.has(l))) return;
      state.family = family;
      redraw(new Map([...prev, ...state.layers]));
      app.emit('type:font-preview', { family });
    },
    stop() {
      if (!state.family) return;
      const layers = new Map(state.layers);
      state.family = null;
      state.layers.clear();
      redraw(layers);
      app.emit('type:font-preview', { family: null });
    },
    dispose() {
      api.stop();
      off();
    },
  };
  app.on('doc:closed', () => api.stop());
  return api;
}

// ---- the menu --------------------------------------------------------------------------------------------------------

let openMenu = null; // the one open font menu

/** Closes the open font menu (and ends its hover preview). */
export function closeFontMenu() {
  openMenu?.close();
}

/**
 * Opens the font menu under `anchor`: onChoose(family) when a family is picked. opts: { value (the current family),
 * initialSearch }.
 */
export function openFontMenu(app, catalog, preview, anchor, { value = '', initialSearch = '', onChoose } = {}) {
  closeFontMenu();
  const settings = () => app.settings.typeFonts ?? {};
  const pop = el('div', 'popover fp-menu');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Fonts');
  pop.dataset.fontMenu = '';
  const head = el('div', 'fp-head');
  const search = el('input', 'fp-search');
  search.type = 'search';
  search.placeholder = 'Search fonts';
  search.setAttribute('aria-label', 'Search fonts');
  search.value = initialSearch;
  const cls = el('select', 'select fp-class');
  cls.setAttribute('aria-label', 'Filter by classification');
  cls.title = 'Filter by classification';
  cls.append(new Option('All Classes', ''), ...FONT_CLASSES.map((c) => new Option(CLASS_LABELS[c], c)));
  const favBtn = el('button', 'btn small fp-fav-filter');
  favBtn.type = 'button';
  favBtn.title = 'Show favourite fonts';
  favBtn.setAttribute('aria-label', 'Show favourite fonts');
  favBtn.setAttribute('aria-pressed', 'false');
  favBtn.innerHTML = icon('font-star');
  const simBtn = el('button', 'btn small fp-similar-filter');
  simBtn.type = 'button';
  simBtn.title = 'Show similar fonts';
  simBtn.setAttribute('aria-label', 'Show similar fonts');
  simBtn.setAttribute('aria-pressed', 'false');
  simBtn.innerHTML = icon('font-similar');
  head.append(search, cls, favBtn, simBtn);
  const list = el('div', 'fp-list');
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  const spacer = el('div', 'fp-spacer');
  list.appendChild(spacer);
  const foot = el('div', 'fp-foot');
  const sampleSel = el('select', 'select fp-sample-text');
  sampleSel.setAttribute('aria-label', 'Sample text');
  sampleSel.title = 'Sample text';
  sampleSel.append(...SAMPLES.map(([v, l]) => new Option(l, v)));
  sampleSel.value = SAMPLES.some(([v]) => v === settings().sample) ? settings().sample : 'Sample';
  const sizeSel = el('select', 'select fp-preview-size');
  sizeSel.setAttribute('aria-label', 'Font preview size');
  sizeSel.title = 'Font preview size';
  sizeSel.append(...[['none', 'No preview'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra Large'], ['huge', 'Huge']].map(([v, l]) => new Option(l, v)));
  sizeSel.value = settings().previewSize ?? 'medium';
  const count = el('span', 'fp-count');
  foot.append(sampleSel, sizeSel, count);
  pop.append(head, list, foot);
  document.body.appendChild(pop);

  let favOnly = false;
  let similarTo = null;
  let items = []; // { kind: 'head', label } | { kind: 'family', entry }
  let highlight = -1;
  let rowH = 30;
  let previewTimer = 0;

  const sampleText = () => {
    const v = sampleSel.value;
    if (v !== '$selection') return v;
    const t = typeTargets(app);
    const layer = t.layer;
    if (!layer) return 'Sample';
    const text = layer.text ?? '';
    const s = t.editing && t.from !== t.to ? text.slice(t.from, t.to) : text;
    return s.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Sample';
  };
  const build = () => {
    const size = PREVIEW_PX[sizeSel.value] ?? 15;
    rowH = Math.max(26, Math.round(size * 1.7));
    const q = search.value;
    const classes = cls.value ? [cls.value] : null;
    let fams = similarTo ? catalog.similar(similarTo, { limit: 40 }) : catalog.families({ search: q, classes, favourites: favOnly });
    if (similarTo && (q || classes || favOnly)) {
      const allowed = new Set(catalog.families({ search: q, classes, favourites: favOnly }).map((f) => familyKey(f.name)));
      fams = fams.filter((f) => allowed.has(familyKey(f.name)));
    }
    items = [];
    if (!q && !classes && !favOnly && !similarTo) {
      const recent = catalog.recent.list().map((n) => catalog.family(n)).filter(Boolean).slice(0, RECENT_SHOWN);
      if (recent.length) {
        items.push({ kind: 'head', label: 'Recent' });
        for (const e of recent) items.push({ kind: 'family', entry: e, recent: true });
        items.push({ kind: 'head', label: 'All Fonts' });
      }
    } else if (similarTo) items.push({ kind: 'head', label: `Similar to ${similarTo}` });
    for (const e of fams) items.push({ kind: 'family', entry: e });
    count.textContent = `${fams.length} ${fams.length === 1 ? 'family' : 'families'}`;
    spacer.style.height = `${items.length * rowH}px`;
    // the current family is highlighted when it is listed
    const cur = items.findIndex((it) => it.kind === 'family' && !it.recent && familyKey(it.entry.name) === familyKey(value));
    highlight = q ? items.findIndex((it) => it.kind === 'family') : cur;
    // the current family in view (as the menu opens), else the top of the new list
    list.scrollTop = highlight >= 0 && !q ? Math.max(0, highlight * rowH - list.clientHeight / 2 + rowH / 2) : 0;
    paint();
  };
  const rowCache = new Map();
  const paint = () => {
    const size = PREVIEW_PX[sizeSel.value] ?? 15;
    const sample = sampleText();
    const top = list.scrollTop;
    const h = list.clientHeight || 320;
    const first = Math.max(0, Math.floor(top / rowH) - 4);
    const last = Math.min(items.length, Math.ceil((top + h) / rowH) + 4);
    const keep = new Set();
    for (let i = first; i < last; i++) {
      const it = items[i];
      const key = `${i}:${it.kind}:${it.entry?.name ?? it.label}:${size}:${sample}:${rowH}`;
      keep.add(key);
      let row = rowCache.get(key);
      if (!row) {
        row = renderRow(it, i, size, sample);
        rowCache.set(key, row);
        list.appendChild(row);
      }
      row.classList.toggle('fp-active', i === highlight);
      row.setAttribute('aria-selected', String(i === highlight));
      const star = row.querySelector('.fp-star');
      if (star) star.setAttribute('aria-pressed', String(catalog.favourites.has(it.entry.name)));
    }
    for (const [key, row] of rowCache) {
      if (keep.has(key)) continue;
      row.remove();
      rowCache.delete(key);
    }
    // document order follows the list order (assistive technology and keyboard focus read it)
    const rows = [...rowCache.values()].sort((x, y) => parseFloat(x.style.top) - parseFloat(y.style.top));
    if (rows.some((r, i) => list.children[i + 1] !== r)) list.append(...rows);
  };
  const renderRow = (it, i, size, sample) => {
    const row = el('div', it.kind === 'head' ? 'fp-heading' : 'fp-row');
    row.style.top = `${i * rowH}px`;
    row.style.height = `${rowH}px`;
    if (it.kind === 'head') {
      row.textContent = it.label;
      return row;
    }
    const e = it.entry;
    row.dataset.family = e.name;
    row.dataset.index = String(i);
    row.setAttribute('role', 'option');
    const star = el('button', 'fp-star');
    star.type = 'button';
    star.title = 'Favourite';
    star.setAttribute('aria-label', `Favourite ${e.name}`);
    star.innerHTML = icon('font-star');
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      catalog.favourites.toggle(e.name);
    });
    const name = el('span', 'fp-name', e.name);
    row.append(star, name);
    if (e.variable) row.appendChild(el('span', 'fp-badge', 'VAR'));
    if (size > 0) {
      const s = el('span', 'fp-sample', sample);
      s.style.fontFamily = cssFamilyOf(e);
      s.style.fontSize = `${size}px`;
      row.appendChild(s);
      // the bundled and added families draw their samples once their faces are loaded
      if (e.source === 'bundled' && !e.cssFamily) fonts.requestFamily(e.name);
    }
    row.addEventListener('pointerenter', () => setHighlight(i, { scroll: false }));
    row.addEventListener('click', () => choose(e.name));
    return row;
  };
  const setHighlight = (i, { scroll = true } = {}) => {
    highlight = i;
    paint();
    if (scroll && i >= 0) {
      const y = i * rowH;
      if (y < list.scrollTop) list.scrollTop = y;
      else if (y + rowH > list.scrollTop + list.clientHeight) list.scrollTop = y + rowH - list.clientHeight;
      paint();
    }
    const it = items[i];
    clearTimeout(previewTimer);
    // a short delay, so running the pointer over the list does not draw every family it crosses
    if (it?.kind === 'family') previewTimer = setTimeout(() => preview.start(it.entry.name), 60);
  };
  const move = (d) => {
    let i = highlight;
    for (let n = 0; n < items.length; n++) {
      i = Math.min(items.length - 1, Math.max(0, i + d));
      if (items[i]?.kind === 'family') break;
      if (i === 0 || i === items.length - 1) break;
    }
    if (items[i]?.kind === 'family') setHighlight(i);
  };
  let closed = false;
  const unsubs = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(previewTimer);
    preview.stop();
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('blur', onWindowBlur);
    for (const u of unsubs.splice(0)) u();
    if (openMenu === menu) openMenu = null;
  };
  const choose = (family) => {
    close();
    catalog.recent.push(family);
    onChoose?.(family);
  };
  const outside = (ev) => {
    if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
    close();
  };
  const onWindowBlur = () => close();
  const onCatalog = () => {
    if (!closed) {
      rowCache.forEach((r) => r.remove());
      rowCache.clear();
      build();
    }
  };
  search.addEventListener('input', () => build());
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      move(ev.key === 'ArrowDown' ? 1 : -1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const it = items[highlight];
      const typed = catalog.family(search.value.trim());
      if (it?.kind === 'family') choose(it.entry.name);
      else if (typed) choose(typed.name);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      anchor.focus?.();
    } else if (ev.key === 'Tab') close();
    // the app's own keys stay out of the search field
    ev.stopPropagation();
  });
  list.addEventListener('scroll', () => paint());
  list.addEventListener('pointerleave', () => {
    clearTimeout(previewTimer);
    preview.stop();
  });
  cls.addEventListener('change', () => build());
  favBtn.addEventListener('click', () => {
    favOnly = !favOnly;
    favBtn.setAttribute('aria-pressed', String(favOnly));
    build();
  });
  simBtn.addEventListener('click', () => {
    similarTo = similarTo ? null : value || null;
    simBtn.setAttribute('aria-pressed', String(!!similarTo));
    build();
  });
  sampleSel.addEventListener('change', () => {
    app.saveSettingsSoon({ typeFonts: { ...(app.settings.typeFonts ?? {}), sample: sampleSel.value } });
    rowCache.forEach((r) => r.remove());
    rowCache.clear();
    paint();
  });
  sizeSel.addEventListener('change', () => app.commands.run('type:font-preview-size', sizeSel.value, 'ui'));
  const onSettings = (patch) => {
    if (closed || !patch?.typeFonts) return;
    const size = app.settings.typeFonts?.previewSize ?? 'medium';
    if (sizeSel.value !== size) sizeSel.value = size;
    rowCache.forEach((r) => r.remove());
    rowCache.clear();
    build();
  };
  unsubs.push(app.on('settings:changed', onSettings), app.on('type:catalog-changed', onCatalog));
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('blur', onWindowBlur);

  // place the menu under the anchor, inside the window
  const r = anchor.getBoundingClientRect();
  const width = Math.max(300, Math.min(420, window.innerWidth - 16));
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  const below = window.innerHeight - r.bottom - 8;
  const height = Math.min(460, Math.max(220, below > 260 ? below : r.top - 8));
  pop.style.maxHeight = `${height}px`;
  if (below > 260 || below >= r.top) pop.style.top = `${r.bottom + 2}px`;
  else pop.style.bottom = `${window.innerHeight - r.top + 2}px`;
  list.style.height = `${Math.max(120, height - 90)}px`;

  const menu = {
    element: pop,
    anchor,
    close,
    choose,
    get items() {
      return items;
    },
  };
  openMenu = menu;
  catalog.ready().then(() => !closed && build());
  build();
  search.focus();
  search.setSelectionRange?.(search.value.length, search.value.length);
  return menu;
}

// ---- the family field (options bar and Character panel) ------------------------------------------------------------

/** The family field: shows `value` in its face; opens the font menu. onChange(family) when one is picked. */
export function createFamilyField(app, catalog, preview, { value = '', onChange, ariaLabel = 'Font family' } = {}) {
  const field = el('button', 'fp-field');
  field.type = 'button';
  field.setAttribute('aria-haspopup', 'dialog');
  field.setAttribute('aria-label', ariaLabel);
  field.title = ariaLabel;
  const label = el('span', 'fp-field-name');
  const chev = el('span', 'fp-field-chev');
  chev.innerHTML = icon('chevron-down');
  field.append(label, chev);
  let current = value;
  const show = () => {
    const e = current ? catalog.family(current) : null;
    label.textContent = current || '—';
    label.style.fontFamily = e ? cssFamilyOf(e) : '';
    field.dataset.value = current ?? '';
    field.classList.toggle('fp-missing', !!current && !catalog.known(current));
    field.title = current && !catalog.known(current) ? `${current} (missing)` : current || ariaLabel;
  };
  const open = (initialSearch = '') => {
    if (field.disabled) return;
    openFontMenu(app, catalog, preview, field, { value: current, initialSearch, onChoose: (f) => {
      current = f;
      show();
      onChange?.(f);
    } });
  };
  field.addEventListener('click', () => (openMenu?.element.isConnected && openMenu.anchor === field ? closeFontMenu() : open()));
  field.addEventListener('keydown', (ev) => {
    // typing a name into the field searches for it, as in Photoshop
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      open(ev.key);
    } else if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      open();
    }
  });
  show();
  const offCatalog = whileConnected(app, field, 'type:catalog-changed', show);
  return {
    element: field,
    get: () => current,
    set(v) {
      current = v ?? '';
      show();
    },
    setDisabled(b) {
      field.disabled = !!b;
    },
    destroy() {
      offCatalog();
      field.remove();
    },
  };
}

// ---- the style select -------------------------------------------------------------------------------------------------

/**
 * Fills a select with a family's styles (values: style keys) and selects `key` ('' shows blank: mixed). A key the
 * family has no option for (a custom axis value) gets one of its own.
 */
export function fillStyleSelect(select, catalog, family, key) {
  const e = family ? catalog.family(family) : null;
  const styles = e?.styles ?? [];
  const opts = styles.map((s) => [s.postScriptName ?? `${s.weight}${s.italic ? 'i' : ''}`, s.name]);
  const v = key === '' || key === null || key === undefined ? '' : String(key);
  if (v && !opts.some(([k]) => k === v)) {
    const base = v.split('|')[0];
    const named = opts.find(([k]) => k === base)?.[1];
    opts.push([v, named ? `${named} (custom)` : v]);
  }
  const sig = `${family}|${opts.map((o) => o.join('=')).join(',')}|${v === ''}`;
  if (select.dataset.sig !== sig) {
    select.replaceChildren(...(v === '' ? [Object.assign(new Option('', ''), { hidden: true })] : []), ...opts.map(([k, l]) => new Option(l, k)));
    if (v === '') select.firstChild.dataset.blank = '';
    select.dataset.sig = sig;
  }
  select.value = v;
  select.disabled = !styles.length;
}

/**
 * Listens to an app event for as long as `node` is in the page: panels and the options bar rebuild their controls
 * without destroying them, so a listener ends itself once its node was attached and is gone.
 */
function whileConnected(app, node, name, fn) {
  let seen = false;
  queueMicrotask(() => (seen ||= node.isConnected));
  const off = app.on(name, (detail) => {
    if (!node.isConnected) {
      if (seen) off();
      return;
    }
    seen = true;
    fn(detail);
  });
  return off;
}

/** The tool whose options include `spec` (the options bar passes the spec of the active tool's option). */
function toolOfSpec(app, spec) {
  for (const t of app.tools?.tools?.values?.() ?? []) if (t.options?.includes?.(spec)) return t;
  return app.tools?.active ?? null;
}

// ---- install ------------------------------------------------------------------------------------------------------------

/** The font widgets (E7), the Character panel's rows (E26) and the hover preview stage (E52). */
export function installPicker(app, catalog) {
  const preview = createHoverPreview(app, catalog);

  // the options bar's family: the font menu
  registerWidget('font-family', (spec, { value, onChange, app: a }) => {
    const ap = a ?? app;
    const w = createFamilyField(ap, catalog, preview, { value, onChange });
    w.element.dataset.key = spec?.key ?? 'family';
    return w;
  });
  // the options bar's style: the family's real styles
  registerWidget('font-style', (spec, { value, onChange, app: a }) => {
    const ap = a ?? app;
    const tool = toolOfSpec(ap, spec);
    const select = el('select', 'select fp-style');
    select.setAttribute('aria-label', 'Font style');
    select.title = 'Font style';
    let current = value ?? spec?.default ?? '400';
    const family = () => tool?.opt?.('family') ?? 'Arial';
    const refresh = () => fillStyleSelect(select, catalog, family(), current);
    select.addEventListener('change', () => {
      current = select.value;
      onChange(current);
    });
    const onOptions = (e) => {
      if (!select.isConnected) return;
      if (e?.tool !== tool?.id || (e.key !== 'family' && e.key !== '*')) return;
      // a family of its own: the style becomes that family's nearest one (no layer is restyled by this)
      const fam = family();
      const patch = catalog.stylePatch(fam, current);
      const next = catalog.styleKey({ fontFamily: fam, fontWeight: patch.fontWeight, fontItalic: patch.fontItalic, postScriptName: patch.postScriptName, axes: patch.axes });
      if (next !== current) {
        current = next;
        for (const t of [tool, tool?.sibling].filter(Boolean)) ap.tools.setOpt(t.id, 'style', next, { silent: true });
      }
      refresh();
    };
    const offs = [whileConnected(ap, select, 'tool:options', onOptions), whileConnected(ap, select, 'type:catalog-changed', refresh)];
    refresh();
    return {
      element: select,
      get: () => current,
      set(v) {
        current = v ?? '';
        refresh();
      },
      setDisabled(b) {
        select.disabled = !!b;
      },
      destroy() {
        for (const off of offs) off();
        select.remove();
      },
    };
  });

  // the Character panel (and the Properties text section): family and style rows, axis sliders
  const mixed = (v) => v === M.MIXED;
  registerTypeSection('character', {
    id: 'type-fonts-family',
    replaces: 'family',
    render: ({ attrs, apply }) => {
      const fam = mixed(attrs.fontFamily) ? '' : attrs.fontFamily;
      const w = createFamilyField(app, catalog, preview, {
        value: fam,
        // the runs keep their weight and slant; the face is the new family's nearest (postScriptName and axes reset)
        onChange: (f) => apply({ fontFamily: f, postScriptName: undefined, axes: undefined }),
      });
      w.element.classList.add('fp-panel-field');
      return w.element;
    },
  });
  registerTypeSection('character', {
    id: 'type-fonts-style',
    replaces: 'style',
    render: ({ attrs, apply }) => {
      const select = el('select', 'select fp-style');
      select.dataset.k = 'style';
      select.setAttribute('aria-label', 'Font style');
      const fam = mixed(attrs.fontFamily) ? null : attrs.fontFamily;
      const isMixed = mixed(attrs.fontWeight) || mixed(attrs.fontItalic) || mixed(attrs.postScriptName) || mixed(attrs.axes) || !fam;
      fillStyleSelect(select, catalog, fam, isMixed ? '' : catalog.styleKey(attrs));
      select.addEventListener('change', () => select.value && fam && apply(catalog.stylePatch(fam, select.value)));
      // the hidden built-in select keeps its own key (one `select[data-k="style"]` per panel)
      queueMicrotask(() => {
        for (const s of select.parentElement?.querySelectorAll(':scope > select[data-k="style"]') ?? []) if (s !== select) s.dataset.k = 'style-04';
      });
      return select;
    },
  });
  const axisCache = new Map(); // family -> axes (after the faces load)
  registerTypeSection('character', {
    id: 'type-fonts-axes',
    order: 5,
    test: ({ attrs }) => !mixed(attrs.fontFamily) && !!catalog.family(attrs.fontFamily)?.variable,
    render: ({ attrs, apply }) => {
      const box = el('div', 'fp-axes');
      box.dataset.family = attrs.fontFamily;
      const fill = (axes) => {
        box.replaceChildren();
        if (!axes.length) return;
        const st = { ...attrs, axes: mixed(attrs.axes) ? {} : attrs.axes ?? {} };
        const rec = (() => {
          try {
            return fonts.faceFor(st);
          } catch {
            return null;
          }
        })();
        for (const a of axes) {
          const row = el('label', 'fp-axis');
          row.dataset.axis = a.tag;
          const name = el('span', 'fp-axis-name', a.name);
          const range = el('input', 'fp-axis-range');
          range.type = 'range';
          range.min = String(a.min);
          range.max = String(a.max);
          range.step = a.max - a.min > 20 ? '1' : '0.1';
          const num = el('input', 'fp-axis-value');
          num.type = 'number';
          num.min = range.min;
          num.max = range.max;
          num.step = range.step;
          const v = mixed(attrs.axes) ? null : st.axes[a.tag] ?? rec?.coords?.[a.tag] ?? (a.tag === 'wght' && !mixed(attrs.fontWeight) ? attrs.fontWeight : a.default);
          range.value = String(v ?? a.default);
          num.value = v === null ? '' : String(Math.round(Number(v) * 10) / 10);
          let last = Number(range.value);
          const commit = (raw) => {
            const n = Math.min(a.max, Math.max(a.min, Number(raw)));
            // one change, one entry (a blur after a typed value must not apply it twice)
            if (!Number.isFinite(n) || n === last) return;
            last = n;
            const axesNow = { ...(mixed(attrs.axes) ? {} : attrs.axes ?? {}), [a.tag]: M.tidyNumber ? M.tidyNumber(n) : n };
            apply({ axes: axesNow, ...(a.tag === 'wght' ? { fontWeight: Math.round(n) } : {}) });
          };
          range.addEventListener('input', () => (num.value = range.value));
          // the panel does not redraw its sections while one of them has the focus: let go, so the style list follows
          range.addEventListener('change', () => {
            commit(range.value);
            range.blur();
          });
          num.addEventListener('change', () => {
            commit(num.value);
            num.blur();
          });
          row.append(name, range, num);
          box.appendChild(row);
        }
      };
      const fam = attrs.fontFamily;
      if (axisCache.has(fam)) fill(axisCache.get(fam));
      else catalog.axes(fam).then((axes) => {
        axisCache.set(fam, axes);
        if (box.isConnected && box.dataset.family === fam) fill(axes);
      });
      return box;
    },
  });
  app.on('type:catalog-changed', () => axisCache.clear());

  // Escape while a preview draws ends it (the menu's own Escape closes the menu)
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && preview.family) preview.stop();
  }, true);

  // tests and the other packages reach the picker's parts through the app
  app.fontPicker = { preview, open: (anchor, opts) => openFontMenu(app, catalog, preview, anchor, opts), close: closeFontMenu };
  return preview;
}
