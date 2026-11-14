// Color panel (top group): saturation/brightness square, hue strip, HSB / RGB / hex fields and the
// foreground/background chips (click a chip to choose which colour the panel edits).
//
// Also exports createColorWidget(), the same square + strip + fields, reused by the colour picker
// dialog in lib/extras.js (app.pickColor).
import { icon } from '../icons.js';
import { parseColor, rgbaToHex, rgbToHsv, hsvToRgb } from '../../../shared/pixels/color.js';
import { frameThrottle } from '../form.js';

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
  head.append(fgChip, bgChip, swap, reset, label);
  el.appendChild(head);

  let target = app.settings.colorPanelTarget === 'bg' ? 'bg' : 'fg';
  const current = () => (target === 'bg' ? app.settings.background : app.settings.foreground);

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
  const widget = createColorWidget({ value: current(), onChange: (hex) => push(hex) });
  el.appendChild(widget.element);

  function syncChips() {
    fgChip.style.background = app.settings.foreground;
    bgChip.style.background = app.settings.background;
    fgChip.classList.toggle('active', target === 'fg');
    bgChip.classList.toggle('active', target === 'bg');
    fgChip.setAttribute('aria-pressed', String(target === 'fg'));
    bgChip.setAttribute('aria-pressed', String(target === 'bg'));
    label.textContent = target === 'bg' ? 'Editing background' : 'Editing foreground';
  }

  function setTarget(t) {
    target = t;
    if (app.settings.colorPanelTarget !== t) app.saveSettingsSoon({ colorPanelTarget: t });
    widget.set(current());
    syncChips();
  }

  fgChip.addEventListener('click', () => setTarget('fg'));
  bgChip.addEventListener('click', () => setTarget('bg'));
  fgChip.addEventListener('dblclick', () => app.commands.run('tool:pick-fg', undefined, 'panel'));
  bgChip.addEventListener('dblclick', () => app.commands.run('tool:pick-bg', undefined, 'panel'));
  swap.addEventListener('click', () => app.commands.run('tool:swap-colors', undefined, 'panel'));
  reset.addEventListener('click', () => app.commands.run('tool:default-colors', undefined, 'panel'));

  const refresh = () => {
    if (!(echo && normHex(current()) === echo)) widget.set(current());
    syncChips();
  };
  app.on('color:changed', refresh);
  app.on('settings:changed', (patch) => {
    if (patch && ('foreground' in patch || 'background' in patch)) refresh();
  });

  syncChips();
  app.panels.register({ id: 'color', title: 'Color', icon: 'color', element: el, group: 'top', onShow: refresh });
  return { widget, setTarget };
}
