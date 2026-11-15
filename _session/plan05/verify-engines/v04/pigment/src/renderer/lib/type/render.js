// Drawing for the HarfBuzz engine (type-engine-core, ARCHITECTURE.md "0.4 features", package 1).
//
// Outline glyphs are filled as one Path2D per run, built from each glyph's outline (cached per face) placed with a
// DOMMatrix: the drawn size, horizontal and vertical scale, a composer's glyph scale, and the slant of faux italic or
// of a synthesised italic. Colour glyphs (COLR, CBDT, sbix, SVG fonts, emoji) and characters the face does not have
// are drawn with fillText per shaping unit at its shaped position: colour glyphs in the face's own CSS FontFace, the
// fallback in the run's CSS font so the browser finds a font for it. The text stroke (0.2) is stroked under the fill,
// faux bold is a stroke of size / 30 in the fill colour, as in the stub engine; underline and strikethrough take the
// font's own positions and thicknesses.
import { createCanvas } from '../document.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { glyphPathData, glyphExtents, faceMetrics } from './shaper.js';
import { synthesis } from './fonts.js';
import { cssOf } from './layout.js';

const SKEW = 0.2; // faux italic slant, the stub's −0.2 skew

const pathCache = new WeakMap(); // face rec -> Map(gid -> Path2D)
function glyphPath(rec, gid) {
  let m = pathCache.get(rec);
  if (!m) pathCache.set(rec, (m = new Map()));
  let p = m.get(gid);
  if (!p) {
    const d = glyphPathData(rec, gid);
    p = d ? new Path2D(d) : null;
    m.set(gid, p);
  }
  return p;
}

const colorOf = (st) => rgbaToHex(parseColor(st.color), true);

/** How a run is drawn: horizontal scale (with the composer's glyph scale), vertical scale, slant, emboldening. */
function runLook(run, glyphScale = 1) {
  const st = run.style;
  const syn = synthesis(run.face, st);
  return { sx: run.scaleX * glyphScale, sy: run.scaleY, italic: !!st.fauxItalic || syn.italic, bold: !!st.fauxBold || syn.bold, gs: glyphScale };
}

/** Metrics for decorations in px: { underlinePos, underlineSize, strikePos, strikeSize } (y down from the baseline). */
function decoration(run) {
  const size = run.size;
  const rec = run.face;
  if (!rec) return { underlinePos: run.style.size * 0.12, underlineSize: Math.max(1, run.style.size / 16), strikePos: -run.style.size * 0.3, strikeSize: Math.max(1, run.style.size / 16) };
  const m = faceMetrics(rec);
  const k = size / rec.upem;
  return { underlinePos: -m.underlineOffset * k, underlineSize: Math.max(1, m.underlineSize * k), strikePos: -m.strikeOffset * k, strikeSize: Math.max(1, m.strikeSize * k) };
}

/**
 * Draws one run onto ctx with (ox, oy) added to base-space positions. Units are drawn where the layout put them; a
 * `place(unit)` callback may instead give each unit its own transform (text on a path).
 */
export function drawRun(ctx, run, ox, oy, glyphScale = 1) {
  const st = run.style;
  const look = runLook(run, glyphScale);
  const fill = colorOf(st);
  const outline = new Path2D();
  let hasOutline = false;
  const others = [];
  for (const u of run.units) {
    if (u.kind === 'glyphs' && run.face) {
      for (const g of u.glyphs) {
        const p = glyphPath(run.face, g.id);
        if (!p) continue;
        addGlyph(outline, p, run, look, u.x + ox + g.x * look.gs, run.baseline + oy, g.y);
        hasOutline = true;
      }
    } else if (u.str) others.push(u);
  }
  ctx.save();
  if (hasOutline) {
    if (st.stroke && st.stroke.width > 0) {
      ctx.lineWidth = st.stroke.width;
      ctx.strokeStyle = st.stroke.color ?? '#000';
      ctx.lineJoin = 'round';
      ctx.stroke(outline);
    }
    if (look.bold) {
      ctx.lineWidth = st.size / 30;
      ctx.strokeStyle = fill;
      ctx.lineJoin = 'round';
      ctx.stroke(outline);
    }
    ctx.fillStyle = fill;
    ctx.fill(outline);
  }
  for (const u of others) drawTextUnit(ctx, run, u, look, u.x + ox, run.baseline + oy, fill);
  ctx.restore();
  // decorations run under the whole run (spaces included), as the stub's do
  if ((st.underline || st.strike) && run.advance > 0) {
    const d = decoration(run);
    ctx.fillStyle = fill;
    if (st.underline) ctx.fillRect(run.x + ox, run.baseline + oy + d.underlinePos, run.advance, d.underlineSize);
    if (st.strike) ctx.fillRect(run.x + ox, run.baseline + oy + d.strikePos, run.advance, d.strikeSize);
  }
}

/** Adds a glyph outline (font units, y up) at pen (x, baseline) with the glyph's own y offset `gy` (px, y down). */
function addGlyph(target, p, run, look, x, baseline, gy) {
  const k = run.size / run.face.upem;
  const a = look.sx * k;
  // unscaled y of the glyph origin is gy; slanting about the baseline moves it by −SKEW × sx × y
  const slant = look.italic ? SKEW : 0;
  target.addPath(p, new DOMMatrix([a, 0, slant * a, -look.sy * k, x - slant * look.sx * gy, baseline + look.sy * gy]));
}

/** A colour or fallback unit: fillText at the pen with the run's scale and slant. */
function drawTextUnit(ctx, run, u, look, x, baseline, fill) {
  const st = run.style;
  const rec = run.face;
  const css = u.kind === 'color' && rec?.fontFace ? `${u.size}px "${rec.cssFamily}"` : cssOf(st, u.size);
  ctx.save();
  ctx.translate(x, baseline);
  if (look.sx !== 1 || look.sy !== 1 || look.italic) ctx.transform(look.sx, 0, look.italic ? -SKEW * look.sx : 0, look.sy, 0, 0);
  ctx.font = css;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = fill;
  if (u.kind !== 'color' && st.stroke && st.stroke.width > 0) {
    ctx.lineWidth = st.stroke.width;
    ctx.strokeStyle = st.stroke.color ?? '#000';
    ctx.lineJoin = 'round';
    ctx.strokeText(u.str, 0, 0);
  }
  if (u.kind !== 'color' && look.bold) {
    ctx.lineWidth = st.size / 30;
    ctx.strokeStyle = fill;
    ctx.lineJoin = 'round';
    ctx.strokeText(u.str, 0, 0);
  }
  ctx.fillText(u.str, 0, 0);
  ctx.restore();
}

/**
 * Draws one shaping unit with its pen start at the current origin (0, 0) on the baseline: text on a path places each
 * unit with a translate and a rotate, then calls this. Decorations under the unit's advance.
 */
export function drawUnitAtOrigin(ctx, run, u) {
  const st = run.style;
  const look = runLook(run, 1);
  const fill = colorOf(st);
  if (u.kind === 'glyphs' && run.face) {
    const outline = new Path2D();
    let any = false;
    for (const g of u.glyphs) {
      const p = glyphPath(run.face, g.id);
      if (!p) continue;
      addGlyph(outline, p, run, look, g.x, 0, g.y);
      any = true;
    }
    if (any) {
      if (st.stroke && st.stroke.width > 0) {
        ctx.lineWidth = st.stroke.width;
        ctx.strokeStyle = st.stroke.color ?? '#000';
        ctx.lineJoin = 'round';
        ctx.stroke(outline);
      }
      if (look.bold) {
        ctx.lineWidth = st.size / 30;
        ctx.strokeStyle = fill;
        ctx.lineJoin = 'round';
        ctx.stroke(outline);
      }
      ctx.fillStyle = fill;
      ctx.fill(outline);
    }
  } else if (u.str) drawTextUnit(ctx, run, u, look, 0, 0, fill);
  const w = u.advance - (u.trk ?? 0);
  if ((st.underline || st.strike) && w > 0) {
    const d = decoration(run);
    ctx.fillStyle = fill;
    if (st.underline) ctx.fillRect(0, d.underlinePos, w, d.underlineSize);
    if (st.strike) ctx.fillRect(0, d.strikePos, w, d.strikeSize);
  }
}

// ---- bounds -----------------------------------------------------------------------------------------------------------

function allRuns(line) {
  const out = [...line.runs];
  if (line._hyphen) out.push(line._hyphen);
  if (line._marker) out.push(line._marker);
  return out;
}

/**
 * Base bounds of a layout: the stub's padded box (0.3's: the box grown by 0.3 × the largest size, the stroke and the
 * shifts) joined with the ink of every visible glyph, so swashes, marks and colour glyphs are never clipped.
 */
export function layoutBounds(layer, lay) {
  if (lay._bounds) return lay._bounds;
  let size = 0, stroke = 0, extra = 0;
  for (const line of lay.lines) for (const r of allRuns(line)) {
    const s = r.style;
    size = Math.max(size, s.size);
    stroke = Math.max(stroke, s.stroke?.width ?? 0);
    extra = Math.max(extra, Math.abs(s.baselineShift || 0) + (s.position !== 'normal' ? s.size * 0.333 : 0) + (s.fauxItalic ? s.size * 0.2 : 0) + (s.scaleY > 100 ? (s.size * (s.scaleY - 100)) / 100 : 0));
  }
  if (!size) size = layer.content ? Math.max(1, (lay.ascent || 0) / 0.8) : 48;
  const pad = Math.ceil(size * 0.3) + stroke + Math.ceil(extra);
  let x1 = layer.x - pad, y1 = layer.y - pad, x2 = layer.x + lay.width + pad, y2 = layer.y + lay.height + pad;
  for (const line of lay.lines) {
    if (!line.visible) continue;
    for (const r of allRuns(line)) {
      const look = runLook(r, line._glyphScale ?? 1);
      const k = r.face ? r.size / r.face.upem : 0;
      const grow = (r.style.stroke?.width ?? 0) + (look.bold ? r.style.size / 30 : 0) + 1;
      for (const u of r.units) {
        if (u.kind === 'glyphs' && r.face) {
          for (const g of u.glyphs) {
            const e = glyphExtents(r.face, g.id);
            if (!e || !e.width) continue;
            const gx = u.x + g.x * look.gs;
            const top = r.baseline + g.y * look.sy - e.yBearing * k * look.sy;
            const bottom = top - e.height * k * look.sy;
            const slant = look.italic ? SKEW * look.sx * Math.max(Math.abs(top - r.baseline), Math.abs(bottom - r.baseline)) : 0;
            x1 = Math.min(x1, gx + e.xBearing * k * look.sx - slant - grow);
            x2 = Math.max(x2, gx + (e.xBearing + e.width) * k * look.sx + slant + grow);
            y1 = Math.min(y1, top - grow);
            y2 = Math.max(y2, bottom + grow);
          }
        } else if (u.str) {
          x1 = Math.min(x1, u.x - grow);
          x2 = Math.max(x2, u.x + u.advance + grow);
          y1 = Math.min(y1, r.baseline - u.size * 1.1 * look.sy - grow);
          y2 = Math.max(y2, r.baseline + u.size * 0.35 * look.sy + grow);
        }
      }
    }
  }
  const b = { x: Math.floor(x1), y: Math.floor(y1), width: Math.max(1, Math.ceil(x2 - Math.floor(x1))), height: Math.max(1, Math.ceil(y2 - Math.floor(y1))) };
  Object.defineProperty(lay, '_bounds', { value: b, enumerable: false });
  return b;
}

/** The base render of a layout: { canvas, x, y } (B.2 renderText). */
export function renderLayout(layer, lay) {
  const b = layoutBounds(layer, lay);
  const canvas = createCanvas(b.width, b.height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  for (const line of lay.lines) {
    if (!line.visible) continue;
    for (const r of allRuns(line)) drawRun(ctx, r, -b.x, -b.y, r === line._hyphen || r === line._marker ? 1 : line._glyphScale ?? 1);
  }
  return { canvas, x: b.x, y: b.y };
}
