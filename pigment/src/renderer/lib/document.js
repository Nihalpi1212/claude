// Document and layer model (see ARCHITECTURE.md "Documents, layers, selection"). Layers hold
// pixels (raster) or parameters (text, shape, fill, adjustment); every mutation bumps `version`
// so the compositor can cache. Mutations happen through lib/history.js so they are undoable.
import { parseColor, rgbaToHex } from '../../shared/pixels/color.js';

export const BLEND_MODES = [
  ['normal', 'Normal'], ['dissolve', 'Dissolve'], null,
  ['darken', 'Darken'], ['multiply', 'Multiply'], ['color-burn', 'Color Burn'], ['linear-burn', 'Linear Burn'], ['darker-color', 'Darker Color'], null,
  ['lighten', 'Lighten'], ['screen', 'Screen'], ['color-dodge', 'Color Dodge'], ['linear-dodge', 'Linear Dodge (Add)'], ['lighter-color', 'Lighter Color'], null,
  ['overlay', 'Overlay'], ['soft-light', 'Soft Light'], ['hard-light', 'Hard Light'], ['vivid-light', 'Vivid Light'], ['linear-light', 'Linear Light'], ['pin-light', 'Pin Light'], ['hard-mix', 'Hard Mix'], null,
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'], ['divide', 'Divide'], null,
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];
export const BLEND_LABELS = Object.fromEntries(BLEND_MODES.filter(Boolean));
BLEND_LABELS['pass-through'] = 'Pass Through';

let nextId = 1;
export const newId = (prefix = 'L') => `${prefix}${(nextId++).toString(36)}${Date.now().toString(36).slice(-3)}`;

export function createCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function copyCanvas(src, width = src.width, height = src.height) {
  const c = createCanvas(width, height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function canvasIsBlank(canvas) {
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}

// ---- layers ---------------------------------------------------------------------------------------------------

export class Layer {
  constructor(type, props = {}) {
    this.id = props.id ?? newId();
    this.type = type;
    this.name = props.name ?? 'Layer';
    this.visible = props.visible ?? true;
    this.opacity = props.opacity ?? 1;
    this.fillOpacity = props.fillOpacity ?? 1;
    this.blend = props.blend ?? 'normal';
    this.locked = { pixels: false, position: false, transparency: false, all: false, ...(props.locked ?? {}) };
    this.clip = props.clip ?? false;
    this.mask = props.mask ?? null; // { canvas, enabled, linked }
    this.styles = props.styles ?? null;
    this.parent = null;
    this.version = 0;
    this.collapsedStyles = false;
  }
  get isGroup() {
    return this.type === 'group';
  }
  get isLocked() {
    return this.locked.all;
  }
  /** Bumps the version of this layer and every ancestor (the compositor caches on it). */
  touch() {
    this.version++;
    for (let p = this.parent; p; p = p.parent) p.version++;
  }
  /** Axis-aligned bounds in document space of what this layer draws (null for adjustment layers). */
  bounds() {
    return null;
  }
  /** Shallow description for the Layers panel and serialization (pixels handled by io.js). */
  describe() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      visible: this.visible,
      opacity: this.opacity,
      fillOpacity: this.fillOpacity,
      blend: this.blend,
      locked: { ...this.locked },
      clip: this.clip,
      hasMask: !!this.mask,
      maskEnabled: this.mask?.enabled ?? false,
      maskLinked: this.mask?.linked ?? true,
      styles: this.styles ? JSON.parse(JSON.stringify(this.styles)) : null,
    };
  }
}

export class RasterLayer extends Layer {
  constructor(props = {}) {
    super('raster', props);
    this.x = props.x ?? 0;
    this.y = props.y ?? 0;
    this.canvas = props.canvas ?? createCanvas(props.width ?? 1, props.height ?? 1);
  }
  get width() {
    return this.canvas.width;
  }
  get height() {
    return this.canvas.height;
  }
  bounds() {
    return { x: this.x, y: this.y, width: this.canvas.width, height: this.canvas.height };
  }
  get ctx() {
    return this.canvas.getContext('2d', { willReadFrequently: true });
  }
  /** Grows the layer canvas so it covers rect (document coordinates); existing pixels are kept in place. */
  ensureCovers(rect) {
    const b = this.bounds();
    const x1 = Math.min(b.x, Math.floor(rect.x)), y1 = Math.min(b.y, Math.floor(rect.y));
    const x2 = Math.max(b.x + b.width, Math.ceil(rect.x + rect.width)), y2 = Math.max(b.y + b.height, Math.ceil(rect.y + rect.height));
    if (x1 === b.x && y1 === b.y && x2 === b.x + b.width && y2 === b.y + b.height) return false;
    const c = createCanvas(x2 - x1, y2 - y1);
    c.getContext('2d').drawImage(this.canvas, b.x - x1, b.y - y1);
    this.canvas = c;
    this.x = x1;
    this.y = y1;
    return true;
  }
}

export class GroupLayer extends Layer {
  constructor(props = {}) {
    super('group', { blend: 'pass-through', name: 'Group', ...props });
    this.children = [];
    this.expanded = props.expanded ?? true;
  }
  bounds() {
    let b = null;
    for (const c of this.children) {
      const cb = c.bounds();
      if (!cb) continue;
      b = b ? unionRect(b, cb) : { ...cb };
    }
    return b;
  }
}

export const DEFAULT_TEXT_STYLE = { family: 'Arial', size: 48, weight: 400, italic: false, underline: false, color: '#000000', align: 'left', lineHeight: 1.2, letterSpacing: 0, stroke: null };

export class TextLayer extends Layer {
  constructor(props = {}) {
    super('text', { name: props.text?.split('\n')[0]?.slice(0, 30) || 'Text', ...props });
    this.x = props.x ?? 0;
    this.y = props.y ?? 0;
    this.width = props.width ?? null; // null: point text (grows), number: paragraph box
    this.text = props.text ?? '';
    this.font = { ...DEFAULT_TEXT_STYLE, ...(props.font ?? {}) };
    this.rotation = props.rotation ?? 0;
    this._cache = null;
  }
  /** Lines after wrapping, with their measured widths. */
  layout(ctx = measureContext()) {
    ctx.font = cssFont(this.font);
    const lineHeight = this.font.size * this.font.lineHeight;
    const words = this.text.split('\n');
    const lines = [];
    const spacing = this.font.letterSpacing;
    const widthOf = (s) => ctx.measureText(s).width + Math.max(0, s.length - 1) * spacing;
    for (const para of words) {
      if (this.width === null || !para) {
        lines.push({ text: para, width: widthOf(para) });
        continue;
      }
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (widthOf(next) <= this.width || !line) line = next;
        else {
          lines.push({ text: line, width: widthOf(line) });
          line = word;
        }
      }
      lines.push({ text: line, width: widthOf(line) });
    }
    const width = this.width ?? Math.max(1, ...lines.map((l) => l.width));
    return { lines, lineHeight, width: Math.ceil(width), height: Math.ceil(lines.length * lineHeight), ascent: this.font.size * 0.8 };
  }
  bounds() {
    const l = this.layout();
    const pad = Math.ceil(this.font.size * 0.3) + (this.font.stroke?.width ?? 0);
    return { x: this.x - pad, y: this.y - pad, width: l.width + pad * 2, height: l.height + pad * 2 };
  }
  render() {
    if (this._cache && this._cache.version === this.version) return this._cache;
    const l = this.layout();
    const b = this.bounds();
    const canvas = createCanvas(b.width, b.height);
    const ctx = canvas.getContext('2d');
    ctx.font = cssFont(this.font);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgbaToHex(parseColor(this.font.color), true);
    const ox = this.x - b.x, oy = this.y - b.y;
    l.lines.forEach((line, i) => {
      let x = ox;
      if (this.font.align === 'center') x = ox + (l.width - line.width) / 2;
      else if (this.font.align === 'right') x = ox + l.width - line.width;
      const y = oy + l.ascent + i * l.lineHeight;
      drawSpaced(ctx, line.text, x, y, this.font.letterSpacing, this.font.stroke);
      if (this.font.underline) {
        ctx.fillRect(x, y + this.font.size * 0.12, line.width, Math.max(1, this.font.size / 16));
      }
    });
    this._cache = { version: this.version, canvas, x: b.x, y: b.y };
    return this._cache;
  }
}

function drawSpaced(ctx, text, x, y, spacing, stroke) {
  const paint = (t, px) => {
    if (stroke && stroke.width > 0) {
      ctx.lineWidth = stroke.width;
      ctx.strokeStyle = stroke.color ?? '#000';
      ctx.lineJoin = 'round';
      ctx.strokeText(t, px, y);
    }
    ctx.fillText(t, px, y);
  };
  if (!spacing) return paint(text, x);
  let cx = x;
  for (const ch of text) {
    paint(ch, cx);
    cx += ctx.measureText(ch).width + spacing;
  }
}

let _measure = null;
export function measureContext() {
  if (!_measure) _measure = createCanvas(1, 1).getContext('2d');
  return _measure;
}

export function cssFont(font) {
  return `${font.italic ? 'italic ' : ''}${font.weight ?? 400} ${font.size}px ${quoteFamily(font.family)}`;
}
const quoteFamily = (f) => (/[\s'"]/.test(f) && !/^["']/.test(f) ? `"${f}"` : f);

/** Vector path data: subpaths of anchor points with cubic handles (absolute coordinates). */
export function emptyPath() {
  return { subpaths: [] };
}

export function pathToPath2D(path, offsetX = 0, offsetY = 0) {
  const p = new Path2D();
  for (const sp of path.subpaths ?? []) {
    const pts = sp.points;
    if (!pts?.length) continue;
    p.moveTo(pts[0].x + offsetX, pts[0].y + offsetY);
    for (let i = 1; i <= pts.length - (sp.closed ? 0 : 1); i++) {
      const a = pts[i - 1], b = pts[i % pts.length];
      if (a.outX === undefined && b.inX === undefined) p.lineTo(b.x + offsetX, b.y + offsetY);
      else p.bezierCurveTo((a.outX ?? a.x) + offsetX, (a.outY ?? a.y) + offsetY, (b.inX ?? b.x) + offsetX, (b.inY ?? b.y) + offsetY, b.x + offsetX, b.y + offsetY);
    }
    if (sp.closed) p.closePath();
  }
  return p;
}

export function pathBounds(path) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const sp of path.subpaths ?? []) {
    for (const pt of sp.points) {
      for (const [x, y] of [[pt.x, pt.y], [pt.inX ?? pt.x, pt.inY ?? pt.y], [pt.outX ?? pt.x, pt.outY ?? pt.y]]) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return x1 === Infinity ? null : { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

export function makePaint(ctx, paint, rect) {
  if (!paint) return 'transparent';
  if (paint.type === 'solid') return rgbaToHex(parseColor(paint.color), true);
  if (paint.type === 'gradient') return makeGradient(ctx, paint.gradient, rect);
  if (paint.type === 'pattern' && paint.pattern?.canvas) {
    const p = ctx.createPattern(paint.pattern.canvas, 'repeat');
    if (p && paint.pattern.scale && paint.pattern.scale !== 1) p.setTransform(new DOMMatrix().scale(paint.pattern.scale));
    return p ?? 'transparent';
  }
  return 'transparent';
}

/** Builds a canvas gradient; `from`/`to` are in the same space as rect (absolute), defaulting to rect's left->right. */
export function makeGradient(ctx, g, rect) {
  const from = g.from ?? [rect.x, rect.y + rect.height / 2];
  const to = g.to ?? [rect.x + rect.width, rect.y + rect.height / 2];
  let grad;
  const kind = g.kind ?? 'linear';
  if (kind === 'radial' || kind === 'diamond') {
    const r = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    grad = ctx.createRadialGradient(from[0], from[1], 0, from[0], from[1], r);
  } else if (kind === 'angle') {
    grad = ctx.createConicGradient(Math.atan2(to[1] - from[1], to[0] - from[0]), from[0], from[1]);
  } else if (kind === 'reflected') {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    grad = ctx.createLinearGradient(from[0] - dx, from[1] - dy, to[0], to[1]);
  } else grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
  const stops = (g.stops?.length ? g.stops : [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]).slice().sort((a, b) => a.pos - b.pos);
  const list = g.reverse ? stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).sort((a, b) => a.pos - b.pos) : stops;
  if (kind === 'reflected') {
    // mirror the stops around the middle
    const half = list.map((s) => ({ pos: 0.5 + s.pos / 2, color: s.color }));
    const mirrored = list.map((s) => ({ pos: 0.5 - s.pos / 2, color: s.color }));
    for (const s of [...mirrored, ...half].sort((a, b) => a.pos - b.pos)) grad.addColorStop(Math.min(1, Math.max(0, s.pos)), rgbaToHex(parseColor(s.color), true));
  } else for (const s of list) grad.addColorStop(Math.min(1, Math.max(0, s.pos)), rgbaToHex(parseColor(s.color), true));
  return grad;
}

export class ShapeLayer extends Layer {
  constructor(props = {}) {
    super('shape', { name: props.name ?? 'Shape', ...props });
    this.path = props.path ?? emptyPath();
    this.fill = props.fill ?? { type: 'solid', color: '#4f81ff' };
    this.stroke = props.stroke ?? null; // { color|paint, width, align: 'center'|'inside'|'outside', dash: [] }
    this.shapeKind = props.shapeKind ?? 'path'; // rect | ellipse | polygon | line | path (for the properties panel)
    this.shapeProps = props.shapeProps ?? {};
    this._cache = null;
  }
  bounds() {
    const b = pathBounds(this.path);
    if (!b) return null;
    const pad = Math.ceil((this.stroke?.width ?? 0) + 1);
    return { x: Math.floor(b.x) - pad, y: Math.floor(b.y) - pad, width: Math.ceil(b.width) + pad * 2 + 1, height: Math.ceil(b.height) + pad * 2 + 1 };
  }
  render() {
    if (this._cache && this._cache.version === this.version) return this._cache;
    const b = this.bounds() ?? { x: 0, y: 0, width: 1, height: 1 };
    const canvas = createCanvas(b.width, b.height);
    const ctx = canvas.getContext('2d');
    const p = pathToPath2D(this.path, -b.x, -b.y);
    const rect = { x: 0, y: 0, width: b.width, height: b.height };
    if (this.fill) {
      ctx.fillStyle = makePaint(ctx, this.fill, rect);
      ctx.fill(p, 'nonzero');
    }
    if (this.stroke && this.stroke.width > 0) {
      ctx.lineWidth = this.stroke.width * (this.stroke.align === 'center' || !this.stroke.align ? 1 : 2);
      ctx.strokeStyle = makePaint(ctx, this.stroke.paint ?? { type: 'solid', color: this.stroke.color ?? '#000' }, rect);
      ctx.lineJoin = this.stroke.join ?? 'miter';
      ctx.lineCap = this.stroke.cap ?? 'butt';
      ctx.setLineDash(this.stroke.dash ?? []);
      if (this.stroke.align === 'inside') {
        ctx.save();
        ctx.clip(p);
        ctx.stroke(p);
        ctx.restore();
      } else if (this.stroke.align === 'outside') {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.stroke(p);
        ctx.restore();
        // keep fill on top: redraw fill
        if (this.fill) {
          ctx.fillStyle = makePaint(ctx, this.fill, rect);
          ctx.fill(p, 'nonzero');
        }
      } else ctx.stroke(p);
    }
    this._cache = { version: this.version, canvas, x: b.x, y: b.y };
    return this._cache;
  }
}

export class FillLayer extends Layer {
  constructor(props = {}) {
    super('fill', { name: props.name ?? 'Fill', ...props });
    this.paint = props.paint ?? { type: 'solid', color: '#808080' };
    this._cache = null;
    this.docWidth = props.docWidth ?? 1;
    this.docHeight = props.docHeight ?? 1;
  }
  bounds() {
    return { x: 0, y: 0, width: this.docWidth, height: this.docHeight };
  }
  render() {
    if (this._cache && this._cache.version === this.version && this._cache.canvas.width === this.docWidth && this._cache.canvas.height === this.docHeight) return this._cache;
    const canvas = createCanvas(this.docWidth, this.docHeight);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = makePaint(ctx, this.paint, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this._cache = { version: this.version, canvas, x: 0, y: 0 };
    return this._cache;
  }
}

export class AdjustmentLayer extends Layer {
  constructor(props = {}) {
    super('adjustment', { name: props.name ?? 'Adjustment', ...props });
    this.kind = props.kind ?? 'levels';
    this.params = props.params ?? {};
  }
  bounds() {
    return null;
  }
}

export function layerFromDescription(d) {
  switch (d.type) {
    case 'group': return new GroupLayer(d);
    case 'text': return new TextLayer(d);
    case 'shape': return new ShapeLayer(d);
    case 'fill': return new FillLayer(d);
    case 'adjustment': return new AdjustmentLayer(d);
    default: return new RasterLayer(d);
  }
}

export function unionRect(a, b) {
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width), y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function intersectRect(a, b) {
  if (!a || !b) return null;
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

// ---- document --------------------------------------------------------------------------------------------------

export class Document {
  /**
   * @param {{ width: number, height: number, dpi?: number, name?: string, path?: string|null }} opts
   */
  constructor(opts) {
    this.id = newId('D');
    this.width = Math.max(1, Math.round(opts.width));
    this.height = Math.max(1, Math.round(opts.height));
    this.dpi = opts.dpi ?? 72;
    this.name = opts.name ?? 'Untitled';
    this.path = opts.path ?? null;
    this.format = opts.format ?? null; // 'pigment' | 'psd' | 'png' ... (what the path holds)
    this.root = new GroupLayer({ name: 'Root', id: 'root' });
    this.active = null;
    this.selected = new Set();
    this.selection = null; // Selection (lib/selection.js)
    this.savedSelection = null;
    this.guides = [];
    this.channels = []; // saved alpha channels { id, name, mask: Uint8ClampedArray }
    this.paths = []; // saved vector paths { id, name, path }
    this.history = null; // set by lib/history.js
    this.version = 0;
    this.listeners = new Set();
    this.meta = {}; // author, description, exif copied on import
    this.thumbnail = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Notifies listeners: kind = 'pixels'|'tree'|'props'|'selection'|'guides'|'canvas'|'active'. */
  changed(kind, detail = {}) {
    this.version++;
    for (const fn of this.listeners) fn({ kind, doc: this, ...detail });
  }

  get bounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  /** Flattened layers bottom -> top (groups included before their children). */
  layers(root = this.root, out = []) {
    for (const l of root.children) {
      out.push(l);
      if (l.isGroup) this.layers(l, out);
    }
    return out;
  }

  find(id) {
    return this.layers().find((l) => l.id === id) ?? (id === 'root' ? this.root : null);
  }

  indexOf(layer) {
    return layer.parent ? layer.parent.children.indexOf(layer) : -1;
  }

  /** Inserts layer into parent at index (default: above the active layer, or on top). */
  add(layer, parent = null, index = null) {
    let p = parent;
    let i = index;
    if (!p) {
      if (this.active?.isGroup && this.active !== this.root && index === null) {
        p = this.active;
        i = p.children.length;
      } else if (this.active && this.active.parent) {
        p = this.active.parent;
        i = p.children.indexOf(this.active) + 1;
      } else {
        p = this.root;
        i = p.children.length;
      }
    }
    if (i === null || i > p.children.length) i = p.children.length;
    p.children.splice(i, 0, layer);
    layer.parent = p;
    if (layer.type === 'fill') {
      layer.docWidth = this.width;
      layer.docHeight = this.height;
    }
    layer.touch();
    this.changed('tree', { layer });
    return layer;
  }

  remove(layer) {
    const p = layer.parent;
    if (!p) return -1;
    const i = p.children.indexOf(layer);
    p.children.splice(i, 1);
    layer.parent = null;
    p.touch();
    this.selected.delete(layer);
    if (this.active === layer) this.setActive(p.children[Math.min(i, p.children.length - 1)] ?? (p === this.root ? null : p));
    this.changed('tree', { layer });
    return i;
  }

  move(layer, parent, index) {
    const from = layer.parent;
    if (!from) return;
    const fromIndex = from.children.indexOf(layer);
    from.children.splice(fromIndex, 1);
    from.touch();
    let i = index;
    if (from === parent && fromIndex < index) i = index - 1;
    parent.children.splice(Math.min(i, parent.children.length), 0, layer);
    layer.parent = parent;
    layer.touch();
    this.changed('tree', { layer });
  }

  setActive(layer, { additive = false } = {}) {
    if (!additive) this.selected.clear();
    this.active = layer;
    if (layer) this.selected.add(layer);
    this.changed('active', { layer });
  }

  /** Layers selected in the panel, top -> bottom order of the tree. */
  selectedLayers() {
    const order = this.layers();
    return order.filter((l) => this.selected.has(l)).reverse();
  }

  /** Position of a layer in the flattened list (0 = bottom). */
  depth(layer) {
    let d = 0;
    for (let p = layer.parent; p && p !== this.root; p = p.parent) d++;
    return d;
  }

  /** Replaces the whole layer tree (used by image/canvas size, flatten) keeping ids where possible. */
  replaceTree(root, { width, height } = {}) {
    this.root = root;
    if (width) this.width = width;
    if (height) this.height = height;
    for (const l of this.layers()) if (l.type === 'fill') {
      l.docWidth = this.width;
      l.docHeight = this.height;
      l.touch();
    }
    const act = this.active ? this.find(this.active.id) : null;
    this.active = act ?? this.root.children[this.root.children.length - 1] ?? null;
    this.selected = new Set(this.active ? [this.active] : []);
    this.root.touch();
    this.changed('canvas');
  }

  /** Non-transparent pixel bounds of the whole document (null when empty). */
  contentBounds(layers = this.layers().filter((l) => l.visible && !l.isGroup)) {
    let b = null;
    for (const l of layers) {
      const lb = l.bounds();
      if (!lb) continue;
      b = b ? unionRect(b, lb) : { ...lb };
    }
    return b ? intersectRect(b, this.bounds) : null;
  }

  /** Serialisable description of the tree (no pixels). */
  describe() {
    const walk = (layer) => {
      const d = layer.describe();
      if (layer.type === 'raster') Object.assign(d, { x: layer.x, y: layer.y, width: layer.canvas.width, height: layer.canvas.height });
      if (layer.type === 'group') Object.assign(d, { expanded: layer.expanded, children: layer.children.map(walk) });
      if (layer.type === 'text') Object.assign(d, { x: layer.x, y: layer.y, width: layer.width, text: layer.text, font: { ...layer.font }, rotation: layer.rotation });
      if (layer.type === 'shape') Object.assign(d, { path: JSON.parse(JSON.stringify(layer.path)), fill: layer.fill, stroke: layer.stroke, shapeKind: layer.shapeKind, shapeProps: layer.shapeProps });
      if (layer.type === 'fill') Object.assign(d, { paint: JSON.parse(JSON.stringify({ ...layer.paint, pattern: layer.paint.pattern ? { scale: layer.paint.pattern.scale } : undefined })) });
      if (layer.type === 'adjustment') Object.assign(d, { kind: layer.kind, params: JSON.parse(JSON.stringify(layer.params)) });
      return d;
    };
    return {
      version: 1,
      app: 'pigment',
      width: this.width,
      height: this.height,
      dpi: this.dpi,
      name: this.name,
      active: this.active?.id ?? null,
      guides: this.guides.map((g) => ({ ...g })),
      channels: this.channels.map((c) => ({ id: c.id, name: c.name })),
      paths: this.paths.map((p) => ({ id: p.id, name: p.name, path: p.path })),
      meta: this.meta,
      layers: this.root.children.map(walk),
    };
  }
}

/** Creates a new document with a background layer filled with `background` ('white'|'transparent'|'background'|hex). */
export function createDocument({ width, height, dpi = 72, name = 'Untitled', background = 'white', backgroundColor = '#ffffff' }) {
  const doc = new Document({ width, height, dpi, name });
  const layer = new RasterLayer({ name: 'Background', width, height });
  if (background !== 'transparent') {
    const ctx = layer.canvas.getContext('2d');
    ctx.fillStyle = background === 'white' ? '#ffffff' : background === 'black' ? '#000000' : backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }
  layer.name = background === 'transparent' ? 'Layer 1' : 'Background';
  doc.root.children.push(layer);
  layer.parent = doc.root;
  doc.active = layer;
  doc.selected.add(layer);
  return doc;
}
