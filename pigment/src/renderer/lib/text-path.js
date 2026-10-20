// Text on a path and stacked vertical text (see ARCHITECTURE.md "Text on a path and stacked
// vertical text"). One textExtensions entry (lib/document.js) takes over layout(), baseBounds() and
// renderBase() of a TextLayer whose `pathText` is set or whose font.orientation is
// 'vertical-stacked'; everything else about text layers (editing session, transform matrix,
// serialisation) is untouched. Layouts answer with `glyphs` ({ ch, x, y, angle, width, index }) so
// the Type tool can hit-test and place its caret without knowing how the glyphs were laid out.
//
// Text on a path: pathText = { path: PathData (document space), startOffset: 0..1, flip, align,
// baselineShift? }. The first subpath with two or more anchors is flattened (lib/tools/vector.js
// flattenSubpath) and sampled by arc length: each glyph sits with its centre on the path, rotated to
// the tangent; `flip` reverses the direction of travel, which puts the text on the other side of the
// path. The layer's x/y are an offset added to the path, so Move and Free Transform keep working.
import { textExtensions, createCanvas, cssFont, measureContext, unionRect } from './document.js';
import { flattenSubpath, clonePath, isEmptyPath, activePathTarget } from './tools/vector.js';
import { setLayerProps } from './layer-ops.js';
import { parseColor, rgbaToHex } from '../../shared/pixels/color.js';
import { multiplyMatrix, invertMatrix } from '../../shared/pixels/transform.js';

export const ORIENTATIONS = ['horizontal', 'vertical', 'vertical-stacked'];

// ---- arc-length sampling ------------------------------------------------------------------------------------------

const usableSubpath = (path) => (path?.subpaths ?? []).find((s) => s?.points?.length >= 2) ?? null;

/**
 * Arc-length sampler over the first usable subpath: { length, closed, at(s) -> { x, y, angle },
 * nearest(x, y) -> { s, d } }. Lines and cubic segments alike go through flattenSubpath (chord
 * tolerance 0.25 px), so tangents come from the polyline; `flip` reverses the direction of travel.
 */
export function samplePath(path, { flip = false, offsetX = 0, offsetY = 0 } = {}) {
  const sp = usableSubpath(path);
  if (!sp) return null;
  let pts = flattenSubpath(sp, 0.25).map(([x, y]) => [x + offsetX, y + offsetY]);
  if (sp.closed && pts.length > 1) pts = [...pts, pts[0]];
  if (flip) pts = pts.slice().reverse();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum[cum.length - 1];
  const closed = !!sp.closed;
  const segmentAt = (s) => {
    let lo = 0, hi = cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    length,
    closed,
    points: pts,
    at(s) {
      if (length <= 0) return { x: pts[0][0], y: pts[0][1], angle: 0 };
      let d = s;
      if (closed) d = ((d % length) + length) % length;
      else d = Math.max(0, Math.min(length, d));
      const i = segmentAt(d);
      const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
      const len = cum[i + 1] - cum[i] || 1;
      const t = Math.max(0, Math.min(1, (d - cum[i]) / len));
      // tangent of the segment; at a vertex of a flattened curve the neighbours are nearly collinear
      let dx = b[0] - a[0], dy = b[1] - a[1];
      if (!dx && !dy && i > 0) {
        dx = a[0] - pts[i - 1][0];
        dy = a[1] - pts[i - 1][1];
      }
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle: Math.atan2(dy, dx) };
    },
    nearest(x, y) {
      let best = { s: 0, d: Infinity };
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
        const px = a[0] + dx * t, py = a[1] + dy * t;
        const d = Math.hypot(px - x, py - y);
        if (d < best.d - 1e-9) best = { s: cum[i] + Math.sqrt(l2) * t, d };
      }
      return best;
    },
  };
}

/** Fraction (0..1) of the path's length at the point of the path nearest to (x, y). */
export function pathOffsetAt(path, x, y) {
  const sampler = samplePath(path);
  if (!sampler || sampler.length <= 0) return 0;
  const f = Math.max(0, Math.min(1, sampler.nearest(x, y).s / sampler.length));
  // on a closed path the seam is both the end and the start: call it the start
  return sampler.closed && f > 1 - 1e-6 ? 0 : f;
}

// samplers are cached per pathText object: setLayerProps replaces the object on every change
const samplers = new WeakMap();
function samplerFor(layer) {
  const pt = layer.pathText;
  const key = `${!!pt.flip}:${layer.x}:${layer.y}`;
  let entry = samplers.get(pt);
  if (!entry || entry.key !== key) {
    entry = { key, sampler: samplePath(pt.path, { flip: !!pt.flip, offsetX: layer.x || 0, offsetY: layer.y || 0 }) };
    samplers.set(pt, entry);
  }
  return entry.sampler;
}

// ---- layouts ------------------------------------------------------------------------------------------------------

const ascentOf = (font) => font.size * 0.8; // TextLayer.layout() puts the first baseline at y + 0.8 × size
const descentOf = (font) => font.size * 0.25;

function glyphCorners(g, font) {
  const asc = ascentOf(font), desc = descentOf(font), hw = g.width / 2;
  const c = Math.cos(g.angle), s = Math.sin(g.angle);
  return [[-hw, -asc], [hw, -asc], [hw, desc], [-hw, desc]].map(([x, y]) => [g.x + x * c - y * s, g.y + x * s + y * c]);
}

function glyphUnion(glyphs, font) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const g of glyphs) {
    if (g.hidden) continue;
    for (const [x, y] of glyphCorners(g, font)) {
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return x1 === Infinity ? null : { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

function layoutOnPath(layer, ctx) {
  const font = layer.font;
  const pt = layer.pathText;
  ctx.font = cssFont(font);
  const sampler = samplerFor(layer);
  const spacing = font.letterSpacing ?? 0;
  const text = layer.text ?? '';
  const chars = [];
  for (let i = 0; i < text.length; i++) chars.push({ ch: text[i], index: i, width: text[i] === '\n' ? 0 : ctx.measureText(text[i]).width });
  const total = chars.reduce((n, c) => n + c.width + spacing, 0) - (chars.length ? spacing : 0);
  let cursor = (pt.startOffset ?? 0) * sampler.length;
  // the live alignment (Character panel, options bar) wins; pathText.align is what it was when attached
  const align = font.align ?? pt.align ?? 'left';
  const s0 = (pt.startOffset ?? 0) * sampler.length - (align === 'center' ? total / 2 : align === 'right' ? total : 0);
  if (align === 'center') cursor -= total / 2;
  else if (align === 'right') cursor -= total;
  const shift = pt.baselineShift ?? 0;
  const glyphs = chars.map((c) => {
    const mid = cursor + c.width / 2;
    const p = sampler.at(mid);
    cursor += c.width + spacing;
    // the baseline offset moves the glyph along the normal (local "up" is (sin θ, −cos θ))
    const x = p.x + Math.sin(p.angle) * shift, y = p.y - Math.cos(p.angle) * shift;
    // text longer than the path is hidden at its end; on a closed path it must not wrap round over its own start
    // (on a closed path the glyph's far edge counts, so the last visible glyph never overlaps the first)
    const hidden = c.ch === '\n' || (sampler.closed ? mid + c.width / 2 - s0 > sampler.length + 1e-6 : mid < 0 || mid > sampler.length);
    return { ch: c.ch, x, y, angle: p.angle, width: c.width, index: c.index, hidden };
  });
  const start = sampler.at((pt.startOffset ?? 0) * sampler.length);
  const box = glyphUnion(glyphs, font) ?? { x: start.x, y: start.y - ascentOf(font), width: Math.max(2, font.size / 2), height: font.size };
  return {
    lines: [{ text: text.replace(/\n/g, ' '), width: total }],
    lineHeight: font.size * (font.lineHeight ?? 1.2),
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
    ascent: ascentOf(font),
    glyphs,
    box,
    anchor: { x: start.x, y: start.y, angle: start.angle },
  };
}

function layoutStacked(layer, ctx) {
  const font = layer.font;
  ctx.font = cssFont(font);
  const size = font.size;
  const pitch = size * (font.lineHeight ?? 1.2); // column pitch: leading runs sideways
  const advance = size + (font.letterSpacing ?? 0); // glyphs stack one em apart (+ tracking)
  const paras = (layer.text ?? '').split('\n');
  const counts = paras.map((p) => [...p].length);
  const height = Math.max(1, ...counts) * advance;
  const glyphs = [];
  let index = 0;
  paras.forEach((para, li) => {
    // the first line is the rightmost column; align places the column's glyphs top / middle / bottom
    const colX = layer.x + (paras.length - 1 - li) * pitch + pitch / 2;
    const free = height - counts[li] * advance;
    const top = font.align === 'center' ? free / 2 : font.align === 'right' ? free : 0;
    let k = 0;
    for (const ch of para) {
      glyphs.push({ ch, x: colX, y: layer.y + top + ascentOf(font) + k * advance, angle: 0, width: ctx.measureText(ch).width, index });
      index += ch.length;
      k++;
    }
    index += 1; // the newline
  });
  const width = paras.length * pitch;
  return {
    lines: paras.map((p) => ({ text: p, width: pitch })),
    lineHeight: pitch,
    width: Math.ceil(width),
    height: Math.ceil(height),
    ascent: ascentOf(font),
    glyphs,
    box: { x: layer.x, y: layer.y, width, height },
  };
}

function paintGlyph(ctx, ch, x, y, font) {
  const stroke = font.stroke;
  if (stroke && stroke.width > 0) {
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color ?? '#000';
    ctx.lineJoin = 'round';
    ctx.strokeText(ch, x, y);
  }
  ctx.fillText(ch, x, y);
  if (font.underline) ctx.fillRect(x, y + font.size * 0.12, ctx.measureText(ch).width, Math.max(1, font.size / 16));
}

const isPathText = (layer) => !!layer.pathText && !!usableSubpath(layer.pathText.path);

export const textPathExtension = {
  test: (layer) => layer.type === 'text' && (isPathText(layer) || layer.font?.orientation === 'vertical-stacked'),
  layout(layer, ctx = measureContext()) {
    return isPathText(layer) ? layoutOnPath(layer, ctx) : layoutStacked(layer, ctx);
  },
  baseBounds(layer) {
    const l = this.layout(layer);
    const pad = Math.ceil(layer.font.size * 0.3) + (layer.font.stroke?.width ?? 0);
    return { x: Math.floor(l.box.x - pad), y: Math.floor(l.box.y - pad), width: Math.ceil(l.box.width + pad * 2), height: Math.ceil(l.box.height + pad * 2) };
  },
  renderBase(layer) {
    const l = this.layout(layer);
    const b = this.baseBounds(layer);
    const canvas = createCanvas(b.width, b.height);
    const ctx = canvas.getContext('2d');
    ctx.font = cssFont(layer.font);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgbaToHex(parseColor(layer.font.color), true);
    for (const g of l.glyphs) {
      if (g.hidden || !g.ch.trim()) continue;
      ctx.save();
      ctx.translate(g.x - b.x, g.y - b.y);
      if (g.angle) ctx.rotate(g.angle);
      paintGlyph(ctx, g.ch, -g.width / 2, 0, layer.font);
      ctx.restore();
    }
    return { canvas, x: b.x, y: b.y };
  },
};

// ---- commands -----------------------------------------------------------------------------------------------------

/** The path a text layer should follow: the Paths panel's choice, a selected shape layer, the work path, a saved path, the top shape. */
export function pathForText(app, textLayer) {
  const doc = app.doc;
  if (!doc) return null;
  const ap = app.ui?.activePath;
  if (ap && ap.doc === doc.id) {
    if (ap.kind === 'shape') {
      const l = doc.find(ap.layerId);
      if (l?.type === 'shape' && !isEmptyPath(l.path)) return { path: l.path, label: l.name };
    } else {
      const t = activePathTarget(app);
      if (t && !isEmptyPath(t.get())) return { path: t.get(), label: t.label };
    }
  }
  const shape = doc.selectedLayers().find((l) => l.type === 'shape' && l !== textLayer && !isEmptyPath(l.path));
  if (shape) return { path: shape.path, label: shape.name };
  if (doc.workPath && !isEmptyPath(doc.workPath)) return { path: doc.workPath, label: 'Work Path' };
  const saved = doc.paths.find((p) => !isEmptyPath(p.path));
  if (saved) return { path: saved.path, label: saved.name };
  const top = doc.layers().slice().reverse().find((l) => l.type === 'shape' && l.visible && !isEmptyPath(l.path));
  return top ? { path: top.path, label: top.name } : null;
}

/** Rotation the Vertical Type tool applies: 90° clockwise about the layer's origin. */
const verticalRotation = (layer) => [0, 1, -1, 0, layer.x + layer.y, layer.y - layer.x];
const isIdentity = (m) => m.every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-9);

/** Switches a text layer between horizontal, vertical (rotated) and vertical-stacked, undoably. */
export function setOrientation(app, layer, next) {
  if (!ORIENTATIONS.includes(next)) return false;
  const current = layer.font.orientation ?? 'horizontal';
  if (current === next) return false;
  // text on a path follows the path: rotating it about the document origin would throw it off the canvas
  if (layer.pathText && next !== 'horizontal') {
    app.dialogs?.toast('Text on a path is always horizontal; release it from the path (Layer › Type) to make it vertical', { kind: 'error', timeout: 3200 });
    return false;
  }
  let transform = layer.transform ? layer.transform.slice() : null;
  const R = verticalRotation(layer);
  if (current === 'vertical') transform = multiplyMatrix(transform ?? [1, 0, 0, 1, 0, 0], invertMatrix(R));
  if (next === 'vertical') transform = multiplyMatrix(transform ?? [1, 0, 0, 1, 0, 0], R);
  if (transform && isIdentity(transform)) transform = null;
  const font = { ...layer.font };
  if (next === 'horizontal') delete font.orientation;
  else font.orientation = next;
  setLayerProps(app, layer, { font, transform }, 'Text Orientation');
  return true;
}

export function install(app) {
  if (!textExtensions.includes(textPathExtension)) textExtensions.push(textPathExtension);

  const activeText = () => (app.doc?.active?.type === 'text' && !app.doc.active.locked.all ? app.doc.active : null);
  const onPath = () => !!activeText()?.pathText;
  const toast = (msg) => app.dialogs.toast(msg, { kind: 'error', timeout: 2200 });

  app.commands.registerAll({
    'text:on-path': {
      label: 'Text on Path',
      enabled: () => !!activeText(),
      run: () => {
        const layer = activeText();
        if (!layer) return toast('Select a text layer first');
        const found = pathForText(app, layer);
        if (!found) return toast('Draw a shape or a path first, then choose Text on Path');
        if (!usableSubpath(found.path)) return toast('The path needs at least two anchor points');
        const keep = layer.pathText ?? {};
        app.doc.history.group('Text on Path', () => {
          // rotated (vertical) text would rotate the whole path layout: it goes back to horizontal first
          if ((layer.font.orientation ?? 'horizontal') === 'vertical') setOrientation(app, layer, 'horizontal');
          // the path is stored in document space; x/y become the (zero) offset Move adds to it
          // a Free Transform matrix of the text would move the path layout off the path: the glyphs follow the path
          // alone, and the matrix's scale is folded into the type so scaled text keeps its size
          const t = layer.transform;
          const k = t ? Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) : 1;
          const r2 = (v) => Math.round(v * 100) / 100;
          const font = Math.abs(k - 1) > 1e-6 ? { ...layer.font, size: r2(layer.font.size * k), letterSpacing: r2((layer.font.letterSpacing ?? 0) * k), ...(layer.font.stroke ? { stroke: { ...layer.font.stroke, width: r2(layer.font.stroke.width * k) } } : {}) } : null;
          setLayerProps(app, layer, { pathText: { path: clonePath(found.path), startOffset: keep.startOffset ?? 0, flip: !!keep.flip, align: keep.align ?? layer.font.align ?? 'left' }, x: 0, y: 0, transform: null, ...(font ? { font } : {}) }, 'Text on Path');
        });
        return true;
      },
    },
    'text:release-path': {
      label: 'Release from Path',
      enabled: onPath,
      run: () => {
        const layer = activeText();
        if (!layer?.pathText) return toast('The text layer is not on a path');
        // the text stays where it was: its box starts at the glyphs' top-left corner
        const pad = Math.ceil(layer.font.size * 0.3);
        const b = layer.baseBounds();
        setLayerProps(app, layer, { pathText: null, x: Math.round((b.x + pad) * 100) / 100, y: Math.round((b.y + pad) * 100) / 100, width: null }, 'Release from Path');
        return true;
      },
    },
    'text:flip-path': {
      label: 'Flip Text on Path',
      enabled: onPath,
      run: () => {
        const layer = activeText();
        if (!layer?.pathText) return toast('The text layer is not on a path');
        // the anchor stays on the same point of the path: offsets run along the (reversed) direction of travel
        const pt = layer.pathText;
        setLayerProps(app, layer, { pathText: { ...pt, flip: !pt.flip, startOffset: Math.round((1 - (pt.startOffset ?? 0)) * 1000) / 1000 } }, 'Flip Text on Path');
        return true;
      },
    },
    'text:orientation': {
      label: 'Text Orientation',
      enabled: () => !!activeText(),
      run: (arg) => {
        const layer = activeText();
        if (!layer) return toast('Select a text layer first');
        const next = ORIENTATIONS.includes(arg) ? arg : 'horizontal';
        // the whole selection of text layers follows, as one entry
        const targets = app.doc.selectedLayers().filter((l) => l.type === 'text' && !l.locked.all);
        const list = targets.length ? targets : [layer];
        const apply = () => {
          for (const l of list) setOrientation(app, l, next);
        };
        if (list.length > 1) app.doc.history.group('Text Orientation', apply);
        else apply();
        // a refused switch (text on a path) must still put the native menu's radio back: force a resend
        if (app.uiState) app.uiState = { ...app.uiState, textOrientation: undefined };
        app.syncUiState();
        return true;
      },
    },
  });
}

