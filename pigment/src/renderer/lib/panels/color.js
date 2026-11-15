// Color panel (top group): the foreground/background chips (click a chip to choose which colour the panel edits) and,
// from the panel menu (color-picker-swatches, 0.5), a view (Hue Cube: 0.4's saturation/brightness square, hue strip
// and HSB / RGB / hex fields; Brightness Cube; Color Wheel), a set of sliders (Grayscale, RGB, HSB, CMYK, Lab, Web), a
// colour ramp (RGB / CMYK spectrum, grayscale, current colours; Make Ramp Web Safe), the out-of-gamut warning and Copy
// Color as HTML / Hex Code. Settings: settings.colorUI.panel.
//
// Also exports createColorWidget() (0.4's square + strip + fields) and normHex, kept for their callers.
import { icon } from '../icons.js';
import { parseColor, rgbaToHex, rgbToHsv, hsvToRgb } from '../../../shared/pixels/color.js';
import { frameThrottle } from '../form.js';
import { isOutOfCmykGamut } from '../../../shared/pixels/color.js';
import { SRGB, toLab, fromLab, convertColor } from '../color/pipeline.js';
import * as M from '../color-picker-model.js';
import { createAxisPicker, createWheelView, createSliders, createRamp, SLIDER_MODELS, RAMP_KINDS } from './color-views.js';

const AREA_W = 240, AREA_H = 160;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Normalises any colour input to '#rrggbb' (alpha dropped). */
export function normHex(c) {
  return rgbaToHex(parseColor(c, [0, 0, 0, 1]));
}

/**
 * Builds the colour editor: SV square, hue strip, HSB/RGB/hex fields.
 * onChange(hex, { final }) fires on every edit (final = pointer released or a field committed).
 * Returns { element, set(hex), get(): hex, hsv }.
 * @param {{ value?: string, onChange?: (hex: string, info: { final: boolean }) => void, large?: boolean, fields?: boolean }} opts
 */
export function createColorWidget({ value = '#000000', onChange, large = false, fields = true } = {}) {
  const el = document.createElement('div');
  el.className = 'color-widget' + (large ? ' large' : '');
  el.innerHTML = `
    <div class="color-area" role="slider" tabindex="0" aria-label="Saturation and brightness"><canvas width="${AREA_W}" height="${large ? AREA_W : AREA_H}"></canvas><span class="color-marker"></span></div>
    <div class="hue-bar" role="slider" tabindex="0" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"><span class="bar-marker"></span></div>
    <div class="color-fields">
      <label title="Hue (degrees)">H <input class="input" data-f="h" type="number" min="0" max="360" step="1"></label>
      <label title="Saturation (%)">S <input class="input" data-f="s" type="number" min="0" max="100" step="1"></label>
      <label title="Brightness (%)">B <input class="input" data-f="v" type="number" min="0" max="100" step="1"></label>
      <label title="Red (0–255)">R <input class="input" data-f="r" type="number" min="0" max="255" step="1"></label>
      <label title="Green (0–255)">G <input class="input" data-f="g" type="number" min="0" max="255" step="1"></label>
      <label title="Blue (0–255)">B <input class="input" data-f="b" type="number" min="0" max="255" step="1"></label>
    </div>
    <div class="color-hex"><span class="muted">#</span><input class="input" data-f="hex" type="text" maxlength="7" spellcheck="false" aria-label="Hex colour"></div>`;
  const area = el.querySelector('.color-area');
  const canvas = area.querySelector('canvas');
  const marker = area.querySelector('.color-marker');
  const hueBar = el.querySelector('.hue-bar');
  const hueMarker = hueBar.querySelector('.bar-marker');
  const inputs = Object.fromEntries([...el.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i]));
  if (!fields) {
    el.querySelector('.color-fields').hidden = true;
    el.querySelector('.color-hex').hidden = true;
  }

  // state: hue is kept separately so greys and black keep the hue the user chose
  const state = { h: 0, s: 0, v: 0, hex: '#000000' };
  let drawnHue = null;

  function fromHex(hex, keepHue = true) {
    const [r, g, b] = parseColor(hex);
    const [h, s, v] = rgbToHsv(r, g, b);
    if (!keepHue || (s > 0.001 && v > 0.001)) state.h = h;
    state.s = s;
    state.v = v;
    state.hex = normHex(hex);
  }

  function rgbNow() {
    return hsvToRgb(state.h, state.s, state.v).map((c) => Math.round(c));
  }

  function drawArea() {
    if (drawnHue === state.h) return;
    drawnHue = state.h;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const [hr, hg, hb] = hsvToRgb(state.h, 1, 1);
    ctx.fillStyle = `rgb(${hr | 0},${hg | 0},${hb | 0})`;
    ctx.fillRect(0, 0, w, h);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, 'rgba(255,255,255,1)');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, h);
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, h);
  }

  function sync(skip = null) {
    drawArea();
    marker.style.left = `${state.s * 100}%`;
    marker.style.top = `${(1 - state.v) * 100}%`;
    marker.style.background = state.hex;
    hueMarker.style.left = `${(state.h / 360) * 100}%`;
    hueBar.setAttribute('aria-valuenow', String(Math.round(state.h)));
    area.setAttribute('aria-valuetext', `Saturation ${Math.round(state.s * 100)}%, brightness ${Math.round(state.v * 100)}%`);
    const [r, g, b] = parseColor(state.hex);
    const vals = { h: Math.round(state.h) % 360, s: Math.round(state.s * 100), v: Math.round(state.v * 100), r, g, b, hex: state.hex.slice(1) };
    for (const [k, input] of Object.entries(inputs)) {
      if (input === skip || document.activeElement === input) continue;
      input.value = String(vals[k]);
    }
  }

  function emit(final) {
    onChange?.(state.hex, { final });
  }

  function setHsv(h, s, v, final = false) {
    state.h = clamp(h, 0, 360);
    state.s = clamp(s, 0, 1);
    state.v = clamp(v, 0, 1);
    state.hex = rgbaToHex(hsvToRgb(state.h, state.s, state.v));
    sync();
    emit(final);
  }

  function drag(target, onPoint) {
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      target.focus({ preventScroll: true });
      target.setPointerCapture(e.pointerId);
      const at = (ev) => {
        const r = target.getBoundingClientRect();
        onPoint(clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1), clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1), false);
      };
      at(e);
      const move = (ev) => at(ev);
      const up = (ev) => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        const r = target.getBoundingClientRect();
        onPoint(clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1), clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1), true);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  }
  drag(area, (x, y, final) => setHsv(state.h, x, 1 - y, final));
  drag(hueBar, (x, _y, final) => setHsv(Math.min(359.99, x * 360), state.s, state.v, final));

  // keyboard: arrows nudge saturation/brightness or hue
  area.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    setHsv(state.h, state.s + d[0], state.v + d[1], true);
  });
  hueBar.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setHsv((state.h + d + 360) % 360, state.s, state.v, true);
  });

  // fields
  const fieldCommit = (input, final) => {
    const k = input.dataset.f;
    if (k === 'hex') {
      const raw = input.value.trim().replace(/^#/, '');
      if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(raw)) {
        if (final) input.value = state.hex.slice(1);
        return;
      }
      fromHex(`#${raw}`);
      sync(input);
      emit(final);
      return;
    }
    const n = Number(input.value);
    if (input.value === '' || !Number.isFinite(n)) {
      if (final) sync();
      return;
    }
    if (k === 'h' || k === 's' || k === 'v') {
      const h = k === 'h' ? clamp(n, 0, 360) % 360 : state.h;
      const s = k === 's' ? clamp(n, 0, 100) / 100 : state.s;
      const v = k === 'v' ? clamp(n, 0, 100) / 100 : state.v;
      state.h = h;
      state.s = s;
      state.v = v;
      state.hex = rgbaToHex(hsvToRgb(h, s, v));
    } else {
      const [r, g, b] = parseColor(state.hex);
      const next = { r, g, b, [k]: clamp(Math.round(n), 0, 255) };
      fromHex(rgbaToHex([next.r, next.g, next.b]));
    }
    sync(input);
    emit(final);
  };
  for (const input of Object.values(inputs)) {
    input.addEventListener('input', () => fieldCommit(input, false));
    input.addEventListener('change', () => {
      fieldCommit(input, true);
      sync();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        fieldCommit(input, true);
        input.select?.();
      }
    });
    input.addEventListener('blur', () => sync());
  }

  fromHex(value, false);
  sync();

  return {
    element: el,
    /** Sets the colour without firing onChange (keeps the current hue for greys). */
    set(hex) {
      if (normHex(hex) === state.hex) return;
      fromHex(hex);
      sync();
    },
    get: () => state.hex,
    get hsv() {
      return { h: state.h, s: state.s, v: state.v };
    },
    rgb: rgbNow,
  };
}

/** Small "set foreground" helpers shared by panels. */
export function chipButton(className, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `sw ${className}`;
  b.title = title;
  return b;
}

const PANEL_VIEWS = [
  ['hue-cube', 'Hue Cube'],
  ['brightness-cube', 'Brightness Cube'],
  ['wheel', 'Color Wheel'],
];
const PANEL_DEFAULTS = { view: 'hue-cube', sliders: 'none', ramp: 'none', webRamp: false };

/** settings.colorUI.panel (color-picker-swatches' namespace): the view, the sliders and the ramp shown. */
export function colorPanelPrefs(app) {
  const p = { ...PANEL_DEFAULTS, ...(app.settings.colorUI?.panel ?? {}) };
  if (!PANEL_VIEWS.some(([id]) => id === p.view)) p.view = PANEL_DEFAULTS.view;
  if (p.sliders !== 'none' && !SLIDER_MODELS.some(([id]) => id === p.sliders)) p.sliders = 'none';
  if (p.ramp !== 'none' && !RAMP_KINDS.some(([id]) => id === p.ramp)) p.ramp = 'none';
  return p;
}

export function install(app) {
  const el = document.createElement('div');
  el.className = 'color-panel';
  const head = document.createElement('div');
  head.className = 'color-preview';
  const fgChip = chipButton('chip-fg', 'Foreground colour: click to edit it here, double-click for the colour picker');
  const bgChip = chipButton('chip-bg', 'Background colour: click to edit it here, double-click for the colour picker');
  const swap = document.createElement('button');
  swap.className = 'pbtn';
  swap.title = 'Swap colours (X)';
  swap.innerHTML = icon('swap');
  const reset = document.createElement('button');
  reset.className = 'pbtn';
  reset.title = 'Default colours (D)';
  reset.innerHTML = icon('default-colors');
  const label = document.createElement('span');
  label.className = 'muted color-target-label';
  // Photoshop's out-of-gamut (printing) warning: a click takes the closest printable colour
  const gamut = document.createElement('button');
  gamut.type = 'button';
  gamut.className = 'pbtn color-gamut';
  gamut.hidden = true;
  gamut.title = 'Out of gamut for printing: click to take the closest printable colour';
  gamut.innerHTML = `${icon('warning')}<span class="cpx-warn-swatch"></span>`;
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'pbtn';
  menuBtn.dataset.act = 'menu';
  menuBtn.title = 'Color panel menu';
  menuBtn.innerHTML = icon('more');
  head.append(fgChip, bgChip, swap, reset, label, gamut, menuBtn);
  el.appendChild(head);
  const viewBox = document.createElement('div');
  viewBox.className = 'color-view';
  const slidersBox = document.createElement('div');
  slidersBox.className = 'color-sliders-wrap';
  const rampBox = document.createElement('div');
  rampBox.className = 'color-ramp-wrap';
  el.append(viewBox, slidersBox, rampBox);

  let target = app.settings.colorPanelTarget === 'bg' ? 'bg' : 'fg';
  const current = () => (target === 'bg' ? app.settings.background : app.settings.foreground);
  const conv = () => {
    const profile = app.doc?.profile ?? null;
    return { toLab: (rgb) => toLab(rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))), profile), fromLab: (lab) => fromLab(lab, profile) };
  };

  // the panel's own edits come back as color:changed; `echo` stops them from resetting the widget
  // (which would lose the hue of greys and jump back while dragging)
  let echo = null;
  const push = frameThrottle((hex) => {
    echo = hex;
    try {
      if (target === 'bg') app.setColors({ background: hex });
      else app.setColors({ foreground: hex });
    } finally {
      echo = null;
    }
  });
  // the Hue Cube is 0.4's widget (its fields included); the panel keeps it as `widget`
  const widget = createColorWidget({ value: current(), onChange: (hex) => push(hex) });
  let view = null; // the shown view: { element, set(hex) }
  let sliders = null;
  let ramp = null;

  function build() {
    const prefs = colorPanelPrefs(app);
    el.dataset.view = prefs.view;
    if (prefs.view === 'hue-cube') view = { element: widget.element, set: (hex) => widget.set(hex) };
    else if (prefs.view === 'wheel') view = createWheelView({ value: current(), onChange: (hex) => push(hex) });
    else {
      const ap = createAxisPicker({ axis: 'v', value: current(), conv: conv(), size: 200, stripWidth: 16, onChange: (st) => push(M.stateHex(st)) });
      view = { element: ap.element, set: (hex) => ap.set(hex) };
    }
    viewBox.replaceChildren(view.element);
    sliders = prefs.sliders === 'none' ? null : createSliders({ model: prefs.sliders, value: current(), conv: conv(), onChange: (hex) => push(hex) });
    slidersBox.replaceChildren(...(sliders ? [sliders.element] : []));
    slidersBox.hidden = !sliders;
    ramp = prefs.ramp === 'none' ? null : createRamp({
      kind: prefs.ramp,
      web: prefs.webRamp,
      colors: () => ({ fg: app.settings.foreground, bg: app.settings.background }),
      onPick: (hex, e) => (e?.altKey ? app.setColors({ background: hex }) : target === 'bg' ? app.setColors({ background: hex }) : app.setColors({ foreground: hex })),
    });
    rampBox.replaceChildren(...(ramp ? [ramp.element] : []));
    rampBox.hidden = !ramp;
    syncGamut();
  }

  function syncGamut() {
    const rgb = M.rgbOfHex(current());
    const srgb = convertColor(rgb, app.doc?.profile ?? null, SRGB);
    const out = isOutOfCmykGamut(srgb);
    gamut.hidden = !out;
    if (out) gamut.querySelector('.cpx-warn-swatch').style.background = M.hexOfRgb(M.printableRgb(srgb));
  }
  gamut.addEventListener('click', () => {
    const srgb = M.printableRgb(convertColor(M.rgbOfHex(current()), app.doc?.profile ?? null, SRGB));
    const hex = M.hexOfRgb(convertColor(srgb, SRGB, app.doc?.profile ?? null));
    if (target === 'bg') app.setColors({ background: hex });
    else app.setColors({ foreground: hex });
  });

  function syncChips() {
    fgChip.style.background = app.settings.foreground;
    bgChip.style.background = app.settings.background;
    fgChip.classList.toggle('active', target === 'fg');
    bgChip.classList.toggle('active', target === 'bg');
    fgChip.setAttribute('aria-pressed', String(target === 'fg'));
    bgChip.setAttribute('aria-pressed', String(target === 'bg'));
    label.textContent = target === 'bg' ? 'Editing background' : 'Editing foreground';
  }

  function setAll(hex) {
    view?.set(hex);
    sliders?.set(hex);
  }

  function setTarget(t) {
    target = t;
    if (app.settings.colorPanelTarget !== t) app.saveSettingsSoon({ colorPanelTarget: t });
    setAll(current());
    syncChips();
    syncGamut();
  }

  const savePrefs = (patch) => {
    const ui = app.settings.colorUI ?? {};
    app.saveSettingsSoon({ colorUI: { ...ui, panel: { ...colorPanelPrefs(app), ...patch } } });
    build();
  };
  menuBtn.addEventListener('click', () => {
    const prefs = colorPanelPrefs(app);
    app.dialogs.popover(menuBtn, [
      ...PANEL_VIEWS.map(([id, l]) => ({ label: l, checked: prefs.view === id, onSelect: () => savePrefs({ view: id }) })),
      { type: 'separator' },
      { label: 'No Sliders', checked: prefs.sliders === 'none', onSelect: () => savePrefs({ sliders: 'none' }) },
      ...SLIDER_MODELS.map(([id, l]) => ({ label: l, checked: prefs.sliders === id, onSelect: () => savePrefs({ sliders: id }) })),
      { type: 'separator' },
      { label: 'No Color Ramp', checked: prefs.ramp === 'none', onSelect: () => savePrefs({ ramp: 'none' }) },
      ...RAMP_KINDS.map(([id, l]) => ({ label: l, checked: prefs.ramp === id, onSelect: () => savePrefs({ ramp: id }) })),
      { label: 'Make Ramp Web Safe', checked: !!prefs.webRamp, onSelect: () => savePrefs({ webRamp: !prefs.webRamp }) },
      { type: 'separator' },
      { label: 'Copy Color as HTML', icon: 'copy', onSelect: () => copyColor(current(), 'html') },
      { label: 'Copy Color\'s Hex Code', icon: 'copy', onSelect: () => copyColor(current(), 'hex') },
    ], { align: 'right' });
  });
  async function copyColor(hex, kind) {
    const { copyColorCode } = await import('../tools/nav.js');
    copyColorCode(app, hex, kind);
  }

  fgChip.addEventListener('click', () => setTarget('fg'));
  bgChip.addEventListener('click', () => setTarget('bg'));
  fgChip.addEventListener('dblclick', () => app.commands.run('tool:pick-fg', undefined, 'panel'));
  bgChip.addEventListener('dblclick', () => app.commands.run('tool:pick-bg', undefined, 'panel'));
  swap.addEventListener('click', () => app.commands.run('tool:swap-colors', undefined, 'panel'));
  reset.addEventListener('click', () => app.commands.run('tool:default-colors', undefined, 'panel'));

  const refresh = () => {
    if (!(echo && normHex(current()) === echo)) setAll(current());
    else sliders?.set(current());
    syncChips();
    syncGamut();
    if (ramp && colorPanelPrefs(app).ramp === 'current') ramp.redraw();
  };
  app.on('color:changed', refresh);
  app.on('settings:changed', (patch) => {
    if (patch && ('foreground' in patch || 'background' in patch)) refresh();
  });
  // a document with another profile (or an engine that became ready) changes the Lab numbers and the gamut
  app.on('color:display-changed', () => {
    if (colorPanelPrefs(app).view === 'brightness-cube' || colorPanelPrefs(app).sliders === 'lab' || colorPanelPrefs(app).sliders === 'gray') build();
    else syncGamut();
  });
  app.on('doc:activated', () => syncGamut());

  build();
  syncChips();
  app.panels.register({ id: 'color', title: 'Color', icon: 'color', element: el, group: 'top', onShow: refresh });
  return { widget, setTarget, rebuild: build };
}
