// Paragraph panel (type-paragraph-panel, ARCHITECTURE.md "0.4 features (contracts)", package 4; A, B.2, B.7, L.1,
// L.14, M.7): the seven alignments, indents, space before and after, Hyphenate with the Hyphenation dialog, the
// Justification dialog, Roman Hanging Punctuation, Adobe's Single-line and Every-line composers, bulleted and numbered
// lists, Reset Paragraph and the options bar's Character / Paragraph toggle. It also registers what lays paragraphs out
// with the type facade: the two composers (lib/type/paragraph.js), the UAX 14 breaker (lib/type/line-breaks.js), the
// TeX-pattern hyphenator (lib/type/hyphenation.js) and the list formatter.
//
// Everything acts through lib/type/target.js, as the Character panel does: while text is edited, on the paragraphs
// the selection touches (a caret: its paragraph); otherwise on every selected text layer, one history entry per change
// whatever the number of layers; with no text layer targeted, on the defaults for new text (settings.type.para and
// the type tools' alignment). Mixed values show blank.
import * as M from '../type/model.js';
import * as api from '../type/api.js';
import { typeTargets, readPara, readChar, applyPara, editTypeLayers, typeDefaults, setTypeDefaults } from '../type/target.js';
import { typeSections } from '../type/sections.js';
import { typeUnit, toUnit, fromUnit, formatNumber, showLength } from '../type/char-values.js';
import { singleLineComposer, everyLineComposer, listFormatter, LIST_MARKERS, resetParagraphPatch, listPatch, mergeChanged } from '../type/paragraph.js';
import { breaker } from '../type/line-breaks.js';
import { hyphenateWord, HYPHENATION_LANGUAGES, patternLanguage, ensureLanguage, onLanguageLoaded } from '../type/hyphenation.js';
import { numericField } from '../numeric-field.js';
import { icon, registerIcons } from '../icons.js';
import { typeSession } from '../tools/text.js';

const TYPE_TOOLS = ['type-horizontal', 'type-vertical'];

registerIcons({
  paragraph: '<path d="M10 20V4h8M15 20V4"/><path d="M10 4a4 4 0 0 0 0 8"/>',
  'justify-left': '<path d="M4 5h16M4 9h16M4 13h16M4 17h9"/>',
  'justify-center': '<path d="M4 5h16M4 9h16M4 13h16M7.5 17h9"/>',
  'justify-right': '<path d="M4 5h16M4 9h16M4 13h16M11 17h9"/>',
  'justify-all': '<path d="M4 5h16M4 9h16M4 13h16M4 17h16"/>',
  'text-left': '<path d="M4 5h16M4 9h11M4 13h16M4 17h11"/>',
  'text-center': '<path d="M4 5h16M6.5 9h11M4 13h16M6.5 17h11"/>',
  'text-right': '<path d="M4 5h16M9 9h11M4 13h16M9 17h11"/>',
  'indent-left': '<path d="M9 5h11M9 9h11M9 13h11M9 17h11"/><path d="M3 8l3 3-3 3"/>',
  'indent-right': '<path d="M4 5h11M4 9h11M4 13h11M4 17h11"/><path d="M21 8l-3 3 3 3"/>',
  'indent-first': '<path d="M10 6h10M4 10h16M4 14h16M4 18h16"/><path d="M3 3.5l3 2.5-3 2.5"/>',
  'space-before': '<path d="M4 12h16M4 16h16M4 20h10"/><path d="M12 3v6M9.5 6.5 12 9l2.5-2.5"/>',
  'space-after': '<path d="M4 4h16M4 8h16M4 12h10"/><path d="M12 21v-6M9.5 17.5 12 15l2.5 2.5"/>',
  'list-bullet': '<circle cx="5" cy="7" r="1.3"/><circle cx="5" cy="12" r="1.3"/><circle cx="5" cy="17" r="1.3"/><path d="M9 7h11M9 12h11M9 17h11"/>',
  'list-number': '<path d="M4 5h1.5v4M4 9h3M4 14.5c.5-1 2.5-1 2.7 0 .2 1-2.7 2-2.7 3.5h3"/><path d="M10 7h10M10 12h10M10 17h10"/>',
});

// [align value, title, icon]
export const ALIGNS = Object.freeze([
  ['left', 'Left align text', 'text-left'],
  ['center', 'Center text', 'text-center'],
  ['right', 'Right align text', 'text-right'],
  ['justify-left', 'Justify last left', 'justify-left'],
  ['justify-center', 'Justify last centered', 'justify-center'],
  ['justify-right', 'Justify last right', 'justify-right'],
  ['justify-all', 'Justify all', 'justify-all'],
]);

/** The resolution the type units convert with: the active document's (72 ppi without one). */
const docDpi = (app) => (Number(app?.doc?.dpi) > 0 ? Number(app.doc.dpi) : 72);

// ---- applying -----------------------------------------------------------------------------------------------------------

const targeted = (app) => {
  const t = typeTargets(app);
  return t.editing || t.layers.length > 0;
};

/**
 * Applies a paragraph patch to what the panels target (B.7): the paragraphs of the selection, else the selected text
 * layers (one history entry), else the defaults for new text. The alignment of new text is the type tools' option
 * (setTypeDefaults writes it there).
 */
export function applyParagraph(app, patch, { label = 'Paragraph', merge = false } = {}) {
  if (targeted(app)) {
    applyPara(app, patch, { label, merge });
    return;
  }
  setTypeDefaults(app, { para: patch });
  app.emit('type:selection', { layer: null, from: null, to: null });
}

/**
 * Changes each targeted paragraph by its own style: fn(resolvedStyle) -> patch. The dialogs use it so that a field
 * left blank (several values) keeps every paragraph's own value. One history entry (or one session step).
 */
export function editParagraphs(app, fn, { label = 'Paragraph' } = {}) {
  const t = typeTargets(app);
  const each = (content, from, to) => {
    let out = content;
    for (const p of M.paragraphs(content)) {
      // a caret touches its paragraph; a range every paragraph it overlaps (as model applyPara)
      const touches = from === to ? from >= p.from && from <= p.to : p.from <= to && p.to >= from;
      if (!touches) continue;
      const patch = fn(p.style);
      if (patch && Object.keys(patch).length) out = M.applyPara(out, p.from, p.from, patch);
    }
    return out;
  };
  if (t.editing) {
    const s = typeSession(app)?.typeSessionApi?.();
    if (s) s.edit((content, from, to) => ({ content: each(content, from, to), from, to }), { label });
    return;
  }
  if (t.layers.length) {
    editTypeLayers(app, t.layers, (l) => ({ content: each(l.content, 0, M.contentLength(l.content)) }), { label, keys: ['paragraph'] });
    return;
  }
  const cur = typeDefaults(app).para;
  setTypeDefaults(app, { para: fn(cur) ?? {} });
  app.emit('type:selection', { layer: null, from: null, to: null });
}

/** Reset Paragraph (type:reset-paragraph): every paragraph attribute back to Photoshop's defaults. */
export function resetParagraph(app) {
  if (targeted(app)) applyPara(app, resetParagraphPatch(), { label: 'Reset Paragraph' });
  else {
    // the defaults for new text: settings.type.para emptied, the tools' alignment back to left
    setTypeDefaults(app, { para: { ...Object.fromEntries(Object.keys(app.settings?.type?.para ?? {}).map((k) => [k, undefined])), align: 'left' } });
    app.emit('type:selection', { layer: null, from: null, to: null });
  }
}

/** Turns a list on or off for the targeted paragraphs (Bulleted List / Numbered List buttons). */
export function toggleList(app, type) {
  const attrs = readPara(app);
  const char = readChar(app);
  const size = Number.isFinite(char.size) ? char.size : M.CHAR_DEFAULTS.size;
  const cur = attrs.list;
  const on = !(cur && cur !== M.MIXED && cur.type === type);
  applyParagraph(app, listPatch(on ? type : null, { current: cur === M.MIXED ? null : cur, indentLeft: attrs.indentLeft, size }), { label: type === 'number' ? 'Numbered List' : 'Bulleted List' });
}

// ---- small DOM helpers ----------------------------------------------------------------------------------------------------

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/**
 * A number field that commits on change, ignores a commit of the value it already shows (a blur after Enter, a
 * re-render), and does not overwrite what is being typed. `onCommit(v)` gets the typed number.
 */
function guardedField(spec, onCommit) {
  let shown = '';
  let dirty = false;
  const f = numericField({
    ...spec,
    onChange: (v) => {
      dirty = false;
      if (v === null || formatNumber(v, 4) === shown) return;
      shown = formatNumber(v, 4);
      onCommit(v);
    },
  });
  f.input.removeAttribute('min');
  f.input.removeAttribute('max');
  f.input.addEventListener('input', () => (dirty = true));
  f.show = (v) => {
    shown = v === '' || v === null || v === undefined ? '' : formatNumber(Number(v), 4);
    if (dirty && document.activeElement === f.input) return;
    dirty = false;
    f.set(v === null || v === undefined ? '' : v);
  };
  return f;
}

function iconLabel(name, title) {
  const s = el('span', 'para-icon', icon(name));
  s.title = title;
  return s;
}

// ---- the controls (Paragraph panel and Properties) ------------------------------------------------------------------------

/**
 * Builds the paragraph controls. `variant` 'panel' or 'properties' (which adds a button to the panel). Returns
 * { element, refresh(), unit, destroy() }. Rows carry the L.14 ids (align, indents, spacing, hyphenate, plus list);
 * the sections registered for 'paragraph' render after them, or in place of a row they `replaces`.
 */
export function createParagraphControls(app, { variant = 'panel' } = {}) {
  const root = el('div', `para-controls para-v-${variant}`);
  const unit = typeUnit(app.settings);
  const dpiOf = () => docDpi(app);
  const rows = new Map();
  const row = (id, ...children) => {
    const r = el('div', 'para-row');
    r.dataset.row = id;
    r.append(...children);
    rows.set(id, r);
    root.appendChild(r);
    return r;
  };
  const apply = (patch, opts) => applyParagraph(app, patch, opts);

  // the seven alignments
  const aligns = el('div', 'para-aligns');
  aligns.setAttribute('role', 'group');
  aligns.setAttribute('aria-label', 'Alignment');
  for (const [value, title, ic] of ALIGNS) {
    const b = el('button', 'para-align', icon(ic));
    b.type = 'button';
    b.dataset.align = value;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', () => apply({ align: value }, { label: 'Alignment' }));
    aligns.appendChild(b);
  }
  row('align', aligns);

  // indents and spacing: px in the model, shown in the type unit
  const lengthField = (key, title, ic, labelText) => {
    const f = guardedField({ key, step: unit === 'mm' ? 0.1 : 1, unit, units: undefined, dpi: dpiOf, width: 60 }, (v) => {
      const px = fromUnit(v, unit, dpiOf());
      if (Number.isFinite(px)) apply({ [key]: M.tidyNumber(Math.max(-10000, Math.min(10000, px))) }, { label: labelText });
    });
    f.input.title = title;
    f.input.setAttribute('aria-label', title);
    const cell = el('span', 'para-cell');
    cell.append(iconLabel(ic, title), f.element);
    return { cell, field: f };
  };
  const indentLeft = lengthField('indentLeft', 'Indent left margin', 'indent-left', 'Indent Left');
  const indentRight = lengthField('indentRight', 'Indent right margin', 'indent-right', 'Indent Right');
  const indentFirst = lengthField('indentFirst', 'Indent first line', 'indent-first', 'Indent First Line');
  const indents = el('div', 'para-grid');
  indents.append(indentLeft.cell, indentRight.cell, indentFirst.cell);
  row('indents', indents);
  const spaceBefore = lengthField('spaceBefore', 'Add space before paragraph', 'space-before', 'Space Before');
  const spaceAfter = lengthField('spaceAfter', 'Add space after paragraph', 'space-after', 'Space After');
  const spacing = el('div', 'para-grid');
  spacing.append(spaceBefore.cell, spaceAfter.cell);
  row('spacing', spacing);

  // Hyphenate
  const hyLabel = el('label', 'checkbox para-hyphenate');
  const hyphenate = el('input');
  hyphenate.type = 'checkbox';
  hyphenate.dataset.k = 'hyphenate';
  hyLabel.append(hyphenate, document.createTextNode('Hyphenate'));
  hyphenate.addEventListener('change', () => apply({ hyphenate: hyphenate.checked }, { label: 'Hyphenate' }));
  row('hyphenate', hyLabel);

  // lists (Photoshop 2024's bulleted and numbered lists)
  const listBtn = (type, title, ic) => {
    const b = el('button', 'para-list-btn', icon(ic));
    b.type = 'button';
    b.dataset.list = type;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', () => toggleList(app, type));
    return b;
  };
  const bullets = listBtn('bullet', 'Bulleted list', 'list-bullet');
  const numbers = listBtn('number', 'Numbered list', 'list-number');
  const marker = el('select', 'select para-marker');
  marker.dataset.k = 'listMarker';
  marker.setAttribute('aria-label', 'List marker');
  marker.title = 'List marker';
  marker.addEventListener('change', () => {
    const cur = readPara(app).list;
    if (!cur || cur === M.MIXED || !marker.value) return;
    apply({ list: { ...cur, marker: marker.value } }, { label: 'List Marker' });
  });
  const startField = guardedField({ key: 'listStart', step: 1, width: 48 }, (v) => {
    const cur = readPara(app).list;
    if (!cur || cur === M.MIXED) return;
    apply({ list: { ...cur, start: Math.max(0, Math.min(9999, Math.round(v))) } }, { label: 'List Start' });
  });
  startField.input.title = 'Start numbering at';
  startField.input.setAttribute('aria-label', 'Start numbering at');
  const levelField = guardedField({ key: 'listLevel', step: 1, width: 40 }, (v) => {
    const cur = readPara(app).list;
    if (!cur || cur === M.MIXED) return;
    apply({ list: { ...cur, level: Math.max(0, Math.min(8, Math.round(v) - 1)) } }, { label: 'List Level' });
  });
  levelField.input.title = 'List level (1 to 9)';
  levelField.input.setAttribute('aria-label', 'List level');
  const listExtras = el('span', 'para-list-extras');
  listExtras.append(marker, el('span', 'muted', 'Start'), startField.element, el('span', 'muted', 'Level'), levelField.element);
  row('list', bullets, numbers, listExtras);

  // registered sections (L.14) after the built-in controls
  const sectionsBox = el('div', 'para-sections');
  root.appendChild(sectionsBox);

  let actions = null;
  if (variant === 'properties') {
    actions = el('div', 'props-actions');
    root.appendChild(actions);
  }

  function renderSections(attrs) {
    if (sectionsBox.contains(document.activeElement)) return;
    for (const r of rows.values()) {
      r.querySelector(':scope > .para-replaced')?.remove();
      for (const c of r.children) if (c.dataset.replacedBy) {
        c.hidden = false;
        delete c.dataset.replacedBy;
      }
    }
    sectionsBox.replaceChildren();
    const ctx = { app, attrs, apply: (patch) => apply(patch), unit };
    for (const spec of typeSections('paragraph')) {
      try {
        if (spec.test && !spec.test(ctx)) continue;
        const node = spec.render(ctx);
        if (!node) continue;
        const target = spec.replaces ? rows.get(spec.replaces) : null;
        if (target) {
          for (const c of target.children) if (!c.hidden) {
            c.hidden = true;
            c.dataset.replacedBy = spec.id;
          }
          node.classList.add('para-replaced');
          target.appendChild(node);
        } else sectionsBox.appendChild(node);
      } catch (err) {
        console.warn(`type section ${spec.id} failed`, err);
      }
    }
  }

  function refresh() {
    const t = typeTargets(app);
    const attrs = readPara(app);
    const dpi = dpiOf();
    root.dataset.target = t.editing ? 'editing' : t.layers.length ? 'layers' : 'defaults';
    for (const b of aligns.children) b.setAttribute('aria-pressed', String(attrs.align === b.dataset.align));
    aligns.dataset.mixed = String(attrs.align === M.MIXED);
    indentLeft.field.show(showLength(attrs.indentLeft, unit, dpi));
    indentRight.field.show(showLength(attrs.indentRight, unit, dpi));
    indentFirst.field.show(showLength(attrs.indentFirst, unit, dpi));
    spaceBefore.field.show(showLength(attrs.spaceBefore, unit, dpi));
    spaceAfter.field.show(showLength(attrs.spaceAfter, unit, dpi));
    hyphenate.indeterminate = attrs.hyphenate === M.MIXED;
    hyphenate.checked = attrs.hyphenate === true;
    // lists
    const list = attrs.list;
    const type = list && list !== M.MIXED ? list.type : null;
    bullets.setAttribute('aria-pressed', list === M.MIXED ? 'mixed' : String(type === 'bullet'));
    numbers.setAttribute('aria-pressed', list === M.MIXED ? 'mixed' : String(type === 'number'));
    listExtras.hidden = !type;
    if (type) {
      const options = type === 'number'
        ? LIST_MARKERS.number.map((m) => [m, { decimal: '1. 2. 3.', 'lower-alpha': 'a. b. c.', 'upper-alpha': 'A. B. C.', 'lower-roman': 'i. ii. iii.', 'upper-roman': 'I. II. III.' }[m]])
        : LIST_MARKERS.bullet.map((m) => [m, m]);
      const want = options.map(([v]) => v).join('|');
      if (marker.dataset.list !== want) {
        marker.replaceChildren(...options.map(([v, l]) => new Option(l, v)));
        marker.dataset.list = want;
      }
      if (document.activeElement !== marker) {
        if (![...marker.options].some((o) => o.value === list.marker)) marker.add(new Option(list.marker, list.marker));
        marker.value = list.marker;
      }
      startField.element.hidden = type !== 'number';
      startField.element.previousElementSibling.hidden = type !== 'number';
      startField.show(list.start ?? 1);
      levelField.show((list.level ?? 0) + 1);
    }
    if (actions) {
      actions.replaceChildren();
      if (app.panels.panels?.has?.('paragraph')) {
        const b = el('button', 'btn small', `${icon('paragraph')}<span>Paragraph…</span>`);
        b.type = 'button';
        b.title = 'Show the Paragraph panel';
        b.addEventListener('click', () => app.panels.show('paragraph', { reveal: true }));
        actions.appendChild(b);
      }
    }
    renderSections(attrs);
    return attrs;
  }

  return {
    element: root,
    refresh,
    unit,
    destroy() {
      root.remove();
    },
  };
}

// ---- the panel menu -----------------------------------------------------------------------------------------------------

/** Photoshop's Paragraph panel menu (plus Pigment's line-break rules). */
export function paragraphMenuItems(app) {
  const a = readPara(app);
  const run = (id) => () => app.commands.run(id, undefined, 'panel');
  return [
    { label: 'Roman Hanging Punctuation', checked: a.hangingPunctuation === true, onSelect: () => applyParagraph(app, { hangingPunctuation: a.hangingPunctuation !== true }, { label: 'Roman Hanging Punctuation' }) },
    { type: 'separator' },
    { label: 'Justification…', onSelect: run('type:justification-settings') },
    { label: 'Hyphenation…', onSelect: run('type:hyphenation-settings') },
    { type: 'separator' },
    { label: 'Adobe Single-line Composer', checked: a.composer === 'single', onSelect: () => applyParagraph(app, { composer: 'single' }, { label: 'Composer' }) },
    { label: 'Adobe Every-line Composer', checked: a.composer === 'every', onSelect: () => applyParagraph(app, { composer: 'every' }, { label: 'Composer' }) },
    { type: 'separator' },
    { type: 'title', label: 'Line breaks' },
    { label: 'Standard (Unicode)', checked: a.breakRules === 'standard', onSelect: () => applyParagraph(app, { breakRules: 'standard' }, { label: 'Line Breaks' }) },
    { label: 'At Spaces Only (Pigment 0.3)', checked: a.breakRules === 'legacy', onSelect: () => applyParagraph(app, { breakRules: 'legacy' }, { label: 'Line Breaks' }) },
    { type: 'separator' },
    { label: 'Reset Paragraph', onSelect: run('type:reset-paragraph') },
  ];
}

// ---- the dialogs ------------------------------------------------------------------------------------------------------------

/**
 * A number input for the dialogs: blank with "Mixed" for several values; `touched` tells whether the user changed it
 * (only changed fields are applied, so each paragraph keeps its own value for the others).
 */
function dialogNumber({ key, value, min, max, step = 1, title }) {
  const f = numericField({ key, step, width: 64 });
  f.input.removeAttribute('min');
  f.input.removeAttribute('max');
  const mixed = value === M.MIXED || value === undefined;
  f.set(mixed ? '' : value);
  if (mixed) f.input.placeholder = 'Mixed';
  if (title) f.input.title = title;
  let touched = false;
  f.input.addEventListener('input', () => (touched = true));
  return {
    element: f.element,
    input: f.input,
    get touched() {
      return touched && f.input.value !== '';
    },
    value: () => {
      const v = Number(f.input.value);
      return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null;
    },
  };
}

function dialogCheck(key, label, value) {
  const wrap = el('label', 'checkbox');
  const input = el('input');
  input.type = 'checkbox';
  input.dataset.key = key;
  input.indeterminate = value === M.MIXED;
  input.checked = value === true;
  let touched = false;
  input.addEventListener('change', () => (touched = true));
  wrap.append(input, document.createTextNode(label));
  return { element: wrap, input, get touched() {
    return touched;
  }, value: () => input.checked };
}

const sub = (obj, k) => (obj === M.MIXED || !obj ? M.MIXED : obj[k]);

/**
 * Photoshop's Hyphenation dialog. Reads readPara(app, { deep: true }) so each field shows its own mixed state; OK
 * applies the changed fields only, as one history entry.
 */
export async function hyphenationDialog(app) {
  const a = readPara(app, { deep: true });
  const hy = a.hyphenation;
  const unit = typeUnit(app.settings);
  const dpi = docDpi(app);
  const zoneVal = sub(hy, 'zone');
  const f = {
    hyphenate: dialogCheck('hyphenate', 'Hyphenate', a.hyphenate),
    minWord: dialogNumber({ key: 'minWord', value: sub(hy, 'minWord'), min: 2, max: 25 }),
    after: dialogNumber({ key: 'after', value: sub(hy, 'after'), min: 1, max: 15 }),
    before: dialogNumber({ key: 'before', value: sub(hy, 'before'), min: 1, max: 15 }),
    limit: dialogNumber({ key: 'limit', value: sub(hy, 'limit'), min: 0, max: 25, title: '0: no limit' }),
    zone: dialogNumber({ key: 'zone', value: zoneVal === M.MIXED ? M.MIXED : Number(formatNumber(toUnit(zoneVal, unit, dpi), 2)), min: 0, max: toUnit(10000, unit, dpi), step: unit === 'mm' ? 0.1 : 1 }),
    capitalized: dialogCheck('capitalized', 'Hyphenate Capitalized Words', sub(hy, 'capitalized')),
    lastWord: dialogCheck('lastWord', 'Hyphenate Last Word', sub(hy, 'lastWord')),
  };
  const content = el('div', 'para-dialog para-hyphenation');
  content.appendChild(f.hyphenate.element);
  const grid = el('div', 'para-dialog-grid');
  const line = (label, field, after) => grid.append(el('span', 'para-dialog-label', label), field.element, el('span', 'muted', after));
  line('Words Longer Than:', f.minWord, 'letters');
  line('After First:', f.after, 'letters');
  line('Before Last:', f.before, 'letters');
  line('Hyphen Limit:', f.limit, 'hyphens');
  line('Hyphenation Zone:', f.zone, unit);
  content.append(grid, f.capitalized.element, f.lastWord.element);
  const lang = readChar(app).language;
  if (lang !== M.MIXED && !patternLanguage(lang)) content.appendChild(el('p', 'muted para-note', `No hyphenation patterns for ${lang}: text in it is not hyphenated.`));
  const ok = await app.dialogs.open({
    title: 'Hyphenation',
    content,
    width: 380,
    className: 'para-hyphenation-dialog',
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: (dialog) => f.minWord.input.focus(),
  });
  if (!ok) return false;
  const changes = {};
  for (const k of ['minWord', 'after', 'before', 'limit']) if (f[k].touched) changes[k] = Math.round(f[k].value());
  if (f.zone.touched) changes.zone = M.tidyNumber(fromUnit(f.zone.value(), unit, dpi));
  for (const k of ['capitalized', 'lastWord']) if (f[k].touched) changes[k] = f[k].value();
  const hyphenateChanged = f.hyphenate.touched;
  if (!hyphenateChanged && !Object.keys(changes).length) return true;
  editParagraphs(app, (style) => {
    const patch = {};
    if (hyphenateChanged) patch.hyphenate = f.hyphenate.value();
    if (Object.keys(changes).length) patch.hyphenation = mergeChanged(style.hyphenation, changes);
    return patch;
  }, { label: 'Hyphenation' });
  return true;
}

const SINGLE_WORD = [['justify-all', 'Full Justify'], ['left', 'Align Left'], ['center', 'Align Center'], ['right', 'Align Right']];

/** Photoshop's Justification dialog (word and letter spacing, glyph scaling, auto leading, single word justification). */
export async function justificationDialog(app) {
  const a = readPara(app, { deep: true });
  const j = a.justification;
  const rowsDef = [
    ['word', 'Word Spacing:', 0, 1000],
    ['letter', 'Letter Spacing:', -100, 500],
    ['glyph', 'Glyph Scaling:', 50, 200],
  ];
  const content = el('div', 'para-dialog para-justification');
  const grid = el('div', 'para-just-grid');
  grid.append(el('span'), el('span', 'para-dialog-head', 'Minimum'), el('span', 'para-dialog-head', 'Desired'), el('span', 'para-dialog-head', 'Maximum'));
  const fields = {};
  for (const [key, label, min, max] of rowsDef) {
    const arr = sub(j, key);
    fields[key] = [0, 1, 2].map((i) => dialogNumber({ key: `${key}${['Min', 'Des', 'Max'][i]}`, value: arr === M.MIXED ? M.MIXED : arr[i], min, max }));
    grid.append(el('span', 'para-dialog-label', label), ...fields[key].map((x) => {
      const c = el('span', 'para-pct');
      c.append(x.element, el('span', 'muted', '%'));
      return c;
    }));
  }
  const autoLeading = dialogNumber({ key: 'autoLeading', value: sub(j, 'autoLeading'), min: 0, max: 500 });
  const al = el('span', 'para-pct');
  al.append(autoLeading.element, el('span', 'muted', '%'));
  grid.append(el('span', 'para-dialog-label', 'Auto Leading:'), al);
  content.appendChild(grid);
  const singleWord = el('select', 'select');
  singleWord.dataset.key = 'singleWord';
  const sw = sub(j, 'singleWord');
  if (sw === M.MIXED) singleWord.add(new Option('', ''));
  for (const [v, l] of SINGLE_WORD) singleWord.add(new Option(l, v));
  singleWord.value = sw === M.MIXED ? '' : sw;
  let swTouched = false;
  singleWord.addEventListener('change', () => (swTouched = singleWord.value !== ''));
  const swRow = el('label', 'para-single-word', '<span class="para-dialog-label">Single Word Justification:</span>');
  swRow.appendChild(singleWord);
  content.appendChild(swRow);
  const error = el('p', 'para-error');
  error.hidden = true;
  content.appendChild(error);
  const collect = () => {
    const changes = {};
    for (const [key] of rowsDef) {
      const t = fields[key].map((x) => (x.touched ? x.value() : null));
      if (t.some((v) => v !== null)) changes[key] = t;
    }
    if (autoLeading.touched) changes.autoLeading = autoLeading.value();
    if (swTouched) changes.singleWord = singleWord.value;
    return changes;
  };
  const ok = await app.dialogs.open({
    title: 'Justification',
    content,
    width: 440,
    className: 'para-justification-dialog',
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    // Minimum ≤ Desired ≤ Maximum where all three are known (blank fields keep each paragraph's own)
    validate: () => {
      for (const [key, label] of rowsDef) {
        const v = fields[key].map((x) => (x.input.value === '' ? null : x.value()));
        if (v.every((x) => x !== null) && !(v[0] <= v[1] && v[1] <= v[2])) {
          error.textContent = `${label.replace(':', '')}: the minimum cannot be more than the desired value, nor the desired value more than the maximum.`;
          error.hidden = false;
          return false;
        }
      }
      return true;
    },
  });
  if (!ok) return false;
  const changes = collect();
  if (!Object.keys(changes).length) return true;
  editParagraphs(app, (style) => {
    const cur = style.justification;
    const next = { ...cur };
    for (const [key] of rowsDef) if (changes[key]) next[key] = cur[key].map((v, i) => (changes[key][i] === null ? v : changes[key][i]));
    if ('autoLeading' in changes) next.autoLeading = changes.autoLeading;
    if ('singleWord' in changes) next.singleWord = changes.singleWord;
    return { justification: next };
  }, { label: 'Justification' });
  return true;
}

// ---- new text, the toggle and the panel ---------------------------------------------------------------------------------------

/**
 * New text starts with the paragraph defaults (B.7): the Type tool builds a new layer from 0.3's flat font, which
 * marks its paragraph `composer: 'single'`, `breakRules: 'legacy'` (fromLegacy, meant for version 2 files). A new layer
 * gets the defaults' composer and line-break rules instead (Photoshop's: Every-line, Unicode breaks), before anything
 * is typed, so they belong to the creation entry.
 */
function newTextParagraphs(app, layer) {
  const s = typeSession(app)?.session;
  if (!s?.isNew || s.layer !== layer || s.paraDefaultsApplied) return;
  s.paraDefaultsApplied = true;
  const want = typeDefaults(app).para;
  const content = layer.content;
  const paras = M.paragraphs(content);
  if (!paras.some((p) => p.style.composer !== want.composer || p.style.breakRules !== want.breakRules)) return;
  const next = M.applyPara(content, 0, M.contentLength(content), { composer: want.composer, breakRules: want.breakRules });
  if (next === content) return;
  layer.content = next;
  layer.touch();
  s.editor?.invalidate?.();
  s.doc?.changed?.('props', { layer });
}

let lastToggle = null; // set when the toggle showed the type panels: { previous tab of their group }
let front = 'character'; // the type panel the toggle shows: the one that was in front when it last hid them

/**
 * type:toggle-panels (the Type tool's options-bar button, M.7): shows the Character and Paragraph panels (Character in
 * front the first time, afterwards the one that was in front when they were last hidden); pressed again while one of
 * them is in front, it brings back the panel their group showed before.
 */
export function togglePanels(app) {
  const panels = app.panels;
  const shown = ['character', 'paragraph'].find((id) => panels.isVisible(id));
  if (shown && lastToggle) {
    front = shown;
    const back = lastToggle.previous;
    lastToggle = null;
    if (back && panels.panels?.has?.(back)) panels.show(back, { reveal: true });
    return;
  }
  const group = panels.panels?.get?.('character')?.group;
  const previous = group?.current && !['character', 'paragraph'].includes(group.current) ? group.current : null;
  const id = front === 'paragraph' && panels.panels?.has?.('paragraph') ? 'paragraph' : 'character';
  app.commands.run(`window:panel-${id}`, undefined, 'api');
  lastToggle = { previous };
}

export function install(app) {
  // the line-breaking plug-ins of the type facade (B.2)
  api.registerComposer(singleLineComposer);
  api.registerComposer(everyLineComposer);
  api.registerBreaker(breaker);
  api.registerHyphenator(hyphenateWord, { languages: Object.keys(HYPHENATION_LANGUAGES) });
  // regional tags ('de-AT', 'en-AU', 'pt-BR') hyphenate with the bundled language they belong to; the facade matches
  // tags exactly, and a hyphenator with no languages answers for any tag
  api.registerHyphenator((word, lang) => (patternLanguage(lang) ? hyphenateWord(word, lang) : null), { languages: [] });
  // registering a list formatter relays out the open documents (B.2), so text opened before this module installed
  // picks up the composers above too
  api.registerListFormatter(listFormatter);

  // patterns load on demand; when a language arrives, text that hyphenates is laid out again (no history entry)
  onLanguageLoaded(() => {
    const any = (app.docs?.list?.() ?? []).some((d) => d.layers().some((l) => l.type === 'text' && M.paragraphs(l.content).some((p) => p.style.hyphenate)));
    if (any) api.fontsChanged();
  });
  ensureLanguage('en-US');

  app.commands.register('type:reset-paragraph', { label: 'Reset Paragraph', run: () => resetParagraph(app) });
  app.commands.register('type:hyphenation-settings', { label: 'Hyphenation…', run: () => hyphenationDialog(app) });
  app.commands.register('type:justification-settings', { label: 'Justification…', run: () => justificationDialog(app) });
  app.commands.register('type:toggle-panels', { label: 'Toggle the Character and Paragraph Panels', run: () => togglePanels(app) });

  app.on('type:session', ({ layer } = {}) => {
    if (layer) newTextParagraphs(app, layer);
  });

  // the panel
  const root = el('div', 'para-panel');
  const head = el('div', 'para-head');
  const empty = el('div', 'panel-empty para-empty', 'No text layer selected. These settings apply to new text.');
  empty.hidden = true;
  const menuBtn = el('button', 'pbtn para-menu', icon('more'));
  menuBtn.type = 'button';
  menuBtn.dataset.act = 'menu';
  menuBtn.title = 'Paragraph panel menu';
  menuBtn.setAttribute('aria-label', 'Paragraph panel menu');
  menuBtn.addEventListener('click', () => app.dialogs.popover(menuBtn, paragraphMenuItems(app), { align: 'right' }));
  head.append(empty, menuBtn);
  root.appendChild(head);
  let controls = createParagraphControls(app, { variant: 'panel' });
  root.appendChild(controls.element);

  let pending = 0;
  function refresh() {
    pending = 0;
    if (app.panels.panels?.has?.('paragraph') && !app.panels.isVisible('paragraph')) return;
    if (controls.unit !== typeUnit(app.settings)) {
      const next = createParagraphControls(app, { variant: 'panel' });
      controls.element.replaceWith(next.element);
      controls.destroy();
      controls = next;
    }
    controls.refresh();
    empty.hidden = controls.element.dataset.target !== 'defaults';
  }
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(refresh);
  };
  app.on('doc:activated', schedule);
  app.on('doc:change', (e) => {
    if (['props', 'active', 'tree', 'history', 'canvas'].includes(e.kind)) schedule();
  });
  app.on('type:session', schedule);
  app.on('type:selection', schedule);
  app.on('type:sections-changed', ({ panel } = {}) => {
    if (panel === 'paragraph') schedule();
  });
  app.on('tool:options', (e) => {
    if (TYPE_TOOLS.includes(e?.tool)) schedule();
  });
  app.on('settings:changed', schedule);

  app.panels.register({
    id: 'paragraph',
    title: 'Paragraph',
    icon: 'paragraph',
    element: root,
    group: 'middle',
    onShow: refresh,
  });
  refresh();
  return { refresh, applyParagraph, editParagraphs, resetParagraph, hyphenationDialog, justificationDialog, createParagraphControls };
}
