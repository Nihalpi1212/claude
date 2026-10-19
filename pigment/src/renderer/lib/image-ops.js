// Image menu (Image Size, Canvas Size, Rotate/Flip Canvas, Crop, Trim, Reveal All, Duplicate) and
// Free Transform (Edit › Free Transform / Transform › Scale, Rotate, Skew, Distort, Perspective,
// Rotate 90°/180°, Flip). Whole-document operations build a new layer tree from the old one so the
// structural snapshot in layer-ops.js undoes them exactly; old layers are never mutated.
import { RasterLayer, createCanvas, copyCanvas, intersectRect, unionRect, Document } from './document.js';
import { structural, setLayerProps, cloneLayer } from './layer-ops.js';
import { formDialog } from './form.js';
import { Selection } from './selection.js';
import { Tool } from './tools.js';
import { icon } from './icons.js';
import { flattenDocument } from './compositor.js';
import * as T from '../../shared/pixels/transform.js';

// ---- pixel helpers --------------------------------------------------------------------------------------------

export function canvasData(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

export function dataCanvas(img) {
  const c = createCanvas(Math.max(1, img.width), Math.max(1, img.height));
  const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
  c.getContext('2d').putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return c;
}

/** Draws src (placed at sx, sy) through matrix m; returns { canvas, x, y } covering the result. */
export function affineCanvas(src, sx, sy, m, { smooth = true, clip = null } = {}) {
  let out = T.transformBounds(m, { x: sx, y: sy, width: src.width, height: src.height });
  if (clip) out = intersectRect(out, clip);
  if (!out || out.width < 1 || out.height < 1) return { canvas: createCanvas(1, 1), x: 0, y: 0, empty: true };
  const c = createCanvas(out.width, out.height);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - out.x, m[5] - out.y);
  ctx.drawImage(src, sx, sy);
  return { canvas: c, x: out.x, y: out.y };
}

/** Perspective-warps src (placed at sx, sy) so its corners land on quad [tl, tr, br, bl]. */
export function perspectiveCanvas(src, sx, sy, quad, { quality = 'bilinear', maxSize = 0 } = {}) {
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const out = { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)) };
  out.width = Math.max(1, Math.ceil(Math.max(...xs)) - out.x);
  out.height = Math.max(1, Math.ceil(Math.max(...ys)) - out.y);
  let source = src, scale = 1;
  // previews: work on a reduced copy so dragging stays responsive
  if (maxSize && Math.max(out.width, out.height, src.width, src.height) > maxSize) {
    scale = maxSize / Math.max(out.width, out.height, src.width, src.height);
    source = createCanvas(Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale)));
    source.getContext('2d').drawImage(src, 0, 0, source.width, source.height);
  }
  const w = source.width, h = source.height;
  const srcQuad = [[0, 0], [w, 0], [w, h], [0, h]];
  const dstQuad = quad.map(([x, y]) => [(x - out.x) * scale, (y - out.y) * scale]);
  const outScaled = { x: 0, y: 0, width: Math.max(1, Math.ceil(out.width * scale)), height: Math.max(1, Math.ceil(out.height * scale)) };
  const img = T.perspective(canvasData(source), srcQuad, dstQuad, outScaled, { quality });
  let canvas = dataCanvas(img);
  if (scale !== 1) {
    const full = createCanvas(out.width, out.height);
    const ctx = full.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    canvas = full;
  }
  void sx;
  void sy;
  return { canvas, x: out.x, y: out.y };
}

function alphaCanvas(mask, w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) {
    img.data[j - 3] = img.data[j - 2] = img.data[j - 1] = 255;
    img.data[j] = mask[i];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function canvasAlpha(canvas) {
  const d = canvasData(canvas).data;
  const out = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

function cornerAlpha(canvas) {
  try {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3];
  } catch {
    return 255;
  }
}

const isTranslation = (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
const isAxisAligned = (m) => (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) || (Math.abs(m[0]) < 1e-9 && Math.abs(m[3]) < 1e-9);

/** Transforms a document-sized mask canvas into a new document-sized mask (uncovered area = old background). */
function transformMaskCanvas(mask, m, newW, newH, { smooth = true, resizeMethod = null } = {}) {
  const c = createCanvas(newW, newH);
  const ctx = c.getContext('2d');
  if (resizeMethod) {
    const img = T.resize(canvasData(mask), newW, newH, { method: resizeMethod });
    ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return c;
  }
  const bg = cornerAlpha(mask);
  if (bg > 0) {
    ctx.fillStyle = `rgba(255,255,255,${bg / 255})`;
    ctx.fillRect(0, 0, newW, newH);
    // clear where the old mask lands
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mask.width, mask.height);
    ctx.restore();
  }
  ctx.save();
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
  return c;
}

function mapPath(path, f) {
  return {
    ...path,
    subpaths: (path.subpaths ?? []).map((sp) => ({
      ...sp,
      points: sp.points.map((p) => {
        const q = { ...p };
        [q.x, q.y] = f(p.x, p.y);
        if (p.inX !== undefined) [q.inX, q.inY] = f(p.inX, p.inY);
        if (p.outX !== undefined) [q.outX, q.outY] = f(p.outX, p.outY);
        return q;
      }),
    })),
  };
}

/** Copy of a layer object sharing immutable data; the copy is safe to change without touching the original. */
function shallow(layer, over = {}) {
  const c = Object.assign(Object.create(Object.getPrototypeOf(layer)), layer);
  c.locked = { ...layer.locked };
  if (layer.font) c.font = { ...layer.font, stroke: layer.font.stroke ? { ...layer.font.stroke } : null };
  if (layer.mask) c.mask = { ...layer.mask };
  if ('_cache' in layer) c._cache = null;
  c.parent = null;
  Object.assign(c, over);
  c.version = (layer.version ?? 0) + 1;
  return c;
}

// ---- whole-document remapping -----------------------------------------------------------------------------------

/**
 * spec: { width, height, matrix (old doc -> new doc), mode: 'translate'|'scale'|'exact'|'affine',
 *         method (resize method for 'scale'), clip (delete pixels outside the new canvas),
 *         extend: css colour for newly exposed canvas on a full-canvas bottom layer, scaleStyles }
 */
function remapDocument(app, label, spec) {
  const d = app.doc;
  const { width: W, height: H, matrix: m, mode } = spec;
  const clipRect = spec.clip ? { x: 0, y: 0, width: W, height: H } : null;
  const point = (x, y) => T.applyMatrix(m, x, y);
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  const uniform = Math.abs(sx - sy) < 1e-6;

  const raster = (canvas, x, y) => {
    if (mode === 'translate') {
      const nx = x + m[4], ny = y + m[5];
      if (!clipRect) return { canvas, x: nx, y: ny };
      const r = intersectRect({ x: nx, y: ny, width: canvas.width, height: canvas.height }, clipRect);
      if (!r) return { canvas: createCanvas(1, 1), x: 0, y: 0 };
      if (r.width === canvas.width && r.height === canvas.height) return { canvas, x: nx, y: ny };
      const c = createCanvas(r.width, r.height);
      c.getContext('2d').drawImage(canvas, nx - r.x, ny - r.y);
      return { canvas: c, x: r.x, y: r.y };
    }
    if (mode === 'scale') {
      const x1 = Math.round(x * m[0]), y1 = Math.round(y * m[3]);
      const x2 = Math.round((x + canvas.width) * m[0]), y2 = Math.round((y + canvas.height) * m[3]);
      const img = T.resize(canvasData(canvas), Math.max(1, x2 - x1), Math.max(1, y2 - y1), { method: spec.method ?? 'bicubic' });
      return { canvas: dataCanvas(img), x: x1, y: y1 };
    }
    return affineCanvas(canvas, x, y, m, { smooth: mode !== 'exact', clip: clipRect });
  };

  const mapLayer = (layer) => {
    let out;
    switch (layer.type) {
      case 'group':
        out = shallow(layer);
        out.children = layer.children.map((c) => {
          const cc = mapLayer(c);
          cc.parent = out;
          return cc;
        });
        break;
      case 'raster': {
        const r = raster(layer.canvas, layer.x, layer.y);
        out = shallow(layer, { canvas: r.canvas, x: r.x, y: r.y });
        break;
      }
      case 'text': {
        if (mode === 'translate' && !layer.transform) out = shallow(layer, { x: layer.x + m[4], y: layer.y + m[5] });
        else if (mode === 'scale' && uniform && !layer.transform) {
          const s = sx;
          const font = { ...layer.font, size: layer.font.size * s, letterSpacing: (layer.font.letterSpacing ?? 0) * s };
          if (font.stroke) font.stroke = { ...font.stroke, width: font.stroke.width * s };
          out = shallow(layer, { x: layer.x * s, y: layer.y * s, width: layer.width === null ? null : layer.width * s, font });
        } else out = shallow(layer, { transform: T.multiplyMatrix(m, layer.transform ?? T.IDENTITY) });
        break;
      }
      case 'shape': {
        const over = { path: mapPath(layer.path, point) };
        if (layer.stroke && mode !== 'translate' && spec.scaleStyles !== false) over.stroke = { ...layer.stroke, width: layer.stroke.width * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) };
        out = shallow(layer, over);
        break;
      }
      default:
        out = shallow(layer);
    }
    if (layer.mask?.canvas) {
      out.mask = {
        ...layer.mask,
        canvas: mode === 'scale' ? transformMaskCanvas(layer.mask.canvas, m, W, H, { resizeMethod: 'bilinear' }) : transformMaskCanvas(layer.mask.canvas, m, W, H, { smooth: mode !== 'exact' && mode !== 'translate' }),
      };
    }
    if (out.styles && spec.scaleStyles && mode === 'scale') out.styles = scaleStyles(out.styles, Math.sqrt(sx * sy));
    return out;
  };

  const mapAlpha = (mask) => {
    const c = alphaCanvas(mask, d.width, d.height);
    const nc = mode === 'scale' ? transformMaskCanvas(c, m, W, H, { resizeMethod: 'bilinear' }) : transformMaskCanvas(c, m, W, H, { smooth: mode === 'affine' });
    return canvasAlpha(nc);
  };

  const mapGuide = (g) => {
    const dir = g.axis === 'x' ? [m[2], m[3]] : [m[0], m[1]];
    if (Math.abs(dir[0]) > 1e-9 && Math.abs(dir[1]) > 1e-9) return null;
    const p = g.axis === 'x' ? point(g.pos, 0) : point(0, g.pos);
    const axis = Math.abs(dir[0]) > Math.abs(dir[1]) ? 'y' : 'x';
    return { ...g, axis, pos: Math.round((axis === 'x' ? p[0] : p[1]) * 100) / 100 };
  };

  structural(app, label, () => {
    const root = mapLayer(d.root);
    root.parent = null;
    if (spec.extend) extendBackground(root, d, spec, W, H);
    d.selection = d.selection && !d.selection.isEmpty && spec.keepSelection !== false ? Selection.fromMask(W, H, mapAlpha(d.selection.mask)) : null;
    if (d.selection?.isEmpty) d.selection = null;
    d.guides = d.guides.map(mapGuide).filter(Boolean);
    d.channels = d.channels.map((ch) => ({ ...ch, mask: mapAlpha(ch.mask) }));
    d.paths = d.paths.map((p) => ({ ...p, path: mapPath(p.path, point) }));
    if (spec.dpi) d.dpi = spec.dpi;
    d.replaceTree(root, { width: W, height: H });
  });
  app.view?.center?.();
  app.view?.invalidate();
}

function scaleStyles(styles, s) {
  const out = JSON.parse(JSON.stringify(styles));
  const scaleKeys = ['size', 'distance', 'width', 'range', 'spread'];
  for (const v of Object.values(out)) {
    if (!v || typeof v !== 'object') continue;
    for (const k of ['size', 'distance', 'width']) if (typeof v[k] === 'number') v[k] *= s;
  }
  void scaleKeys;
  return out;
}

/** Canvas Size: paints the newly exposed area on the bottom layer when it covered the old canvas. */
function extendBackground(root, d, spec, W, H) {
  const bottom = root.children[0];
  if (!bottom || bottom.type !== 'raster') return;
  const old = { x: spec.matrix[4], y: spec.matrix[5], width: d.width, height: d.height };
  const b = { x: bottom.x, y: bottom.y, width: bottom.canvas.width, height: bottom.canvas.height };
  if (b.x > old.x || b.y > old.y || b.x + b.width < old.x + old.width || b.y + b.height < old.y + old.height) return;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = spec.extend;
  ctx.fillRect(0, 0, W, H);
  ctx.clearRect(old.x, old.y, old.width, old.height);
  ctx.drawImage(bottom.canvas, bottom.x, bottom.y);
  bottom.canvas = c;
  bottom.x = 0;
  bottom.y = 0;
}

// ---- units ---------------------------------------------------------------------------------------------------

const UNITS = [['px', 'Pixels'], ['percent', 'Percent'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points']];

export function toPx(v, unit, dpi, ref) {
  switch (unit) {
    case 'percent': return (v / 100) * ref;
    case 'in': return v * dpi;
    case 'cm': return (v / 2.54) * dpi;
    case 'mm': return (v / 25.4) * dpi;
    case 'pt': return (v / 72) * dpi;
    default: return v;
  }
}

export function fromPx(px, unit, dpi, ref) {
  switch (unit) {
    case 'percent': return (px / ref) * 100;
    case 'in': return px / dpi;
    case 'cm': return (px / dpi) * 2.54;
    case 'mm': return (px / dpi) * 25.4;
    case 'pt': return (px / dpi) * 72;
    default: return px;
  }
}

const round = (v, unit) => (unit === 'px' ? Math.round(v) : Math.round(v * 1000) / 1000);

const RESAMPLE = [['bicubic', 'Bicubic (smooth gradients)'], ['lanczos', 'Lanczos (sharper)'], ['bilinear', 'Bilinear'], ['area', 'Area average (best for reduction)'], ['nearest', 'Nearest neighbor (hard edges)']];

// ---- install --------------------------------------------------------------------------------------------------

export function install(app) {
  const has = () => !!app.doc;
  const doc = () => app.doc;

  async function imageSize(arg) {
    const d = doc();
    let opts = arg && typeof arg === 'object' ? arg : null;
    if (!opts) {
      let pxW = d.width, pxH = d.height, dpi = d.dpi;
      const unit0 = app.settings.imageSizeUnit ?? 'px';
      const fields = [
        { key: 'unit', label: 'Units', type: 'select', value: unit0, options: UNITS },
        { key: 'width', label: 'Width', type: 'number', value: round(fromPx(pxW, unit0, dpi, d.width), unit0), min: 0.001, step: 0.001 },
        { key: 'height', label: 'Height', type: 'number', value: round(fromPx(pxH, unit0, dpi, d.height), unit0), min: 0.001, step: 0.001 },
        { key: 'dpi', label: 'Resolution (pixels/inch)', type: 'number', value: dpi, min: 1, max: 10000, step: 0.01 },
        { key: 'constrain', label: 'Constrain proportions', type: 'checkbox', value: true },
        { key: 'resample', label: 'Resample', type: 'checkbox', value: true },
        { key: 'method', label: 'Resample method', type: 'select', value: app.settings.resampleMethod ?? 'bicubic', options: RESAMPLE, when: (v) => v.resample },
        { key: 'scaleStyles', label: 'Scale styles', type: 'checkbox', value: true },
        { key: 'info', type: 'custom', render: () => infoEl, sync: () => updateInfo() },
      ];
      const infoEl = document.createElement('div');
      infoEl.className = 'muted';
      const updateInfo = () => {
        const mb = (pxW * pxH * 4) / 1048576;
        infoEl.textContent = `New size: ${Math.round(pxW)} × ${Math.round(pxH)} px (${mb.toFixed(1)} MB per layer) — was ${d.width} × ${d.height} px`;
      };
      updateInfo();
      opts = await formDialog(app, {
        title: 'Image Size',
        fields,
        onChange: (v, key, form) => {
          const ratio = d.width / d.height;
          if (key === 'unit') {
            form.set('width', round(fromPx(pxW, v.unit, dpi, d.width), v.unit), { silent: true });
            form.set('height', round(fromPx(pxH, v.unit, dpi, d.height), v.unit), { silent: true });
          } else if (key === 'width' || key === 'height') {
            const ref = key === 'width' ? d.width : d.height;
            const px = toPx(v[key], v.unit, dpi, ref);
            if (!v.resample && v.unit !== 'px' && v.unit !== 'percent') {
              // physical size changes the resolution, pixels stay
              const pxNow = key === 'width' ? pxW : pxH;
              dpi = Math.max(1, (pxNow / px) * dpi);
              form.set('dpi', Math.round(dpi * 100) / 100, { silent: true });
              const other = key === 'width' ? 'height' : 'width';
              form.set(other, round(fromPx(key === 'width' ? pxH : pxW, v.unit, dpi, other === 'width' ? d.width : d.height), v.unit), { silent: true });
            } else {
              if (key === 'width') pxW = px;
              else pxH = px;
              if (v.constrain) {
                if (key === 'width') pxH = pxW / ratio;
                else pxW = pxH * ratio;
                const other = key === 'width' ? 'height' : 'width';
                form.set(other, round(fromPx(other === 'width' ? pxW : pxH, v.unit, dpi, other === 'width' ? d.width : d.height), v.unit), { silent: true });
              }
            }
          } else if (key === 'dpi') {
            const old = dpi;
            dpi = v.dpi;
            if (v.resample && v.unit !== 'px' && v.unit !== 'percent') {
              pxW = (pxW / old) * dpi;
              pxH = (pxH / old) * dpi;
            } else if (!v.resample) {
              form.set('width', round(fromPx(pxW, v.unit, dpi, d.width), v.unit), { silent: true });
              form.set('height', round(fromPx(pxH, v.unit, dpi, d.height), v.unit), { silent: true });
            }
          } else if (key === 'resample' && !v.resample) {
            pxW = d.width;
            pxH = d.height;
            form.set('width', round(fromPx(pxW, v.unit, dpi, d.width), v.unit), { silent: true });
            form.set('height', round(fromPx(pxH, v.unit, dpi, d.height), v.unit), { silent: true });
          }
          updateInfo();
        },
        validate: () => {
          if (pxW < 1 || pxH < 1 || pxW > 30000 || pxH > 30000) {
            app.dialogs.toast('Width and height must be between 1 and 30,000 pixels', { kind: 'error' });
            return false;
          }
          return true;
        },
      });
      if (!opts) return;
      app.settings.imageSizeUnit = opts.unit;
      app.settings.resampleMethod = opts.method;
      app.saveSettingsSoon();
      opts = { width: Math.round(pxW), height: Math.round(pxH), dpi, method: opts.resample ? opts.method : null, scaleStyles: opts.scaleStyles };
    }
    const W = Math.max(1, Math.round(opts.width)), H = Math.max(1, Math.round(opts.height));
    if (W === d.width && H === d.height) {
      if (opts.dpi && opts.dpi !== d.dpi) structural(app, 'Image size', () => (d.dpi = opts.dpi));
      return;
    }
    await app.busy('Resizing image…', async () => {
      remapDocument(app, 'Image size', { width: W, height: H, matrix: [W / d.width, 0, 0, H / d.height, 0, 0], mode: 'scale', method: opts.method ?? 'bicubic', dpi: opts.dpi, scaleStyles: opts.scaleStyles !== false });
    });
  }

  function anchorField(value = 'c') {
    return {
      key: 'anchor',
      label: 'Anchor',
      type: 'custom',
      value,
      render: (values, set) => {
        const grid = document.createElement('div');
        grid.className = 'anchor-grid';
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,26px);gap:3px';
        const ids = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];
        for (const id of ids) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'seg-button';
          b.style.cssText = 'width:26px;height:26px;padding:0';
          b.dataset.anchor = id;
          b.title = `Anchor ${id}`;
          b.addEventListener('click', () => set('anchor', id));
          grid.appendChild(b);
        }
        const sync = () => {
          for (const b of grid.children) {
            b.setAttribute('aria-pressed', String(b.dataset.anchor === values.anchor));
            b.textContent = b.dataset.anchor === values.anchor ? '●' : '';
          }
        };
        grid._sync = sync;
        sync();
        return grid;
      },
      sync: (values, node) => node?._sync?.(),
    };
  }

  function anchorOffset(anchor, dw, dh) {
    const fx = anchor.includes('w') ? 0 : anchor.includes('e') ? 1 : 0.5;
    const fy = anchor.includes('n') ? 0 : anchor.includes('s') ? 1 : 0.5;
    return [Math.round(dw * fx), Math.round(dh * fy)];
  }

  function extensionColor(kind, custom) {
    return { background: app.settings.background, foreground: app.settings.foreground, white: '#ffffff', black: '#000000', grey: '#808080', custom, transparent: null }[kind] ?? null;
  }

  async function canvasSize(arg) {
    const d = doc();
    let opts = arg && typeof arg === 'object' ? arg : null;
    if (!opts) {
      const unit0 = app.settings.canvasSizeUnit ?? 'px';
      opts = await formDialog(app, {
        title: 'Canvas Size',
        intro: `Current size: ${d.width} × ${d.height} px`,
        fields: [
          { key: 'unit', label: 'Units', type: 'select', value: unit0, options: UNITS },
          { key: 'relative', label: 'Relative', type: 'checkbox', value: false },
          { key: 'width', label: 'Width', type: 'number', value: round(fromPx(d.width, unit0, d.dpi, d.width), unit0), step: 0.001 },
          { key: 'height', label: 'Height', type: 'number', value: round(fromPx(d.height, unit0, d.dpi, d.height), unit0), step: 0.001 },
          anchorField('c'),
          { key: 'extend', label: 'Canvas extension color', type: 'select', value: 'background', options: [['background', 'Background color'], ['foreground', 'Foreground color'], ['white', 'White'], ['black', 'Black'], ['grey', 'Gray'], ['transparent', 'Transparent'], ['custom', 'Other…']] },
          { key: 'custom', label: 'Color', type: 'color', value: '#ffffff', when: (v) => v.extend === 'custom' },
        ],
        onChange: (v, key, form) => {
          if (key === 'unit' || key === 'relative') {
            const baseW = v.relative ? 0 : d.width, baseH = v.relative ? 0 : d.height;
            form.set('width', round(fromPx(baseW, v.unit, d.dpi, d.width), v.unit), { silent: true });
            form.set('height', round(fromPx(baseH, v.unit, d.dpi, d.height), v.unit), { silent: true });
          }
        },
      });
      if (!opts) return;
      app.settings.canvasSizeUnit = opts.unit;
      app.saveSettingsSoon();
      let W = toPx(opts.width, opts.unit, d.dpi, d.width), H = toPx(opts.height, opts.unit, d.dpi, d.height);
      if (opts.unit === 'percent' && opts.relative) {
        W = (opts.width / 100) * d.width;
        H = (opts.height / 100) * d.height;
      }
      if (opts.relative) {
        W += d.width;
        H += d.height;
      }
      opts = { width: Math.round(W), height: Math.round(H), anchor: opts.anchor, color: extensionColor(opts.extend, opts.custom) };
    }
    const W = Math.round(opts.width), H = Math.round(opts.height);
    if (W < 1 || H < 1 || W > 30000 || H > 30000) return app.dialogs.toast('The canvas must be between 1 and 30,000 pixels', { kind: 'error' });
    if (W === d.width && H === d.height) return;
    const [dx, dy] = anchorOffset(opts.anchor ?? 'c', W - d.width, H - d.height);
    remapDocument(app, 'Canvas size', { width: W, height: H, matrix: [1, 0, 0, 1, dx, dy], mode: 'translate', clip: W < d.width || H < d.height ? app.settings.cropDeletes !== false : false, extend: opts.color ?? null });
  }

  async function rotateCanvas(kind) {
    const d = doc();
    const W = d.width, H = d.height;
    if (kind === 'arbitrary') {
      const o = await formDialog(app, {
        title: 'Rotate Canvas',
        fields: [
          { key: 'angle', label: 'Angle', type: 'number', value: 0, min: -359.99, max: 359.99, step: 0.01, unit: '°' },
          { key: 'dir', label: 'Direction', type: 'segment', value: 'cw', options: [['cw', 'Clockwise'], ['ccw', 'Counter-clockwise']] },
        ],
      });
      if (!o || !o.angle) return;
      const deg = o.dir === 'ccw' ? -o.angle : o.angle;
      const n = ((deg % 360) + 360) % 360;
      if (n === 90 || n === 180 || n === 270) return rotateCanvas(n === 90 ? 90 : n === 180 ? 180 : -90);
      const rad = (deg * Math.PI) / 180;
      const r = T.matrixFrom({ rotate: rad, origin: [W / 2, H / 2] });
      const b = T.transformBounds(r, { x: 0, y: 0, width: W, height: H });
      const m = T.multiplyMatrix([1, 0, 0, 1, -b.x, -b.y], r);
      return remapDocument(app, 'Rotate canvas', { width: b.width, height: b.height, matrix: m, mode: 'affine' });
    }
    const specs = {
      90: { w: H, h: W, m: [0, 1, -1, 0, H, 0], label: 'Rotate 90° clockwise' },
      '-90': { w: H, h: W, m: [0, -1, 1, 0, 0, W], label: 'Rotate 90° counter-clockwise' },
      180: { w: W, h: H, m: [-1, 0, 0, -1, W, H], label: 'Rotate 180°' },
      'flip-h': { w: W, h: H, m: [-1, 0, 0, 1, W, 0], label: 'Flip canvas horizontal' },
      'flip-v': { w: W, h: H, m: [1, 0, 0, -1, 0, H], label: 'Flip canvas vertical' },
    };
    const s = specs[String(kind)];
    if (!s) return;
    remapDocument(app, s.label, { width: s.w, height: s.h, matrix: s.m, mode: 'exact' });
  }

  function cropRect(arg) {
    const d = doc();
    const r = arg?.rect;
    if (!r) return;
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
    remapDocument(app, arg.label ?? 'Crop', { width: rect.width, height: rect.height, matrix: [1, 0, 0, 1, -rect.x, -rect.y], mode: 'translate', clip: arg.deletePixels !== false, keepSelection: arg.keepSelection ?? false });
    void d;
  }

  function cropToSelection() {
    const d = doc();
    const b = d.selection?.bounds;
    if (!b) return app.dialogs.toast('Make a selection first', { kind: 'error' });
    cropRect({ rect: b, deletePixels: true, label: 'Crop' });
  }

  async function trim(arg) {
    const d = doc();
    let opts = arg && typeof arg === 'object' ? arg : null;
    if (!opts) {
      opts = await formDialog(app, {
        title: 'Trim',
        fields: [
          { key: 'basis', label: 'Based on', type: 'select', value: 'transparent', options: [['transparent', 'Transparent pixels'], ['top-left', 'Top left pixel color'], ['bottom-right', 'Bottom right pixel color']] },
          { type: 'section', label: 'Trim away' },
          { key: 'top', label: 'Top', type: 'checkbox', value: true },
          { key: 'bottom', label: 'Bottom', type: 'checkbox', value: true },
          { key: 'left', label: 'Left', type: 'checkbox', value: true },
          { key: 'right', label: 'Right', type: 'checkbox', value: true },
        ],
      });
      if (!opts) return;
    }
    const flat = flattenDocument(d, d.view.compositor);
    const data = canvasData(flat).data;
    const W = d.width, H = d.height;
    let ref = null;
    if (opts.basis === 'top-left') ref = 0;
    else if (opts.basis === 'bottom-right') ref = (W * H - 1) * 4;
    const differs = (i) => {
      if (ref === null) return data[i + 3] > 0;
      return Math.abs(data[i] - data[ref]) > 1 || Math.abs(data[i + 1] - data[ref + 1]) > 1 || Math.abs(data[i + 2] - data[ref + 2]) > 1 || Math.abs(data[i + 3] - data[ref + 3]) > 1;
    };
    let x1 = W, y1 = H, x2 = -1, y2 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!differs((y * W + x) * 4)) continue;
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
    if (x2 < 0) return app.dialogs.toast('Nothing to trim: the image is empty', { kind: 'error' });
    const rect = { x: opts.left !== false ? x1 : 0, y: opts.top !== false ? y1 : 0 };
    rect.width = (opts.right !== false ? x2 + 1 : W) - rect.x;
    rect.height = (opts.bottom !== false ? y2 + 1 : H) - rect.y;
    if (rect.x === 0 && rect.y === 0 && rect.width === W && rect.height === H) return app.dialogs.toast('Nothing to trim', { timeout: 1500 });
    cropRect({ rect, deletePixels: true, label: 'Trim' });
  }

  function revealAll() {
    const d = doc();
    let b = { x: 0, y: 0, width: d.width, height: d.height };
    for (const l of d.layers()) {
      if (l.isGroup || l.type === 'fill' || l.type === 'adjustment') continue;
      const lb = l.bounds();
      if (lb) b = unionRect(b, lb);
    }
    if (b.x === 0 && b.y === 0 && b.width === d.width && b.height === d.height) return app.dialogs.toast('All layer content is already visible', { timeout: 1600 });
    remapDocument(app, 'Reveal all', { width: b.width, height: b.height, matrix: [1, 0, 0, 1, -b.x, -b.y], mode: 'translate' });
  }

  async function duplicate(arg) {
    const d = doc();
    let opts = arg && typeof arg === 'object' ? arg : null;
    if (!opts) {
      opts = await formDialog(app, {
        title: 'Duplicate Image',
        fields: [
          { key: 'name', label: 'Name', type: 'text', value: `${d.name.replace(/\.[^.]+$/, '')} copy`, autofocus: true },
          { key: 'merged', label: 'Duplicate merged layers only', type: 'checkbox', value: false },
        ],
      });
      if (!opts) return;
    }
    const copy = new Document({ width: d.width, height: d.height, dpi: d.dpi, name: opts.name || `${d.name} copy` });
    if (opts.merged) {
      const flat = copyCanvas(flattenDocument(d, d.view.compositor));
      const layer = new RasterLayer({ name: 'Background', canvas: flat });
      layer.parent = copy.root;
      copy.root.children.push(layer);
      copy.active = layer;
    } else {
      for (const l of d.root.children) {
        const c = cloneLayer(l, { name: l.name });
        c.parent = copy.root;
        copy.root.children.push(c);
      }
      copy.active = copy.root.children[copy.root.children.length - 1] ?? null;
    }
    copy.selected = new Set(copy.active ? [copy.active] : []);
    copy.guides = d.guides.map((g) => ({ ...g }));
    copy.channels = d.channels.map((c) => ({ ...c, mask: new Uint8ClampedArray(c.mask) }));
    copy.paths = d.paths.map((p) => JSON.parse(JSON.stringify(p)));
    if (d.selection) copy.selection = Selection.fromMask(d.width, d.height, new Uint8ClampedArray(d.selection.mask));
    app.docs.add(copy);
    copy.history.markSaved();
    // a duplicate has never been saved: mark it dirty so closing asks
    copy.history.savedIndex = -2;
    app.syncUiState();
  }

  // ---- free transform -------------------------------------------------------------------------------------------
  const transformTool = new TransformTool(app);
  app.tools.tools.set(transformTool.id, transformTool);
  app.transformTool = transformTool;

  app.commands.registerAll({
    'image:size': { enabled: has, run: imageSize, label: 'Image Size…' },
    'image:canvas-size': { enabled: has, run: canvasSize, label: 'Canvas Size…' },
    'image:rotate': { enabled: has, run: (k) => rotateCanvas(k ?? 90) },
    'image:rotate-90': { enabled: has, run: () => rotateCanvas(90), label: 'Rotate 90° Clockwise' },
    'image:rotate--90': { enabled: has, run: () => rotateCanvas(-90), label: 'Rotate 90° Counter Clockwise' },
    'image:rotate-180': { enabled: has, run: () => rotateCanvas(180), label: 'Rotate 180°' },
    'image:rotate-arbitrary': { enabled: has, run: () => rotateCanvas('arbitrary'), label: 'Arbitrary…' },
    'image:flip-h': { enabled: has, run: () => rotateCanvas('flip-h'), label: 'Flip Canvas Horizontal' },
    'image:flip-v': { enabled: has, run: () => rotateCanvas('flip-v'), label: 'Flip Canvas Vertical' },
    'image:crop': { enabled: () => !!app.doc?.selection && !app.doc.selection.isEmpty, run: cropToSelection, label: 'Crop' },
    'image:crop-rect': { enabled: has, run: cropRect },
    'image:trim': { enabled: has, run: trim, label: 'Trim…' },
    'image:reveal-all': { enabled: has, run: revealAll, label: 'Reveal All' },
    'image:duplicate': { enabled: has, run: duplicate, label: 'Duplicate…' },
    'edit:free-transform': { enabled: () => transformTool.canStart(), run: (arg) => transformTool.start({ mode: 'free', ...(arg ?? {}) }), label: 'Free Transform' },
    'edit:transform': {
      enabled: () => transformTool.canStart(),
      run: (kind) => {
        const quick = { 'rotate-180': Math.PI, 'rotate-90': Math.PI / 2, 'rotate--90': -Math.PI / 2 };
        if (kind in quick || kind === 'flip-h' || kind === 'flip-v') return transformTool.quick(kind);
        return transformTool.start({ mode: kind ?? 'free' });
      },
    },
    'edit:transform-again': { enabled: () => !!transformTool.lastMatrix && transformTool.canStart(), run: () => transformTool.again(), label: 'Transform Again' },
  });
  for (const k of ['scale', 'rotate', 'skew', 'distort', 'perspective', 'rotate-180', 'rotate-90', 'rotate--90', 'flip-h', 'flip-v']) {
    app.commands.register(`edit:transform-${k}`, { enabled: () => transformTool.canStart(), run: () => app.commands.run('edit:transform', k, 'api') });
  }

  app.remapDocument = (label, spec) => remapDocument(app, label, spec);
}

// ---- Transform tool -------------------------------------------------------------------------------------------

const HANDLE_IDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const LOCAL = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

function affineFromQuad(box, q) {
  // maps box corners (tl, tr, bl) onto quad points (tl, tr, bl)
  const [tl, tr, , bl] = q;
  const a = (tr[0] - tl[0]) / box.width, b = (tr[1] - tl[1]) / box.width;
  const c = (bl[0] - tl[0]) / box.height, d = (bl[1] - tl[1]) / box.height;
  return [a, b, c, d, tl[0] - a * box.x - c * box.y, tl[1] - b * box.x - d * box.y];
}

function quadFromMatrix(box, m) {
  return [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]].map(([x, y]) => T.applyMatrix(m, x, y));
}

function isParallelogram(q) {
  const e = 1e-3;
  return Math.abs(q[0][0] + q[2][0] - q[1][0] - q[3][0]) < e && Math.abs(q[0][1] + q[2][1] - q[1][1] - q[3][1]) < e;
}

export class TransformTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'transform',
      name: 'Free Transform',
      icon: 'transform',
      cursor: 'default',
      hint: 'Drag handles to scale (Shift keeps proportions, Alt from the centre), outside to rotate (Shift snaps 15°), Ctrl+drag a corner to distort, Ctrl+Shift+drag an edge to skew. Enter applies, Esc cancels.',
      options: [],
    });
    this.session = null;
    this.lastMatrix = null;
  }

  canStart() {
    const d = this.app.doc;
    if (!d || this.session) return false;
    return this.collectTargets(d, { quiet: true }).length > 0 || (d.selection && !d.selection.isEmpty);
  }

  collectTargets(d, { quiet = false } = {}) {
    const out = [];
    const add = (l) => {
      if (l.isGroup) return l.children.forEach(add);
      if (!l.visible && l !== d.active) return;
      if (['raster', 'text', 'shape'].includes(l.type)) out.push(l);
    };
    const sel = d.selectedLayers();
    (sel.length ? sel : d.active ? [d.active] : []).forEach(add);
    const locked = out.filter((l) => l.locked.all || l.locked.position);
    if (locked.length && !quiet) this.app.dialogs.toast(`"${locked[0].name}" is locked`, { kind: 'error' });
    return out.filter((l) => !(l.locked.all || l.locked.position));
  }

  /** Starts an interactive transform. opts: { mode, selectionOnly } */
  start({ mode = 'free', selectionOnly = false } = {}) {
    const app = this.app;
    const d = app.doc;
    if (!d || this.session) return;
    app.tools.active?.commit?.();
    const hasSel = d.selection && !d.selection.isEmpty;
    const s = { mode, doc: d, targets: [], selectionOnly: false, history: [] };
    if (selectionOnly) {
      if (!hasSel) return;
      s.selectionOnly = true;
      s.selection = d.selection;
      s.selCanvas = alphaCanvas(d.selection.mask, d.width, d.height);
      s.box = { ...d.selection.bounds };
    } else {
      const layers = this.collectTargets(d);
      if (!layers.length) {
        if (hasSel) return this.start({ mode, selectionOnly: true });
        return app.dialogs.toast('Select a layer to transform', { kind: 'error' });
      }
      if (hasSel && layers.length === 1 && layers[0].type === 'raster') {
        // transform the selected pixels: cut them into a floating piece
        const layer = layers[0];
        const b = intersectRect(d.selection.bounds, layer.bounds());
        if (!b) return app.dialogs.toast('The selected area is empty', { kind: 'error' });
        const piece = createCanvas(b.width, b.height);
        const pctx = piece.getContext('2d');
        pctx.drawImage(layer.canvas, layer.x - b.x, layer.y - b.y);
        pctx.globalCompositeOperation = 'destination-in';
        pctx.drawImage(d.selection.toCanvas(), -b.x, -b.y);
        const erased = copyCanvas(layer.canvas);
        const ectx = erased.getContext('2d');
        ectx.globalCompositeOperation = 'destination-out';
        ectx.drawImage(d.selection.toCanvas(), -layer.x, -layer.y);
        s.floating = { layer, piece, pieceX: b.x, pieceY: b.y, erased, orig: { canvas: layer.canvas, x: layer.x, y: layer.y }, selection: d.selection };
        s.box = { ...b };
        s.targets = [layer];
        layer.canvas = erased;
        layer.touch();
      } else {
        s.targets = layers;
        let box = null;
        for (const l of layers) {
          const lb = l.type === 'raster' ? contentRect(l) : l.bounds();
          if (lb) box = box ? unionRect(box, lb) : lb;
        }
        if (!box) return app.dialogs.toast('The layer is empty', { kind: 'error' });
        s.box = box;
        s.orig = layers.map((l) => ({ layer: l, canvas: l.canvas, x: l.x, y: l.y, transform: l.transform ?? null, path: l.path, mask: l.mask, stroke: l.stroke }));
        // crop raster sources to their content so the transform box hugs the pixels
        s.sources = new Map();
        for (const o of s.orig) {
          if (o.layer.type !== 'raster') continue;
          const r = contentRect(o.layer);
          if (!r) continue;
          const c = createCanvas(r.width, r.height);
          c.getContext('2d').drawImage(o.canvas, o.x - r.x, o.y - r.y);
          s.sources.set(o.layer, { canvas: c, x: r.x, y: r.y });
        }
      }
    }
    s.hasText = s.targets.some((l) => l.type === 'text');
    s.quad = quadFromMatrix(s.box, T.IDENTITY);
    s.pivot = [s.box.x + s.box.width / 2, s.box.y + s.box.height / 2];
    s.interp = app.settings.transformInterpolation ?? 'bicubic';
    this.session = s;
    this.returnTo = app.tools.active && app.tools.active !== this ? app.tools.active.id : 'move';
    // the selection outline is hidden while transforming pixels
    if (!s.selectionOnly) d.view.hideAnts = true;
    app.tools.activate(this.id);
    this.unsub = d.onChange((e) => {
      if (e.kind === 'history' && !this.committing && this.session) this.cancel();
    });
    this.update();
  }

  /** Immediate rotate/flip of the target layers around their centre. */
  quick(kind) {
    this.start({ mode: 'free' });
    const s = this.session;
    if (!s) return;
    const [cx, cy] = s.pivot;
    let m;
    if (kind === 'flip-h') m = [-1, 0, 0, 1, 2 * cx, 0];
    else if (kind === 'flip-v') m = [1, 0, 0, -1, 0, 2 * cy];
    else m = T.matrixFrom({ rotate: { 'rotate-180': Math.PI, 'rotate-90': Math.PI / 2, 'rotate--90': -Math.PI / 2 }[kind], origin: [cx, cy] });
    s.quad = quadFromMatrix(s.box, m);
    s.exact = true;
    this.commit();
  }

  again() {
    const m = this.lastMatrix;
    if (!m) return;
    this.start({ mode: 'free' });
    const s = this.session;
    if (!s) return;
    // apply the last transform relative to the new box: same linear part, same pivot-relative translation
    const c = [s.box.x + s.box.width / 2, s.box.y + s.box.height / 2];
    const lin = [m[0], m[1], m[2], m[3], 0, 0];
    const p = T.applyMatrix(lin, c[0], c[1]);
    const mm = [m[0], m[1], m[2], m[3], c[0] - p[0] + (this.lastShift?.[0] ?? 0), c[1] - p[1] + (this.lastShift?.[1] ?? 0)];
    s.quad = quadFromMatrix(s.box, mm);
    this.commit();
  }

  /** Destination quad of a rect (document coords) under the current transform. */
  quadFor(rect) {
    const s = this.session;
    const m = this.matrix;
    const corners = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]];
    if (m) return corners.map(([x, y]) => T.applyMatrix(m, x, y));
    const H = T.homography(quadFromMatrix(s.box, T.IDENTITY), s.quad);
    return corners.map(([x, y]) => T.applyHomography(H, x, y));
  }

  get matrix() {
    const s = this.session;
    return s && isParallelogram(s.quad) ? affineFromQuad(s.box, s.quad) : null;
  }

  deactivate() {
    if (this.session && !this.committing) this.commit();
  }

  // -- preview -------------------------------------------------------------------------------------------------
  update({ final = false } = {}) {
    const s = this.session;
    if (!s) return;
    const m = this.matrix;
    const big = s.box.width * s.box.height > 4e6;
    if (s.selectionOnly) {
      this.view?.invalidate();
      this.syncBar();
      return;
    }
    if (s.floating) {
      const f = s.floating;
      const r = m ? affineCanvas(f.piece, f.pieceX, f.pieceY, m, { smooth: !big || final }) : perspectiveCanvas(f.piece, f.pieceX, f.pieceY, this.quadFor({ x: f.pieceX, y: f.pieceY, width: f.piece.width, height: f.piece.height }), { maxSize: final ? 0 : 700 });
      if (!s.previewLayer) {
        s.previewLayer = new RasterLayer({ name: 'Transform', canvas: r.canvas, x: r.x, y: r.y, opacity: f.layer.opacity, blend: f.layer.blend });
        s.previewLayer.preview = true;
        const parent = f.layer.parent;
        parent.children.splice(parent.children.indexOf(f.layer) + 1, 0, s.previewLayer);
        s.previewLayer.parent = parent;
      } else {
        s.previewLayer.canvas = r.canvas;
        s.previewLayer.x = r.x;
        s.previewLayer.y = r.y;
      }
      s.previewLayer.touch();
    } else {
      for (const o of s.orig) {
        const l = o.layer;
        if (l.type === 'raster') {
          const src = s.sources.get(l);
          if (!src) continue;
          const r = m ? affineCanvas(src.canvas, src.x, src.y, m, { smooth: !big || final }) : perspectiveCanvas(src.canvas, src.x, src.y, this.quadFor({ x: src.x, y: src.y, width: src.canvas.width, height: src.canvas.height }), { maxSize: final ? 0 : 700 });
          // pixels of the layer outside the content rect are transparent: the preview replaces the canvas
          l.canvas = r.canvas;
          l.x = r.x;
          l.y = r.y;
        } else if (l.type === 'text') {
          if (m) l.transform = T.multiplyMatrix(m, o.transform ?? T.IDENTITY);
        } else if (l.type === 'shape') {
          const H = m ? null : T.homography(quadFromMatrix(s.box, T.IDENTITY), s.quad);
          l.path = mapPath(o.path, m ? (x, y) => T.applyMatrix(m, x, y) : (x, y) => T.applyHomography(H, x, y));
        }
        l.touch();
      }
    }
    s.doc.changed('pixels');
    this.syncBar();
  }

  restoreOriginals() {
    const s = this.session;
    if (!s) return;
    if (s.previewLayer) {
      const parent = s.previewLayer.parent;
      parent.children.splice(parent.children.indexOf(s.previewLayer), 1);
      s.previewLayer = null;
    }
    if (s.floating) {
      const f = s.floating;
      f.layer.canvas = f.orig.canvas;
      f.layer.x = f.orig.x;
      f.layer.y = f.orig.y;
      f.layer.touch();
    }
    for (const o of s.orig ?? []) {
      const l = o.layer;
      if (l.type === 'raster') {
        l.canvas = o.canvas;
        l.x = o.x;
        l.y = o.y;
      } else if (l.type === 'text') l.transform = o.transform;
      else if (l.type === 'shape') l.path = o.path;
      l.touch();
    }
  }

  end() {
    const s = this.session;
    this.unsub?.();
    this.unsub = null;
    this.session = null;
    this.drag = null;
    if (s) s.doc.view.hideAnts = false;
    const back = this.returnTo ?? 'move';
    this.returnTo = null;
    if (this.app.tools.active === this) {
      this.committing = true;
      this.app.tools.activate(back);
      this.committing = false;
    }
    this.app.commands.invalidate();
    this.app.view?.invalidate();
  }

  cancel() {
    if (!this.session) return false;
    this.restoreOriginals();
    this.session.doc.changed('pixels');
    this.end();
    return true;
  }

  commit() {
    const s = this.session;
    if (!s) return false;
    const app = this.app;
    const d = s.doc;
    const m = this.matrix;
    const identity = m && Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;
    this.restoreOriginals();
    if (identity) {
      d.changed('pixels');
      this.end();
      return true;
    }
    this.committing = true;
    try {
      const quality = s.interp;
      const render = (canvas, x, y) => {
        if (m) {
          if (s.exact) return affineCanvas(canvas, x, y, m, { smooth: false });
          if (quality === 'nearest') return affineCanvas(canvas, x, y, m, { smooth: false });
          return affineCanvas(canvas, x, y, m, { smooth: true });
        }
        return perspectiveCanvas(canvas, x, y, this.quadFor({ x, y, width: canvas.width, height: canvas.height }), { quality: quality === 'nearest' ? 'nearest' : quality === 'bilinear' ? 'bilinear' : 'bicubic' });
      };
      // masks follow affine transforms (perspective leaves them in place)
      const mapMask = (mask) => (m ? transformMaskCanvas(mask, m, d.width, d.height, { smooth: !s.exact }) : mask);
      if (s.selectionOnly) {
        const r = render(s.selCanvas, 0, 0);
        const c = createCanvas(d.width, d.height);
        c.getContext('2d').drawImage(r.canvas, r.x, r.y);
        const sel = Selection.fromMask(d.width, d.height, canvasAlpha(c));
        app.applySelection(sel.isEmpty ? null : sel, 'replace', 'Transform selection');
      } else if (s.floating) {
        const f = s.floating;
        const r = render(f.piece, f.pieceX, f.pieceY);
        const label = 'Free transform';
        d.history.group(label, () => {
          d.history.replaceCanvas(label, f.layer, () => {
            const b = unionRect({ x: f.layer.x, y: f.layer.y, width: f.erased.width, height: f.erased.height }, { x: r.x, y: r.y, width: r.canvas.width, height: r.canvas.height });
            const c = createCanvas(b.width, b.height);
            const ctx = c.getContext('2d');
            ctx.drawImage(f.erased, f.layer.x - b.x, f.layer.y - b.y);
            ctx.drawImage(r.canvas, r.x - b.x, r.y - b.y);
            return { canvas: c, x: b.x, y: b.y };
          });
          // the selection follows the pixels
          const sr = render(alphaCanvas(f.selection.mask, d.width, d.height), 0, 0);
          const sc = createCanvas(d.width, d.height);
          sc.getContext('2d').drawImage(sr.canvas, sr.x, sr.y);
          const before = d.selection, after = Selection.fromMask(d.width, d.height, canvasAlpha(sc));
          const set = (v) => {
            d.selection = v && !v.isEmpty ? v : null;
            d.changed('selection');
          };
          set(after);
          d.history.push({ label: 'Transform selection', undo: () => set(before), redo: () => set(after), bytes: 0, at: Date.now() });
        });
      } else {
        d.history.group('Free transform', () => {
          for (const o of s.orig) {
            const l = o.layer;
            if (l.type === 'raster') {
              const src = s.sources.get(l);
              if (!src) continue;
              d.history.replaceCanvas('Transform', l, () => render(src.canvas, src.x, src.y));
            } else if (l.type === 'text') {
              if (m) setLayerProps(app, l, { transform: T.multiplyMatrix(m, o.transform ?? T.IDENTITY) }, 'Transform');
              else app.dialogs.toast('Distort and perspective need a rasterized text layer', { kind: 'error' });
            } else if (l.type === 'shape') {
              const H = m ? null : T.homography(quadFromMatrix(s.box, T.IDENTITY), s.quad);
              const f = m ? (x, y) => T.applyMatrix(m, x, y) : (x, y) => T.applyHomography(H, x, y);
              const patch = { path: mapPath(o.path, f) };
              if (l.stroke && m && app.settings.transformScalesStrokes) patch.stroke = { ...l.stroke, width: l.stroke.width * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) };
              setLayerProps(app, l, patch, 'Transform');
            }
            if (l.mask?.canvas && l.mask.linked !== false && m) {
              const before = l.mask, after = { ...l.mask, canvas: mapMask(l.mask.canvas) };
              const set = (v) => {
                l.mask = v;
                l.touch();
                d.changed('pixels', { layer: l });
              };
              set(after);
              d.history.push({ label: 'Transform mask', undo: () => set(before), redo: () => set(after), bytes: d.width * d.height * 4, at: Date.now() });
            }
          }
        });
      }
      if (m) {
        this.lastMatrix = m;
        this.lastShift = null;
      }
    } catch (err) {
      app.reportError(err, 'Could not apply the transform');
    } finally {
      this.committing = false;
    }
    d.changed('pixels');
    this.end();
    return true;
  }

  // -- interaction ---------------------------------------------------------------------------------------------
  screenQuad() {
    return this.session.quad.map(([x, y]) => {
      const p = this.view.toScreen(x, y);
      return [p.x, p.y];
    });
  }

  handlePoints() {
    const q = this.screenQuad();
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return { nw: q[0], n: mid(q[0], q[1]), ne: q[1], e: mid(q[1], q[2]), se: q[2], s: mid(q[2], q[3]), sw: q[3], w: mid(q[3], q[0]) };
  }

  hit(p) {
    const s = this.session;
    if (!s) return null;
    const pivot = this.view.toScreen(s.pivot[0], s.pivot[1]);
    if (Math.hypot(pivot.x - p.screenX, pivot.y - p.screenY) < 7) return 'pivot';
    const hp = this.handlePoints();
    for (const id of HANDLE_IDS) if (Math.hypot(hp[id][0] - p.screenX, hp[id][1] - p.screenY) < 8) return id;
    if (pointInQuad([p.screenX, p.screenY], this.screenQuad())) return 'move';
    return 'rotate';
  }

  cursorFor(h) {
    if (!h) return 'default';
    if (h === 'move') return 'move';
    if (h === 'pivot') return 'crosshair';
    if (h === 'rotate') return 'alias';
    const m = this.matrix;
    const angle = m ? Math.atan2(m[1], m[0]) : 0;
    const base = { n: 90, ne: 45, e: 0, se: -45, s: 90, sw: 45, w: 0, nw: -45 }[h];
    const a = (((base - (angle * 180) / Math.PI) % 180) + 180) % 180;
    return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nesw-resize' : a < 112.5 ? 'ns-resize' : 'nwse-resize';
  }

  onPointerDown(p) {
    const s = this.session;
    if (!s) return;
    const h = this.hit(p);
    const ctrl = p.ctrl || p.meta;
    let op = h;
    if (h && LOCAL[h]) {
      const corner = h.length === 2;
      if (s.mode === 'distort' || (ctrl && !p.shift && !p.alt && corner)) op = 'distort';
      else if (s.mode === 'perspective' || (ctrl && p.shift && p.alt && corner)) op = 'perspective';
      else if (s.mode === 'skew' || (ctrl && !corner)) op = 'skew';
      else if (s.mode === 'rotate') op = 'rotate';
      else op = 'scale';
      if ((op === 'distort' || op === 'perspective') && s.hasText) {
        this.app.dialogs.toast('Text layers can only be scaled, rotated and skewed', { kind: 'error', timeout: 2200 });
        op = 'scale';
      }
    } else if (h === 'move' && s.mode === 'rotate') op = 'rotate';
    this.drag = { op, handle: h, start: p, quad: s.quad.map((q) => q.slice()), pivot: s.pivot.slice(), matrix: this.matrix };
  }

  onPointerMove(p, dragging) {
    const s = this.session;
    if (!s) return;
    if (!dragging || !this.drag) {
      this.view.setCursor(this.cursorFor(this.hit(p)));
      return;
    }
    const dr = this.drag;
    const dx = p.x - dr.start.x, dy = p.y - dr.start.y;
    const M0 = dr.matrix;
    switch (dr.op) {
      case 'pivot':
        s.pivot = [dr.pivot[0] + dx, dr.pivot[1] + dy];
        break;
      case 'move': {
        let mx = dx, my = dy;
        if (p.shift) Math.abs(dx) > Math.abs(dy) ? (my = 0) : (mx = 0);
        s.quad = dr.quad.map(([x, y]) => [x + mx, y + my]);
        s.pivot = [dr.pivot[0] + mx, dr.pivot[1] + my];
        break;
      }
      case 'rotate': {
        const [cx, cy] = dr.pivot;
        let a = Math.atan2(p.y - cy, p.x - cx) - Math.atan2(dr.start.y - cy, dr.start.x - cx);
        if (p.shift) {
          const base = M0 ? Math.atan2(M0[1], M0[0]) : 0;
          const step = Math.PI / 12;
          a = Math.round((base + a) / step) * step - base;
        }
        const R = T.matrixFrom({ rotate: a, origin: [cx, cy] });
        s.quad = dr.quad.map(([x, y]) => T.applyMatrix(R, x, y));
        break;
      }
      case 'scale': {
        if (!M0) {
          // non-affine quad: move the handle's corners
          moveCorners(s, dr, dx, dy);
          break;
        }
        const inv = T.invertMatrix(M0);
        const [u, v] = T.applyMatrix(inv, p.x, p.y);
        const b = s.box;
        const [hx, hy] = LOCAL[dr.handle];
        const alt = p.alt;
        const anchor = alt ? [b.x + b.width / 2, b.y + b.height / 2] : [b.x + (1 - hx) * b.width, b.y + (1 - hy) * b.height];
        const hxAbs = b.x + hx * b.width, hyAbs = b.y + hy * b.height;
        let sx = hx === 0.5 ? 1 : (u - anchor[0]) / (hxAbs - anchor[0] || 1);
        let sy = hy === 0.5 ? 1 : (v - anchor[1]) / (hyAbs - anchor[1] || 1);
        const proportional = this.app.settings.transformProportional ? !p.shift : p.shift;
        if (proportional) {
          if (hx === 0.5) sx = Math.sign(sx || 1) * Math.abs(sy);
          else if (hy === 0.5) sy = Math.sign(sy || 1) * Math.abs(sx);
          else {
            const k = Math.max(Math.abs(sx), Math.abs(sy));
            sx = Math.sign(sx || 1) * k;
            sy = Math.sign(sy || 1) * k;
          }
        }
        if (Math.abs(sx) < 1e-3) sx = 1e-3 * Math.sign(sx || 1);
        if (Math.abs(sy) < 1e-3) sy = 1e-3 * Math.sign(sy || 1);
        const S = [sx, 0, 0, sy, anchor[0] - sx * anchor[0], anchor[1] - sy * anchor[1]];
        const M = T.multiplyMatrix(M0, S);
        s.quad = quadFromMatrix(b, M);
        s.pivot = T.applyMatrix(M, b.x + b.width / 2, b.y + b.height / 2);
        break;
      }
      case 'skew': {
        if (!M0) {
          moveCorners(s, dr, dx, dy);
          break;
        }
        const inv = T.invertMatrix(M0);
        const [u, v] = T.applyMatrix(inv, p.x, p.y);
        const [u0, v0] = T.applyMatrix(inv, dr.start.x, dr.start.y);
        const b = s.box;
        const [hx, hy] = LOCAL[dr.handle];
        let K;
        if (hy !== 0.5 && hx === 0.5) {
          const ay = b.y + (1 - hy) * b.height, hyAbs = b.y + hy * b.height;
          const k = (u - u0) / (hyAbs - ay || 1);
          K = [1, 0, k, 1, -k * ay, 0];
        } else if (hx !== 0.5 && hy === 0.5) {
          const ax = b.x + (1 - hx) * b.width, hxAbs = b.x + hx * b.width;
          const k = (v - v0) / (hxAbs - ax || 1);
          K = [1, k, 0, 1, 0, -k * ax];
        } else {
          moveCorners(s, dr, dx, dy);
          break;
        }
        s.quad = quadFromMatrix(b, T.multiplyMatrix(M0, K));
        break;
      }
      case 'distort':
        moveCorners(s, dr, dx, dy);
        break;
      case 'perspective': {
        const i = { nw: 0, ne: 1, se: 2, sw: 3 }[dr.handle];
        if (i === undefined) {
          moveCorners(s, dr, dx, dy);
          break;
        }
        const q = dr.quad.map((x) => x.slice());
        if (Math.abs(dx) > Math.abs(dy)) {
          const j = [1, 0, 3, 2][i];
          q[i][0] += dx;
          q[j][0] -= dx;
        } else {
          const j = [3, 2, 1, 0][i];
          q[i][1] += dy;
          q[j][1] -= dy;
        }
        s.quad = q;
        break;
      }
    }
    this.scheduleUpdate();
  }

  onPointerUp() {
    if (!this.drag) return;
    const moved = this.drag.op !== 'pivot';
    this.drag = null;
    if (moved) this.update({ final: true });
  }

  onDoubleClick(p) {
    if (this.hit(p) === 'move') this.commit();
  }

  onKeyDown(e) {
    if (!this.session) return false;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      const [dx, dy] = moves[e.key];
      const s = this.session;
      s.quad = s.quad.map(([x, y]) => [x + dx, y + dy]);
      s.pivot = [s.pivot[0] + dx, s.pivot[1] + dy];
      this.update({ final: true });
      return true;
    }
    if (e.key === 'Enter') {
      this.commit();
      return true;
    }
    if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) {
      // undo while transforming cancels the transform
      this.cancel();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  scheduleUpdate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  }

  drawOverlay(ctx, view) {
    const s = this.session;
    if (!s) return;
    const q = this.screenQuad();
    ctx.save();
    if (s.selectionOnly) {
      // outline of the transformed selection box
      ctx.setLineDash([4, 3]);
    }
    ctx.strokeStyle = '#2f80ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    const hp = this.handlePoints();
    ctx.fillStyle = '#ffffff';
    for (const id of HANDLE_IDS) {
      const [x, y] = hp[id];
      ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8);
      ctx.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
    }
    const pv = view.toScreen(s.pivot[0], s.pivot[1]);
    ctx.beginPath();
    ctx.arc(pv.x, pv.y, 5, 0, Math.PI * 2);
    ctx.moveTo(pv.x - 8, pv.y);
    ctx.lineTo(pv.x + 8, pv.y);
    ctx.moveTo(pv.x, pv.y - 8);
    ctx.lineTo(pv.x, pv.y + 8);
    ctx.stroke();
    if (s.selectionOnly) {
      // preview the selection mask transformed
      const m = this.matrix;
      if (m) {
        ctx.globalAlpha = 0.25;
        const vm = view.matrix();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const dpr = view.dpr;
        const t = T.multiplyMatrix([dpr * vm.a, dpr * vm.b, dpr * vm.c, dpr * vm.d, dpr * vm.e, dpr * vm.f], m);
        ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
        ctx.drawImage(s.selCanvas, 0, 0);
      }
    }
    ctx.restore();
  }

  // -- options bar -------------------------------------------------------------------------------------------
  renderBar() {
    const bar = this.app.tools.optionsBar;
    if (!bar) return;
    // ToolManager renders the title; we add numeric fields
    this.fields = {};
    const add = (key, label, unit, onCommit) => {
      const wrap = document.createElement('label');
      wrap.className = 'opt opt-number';
      wrap.innerHTML = `<span class="opt-label">${label}</span>`;
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input';
      input.step = 'any';
      input.dataset.key = key;
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) onCommit(v);
      });
      wrap.appendChild(input);
      if (unit) {
        const u = document.createElement('span');
        u.className = 'opt-unit';
        u.textContent = unit;
        wrap.appendChild(u);
      }
      bar.appendChild(wrap);
      this.fields[key] = input;
    };
    const withMatrix = (fn) => {
      const s = this.session;
      const m = this.matrix;
      if (!s || !m) return this.app.dialogs.toast('Numeric values are not available for a distorted transform', { kind: 'error' });
      fn(s, m);
      this.update({ final: true });
    };
    const decompose = (m) => {
      const sx = Math.hypot(m[0], m[1]);
      const rot = Math.atan2(m[1], m[0]);
      const det = m[0] * m[3] - m[1] * m[2];
      const sy = det / sx;
      const skew = Math.atan2(m[0] * m[2] + m[1] * m[3], det);
      return { sx, sy, rot, skew };
    };
    const rebuild = (s, parts) => {
      const b = s.box;
      const c = [b.x + b.width / 2, b.y + b.height / 2];
      const lin = T.matrixFrom({ scale: [parts.sx, parts.sy], skew: [parts.skew, 0], rotate: parts.rot });
      const cur = T.applyMatrix(this.matrix, c[0], c[1]);
      const p = T.applyMatrix(lin, c[0], c[1]);
      const M = [lin[0], lin[1], lin[2], lin[3], cur[0] - p[0], cur[1] - p[1]];
      s.quad = quadFromMatrix(b, M);
    };
    add('x', 'X', 'px', (v) => withMatrix((s, m) => {
      const c = T.applyMatrix(m, s.box.x + s.box.width / 2, s.box.y + s.box.height / 2);
      s.quad = s.quad.map(([x, y]) => [x + v - c[0], y]);
      s.pivot = [s.pivot[0] + v - c[0], s.pivot[1]];
    }));
    add('y', 'Y', 'px', (v) => withMatrix((s, m) => {
      const c = T.applyMatrix(m, s.box.x + s.box.width / 2, s.box.y + s.box.height / 2);
      s.quad = s.quad.map(([x, y]) => [x, y + v - c[1]]);
      s.pivot = [s.pivot[0], s.pivot[1] + v - c[1]];
    }));
    add('w', 'W', '%', (v) => withMatrix((s, m) => rebuild(s, { ...decompose(m), sx: v / 100 })));
    add('h', 'H', '%', (v) => withMatrix((s, m) => rebuild(s, { ...decompose(m), sy: v / 100 })));
    add('angle', '∠', '°', (v) => withMatrix((s, m) => rebuild(s, { ...decompose(m), rot: (v * Math.PI) / 180 })));
    add('skew', 'Skew', '°', (v) => withMatrix((s, m) => rebuild(s, { ...decompose(m), skew: (v * Math.PI) / 180 })));
    this.decompose = decompose;

    const interp = document.createElement('label');
    interp.className = 'opt opt-select';
    interp.innerHTML = '<span class="opt-label">Interpolation</span>';
    const sel = document.createElement('select');
    sel.className = 'select';
    for (const [v, l] of [['bicubic', 'Bicubic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest neighbor']]) sel.add(new Option(l, v));
    sel.value = this.session?.interp ?? this.app.settings.transformInterpolation ?? 'bicubic';
    sel.addEventListener('change', () => {
      this.app.settings.transformInterpolation = sel.value;
      this.app.saveSettingsSoon();
      if (this.session) this.session.interp = sel.value;
    });
    interp.appendChild(sel);
    bar.appendChild(interp);

    const mk = (label, iconName, fn, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small${primary ? ' primary' : ''}`;
      b.innerHTML = `${icon(iconName)}<span>${label}</span>`;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    mk('Cancel', 'close', () => this.cancel());
    mk('Apply', 'check', () => this.commit(), true);
    this.syncBar();
  }

  renderOptions(bar) {
    void bar;
    this.renderBar();
  }

  syncBar() {
    const s = this.session;
    if (!s || !this.fields || !this.decompose) return;
    const m = this.matrix;
    const set = (k, v) => {
      const f = this.fields[k];
      if (f && document.activeElement !== f) f.value = v === null ? '' : String(Math.round(v * 100) / 100);
    };
    if (!m) {
      for (const k of Object.keys(this.fields)) set(k, null);
      return;
    }
    const c = T.applyMatrix(m, s.box.x + s.box.width / 2, s.box.y + s.box.height / 2);
    const p = this.decompose(m);
    set('x', c[0]);
    set('y', c[1]);
    set('w', p.sx * 100);
    set('h', p.sy * 100);
    set('angle', (p.rot * 180) / Math.PI);
    set('skew', (p.skew * 180) / Math.PI);
    this.app.statusbar?.set('hint', `W ${Math.round(p.sx * 100)}%  H ${Math.round(p.sy * 100)}%  ∠ ${Math.round((p.rot * 1800) / Math.PI) / 10}°`);
  }
}

function moveCorners(s, dr, dx, dy) {
  const idx = { nw: [0], n: [0, 1], ne: [1], e: [1, 2], se: [2], s: [2, 3], sw: [3], w: [3, 0] }[dr.handle] ?? [];
  s.quad = dr.quad.map((q, i) => (idx.includes(i) ? [q[0] + dx, q[1] + dy] : q.slice()));
}

function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Bounds of the non-transparent pixels of a raster layer (document coordinates) or null. */
export function contentRect(layer) {
  const c = layer.canvas;
  const b = T.contentBounds ? T.contentBounds(canvasData(c)) : null;
  if (!b) return null;
  return { x: layer.x + b.x, y: layer.y + b.y, width: b.width, height: b.height };
}
