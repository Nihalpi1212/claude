// Numeric field (ARCHITECTURE.md "0.4 features", H; E7). Skeleton stub; owned by conventions-shortcuts-fields,
// which replaces this file and keeps its exports (arithmetic such as 100+50 and 50%, typed units, Shift+arrow x10,
// the wheel, the scrubby label's feel, a popup slider).
//
// The stub is 0.3's number input: <input class="input" type="number"> with min, max, step and the value, marked
// `data-numeric` (code that asks "is this a number field" tests `input[type=number], input[data-numeric]`), plus
// `data-key` when the spec has a key. The input never changes its type here: the specs fill() it as a number input.
// `spec.scrubby` with `spec.label` adds a label in front whose horizontal drag changes the value by
// Δx × step (the minimal scrubby label of H).
//
//   numericField({ key?, id?, label?, value, min?, max?, step?, unit?, scrubby?, width?, className?,
//                  format?(v) -> string, onInput?(v), onChange?(v) })
//     -> { element, input, label, get(), set(value, { silent }?), setDisabled(b), destroy() }
// `element` is the input itself when there is neither a label nor a unit, so a caller that appends `element` builds
// exactly 0.3's DOM.

const clampTo = (v, spec) => {
  if (spec.min !== undefined && spec.min !== '' && v < Number(spec.min)) v = Number(spec.min);
  if (spec.max !== undefined && spec.max !== '' && v > Number(spec.max)) v = Number(spec.max);
  return v;
};

export function numericField(spec = {}) {
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
  const format = typeof spec.format === 'function' ? spec.format : (v) => String(v);
  const show = (v) => (v === null || v === undefined || v === '' ? '' : Number.isFinite(Number(v)) ? format(Number(v)) : String(v));
  input.value = show(spec.value);

  let label = null;
  let unit = null;
  if (spec.label) {
    label = document.createElement('span');
    label.className = 'numeric-label' + (spec.scrubby ? ' scrubby' : '');
    label.textContent = spec.label;
  }
  if (spec.unit) {
    unit = document.createElement('span');
    unit.className = 'opt-unit';
    unit.textContent = spec.unit;
  }
  let element = input;
  if (label || unit) {
    element = document.createElement('span');
    element.className = 'numeric-field';
    if (label) element.appendChild(label);
    element.appendChild(input);
    if (unit) element.appendChild(unit);
  }

  const get = () => {
    const v = Number(input.value);
    return input.value === '' || !Number.isFinite(v) ? null : v;
  };
  const set = (v, { silent = true } = {}) => {
    input.value = show(v);
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
    if (v !== null) spec.onChange?.(clampTo(v, spec));
  });

  // the minimal scrubby label: drag left / right
  let drag = null;
  const onDown = (e) => {
    if (e.button !== 0 || input.disabled) return;
    drag = { x: e.clientX, start: get() ?? 0, id: e.pointerId };
    label.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!drag) return;
    const step = Number(spec.step) || 1;
    const v = clampTo(Math.round((drag.start + (e.clientX - drag.x) * step) / step) * step, spec);
    input.value = show(v);
    spec.onInput?.(v);
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    const v = get();
    if (v !== null) spec.onChange?.(v);
  };
  if (label && spec.scrubby) {
    label.style.cursor = 'ew-resize';
    label.addEventListener('pointerdown', onDown);
    label.addEventListener('pointermove', onMove);
    label.addEventListener('pointerup', onUp);
    label.addEventListener('pointercancel', onUp);
  }

  return {
    element,
    input,
    label,
    get,
    set,
    setDisabled(b) {
      input.disabled = !!b;
    },
    destroy() {
      element.remove();
    },
  };
}
