// Color Libraries (ARCHITECTURE.md "0.5 features", S7.2; color-picker-swatches, package 11): colour books the user
// loads (.acb Adobe Color Books such as TOYO, DIC, HKS, ANPA, FOCOLTONE, TRUMATCH, or an .ase file), kept as the
// preset kind `color-books`: one preset per book, data { title, colorSpace, count, blob: 'book-<sha1>.json' }, the
// colours in the side file. No licensed books are shipped.
//
//   registerColorBooks()                 the kind and the .acb format (registerPresetFileFormat, review decision 7):
//                                        opening or dropping an .acb file adds the book
//   loadBookFiles(app, { paths? })       Load Book…: .acb through parseAcb, .ase through parseAse (preset-files-manager)
//   addBookPreset(app, book) / readBook(app, preset) / bookEntryValue(book, entry, doc) -> ColorValue
//   colorLibrariesDialog(app, { initial, doc, book, name }) -> Promise<{ book, entry } | null>
import { registerPresetKind } from './presets.js';
import { registerPresetFileFormat, importPresetBytes } from './preset-formats.js';
import { parseAse } from './preset-files/aco-ase.js';
import { sha1Hex } from './color/profiles.js';
import { fromLab, toLab } from './color/pipeline.js';
import { cmykToRgb } from '../../shared/pixels/color.js';
import { icon } from './icons.js';
import * as M from './color-picker-model.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const baseName = (p) => String(p ?? '').replace(/^.*[\\/]/, '');

/** A book's side file: { name, bytes } (the JSON of its colours, named by its hash). */
export function bookBlob(book) {
  const json = JSON.stringify({ title: book.title, prefix: book.prefix ?? '', postfix: book.postfix ?? '', description: book.description ?? '', colorSpace: book.colorSpace, colors: book.colors.map((c) => ({ name: c.name, code: c.code ?? '', color: c.color, type: c.type ?? 'spot' })) });
  const bytes = enc(json);
  return { name: `book-${sha1Hex(bytes)}.json`, bytes };
}

const bookData = (book, blob) => ({ title: book.title, colorSpace: book.colorSpace, count: book.colors.length, blob });

export function registerColorBooks() {
  registerPresetKind('color-books', {
    title: 'Color Books',
    version: 1,
    builtins: () => ({ presets: [] }), // no licensed books are shipped
    normalize: (data) => (isObject(data) && typeof data.blob === 'string' ? { title: String(data.title ?? ''), colorSpace: String(data.colorSpace ?? 'rgb'), count: Number.isFinite(data.count) ? data.count : 0, blob: data.blob } : null),
    blobs: (data) => (typeof data?.blob === 'string' ? [data.blob] : []),
  });
  registerPresetFileFormat({
    id: 'acb',
    name: 'Adobe Color Book',
    extensions: ['acb'],
    kinds: ['color-books'],
    async read(bytes, { name } = {}) {
      const book = M.parseAcb(bytes);
      const report = book.report.map((l) => `${baseName(name)}: ${l}`);
      if (!book.colors.length) {
        if (!report.length) report.push(`${baseName(name)}: the colour book holds no colours`);
        return { items: [], report };
      }
      const blob = bookBlob(book);
      return { items: [{ kind: 'color-books', name: book.title, data: bookData(book, blob.name), blobs: { [blob.name]: blob.bytes } }], report };
    },
  });
}

/** Adds a parsed book as a `color-books` preset (its side file first). */
export async function addBookPreset(app, book) {
  await app.presets.ready('color-books');
  const blob = bookBlob(book);
  await app.presets.writeBlob('color-books', blob.name, blob.bytes);
  return app.presets.add('color-books', { name: book.title, data: bookData(book, blob.name) });
}

const bookCache = new Map(); // blob name -> book
/** The colours of a `color-books` preset: { title, prefix, postfix, colorSpace, colors }, or null. */
export async function readBook(app, preset) {
  const name = preset?.data?.blob;
  if (!name) return null;
  if (bookCache.has(name)) return bookCache.get(name);
  try {
    const bytes = await app.presets.readBlob('color-books', name);
    if (!bytes) return null;
    const book = JSON.parse(dec(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
    if (!Array.isArray(book?.colors)) return null;
    bookCache.set(name, book);
    return book;
  } catch (err) {
    console.warn('A colour book could not be read', err);
    return null;
  }
}

/** RGB numbers of a book colour in the document's profile (Lab through fromLab, S6.5; CMYK 0.3's model). */
export function bookEntryRgb(entry, doc) {
  const c = entry?.color;
  const v = c?.values ?? [0, 0, 0];
  if (c?.space === 'lab') return fromLab(v.slice(0, 3), doc?.profile ?? null);
  if (c?.space === 'cmyk') return cmykToRgb(v[0], v[1], v[2], v[3]).map((x) => Math.round(x));
  if (c?.space === 'gray') return [0, 0, 0].map(() => Math.round(255 * (1 - v[0] / 100)));
  return v.slice(0, 3).map((x) => Math.round(x));
}

/** The ColorValue (S7.1) of a book colour: space 'book', its Lab or CMYK numbers kept. */
export function bookEntryValue(book, entry, doc) {
  const rgb = bookEntryRgb(entry, doc);
  const v = { hex: M.hexOfRgb(rgb), rgb, book: { book: book.title, name: M.bookColorName(book, entry) }, space: 'book' };
  if (entry.color.space === 'lab') v.lab = entry.color.values.slice(0, 3);
  if (entry.color.space === 'cmyk') v.cmyk = entry.color.values.slice(0, 4);
  return v;
}

/**
 * Load Book…: the open dialog (or `paths`), each .acb or .ase file a book. Returns the presets added; the report
 * lines (damaged files, files with no colours) show in one alert.
 */
export async function loadBookFiles(app, { paths = null } = {}) {
  const { bridge } = await import('./bridge.js');
  let list = Array.isArray(paths) ? paths : paths ? [paths] : null;
  if (!list) {
    const picked = await bridge.openFileDialog({ title: 'Load Color Book', multiple: true, filters: [{ name: 'Color books', extensions: ['acb', 'ase'] }] });
    list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  }
  const added = [];
  const report = [];
  for (const path of list) {
    const name = baseName(path);
    try {
      if (typeof window !== 'undefined' && window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
      const bytes = await bridge.readFile(path);
      if (/\.ase$/i.test(name)) {
        const book = M.bookFromAse(parseAse(bytes), name);
        report.push(...book.report.map((l) => `${name}: ${l}`));
        if (book.colors.length) added.push(await addBookPreset(app, book));
        else report.push(`${name}: the file holds no colours`);
      } else {
        const before = new Set(app.presets.list('color-books').map((p) => p.id));
        const res = await importPresetBytes(app, [{ name, bytes }], { kinds: ['color-books'] });
        report.push(...res.report);
        added.push(...app.presets.list('color-books').filter((p) => !before.has(p.id)));
      }
    } catch (err) {
      report.push(`${name}: ${err?.message ?? err}`);
    }
  }
  if (report.length) app.dialogs?.alert?.(added.length ? 'Some colour books were not loaded completely' : 'No colour book was loaded', { title: 'Load Book', detail: report.join('\n') });
  return added;
}

// ---- the dialog --------------------------------------------------------------------------------------------------

/**
 * The Color Libraries dialog: a book, its colours (type a name or code to find one), Load Book…, Remove Book.
 * Resolves { book, entry } for OK, null for Picker (back to the colour picker) or a dismissal.
 */
export async function colorLibrariesDialog(app, { initial = '#000000', doc = app.doc, book: bookTitle = null, name: colorName = null } = {}) {
  await app.presets.ready('color-books');
  const content = document.createElement('div');
  content.className = 'cl-dialog';
  content.innerHTML = `
    <div class="cl-top">
      <label class="cl-book-row">Book <select class="input" data-k="book" aria-label="Colour book"></select></label>
      <button type="button" class="btn small cl-load">${icon('folder')} Load Book…</button>
      <button type="button" class="btn small cl-remove" title="Remove this book from Pigment">${icon('trash')} Remove Book</button>
    </div>
    <input class="input cl-search" data-k="search" type="search" placeholder="Type a name or code" aria-label="Find a colour">
    <div class="cl-body">
      <div class="cl-list" role="listbox" aria-label="Colours"></div>
      <div class="cl-side">
        <div class="cl-preview"></div>
        <div class="cl-name"></div>
        <div class="cl-values muted"></div>
      </div>
    </div>
    <div class="cl-empty muted" hidden>No colour book is loaded. Pigment ships no licensed books: load an .acb or .ase book you own with Load Book….</div>`;
  const $ = (s) => content.querySelector(s);
  const select = $('[data-k="book"]'), list = $('.cl-list'), search = $('.cl-search');
  const preview = $('.cl-preview'), nameEl = $('.cl-name'), valuesEl = $('.cl-values');
  let presets = [];
  let book = null;
  let chosen = null;
  let okButton = null;
  const target = M.rgbOfHex(initial);
  const targetLab = toLab(target, doc?.profile ?? null);

  const describe = (e) => {
    const v = e.color.values.map((x) => Math.round(x * 10) / 10);
    if (e.color.space === 'lab') return `L ${v[0]}  a ${v[1]}  b ${v[2]}`;
    if (e.color.space === 'cmyk') return `C ${v[0]}  M ${v[1]}  Y ${v[2]}  K ${v[3]}`;
    if (e.color.space === 'gray') return `K ${v[0]}`;
    return `R ${v[0]}  G ${v[1]}  B ${v[2]}`;
  };
  const choose = (entry, { scroll = false } = {}) => {
    chosen = entry;
    for (const b of list.querySelectorAll('.cl-color')) b.setAttribute('aria-selected', String(b._entry === entry));
    if (!entry) {
      preview.style.background = 'transparent';
      nameEl.textContent = '';
      valuesEl.textContent = '';
    } else {
      const v = bookEntryValue(book, entry, doc);
      preview.style.background = v.hex;
      nameEl.textContent = v.book.name;
      valuesEl.textContent = `${describe(entry)}${entry.code ? `  ·  ${entry.code}` : ''}`;
      if (scroll) list.querySelector('.cl-color[aria-selected="true"]')?.scrollIntoView?.({ block: 'center' });
    }
    if (okButton) okButton.disabled = !entry;
  };
  const renderList = () => {
    list.replaceChildren();
    if (!book) return;
    for (const e of M.filterBookColors(book, search.value)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cl-color';
      b.setAttribute('role', 'option');
      b._entry = e;
      const full = M.bookColorName(book, e);
      b.dataset.name = full;
      b.innerHTML = `<span class="cl-chip"></span><span class="cl-label"></span>`;
      b.querySelector('.cl-chip').style.background = M.hexOfRgb(bookEntryRgb(e, doc));
      b.querySelector('.cl-label').textContent = full;
      b.addEventListener('click', () => choose(e));
      b.addEventListener('dblclick', () => {
        choose(e);
        okButton?.click();
      });
      list.appendChild(b);
    }
    choose(chosen && M.filterBookColors(book, search.value).includes(chosen) ? chosen : null);
  };
  // the book's colour nearest the picker's (Photoshop opens the libraries there)
  const nearest = () => {
    if (!book?.colors?.length) return null;
    if (colorName) {
      const named = book.colors.find((c) => M.bookColorName(book, c) === colorName);
      if (named) return named;
    }
    let best = null, bestD = Infinity;
    for (const c of book.colors) {
      const d = M.deltaE(toLab(bookEntryRgb(c, doc), doc?.profile ?? null), targetLab);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };
  const showBook = async (id) => {
    const p = presets.find((x) => x.id === id) ?? presets[0] ?? null;
    book = p ? await readBook(app, p) : null;
    if (book && !book.title) book.title = p.name;
    select.value = p?.id ?? '';
    search.value = '';
    chosen = nearest();
    renderList();
    choose(chosen, { scroll: true });
    $('.cl-empty').hidden = !!presets.length;
    $('.cl-remove').disabled = !p;
    if (p) app.saveSettingsSoon({ colorUI: { ...(app.settings.colorUI ?? {}), lastBook: p.id } });
  };
  const refreshBooks = async (pick = null) => {
    presets = app.presets.list('color-books');
    select.replaceChildren(...presets.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      return o;
    }));
    const wanted = pick ?? presets.find((p) => p.name === bookTitle || p.data.title === bookTitle)?.id ?? app.settings.colorUI?.lastBook;
    await showBook(presets.some((p) => p.id === wanted) ? wanted : presets[0]?.id);
  };
  select.addEventListener('change', () => showBook(select.value));
  search.addEventListener('input', () => {
    renderList();
    // typing a name jumps to the first match, as Photoshop's typed search
    const first = list.querySelector('.cl-color');
    if (first && search.value.trim()) choose(first._entry, { scroll: true });
  });
  $('.cl-load').addEventListener('click', async () => {
    const added = await loadBookFiles(app);
    if (added.length) await refreshBooks(added[added.length - 1].id);
  });
  $('.cl-remove').addEventListener('click', async () => {
    const p = presets.find((x) => x.id === select.value);
    if (!p) return;
    const ok = await app.dialogs.confirm(`Remove the colour book "${p.name}" from Pigment?`, { title: 'Remove Book', okLabel: 'Remove' });
    if (!ok) return;
    app.presets.remove('color-books', [p.id]);
    await refreshBooks();
  });
  await refreshBooks();

  const res = await app.dialogs.open({
    title: 'Color Libraries',
    content,
    width: 560,
    className: 'color-libraries-dialog',
    buttons: [{ label: 'Picker', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: (dialogEl) => {
      okButton = dialogEl.querySelector('.dialog-buttons .btn.primary');
      if (okButton) okButton.disabled = !chosen;
      search.focus();
    },
  });
  return res && book && chosen ? { book, entry: chosen } : null;
}
