// Ruler units and origin (ARCHITECTURE.md "0.4 features", L.10; E27). Owned by guides-snapping.
//
// Every coordinate readout (the rulers, Info, the Properties transform section, the Free Transform options bar, the
// New Guide dialog) asks app.rulers, each foreign call marked `// ruler (lib/rulers.js)`, so they all count from the
// same origin in the same unit. The origin lives in the document store (`rulerOrigin`, a 'value' collection in
// document px, D): it is saved with the document, undoable, and Image Size / Canvas Size / Crop move it with the image.
//
// Units: px, in, cm, mm, pt and picas (12 pt, Photoshop's Picas) are converted at the document resolution (72 ppi when it has none); percent is a
// percentage of the document's width (x) or height (y). The pure helpers below are what the unit tests check.

import { registerCollection, collectionSpec } from './doc-store.js';

export const UNITS = ['px', 'in', 'cm', 'mm', 'pt', 'pica', 'percent'];
export const UNIT_LABEL = { px: 'px', in: 'in', cm: 'cm', mm: 'mm', pt: 'pt', pica: 'pc', percent: '%' };
export const UNIT_NAMES = { px: 'Pixels', in: 'Inches', cm: 'Centimeters', mm: 'Millimeters', pt: 'Points', pica: 'Picas', percent: 'Percent' };

/** Document px per unit along an axis (pure). */
export function perUnitFor(unit, doc, axis) {
  const dpi = doc?.dpi || 72;
  switch (unit) {
    case 'in': return dpi;
    case 'cm': return dpi / 2.54;
    case 'mm': return dpi / 25.4;
    case 'pt': return dpi / 72;
    case 'pica': return dpi / 6; // 1 pc = 12 pt
    case 'percent': return ((axis === 'y' ? doc?.height : doc?.width) || 1) / 100;
    default: return 1;
  }
}

/** The unit a typed suffix names ('px', 'in', '"', 'cm', 'mm', 'pt', 'pc', '%', 'percent'), or null. */
export function unitFromSuffix(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t === '"' || t === 'in' || t === 'inch' || t === 'inches') return 'in';
  if (t === '%' || t === 'percent') return 'percent';
  if (t === 'px' || t === 'pixel' || t === 'pixels') return 'px';
  if (t === 'cm' || t === 'mm' || t === 'pt') return t;
  if (t === 'point' || t === 'points') return 'pt';
  if (t === 'pc' || t === 'pica' || t === 'picas') return 'pica';
  return null;
}

/**
 * A typed length ("40", "2.5 cm", "1in", "50%") as { value, unit } (unit null when none was typed), or null when it is
 * not a number. A comma works as the decimal separator.
 */
export function parseMeasure(text) {
  const m = /^\s*(-?\d*(?:[.,]\d+)?|-?\d+[.,]?)\s*([a-z%"]*)\s*$/i.exec(String(text ?? ''));
  if (!m || m[1] === '' || m[1] === '-') return null;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  if (!m[2]) return { value, unit: null };
  const unit = unitFromSuffix(m[2]);
  return unit ? { value, unit } : null;
}

/** Rounds a ruler value for display: whole pixels to 2 decimals, the other units to 3. */
export function roundForUnit(v, unit) {
  const k = unit === 'px' || unit === 'percent' ? 100 : 1000;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

export class Rulers {
  constructor(app) {
    this.app = app;
  }

  /** 'px' | 'in' | 'cm' | 'mm' | 'pt' | 'pica' | 'percent' (settings.rulerUnit). */
  unit(doc) {
    void doc;
    const u = this.app.settings?.rulerUnit ?? 'px';
    return UNIT_LABEL[u] ? u : 'px';
  }

  /** The ruler origin in document px ({ x: 0, y: 0 } is the document's top-left corner). */
  origin(doc) {
    const o = doc?.store?.get?.('rulerOrigin');
    return o && Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: o.x, y: o.y } : { x: 0, y: 0 };
  }

  /** Moves the origin as one undoable step (the ruler corner drag; `view:ruler-origin`). */
  setOrigin(doc, p, { label = 'Ruler Origin' } = {}) {
    if (!doc?.store) return false;
    const cur = this.origin(doc);
    const next = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
    if (cur.x === next.x && cur.y === next.y) return false;
    doc.store.set('rulerOrigin', next, { label });
    return true;
  }

  /** Puts the origin back on the document corner (double-click on the ruler corner). */
  resetOrigin(doc) {
    return this.setOrigin(doc, { x: 0, y: 0 }, { label: 'Reset Ruler Origin' });
  }

  /** Document px per ruler unit along an axis (in `unit` when given, else the ruler unit). */
  perUnit(doc, axis, unit = this.unit(doc)) {
    return perUnitFor(unit, doc, axis);
  }

  /** A document coordinate (or a length, with `length`: no origin) in ruler units. */
  toRuler(doc, axis, px, { length = false, unit } = {}) {
    const o = length ? 0 : this.origin(doc)[axis === 'y' ? 'y' : 'x'];
    return (px - o) / this.perUnit(doc, axis, unit);
  }

  /** A value in ruler units back to a document coordinate (or a length). */
  fromRuler(doc, axis, value, { length = false, unit } = {}) {
    const o = length ? 0 : this.origin(doc)[axis === 'y' ? 'y' : 'x'];
    return value * this.perUnit(doc, axis, unit) + o;
  }

  /** "12.5 cm": the value in ruler units, rounded, and the unit label. */
  format(doc, axis, px, opts = {}) {
    const unit = opts.unit ?? this.unit(doc);
    const v = this.toRuler(doc, axis, px, { ...opts, unit });
    return `${roundForUnit(v, unit)} ${UNIT_LABEL[unit]}`;
  }

  /**
   * A typed value in document px: "40" is in ruler units, "2 cm" / "1in" / "50%" in the unit typed. Positions count
   * from the ruler origin, lengths (`length: true`) do not. Null when the text is not a measure.
   */
  parse(doc, axis, text, { length = false } = {}) {
    const m = parseMeasure(text);
    if (!m) return null;
    return this.fromRuler(doc, axis, m.value, { length, unit: m.unit ?? this.unit(doc) });
  }

  /**
   * The grid of a document in px: { major, minor, origin } per axis. Gridline Every is settings.gridSize in
   * settings.guides.gridUnit ('px' by default); Subdivisions splits each cell; the grid starts at the ruler origin.
   */
  grid(doc, axis) {
    const s = this.app.settings ?? {};
    const unit = UNIT_LABEL[s.guides?.gridUnit] ? s.guides.gridUnit : 'px';
    const major = Math.max(0, Number(s.gridSize) || 0) * perUnitFor(unit, doc, axis);
    const subdivisions = Math.max(1, Math.min(100, Math.round(Number(s.gridSubdivisions) || 1)));
    return { major, minor: major / subdivisions, subdivisions, origin: this.origin(doc)[axis === 'y' ? 'y' : 'x'] };
  }
}

/**
 * The ruler origin through Image Size, Canvas Size, Rotate, Flip and Crop: an origin the user placed follows the image
 * (the skeleton's mapping), but the untouched origin stays on the document corner, as in Photoshop (mapping it would
 * leave the rulers counting from an odd point after Canvas Size or Rotate Arbitrary, and every position typed in New
 * Guide would be off). The skeleton registered the collection for the stub period; guides-snapping owns its meaning.
 */
export function transformOrigin(v, m) {
  if (!v || (v.x === 0 && v.y === 0)) return { x: 0, y: 0 };
  return { x: m[0] * v.x + m[2] * v.y + m[4], y: m[1] * v.x + m[3] * v.y + m[5] };
}

const originSpec = collectionSpec('rulerOrigin');
if (originSpec) registerCollection('rulerOrigin', { ...originSpec, transform: transformOrigin });

/** Creates app.rulers (app.js start() calls it before MODULES). */
export function installRulers(app) {
  app.rulers = new Rulers(app);
  return app.rulers;
}
