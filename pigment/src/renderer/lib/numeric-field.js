// Numeric field (ARCHITECTURE.md "0.4 features", H; E7), owned by conventions-shortcuts-fields.
//
//   numericField({ key?, id?, label?, value, min?, max?, step?, unit?, units?, dpi?, base?, scrubby?, popup?, width?,
//                  className?, format?(v) -> string, onInput?(v), onChange?(v) })
//     -> { element, input, label, get(), set(value, { silent }?), setDisabled(b), destroy() }
//
// The input is 0.3's number input (<input class="input" type="number" data-numeric>, plus data-key when the spec has
// a key), so `element` is the bare input when there is neither a label, a unit nor a popup slider, and a caller that
// appends `element` builds exactly 0.3's DOM. What the field adds (Photoshop's conventions):
//   - arithmetic and units: `100+50`, `200/4`, `50%`, `2in`, `1in+10px`. The input stays type="number" at rest and
//     while focused; only a keydown that would insert a character a number input cannot hold (an operator other than
//     a leading minus, `%`, a unit letter) turns it into type="text" and inserts that character. Enter, Tab and blur
//     evaluate the entry and turn the input back to type="number" before any panel or dialog handler sees the key;
//     Escape restores the value it had before. Invalid entries keep the old value.
//     `units` lists the units the field takes; `unit` is the field's own unit (default units[0] or 'px' when only
//     units are given); `dpi` (number or function) converts lengths to and from pixels; `base` (number or function)
//     is what 100 % means (default: the value the field had).
//   - ArrowUp / ArrowDown step by `step` (Shift: ten steps), and so does the wheel over the focused field.
//   - a scrubby label: drag the label left or right (Shift: ten times faster, Alt: ten times slower).
//   - `popup: true`: a small button opens a slider under the field (needs `min` and `max`).
//
// The same behaviour reaches every other number input of the app through installNumericEnhancer() (lib/conventions.js
// installs it): its listeners are delegated at the window, in the capture phase, so they run before any dialog's or
// panel's own key handling, and a wrapping or `for` <label> of a number input scrubs it.
//
// The pure part (parseNumericEntry, resolveNumericEntry, roundToStep) has no DOM access, so node's tests import it.

// ---- the expression parser (pure) ------------------------------------------------------------------------------

/** Length units and how many of each make an inch ('px' depends on the resolution). */
const PER_INCH = { in: 1, cm: 2.54, mm: 25.4, pt: 72, pc: 6 };
const UNIT_ALIASES = {
  px: 'px', pixel: 'px', pixels: 'px',
  pt: 'pt', point: 'pt', points: 'pt',
  pc: 'pc', pica: 'pc', picas: 'pc',
  mm: 'mm', millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  in: 'in', inch: 'in', inches: 'in', '"': 'in',
  '%': '%', percent: '%',
};
export const LENGTH_UNITS = ['px', 'pt', 'mm', 'cm', 'in'];

const isLength = (u) => u === 'px' || u in PER_INCH;
const valueOf = (v) => (typeof v === 'function' ? v() : v);

function tokenize(text) {
  const tokens = [];
  const s = String(text);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === ' ') {
      i++;
      continue;
    }
    if (/[0-9.,]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.,]/.test(s[j])) j++;
      let raw = s.slice(i, j);
      // a comma is a decimal separator (1,5) unless the number already has a point (1,000.5 is not accepted)
      if (raw.includes('.') && raw.includes(',')) return null;
      raw = raw.replace(',', '.');
      if ((raw.match(/\./g) ?? []).length > 1 || raw === '.') return null;
      tokens.push({ t: 'num', v: Number(raw) });
      i = j;
      continue;
    }
    if ('+-*/×÷()'.includes(c)) {
      tokens.push({ t: c === '×' ? '*' : c === '÷' ? '/' : c });
      i++;
      continue;
    }
    if (c === '%' || c === '"' || c === '°') {
      tokens.push({ t: 'unit', v: c });
      i++;
      continue;
    }
    if (/[a-zA-Zµ]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Zµ]/.test(s[j])) j++;
      tokens.push({ t: 'unit', v: s.slice(i, j) });
      i = j;
      continue;
    }
    return null;
  }
  return tokens;
}

/**
 * Converts `v` in unit `from` to the field's unit. Returns null when the units do not go together.
 * ctx: { unit, units, dpi, base }
 */
function convert(v, from, ctx) {
  const field = ctx.unit;
  const lower = from.toLowerCase();
  const name = UNIT_ALIASES[lower] ?? (field && lower === String(field).toLowerCase() ? field : null);
  if (!name) return null;
  if (field && name === field) return v;
  if (ctx.units && !ctx.units.includes(name) && name !== '%') return null;
  if (name === '%') {
    if (field === '%') return v;
    const base = Number(valueOf(ctx.base));
    if (!Number.isFinite(base)) return null;
    return (base * v) / 100;
  }
  const to = field ?? 'px';
  if (!isLength(name) || !isLength(to)) return null;
  const dpi = Number(valueOf(ctx.dpi) ?? 72) || 72;
  const inches = name === 'px' ? v / dpi : v / PER_INCH[name];
  return to === 'px' ? inches * dpi : inches * PER_INCH[to];
}

/**
 * Evaluates what was typed into a numeric field: numbers, + - * / ( ), and units after a number or a bracket.
 * Returns the number in the field's unit, or null when the entry is not valid.
 *   opts: { unit?: string, units?: string[], dpi?: number | () => number, base?: number | () => number, old?: number }
 * `base` (what 100 % means) defaults to `old`. A number without a unit is in the field's unit.
 */
export function parseNumericEntry(text, opts = {}) {
  const tokens = tokenize(String(text ?? '').trim());
  if (!tokens || !tokens.length) return null;
  const units = Array.isArray(opts.units) && opts.units.length ? opts.units.map((u) => UNIT_ALIASES[String(u).toLowerCase()] ?? u) : null;
  const ctx = {
    unit: opts.unit ?? (units ? units[0] : null),
    units,
    dpi: opts.dpi,
    base: opts.base ?? opts.old,
  };
  let pos = 0;
  const peek = () => tokens[pos];
  const fail = () => {
    throw new Error('bad entry');
  };
  const withUnit = (v) => {
    const t = peek();
    if (t?.t === 'unit') {
      pos++;
      const c = convert(v, t.v, ctx);
      if (c === null) fail();
      return c;
    }
    return v;
  };
  function primary() {
    const t = peek();
    if (!t) fail();
    if (t.t === 'num') {
      pos++;
      return withUnit(t.v);
    }
    if (t.t === '(') {
      pos++;
      const v = expr();
      if (peek()?.t !== ')') fail();
      pos++;
      return withUnit(v);
    }
    return fail();
  }
  function unary() {
    const t = peek();
    if (t?.t === '-') {
      pos++;
      return -unary();
    }
    if (t?.t === '+') {
      pos++;
      return unary();
    }
    return primary();
  }
  function term() {
    let v = unary();
    for (;;) {
      const t = peek();
      if (t?.t === '*') {
        pos++;
        v *= unary();
      } else if (t?.t === '/') {
        pos++;
        const d = unary();
        if (d === 0) fail();
        v /= d;
      } else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      const t = peek();
      if (t?.t === '+') {
        pos++;
        v += term();
      } else if (t?.t === '-') {
        pos++;
        v -= term();
      } else return v;
    }
  }
  try {
    const v = expr();
    if (pos !== tokens.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/** Number of decimals a step shows (1 -> 0, 0.01 -> 2; at most 4). */
export function stepDecimals(step) {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0 || s >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(s) - 1e-9));
}

/** Rounds to the precision of `step` and clamps to min / max (either may be missing or ''). */
export function roundToStep(v, { min, max, step } = {}) {
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  const d = stepDecimals(step);
  n = Number(n.toFixed(d));
  if (min !== undefined && min !== null && min !== '' && Number.isFinite(Number(min)) && n < Number(min)) n = Number(min);
  if (max !== undefined && max !== null && max !== '' && Number.isFinite(Number(max)) && n > Number(max)) n = Number(max);
  return Object.is(n, -0) ? 0 : n;
}

/**
 * What a field shows after an entry: the evaluated, rounded and clamped value, or `old` when the entry is not valid.
 *   opts: parseNumericEntry's options plus { min, max, step }
 */
export function resolveNumericEntry(text, old, opts = {}) {
  const v = parseNumericEntry(text, { ...opts, old: opts.old ?? old });
  if (v === null) return old;
  return roundToStep(v, opts) ?? old;
}

// ---- the enhancer (DOM) ------------------------------------------------------------------------------------------

const SPECS = new WeakMap(); // input -> numericField spec
const STATE = new WeakMap(); // input -> per-focus state
const SCRUB_HOSTS = new WeakMap(); // scrubby label element -> input
let installed = false;
let dispatching = 0;
let lastTabAt = 0;
let appRef = null;

const NUMERIC_SELECTOR = 'input[type=number], input[data-numeric], input[data-numeric-text]';

function isNumericInput(el) {
  return !!el && el.tagName === 'INPUT' && !el.disabled && !el.readOnly && el.matches(NUMERIC_SELECTOR) && (el.type === 'number' || el.type === 'text');
}

// `before` is the value the field last stood for (on focus, after a commit, a step or a scrub, or when the app set
// it): Escape restores it, an invalid entry falls back to it, and `50%` means half of it
function stateOf(input) {
  let s = STATE.get(input);
  if (!s) {
    s = { textMode: false, before: input.value, allSelected: false, ourDirty: false, width: null };
    STATE.set(input, s);
  }
  return s;
}

/** Marks a numeric input whose whole text was just selected (a dialog's select() on open), so typing replaces it. */
export function noteSelectAll(input) {
  if (isNumericInput(input)) stateOf(input).allSelected = true;
}

/** The field options of an input: its numericField spec, else what its attributes and a unit label say. */
function optionsOf(input) {
  const spec = SPECS.get(input) ?? {};
  const attr = (name) => (input.hasAttribute(name) && input.getAttribute(name) !== '' ? Number(input.getAttribute(name)) : undefined);
  let unit = spec.unit ?? input.dataset.unit;
  if (!unit && !spec.units) {
    const sib = input.nextElementSibling;
    const text = sib?.classList?.contains('opt-unit') ? sib.textContent.trim() : '';
    if (text) unit = UNIT_ALIASES[text.toLowerCase()] ?? text;
  }
  const docDpi = () => appRef?.doc?.dpi ?? globalThis.pigmentApp?.doc?.dpi ?? 72;
  return {
    unit,
    units: spec.units,
    dpi: spec.dpi ?? docDpi,
    base: spec.base,
    min: spec.min !== undefined && spec.min !== '' ? Number(spec.min) : attr('min'),
    max: spec.max !== undefined && spec.max !== '' ? Number(spec.max) : attr('max'),
    step: Number(spec.step) > 0 ? Number(spec.step) : Number(input.getAttribute('step')) > 0 ? Number(input.getAttribute('step')) : 1,
    format: spec.format,
  };
}

function show(input, v, opts) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return;
  input.value = typeof opts.format === 'function' ? opts.format(Number(v)) : String(Number(v));
}

function fire(input, ...types) {
  dispatching++;
  try {
    for (const type of types) input.dispatchEvent(new Event(type, { bubbles: true }));
  } finally {
    dispatching--;
  }
}

function enterTextMode(input, text) {
  const s = stateOf(input);
  if (s.textMode) return;
  s.textMode = true;
  // `before` stays the value from before the typing: digits typed ahead of the operator are part of the entry
  // keep the box as wide as it was: some stylesheets size input[type=number] only
  s.width = input.style.width;
  if (!input.style.width && input.offsetWidth) input.style.width = `${input.offsetWidth}px`;
  input.dataset.numericText = '';
  input.type = 'text';
  input.value = text;
  try {
    input.setSelectionRange(text.length, text.length);
  } catch {
    /* ignore */
  }
}

function leaveTextMode(input) {
  const s = stateOf(input);
  if (!s.textMode) return;
  s.textMode = false;
  input.type = 'number';
  delete input.dataset.numericText;
  input.style.width = s.width ?? '';
  s.width = null;
}

/** The number a field holds now (its typed expression evaluated in text mode), or null. */
function currentValue(input) {
  const s = stateOf(input);
  const opts = optionsOf(input);
  if (s.textMode) {
    const old = Number(s.before);
    return parseNumericEntry(input.value, { ...opts, old: Number.isFinite(old) ? old : undefined });
  }
  if (input.value === '') return null;
  const v = Number(input.value);
  return Number.isFinite(v) ? v : null;
}

/** Evaluates a field in text mode and turns it back into a number input; input and change follow when it changed. */
function commit(input) {
  const s = stateOf(input);
  if (!s.textMode) return;
  const opts = optionsOf(input);
  const before = s.before;
  const old = before === '' ? null : Number(before);
  const v = parseNumericEntry(input.value, { ...opts, old: Number.isFinite(old) ? old : undefined });
  leaveTextMode(input);
  const r = v === null ? null : roundToStep(v, opts);
  if (r === null) {
    input.value = before;
    return;
  }
  show(input, r, opts);
  s.ourDirty = false;
  s.before = input.value;
  if (input.value !== before) fire(input, 'input', 'change');
}

/** Commits the focused numeric field if it holds a typed expression (callers: anything that reads values at once). */
export function commitActiveNumeric() {
  const el = document.activeElement;
  if (el && STATE.get(el)?.textMode) commit(el);
}

function stepBy(input, dir, mult) {
  const opts = optionsOf(input);
  const s = stateOf(input);
  const base = currentValue(input) ?? (Number(s.before) || 0);
  leaveTextMode(input);
  const v = roundToStep(base + dir * opts.step * mult, opts);
  if (v === null) return;
  const was = input.value;
  show(input, v, opts);
  if (input.value !== was) {
    s.ourDirty = true;
    // a step applies at once (panels act on its input event): Escape no longer takes it back
    s.before = input.value;
    fire(input, 'input');
  }
}

const OPERATOR = /^[+*/×÷()%°"]$/;

function onKeyDown(e) {
  const input = e.target;
  if (e.key === 'Tab') lastTabAt = performance.now();
  if (!isNumericInput(input) || e.isComposing) return;
  const s = stateOf(input);
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === 'a' || e.key === 'A') s.allSelected = true;
    return;
  }
  switch (e.key) {
    case 'Enter':
    case 'Tab':
      if (s.textMode) commit(input);
      else if (s.ourDirty) {
        s.ourDirty = false;
        fire(input, 'change');
      }
      return;
    case 'Escape':
      // Escape drops what was typed, plain digits as well as an expression: the field shows its value again and
      // nothing is applied (setting the value also keeps the input's own change event from firing on blur)
      leaveTextMode(input);
      if (input.value !== s.before) input.value = s.before;
      s.ourDirty = false;
      return;
    case 'ArrowUp':
    case 'ArrowDown':
      if (e.altKey) return;
      e.preventDefault();
      stepBy(input, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : 1);
      s.allSelected = false;
      return;
    default:
      break;
  }
  if (e.key.length !== 1 || e.altKey) {
    if (e.key === 'Backspace' || e.key === 'Delete') s.allSelected = false;
    return;
  }
  if (s.textMode) {
    s.allSelected = false;
    return;
  }
  const k = e.key;
  let insert = false;
  if (k === '-') {
    // a leading minus is a number input's own; anywhere else it is an operator
    insert = input.value !== '' || input.validity?.badInput;
  } else if (OPERATOR.test(k) || (/^[a-zA-Z]$/.test(k) && k !== 'e' && k !== 'E')) insert = true;
  if (insert) {
    e.preventDefault();
    const keep = s.allSelected || input.validity?.badInput ? '' : input.value;
    enterTextMode(input, keep + k);
  }
  s.allSelected = false;
}

function onInput(e) {
  const input = e.target;
  if (dispatching || !isNumericInput(input)) return;
  const s = STATE.get(input);
  if (!s) return;
  // what is typed in text mode is an expression ("100+"): listeners see the evaluated number when it is committed
  if (s.textMode) e.stopImmediatePropagation();
  else s.ourDirty = false; // typed by hand: the input's own change event follows
}

function onChange(e) {
  const input = e.target;
  if (dispatching || !isNumericInput(input)) return;
  const s = STATE.get(input);
  if (!s) return;
  if (s.textMode) e.stopImmediatePropagation();
  else {
    s.ourDirty = false;
    s.before = input.value; // typed digits committed (Enter, Tab, blur)
  }
}

function onFocusIn(e) {
  const input = e.target;
  if (!isNumericInput(input)) return;
  const s = stateOf(input);
  s.before = input.value;
  s.ourDirty = false;
  // Tab selects the whole text, a click places the caret
  s.allSelected = performance.now() - lastTabAt < 300;
}

function onFocusOut(e) {
  const input = e.target;
  if (!isNumericInput(input)) return;
  const s = STATE.get(input);
  if (!s) return;
  if (s.textMode) commit(input);
  else if (s.ourDirty) {
    s.ourDirty = false;
    fire(input, 'change');
  }
}

function onPointerDownInput(e) {
  if (isNumericInput(e.target)) stateOf(e.target).allSelected = false;
}

function onDblClick(e) {
  if (isNumericInput(e.target)) stateOf(e.target).allSelected = true;
}

let wheelAcc = 0;
function onWheel(e) {
  const input = e.target;
  if (!isNumericInput(input) || document.activeElement !== input) return;
  e.preventDefault();
  e.stopPropagation();
  // a mouse notch is one step; a trackpad's small deltas add up to one
  const d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
  wheelAcc += d;
  if (Math.abs(d) < 50 && Math.abs(wheelAcc) < 50) return;
  const dir = wheelAcc < 0 ? 1 : -1;
  wheelAcc = 0;
  stepBy(input, dir, e.shiftKey ? 10 : 1);
}

// ---- scrubby labels ------------------------------------------------------------------------------------------

/** The number input a pointer-down target scrubs: a numericField's scrubby label, or a <label> of a number input. */
function scrubTarget(target) {
  if (!target || !target.closest) return null;
  if (target.closest('input, select, textarea, button, a[href], [contenteditable="true"]')) return null;
  const host = target.closest('.numeric-label.scrubby');
  if (host && SCRUB_HOSTS.has(host)) return { host, input: SCRUB_HOSTS.get(host) };
  const label = target.closest('label');
  const control = label?.control;
  if (label && control && isNumericInput(control) && control.type === 'number') return { host: label, input: control };
  return null;
}

let scrub = null;
function onScrubDown(e) {
  if (e.button !== 0 || scrub) return;
  const t = scrubTarget(e.target);
  if (!t) return;
  const opts = optionsOf(t.input);
  scrub = { ...t, x: e.clientX, start: currentValue(t.input) ?? 0, started: false, opts, id: e.pointerId, last: t.input.value };
  window.addEventListener('pointermove', onScrubMove, true);
  window.addEventListener('pointerup', onScrubUp, true);
  window.addEventListener('pointercancel', onScrubUp, true);
}

function onScrubMove(e) {
  const s = scrub;
  if (!s || e.pointerId !== s.id) return;
  const dx = e.clientX - s.x;
  if (!s.started) {
    if (Math.abs(dx) < 3) return;
    s.started = true;
    s.host.classList.add('scrubbing');
    document.body.classList.add('numeric-scrubbing');
    leaveTextMode(s.input);
  }
  e.preventDefault();
  // one step per pixel; Shift ten steps, Alt a tenth (never finer than the field shows)
  const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  const v = roundToStep(s.start + dx * s.opts.step * mult, { ...s.opts, step: e.altKey ? s.opts.step / 10 : s.opts.step });
  if (v === null) return;
  show(s.input, v, s.opts);
  if (s.input.value !== s.last) {
    s.last = s.input.value;
    stateOf(s.input).before = s.input.value; // applied live, as a step
    fire(s.input, 'input');
  }
}

function onScrubUp(e) {
  const s = scrub;
  if (!s || e.pointerId !== s.id) return;
  scrub = null;
  window.removeEventListener('pointermove', onScrubMove, true);
  window.removeEventListener('pointerup', onScrubUp, true);
  window.removeEventListener('pointercancel', onScrubUp, true);
  if (!s.started) return;
  s.host.classList.remove('scrubbing');
  document.body.classList.remove('numeric-scrubbing');
  fire(s.input, 'change');
  // the click that ends a drag on a <label> would focus the input and select its text: drop it
  const swallow = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

// a label that scrubs shows the resize cursor (labels are found lazily: panels build their fields at any time)
function onPointerOver(e) {
  const label = e.target?.closest?.('label');
  if (!label || label.dataset.scrubChecked !== undefined) return;
  label.dataset.scrubChecked = '';
  const c = label.control;
  if (c && c.tagName === 'INPUT' && c.type === 'number') label.classList.add('numeric-scrub-label');
}

/**
 * Installs the delegated listeners that give every number input of the page the numeric field's behaviour
 * (arithmetic, units of a known unit label, Shift+arrow, the wheel, label scrubbing). Idempotent.
 */
export function installNumericEnhancer(app = null) {
  if (app) appRef = app;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('input', onInput, true);
  window.addEventListener('change', onChange, true);
  window.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('pointerdown', onPointerDownInput, true);
  window.addEventListener('pointerdown', onScrubDown, true);
  window.addEventListener('pointerover', onPointerOver, true);
  window.addEventListener('dblclick', onDblClick, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
}

// ---- popup slider ----------------------------------------------------------------------------------------------

let openPopup = null;
function closePopup() {
  openPopup?.close();
  openPopup = null;
}

function showPopupSlider(anchor, input, opts) {
  closePopup();
  const pop = document.createElement('div');
  pop.className = 'numeric-popup';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(opts.min);
  range.max = String(opts.max);
  range.step = String(opts.step);
  range.value = String(currentValue(input) ?? opts.min);
  range.setAttribute('aria-label', 'Value');
  pop.appendChild(range);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 4)}px`;
  range.addEventListener('input', () => {
    leaveTextMode(input);
    show(input, Number(range.value), opts);
    stateOf(input).before = input.value; // applied live, as a step
    fire(input, 'input');
  });
  range.addEventListener('change', () => fire(input, 'change'));
  const onDown = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) closePopup();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      closePopup();
      input.focus();
    }
  };
  setTimeout(() => window.addEventListener('pointerdown', onDown, true));
  pop.addEventListener('keydown', onKey);
  openPopup = {
    close() {
      window.removeEventListener('pointerdown', onDown, true);
      pop.remove();
    },
  };
  range.focus();
}

// ---- numericField -------------------------------------------------------------------------------------------

export function numericField(spec = {}) {
  installNumericEnhancer();
  const input = document.createElement('input');
  input.className = spec.className ?? 'input';
  input.type = 'number';
  if (spec.id) input.id = spec.id;
  if (spec.key) input.dataset.key = spec.key;
  input.dataset.numeric = '';
  if (spec.min !== undefined) input.min = String(spec.min);
  if (spec.max !== undefined) input.max = String(spec.max);
  if (spec.step !== undefined) input.step = String(spec.step);
  if (spec.width) input.style.width = typeof spec.width === 'number' ? `${spec.width}px` : spec.width;
  SPECS.set(input, spec);
  const format = typeof spec.format === 'function' ? spec.format : (v) => String(v);
  const display = (v) => (v === null || v === undefined || v === '' ? '' : Number.isFinite(Number(v)) ? format(Number(v)) : String(v));
  input.value = display(spec.value);

  let label = null;
  let unit = null;
  let popup = null;
  if (spec.label) {
    label = document.createElement('span');
    label.className = 'numeric-label' + (spec.scrubby ? ' scrubby' : '');
    label.textContent = spec.label;
    if (spec.scrubby) SCRUB_HOSTS.set(label, input);
  }
  if (spec.unit) {
    unit = document.createElement('span');
    unit.className = 'opt-unit';
    unit.textContent = spec.unit;
  }
  const hasRange = Number.isFinite(Number(spec.min)) && Number.isFinite(Number(spec.max)) && spec.min !== '' && spec.max !== '';
  if (spec.popup && hasRange) {
    popup = document.createElement('button');
    popup.type = 'button';
    popup.className = 'numeric-popup-button';
    popup.title = 'Show a slider';
    popup.tabIndex = -1;
    popup.setAttribute('aria-label', `${spec.label ?? 'Value'} slider`);
    popup.addEventListener('click', (e) => {
      e.preventDefault();
      if (input.disabled) return;
      if (openPopup) return closePopup();
      showPopupSlider(element, input, optionsOf(input));
    });
  }
  let element = input;
  if (label || unit || popup) {
    element = document.createElement('span');
    element.className = 'numeric-field';
    if (label) element.appendChild(label);
    element.appendChild(input);
    if (unit) element.appendChild(unit);
    if (popup) element.appendChild(popup);
  }

  const clampTo = (v) => {
    if (spec.min !== undefined && spec.min !== '' && v < Number(spec.min)) v = Number(spec.min);
    if (spec.max !== undefined && spec.max !== '' && v > Number(spec.max)) v = Number(spec.max);
    return v;
  };
  const get = () => {
    const s = STATE.get(input);
    if (s?.textMode) return currentValue(input);
    const v = Number(input.value);
    return input.value === '' || !Number.isFinite(v) ? null : v;
  };
  const set = (v, { silent = true } = {}) => {
    leaveTextMode(input);
    input.value = display(v);
    const st = STATE.get(input);
    if (st) st.before = input.value; // what the app holds now is what Escape returns to
    if (!silent) {
      spec.onInput?.(get());
      spec.onChange?.(get());
    }
  };
  input.addEventListener('input', () => {
    const v = get();
    if (v !== null) spec.onInput?.(v);
  });
  input.addEventListener('change', () => {
    const v = get();
    if (v !== null) spec.onChange?.(clampTo(v));
  });

  return {
    element,
    input,
    label,
    get,
    set,
    setDisabled(b) {
      input.disabled = !!b;
      if (popup) popup.disabled = !!b;
    },
    destroy() {
      if (openPopup && element.isConnected) closePopup();
      element.remove();
    },
  };
}
