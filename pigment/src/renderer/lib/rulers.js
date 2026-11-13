// Ruler units and origin (ARCHITECTURE.md "0.4 features", L.10; E27): every coordinate readout (Info, the
// Properties transform section, the Free Transform options bar) asks app.rulers, each call marked
// `// ruler (lib/rulers.js)`, so they all follow the ruler origin and units. Skeleton stub; owned by
// guides-snapping, which replaces this file and keeps its exports (installRulers, the app.rulers API).
//
// Stub behaviour: no origin ({ x: 0, y: 0 }), and 0.3's unit maths (the Info panel's fmtUnit): px, in, cm, mm, pt
// at the document resolution, percent of the document's width or height.

const UNIT_LABEL = { px: 'px', in: 'in', cm: 'cm', mm: 'mm', pt: 'pt', percent: '%' };

export class Rulers {
  constructor(app) {
    this.app = app;
  }

  /** 'px' | 'in' | 'cm' | 'mm' | 'pt' | 'percent' (settings.rulerUnit). */
  unit(doc) {
    void doc;
    const u = this.app.settings?.rulerUnit ?? 'px';
    return UNIT_LABEL[u] ? u : 'px';
  }

  /** The ruler origin in document px. Stub: the document's top-left corner. */
  origin(doc) {
    void doc;
    return { x: 0, y: 0 };
  }

  /** Document px per ruler unit along an axis. */
  perUnit(doc, axis) {
    const dpi = doc?.dpi || 72;
    switch (this.unit(doc)) {
      case 'in': return dpi;
      case 'cm': return dpi / 2.54;
      case 'mm': return dpi / 25.4;
      case 'pt': return dpi / 72;
      case 'percent': return ((axis === 'x' ? doc?.width : doc?.height) || 1) / 100;
      default: return 1;
    }
  }

  /** A document coordinate (or a length, with `length`: no origin) in ruler units. */
  toRuler(doc, axis, px, { length = false } = {}) {
    const o = length ? 0 : this.origin(doc)[axis === 'y' ? 'y' : 'x'];
    return (px - o) / this.perUnit(doc, axis);
  }

  /** A value in ruler units back to a document coordinate (or a length). */
  fromRuler(doc, axis, value, { length = false } = {}) {
    const o = length ? 0 : this.origin(doc)[axis === 'y' ? 'y' : 'x'];
    return value * this.perUnit(doc, axis) + o;
  }

  /** "12.5 cm": the value in ruler units, rounded to 2 decimals, and the unit label. */
  format(doc, axis, px, opts = {}) {
    const v = this.toRuler(doc, axis, px, opts);
    return `${Math.round(v * 100) / 100} ${UNIT_LABEL[this.unit(doc)]}`;
  }
}

/** Creates app.rulers (app.js start() calls it before MODULES). */
export function installRulers(app) {
  app.rulers = new Rulers(app);
  return app.rulers;
}
