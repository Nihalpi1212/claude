// Scripted Patterns (patterns package, ARCHITECTURE.md "0.4 features", package 10): Edit > Fill > Pattern > Scripted
// Patterns. Photoshop's six scripts place copies of a pattern tile over the filled area: Brick Fill, Cross Weave,
// Place Along Path, Random Fill, Spiral and Symmetry Fill, each with Pattern Scale, Spacing and the colour and
// brightness randomness of its copies.
//
// The placement maths is pure (no DOM, so Node unit tests run it) and seeded: the same options and seed always place
// the same copies, so a recorded Fill replays exactly. drawPlacements() draws them on a Canvas 2D context; the caller
// gives it a canvas factory, so importing this file never touches the DOM.
//
//   SCRIPTS: { id, name, needsPath?, fields: FieldSpec[] (form.js), defaults }[]
//   scriptPlacements(id, { area: Rect (document px), tile: { width, height }, options, paths? }) -> Placement[]
//     Placement = { x, y (the copy's centre, document px), angle (degrees, clockwise on screen), scale, flipX, flipY,
//                   hue (degrees), bright (-1..1) }
//     paths (Place Along Path): polylines [{ closed, points: [[x, y], ...] }] in document px
//   recolorTile(tile, hue, bright) -> a new { width, height, data } (hue rotation that keeps luminance, brightness)
//   drawPlacements(ctx, placements, tile, { origin: [x, y] (document position of ctx's 0, 0), makeCanvas(w, h) })
import { seededRandom } from '../../shared/pixels/gradient-model.js';

export const MAX_COPIES = 50000;

const pct = (key, label, value, min, max) => ({ key, label, type: 'slider', value, min, max, unit: '%' });
const px = (key, label, value, min, max) => ({ key, label, type: 'slider', value, min, max, unit: 'px' });
const RANDOMNESS = [pct('colorRandom', 'Color randomness', 0, 0, 100), pct('brightRandom', 'Brightness randomness', 0, 0, 100)];

export const SYMMETRY_TYPES = [
  ['translation', 'Translation'],
  ['mirror', 'Mirror'],
  ['mirror-both', 'Mirror both ways'],
  ['glide', 'Glide reflection'],
  ['rotate-180', '2-fold rotation'],
  ['rotate-120', '3-fold rotation'],
  ['rotate-90', '4-fold rotation'],
  ['rotate-60', '6-fold rotation'],
  ['kaleidoscope', '4-fold rotation with mirrors'],
];

export const SCRIPTS = [
  {
    id: 'brick-fill',
    name: 'Brick Fill',
    fields: [pct('scale', 'Pattern scale', 100, 10, 1000), px('spacing', 'Spacing', 0, -200, 400), pct('offset', 'Offset between rows', 50, 0, 100), ...RANDOMNESS],
  },
  {
    id: 'cross-weave',
    name: 'Cross Weave',
    fields: [pct('scale', 'Pattern scale', 100, 10, 1000), px('spacing', 'Spacing', 0, -200, 400), ...RANDOMNESS],
  },
  {
    id: 'place-along-path',
    name: 'Place Along Path',
    needsPath: true,
    fields: [
      pct('scale', 'Pattern scale', 100, 10, 1000),
      px('spacing', 'Spacing', 0, -200, 400),
      { key: 'alignment', label: 'Alignment', type: 'select', value: 'along', options: [['along', 'Along the path'], ['alternate', 'Alternate sides']] },
      pct('progression', 'Scale progression', 100, 80, 120),
      px('distance', 'Distance from path', 0, -400, 400),
      { key: 'angle', label: 'Rotate angle', type: 'slider', value: 0, min: -180, max: 180, unit: '°' },
      { key: 'fit', label: 'Adjust spacing to fit', type: 'checkbox', value: true },
      ...RANDOMNESS,
    ],
  },
  {
    id: 'random-fill',
    name: 'Random Fill',
    fields: [
      { key: 'density', label: 'Density', type: 'slider', value: 3, min: 0.1, max: 10, step: 0.1 },
      pct('minScale', 'Minimum scale', 50, 10, 1000),
      pct('maxScale', 'Maximum scale', 150, 10, 1000),
      { key: 'rotate', label: 'Rotate pattern', type: 'checkbox', value: true },
      ...RANDOMNESS,
    ],
  },
  {
    id: 'spiral',
    name: 'Spiral',
    fields: [
      pct('scale', 'Pattern scale', 100, 10, 1000),
      px('spacing', 'Spacing', 0, -200, 400),
      { key: 'angle', label: 'Starting angle', type: 'slider', value: 0, min: -180, max: 180, unit: '°' },
      pct('progression', 'Scale progression', 100, 50, 200),
      { key: 'rotate', label: 'Rotate pattern', type: 'checkbox', value: true },
      ...RANDOMNESS,
    ],
  },
  {
    id: 'symmetry-fill',
    name: 'Symmetry Fill',
    fields: [
      { key: 'symmetry', label: 'Symmetry type', type: 'select', value: 'rotate-90', options: SYMMETRY_TYPES },
      pct('scale', 'Pattern scale', 100, 10, 1000),
      pct('translateX', 'Pattern translation X', 0, -100, 100),
      pct('translateY', 'Pattern translation Y', 0, -100, 100),
      { key: 'angle', label: 'Pattern rotate angle', type: 'slider', value: 0, min: -180, max: 180, unit: '°' },
      ...RANDOMNESS,
    ],
  },
];
for (const s of SCRIPTS) s.defaults = Object.fromEntries(s.fields.map((f) => [f.key, f.value]));

export function scriptDef(id) {
  return SCRIPTS.find((s) => s.id === id) ?? null;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The copies a script places over `area`. Options missing from `options` take the script's defaults; `options.seed`
 * (an integer) drives every random choice.
 */
export function scriptPlacements(id, { area, tile, options = {}, paths = [] } = {}) {
  const def = scriptDef(id);
  if (!def || !area || !tile?.width || !tile?.height) return [];
  const o = { ...def.defaults, ...options };
  const rnd = seededRandom(num(o.seed, 1));
  const colorR = clampN(num(o.colorRandom, 0), 0, 100) / 100, brightR = clampN(num(o.brightRandom, 0), 0, 100) / 100;
  // every copy draws its two random variations, in the same order, whether or not they are used: changing one slider
  // does not reshuffle the other choices
  const vary = (p) => {
    const h = rnd() * 2 - 1, b = rnd() * 2 - 1;
    p.hue = colorR ? h * colorR * 180 : 0;
    p.bright = brightR ? b * brightR * 0.75 : 0;
    return p;
  };
  const copy = (x, y, extra = {}) => vary({ x, y, angle: 0, scale: 1, flipX: false, flipY: false, ...extra });
  const out = [];
  const push = (p) => {
    if (out.length < MAX_COPIES) out.push(p);
  };
  const s = clampN(num(o.scale, 100), 1, 10000) / 100;
  const tw = tile.width * s, th = tile.height * s;
  const spacing = num(o.spacing, 0);
  const right = area.x + area.width, bottom = area.y + area.height;

  switch (id) {
    case 'brick-fill': {
      const sx = Math.max(1, tw + spacing), sy = Math.max(1, th + spacing);
      const shift = (clampN(num(o.offset, 50), 0, 100) / 100) * sx;
      for (let row = 0, y = area.y + th / 2; y - th / 2 < bottom; row++, y += sy) {
        // odd rows start half (or `offset`) a brick to the left, so the area's left edge stays covered
        for (let x = area.x + tw / 2 - (row % 2 ? shift : 0); x - tw / 2 < right; x += sx) push(copy(x, y, { scale: s }));
      }
      break;
    }
    case 'cross-weave': {
      // square cells; copies turn a quarter in a checkerboard, like strips woven over and under
      const cell = Math.max(1, Math.max(tw, th) + spacing);
      for (let j = 0, y = area.y + cell / 2; y - cell / 2 < bottom; j++, y += cell) {
        for (let i = 0, x = area.x + cell / 2; x - cell / 2 < right; i++, x += cell) push(copy(x, y, { scale: s, angle: (i + j) % 2 ? 90 : 0 }));
      }
      break;
    }
    case 'random-fill': {
      const density = clampN(num(o.density, 3), 0, 10);
      const lo = clampN(num(o.minScale, 50), 1, 10000) / 100, hi = Math.max(lo, clampN(num(o.maxScale, 150), 1, 10000) / 100);
      const mean = (lo + hi) / 2;
      const count = Math.min(MAX_COPIES, Math.round((density * area.width * area.height) / Math.max(1, tile.width * tile.height * mean * mean)));
      for (let i = 0; i < count; i++) {
        const x = area.x + rnd() * area.width, y = area.y + rnd() * area.height;
        const k = lo + rnd() * (hi - lo);
        const a = rnd() * 360;
        push(copy(x, y, { scale: k, angle: o.rotate === false ? 0 : a }));
      }
      break;
    }
    case 'spiral': {
      // Archimedean spiral r = a·θ from the area's centre: neighbouring turns sit one copy (plus spacing) apart
      const cx = area.x + area.width / 2, cy = area.y + area.height / 2;
      const gap = Math.max(1, Math.max(tw, th) + spacing);
      const a = gap / (2 * Math.PI);
      const reach = Math.hypot(area.width, area.height) / 2 + gap;
      const start = (num(o.angle, 0) * Math.PI) / 180;
      const prog = clampN(num(o.progression, 100), 1, 1000) / 100;
      let theta = 0;
      while (a * theta <= reach && out.length < MAX_COPIES) {
        const r = a * theta;
        const turn = theta / (2 * Math.PI);
        const k = clampN(s * Math.pow(prog, turn), 0.01, 100);
        const phi = theta + start;
        push(copy(cx + r * Math.cos(phi), cy + r * Math.sin(phi), { scale: k, angle: o.rotate === false ? 0 : (phi * 180) / Math.PI + 90 }));
        // the next copy one copy-width further along the curve (the arc length of a small step is about r·dθ)
        const step = Math.max(tw, th) * (k / s) + spacing;
        theta += Math.max(step, 1) / Math.max(r, gap / 2);
      }
      break;
    }
    case 'place-along-path': {
      const prog = clampN(num(o.progression, 100), 1, 1000) / 100;
      const dist = num(o.distance, 0);
      const rot = num(o.angle, 0);
      const alternate = o.alignment === 'alternate';
      let index = 0;
      for (const poly of paths ?? []) {
        const pts = (poly?.points ?? []).slice();
        if (pts.length < 2) continue;
        if (poly.closed) pts.push(pts[0]);
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const length = cum[cum.length - 1];
        if (length <= 0) continue;
        const at = (d) => {
          let i = 1;
          while (i < cum.length - 1 && cum[i] < d) i++;
          const seg = cum[i] - cum[i - 1] || 1;
          const t = clampN((d - cum[i - 1]) / seg, 0, 1);
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
          return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, dir: Math.atan2(y1 - y0, x1 - x0) };
        };
        // the copies and the advance after each (their widths grow by the progression); an open path takes a copy at
        // each end, a closed one does not repeat its start
        const advances = [];
        for (let k = s, d = 0; (poly.closed ? d < length - 1e-6 : d <= length + 1e-6) && advances.length < MAX_COPIES; k = clampN(k * prog, 0.01, 100)) {
          const step = Math.max(1, tw * (k / s) + spacing);
          advances.push({ k, step });
          d += step;
        }
        // Adjust spacing to fit: the advances are stretched so the copies end exactly on the path's end
        const span = advances.slice(0, poly.closed ? advances.length : advances.length - 1).reduce((t, a) => t + a.step, 0);
        const stretch = o.fit !== false && span > 0 ? length / span : 1;
        let d = 0;
        for (const { k, step } of advances) {
          const p = at(Math.min(d, length));
          const side = alternate && index % 2 ? -1 : 1;
          const nx = -Math.sin(p.dir), ny = Math.cos(p.dir);
          push(copy(p.x + nx * dist * side, p.y + ny * dist * side, { scale: k, angle: (p.dir * 180) / Math.PI + rot + (side < 0 ? 180 : 0) }));
          index++;
          d += step * stretch;
        }
      }
      break;
    }
    case 'symmetry-fill': {
      const type = SYMMETRY_TYPES.some(([t]) => t === o.symmetry) ? o.symmetry : 'rotate-90';
      const base = num(o.angle, 0);
      const cell = Math.max(tw, th);
      const tx = (num(o.translateX, 0) / 100) * cell, ty = (num(o.translateY, 0) / 100) * cell;
      // the copies of one motif in a unit cell: offsets in cell units from the cell's centre, a turn and mirrors
      const ops = symmetryOps(type);
      const hex = type === 'rotate-120' || type === 'rotate-60';
      const unit = ops.unit * cell;
      const rowStep = hex ? unit * Math.sqrt(3) / 2 : unit;
      for (let j = 0, cy = area.y; cy - unit < bottom; j++, cy += rowStep) {
        const shift = hex && j % 2 ? unit / 2 : type === 'glide' && j % 2 ? unit / 2 : 0;
        for (let cx = area.x - shift; cx - unit < right; cx += unit) {
          for (const op of ops.copies) {
            const flipRow = type === 'glide' && j % 2;
            const ox = (op.dx * unit) / 2 + tx, oy = (op.dy * unit) / 2 + ty;
            // the motif's own offset turns with the copy, so a rotation group spins around the cell's centre
            const t = (op.angle * Math.PI) / 180;
            const rx = ox * Math.cos(t) - oy * Math.sin(t), ry = ox * Math.sin(t) + oy * Math.cos(t);
            push(copy(cx + rx, cy + ry, { scale: s, angle: op.angle + base, flipX: !!op.flipX !== !!flipRow, flipY: !!op.flipY }));
          }
        }
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** The motif copies of one cell of a symmetry type: { unit (cell size in motif sizes), copies: { dx, dy, angle, flipX, flipY }[] }. */
export function symmetryOps(type) {
  const turns = (n, off = 0.5) => Array.from({ length: n }, (_, i) => ({ dx: off, dy: off, angle: (360 / n) * i }));
  switch (type) {
    case 'translation': return { unit: 1, copies: [{ dx: 0, dy: 0, angle: 0 }] };
    case 'mirror': return { unit: 2, copies: [{ dx: -0.5, dy: 0, angle: 0 }, { dx: 0.5, dy: 0, angle: 0, flipX: true }] };
    case 'mirror-both': return { unit: 2, copies: [{ dx: -0.5, dy: -0.5, angle: 0 }, { dx: 0.5, dy: -0.5, angle: 0, flipX: true }, { dx: -0.5, dy: 0.5, angle: 0, flipY: true }, { dx: 0.5, dy: 0.5, angle: 0, flipX: true, flipY: true }] };
    case 'glide': return { unit: 1, copies: [{ dx: 0, dy: 0, angle: 0 }] };
    case 'rotate-180': return { unit: 2, copies: turns(2) };
    case 'rotate-120': return { unit: 2, copies: turns(3, 0.5) };
    case 'rotate-60': return { unit: 2, copies: turns(6, 0.5) };
    case 'kaleidoscope': return { unit: 2, copies: [...turns(4), ...turns(4).map((c) => ({ ...c, angle: c.angle + 90, flipX: true }))] };
    case 'rotate-90':
    default: return { unit: 2, copies: turns(4) };
  }
}

/**
 * A recoloured copy of a tile: the hue turned by `hue` degrees with a luminance-keeping rotation (the matrix of CSS's
 * hue-rotate()), the brightness moved by `bright` (-1..1: towards black or white). Alpha unchanged.
 */
export function recolorTile(tile, hue = 0, bright = 0) {
  const { width, height } = tile;
  const src = tile.data;
  const data = new Uint8ClampedArray(src.length);
  const a = (hue * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const up = bright > 0, k = Math.abs(bright);
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i], g = src[i + 1], b = src[i + 2];
    let R = hue ? m[0] * r + m[1] * g + m[2] * b : r;
    let G = hue ? m[3] * r + m[4] * g + m[5] * b : g;
    let B = hue ? m[6] * r + m[7] * g + m[8] * b : b;
    if (k) {
      R = up ? R + (255 - R) * k : R * (1 - k);
      G = up ? G + (255 - G) * k : G * (1 - k);
      B = up ? B + (255 - B) * k : B * (1 - k);
    }
    data[i] = R;
    data[i + 1] = G;
    data[i + 2] = B;
    data[i + 3] = src[i + 3];
  }
  return { width, height, data };
}

/**
 * Draws the copies on ctx. `tile` is { width, height, data } (ImageData-like); makeCanvas(w, h) gives a canvas. The
 * recoloured tiles are cached by hue (5° steps) and brightness (2 % steps), so thousands of copies cost a few dozen
 * recolourings at most.
 */
export function drawPlacements(ctx, placements, tile, { origin = [0, 0], makeCanvas }) {
  const cache = new Map();
  const tileCanvas = (hue, bright) => {
    const hq = Math.round(hue / 5) * 5, bq = Math.round(bright * 50) / 50;
    const key = `${hq}|${bq}`;
    let c = cache.get(key);
    if (!c) {
      const img = hq || bq ? recolorTile(tile, hq, bq) : tile;
      c = makeCanvas(tile.width, tile.height);
      const cctx = c.getContext('2d');
      const id = cctx.createImageData(tile.width, tile.height);
      id.data.set(img.data);
      cctx.putImageData(id, 0, 0);
      cache.set(key, c);
    }
    return c;
  };
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  for (const p of placements) {
    const c = tileCanvas(p.hue ?? 0, p.bright ?? 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(p.x - origin[0], p.y - origin[1]);
    if (p.angle) ctx.rotate((p.angle * Math.PI) / 180);
    ctx.scale((p.flipX ? -1 : 1) * p.scale, (p.flipY ? -1 : 1) * p.scale);
    ctx.drawImage(c, -tile.width / 2, -tile.height / 2);
  }
  ctx.restore();
}
