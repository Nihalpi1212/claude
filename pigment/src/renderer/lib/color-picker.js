// The colour picker (ARCHITECTURE.md "0.5 features", S7; color-picker-swatches' MODULES entry, package 11). Every colour
// the user chooses goes through app.colorPicker:
//   app.colorPicker.pick({ initial: ColorValue | '#rrggbb', title?, live?(c), doc?, target?, allowBooks? }) -> Promise<ColorValue | null>
//   app.colorPicker.hud({ at, tool, initial }) -> HudSession { move(p), up(p), cancel(), done: Promise<ColorValue | null> }
//   app.pickColor(initial, { title, live, target = 'field' }) -> Promise<'#rrggbb' | null>   (0.4's API, kept: pick()
//     returning hex; a call without a target is a field's)
//   swatchColors(app) -> '#rrggbb'[]                                       (the shape paint popover's swatch row)
// ColorValue: { hex, rgb: [r, g, b], lab?, cmyk?, book: { book, name } | null, space: 'rgb' | 'hsb' | 'lab' | 'cmyk' | 'book' }.
//
// Skeleton stub (real: false): the picker is 0.4's dialog moved verbatim from lib/extras.js (S7.4's DOM: class
// color-picker-dialog, inputs [data-f="h|s|v|r|g|b|hex"] from the colour widget and [data-m="L|a|b|c|m|y|k"], OK as
// .dialog-buttons .btn.primary); pick() wraps it. The HUD session draws nothing and resolves null on up(). The kinds
// `swatches` (0.4's DEFAULT_SWATCHES as built-ins), `color-books` and `color-profiles` are registered by
// lib/preset-kinds.js. The package replaces this file at the same path and keeps these exports.
import { icon } from './icons.js';
import { createColorWidget, normHex } from './panels/color.js';
import { parseColor, rgbaToHex, rgbToLab, labToRgb, rgbToCmyk, cmykToRgb } from '../../shared/pixels/color.js';
import { DEFAULT_SWATCHES } from '../../shared/defaults.js';

/** A ColorValue (S7.1) for an RGB hex: what the stub picker, which works in RGB only, resolves with. */
export function colorValue(hex) {
  const h = normHex(hex);
  const [r, g, b] = parseColor(h);
  return { hex: h, rgb: [r, g, b], book: null, space: 'rgb' };
}

const hexOf = (initial, fallback) => normHex(typeof initial === 'string' ? initial : initial?.hex ?? fallback);

/** '#rrggbb' of a `swatches` preset's colour (S7.2: rgb 0..255, lab L 0..100 a b -128..127, cmyk and gray 0..100). */
export function swatchHex(data) {
  const c = data?.color;
  const v = Array.isArray(c?.values) ? c.values.map(Number) : null;
  if (!v || v.some((x) => !Number.isFinite(x))) return null;
  const hex = (rgb) => rgbaToHex(rgb.map((x) => Math.max(0, Math.min(255, Math.round(x)))));
  if (c.space === 'rgb') return hex(v.slice(0, 3));
  if (c.space === 'lab') return hex(labToRgb(v[0], v[1], v[2]));
  if (c.space === 'cmyk') return hex(cmykToRgb(v[0], v[1], v[2], v[3]));
  if (c.space === 'gray') return hex([0, 0, 0].map(() => 255 * (1 - v[0] / 100))); // gray is ink: 0 % white
  return null;
}

/**
 * The swatches as hex (the shape paint popover's row). Stub: the `swatches` kind once color-picker-swatches has
 * migrated 0.4's palette into it (settings.colorUI.swatchesMigrated), else 0.4's settings.swatches (when edited or
 * non-empty) or DEFAULT_SWATCHES, exactly as 0.4's popover read them.
 */
export function swatchColors(app) {
  if (app?.settings?.colorUI?.swatchesMigrated && app.presets) {
    try {
      return app.presets.list('swatches').map((p) => swatchHex(p.data)).filter(Boolean);
    } catch (err) {
      console.warn('swatches kind not readable', err);
    }
  }
  const s = app?.settings?.swatches;
  const list = Array.isArray(s) && (app.settings.swatchesEdited || s.length) ? s : DEFAULT_SWATCHES;
  return list.map((c) => normHex(typeof c === 'string' ? c : c?.color ?? '#000000'));
}

function pickColor(app, initial, { title = 'Color Picker', live } = {}) {
  const start = normHex(initial ?? app.settings.foreground);
  let current = start;
  let liveRaf = 0;
  let liveHex = null;
  const pushLive = (hex) => {
    if (typeof live !== 'function') return;
    liveHex = hex;
    if (liveRaf) return;
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      try {
        live(liveHex);
      } catch (err) {
        console.error(err);
      }
    });
  };

  const content = document.createElement('div');
  content.className = 'color-dialog';
  const widget = createColorWidget({
    value: start,
    large: true,
    onChange: (hex) => {
      current = hex;
      showNew();
      pushLive(hex);
    },
  });
  const side = document.createElement('div');
  side.className = 'color-dialog-side';
  side.innerHTML = `
    <div class="cp-compare" aria-label="New and current colour">
      <span class="muted">new</span>
      <div class="cp-swatches"><span class="cp-new"></span><button type="button" class="cp-old" title="Click to go back to the current colour"></button></div>
      <span class="muted">current</span>
    </div>
    <div class="color-fields cp-modes" style="grid-template-columns: repeat(4, 1fr)" aria-label="Lab and CMYK">
      <label title="Lightness (0–100)">L <input class="input" data-m="L" type="number" min="0" max="100" step="1"></label>
      <label title="a (green–red)">a <input class="input" data-m="a" type="number" min="-128" max="127" step="1"></label>
      <label title="b (blue–yellow)">b <input class="input" data-m="b" type="number" min="-128" max="127" step="1"></label>
      <label title="Cyan (%)">C <input class="input" data-m="c" type="number" min="0" max="100" step="1"></label>
      <label title="Magenta (%)">M <input class="input" data-m="m" type="number" min="0" max="100" step="1"></label>
      <label title="Yellow (%)">Y <input class="input" data-m="y" type="number" min="0" max="100" step="1"></label>
      <label title="Black (%)">K <input class="input" data-m="k" type="number" min="0" max="100" step="1"></label>
    </div>
    <div class="cp-quick-title muted">Recent and swatches</div>
    <div class="cp-quick"></div>
    <button type="button" class="btn small cp-add">${icon('plus')} Add to Swatches</button>`;
  const newSw = side.querySelector('.cp-new');
  const oldSw = side.querySelector('.cp-old');
  oldSw.style.background = start;
  // Lab and CMYK readouts/fields (lib/color-modes.js owns the maths): typing in one converts back to RGB
  const modes = Object.fromEntries([...side.querySelectorAll('[data-m]')].map((i) => [i.dataset.m, i]));
  const showModes = () => {
    const [r, g, b] = parseColor(current);
    const lab = rgbToLab(r, g, b), cmyk = rgbToCmyk(r, g, b);
    const vals = { L: lab[0], a: lab[1], b: lab[2], c: cmyk[0], m: cmyk[1], y: cmyk[2], k: cmyk[3] };
    for (const [k, input] of Object.entries(modes)) if (document.activeElement !== input) input.value = String(Math.round(vals[k]));
  };
  const commitMode = (key) => {
    const n = (k) => Number(modes[k].value);
    if (Object.values(modes).some((i) => i.value === '' || !Number.isFinite(Number(i.value)))) return;
    const rgb = 'Lab'.includes(key) ? labToRgb(n('L'), n('a'), n('b')) : cmykToRgb(n('c'), n('m'), n('y'), n('k'));
    choose(rgbaToHex(rgb.map((v) => Math.round(v))));
  };
  for (const [k, input] of Object.entries(modes)) {
    input.addEventListener('change', () => commitMode(k));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitMode(k);
    });
  }
  const showNew = () => {
    newSw.style.background = current;
    showModes();
  };
  const choose = (hex) => {
    current = normHex(hex);
    widget.set(current);
    showNew();
    pushLive(current);
  };
  oldSw.addEventListener('click', () => choose(start));
  const quick = side.querySelector('.cp-quick');
  const recent = (app.settings.recentColors ?? []).map(normHex);
  const palette = app.settings.swatchesEdited || app.settings.swatches?.length ? app.settings.swatches : DEFAULT_SWATCHES;
  const seen = new Set();
  for (const c of [...recent, ...(palette ?? []).map((s) => normHex(typeof s === 'string' ? s : s?.color))]) {
    if (seen.has(c) || seen.size >= 30) continue;
    seen.add(c);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => choose(c));
    quick.appendChild(b);
  }
  side.querySelector('.cp-add').addEventListener('click', (e) => {
    const list = (app.settings.swatchesEdited || app.settings.swatches?.length ? app.settings.swatches : DEFAULT_SWATCHES).slice();
    list.push(current);
    app.saveSettingsSoon({ swatches: list, swatchesEdited: true });
    app.emit('swatches:changed', list);
    e.currentTarget.textContent = 'Added';
    e.currentTarget.disabled = true;
  });
  showNew();
  content.append(widget.element, side);

  return app.dialogs
    .open({
      title,
      content,
      width: 520,
      className: 'color-picker-dialog',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    })
    .then((ok) => {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
      return ok ? normHex(current) : null;
    });
}

/** The stub HUD session (S7.1): the picker's own drawing and live colour come with color-picker-swatches. */
function hudSession() {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  let open = true;
  const end = () => {
    if (!open) return;
    open = false;
    resolve(null);
  };
  return { move() {}, up: end, cancel: end, done };
}

export function install(app) {
  const picker = {
    real: false,
    /** S7.1: resolves with the ColorValue chosen, or null. The stub works in RGB and ignores target and books. */
    pick({ initial, title = 'Color Picker', live = null } = {}) {
      const start = hexOf(initial, app.settings.foreground);
      return pickColor(app, start, { title, live: typeof live === 'function' ? (hex) => live(colorValue(hex)) : undefined }).then((hex) => (hex ? colorValue(hex) : null));
    },
    hud: () => hudSession(),
  };
  app.colorPicker = picker;
  // 0.4's API: pick() returning hex
  app.pickColor = (initial, { title, live, target = 'field' } = {}) => picker.pick({ initial, title, target, live: typeof live === 'function' ? (c) => live(c.hex) : null }).then((c) => (c ? c.hex : null));
}
