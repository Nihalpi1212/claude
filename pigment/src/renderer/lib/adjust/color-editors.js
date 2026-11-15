// Adjustment editors of adjust-color (I.2), registered with app.adjustEditors by lib/adjust/color.js: Black & White
// (Auto, the on-image tool, presets), Photo Filter (Photoshop's filter list), Channel Mixer (output channel, total,
// presets), Gradient Map (the `gradient` widget with Reverse, Dither and the method), Selective Color (presets) and the
// three 0.4 kinds. Hue/Saturation and Shadows/Highlights have files of their own. Every editor returns `setParams` so
// presets, Auto and Reset update it in place; field data-keys keep 0.3's names (reds…magentas, color, density,
// r.r…gray.constant), so 0.3's specs find them.
import { buildForm } from '../form.js';
import { getPath, setPath } from '../adjust-ui.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { PHOTO_FILTERS, blackWhiteAuto, rangeForColor, mixerTotal } from '../../../shared/pixels/adjust-color.js';
import { normalizeGradient } from '../../../shared/pixels/gradient-model.js';
import '../gradient-widget.js'; // the `gradient` field widget (gradients package)

const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
export const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const CB = (key, label, extra = {}) => ({ key, label, type: 'checkbox', ...extra });

/**
 * A form-backed editor over params with dotted keys (`r.g`): fields whose key starts with `__` are UI state. `read`
 * turns params into extra form values, `write(params, values)` the reverse for the UI-state fields. Returns
 * { form, element, get(), set(params) }.
 */
export function pathFormEditor(fields, params, onChange, { read = null, write = null, app = null, defaults = null } = {}) {
  let p = clone(params) ?? {};
  const valuesOf = () => {
    const v = {};
    for (const f of fields) {
      if (!f.key || f.key.startsWith('__')) continue;
      const x = getPath(p, f.key);
      v[f.key] = x ?? f.value ?? (f.type === 'checkbox' ? false : f.type === 'color' ? '#000000' : 0);
    }
    return { ...v, ...(read ? read(p) : {}) };
  };
  const initial = valuesOf();
  for (const f of fields) if (f.key?.startsWith('__') && initial[f.key] === undefined) initial[f.key] = typeof f.value === 'function' ? f.value() : f.value;
  const form = buildForm(fields, {
    app,
    values: initial,
    onChange: (values, key) => {
      if (key && key.startsWith('__') && !(write && write.uiKeys?.includes(key))) return; // UI-only (an output menu)
      for (const f of fields) if (f.key && !f.key.startsWith('__')) setPath(p, f.key, values[f.key]);
      if (write) p = write(p, values, key) ?? p;
      onChange(clone(p));
    },
  });
  return {
    form,
    element: form.element,
    get: () => clone(p),
    set(next) {
      p = { ...clone(defaults ?? {}), ...clone(next ?? {}) };
      const v = valuesOf();
      for (const [k, val] of Object.entries(v)) form.set(k, val, { silent: true });
    },
  };
}

// ---- Black & White -------------------------------------------------------------------------------------------------

const BW = [['reds', 'Reds', '#e03030'], ['yellows', 'Yellows', '#e0d020'], ['greens', 'Greens', '#30b030'], ['cyans', 'Cyans', '#20c0d0'], ['blues', 'Blues', '#3050e0'], ['magentas', 'Magentas', '#d030d0']];

export function blackWhiteEditor(kind, params, onChange, { app = null, source = null } = {}) {
  const tint = (v) => !!v.__tint;
  const fields = [
    ...BW.map(([k, label]) => S(k, label, -200, 300, 1, { unit: '%', className: `bw-${k}` })),
    CB('__tint', 'Tint'),
    S('__tintHue', 'Hue', 0, 360, 1, { when: tint, unit: '°' }),
    S('__tintSat', 'Saturation', 0, 100, 1, { when: tint, unit: '%' }),
  ];
  const ed = pathFormEditor(fields, params, onChange, {
    app,
    defaults: ADJUSTMENTS[kind]?.defaults,
    read: (p) => ({ __tint: !!p.tint, __tintHue: p.tint?.hue ?? 42, __tintSat: p.tint?.sat ?? 20 }),
    write: Object.assign((p, v) => ({ ...p, tint: v.__tint ? { hue: v.__tintHue, sat: v.__tintSat } : null }), { uiKeys: ['__tint', '__tintHue', '__tintSat'] }),
  });
  ed.element.classList.add('bw-editor');
  // colour chips beside the six sliders (Photoshop's slider gradients)
  for (const [k, , color] of BW) {
    const input = ed.element.querySelector(`input[data-key="${k}"]`);
    const row = input?.closest('.field');
    if (row) row.style.setProperty('--bw-chip', color);
  }
  let drag = null;
  const emit = () => onChange(ed.get());
  return {
    element: ed.element,
    form: ed.form,
    setParams: (next) => ed.set(next),
    auto: { run: (src) => ({ ...ed.get(), ...blackWhiteAuto(src) }) },
    // Photoshop's on-image tool for Black & White: click a colour and drag left or right to change its slider
    onImage: {
      label: 'Click and drag in the image to modify a similar color',
      icon: 'on-image',
      cursor: 'ew-resize',
      down(rgba, pt) {
        const k = rgba ? rangeForColor(rgba) : null;
        if (!k) return;
        drag = { key: k, start: ed.get()[k] ?? 0, x: pt?.screenX ?? 0 };
      },
      move(_rgba, pt) {
        if (!drag) return;
        const v = Math.max(-200, Math.min(300, Math.round(drag.start + ((pt?.screenX ?? drag.x) - drag.x))));
        ed.set({ ...ed.get(), [drag.key]: v });
        emit();
      },
      up() {
        drag = null;
      },
    },
  };
}

// ---- Photo Filter --------------------------------------------------------------------------------------------------

const filterFor = (color) => PHOTO_FILTERS.find((f) => f[2].toLowerCase() === String(color ?? '').toLowerCase())?.[0] ?? 'custom';

export function photoFilterEditor(kind, params, onChange, { app = null } = {}) {
  const fields = [
    { key: '__filter', label: 'Filter', type: 'select', options: [...PHOTO_FILTERS.map(([id, name]) => [id, name]), ['custom', 'Custom color']] },
    { key: 'color', label: 'Color', type: 'color' },
    S('density', 'Density', 0, 100, 1, { unit: '%' }),
    CB('preserveLuminosity', 'Preserve luminosity'),
  ];
  let ed = null;
  ed = pathFormEditor(fields, params, onChange, {
    app,
    defaults: ADJUSTMENTS[kind]?.defaults,
    read: (p) => ({ __filter: filterFor(p.color) }),
    write: Object.assign((p, v, key) => {
      if (key === '__filter' && v.__filter !== 'custom') {
        const col = PHOTO_FILTERS.find((f) => f[0] === v.__filter)?.[2];
        if (col) {
          p.color = col;
          queueMicrotask(() => ed.form.set('color', col, { silent: true }));
        }
      } else if (key === 'color') queueMicrotask(() => ed.form.set('__filter', filterFor(v.color), { silent: true }));
      return p;
    }, { uiKeys: ['__filter'] }),
  });
  return { element: ed.element, form: ed.form, setParams: (next) => ed.set(next) };
}

// ---- Channel Mixer -------------------------------------------------------------------------------------------------

const OUTS = [['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];

export function channelMixerEditor(kind, params, onChange, { app = null } = {}) {
  const fields = [
    { key: '__out', label: 'Output channel', type: 'select', value: 'r', options: OUTS, when: (v) => !v.monochrome },
    CB('monochrome', 'Monochrome'),
  ];
  for (const o of ['r', 'g', 'b', 'gray']) {
    const when = o === 'gray' ? (v) => !!v.monochrome : (v) => !v.monochrome && v.__out === o;
    fields.push(S(`${o}.r`, 'Red', -200, 200, 1, { when, unit: '%' }), S(`${o}.g`, 'Green', -200, 200, 1, { when, unit: '%' }), S(`${o}.b`, 'Blue', -200, 200, 1, { when, unit: '%' }));
    fields.push({ type: 'custom', key: `__total.${o}`, when, render: () => totalRow(o) });
    fields.push(S(`${o}.constant`, 'Constant', -200, 200, 1, { when, unit: '%' }));
  }
  const totals = new Map();
  function totalRow(o) {
    const el = document.createElement('div');
    el.className = 'mixer-total';
    el.dataset.total = o;
    totals.set(o, el);
    return el;
  }
  const ed = pathFormEditor(fields, params, (p) => {
    showTotals(p);
    onChange(p);
  }, {
    app,
    defaults: ADJUSTMENTS[kind]?.defaults,
    write: Object.assign((p) => {
      if (p.monochrome && !p.gray) p.gray = { r: 40, g: 40, b: 20, constant: 0 };
      return p;
    }, { uiKeys: [] }),
  });
  function showTotals(p) {
    for (const [o, el] of totals) {
      const t = Math.round(mixerTotal(p[o] ?? ADJUSTMENTS['channel-mixer'].defaults[o]));
      el.textContent = `Total: ${t > 0 ? '+' : ''}${t} %`;
      // Photoshop warns when the sources add up to more than 100 %: the channel can clip
      el.classList.toggle('over', t > 100);
      el.title = t > 100 ? 'The total is above 100 %: bright colours in this channel may clip' : '';
    }
  }
  showTotals(ed.get());
  return {
    element: ed.element,
    form: ed.form,
    setParams(next) {
      ed.set(next);
      showTotals(ed.get());
    },
  };
}

// ---- Gradient Map --------------------------------------------------------------------------------------------------

/** The widget's value for Gradient Map params: the def (0.3 stops upgraded by the model) plus reverse and dither. */
export function gradientMapValue(p) {
  return { ...normalizeGradient(p ?? {}), reverse: !!p?.reverse, dither: !!p?.dither };
}

export function gradientMapEditor(kind, params, onChange, { app = null } = {}) {
  let p = clone(params) ?? {};
  const fields = [{ key: 'gradient', label: 'Gradient used for grayscale mapping', type: 'gradient', placement: false, flags: ['reverse', 'dither'], method: true, span: true }];
  const form = buildForm(fields, {
    app,
    values: { gradient: gradientMapValue(p) },
    onChange: (values) => {
      // the def replaces 0.3's stops: the model reads either
      p = { ...clone(values.gradient), reverse: !!values.gradient?.reverse, dither: !!values.gradient?.dither };
      onChange(clone(p));
    },
  });
  form.element.classList.add('gradient-map-editor');
  return {
    element: form.element,
    form,
    setParams(next) {
      p = clone(next) ?? {};
      form.set('gradient', gradientMapValue(p), { silent: true });
    },
  };
}

// ---- Selective Color -----------------------------------------------------------------------------------------------

const SEL = [['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['whites', 'Whites'], ['neutrals', 'Neutrals'], ['blacks', 'Blacks']];

export function selectiveColorEditor(kind, params, onChange, { app = null } = {}) {
  const fields = [{ key: '__range', label: 'Colors', type: 'select', value: 'reds', options: SEL, span: true }];
  for (const [r] of SEL) {
    const when = (v) => v.__range === r;
    fields.push(S(`${r}.c`, 'Cyan', -100, 100, 1, { when, unit: '%' }), S(`${r}.m`, 'Magenta', -100, 100, 1, { when, unit: '%' }), S(`${r}.y`, 'Yellow', -100, 100, 1, { when, unit: '%' }), S(`${r}.k`, 'Black', -100, 100, 1, { when, unit: '%' }));
  }
  fields.push({ key: 'relative', label: 'Method', type: 'segment', options: [[true, 'Relative'], [false, 'Absolute']] });
  const ed = pathFormEditor(fields, params, onChange, { app, defaults: ADJUSTMENTS[kind]?.defaults });
  return { element: ed.element, form: ed.form, setParams: (next) => ed.set(next) };
}

// ---- Color and Vibrance, Clarity and Dehaze, Grain (the fields the registry declares) -------------------------------

export function fieldsEditor(kind, params, onChange, { app = null } = {}) {
  const fields = clone(ADJUSTMENTS[kind]?.fields ?? []);
  const ed = pathFormEditor(fields, params, onChange, { app, defaults: ADJUSTMENTS[kind]?.defaults });
  ed.element.classList.add(`${kind}-editor`);
  return { element: ed.element, form: ed.form, setParams: (next) => ed.set(next) };
}
