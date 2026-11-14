// type-character-panel (package 3, ARCHITECTURE.md "0.4 features (contracts)", Packages; A, B.7, H, L.1, L.14):
// the character controls shared by the Character panel (lib/panels/character.js) and the Properties text section
// (lib/properties/text.js), the options bar's `font-size` field (units and the preset list), Reset Character, the
// optical kerner, the type-unit preference and the defaults new text starts with.
//
// Everything acts through lib/type/target.js: while text is edited, on the selection (a caret sets the insertion
// style, so the next typed characters get it); otherwise on every selected text layer, one history entry per change
// whatever the number of layers. With no text layer targeted the controls edit the defaults for new text
// (setTypeDefaults). Fields show '' when the selection has several values (MIXED).
import * as M from './model.js';
import * as api from './api.js';
import { typeTargets, readChar, applyChar, applyTypeOptions, applyBox, editTypeLayers, typeDefaults, setTypeDefaults } from './target.js';
import { typeSections } from './sections.js';
import {
  typeUnit, toUnit, fromUnit, formatNumber, showLength, showNumber, sizePresets, SPACING_PRESETS, showLeading, toggleState,
  styleValue, styleToChar, resetCharacterPatch, documentLanguages, languageOptions, UNIT_NAMES, TYPE_UNITS, autoLeadingPx,
} from './char-values.js';
import { opticalKerning, glyphProfile, referenceTarget } from './optical-kerning.js';
import { faceFor } from './fonts.js';
import { shapePiece, drawnSize, harfBuzz } from './shaper.js';
import { registerWidget } from '../fields.js';
import { numericField } from '../numeric-field.js';
import { icon } from '../icons.js';
import { fontFamilies, loadSystemFonts, STYLES, typeSession } from '../tools/text.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

export { typeUnit, toUnit, fromUnit } from './char-values.js';

const TYPE_TOOLS = ['type-horizontal', 'type-vertical'];
const hex6 = (c) => rgbaToHex(parseColor(c ?? '#000000')).slice(0, 7);
const ANTI_ALIAS = [['none', 'None'], ['sharp', 'Sharp'], ['crisp', 'Crisp'], ['strong', 'Strong'], ['smooth', 'Smooth']];
const ORIENTATIONS = [['horizontal', 'Horizontal'], ['vertical', 'Vertical (rotated)'], ['vertical-stacked', 'Vertical, stacked']];
// the eight toggles of Photoshop's Character panel: [id, attribute, value when on, title, label html]
export const TOGGLES = Object.freeze([
  ['faux-bold', 'fauxBold', true, 'Faux Bold', '<b>T</b>'],
  ['faux-italic', 'fauxItalic', true, 'Faux Italic', '<i>T</i>'],
  ['all-caps', 'caps', 'all', 'All Caps', 'TT'],
  ['small-caps', 'caps', 'small', 'Small Caps', 'T<small>T</small>'],
  ['superscript', 'position', 'super', 'Superscript', 'T<sup>1</sup>'],
  ['subscript', 'position', 'sub', 'Subscript', 'T<sub>1</sub>'],
  ['underline', 'underline', true, 'Underline', '<u>T</u>'],
  ['strike', 'strike', true, 'Strikethrough', '<s>T</s>'],
]);
const OFF = { fauxBold: false, fauxItalic: false, caps: 'normal', position: 'normal', underline: false, strike: false };

/** The resolution the type units convert with: the active document's (72 ppi without one). */
export const docDpi = (app) => (Number(app?.doc?.dpi) > 0 ? Number(app.doc.dpi) : 72);

// ---- applying ------------------------------------------------------------------------------------------------------

// attributes that never become defaults for new text: manual kerning belongs to one pair of characters
const NOT_DEFAULT = new Set(['kern']);

/**
 * Applies a character patch to what the panels target (B.7), as one history entry (or one session step), and makes
 * it the default for new text too, as Photoshop's Character panel does (0.3's panel did the same). The colour of a
 * targeted layer does not change the foreground colour (0.3); with nothing targeted it does (new text uses it).
 */
export function applyCharacter(app, patch, { label = 'Character', merge = false } = {}) {
  const t = typeTargets(app);
  const targeted = t.editing || t.layers.length > 0;
  if (targeted) applyChar(app, patch, { label, merge });
  const defaults = {};
  for (const [k, v] of Object.entries(patch)) {
    if (NOT_DEFAULT.has(k)) continue;
    if (k === 'color' && targeted) continue;
    defaults[k] = v;
  }
  if (Object.keys(defaults).length) setTypeDefaults(app, { char: defaults });
}

/**
 * Manual kerning: at a caret it sets the kerning after the character before it (Photoshop kerns the pair around the
 * insertion point); on a range or on layers it sets every character's.
 */
export function applyKerning(app, value, { merge = false } = {}) {
  const v = value === undefined ? undefined : M.tidyNumber(Math.max(-1000, Math.min(10000, Number(value) || 0)));
  const t = typeTargets(app);
  const s = t.editing ? typeSession(app)?.typeSessionApi?.() : null;
  if (s && s.from === s.to) {
    if (s.from <= 0) return;
    s.edit((content, from, to) => ({ content: M.applyChar(content, from - 1, from, { kern: v }), from, to }), { label: 'Kerning', merge });
    return;
  }
  if (t.editing || t.layers.length) applyChar(app, { kern: v }, { label: 'Kerning', merge });
}

/** Reset Character (type:reset-character): the panel's attributes back to their defaults (char-values.js). */
export function resetCharacter(app) {
  applyCharacter(app, resetCharacterPatch(), { label: 'Reset Character' });
}

/**
 * Point text <-> paragraph text. `kind` 'point' clears the box; 'paragraph' sets a box around the text as it is
 * laid out now (each layer its own), growing with the text (height null), as Photoshop's Convert to Paragraph Text.
 */
export function convertTextBox(app, kind) {
  const t = typeTargets(app);
  if (kind === 'point') {
    if (t.editing || t.layers.length) applyBox(app, { width: null, height: null }, { label: 'Convert to Point Text' });
    return;
  }
  const widthOf = (l) => Math.max(1, Math.ceil(api.layoutText(l).width || 1));
  if (t.editing) {
    if (t.layer.width === null) applyBox(app, { width: widthOf(t.layer), height: null }, { label: 'Convert to Paragraph Text' });
    return;
  }
  const layers = t.layers.filter((l) => l.width === null);
  editTypeLayers(app, layers, (l) => ({ width: widthOf(l), height: null }), { label: 'Convert to Paragraph Text', keys: ['width', 'height'] });
}

// ---- the controls (Character panel and Properties) ------------------------------------------------------------------

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function select(key, label, options) {
  const s = el('select', 'select');
  s.dataset.k = key;
  s.setAttribute('aria-label', label);
  for (const [v, l] of options) s.add(new Option(l, v));
  return s;
}

/** Sets a select's value, adding a blank choice for a mixed value (and an option for a value it lacks). */
function setSelect(s, value, labelFor = (v) => v) {
  const v = value === M.MIXED || value === undefined || value === null ? '' : String(value);
  let blank = s.querySelector('option[data-blank]');
  if (v === '') {
    if (!blank) {
      blank = new Option('', '');
      blank.dataset.blank = '';
      s.insertBefore(blank, s.firstChild);
    }
  } else {
    blank?.remove();
    if (![...s.options].some((o) => o.value === v)) s.add(new Option(labelFor(v), v), 0);
  }
  s.value = v;
}

/**
 * numericField with two guards the panels need: a change that commits the value the field already shows is no change
 * (a blur after Enter, a re-render), and `show(v)` does not overwrite what the user is typing (focused and edited
 * since the last commit). `onChange(v)` gets the committed number.
 */
function guardedField(spec, onChange) {
  let shown = '';
  let dirty = false;
  const f = numericField({
    ...spec,
    onChange: (v) => {
      dirty = false;
      if (v === null || formatNumber(v, 4) === shown) return;
      shown = formatNumber(v, 4);
      onChange(v);
    },
  });
  f.input.addEventListener('input', () => (dirty = true));
  // a field that may be emptied (the box height: empty = the box grows with the text) commits null
  if (spec.allowEmpty) {
    f.input.addEventListener('change', () => {
      if (f.input.value !== '' || shown === '') return;
      dirty = false;
      shown = '';
      onChange(null);
    });
  }
  f.show = (v) => {
    const str = v === '' || v === null || v === undefined ? '' : formatNumber(Number(v), 4);
    shown = str;
    const focused = document.activeElement === f.input;
    if (dirty && focused) return;
    dirty = false;
    const before = f.input.value;
    f.set(v === null || v === undefined ? '' : v);
    // a field focused for typing (nothing typed yet) that shows a new value keeps it selected, so what is typed next
    // replaces it rather than being appended to it (a new value would otherwise put the caret at its end)
    if (focused && f.input.value !== before) f.input.select();
  };
  return f;
}

/**
 * A number field of the panel: numericField (conventions-shortcuts-fields adds arithmetic, typed units and the
 * scrubby feel) with a scrubby text label, the unit after it and an optional preset list. `onCommit(v, { merge })`
 * gets the typed value (field unit) on change and, merged, while the label is dragged.
 */
function numberRow({ key, label = '', title, unit, step = 1, presets = null, placeholder = '', onCommit, dpi }) {
  let scrubbing = false;
  const f = guardedField({
    key,
    label,
    scrubby: true,
    step,
    unit,
    units: unit && TYPE_UNITS.includes(unit) ? TYPE_UNITS : undefined,
    dpi,
    onInput: (v) => {
      if (scrubbing && v !== null) onCommit(v, { merge: true });
    },
  }, (v) => onCommit(v, { merge: scrubbing }));
  f.input.removeAttribute('min');
  f.input.removeAttribute('max');
  if (placeholder) f.input.placeholder = placeholder;
  if (f.label) {
    f.label.title = title;
    f.label.addEventListener('pointerdown', () => {
      scrubbing = true;
      const end = () => {
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        // after the field's own pointerup (its last onChange is merged into the drag)
        setTimeout(() => (scrubbing = false), 0);
      };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }
  f.input.title = title;
  const cell = el('span', 'char-cell');
  cell.appendChild(f.element);
  let list = null;
  if (presets) {
    list = el('select', 'select char-presets');
    list.dataset.k = `${key}Presets`;
    list.setAttribute('aria-label', `${title} presets`);
    list.title = `${title} presets`;
    const fill = (items) => {
      list.replaceChildren(new Option('▾', ''), ...items.map(({ label: l, value }) => new Option(l, value)));
      list.value = '';
    };
    fill(presets);
    list.addEventListener('change', () => {
      const v = list.value;
      list.value = '';
      if (v !== '') onCommit(v, { merge: false, preset: true });
    });
    cell.appendChild(list);
  }
  return { cell, field: f, list };
}

/**
 * Builds the character controls. `variant` 'panel' (the Character panel) or 'properties' (the Properties text
 * section, which adds Edit Text and the panel button). Returns { element, refresh(), destroy() }; the caller decides
 * when to refresh (the panel on 'type:selection' and document changes; the Properties host re-renders).
 */
export function createCharacterControls(app, { variant = 'panel' } = {}) {
  const root = el('div', `char-controls char-v-${variant}`);
  const unit = typeUnit(app.settings);
  const dpiOf = () => docDpi(app);
  const rows = new Map(); // row id -> element (L.14: a section with `replaces` takes its place)
  const cell = (id, child) => {
    const c = el('div', 'char-row-cell');
    c.dataset.row = id;
    c.appendChild(child);
    rows.set(id, c);
    return c;
  };
  const line = (...cells) => {
    const r = el('div', 'char-line');
    r.append(...cells);
    root.appendChild(r);
    return r;
  };
  const apply = (patch, opts) => applyCharacter(app, patch, opts);

  // family and style: plain selects until type-fonts (0.5) replaces the family control through `replaces: 'family'`
  const family = select('family', 'Font family', []);
  family.addEventListener('pointerdown', () => loadSystemFonts());
  family.addEventListener('change', () => family.value && apply({ fontFamily: family.value, postScriptName: undefined }));
  const style = select('style', 'Font style', STYLES);
  style.addEventListener('change', () => style.value && apply(styleToChar(style.value)));
  line(cell('family', family));
  line(cell('style', style));

  // size, leading
  const sizeRow = numberRow({
    key: 'size', label: 'Size', title: 'Font size', unit, step: unit === 'mm' ? 0.1 : 1, dpi: dpiOf, presets: sizePresets(unit, 72).map((p) => ({ label: p.label, value: String(p.px) })),
    onCommit: (v, { merge, preset }) => {
      const px = preset ? presetPx(Number(v)) : fromUnit(v, unit, dpiOf());
      if (px > 0) apply({ size: M.tidyNumber(Math.min(10000, Math.max(0.1, px))) }, { label: 'Font Size', merge });
    },
  });
  // the preset list is built at 72 ppi; a choice is converted with the document's resolution when picked
  const presetPx = (px72) => (unit === 'px' ? px72 : fromUnit(toUnit(px72, unit, 72), unit, dpiOf()));
  const leadRow = numberRow({
    key: 'leading', label: 'Leading', title: 'Leading', unit, step: unit === 'mm' ? 0.1 : 1, dpi: dpiOf, placeholder: '', presets: [{ label: 'Auto', value: 'auto' }, ...sizePresets(unit, 72).map((p) => ({ label: p.label, value: String(p.px) }))],
    onCommit: (v, { merge, preset }) => {
      if (v === 'auto') return apply({ leading: 'auto' }, { label: 'Leading' });
      const px = preset ? presetPx(Number(v)) : fromUnit(v, unit, dpiOf());
      if (px > 0) apply({ leading: M.tidyNumber(Math.min(20000, Math.max(0.1, px))) }, { label: 'Leading', merge });
    },
  });
  line(cell('size', sizeRow.cell), cell('leading', leadRow.cell));

  // kerning (Metrics / Optical / 0 and a manual value), tracking
  const autoKern = select('autoKern', 'Kerning method', [['metrics', 'Metrics'], ['optical', 'Optical'], ['none', '0']]);
  autoKern.title = 'Kerning: the font\'s pairs (Metrics), by the glyph shapes (Optical) or none (0)';
  autoKern.addEventListener('change', () => autoKern.value && apply({ autoKern: autoKern.value }, { label: 'Kerning' }));
  const kernRow = numberRow({
    key: 'kern', title: 'Kerning between the characters at the insertion point (1/1000 em)', step: 1,
    onCommit: (v, { merge }) => applyKerning(app, Number(v), { merge }),
  });
  const kernCell = el('span', 'char-kerning');
  kernCell.append(autoKern, kernRow.cell);
  const trackRow = numberRow({
    key: 'tracking', label: 'Track', title: 'Tracking (1/1000 em)', step: 1, presets: SPACING_PRESETS.map((n) => ({ label: String(n), value: String(n) })),
    onCommit: (v, { merge }) => apply({ tracking: M.tidyNumber(Math.max(-1000, Math.min(10000, Number(v)))) }, { label: 'Tracking', merge }),
  });
  line(cell('kerning', kernCell), cell('tracking', trackRow.cell));

  // vertical and horizontal scale
  const scaleY = numberRow({ key: 'scaleY', label: 'V', title: 'Vertical scale', unit: '%', step: 1, onCommit: (v, { merge }) => apply({ scaleY: M.tidyNumber(Math.max(1, Math.min(1000, Number(v)))) }, { label: 'Vertical Scale', merge }) });
  const scaleX = numberRow({ key: 'scaleX', label: 'H', title: 'Horizontal scale', unit: '%', step: 1, onCommit: (v, { merge }) => apply({ scaleX: M.tidyNumber(Math.max(1, Math.min(1000, Number(v)))) }, { label: 'Horizontal Scale', merge }) });
  const scaleCell = el('span', 'char-scale');
  scaleCell.append(scaleY.cell, scaleX.cell);
  line(cell('scale', scaleCell));

  // baseline shift, colour
  const shiftRow = numberRow({
    key: 'baselineShift', label: 'Shift', title: 'Baseline shift', unit, step: unit === 'mm' ? 0.1 : 1, dpi: dpiOf,
    onCommit: (v, { merge }) => {
      const px = fromUnit(v, unit, dpiOf());
      if (Number.isFinite(px)) apply({ baselineShift: M.tidyNumber(Math.max(-10000, Math.min(10000, px))) }, { label: 'Baseline Shift', merge });
    },
  });
  const color = el('input');
  color.type = 'color';
  color.dataset.k = 'color';
  color.setAttribute('aria-label', 'Text colour');
  color.title = 'Text colour';
  // a colour-picker drag is one history entry
  color.addEventListener('input', () => apply({ color: color.value }, { label: 'Color', merge: true }));
  const colorCell = el('label', 'char-color', '<span class="numeric-label">Color</span>');
  colorCell.appendChild(color);
  line(cell('baseline', shiftRow.cell), cell('color', colorCell));

  // the eight toggles
  const toggles = el('div', 'char-toggles');
  toggles.setAttribute('role', 'group');
  toggles.setAttribute('aria-label', 'Character styles');
  for (const [id, key, on, title, html] of TOGGLES) {
    const b = el('button', 'char-toggle', html);
    b.type = 'button';
    b.dataset.k = id;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', () => toggle(app, key, on, title));
    toggles.appendChild(b);
  }
  line(cell('toggles', toggles));

  // language and anti-aliasing
  const language = select('language', 'Language', []);
  language.title = 'Language (hyphenation dictionary)';
  language.addEventListener('change', () => language.value && apply({ language: language.value }, { label: 'Language' }));
  const antiAlias = select('antiAlias', 'Anti-aliasing', ANTI_ALIAS);
  antiAlias.title = 'Anti-aliasing method';
  antiAlias.addEventListener('change', () => antiAlias.value && applyTypeOptions(app, { antiAlias: antiAlias.value }, { label: 'Anti-Aliasing' }));
  const aaCell = el('span', 'char-aa');
  aaCell.append(el('span', 'muted', 'aa'), antiAlias);
  line(cell('language', language), cell('antiAlias', aaCell));

  // Pigment's own: orientation (the command rotates the layer), the text stroke, point or paragraph text and its box
  const extras = el('div', 'char-extras');
  root.appendChild(extras);
  const orientation = select('orientation', 'Text orientation', ORIENTATIONS);
  orientation.addEventListener('change', () => {
    typeSession(app)?.commitSession(); // the orientation switch is its own history entry
    app.commands.run('text:orientation', orientation.value, 'panel');
    refresh();
  });
  const orientRow = el('div', 'prop-row', '<span>Orientation</span>');
  orientRow.dataset.row = 'orientation';
  orientRow.appendChild(orientation);
  extras.appendChild(orientRow);

  const strokeColor = el('input');
  strokeColor.type = 'color';
  strokeColor.dataset.k = 'strokeColor';
  strokeColor.setAttribute('aria-label', 'Stroke colour');
  const strokeWidth = guardedField({ key: 'strokeWidth', min: 0, max: 1000, step: 0.5, width: 56 }, () => apply(strokePatch(), { label: 'Text Stroke' }));
  strokeWidth.input.setAttribute('aria-label', 'Stroke width');
  const strokePatch = () => {
    const w = Number(strokeWidth.input.value);
    return { stroke: w > 0 ? { color: strokeColor.value, width: w } : null };
  };
  strokeColor.addEventListener('input', () => {
    if (!(Number(strokeWidth.input.value) > 0)) strokeWidth.input.value = '2';
    apply(strokePatch(), { label: 'Text Stroke', merge: true });
  });
  const strokeRow = el('div', 'prop-row', '<span>Stroke</span>');
  strokeRow.dataset.row = 'stroke';
  strokeRow.append(strokeColor, strokeWidth.element, el('span', 'muted', 'px'));
  extras.appendChild(strokeRow);

  const box = select('box', 'Point or paragraph text', [['point', 'Point text'], ['paragraph', 'Paragraph box']]);
  box.addEventListener('change', () => {
    convertTextBox(app, box.value);
    refresh();
  });
  const boxW = guardedField({ key: 'boxWidth', step: 1, width: 64 }, (v) => v > 0 && applyBox(app, { width: M.tidyNumber(fromUnit(v, unit, dpiOf())) }));
  boxW.input.setAttribute('aria-label', 'Box width');
  boxW.input.title = `Paragraph box width (${unit})`;
  const boxH = guardedField({ key: 'boxHeight', step: 1, width: 64, allowEmpty: true }, (v) => applyBox(app, { height: v > 0 ? M.tidyNumber(fromUnit(v, unit, dpiOf())) : null }));
  boxH.input.setAttribute('aria-label', 'Box height');
  boxH.input.title = `Paragraph box height (${unit}); empty: the box grows with the text`;
  boxH.input.placeholder = 'Auto';
  const boxRow = el('div', 'prop-row char-box', '<span>Text</span>');
  boxRow.dataset.row = 'box';
  boxRow.append(box, boxW.element, el('span', 'muted', '×'), boxH.element);
  extras.appendChild(boxRow);

  // registered sections (L.14) after the built-in controls
  const sectionsBox = el('div', 'char-sections');
  root.appendChild(sectionsBox);

  let actions = null;
  if (variant === 'properties') {
    actions = el('div', 'props-actions');
    root.appendChild(actions);
  }

  function renderSections(attrs) {
    if (sectionsBox.contains(document.activeElement)) return;
    for (const r of rows.values()) {
      r.querySelector(':scope > .char-replaced')?.remove();
      for (const c of r.children) if (c.dataset.replacedBy) {
        c.hidden = false;
        delete c.dataset.replacedBy;
      }
    }
    sectionsBox.replaceChildren();
    const ctx = { app, attrs, apply: (patch) => apply(patch), unit };
    for (const spec of typeSections('character')) {
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
          node.classList.add('char-replaced');
          target.appendChild(node);
        } else sectionsBox.appendChild(node);
      } catch (err) {
        console.warn(`type section ${spec.id} failed`, err);
      }
    }
  }

  function refresh() {
    const t = typeTargets(app);
    const attrs = readChar(app);
    const dpi = dpiOf();
    root.dataset.target = t.editing ? 'editing' : t.layers.length ? 'layers' : 'defaults';
    // family
    if (document.activeElement !== family) {
      const list = fontFamilies();
      const cur = attrs.fontFamily === M.MIXED ? null : attrs.fontFamily;
      const names = cur && !list.includes(cur) ? [cur, ...list] : list;
      const want = names.join('|');
      if (family.dataset.list !== want) {
        family.replaceChildren(...names.map((n) => new Option(n, n)));
        family.dataset.list = want;
      }
      setSelect(family, attrs.fontFamily);
    }
    setSelect(style, styleValue(attrs));
    const setField = (row, v) => row.field.show(v);
    setField(sizeRow, showLength(attrs.size, unit, dpi));
    const lead = showLeading(attrs.leading, unit, dpi);
    setField(leadRow, lead === 'auto' ? '' : lead);
    leadRow.field.input.placeholder = lead === 'auto' ? `(${showLength(autoLeadingPx(attrs.size === M.MIXED ? NaN : attrs.size), unit, dpi) || 'Auto'})` : '';
    leadRow.field.input.dataset.auto = String(lead === 'auto');
    setSelect(autoKern, attrs.autoKern);
    setField(kernRow, showNumber(attrs.kern));
    setField(trackRow, showNumber(attrs.tracking));
    setField(scaleY, showNumber(attrs.scaleY));
    setField(scaleX, showNumber(attrs.scaleX));
    setField(shiftRow, showLength(attrs.baselineShift, unit, dpi));
    if (document.activeElement !== color) color.value = attrs.color === M.MIXED ? '#000000' : hex6(attrs.color);
    color.dataset.mixed = String(attrs.color === M.MIXED);
    for (const b of toggles.children) {
      const [, key, on] = TOGGLES.find(([id]) => id === b.dataset.k);
      b.setAttribute('aria-pressed', String(toggleState(attrs, key, on)));
    }
    // language: the hyphenation languages and those of the document's text
    const docLangs = documentLanguages((app.doc?.layers?.() ?? []).filter((l) => l.type === 'text').map((l) => l.content));
    const langs = languageOptions(api.hyphenationLanguages(), docLangs, attrs.language);
    if (document.activeElement !== language) {
      const want = langs.map((o) => o.value).join('|');
      if (language.dataset.list !== want) {
        language.replaceChildren(...langs.map((o) => new Option(o.label, o.value)));
        language.dataset.list = want;
      }
      setSelect(language, attrs.language);
    }
    // layer options: the edited layer, else the targeted ones (several: mixed shows blank)
    const layers = t.layers;
    const one = (f) => {
      if (!layers.length) return undefined;
      const vals = layers.map(f);
      return vals.every((v) => v === vals[0]) ? vals[0] : M.MIXED;
    };
    const hasLayer = layers.length > 0;
    rows.get('antiAlias').hidden = !hasLayer;
    setSelect(antiAlias, one((l) => l.typeOptions?.antiAlias ?? 'smooth'));
    orientRow.hidden = !hasLayer;
    setSelect(orientation, one((l) => l.typeOptions?.orientation ?? 'horizontal'));
    strokeRow.hidden = false;
    const st = attrs.stroke;
    if (document.activeElement !== strokeColor) strokeColor.value = st && st !== M.MIXED ? hex6(st.color) : '#000000';
    strokeWidth.show(st === M.MIXED ? '' : st ? st.width : 0);
    boxRow.hidden = !hasLayer;
    if (hasLayer) {
      const w = one((l) => l.width);
      setSelect(box, w === M.MIXED ? M.MIXED : w === null ? 'point' : 'paragraph');
      const isBox = w !== null;
      boxW.element.hidden = !isBox;
      boxH.element.hidden = !isBox;
      boxRow.querySelector('.muted').hidden = !isBox;
      if (isBox) {
        boxW.show(w === M.MIXED ? '' : showLength(w, unit, dpi));
        const hh = one((l) => l.height);
        boxH.show(hh === M.MIXED || hh === null ? '' : showLength(hh, unit, dpi));
      }
    }
    if (actions) {
      actions.replaceChildren();
      const layer = t.layer;
      if (layer && !t.editing && app.commands.has('layer:edit-text')) actions.appendChild(button('Edit Text', 'text', 'Edit the text on the canvas', () => app.commands.run('layer:edit-text', layer.id, 'panel')));
      if (app.panels.panels?.has?.('character')) actions.appendChild(button('Character…', 'character', 'Show the Character panel', () => app.panels.show('character', { reveal: true })));
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

function button(label, iconName, title, onClick) {
  const b = el('button', 'btn small', `${icon(iconName)}<span>${label}</span>`);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** One of the eight toggles: off where the whole target has it on, else on everywhere (MIXED counts as off). */
export function toggle(app, key, on, label) {
  const attrs = readChar(app);
  const isOn = attrs[key] === on;
  applyCharacter(app, { [key]: isOn ? OFF[key] : on }, { label });
}

/** The panel menu's check boxes on character attributes (Fractional Widths, No Break) and System Layout. */
export function toggleAttribute(app, key, label) {
  if (key === 'systemLayout') {
    const t = typeTargets(app);
    const cur = t.layers.length && t.layers.every((l) => l.typeOptions?.systemLayout === true);
    applyTypeOptions(app, { systemLayout: !cur }, { label });
    return;
  }
  const attrs = readChar(app);
  applyCharacter(app, { [key]: attrs[key] !== true }, { label });
}

/** The Character panel menu (Photoshop's): toggles, Fractional Widths, System Layout, No Break, units, Reset. */
export function characterMenuItems(app, onUnit) {
  const attrs = readChar(app);
  const t = typeTargets(app);
  const sysOn = t.layers.length > 0 && t.layers.every((l) => l.typeOptions?.systemLayout === true);
  const unit = typeUnit(app.settings);
  return [
    ...TOGGLES.map(([, key, on, title]) => ({ label: title, checked: attrs[key] === on, onSelect: () => toggle(app, key, on, title) })),
    { type: 'separator' },
    { label: 'Fractional Widths', checked: attrs.fractionalWidths === true, onSelect: () => toggleAttribute(app, 'fractionalWidths', 'Fractional Widths') },
    { label: 'System Layout', checked: sysOn, disabled: !t.layers.length, onSelect: () => toggleAttribute(app, 'systemLayout', 'System Layout') },
    { label: 'No Break', checked: attrs.noBreak === true, onSelect: () => toggleAttribute(app, 'noBreak', 'No Break') },
    { type: 'separator' },
    { type: 'title', label: 'Type units' },
    ...TYPE_UNITS.map((u) => ({ label: UNIT_NAMES[u], checked: unit === u, onSelect: () => (onUnit ?? setTypeUnit)(app, u) })),
    { type: 'separator' },
    { label: 'Reset Character', onSelect: () => app.commands.run('type:reset-character', undefined, 'panel') },
  ];
}

/** Writes settings.type.unit (a new object: the J.7 defaults are shared references). */
export function setTypeUnit(app, unit) {
  if (!TYPE_UNITS.includes(unit) || typeUnit(app.settings) === unit && app.settings?.type?.unit === unit) return;
  app.saveSettings({ type: { ...(app.settings.type ?? {}), unit } });
}

// ---- the options bar's font-size field (H) ------------------------------------------------------------------------

/**
 * The `font-size` option kind: px in and out, shown in settings.type.unit with the document's resolution, Photoshop's
 * preset list (6..72) and a scrubby icon. tools/text.js declares the size option with this kind.
 */
function fontSizeWidget(spec, { value, onChange, app }) {
  const wrap = el('span', 'opt-number char-size-field');
  const unitOf = () => typeUnit(app?.settings);
  const dpiOf = () => docDpi(app);
  const minPx = Number(spec.min) > 0 ? Number(spec.min) : 0.1;
  const maxPx = Number(spec.max) > 0 ? Number(spec.max) : 10000;
  let px = Number(value ?? spec.default ?? spec.value ?? 48);
  const grip = el('span', 'char-size-grip', icon('text'));
  grip.title = 'Font size (drag to change)';
  let dirty = false;
  const f = numericField({
    step: 1,
    value: '',
    onChange: (v) => {
      dirty = false;
      // the value shown committed again (a blur after Enter) is no change
      if (formatNumber(v, 4) === formatNumber(Number(formatNumber(toUnit(px, unitOf(), dpiOf()), 2)), 4)) return;
      commit(fromUnit(v, unitOf(), dpiOf()));
    },
  });
  f.input.addEventListener('input', () => (dirty = true));
  f.input.setAttribute('aria-label', 'Font size');
  f.input.title = 'Font size';
  const unitLabel = el('span', 'opt-unit');
  const list = el('select', 'select char-presets');
  list.setAttribute('aria-label', 'Font size presets');
  list.title = 'Font size presets';
  const show = () => {
    const u = unitOf();
    unitLabel.textContent = u;
    f.input.step = u === 'mm' ? '0.1' : '1';
    if (!(dirty && document.activeElement === f.input)) f.input.value = formatNumber(toUnit(px, u, dpiOf()), 2);
    const presets = sizePresets(u, dpiOf());
    if (list.dataset.unit !== `${u}:${dpiOf()}`) {
      list.replaceChildren(new Option('▾', ''), ...presets.map((p) => new Option(p.label, String(p.px))));
      list.dataset.unit = `${u}:${dpiOf()}`;
    }
    list.value = '';
  };
  function commit(v, { silent = false } = {}) {
    if (!Number.isFinite(v) || v <= 0) return show();
    px = M.tidyNumber(Math.min(maxPx, Math.max(minPx, v)));
    show();
    if (!silent) onChange(px);
  }
  list.addEventListener('change', () => {
    const v = Number(list.value);
    list.value = '';
    if (v > 0) commit(v);
  });
  // the scrubby icon: 1 unit per pixel dragged, Shift x10 (one history entry: the tool merges size changes)
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, start: toUnit(px, unitOf(), dpiOf()) };
    grip.setPointerCapture?.(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const step = (e.shiftKey ? 10 : 1) * (unitOf() === 'mm' ? 0.1 : 1);
    const v = Math.max(0.1, drag.start + Math.round((e.clientX - drag.x) / 2) * step);
    commit(fromUnit(v, unitOf(), dpiOf()));
  });
  const end = () => (drag = null);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  wrap.append(grip, f.input, unitLabel, list);
  show();
  return {
    element: wrap,
    get: () => px,
    set: (v) => {
      if (Number.isFinite(Number(v))) px = Number(v);
      show();
    },
    setDisabled: (b) => {
      f.input.disabled = !!b;
      list.disabled = !!b;
    },
    destroy: () => wrap.remove(),
  };
}

// ---- optical kerning (B.2 registerKerner) -----------------------------------------------------------------------------

const profileCache = new WeakMap(); // face rec -> Map(key -> profile)
const targetCache = new WeakMap(); // face rec -> Map(size key -> px)
const measureFallback = (s, st, size) => s.length * size * 0.5;

function cachedProfile(rec, unit, outline, size, sx) {
  let m = profileCache.get(rec);
  if (!m) profileCache.set(rec, (m = new Map()));
  const key = `${size}|${sx}|${unit.glyphs.map((g) => `${g.id},${g.x},${g.y}`).join(';')}`;
  let p = m.get(key);
  if (!p) {
    p = glyphProfile(outline, { size });
    if (sx !== 1) {
      // the engine's outlines are not scaled horizontally; the advances are
      for (let j = 0; j < p.bands; j++) {
        p.left[j] *= sx;
        p.right[j] *= sx;
      }
      p.minX *= sx;
      p.maxX *= sx;
    }
    if (m.size > 4000) m.clear();
    m.set(key, p);
  }
  return p;
}

function fontTarget(rec, style, size) {
  let m = targetCache.get(rec);
  if (!m) targetCache.set(rec, (m = new Map()));
  const key = `${size}|${style.scaleX}`;
  if (m.has(key)) return m.get(key);
  const plain = { ...style, tracking: 0, kern: 0, caps: 'normal' };
  const refs = ['n', 'o'].map((ch) => {
    const outline = api.fonts.outline?.(plain, ch) ?? null;
    const adv = api.fonts.advances?.(plain, ch)?.[0] ?? 0;
    return { outline, advance: adv };
  });
  const v = referenceTarget(refs, { size });
  m.set(key, v);
  return v;
}

/**
 * The 'optical' kerner (B.2): fn(style, text, outlines) -> extra advance after each shaping unit in 1/1000 em, or
 * null (metrics kerning) without face data. The units are shaped again here (kern off, as the engine shapes a piece
 * it asks a kerner about) to get their advances; a different unit count than the engine's means null.
 */
export function opticalKerner(style, text, outlines) {
  if (!harfBuzz() || !Array.isArray(outlines) || !outlines.some(Boolean)) return null;
  const rec = faceFor(style);
  if (!rec) return null;
  let piece;
  try {
    piece = shapePiece(text, 0, text.length, style, { faceFor, measure: measureFallback, opticalFallback: false });
  } catch {
    return null;
  }
  if (piece.units.length !== outlines.length) return null;
  const size = drawnSize(style);
  const sx = (Number(style.scaleX) || 100) / 100;
  const units = piece.units.map((u, k) => ({ outline: outlines[k], advance: u.advance, unit: u }));
  return opticalKerning(units, {
    size,
    em: style.size,
    target: fontTarget(rec, style, size),
    profileOf: (u) => cachedProfile(rec, u.unit, u.outline, size, sx),
  });
}

// ---- new text and the 0.3 tool options ------------------------------------------------------------------------------

/** Applies a sparse character patch to the whole text, the insertion style of an empty text included. */
function wholeChar(content, patch) {
  const n = M.contentLength(content);
  if (n) return M.applyChar(content, 0, n, patch);
  return M.mapChar(content, (style) => {
    const out = { ...style };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  });
}

/**
 * New text starts with typeDefaults (B.7): the type tools build the layer from the options bar (family, style, size,
 * align, colour); the attributes the options bar does not have (settings.type.char / .para) are applied here, when
 * the new layer's session opens, before anything is typed, so they belong to the creation entry.
 */
function applyDefaultsToNewText(app, layer) {
  const s = typeSession(app)?.session;
  if (!s?.isNew || s.layer !== layer || s.charDefaultsApplied) return;
  s.charDefaultsApplied = true;
  const char = app.settings?.type?.char ?? {};
  const para = app.settings?.type?.para ?? {};
  if (!Object.keys(char).length && !Object.keys(para).length) return;
  let content = layer.content;
  if (Object.keys(char).length) content = wholeChar(content, char);
  if (Object.keys(para).length) content = M.applyPara(content, 0, M.contentLength(content), para);
  if (content === layer.content) return;
  layer.content = content;
  layer.touch();
  s.editor?.invalidate?.();
  s.doc?.changed?.('props', { layer });
}

/**
 * 0.3's Character panel kept underline, stroke and letter spacing in the type tools' options; 0.4 keeps them in
 * settings.type.char (B.7). Moves stored values over once, so new text and the panel agree.
 */
function migrateToolOptions(app) {
  const tool = app.tools?.get?.('type-horizontal');
  if (!tool?.opt) return;
  const char = {};
  const size = Number(tool.opt('size')) || 48;
  if (tool.opt('underline') === true) char.underline = true;
  const st = tool.opt('stroke');
  if (st && Number(st.width) > 0) char.stroke = { color: st.color, width: Number(st.width) };
  const ls = Number(tool.opt('letterSpacing'));
  if (ls) char.tracking = M.tidyNumber((ls * 1000) / size);
  if (!Object.keys(char).length) return;
  for (const id of TYPE_TOOLS) {
    if (!app.tools.get(id)) continue;
    app.tools.setOpt(id, 'underline', false, { silent: true });
    app.tools.setOpt(id, 'stroke', null, { silent: true });
    app.tools.setOpt(id, 'letterSpacing', 0, { silent: true });
  }
  const rest = app.settings?.type?.char ?? {};
  setTypeDefaults(app, { char: { ...char, ...rest } });
}

// ---- install -------------------------------------------------------------------------------------------------------

export function install(app) {
  api.registerKerner('optical', opticalKerner);
  registerWidget('font-size', fontSizeWidget);

  app.commands.register('type:reset-character', {
    label: 'Reset Character',
    run: () => resetCharacter(app),
  });

  // Preferences > Type Units (Photoshop: Units & Rulers > Type). Ordered after type-editing's 'type' section, whose
  // placeholder value it carries along: both write settings.type, and the dialog merges section patches shallowly.
  app.preferences?.registerSection({
    id: 'type-units',
    title: 'Type Units',
    order: 36,
    fields: [{ key: 'typeUnit', label: 'Type size in', type: 'select', options: TYPE_UNITS.map((u) => [u, UNIT_NAMES[u]]) }],
    read: (s) => ({ typeUnit: typeUnit(s) }),
    write: (values, s) => {
      const u = TYPE_UNITS.includes(values.typeUnit) ? values.typeUnit : 'px';
      const placeholder = 'typePlaceholder' in values ? !!values.typePlaceholder : s.type?.placeholder;
      if (u === typeUnit(s) && placeholder === s.type?.placeholder) return {};
      const type = { ...(s.type ?? {}), unit: u };
      if (placeholder !== undefined) type.placeholder = placeholder;
      return { type };
    },
  });

  app.on('type:session', ({ layer } = {}) => {
    if (layer) applyDefaultsToNewText(app, layer);
  });

  // the options bar shows the size in the type unit: redraw it when the unit or the document's resolution changes
  const redrawBar = () => {
    const t = app.tools?.active;
    // the widget reads the unit and the resolution again when it is set
    if (TYPE_TOOLS.includes(t?.id)) app.tools.updateControl('size', t.opt('size'));
  };
  let lastUnit = typeUnit(app.settings);
  app.on('settings:changed', () => {
    const u = typeUnit(app.settings);
    if (u === lastUnit) return;
    lastUnit = u;
    redrawBar();
    app.properties?.render?.();
  });
  app.on('doc:activated', redrawBar);
  redrawBar();

  // the tools exist once MODULES are installed
  app.on('app:ready', () => migrateToolOptions(app));

  return { createCharacterControls, applyCharacter, resetCharacter, typeDefaults: () => typeDefaults(app) };
}
