// Field widgets (ARCHITECTURE.md "0.4 features", H; E7): one widget API for dialog forms (form.js buildField),
// panels and the options bar (tools.js buildControl). A form field `type` or an option `kind` that is not built in
// and has a registered widget is built with createWidget. Skeleton file; no package edits it: packages register
// their widgets (the later registration wins).
//
//   registerWidget(type, factory(spec, { value, onInput(v), onChange(v), app }) -> Widget)
//   createWidget(type, spec, opts) -> Widget;  hasWidget(type) -> boolean;  isStubWidget(type) -> boolean (tests)
//   Widget: { element, get(), set(value, { silent }?), setDisabled?(b), destroy?() }
//
// The stub widgets below are deliberately plain; their owners replace them: numeric (conventions-shortcuts-fields),
// gradient (gradients), pattern (patterns), contour (layer-style-effects), preset (adjust-tonal), paint (shapes-live),
// font-size (type-character-panel).
import { numericField } from './numeric-field.js';
import { gradientLut, normalizeGradient } from '../../shared/pixels/gradient-model.js';
import { patternCanvas } from './patterns.js';

const WIDGETS = new Map();

export function registerWidget(type, factory) {
  if (typeof type !== 'string' || typeof factory !== 'function') throw new Error('registerWidget(type, factory)');
  WIDGETS.set(type, factory);
}

export function hasWidget(type) {
  return WIDGETS.has(type);
}

export function createWidget(type, spec = {}, opts = {}) {
  const factory = WIDGETS.get(type);
  if (!factory) throw new Error(`No widget of type "${type}"`);
  const app = opts.app ?? spec.app ?? globalThis.pigmentApp ?? null;
  return factory(spec, { value: opts.value, onInput: opts.onInput ?? (() => {}), onChange: opts.onChange ?? (() => {}), app });
}

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

// ---- numeric -----------------------------------------------------------------------------------------------------

registerWidget('numeric', (spec, { value, onInput, onChange }) => {
  const f = numericField({ ...spec, value: value ?? spec.value, onInput, onChange });
  return { element: f.element, get: f.get, set: f.set, setDisabled: f.setDisabled, destroy: f.destroy };
});

// ---- font-size (options bar): today's number field in px ------------------------------------------------------------

registerWidget('font-size', (spec, { value, onInput, onChange }) => {
  const box = el('span', 'opt-number');
  const f = numericField({ min: spec.min, max: spec.max, step: spec.step ?? 1, value: value ?? spec.default ?? spec.value, onChange: (v) => onChange(v) });
  // 0.3's options bar number field commits on change only; typing does not apply each keystroke
  void onInput;
  box.appendChild(f.input);
  const u = el('span', 'opt-unit', 'px');
  box.appendChild(u);
  return { element: box, get: f.get, set: (v) => f.set(v), setDisabled: f.setDisabled, destroy: () => box.remove() };
});

// ---- gradient: a bar and a popover with the two end colours and Reverse --------------------------------------------

/** CSS background of a gradient bar (straight colours, so the checkerboard behind shows transparency). */
export function gradientCss(def, { fg, bg, reverse = false } = {}) {
  const lut = gradientLut(def, { fg, bg, reverse, size: 16 });
  const parts = [];
  for (let i = 0; i < 16; i++) parts.push(`rgba(${lut[i * 4]},${lut[i * 4 + 1]},${lut[i * 4 + 2]},${(lut[i * 4 + 3] / 255).toFixed(3)}) ${Math.round((i / 15) * 100)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

registerWidget('gradient', (spec, { value, onInput, onChange, app }) => {
  const colors = () => ({ fg: app?.settings?.foreground, bg: app?.settings?.background });
  // stored values never hold colour references (G.1): every value this widget reports is resolved
  const resolve = (v) => normalizeGradient(v, colors());
  let current = resolve(value ?? spec.value ?? null);
  const wrap = el('span', 'field-gradient');
  const bar = el('button', 'gradient-bar field-gradient-bar');
  bar.type = 'button';
  bar.title = 'Edit the gradient';
  wrap.appendChild(bar);
  const paint = () => {
    bar.style.background = gradientCss(current, { ...colors(), reverse: !!current.reverse });
  };
  paint();
  const emit = () => {
    const out = spec.placement === false ? stripPlacement(current) : clone(current);
    onInput(out);
    onChange(out);
  };
  // the editor opens inline under the bar (a popover would sit under a dialog's backdrop)
  let box = null;
  bar.addEventListener('click', () => {
    if (box) {
      box.remove();
      box = null;
      return;
    }
    box = el('div', 'field-gradient-pop');
    const row = (label, input) => {
      const r = el('label', 'field-gradient-row');
      r.append(el('span', '', label), input);
      box.appendChild(r);
    };
    const hex = (s) => (typeof s?.color === 'string' ? s.color.slice(0, 7) : '#000000');
    const c0 = el('input');
    c0.type = 'color';
    c0.dataset.key = 'start';
    c0.value = hex(current.stops[0]);
    const c1 = el('input');
    c1.type = 'color';
    c1.dataset.key = 'end';
    c1.value = hex(current.stops[current.stops.length - 1]);
    const rev = el('input');
    rev.type = 'checkbox';
    rev.dataset.key = 'reverse';
    rev.checked = !!current.reverse;
    row('Start color', c0);
    row('End color', c1);
    row('Reverse', rev);
    const update = () => {
      const stops = current.stops.map((s) => ({ ...s }));
      stops[0] = { ...stops[0], color: c0.value };
      stops[stops.length - 1] = { ...stops[stops.length - 1], color: c1.value };
      current = resolve({ ...current, stops, reverse: rev.checked });
      paint();
      emit();
    };
    for (const i of [c0, c1, rev]) i.addEventListener(i.type === 'checkbox' ? 'change' : 'input', update);
    wrap.appendChild(box);
  });
  return {
    element: wrap,
    get: () => (spec.placement === false ? stripPlacement(current) : clone(current)),
    set(v, { silent = true } = {}) {
      current = resolve(v);
      paint();
      if (!silent) emit();
    },
    setDisabled(b) {
      bar.disabled = !!b;
    },
    destroy: () => wrap.remove(),
  };
});

const PLACEMENT_ONLY = ['kind', 'angle', 'scale', 'offset', 'align', 'from', 'to'];
function stripPlacement(def) {
  const out = clone(def);
  for (const k of PLACEMENT_ONLY) delete out[k];
  return out;
}

// ---- pattern: a swatch and "Use current pattern" ----------------------------------------------------------------------

registerWidget('pattern', (spec, { value, onInput, onChange, app }) => {
  let current = value ?? spec.value ?? null;
  const wrap = el('span', 'field-pattern');
  const sw = el('span', 'field-pattern-swatch');
  const use = el('button', 'btn small', 'Use current pattern');
  use.type = 'button';
  wrap.append(sw, use);
  const url = (ref) => (typeof ref === 'string' ? ref : ref?.dataUrl ?? null);
  const paint = () => {
    sw.replaceChildren();
    if (url(current)) sw.appendChild(patternCanvas(url(current), 24));
    const has = !!app?.patterns?.current?.();
    use.disabled = !has;
    use.title = has ? '' : 'Define a pattern first (Edit › Define Pattern)';
  };
  paint();
  use.addEventListener('click', () => {
    const entry = app?.patterns?.current?.();
    if (!entry) return;
    current = app.patterns.ref(entry); // a stored ref always carries the pixels (L.6)
    paint();
    onInput(clone(current));
    onChange(clone(current));
  });
  return {
    element: wrap,
    get: () => clone(current),
    set(v, { silent = true } = {}) {
      current = v ?? null;
      paint();
      if (!silent) {
        onInput(clone(current));
        onChange(clone(current));
      }
    },
    setDisabled(b) {
      use.disabled = !!b;
    },
    destroy: () => wrap.remove(),
  };
});

// ---- contour: a select of the contours presets with a curve preview ------------------------------------------------

const LINEAR_CONTOUR = { name: 'Linear', points: [{ x: 0, y: 0, corner: false }, { x: 1, y: 1, corner: false }] };

function drawContour(canvas, contour) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width;
  ctx.clearRect(0, 0, s, s);
  ctx.strokeStyle = 'currentColor';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  const pts = contour?.points?.length ? contour.points : LINEAR_CONTOUR.points;
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x * (s - 1), (1 - p.y) * (s - 1)) : ctx.moveTo(p.x * (s - 1), (1 - p.y) * (s - 1))));
  ctx.stroke();
}

registerWidget('contour', (spec, { value, onInput, onChange, app }) => {
  let current = value ?? spec.value ?? LINEAR_CONTOUR;
  const wrap = el('span', 'field-contour');
  const preview = el('canvas', 'field-contour-preview');
  preview.width = preview.height = 32;
  const select = el('select', 'select');
  wrap.append(preview, select);
  const presets = () => {
    const list = app?.presets?.list?.('contours') ?? [];
    return list.length ? list : [{ id: 'linear', name: 'Linear', data: LINEAR_CONTOUR }];
  };
  const fill = () => {
    select.replaceChildren();
    const list = presets();
    let selected = null;
    for (const p of list) {
      const o = new Option(p.name, p.id);
      select.add(o);
      if (JSON.stringify(p.data?.points) === JSON.stringify(current?.points)) selected = p.id;
    }
    if (!selected) {
      select.add(new Option('Custom', ''));
      selected = '';
    }
    select.value = selected;
    drawContour(preview, current);
  };
  fill();
  select.addEventListener('change', () => {
    const p = presets().find((x) => x.id === select.value);
    if (!p) return;
    current = clone(p.data);
    drawContour(preview, current);
    onInput(clone(current));
    onChange(clone(current));
  });
  return {
    element: wrap,
    get: () => clone(current),
    set(v, { silent = true } = {}) {
      current = v ?? LINEAR_CONTOUR;
      fill();
      if (!silent) {
        onInput(clone(current));
        onChange(clone(current));
      }
    },
    setDisabled(b) {
      select.disabled = !!b;
    },
    destroy: () => wrap.remove(),
  };
});

// ---- preset: a select of app.presets.list(spec.kind) and "Save Preset…" -------------------------------------------

registerWidget('preset', (spec, { value, onInput, onChange, app }) => {
  let current = value ?? null;
  const wrap = el('span', 'field-preset');
  const select = el('select', 'select');
  select.dataset.presetKind = spec.kind ?? '';
  const save = el('button', 'btn small', 'Save Preset…');
  save.type = 'button';
  wrap.append(select, save);
  const fill = () => {
    select.replaceChildren(new Option(spec.noneLabel ?? 'Custom', ''));
    for (const p of app?.presets?.list?.(spec.kind) ?? []) select.add(new Option(p.name, p.id));
    select.value = current ?? '';
    if (select.value !== (current ?? '')) select.value = '';
    save.hidden = typeof spec.getData !== 'function';
  };
  fill();
  // the kind's file loads once; until then list() gives the built-ins (an unknown kind has no presets)
  try {
    app?.presets?.ready?.(spec.kind)?.then(fill).catch(() => {});
  } catch {
    /* not a registered kind */
  }
  select.addEventListener('change', () => {
    current = select.value || null;
    const preset = current ? app?.presets?.get?.(spec.kind, current) : null;
    if (preset) spec.onPick?.(preset);
    onInput(current);
    onChange(current);
  });
  save.addEventListener('click', async () => {
    if (!app?.presets || typeof spec.getData !== 'function') return;
    const name = await app.dialogs.prompt('Name', { title: 'Save Preset', value: spec.defaultName ?? 'Preset' });
    if (!name?.trim()) return;
    await app.presets.ready(spec.kind); // editing before the user file is read would overwrite it (presets.js)
    const preset = app.presets.add(spec.kind, { name: name.trim(), data: clone(spec.getData()) });
    current = preset.id;
    fill();
    onInput(current);
    onChange(current);
  });
  return {
    element: wrap,
    get: () => current,
    set(v, { silent = true } = {}) {
      current = v ?? null;
      fill();
      if (!silent) {
        onInput(current);
        onChange(current);
      }
    },
    setDisabled(b) {
      select.disabled = save.disabled = !!b;
    },
    destroy: () => wrap.remove(),
  };
});

// ---- paint: a segment for the type and the matching widget ---------------------------------------------------------

const PAINT_LABELS = { none: 'None', solid: 'Color', gradient: 'Gradient', pattern: 'Pattern' };

registerWidget('paint', (spec, { value, onInput, onChange, app }) => {
  const allow = Array.isArray(spec.allow) && spec.allow.length ? spec.allow : ['none', 'solid', 'gradient', 'pattern'];
  let current = value ?? spec.value ?? null;
  const wrap = el('span', 'field-paint');
  const seg = el('span', 'opt-segment');
  const body = el('span', 'field-paint-body');
  wrap.append(seg, body);
  const typeOf = (p) => (p ? p.type : 'none');
  let sub = null;
  // a pattern paint holds its canvas (G.2): copied by reference, never through JSON
  const copy = (p) => (p ? { ...p, ...(p.gradient ? { gradient: clone(p.gradient) } : {}), ...(p.pattern ? { pattern: { ...p.pattern } } : {}) } : null);
  const patternPaint = (ref) => {
    const data = ref ? app?.patterns?.resolve?.(ref) ?? null : null;
    let canvas = null;
    if (data) {
      canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d').putImageData(data, 0, 0);
    }
    return { type: 'pattern', pattern: { canvas, scale: current?.pattern?.scale ?? 1, ...(ref?.presetId ? { presetId: ref.presetId } : {}), ...(ref?.name ? { name: ref.name } : {}) } };
  };
  const emit = () => {
    onInput(copy(current));
    onChange(copy(current));
  };
  const build = () => {
    sub?.destroy?.();
    sub = null;
    body.replaceChildren();
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.value === typeOf(current)));
    const t = typeOf(current);
    if (t === 'solid') {
      const input = el('input');
      input.type = 'color';
      input.value = typeof current.color === 'string' ? current.color.slice(0, 7) : '#000000';
      input.addEventListener('input', () => {
        current = { type: 'solid', color: input.value };
        emit();
      });
      body.appendChild(input);
    } else if (t === 'gradient') {
      sub = createWidget('gradient', { placement: spec.placement }, { app, value: current.gradient, onChange: (g) => {
        current = { type: 'gradient', gradient: g };
        emit();
      } });
      body.appendChild(sub.element);
    } else if (t === 'pattern') {
      sub = createWidget('pattern', {}, { app, value: null, onChange: (ref) => {
        current = patternPaint(ref);
        emit();
      } });
      body.appendChild(sub.element);
    }
  };
  for (const t of allow) {
    const b = el('button', 'seg-button', PAINT_LABELS[t] ?? t);
    b.type = 'button';
    b.dataset.value = t;
    b.addEventListener('click', () => {
      if (typeOf(current) === t) return;
      const fg = app?.settings?.foreground ?? '#000000', bg = app?.settings?.background ?? '#ffffff';
      current = t === 'none' ? null
        : t === 'solid' ? { type: 'solid', color: fg }
          : t === 'gradient' ? { type: 'gradient', gradient: normalizeGradient({ kind: 'linear', stops: [{ pos: 0, color: fg }, { pos: 1, color: bg }] }, { fg, bg }) }
            : patternPaint(app?.patterns?.current?.() ? app.patterns.ref(app.patterns.current()) : null);
      build();
      emit();
    });
    seg.appendChild(b);
  }
  build();
  return {
    element: wrap,
    get: () => copy(current),
    set(v, { silent = true } = {}) {
      current = v ?? null;
      build();
      if (!silent) emit();
    },
    setDisabled(b) {
      for (const x of wrap.querySelectorAll('button, input, select')) x.disabled = !!b;
    },
    destroy: () => {
      sub?.destroy?.();
      wrap.remove();
    },
  };
});

// The stub factories above, so tests can tell whether an owner has replaced a widget yet (rule 8's capability check)
const STUB_FACTORIES = new Set(WIDGETS.values());
/** True while `type` is still the skeleton's stub widget (its owner has not registered one). */
export function isStubWidget(type) {
  return STUB_FACTORIES.has(WIDGETS.get(type));
}
