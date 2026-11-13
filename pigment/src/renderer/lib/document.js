// Document and layer model (see ARCHITECTURE.md "Documents, layers, selection"). Layers hold
// pixels (raster) or parameters (text, shape, fill, adjustment); every mutation bumps `version`
// so the compositor can cache. Mutations happen through lib/history.js so they are undoable.
import { transformBounds } from '../../shared/pixels/transform.js';
import { renderShapeLayer, shapeBounds } from './path-ops.js';
import { paintStyle } from './paint.js';
import { DocStore } from './doc-store.js';
import { fromLegacy, legacyFont, plainText, replacePlain, normalize, normalizeTypeOptions, mapChar, mapPara, tidyNumber } from './type/model.js';

// ---- extension points (see ARCHITECTURE.md "0.2 features") -------------------------------------------------
/**
 * Layer classes registered by feature modules (smart objects): type -> { cls, describe?(layer) -> extra
 * serialisable props }. layerFromDescription() and Document.describe() consult it before the built-ins.
 */
export const LAYER_TYPES = new Map();
export function registerLayerType(type, cls, { describe = null } = {}) {
  LAYER_TYPES.set(type, { cls, describe });
}
/**
 * Text layout/render extensions (text on a path, stacked vertical text): the first entry whose test(layer)
 * is true takes over layout(layer, ctx) -> { lines, lineHeight, width, height, ascent, glyphs? },
 * baseBounds(layer) -> Rect and renderBase(layer) -> { canvas, x, y }; everything else in TextLayer stays.
 */
export const textExtensions = [];
export const textExtensionFor = (layer) => textExtensions.find((e) => e.test(layer)) ?? null;

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
  // document canvases are read back often (history, filters, picking): keep them in memory
  c.getContext('2d', { willReadFrequently: true });
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

// ---- 0.4 layer fields: vector masks and advanced blending (ARCHITECTURE.md "0.4 features", J.1) -------------------

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};
const jsonCopy = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

/**
 * A vector mask: `path` is PathData in document space; `initialFill` is what the mask starts from before the path's
 * components are combined into it ('hide': the path's inside shows; 'reveal': everything shows, subtract hides).
 * Density (0..1) and feather (px) are non-destructive. The K.1 hook (lib/mask-render.js) decides what it masks.
 */
export const DEFAULT_VECTOR_MASK = deepFreeze({ path: { subpaths: [] }, enabled: true, linked: true, density: 1, feather: 0, initialFill: 'hide' });

const BLEND_IF_RANGE = [0, 0, 255, 255];
/**
 * Layer Style > Blending Options beyond opacity, fill and mode (layer-style-blending renders them, K.3). `blendIf`
 * ranges are [black0, black1, white0, white1] in 0..255 (a split slider is two values). `layer.blending === null`
 * means all of these defaults; nothing renders differently until a field differs from them.
 */
export const DEFAULT_BLENDING = deepFreeze({
  channels: { r: true, g: true, b: true },
  knockout: 'none',
  interiorAsGroup: false,
  clippedAsGroup: true,
  transparencyShapes: true,
  maskHidesEffects: false,
  vectorMaskHidesEffects: false,
  blendIf: Object.fromEntries(['gray', 'r', 'g', 'b'].map((c) => [c, { this: BLEND_IF_RANGE, under: BLEND_IF_RANGE }])),
});

/** The full blending options of `b` (null or partial): every missing field from DEFAULT_BLENDING; a fresh object. */
function fullBlending(b) {
  const d = DEFAULT_BLENDING;
  const src = b && typeof b === 'object' ? b : {};
  const range = (v, def) => (Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) ? v.slice() : def.slice());
  const blendIf = {};
  for (const c of Object.keys(d.blendIf)) {
    const s = src.blendIf?.[c] ?? {};
    blendIf[c] = { this: range(s.this, d.blendIf[c].this), under: range(s.under, d.blendIf[c].under) };
  }
  const out = { ...jsonCopy(d), ...jsonCopy(src), channels: { ...d.channels, ...(src.channels ?? {}) }, blendIf };
  return out;
}

/** True when `b` (null, partial or full) renders exactly like the defaults. */
export function isDefaultBlending(b) {
  if (b === null || b === undefined) return true;
  return JSON.stringify(fullBlending(b)) === JSON.stringify(fullBlending(null));
}

/** The blending options a layer renders with (DEFAULT_BLENDING itself, frozen, when the layer has none). */
export function effectiveBlending(layer) {
  const b = layer?.blending;
  return b ? fullBlending(b) : DEFAULT_BLENDING;
}

/** A vector mask with every missing field from DEFAULT_VECTOR_MASK (null stays null); a fresh object. */
function fullVectorMask(vm) {
  if (!vm || typeof vm !== 'object') return null;
  const out = { ...jsonCopy(DEFAULT_VECTOR_MASK), ...jsonCopy(vm) };
  if (!out.path || !Array.isArray(out.path.subpaths)) out.path = { subpaths: [] };
  return out;
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
    this.mask = props.mask ?? null; // { canvas, enabled, linked, density? (0..1, default 1), feather? (px, default 0) }
    // 0.4: { path, enabled, linked, density, feather, initialFill } (DEFAULT_VECTOR_MASK) or null
    this.vectorMask = fullVectorMask(props.vectorMask);
    // 0.4: advanced blending options (DEFAULT_BLENDING), null = all defaults
    this.blending = props.blending && typeof props.blending === 'object' ? jsonCopy(props.blending) : null;
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
    const d = {
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
      vectorMask: this.vectorMask ? jsonCopy(this.vectorMask) : null,
      blending: isDefaultBlending(this.blending) ? null : jsonCopy(this.blending),
    };
    // written only when set, so a 0.3 mask describes as it did
    if (this.mask && this.mask.density !== undefined) d.maskDensity = this.mask.density;
    if (this.mask && this.mask.feather !== undefined) d.maskFeather = this.mask.feather;
    return d;
  }
}

export class RasterLayer extends Layer {
  constructor(props = {}) {
    super('raster', props);
    this.x = props.x ?? 0;
    this.y = props.y ?? 0;
    this.canvas = props.canvas ?? createCanvas(props.width ?? 1, props.height ?? 1);
    // 16/32-bit documents (lib/depth.js): the high-precision pixels, straight RGBA, same size as the canvas;
    // the canvas is the 8-bit proxy everything else paints and composites. { type: 'u16'|'f32', data: Uint16Array|Float32Array }
    this.deep = props.deep ?? null;
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

/**
 * Text backend (ARCHITECTURE.md "0.4 features", B.1): lib/type/api.js sets it when evaluated (app.js imports it
 * statically), and TextLayer.layout() / baseBounds() / renderBase() go to it: { layout(layer), bounds(layer),
 * render(layer) }.
 */
let textBackend = null;
export function setTextBackend(backend) {
  textBackend = backend;
}
function backend() {
  if (!textBackend) throw new Error('The type facade (lib/type/api.js) is not loaded');
  return textBackend;
}

const CHAR_OF_FONT = { family: 'fontFamily', weight: 'fontWeight', italic: 'fontItalic', size: 'size', color: 'color', underline: 'underline' };
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const setKeys = (style, patch) => {
  const out = { ...style };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};

/**
 * The content and type options after assigning a 0.3 font object (A, "Compatibility"): only the fields that differ
 * from the current flat font are applied, to the whole text (an empty text's insertion style too); letterSpacing and
 * lineHeight are converted with the size being set. A missing `orientation` means horizontal (0.3 code deletes it).
 */
export function applyLegacyFont(content, typeOptions, f) {
  const font = f && typeof f === 'object' ? f : {};
  const cur = legacyFont(content, typeOptions);
  const size = Number.isFinite(font.size) && font.size > 0 ? font.size : cur.size;
  const char = {};
  for (const [k, key] of Object.entries(CHAR_OF_FONT)) {
    if (!(k in font) || sameValue(font[k], cur[k])) continue;
    char[key] = k === 'italic' || k === 'underline' ? !!font[k] : font[k];
  }
  if ('stroke' in font && !sameValue(font.stroke, cur.stroke)) char.stroke = font.stroke ? { color: font.stroke.color, width: font.stroke.width } : null;
  if ('letterSpacing' in font && !sameValue(font.letterSpacing, cur.letterSpacing)) char.tracking = Number.isFinite(font.letterSpacing) && font.letterSpacing ? (font.letterSpacing * 1000) / size : undefined;
  const para = {};
  if ('align' in font && font.align !== cur.align) para.align = font.align;
  let next = content;
  if ('lineHeight' in font && Number.isFinite(font.lineHeight) && !sameValue(font.lineHeight, cur.lineHeight)) {
    // 0.3's line height is proportional to the size: auto leading at lineHeight x 100 %
    char.leading = undefined;
    next = mapPara(next, (style, r) => ({ ...style, justification: { ...r.justification, autoLeading: tidyNumber(font.lineHeight * 100) } }));
  }
  if (Object.keys(char).length) next = mapChar(next, (style) => setKeys(style, char));
  if (Object.keys(para).length) next = mapPara(next, (style) => setKeys(style, para));
  const orientation = font.orientation && font.orientation !== 'horizontal' ? font.orientation : 'horizontal';
  const options = (typeOptions?.orientation ?? 'horizontal') === orientation ? typeOptions : normalizeTypeOptions({ ...typeOptions, orientation });
  return { content: next, typeOptions: options };
}

const fontMemo = new WeakMap(); // content -> { typeOptions, font }

export class TextLayer extends Layer {
  /**
   * props: the 0.4 fields { content, typeOptions, height } or 0.3's { text, font } (upgraded through fromLegacy), plus
   * x, y, width (null: point text), rotation, transform, pathText.
   */
  constructor(props = {}) {
    let content, typeOptions;
    if (props.content && typeof props.content === 'object') {
      content = Object.isFrozen(props.content) ? props.content : normalize(props.content);
      typeOptions = normalizeTypeOptions(props.typeOptions ?? (props.font?.orientation ? { orientation: props.font.orientation } : {}));
    } else ({ content, typeOptions } = fromLegacy({ text: props.text ?? '', font: { ...DEFAULT_TEXT_STYLE, ...(props.font ?? {}) } }));
    super('text', { name: plainText(content).split('\n')[0]?.slice(0, 30) || 'Text', ...props });
    this.x = props.x ?? 0;
    this.y = props.y ?? 0;
    this.width = props.width ?? null; // null: point text (grows), number: paragraph box
    this.height = props.height ?? null; // null: the box grows with the text, number: a fixed box (0.4)
    // the rich-text model (lib/type/model.js): the truth; `text` and `font` below are 0.3's flat views of it
    this.content = content;
    this.typeOptions = typeOptions;
    this.rotation = props.rotation ?? 0;
    // optional affine matrix [a, b, c, d, e, f] in document space (free transform keeps text editable)
    this.transform = props.transform ?? null;
    // text on a path: { path: PathData (document space), startOffset: 0..1, flip: boolean, align } or null
    this.pathText = props.pathText ?? null;
    this._cache = null;
  }
  /** The plain text; assigning keeps the formatting outside the changed span (model replacePlain). */
  get text() {
    return plainText(this.content);
  }
  set text(s) {
    this.content = replacePlain(this.content, typeof s === 'string' ? s : String(s ?? ''));
  }
  /** 0.3's flat TextStyle of the first character (a new object; mutating it changes nothing). */
  get font() {
    let m = fontMemo.get(this.content);
    if (!m || m.typeOptions !== this.typeOptions) {
      m = { typeOptions: this.typeOptions, font: legacyFont(this.content, this.typeOptions) };
      fontMemo.set(this.content, m);
    }
    return { ...m.font, stroke: m.font.stroke ? { ...m.font.stroke } : null };
  }
  /** Applies the fields that differ from the current font to the whole text (flattens that attribute on mixed text). */
  set font(f) {
    const r = applyLegacyFont(this.content, this.typeOptions, f);
    this.content = r.content;
    this.typeOptions = r.typeOptions;
  }
  /** The displayed layout (lib/type/api.js: a text extension, else the engine). */
  layout() {
    return backend().layout(this);
  }
  /** Bounds before the free-transform matrix. */
  baseBounds() {
    return backend().bounds(this);
  }
  bounds() {
    const b = this.baseBounds();
    return this.transform ? transformBounds(this.transform, b) : b;
  }
  render() {
    if (this._cache && this._cache.version === this.version) return this._cache;
    const base = this.renderBase();
    if (!this.transform) {
      this._cache = { version: this.version, ...base };
      return this._cache;
    }
    const out = transformBounds(this.transform, { x: base.x, y: base.y, width: base.canvas.width, height: base.canvas.height });
    const canvas = createCanvas(Math.max(1, out.width), Math.max(1, out.height));
    const ctx = canvas.getContext('2d');
    const m = this.transform;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - out.x, m[5] - out.y);
    ctx.drawImage(base.canvas, base.x, base.y);
    this._cache = { version: this.version, canvas, x: out.x, y: out.y };
    return this._cache;
  }
  /** Renders the text without the transform matrix: { canvas, x, y }. */
  renderBase() {
    return backend().render(this);
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

/**
 * 0.3-compatible delegates of lib/paint.js (G.3): `rect` is the placement box in ctx space and from / to are in that
 * same space (origin [0, 0]). FillLayer, path-ops.js renderShapeLayer and the Gradient tool draw through them.
 */
export function makePaint(ctx, paint, rect) {
  return paintStyle(ctx, paint, rect, { origin: [0, 0] });
}

/** Builds a canvas gradient; `from`/`to` are in the same space as rect (absolute), defaulting to rect's left->right. */
export function makeGradient(ctx, g, rect) {
  return paintStyle(ctx, { type: 'gradient', gradient: g }, rect, { origin: [0, 0] });
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
  /** The rendered box, padded for the stroke (path-ops.js shapeBounds, J.5: shapes-live pads every stroke option). */
  bounds() {
    return shapeBounds(this);
  }
  render() {
    if (this._cache && this._cache.version === this.version) return this._cache;
    const b = this.bounds() ?? { x: 0, y: 0, width: 1, height: 1 };
    const canvas = createCanvas(b.width, b.height);
    renderShapeLayer(this, canvas, b);
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
  const registered = LAYER_TYPES.get(d.type);
  if (registered) return new registered.cls(d);
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
   * @param {{ width: number, height: number, dpi?: number, name?: string, path?: string|null, mode?: string, depth?: number, colorTable?: number[][]|null, duotone?: object|null }} opts
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
    // document-level collections saved in .pigment (guides, the ruler origin, ...): lib/doc-store.js. doc.guides is
    // an accessor on it (below)
    this.store = new DocStore(this);
    this.channels = []; // saved alpha channels { id, name, mask: Uint8ClampedArray }
    this.paths = []; // saved vector paths { id, name, path }
    this.history = null; // set by lib/history.js
    this.version = 0;
    this.listeners = new Set();
    this.meta = {}; // author, description, exif copied on import
    this.thumbnail = null;
    // Image > Mode (lib/modes.js): pixels are always stored as RGBA canvases; the mode constrains edits and the
    // compositor's final pass (registerModeRenderer in compositor.js). 'rgb'|'grayscale'|'bitmap'|'duotone'|'indexed'|'cmyk'|'lab'|'multichannel'
    this.mode = opts.mode ?? 'rgb';
    this.depth = opts.depth ?? 8; // bits per channel: 8 | 16 | 32 (lib/depth.js keeps RasterLayer.deep in step)
    this.colorTable = opts.colorTable ?? null; // indexed mode: [[r, g, b], ...] up to 256 entries (+ transparentIndex in duotone/indexed options)
    this.duotone = opts.duotone ?? null; // { type: 'monotone'|'duotone'|'tritone'|'quadtone', inks: [{ name, color: '#rrggbb', curve: [[x, y], ...] }] }
  }

  /** The guides (a frozen array of { id, axis, pos, color? }); assigning a list stores it without history. */
  get guides() {
    return this.store.get('guides');
  }
  set guides(list) {
    this.store.setRaw('guides', list);
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
    // temporary layers (quick mask, transform previews) are never saved
    const saved = (l) => !l.quickMask && !l.preview;
    const walk = (layer) => {
      const d = layer.describe();
      if (layer.type === 'raster') Object.assign(d, { x: layer.x, y: layer.y, width: layer.canvas.width, height: layer.canvas.height, deep: layer.deep?.type ?? null });
      if (layer.type === 'group') Object.assign(d, { expanded: layer.expanded, children: layer.children.filter(saved).map(walk) });
      // version 3: the rich-text content is the truth; `text` and `font` are written for Pigment 0.3 readers (the first run)
      if (layer.type === 'text') Object.assign(d, { x: layer.x, y: layer.y, width: layer.width, height: layer.height ?? null, rotation: layer.rotation, transform: layer.transform ? layer.transform.slice() : null, pathText: layer.pathText ? JSON.parse(JSON.stringify(layer.pathText)) : null, content: JSON.parse(JSON.stringify(layer.content)), typeOptions: { ...layer.typeOptions }, text: layer.text, font: layer.font });
      const registered = LAYER_TYPES.get(layer.type);
      if (registered?.describe) Object.assign(d, registered.describe(layer));
      if (layer.type === 'shape') Object.assign(d, { path: JSON.parse(JSON.stringify(layer.path)), fill: layer.fill, stroke: layer.stroke, shapeKind: layer.shapeKind, shapeProps: layer.shapeProps });
      if (layer.type === 'fill') Object.assign(d, { paint: JSON.parse(JSON.stringify({ ...layer.paint, pattern: layer.paint.pattern ? { scale: layer.paint.pattern.scale } : undefined })) });
      if (layer.type === 'adjustment') Object.assign(d, { kind: layer.kind, params: JSON.parse(JSON.stringify(layer.params)) });
      return d;
    };
    return {
      version: 3,
      app: 'pigment',
      width: this.width,
      height: this.height,
      dpi: this.dpi,
      mode: this.mode ?? 'rgb',
      depth: this.depth ?? 8,
      colorTable: this.colorTable ? this.colorTable.map((c) => [...c]) : null,
      duotone: this.duotone ? JSON.parse(JSON.stringify(this.duotone)) : null,
      name: this.name,
      active: this.active?.id ?? null,
      // the store is the truth (version 3); the plain guides are written too, for Pigment 0.3 readers
      store: this.store.toJSON(),
      guides: this.guides.map((g) => ({ axis: g.axis, pos: g.pos })),
      channels: this.channels.map((c) => ({ id: c.id, name: c.name })),
      paths: this.paths.map((p) => ({ id: p.id, name: p.name, path: p.path })),
      workPath: this.workPath?.subpaths?.length ? JSON.parse(JSON.stringify(this.workPath)) : null,
      meta: this.meta,
      globalLight: this.globalLight ?? null,
      layers: this.root.children.filter(saved).map(walk),
    };
  }
}

/** Creates a new document with a background layer filled with `background` ('white'|'transparent'|'background'|hex). */
export function createDocument({ width, height, dpi = 72, name = 'Untitled', background = 'white', backgroundColor = '#ffffff', mode = 'rgb', depth = 8 }) {
  const doc = new Document({ width, height, dpi, name, mode, depth });
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
