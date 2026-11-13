// Shared helpers of the Properties panel sections (ARCHITECTURE.md "0.4 features", L.1): small DOM builders, the
// content bounds of a layer and the undoable offset the transform section uses. Moved out of panels/properties.js by
// the 0.4 skeleton so that every section file (lib/properties/*.js) builds the same rows. Skeleton file.
import { icon } from '../icons.js';
import { offsetLayers } from '../layer-move.js';
import { unionRect } from '../document.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

const MAX_SCAN = 25e6; // pixels: larger canvases report their canvas box instead of a scanned content box

// ---- content bounds (cached per layer version) ----------------------------------------------------------------
const boundsCache = new WeakMap();

/**
 * Bounding box of the non-transparent pixels of a canvas, or null when it is empty. Reads strips
 * from the edges inwards, so a layer whose content reaches its edges costs a few rows and columns
 * instead of the whole canvas.
 */
function alphaBounds(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w * h > MAX_SCAN) return { x: 0, y: 0, width: w, height: h };
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // strips grow as the scan finds nothing (few reads for sparse layers, small reads for full ones)
  const grow = (n) => Math.min(1024, n * 2);
  // pixels as 32-bit words: alpha is the top byte on little-endian machines (all supported platforms)
  const words = (img) => new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.length >> 2);
  const rowHit = (u, r, rw) => {
    for (let i = r * rw, end = i + rw; i < end; i++) if (u[i] > 0xffffff) return true;
    return false;
  };
  const colHit = (u, c, sw, rows) => {
    for (let r = 0, i = c; r < rows; r++, i += sw) if (u[i] > 0xffffff) return true;
    return false;
  };
  let top = -1;
  for (let y = 0, step = 32; y < h && top < 0; y += step, step = grow(step)) {
    const sh = Math.min(step, h - y);
    const d = words(ctx.getImageData(0, y, w, sh));
    for (let r = 0; r < sh; r++) if (rowHit(d, r, w)) {
      top = y + r;
      break;
    }
  }
  if (top < 0) return null;
  let bottom = top;
  for (let y = h, step = 32; y > top; y -= step, step = grow(step)) {
    const y0 = Math.max(top, y - step);
    const d = words(ctx.getImageData(0, y0, w, y - y0));
    let hit = -1;
    for (let r = y - y0 - 1; r >= 0; r--) if (rowHit(d, r, w)) {
      hit = y0 + r;
      break;
    }
    if (hit >= 0) {
      bottom = hit;
      break;
    }
  }
  const rows = bottom - top + 1;
  let left = -1;
  for (let x = 0, step = 32; x < w && left < 0; x += step, step = grow(step)) {
    const sw = Math.min(step, w - x);
    const d = words(ctx.getImageData(x, top, sw, rows));
    for (let c = 0; c < sw; c++) if (colHit(d, c, sw, rows)) {
      left = x + c;
      break;
    }
  }
  let right = left;
  for (let x = w, step = 32; x > left; x -= step, step = grow(step)) {
    const x0 = Math.max(left, x - step), sw = x - x0;
    const d = words(ctx.getImageData(x0, top, sw, rows));
    let hit = -1;
    for (let c = sw - 1; c >= 0; c--) if (colHit(d, c, sw, rows)) {
      hit = x0 + c;
      break;
    }
    if (hit >= 0) {
      right = hit;
      break;
    }
  }
  return { x: left, y: top, width: right - left + 1, height: rows };
}

/** Bounds of what the layer draws (non-transparent pixels), in document coordinates; null when empty. */
export function layerContentBounds(layer) {
  if (!layer || layer.type === 'adjustment') return null;
  if (layer.isGroup) {
    let b = null;
    for (const c of layer.children) {
      const cb = layerContentBounds(c);
      if (cb) b = b ? unionRect(b, cb) : { ...cb };
    }
    return b;
  }
  const cached = boundsCache.get(layer);
  if (cached && cached.version === layer.version) return cached.rect;
  let rect = null;
  try {
    let src = null;
    if (layer.type === 'raster') src = { canvas: layer.canvas, x: layer.x, y: layer.y };
    else if (typeof layer.render === 'function') src = layer.render();
    if (src?.canvas) {
      const r = alphaBounds(src.canvas);
      rect = r ? { x: r.x + src.x, y: r.y + src.y, width: r.width, height: r.height } : null;
    }
  } catch {
    rect = layer.bounds?.() ?? null;
  }
  boundsCache.set(layer, { version: layer.version, rect });
  return rect;
}

// ---- undoable offset of a layer (and its children / linked mask): see layer-move.js ----------------------------
export function offsetLayer(app, layer, dx, dy, label = 'Move') {
  if (!app.doc || !layer) return;
  offsetLayers(app.doc, [layer], dx, dy, label);
}

// ---- small DOM helpers ------------------------------------------------------------------------------------------
export function h(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label, iconName, title, onClick, { cls = 'btn small' } = {}) {
  const b = h('button', cls);
  b.type = 'button';
  b.innerHTML = `${iconName ? icon(iconName) : ''}${label ? `<span>${label}</span>` : ''}`;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export function section(title) {
  const s = h('div', 'panel-section');
  if (title) s.appendChild(h('h4', '', title));
  return s;
}

export function row(label, content) {
  const r = h('div', 'prop-row');
  r.appendChild(h('span', '', label));
  for (const c of [].concat(content)) if (c) r.appendChild(c);
  return r;
}

export function cssPaint(color) {
  return rgbaToHex(parseColor(color), true);
}

export function gradientCss(g) {
  const stops = (g?.stops?.length ? g.stops : [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }]).slice().sort((a, b) => a.pos - b.pos);
  const list = g?.reverse ? stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).reverse() : stops;
  return `linear-gradient(to right, ${list.map((s) => `${cssPaint(s.color)} ${Math.round(s.pos * 100)}%`).join(', ')})`;
}

export function colorChip(color, title, onPick) {
  const chip = h('button', 'props-chip');
  chip.type = 'button';
  chip.title = title;
  chip.style.background = cssPaint(color);
  chip.addEventListener('click', onPick);
  return chip;
}
