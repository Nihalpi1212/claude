// Vector masks, shape layers, layer masks and paths ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: kind `shape` 350,
// aspects `vector-mask` 290 and `raster-mask` 300; S4.6). psd-layers' file.
//
// - Paths: Pigment's PathData (document px; per subpath `closed`, `op`, anchors with optional in / out handles) and
//   ag-psd's BezierPath records (knots [in, anchor, out], `operation`, `open`) both ways: pathFromPsd / pathToPsd,
//   which preset-files-manager's .csh reader uses too.
// - Vector masks: the layer's `vectorMask` as 'vmsk' (enabled, linked, Reveal All / Hide All start, the path's
//   operations), its density and feather as the layer mask's vector parameters. An inverted vector mask (Photoshop's
//   'invert' flag, which Pigment has no field for) reads as its path plus a document rectangle excluded from it, which
//   draws the same mask.
// - Layer masks: the raster-mask aspect is re-registered (review decision 11): read takes the user mask (`realMask`
//   when the record's first mask is the one rendered from the vector mask), with its density and feather; write gives
//   the mask's own pixels at full strength with those parameters, so Photoshop shows them as Properties settings, and
//   bakes the vector mask into it only where nobody wrote the vector mask (J.8: a shape layer's own vector mask, which
//   PSD cannot hold beside the shape's outline, reported).
// - Shape layers: fill (solid, gradient, pattern) and stroke (width, alignment, caps, joins, miter limit, dashes, the
//   stroke paint) as 'vscg' / 'vstk', the outline as the vector mask and the rendered pixels; live rectangles (radii
//   per corner, rotation) and ellipses through Photoshop's origination data ('vogk'), every other shape as a path
//   shape. In a Grayscale, Duotone or Multichannel document a shape is written natively only when every colour it
//   draws is what the document shows (S4.2); otherwise it declines and the raster kind writes its pixels.
//
// Node-safe: registry, convert.js, paints.js, document.js, path-ops.js (which document.js imports) and src/shared.
import { registerPsdLayerKind, registerPsdAspect, registerPsdFeatures, registerPsdNotice } from './registry.js';
import { paintFromContent, paintToContent, paintColors, unitsToPx, addPatterns } from './paints.js';
import { ShapeLayer, createCanvas } from '../document.js';
import { activeStroke, strokePaintOf, subpathOp } from '../path-ops.js';
import { normalizeAngle } from '../shape-geometry.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ vectorMasks: true, shapes: true });
registerPsdFeatures(PSD_FEATURES);

const plural = (n, one, many) => (n === 1 ? one : many);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const EPS = 1e-4;
const OPS = ['combine', 'subtract', 'intersect', 'exclude'];
const snap = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Math.abs(r - v) < 2e-5 ? r : v;
};

// ---- paths -------------------------------------------------------------------------------------------------------

/**
 * A Pigment Path from ag-psd's path records (`vectorMask.paths`, a .csh shape's `paths`): knot points are in pixels
 * of the `w` x `h` space ag-psd scaled them to (the document, or a custom shape's box). Null when there is no knot.
 */
export function pathFromPsd(paths, w, h) {
  void w;
  void h;
  if (!Array.isArray(paths)) return null;
  const subpaths = [];
  for (const p of paths) {
    const knots = Array.isArray(p?.knots) ? p.knots : [];
    if (!knots.length) continue;
    const points = knots.map(({ points: k }) => {
      // PSD keeps knots as 8.24 fixed-point fractions of the size: 59.9999964 px is 60 px written and read back. Only
      // values that close to a thousandth snap to it; any other value stays as read (a dashed stroke's dashes move
      // with every change along the outline)
      const [ix, iy, x, y, ox, oy] = (Array.isArray(k) ? k : []).map((v) => snap(num(v)));
      const pt = { x, y };
      if (Math.abs(ix - x) > EPS || Math.abs(iy - y) > EPS) Object.assign(pt, { inX: ix, inY: iy });
      if (Math.abs(ox - x) > EPS || Math.abs(oy - y) > EPS) Object.assign(pt, { outX: ox, outY: oy });
      return pt;
    });
    const sp = { closed: !p.open, points };
    if (OPS.includes(p.operation) && p.operation !== 'combine') sp.op = p.operation;
    subpaths.push(sp);
  }
  return subpaths.length ? { subpaths } : null;
}

/** ag-psd's path records for a Pigment Path in a `w` x `h` document (ag-psd divides by the size itself), or null. */
export function pathToPsd(path, w, h) {
  void w;
  void h;
  const out = [];
  for (const sp of path?.subpaths ?? []) {
    const pts = sp?.points ?? [];
    if (!pts.length) continue;
    out.push({
      open: !sp.closed,
      operation: subpathOp(sp),
      fillRule: 'non-zero',
      knots: pts.map((p) => {
        const ix = p.inX ?? p.x, iy = p.inY ?? p.y, ox = p.outX ?? p.x, oy = p.outY ?? p.y;
        // linked: the two handles point opposite ways through the anchor (a smooth point, as Photoshop links them)
        const a = Math.atan2(iy - p.y, ix - p.x), b = Math.atan2(oy - p.y, ox - p.x);
        const both = Math.hypot(ix - p.x, iy - p.y) > EPS && Math.hypot(ox - p.x, oy - p.y) > EPS;
        const turn = (((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const d = Math.abs(turn - Math.PI);
        return { linked: both && d < 1e-3, points: [ix, iy, p.x, p.y, ox, oy] };
      }),
    });
  }
  return out.length ? out : null;
}

/** A document rectangle excluded from a path: the inverse of the path's area (Photoshop's inverted vector mask). */
function invertedPath(path, w, h) {
  const r = [[-1, -1], [w + 1, -1], [w + 1, h + 1], [-1, h + 1]].map(([x, y]) => ({ x, y }));
  return { subpaths: [...(path?.subpaths ?? []), { closed: true, points: r, op: 'exclude' }] };
}

// ---- masks ---------------------------------------------------------------------------------------------------------

/** Alpha mask canvas -> PSD greyscale mask record (white = shows), document sized. */
function greyMask(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    d[i] = d[i + 1] = d[i + 2] = a;
    d[i + 3] = 255;
  }
  const g = createCanvas(canvas.width, canvas.height);
  g.getContext('2d').putImageData(img, 0, 0);
  return g;
}

/** A PSD greyscale mask (record left/top) as a document-sized alpha canvas. */
function alphaMask(m, doc) {
  const out = createCanvas(doc.width, doc.height);
  const octx = out.getContext('2d');
  octx.fillStyle = (m.defaultColor ?? 255) >= 128 ? '#fff' : 'rgba(0,0,0,0)';
  octx.fillRect(0, 0, doc.width, doc.height);
  const src = m.canvas;
  const img = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i];
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = v;
  }
  const tmp = createCanvas(src.width, src.height);
  tmp.getContext('2d').putImageData(img, 0, 0);
  octx.clearRect(m.left ?? 0, m.top ?? 0, src.width, src.height);
  octx.drawImage(tmp, m.left ?? 0, m.top ?? 0);
  return out;
}

const density = (m) => (Number.isFinite(m?.density) ? Math.max(0, Math.min(1, m.density)) : 1);
const feather = (m) => (Number.isFinite(m?.feather) ? Math.max(0, m.feather) : 0);

registerPsdNotice('shape-vector-mask', {
  when: 'save',
  timeout: 5000,
  text: (n) => `${n} shape layer${plural(n, '', 's')} with a vector mask of ${plural(n, 'its', 'their')} own ${plural(n, 'was', 'were')} saved with that mask baked into the layer mask: PSD keeps one vector outline per layer`,
});
registerPsdNotice('psd-shape-pattern', {
  when: 'save',
  timeout: 4000,
  text: (n) => `${n} shape or fill layer${plural(n, '', 's')} with a pattern that had not loaded ${plural(n, 'was', 'were')} saved as pixels`,
});
registerPsdNotice('psd-vector-dropped', {
  when: 'open',
  timeout: 6000,
  text: (n, details) => `${n} vector setting${plural(n, '', 's')} Pigment does not have ${plural(n, 'was', 'were')} approximated: ${[...new Set(details)].join(', ')}`,
});

registerPsdAspect({
  id: 'vector-mask',
  order: 290,
  read(pl, layer, ctx) {
    // a shape's outline is its own path (the shape kind read it)
    if (ctx.claimed(layer, 'shape') || !pl.vectorMask?.paths) return;
    const { doc } = ctx;
    let path = pathFromPsd(pl.vectorMask.paths, doc.width, doc.height) ?? { subpaths: [] };
    if (pl.vectorMask.invert) {
      path = invertedPath(path, doc.width, doc.height);
      ctx.report.add('psd-vector-dropped', 'an inverted vector mask (read as its path excluded from the canvas)');
    }
    layer.vectorMask = {
      path,
      enabled: !pl.vectorMask.disable,
      linked: !pl.vectorMask.notLink,
      density: Number.isFinite(pl.mask?.vectorMaskDensity) ? pl.mask.vectorMaskDensity : 1,
      feather: Number.isFinite(pl.mask?.vectorMaskFeather) ? pl.mask.vectorMaskFeather : 0,
      initialFill: pl.vectorMask.fillStartsWithAllPixels ? 'reveal' : 'hide',
    };
    ctx.claim(layer, 'vector-mask');
  },
  write(layer, rec, ctx) {
    const vm = layer.vectorMask;
    if (!vm || ctx.claimed(layer, 'shape')) return;
    rec.vectorMask = { paths: pathToPsd(vm.path, ctx.doc.width, ctx.doc.height) ?? [], disable: vm.enabled === false, notLink: vm.linked === false, fillStartsWithAllPixels: vm.initialFill === 'reveal' };
    ctx.claim(layer, 'vector-mask');
  },
});

registerPsdAspect({
  id: 'raster-mask',
  order: 300,
  read(pl, layer, ctx) {
    // the user mask: a record whose first mask is the one rendered from the vector mask keeps it second
    const user = pl.mask?.fromVectorData ? pl.realMask : pl.mask;
    if (!user?.canvas || user.fromVectorData) return;
    const mask = { canvas: alphaMask(user, ctx.doc), enabled: !user.disabled, linked: true };
    if (Number.isFinite(pl.mask?.userMaskDensity)) mask.density = pl.mask.userMaskDensity;
    if (Number.isFinite(pl.mask?.userMaskFeather) && pl.mask.userMaskFeather > 0) mask.feather = pl.mask.userMaskFeather;
    layer.mask = mask;
  },
  write(layer, rec, ctx) {
    const raster = layer.mask?.canvas ? layer.mask : null;
    const vm = layer.vectorMask;
    if (!raster && !vm) return;
    if (vm && !ctx.claimed(layer, 'vector-mask')) {
      // nobody wrote the vector mask: 0.4's bake of both into one layer mask (J.8)
      const mask = ctx.maskOf(layer, 'all');
      if (mask) rec.mask = mask;
      if (ctx.claimed(layer, 'shape')) ctx.report.add('shape-vector-mask');
      return;
    }
    const params = {};
    if (raster && density(raster) < 1) params.userMaskDensity = density(raster);
    if (raster && feather(raster) > 0) params.userMaskFeather = feather(raster);
    if (vm && density(vm) < 1) params.vectorMaskDensity = density(vm);
    if (vm && feather(vm) > 0) params.vectorMaskFeather = feather(vm);
    // Mask parameters follow the real-mask block in the record (ag-psd reads them there; without that block it would
    // read the parameters as one), so a record with parameters always carries it: the user mask again, or none
    const hasParams = Object.keys(params).length > 0;
    if (raster) {
      // the mask's own pixels at full strength; density and feather are its parameters
      const grey = greyMask(raster.canvas);
      const disabled = raster.enabled === false;
      rec.mask = { left: 0, top: 0, canvas: grey, defaultColor: 0, disabled, ...params };
      if (hasParams) rec.realMask = { left: 0, top: 0, canvas: grey, defaultColor: 0, disabled };
      return;
    }
    if (!hasParams) return;
    // a vector mask alone carries its density and feather on a mask record rendered from it (as Photoshop writes)
    const rendered = ctx.maskOf({ mask: null, vectorMask: { ...vm, enabled: true, density: 1, feather: 0 }, version: 0 }, 'vector');
    if (rendered) {
      rec.mask = { ...rendered, disabled: false, fromVectorData: true, ...params };
      rec.realMask = { left: 0, top: 0, defaultColor: 255 };
    }
  },
});

// ---- shapes ------------------------------------------------------------------------------------------------------

// Photoshop's origination types (vogk keyOriginType): 1 rectangle, 2 rounded rectangle, 5 ellipse
const ORIGIN = { rect: 1, roundedRect: 2, ellipse: 5 };

/** Photoshop's origination record of a live rectangle or ellipse (box, corners, radii, rotation), or null. */
function originationOf(layer) {
  const kind = layer.shapeKind;
  if (kind !== 'rect' && kind !== 'ellipse') return null;
  const p = layer.shapeProps ?? {};
  const x = num(p.x), y = num(p.y), w = num(p.width), h = num(p.height);
  if (!(w > 0 && h > 0)) return null;
  const a = (num(p.angle) * Math.PI) / 180, cx = x + w / 2, cy = y + h / 2;
  const turn = (px, py) => ({ x: cx + (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a), y: cy + (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a) });
  const corners = [turn(x, y), turn(x + w, y), turn(x + w, y + h), turn(x, y + h)];
  const pxv = (v) => ({ units: 'Pixels', value: v });
  const item = {
    keyOriginType: ORIGIN.ellipse,
    keyOriginResolution: 72,
    keyOriginShapeBoundingBox: { top: pxv(y), left: pxv(x), bottom: pxv(y + h), right: pxv(x + w) },
    keyOriginBoxCorners: corners,
    transform: [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), cx - cx * Math.cos(a) + cy * Math.sin(a), cy - cx * Math.sin(a) - cy * Math.cos(a)],
  };
  if (kind === 'rect') {
    const radii = Array.isArray(p.radii) && p.radii.length === 4 ? p.radii.map((v) => num(v)) : [num(p.radius), num(p.radius), num(p.radius), num(p.radius)];
    const rounded = radii.some((r) => r > 0);
    item.keyOriginType = rounded ? ORIGIN.roundedRect : ORIGIN.rect;
    if (rounded) item.keyOriginRRectRadii = { topLeft: pxv(radii[0]), topRight: pxv(radii[1]), bottomRight: pxv(radii[2]), bottomLeft: pxv(radii[3]) };
  }
  return { keyDescriptorList: [item] };
}

/** { shapeKind, shapeProps } of Photoshop's origination record, or null (a path shape). */
function liveFromOrigination(vo) {
  const item = vo?.keyDescriptorList?.length === 1 ? vo.keyDescriptorList[0] : null;
  if (!item || item.keyShapeInvalidated) return null;
  const type = item.keyOriginType;
  if (type !== ORIGIN.rect && type !== ORIGIN.roundedRect && type !== ORIGIN.ellipse) return null;
  let x, y, w, h, angle = 0;
  const c = item.keyOriginBoxCorners;
  if (Array.isArray(c) && c.length === 4) {
    w = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
    h = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);
    angle = normalizeAngle((Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x) * 180) / Math.PI);
    const cx = (c[0].x + c[2].x) / 2, cy = (c[0].y + c[2].y) / 2;
    x = cx - w / 2;
    y = cy - h / 2;
  } else if (item.keyOriginShapeBoundingBox) {
    const b = item.keyOriginShapeBoundingBox;
    x = unitsToPx(b.left);
    y = unitsToPx(b.top);
    w = unitsToPx(b.right) - x;
    h = unitsToPx(b.bottom) - y;
  } else return null;
  if (!(w > 0 && h > 0)) return null;
  const tidy = (v) => Math.round(v * 1e4) / 1e4;
  const box = { x: tidy(x), y: tidy(y), width: tidy(w), height: tidy(h), angle };
  if (type === ORIGIN.ellipse) return { shapeKind: 'ellipse', shapeProps: box };
  const r = item.keyOriginRRectRadii;
  const radii = r ? [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft].map((v) => tidy(unitsToPx(v))) : [0, 0, 0, 0];
  return { shapeKind: 'rect', shapeProps: { ...box, radii } };
}

const CAPS = ['butt', 'round', 'square'], JOINS = ['miter', 'round', 'bevel'], ALIGNS = ['inside', 'center', 'outside'];

registerPsdLayerKind({
  id: 'shape',
  order: 350,
  // a fill with a vector outline and a stroke style (CS6 and later) or Photoshop's origination data
  test: (pl) => !!pl.vectorFill && !!pl.vectorMask && (!!pl.vectorStroke || !!pl.vectorOrigination),
  read(pl, ctx) {
    const { doc } = ctx;
    const dropped = (d) => ctx.report.add('psd-vector-dropped', d);
    let path = pathFromPsd(pl.vectorMask.paths, doc.width, doc.height) ?? { subpaths: [] };
    if (pl.vectorMask.invert) {
      path = invertedPath(path, doc.width, doc.height);
      dropped('an inverted shape outline (read as its path excluded from the canvas)');
    }
    const vs = pl.vectorStroke ?? null;
    const opts = { place: 'box', patterns: ctx.patterns, profile: doc.profile ?? null, report: dropped };
    const fill = vs?.fillEnabled === false ? null : paintFromContent(pl.vectorFill, opts);
    let stroke = null;
    if (vs?.strokeEnabled) {
      const dpi = num(vs.resolution, doc.dpi || 72);
      const paint = paintFromContent(vs.content ?? { type: 'color', color: { r: 0, g: 0, b: 0 } }, opts) ?? { type: 'solid', color: '#000000' };
      stroke = {
        width: unitsToPx(vs.lineWidth, dpi), align: ALIGNS.includes(vs.lineAlignment) ? vs.lineAlignment : 'center',
        cap: CAPS.includes(vs.lineCapType) ? vs.lineCapType : 'butt', join: JOINS.includes(vs.lineJoinType) ? vs.lineJoinType : 'miter',
        miterLimit: num(vs.miterLimit, 4), dash: (vs.lineDashSet ?? []).map((d) => num(d?.value ?? d)), dashOffset: num(vs.lineDashOffset?.value ?? vs.lineDashOffset),
        paint, ...(paint.type === 'solid' ? { color: paint.color } : {}),
      };
      if (num(vs.opacity, 1) < 1 || (vs.blendMode && vs.blendMode !== 'normal')) dropped('a shape stroke\'s own opacity or blend mode');
    }
    const live = liveFromOrigination(pl.vectorOrigination);
    const layer = new ShapeLayer({ path, fill, stroke, ...(live ?? { shapeKind: 'path', shapeProps: {} }) });
    // no fill is null (the constructor gives a missing fill its default colour)
    if (!fill) layer.fill = null;
    ctx.claim(layer, 'shape');
    return layer;
  },
  match: (layer) => layer.type === 'shape',
  write(layer, ctx) {
    const { doc } = ctx;
    const stroke = activeStroke(layer);
    const strokePaint = stroke ? strokePaintOf(stroke) : null;
    // S4.2: in a mode document every colour must be what it shows
    if (ctx.modeRendered && [...paintColors(layer.fill), ...paintColors(strokePaint)].some((c) => !c || !ctx.asShown(c))) return null;
    const resolve = doc.view?.app?.patterns?.resolve?.bind(doc.view.app.patterns) ?? null;
    let missing = false;
    const content = (paint) => {
      const r = paintToContent(paint, { place: 'box', resolve, report: () => (missing = true) });
      if (paint && !r.content) missing = true;
      return r;
    };
    const fillC = layer.fill ? content(layer.fill) : { content: null, patterns: [] };
    const strokeC = stroke ? content(strokePaint) : { content: null, patterns: [] };
    if (missing) {
      ctx.report.add('psd-shape-pattern');
      return null;
    }
    const r = layer.render();
    const dpi = doc.dpi || 72;
    const pt = (v) => ({ units: 'Points', value: (num(v) * 72) / dpi });
    const rec = {
      left: r.x, top: r.y, canvas: ctx.shown(r.canvas, r.x, r.y),
      vectorFill: fillC.content ?? { type: 'color', color: { r: 0, g: 0, b: 0 } },
      vectorStroke: {
        strokeEnabled: !!stroke, fillEnabled: !!layer.fill,
        lineWidth: pt(stroke?.width ?? 3), lineDashOffset: pt(stroke?.dashOffset ?? 0), miterLimit: num(stroke?.miterLimit, 4),
        lineCapType: CAPS.includes(stroke?.cap) ? stroke.cap : 'butt', lineJoinType: JOINS.includes(stroke?.join) ? stroke.join : 'miter',
        lineAlignment: ALIGNS.includes(stroke?.align) ? stroke.align : 'center', scaleLock: false, strokeAdjust: false,
        lineDashSet: (Array.isArray(stroke?.dash) ? stroke.dash : []).map((d) => ({ units: 'None', value: num(d) })),
        // ag-psd's stroke style writer throws on a pattern's own 'Lnkd' flag: left out (Photoshop's default, linked)
        blendMode: 'normal', opacity: 1, content: strokeC.content ? { ...strokeC.content, linked: undefined } : { type: 'color', color: { r: 0, g: 0, b: 0 } }, resolution: dpi,
      },
      vectorMask: { paths: pathToPsd(layer.path, doc.width, doc.height) ?? [], fillStartsWithAllPixels: false },
    };
    const vo = originationOf(layer);
    if (vo) rec.vectorOrigination = vo;
    addPatterns(ctx.psd, [...fillC.patterns, ...strokeC.patterns]);
    ctx.claim(layer, 'shape');
    return rec;
  },
});
