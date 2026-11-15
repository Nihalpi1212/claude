// Shared UI pieces of the tonal editors (adjust-tonal): the histogram, the slider track with draggable triangles
// (Levels' input and output sliders, Curves' black and white points), the eyedropper icons and the channel menu.
import { histogram } from '../../../shared/pixels/adjust.js';
import { TONAL_SPACES, spaceForMode, tonalSpace, isIdentityTonal } from '../../../shared/pixels/adjust-tonal.js';
import { registerIcons } from '../icons.js';

const DROPPER = '<path d="m14 7 3 3"/><path d="M5 19 15 9l-1-1 3-3a2.1 2.1 0 0 1 3 3l-3 3-1-1L6 20H4z"/>';
registerIcons({
  'eyedropper-black': `${DROPPER}<circle cx="18" cy="18.5" r="4" style="fill:#000" stroke="currentColor" stroke-width="1.2"/>`,
  'eyedropper-gray': `${DROPPER}<circle cx="18" cy="18.5" r="4" style="fill:#888" stroke="currentColor" stroke-width="1.2"/>`,
  'eyedropper-white': `${DROPPER}<circle cx="18" cy="18.5" r="4" style="fill:#fff" stroke="currentColor" stroke-width="1.2"/>`,
  'on-image': '<path d="M12 3v18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/><circle cx="12" cy="12" r="2"/>',
  'curve-points': '<path d="M3 21C9 21 15 3 21 3"/><rect x="10" y="10" width="4" height="4"/>',
});

/** A histogram of an ImageDataLike (null when it cannot be read). */
export function sourceHistogram(source) {
  if (!source) return null;
  try {
    return histogram(source);
  } catch {
    return null;
  }
}

/** Histogram key for a channel of a space: r / g / b for RGB channels, luma otherwise. */
export const histKey = (space, channel) => (space === 'rgb' && ['r', 'g', 'b'].includes(channel) ? channel : 'l');

const HIST_COLORS = { r: 'rgba(220,60,60,0.8)', g: 'rgba(60,170,60,0.8)', b: 'rgba(60,100,230,0.8)', l: 'rgba(140,140,140,0.85)' };

/** Draws a 256-bin histogram into a canvas (a couple of spikes ignored for the scale, as Photoshop does). */
export function drawHistogram(canvas, hist, key = 'l', { alpha = 1, clear = true } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  if (clear) ctx.clearRect(0, 0, w, h);
  const data = hist?.[key];
  if (!data) return;
  const sorted = Array.from(data).sort((a, b) => b - a);
  const max = sorted[2] || sorted[0] || 1;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = HIST_COLORS[key];
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, data[i] / max);
    ctx.fillRect((i / 256) * w, h - v * h, Math.ceil(w / 256), v * h);
  }
  ctx.globalAlpha = 1;
}

/** The channel space an editor shows: the params' own, else (identity params) the document mode's (J.9). */
export function editorSpace(kind, params, app) {
  if (params?.space && TONAL_SPACES[params.space]) return params.space;
  const docSpace = spaceForMode(app?.doc?.mode);
  // 0.3 params with edits are RGB; untouched ones follow the mode
  if (docSpace !== 'rgb' && isIdentityTonal(kind, { ...params, space: 'rgb' })) return docSpace;
  return tonalSpace(params);
}

/** The channel menu of a space: [key, label] for the composite (when any) then each channel. */
export function channelOptions(space) {
  const s = TONAL_SPACES[space];
  return [...(s.composite ? [s.composite] : []), ...s.channels].map((k) => [k, s.names[k]]);
}

/**
 * A slider track with triangles (Photoshop's Levels sliders): handles = [{ key, value, color }]; values 0..255 (the
 * grey one may be fractional). onDrag(key, value, { altKey, phase: 'start' | 'move' | 'end' }) reports drags; set()
 * moves the triangles. The track has a gradient from black to white.
 */
export function sliderTrack(handles, onDrag, { className = '' } = {}) {
  const el = document.createElement('div');
  el.className = `tonal-track ${className}`.trim();
  const bar = document.createElement('div');
  bar.className = 'tonal-track-bar';
  el.appendChild(bar);
  const knobs = new Map();
  for (const h of handles) {
    const k = document.createElement('div');
    k.className = `tonal-knob tonal-knob-${h.color}`;
    k.dataset.handle = h.key;
    k.tabIndex = -1;
    el.appendChild(k);
    knobs.set(h.key, k);
  }
  const values = Object.fromEntries(handles.map((h) => [h.key, h.value]));
  const place = () => {
    for (const [key, k] of knobs) k.style.left = `${(values[key] / 255) * 100}%`;
  };
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const r = el.getBoundingClientRect();
    const at = ((e.clientX - r.left) / r.width) * 255;
    let key = e.target?.dataset?.handle;
    if (!key) {
      // the nearest triangle
      let best = Infinity;
      for (const h of handles) {
        const d = Math.abs(values[h.key] - at);
        if (d < best) {
          best = d;
          key = h.key;
        }
      }
    }
    if (!key) return;
    drag = { key, rect: r };
    el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    onDrag(key, Math.max(0, Math.min(255, at)), { altKey: e.altKey, phase: 'start' });
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const at = ((e.clientX - drag.rect.left) / drag.rect.width) * 255;
    onDrag(drag.key, Math.max(0, Math.min(255, at)), { altKey: e.altKey, phase: 'move' });
  });
  const end = (e) => {
    if (!drag) return;
    const key = drag.key;
    drag = null;
    onDrag(key, values[key], { altKey: e.altKey, phase: 'end' });
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  place();
  return {
    element: el,
    set(next) {
      Object.assign(values, next);
      place();
    },
    get dragging() {
      return !!drag;
    },
  };
}

/** A small labelled select. */
export function selectRow(label, options, value, onChange, { dataKey } = {}) {
  const row = document.createElement('label');
  row.className = 'tonal-row';
  const span = document.createElement('span');
  span.textContent = label;
  const sel = document.createElement('select');
  sel.className = 'select';
  if (dataKey) sel.dataset.key = dataKey;
  for (const [v, l] of options) sel.add(new Option(l, v));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(span, sel);
  return { element: row, select: sel };
}
