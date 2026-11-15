// Colour views (ARCHITECTURE.md "0.5 features", S7; color-picker-swatches, package 11): the pieces the colour picker
// dialog, the Color panel and the HUD colour picker draw with.
//
//   createAxisPicker({ axis, value, conv, web, onChange(state, { final }) }) -> { element, state, set(hex | state),
//     setAxis(id), setWeb(bool), redraw() }   Photoshop's field and strip for any of the nine axes (S, B, R… L, a, b)
//   createWheelView({ value, onChange(hex, { final }) })   a hue ring around a saturation/brightness square
//   createSliders({ model, value, conv, onChange(hex, { final }) })   Grayscale, RGB, HSB, CMYK, Lab, Web sliders
//   createRamp({ kind, web, colors(), onPick(hex, event) })   RGB / CMYK spectrum, grayscale ramp, current colours
//   drawHueSquare / drawHueStrip / drawHueRing   canvas painters shared with lib/hud-picker.js
//
// The numbers drawn are the document's RGB numbers shown as they are (panel images are not colour managed, S6.4).
import { hsvToRgb, rgbToHsv, rgbToCmyk, cmykToRgb, proofRgb } from '../../../shared/pixels/color.js';
import * as M from '../color-picker-model.js';

const el = (tag, className, html) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const css = (rgb) => M.hexOfRgb(rgb);

/** Calls fn(x 0..1, y 0..1, event, final) for a pointer drag on `target` (pointer captured). */
export function dragOn(target, fn) {
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    target.focus?.({ preventScroll: true });
    try {
      target.setPointerCapture(e.pointerId);
    } catch {}
    const at = (ev, final) => {
      const r = target.getBoundingClientRect();
      fn(clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1), clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1), ev, final);
    };
    at(e, false);
    const move = (ev) => at(ev, false);
    const up = (ev) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      at(ev, true);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  });
}

// ---- painters ------------------------------------------------------------------------------------------------------

/** The saturation (left to right) by brightness (top to bottom) square of a hue. */
export function drawHueSquare(ctx, x, y, size, hue) {
  const [r, g, b] = hsvToRgb(hue, 1, 1);
  ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
  ctx.fillRect(x, y, size, size);
  const white = ctx.createLinearGradient(x, 0, x + size, 0);
  white.addColorStop(0, 'rgba(255,255,255,1)');
  white.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = white;
  ctx.fillRect(x, y, size, size);
  const black = ctx.createLinearGradient(0, y, 0, y + size);
  black.addColorStop(0, 'rgba(0,0,0,0)');
  black.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = black;
  ctx.fillRect(x, y, size, size);
}

/** A vertical hue strip, 0° at the top. */
export function drawHueStrip(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  for (let i = 0; i <= 6; i++) {
    const [r, gg, b] = hsvToRgb(i * 60, 1, 1);
    g.addColorStop(i / 6, `rgb(${r | 0},${gg | 0},${b | 0})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

/** A hue ring, 0° at the top, clockwise. */
export function drawHueRing(ctx, cx, cy, inner, outer) {
  const steps = 120;
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1.5) / steps) * Math.PI * 2 - Math.PI / 2;
    const [r, g, b] = hsvToRgb((i / steps) * 360, 1, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, outer, a0, a1);
    ctx.arc(cx, cy, inner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fill();
  }
}

// ---- the field and strip of the nine axes --------------------------------------------------------------------------

/** What the field's picture depends on (it is redrawn only when this changes). */
function fieldKey(axis, st, web) {
  const [r, g, b] = st.rgb, [L, A, B] = st.lab;
  const v = { h: st.hsv.h, s: st.hsv.s, v: st.hsv.v, r, g, b, L, A, B }[axis];
  return `${axis}:${Math.round(v * 100)}:${web ? 1 : 0}`;
}
function stripKey(axis, st, web) {
  const [r, g, b] = st.rgb, [L, A, B] = st.lab;
  const o = { h: [], s: [st.hsv.h, st.hsv.v], v: [st.hsv.h, st.hsv.s], r: [g, b], g: [r, b], b: [r, g], L: [A, B], A: [L, B], B: [L, A] }[axis] ?? [];
  return `${axis}:${o.map((x) => Math.round(x * 100)).join(',')}:${web ? 1 : 0}`;
}

/**
 * Photoshop's colour field and strip for one axis (the radio buttons beside H S B R G B L a b). The state is the
 * model's { hsv, rgb, lab }; `conv` gives the Lab conversions of the document's profile. onChange(state, { final })
 * fires for each drag step and on release.
 */
export function createAxisPicker({ axis = 'h', value = '#000000', conv = M.SRGB_CONV, web = false, size = 256, stripWidth = 20, onChange } = {}) {
  const root = el('div', 'cpx-picker');
  const field = el('div', 'cpx-field');
  field.setAttribute('role', 'slider');
  field.tabIndex = 0;
  field.setAttribute('aria-label', 'Colour field');
  const fieldCanvas = el('canvas');
  const fieldMarker = el('span', 'cpx-field-marker');
  field.append(fieldCanvas, fieldMarker);
  field.style.width = field.style.height = `${size}px`;
  const strip = el('div', 'cpx-strip');
  strip.setAttribute('role', 'slider');
  strip.tabIndex = 0;
  strip.setAttribute('aria-label', 'Colour slider');
  const stripCanvas = el('canvas');
  const stripMarker = el('span', 'cpx-strip-marker');
  strip.append(stripCanvas, stripMarker);
  strip.style.width = `${stripWidth}px`;
  strip.style.height = `${size}px`;
  root.append(field, strip);

  const api = {
    element: root,
    field,
    strip,
    axis,
    web,
    state: typeof value === 'string' ? M.stateFromRgb(M.rgbOfHex(value), conv) : value,
  };
  let keys = { field: null, strip: null };
  let raf = 0;

  const draw = () => {
    raf = 0;
    const st = api.state;
    const lab = M.axisOf(api.axis).model === 'lab';
    const fk = fieldKey(api.axis, st, api.web);
    if (fk !== keys.field) {
      keys.field = fk;
      const n = lab ? 128 : 256;
      fieldCanvas.width = fieldCanvas.height = n;
      const ctx = fieldCanvas.getContext('2d');
      const img = ctx.createImageData(n, n);
      M.renderField(api.axis, st, img.data, n, n, { conv, web: api.web });
      ctx.putImageData(img, 0, 0);
    }
    const sk = stripKey(api.axis, st, api.web);
    if (sk !== keys.strip) {
      keys.strip = sk;
      const n = lab ? 128 : 256;
      stripCanvas.width = 1;
      stripCanvas.height = n;
      const ctx = stripCanvas.getContext('2d');
      const img = ctx.createImageData(1, n);
      M.renderStrip(api.axis, st, img.data, 1, n, { conv, web: api.web });
      ctx.putImageData(img, 0, 0);
    }
    const p = M.axisPosition(api.axis, st);
    fieldMarker.style.left = `${p.x * 100}%`;
    fieldMarker.style.top = `${p.y * 100}%`;
    // a light ring on dark colours, a dark one on light colours (Photoshop's field marker)
    const light = st.lab[0] > 60;
    fieldMarker.classList.toggle('on-light', light);
    stripMarker.style.top = `${(1 - p.t) * 100}%`;
    field.setAttribute('aria-valuetext', M.stateHex(st));
    strip.setAttribute('aria-valuenow', String(Math.round(p.t * 100)));
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };

  const snapWeb = (st) => (api.web ? M.stateFromRgb(M.webSafe(st.rgb), conv, st) : st);
  dragOn(field, (x, y, _e, final) => {
    api.state = snapWeb(M.fromField(api.axis, api.state, x, y, conv));
    draw();
    onChange?.(api.state, { final, source: 'field' });
  });
  dragOn(strip, (_x, y, _e, final) => {
    api.state = snapWeb(M.fromStrip(api.axis, api.state, 1 - y, conv));
    draw();
    onChange?.(api.state, { final, source: 'strip' });
  });
  // arrows nudge the field, Up / Down the strip (Shift: ten steps)
  field.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.shiftKey ? 10 : 1) / 255;
    const p = M.axisPosition(api.axis, api.state);
    api.state = snapWeb(M.fromField(api.axis, api.state, p.x + d[0] * step, p.y + d[1] * step, conv));
    draw();
    onChange?.(api.state, { final: true, source: 'field' });
  });
  strip.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const p = M.axisPosition(api.axis, api.state);
    api.state = snapWeb(M.fromStrip(api.axis, api.state, p.t + (d * (e.shiftKey ? 10 : 1)) / 255, conv));
    draw();
    onChange?.(api.state, { final: true, source: 'strip' });
  });

  api.set = (v) => {
    api.state = typeof v === 'string' ? M.stateFromRgb(M.rgbOfHex(v), conv, api.state) : v;
    schedule();
  };
  api.setAxis = (id) => {
    api.axis = M.axisOf(id).id;
    keys = { field: null, strip: null };
    draw();
  };
  api.setWeb = (on) => {
    api.web = !!on;
    keys = { field: null, strip: null };
    draw();
  };
  api.redraw = () => {
    keys = { field: null, strip: null };
    draw();
  };
  api.destroy = () => cancelAnimationFrame(raf);
  draw();
  return api;
}

// ---- Color Wheel (the Color panel) ---------------------------------------------------------------------------------

/** A hue ring around a saturation/brightness square: the Color panel's Color Wheel view. */
export function createWheelView({ value = '#000000', onChange, size = 150 } = {}) {
  const [h0, s0, v0] = rgbToHsv(...M.rgbOfHex(value));
  const model = new M.HudModel({ hsv: { h: h0, s: s0, v: v0 }, layout: 'wheel', size });
  const root = el('div', 'color-wheel-view');
  const canvas = el('canvas');
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(model.width * dpr);
  canvas.height = Math.round(model.height * dpr);
  canvas.style.width = `${model.width}px`;
  canvas.style.height = `${model.height}px`;
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', 'Colour wheel');
  canvas.tabIndex = 0;
  root.appendChild(canvas);
  let hex = M.hexOfRgb(M.rgbOfHex(value));
  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, model.width, model.height);
    drawHueRing(ctx, model.center.x, model.center.y, model.ring.inner, model.ring.outer);
    const q = model.square;
    drawHueSquare(ctx, q.x, q.y, q.size, model.hsv.h);
    const a = model.anchor(), hm = model.hueMarker();
    ctx.lineWidth = 2;
    for (const [p, r] of [[a, 5], [hm, 6]]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.lineWidth = 2;
    }
    canvas.setAttribute('aria-valuetext', hex);
  };
  let zone = null;
  dragOn(canvas, (x, y, _e, final) => {
    const lx = x * model.width, ly = y * model.height;
    // the zone the press started in keeps the drag (a drag from the ring changes the hue only)
    if (!zone) zone = model.zoneAt(lx, ly);
    if (zone === 'hue' && model.zoneAt(lx, ly) !== 'hue') {
      const c = model.center, d = Math.hypot(lx - c.x, ly - c.y) || 1, r = (model.ring.inner + model.ring.outer) / 2;
      model.move(c.x + ((lx - c.x) / d) * r, c.y + ((ly - c.y) / d) * r);
    } else if (zone === 'square' && model.zoneAt(lx, ly) !== 'square') {
      const q = model.square;
      model.move(clamp(lx, q.x, q.x + q.size), clamp(ly, q.y, q.y + q.size));
    } else model.move(lx, ly);
    if (final) zone = null;
    hex = M.hexOfRgb(hsvToRgb(model.hsv.h, model.hsv.s, model.hsv.v));
    draw();
    onChange?.(hex, { final });
  });
  draw();
  return {
    element: root,
    get: () => hex,
    set(v) {
      const h = M.hexOfRgb(M.rgbOfHex(v));
      if (h === hex) return;
      hex = h;
      const [hh, ss, vv] = rgbToHsv(...M.rgbOfHex(h));
      if (ss > 0.001 && vv > 0.001) model.hsv.h = hh;
      model.hsv.s = ss;
      model.hsv.v = vv;
      draw();
    },
  };
}

// ---- sliders -------------------------------------------------------------------------------------------------------

/** The Color panel's slider sets (Photoshop's panel menu). */
export const SLIDER_MODELS = Object.freeze([
  ['gray', 'Grayscale Slider'],
  ['rgb', 'RGB Sliders'],
  ['hsb', 'HSB Sliders'],
  ['cmyk', 'CMYK Sliders'],
  ['lab', 'Lab Sliders'],
  ['web', 'Web Color Sliders'],
]);

const SLIDERS = {
  gray: [['k', 'K', 0, 100, '%']],
  rgb: [['r', 'R', 0, 255, ''], ['g', 'G', 0, 255, ''], ['b', 'B', 0, 255, '']],
  web: [['r', 'R', 0, 255, ''], ['g', 'G', 0, 255, ''], ['b', 'B', 0, 255, '']],
  hsb: [['h', 'H', 0, 360, '°'], ['s', 'S', 0, 100, '%'], ['v', 'B', 0, 100, '%']],
  cmyk: [['c', 'C', 0, 100, '%'], ['m', 'M', 0, 100, '%'], ['y', 'Y', 0, 100, '%'], ['k', 'K', 0, 100, '%']],
  lab: [['L', 'L', 0, 100, ''], ['a', 'a', -128, 127, ''], ['b', 'b', -128, 127, '']],
};

/** The values of a model for a hex (gray: K ink of the luminance, as Photoshop's Grayscale Slider). */
function valuesOf(model, hex, conv, hueHint) {
  const rgb = M.rgbOfHex(hex);
  if (model === 'rgb' || model === 'web') return { r: rgb[0], g: rgb[1], b: rgb[2] };
  if (model === 'hsb') {
    const [h, s, v] = rgbToHsv(...rgb);
    return { h: s > 0.001 && v > 0.001 ? h : hueHint ?? h, s: s * 100, v: v * 100 };
  }
  if (model === 'cmyk') {
    const [c, m, y, k] = rgbToCmyk(...rgb);
    return { c, m, y, k };
  }
  if (model === 'lab') {
    const [L, a, b] = conv.toLab(rgb);
    return { L, a, b };
  }
  return { k: 100 - (conv.toLab(rgb)[0]) };
}

function rgbOf(model, v, conv) {
  if (model === 'rgb') return [v.r, v.g, v.b];
  if (model === 'web') return M.webSafe([v.r, v.g, v.b]);
  if (model === 'hsb') return hsvToRgb(v.h, v.s / 100, v.v / 100);
  if (model === 'cmyk') return cmykToRgb(v.c, v.m, v.y, v.k);
  if (model === 'lab') return conv.fromLab([v.L, v.a, v.b]);
  return conv.fromLab([100 - v.k, 0, 0]);
}

/** One set of colour sliders: a range and a number per component, each track showing where it leads. */
export function createSliders({ model = 'rgb', value = '#000000', conv = M.SRGB_CONV, onChange } = {}) {
  const root = el('div', 'color-sliders');
  root.dataset.model = model;
  const comps = SLIDERS[model] ?? SLIDERS.rgb;
  let hex = M.hexOfRgb(M.rgbOfHex(value));
  let hue = null;
  let vals = valuesOf(model, hex, conv, hue);
  const rows = comps.map(([k, label, lo, hi, unit]) => {
    const row = el('label', 'color-slider-row');
    const name = el('span', 'color-slider-label', label);
    const range = el('input', 'color-slider');
    range.type = 'range';
    range.min = String(lo);
    range.max = String(hi);
    range.step = model === 'web' ? '51' : '1';
    range.dataset.slider = `${model}.${k}`;
    range.setAttribute('aria-label', label);
    const num = el('input', 'input color-slider-num');
    num.type = 'number';
    num.min = String(lo);
    num.max = String(hi);
    num.dataset.sliderNum = `${model}.${k}`;
    num.setAttribute('aria-label', label);
    row.append(name, range, num);
    if (unit) row.appendChild(el('span', 'muted color-slider-unit', unit));
    const commit = (raw, final) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      vals = { ...vals, [k]: clamp(n, lo, hi) };
      if (model === 'hsb') hue = vals.h;
      hex = M.hexOfRgb(rgbOf(model, vals, conv));
      paint(k);
      onChange?.(hex, { final });
    };
    range.addEventListener('input', () => commit(range.value, false));
    range.addEventListener('change', () => commit(range.value, true));
    num.addEventListener('change', () => commit(num.value, true));
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(num.value, true);
    });
    return { k, lo, hi, range, num };
  });
  root.append(...rows.map((r) => r.range.parentElement));

  // each track: the colours its own component gives with the others held (8 stops)
  function paint(skip = null) {
    for (const r of rows) {
      const v = vals[r.k];
      if (r.k !== skip || document.activeElement !== r.range) r.range.value = String(Math.round(v));
      if (document.activeElement !== r.num) r.num.value = String(Math.round(v));
      const stops = [];
      for (let i = 0; i <= 8; i++) {
        const t = r.lo + ((r.hi - r.lo) * i) / 8;
        stops.push(css(rgbOf(model, { ...vals, [r.k]: t }, conv)));
      }
      r.range.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    }
  }
  paint();
  return {
    element: root,
    model,
    get: () => hex,
    set(v) {
      const h = M.hexOfRgb(M.rgbOfHex(v));
      if (h === hex) return;
      hex = h;
      vals = valuesOf(model, hex, conv, hue);
      paint();
    },
  };
}

// ---- ramps ---------------------------------------------------------------------------------------------------------

export const RAMP_KINDS = Object.freeze([
  ['rgb', 'RGB Spectrum'],
  ['cmyk', 'CMYK Spectrum'],
  ['gray', 'Grayscale Ramp'],
  ['current', 'Current Colors'],
]);

/** The colour of a ramp at (x, y), 0..1 each. */
export function rampRgb(kind, x, y, { fg = [0, 0, 0], bg = [255, 255, 255] } = {}) {
  if (kind === 'gray') return [x * 255, x * 255, x * 255];
  if (kind === 'current') return [0, 1, 2].map((i) => fg[i] + (bg[i] - fg[i]) * x);
  // spectrum: hues left to right, white at the top, the pure hue in the middle, black at the bottom
  const pure = hsvToRgb(x * 360, 1, 1);
  const rgb = y < 0.5 ? pure.map((c) => 255 + (c - 255) * (y * 2)) : pure.map((c) => c * (1 - (y - 0.5) * 2));
  return kind === 'cmyk' ? proofRgb(rgb[0], rgb[1], rgb[2]) : rgb;
}

/** A colour ramp; a click or drag picks from it (onPick(hex, event): Alt picks the background). */
export function createRamp({ kind = 'rgb', web = false, colors = () => ({ fg: '#000000', bg: '#ffffff' }), onPick, width = 240, height = 36 } = {}) {
  const canvas = el('canvas', 'color-ramp');
  canvas.width = width;
  canvas.height = height;
  canvas.dataset.ramp = kind;
  canvas.setAttribute('aria-label', (RAMP_KINDS.find(([id]) => id === kind) ?? RAMP_KINDS[0])[1]);
  const draw = () => {
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const c = colors();
    const fg = M.rgbOfHex(c.fg), bg = M.rgbOfHex(c.bg);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let rgb = rampRgb(kind, x / (width - 1), y / (height - 1), { fg, bg });
        if (web) rgb = M.webSafe(rgb);
        const o = (y * width + x) * 4;
        img.data[o] = rgb[0];
        img.data[o + 1] = rgb[1];
        img.data[o + 2] = rgb[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };
  dragOn(canvas, (x, y, e) => {
    const c = colors();
    let rgb = rampRgb(kind, x, y, { fg: M.rgbOfHex(c.fg), bg: M.rgbOfHex(c.bg) });
    if (web) rgb = M.webSafe(rgb);
    onPick?.(M.hexOfRgb(rgb), e);
  });
  draw();
  return { element: canvas, redraw: draw };
}
