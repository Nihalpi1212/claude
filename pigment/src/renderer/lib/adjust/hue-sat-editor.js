// The Hue/Saturation editor (adjust-color; I.2, J.9): Master and the six colour ranges, each with its own hue,
// saturation and lightness; the range bars with the four bounds handles (drag a handle, or the full-effect band to move
// the whole range); the three range eyedroppers (sample: pick the range of a colour and centre it there; + and -: widen
// or narrow the range); the on-image tool (click a colour to pick its range, drag left or right for its saturation,
// Ctrl-drag for its hue); Colorize. Registered with app.adjustEditors by lib/adjust/color.js; the frame (I.1) shows the
// eyedroppers, the on-image button and the presets.
//
// Parameters out are always the 0.4 shape: the top-level values are the Master, `range: 'master'`, and `ranges` lists
// the ranges that change something or whose bounds were edited. 0.3's single-range params are read as J.9 says (the
// editor shows that range selected).
import { buildForm } from '../form.js';
import { registerIcons } from '../icons.js';
import {
  HUE_BASES, DEFAULT_RANGE_BOUNDS, hueSatRanges, normalizeBounds, boundsWeight, rangeForColor, hueOf, addHueToRange, subtractHueFromRange,
} from '../../../shared/pixels/adjust-color.js';
import { hslToRgb } from '../../../shared/pixels/color.js';

const DROPPER = '<path d="m14 7 3 3"/><path d="M5 19 15 9l-1-1 3-3a2.1 2.1 0 0 1 3 3l-3 3-1-1L6 20H4z"/>';
registerIcons({
  'eyedropper-sample': DROPPER,
  'eyedropper-plus': `${DROPPER}<path d="M17 17h6M20 14v6" stroke-width="1.6"/>`,
  'eyedropper-minus': `${DROPPER}<path d="M17 17h6" stroke-width="1.6"/>`,
  'on-image': '<path d="M12 3v18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/><circle cx="12" cy="12" r="2"/>',
});

const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const wrap360 = (v) => ((v % 360) + 360) % 360;
const LABELS = { master: 'Master', reds: 'Reds', yellows: 'Yellows', greens: 'Greens', cyans: 'Cyans', blues: 'Blues', magentas: 'Magentas' };
const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Editor state from params: the Master values, colorize and all six ranges (defaults where the params have none). */
function stateOf(params) {
  const p = params ?? {};
  const { master, ranges } = hueSatRanges(p);
  const map = {};
  for (const b of HUE_BASES) map[b] = { bounds: [...DEFAULT_RANGE_BOUNDS[b]], hue: 0, saturation: 0, lightness: 0 };
  for (const r of ranges) map[r.base] = { bounds: [...r.bounds], hue: r.hue, saturation: r.saturation, lightness: r.lightness };
  // 0.3's single range opens with that range selected
  const legacy = !(Array.isArray(p.ranges) && p.ranges.length) && p.range && p.range !== 'master' && map[p.range] ? p.range : null;
  return {
    master: { ...master },
    colorize: !!p.colorize,
    colorizeHue: p.colorizeHue ?? 0,
    colorizeSat: p.colorizeSat ?? 25,
    colorizeLight: p.colorizeLight ?? 0,
    map,
    selected: legacy ?? 'master',
  };
}

/** The 0.4 params of an editor state. */
export function paramsOfState(st) {
  const ranges = [];
  for (const b of HUE_BASES) {
    const r = st.map[b];
    const def = DEFAULT_RANGE_BOUNDS[b];
    const moved = r.bounds.some((v, k) => v !== def[k]);
    if (moved || r.hue || r.saturation || r.lightness) ranges.push({ base: b, bounds: [...r.bounds], hue: r.hue, saturation: r.saturation, lightness: r.lightness });
  }
  return {
    hue: st.master.hue, saturation: st.master.saturation, lightness: st.master.lightness,
    colorize: st.colorize, colorizeHue: st.colorizeHue, colorizeSat: st.colorizeSat, colorizeLight: st.colorizeLight,
    range: 'master', ranges,
  };
}

/** Bounds centred on hue h with the default widths (the sample eyedropper moves a range to the sampled colour). */
const centredOn = (h) => [wrap360(Math.round(h) - 45), wrap360(Math.round(h) - 15), wrap360(Math.round(h) + 15), wrap360(Math.round(h) + 45)];

export function hueSatEditor(kind, params, onChange, { app = null } = {}) {
  let st = stateOf(params);
  const target = () => (st.selected === 'master' ? st.master : st.map[st.selected]);
  const emit = () => onChange(paramsOfState(st));

  const root = document.createElement('div');
  root.className = 'hue-sat-editor';
  const off = (v) => !v.colorize, on = (v) => !!v.colorize;
  const S = (key, label, min, max, extra = {}) => ({ key, label, type: 'slider', min, max, step: 1, ...extra });
  const fields = [
    { key: '__range', label: 'Edit', type: 'select', options: ['master', ...HUE_BASES].map((k) => [k, LABELS[k]]), when: off, span: true },
    S('hue', 'Hue', -180, 180, { when: off, unit: '°' }),
    S('saturation', 'Saturation', -100, 100, { when: off }),
    S('lightness', 'Lightness', -100, 100, { when: off }),
    { type: 'custom', key: '__bars', when: (v) => !v.colorize && v.__range !== 'master', render: () => bars.element },
    { key: 'colorize', label: 'Colorize', type: 'checkbox' },
    S('colorizeHue', 'Hue', 0, 360, { when: on, unit: '°' }),
    S('colorizeSat', 'Saturation', 0, 100, { when: on }),
    S('colorizeLight', 'Lightness', -100, 100, { when: on }),
  ];
  const formValues = () => ({
    __range: st.selected, hue: target().hue, saturation: target().saturation, lightness: target().lightness,
    colorize: st.colorize, colorizeHue: st.colorizeHue, colorizeSat: st.colorizeSat, colorizeLight: st.colorizeLight,
  });
  const bars = rangeBars({
    get: () => (st.selected === 'master' ? null : st.map[st.selected]),
    master: () => st.master,
    onBounds: (bounds) => {
      if (st.selected === 'master') return;
      st.map[st.selected].bounds = bounds;
      emit();
    },
  });
  const form = buildForm(fields, {
    app,
    values: formValues(),
    onChange: (values, key) => {
      if (key === '__range') {
        st.selected = values.__range;
        syncForm();
        return;
      }
      if (key === 'hue' || key === 'saturation' || key === 'lightness') target()[key] = values[key];
      else if (key && key in st) st[key] = values[key];
      bars.draw();
      emit();
    },
  });
  root.appendChild(form.element);
  function syncForm() {
    for (const [k, v] of Object.entries(formValues())) form.set(k, v, { silent: true });
    bars.draw();
  }
  bars.draw();

  /** Selects a colour's range (the eyedroppers and the on-image tool); grey picks Master. */
  const selectFor = (rgba, { centre = false } = {}) => {
    const base = rgba ? rangeForColor(rgba) : null;
    if (!base) {
      if (st.selected !== 'master') {
        st.selected = 'master';
        syncForm();
      }
      return null;
    }
    st.selected = base;
    if (centre) st.map[base].bounds = centredOn(hueOf(rgba));
    syncForm();
    return base;
  };
  const eyedroppers = [
    {
      id: 'sample',
      label: 'Sample a color in the image to edit its range',
      icon: 'eyedropper-sample',
      pick(rgba) {
        if (st.colorize || !rgba || rgba[3] === 0) return;
        if (selectFor(rgba, { centre: true })) emit();
      },
    },
    {
      id: 'add',
      label: 'Add a sampled color to the range',
      icon: 'eyedropper-plus',
      pick(rgba) {
        if (st.colorize || !rgba || rgba[3] === 0) return;
        const h = hueOf(rgba);
        if (h === null) return;
        if (st.selected === 'master' && !selectFor(rgba, { centre: true })) return;
        st.map[st.selected].bounds = addHueToRange(st.map[st.selected].bounds, Math.round(h));
        syncForm();
        emit();
      },
    },
    {
      id: 'subtract',
      label: 'Subtract a sampled color from the range',
      icon: 'eyedropper-minus',
      pick(rgba) {
        if (st.colorize || !rgba || rgba[3] === 0 || st.selected === 'master') return;
        const h = hueOf(rgba);
        if (h === null) return;
        st.map[st.selected].bounds = subtractHueFromRange(st.map[st.selected].bounds, Math.round(h));
        syncForm();
        emit();
      },
    },
  ];
  let drag = null;
  return {
    element: root,
    form,
    setParams(next) {
      const keep = st.selected;
      st = stateOf(next);
      // keep the range the user is looking at unless the new params name one
      if (st.selected === 'master' && keep !== 'master') st.selected = keep;
      syncForm();
    },
    eyedroppers,
    onImage: {
      label: 'Click and drag in the image to modify saturation; Ctrl-drag to modify hue',
      icon: 'on-image',
      cursor: 'ew-resize',
      down(rgba, pt) {
        if (st.colorize || !rgba || rgba[3] === 0) return;
        selectFor(rgba);
        const t = target();
        drag = { hue: t.hue, saturation: t.saturation, x: pt?.screenX ?? 0, ctrl: !!(pt?.ctrl || pt?.meta) };
      },
      move(_rgba, pt) {
        if (!drag) return;
        const dx = (pt?.screenX ?? drag.x) - drag.x;
        const t = target();
        if (drag.ctrl || pt?.ctrl || pt?.meta) t.hue = clampTo(drag.hue + dx, -180, 180);
        else t.saturation = clampTo(drag.saturation + dx, -100, 100);
        syncForm();
        emit();
      },
      up() {
        drag = null;
      },
    },
  };
}

/**
 * The range bars: the input spectrum on top, the adjusted spectrum below, centred on the selected range, with its
 * four bounds as handles ([data-bound="0".."3"]) and the full-effect band ([data-bound="band"]) between b and c.
 * Dragging a handle moves that bound (kept in order); dragging the band moves the whole range.
 */
function rangeBars({ get, master, onBounds }) {
  const W = 300, H = 12;
  const element = document.createElement('div');
  element.className = 'hs-bars';
  const top = document.createElement('canvas');
  const bottom = document.createElement('canvas');
  for (const c of [top, bottom]) {
    c.width = W;
    c.height = H;
    c.className = 'hs-spectrum';
  }
  const track = document.createElement('div');
  track.className = 'hs-track';
  const band = document.createElement('div');
  band.className = 'hs-band';
  band.dataset.bound = 'band';
  const falloff = document.createElement('div');
  falloff.className = 'hs-falloff';
  track.append(falloff, band);
  const handles = [0, 1, 2, 3].map((k) => {
    const h = document.createElement('div');
    h.className = `hs-handle hs-handle-${k < 1 || k > 2 ? 'outer' : 'inner'}`;
    h.dataset.bound = String(k);
    h.title = k === 0 || k === 3 ? 'Drag to change the fall-off' : 'Drag to change the range';
    track.appendChild(h);
    return h;
  });
  const readout = document.createElement('div');
  readout.className = 'hs-readout muted';
  element.append(top, track, bottom, readout);

  let centre = 0;
  const xOf = (h) => (wrap360(h - centre + 180) / 360) * 100; // percent across the bar
  const hueAt = (fraction) => centre - 180 + fraction * 360;

  function draw() {
    const r = get();
    if (!r) return;
    const [a, b, c, d] = r.bounds;
    centre = wrap360(b + wrap360(c - b) / 2);
    const m = master();
    const tc = top.getContext('2d'), bc = bottom.getContext('2d');
    for (let x = 0; x < W; x++) {
      const h = hueAt((x + 0.5) / W);
      const [r0, g0, b0] = hslToRgb(h, 1, 0.5);
      tc.fillStyle = `rgb(${r0 | 0},${g0 | 0},${b0 | 0})`;
      tc.fillRect(x, 0, 1, H);
      const w = boundsWeight(r.bounds, wrap360(h));
      const [r1, g1, b1] = hslToRgb(h + m.hue + r.hue * w, 1, 0.5);
      bc.fillStyle = `rgb(${r1 | 0},${g1 | 0},${b1 | 0})`;
      bc.fillRect(x, 0, 1, H);
    }
    const pos = [a, b, c, d].map(xOf);
    // a range wider than the bar's half-circle around its centre still draws in order
    if (pos[1] > pos[2]) pos[1] = 0;
    if (pos[0] > pos[1]) pos[0] = 0;
    if (pos[3] < pos[2]) pos[3] = 100;
    handles.forEach((hd, k) => {
      hd.style.left = `${pos[k]}%`;
    });
    band.style.left = `${pos[1]}%`;
    band.style.width = `${Math.max(0, pos[2] - pos[1])}%`;
    falloff.style.left = `${pos[0]}%`;
    falloff.style.width = `${Math.max(0, pos[3] - pos[0])}%`;
    readout.textContent = `${Math.round(a)}°/${Math.round(b)}°   ${Math.round(c)}°\\${Math.round(d)}°`;
  }

  // dragging
  let drag = null;
  const fractionOf = (e) => {
    const rect = track.getBoundingClientRect();
    return rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
  };
  track.addEventListener('pointerdown', (e) => {
    const which = e.target?.dataset?.bound;
    if (which === undefined || !get()) return;
    e.preventDefault();
    track.setPointerCapture?.(e.pointerId);
    drag = { which, start: hueAt(fractionOf(e)), bounds: [...get().bounds], centre };
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // the bar keeps the centre it had when the drag started, so the handle stays under the pointer
    const h = drag.centre - 180 + fractionOf(e) * 360;
    const delta = Math.round(h - drag.start);
    let next;
    if (drag.which === 'band') next = drag.bounds.map((v) => wrap360(v + delta));
    else {
      const k = Number(drag.which);
      next = [...drag.bounds];
      // keep the bounds in order around the circle: offsets from a, the whole range under 360 degrees
      const off = drag.bounds.map((v) => wrap360(v - drag.bounds[0]));
      if (k === 0) next[0] = wrap360(drag.bounds[0] + Math.min(Math.max(delta, off[3] - 359), off[1]));
      else next[k] = wrap360(drag.bounds[0] + Math.min(Math.max(off[k] + delta, off[k - 1]), k === 3 ? 359 : off[k + 1]));
    }
    if (!normalizeBounds(next)) return;
    onBounds(next.map((v) => Math.round(v)));
    draw();
  });
  const end = () => {
    drag = null;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);

  return { element, draw };
}

export { clone as cloneHueSat };
