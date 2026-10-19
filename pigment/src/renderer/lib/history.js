// Per-document undo/redo (see ARCHITECTURE.md "History"). Entries hold closures plus pixel
// patches; the memory of patches is bounded by settings.historyMemoryMB (oldest entries drop).
import { createCanvas, copyCanvas, intersectRect } from './document.js';

export class History {
  /**
   * @param {import('./document.js').Document} doc
   * @param {{ limit?: number, memoryMB?: number, onChange?: () => void }} opts
   */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.entries = [];
    this.index = -1; // index of the last applied entry
    this.savedIndex = -1;
    this.limit = opts.limit ?? 100;
    this.memoryLimit = (opts.memoryMB ?? 512) * 1024 * 1024;
    this.onChange = opts.onChange ?? (() => {});
    this.snapshots = [];
    this.stroke = null;
    this.batch = null;
  }

  get canUndo() {
    return this.index >= 0;
  }
  get canRedo() {
    return this.index < this.entries.length - 1;
  }
  get dirty() {
    return this.index !== this.savedIndex;
  }
  markSaved() {
    this.savedIndex = this.index;
    this.onChange();
  }

  /** Pushes an entry whose redo has already been applied. */
  push(entry) {
    if (this.batch) {
      this.batch.entries.push(entry);
      return entry;
    }
    this.entries.length = this.index + 1;
    this.entries.push(entry);
    this.index = this.entries.length - 1;
    if (this.savedIndex > this.index) this.savedIndex = -2; // saved state is no longer reachable
    this.trim();
    this.onChange();
    return entry;
  }

  trim() {
    let bytes = this.entries.reduce((n, e) => n + (e.bytes ?? 0), 0);
    while (this.entries.length > this.limit || (bytes > this.memoryLimit && this.entries.length > 1)) {
      const dropped = this.entries.shift();
      bytes -= dropped.bytes ?? 0;
      this.index--;
      this.savedIndex--;
    }
  }

  /**
   * Runs a mutation and records it. `mutate()` returns { undo, redo } (redo may be omitted when
   * the mutation can be replayed by calling mutate again — then pass { replay: true }).
   */
  run(label, mutate, { bytes = 0 } = {}) {
    const result = mutate();
    const entry = { label, undo: result?.undo ?? (() => {}), redo: result?.redo ?? (() => mutate()), bytes, at: Date.now() };
    this.push(entry);
    this.doc.changed('history');
    return entry;
  }

  /** Groups several run()/push() calls into one entry. */
  group(label, fn) {
    if (this.batch) return fn();
    this.batch = { label, entries: [] };
    try {
      fn();
    } finally {
      const { entries } = this.batch;
      this.batch = null;
      if (entries.length) {
        this.push({
          label,
          undo: () => {
            for (let i = entries.length - 1; i >= 0; i--) entries[i].undo();
          },
          redo: () => {
            for (const e of entries) e.redo();
          },
          bytes: entries.reduce((n, e) => n + (e.bytes ?? 0), 0),
          at: Date.now(),
        });
        this.doc.changed('history');
      }
    }
  }

  /**
   * Records a pixel change on a raster canvas (layer canvas or mask canvas) limited to rect
   * (canvas-local coordinates): captures before, runs mutate(ctx), captures after.
   */
  pixels(label, canvas, rect, mutate, { layer = null, kind = 'pixels' } = {}) {
    const r = intersectRect(rect, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    if (!r) return mutate(canvas.getContext('2d', { willReadFrequently: true }));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const before = ctx.getImageData(r.x, r.y, r.width, r.height);
    const result = mutate(ctx);
    const after = ctx.getImageData(r.x, r.y, r.width, r.height);
    layer?.touch();
    const doc = this.doc;
    this.push({
      label,
      undo: () => {
        canvas.getContext('2d').putImageData(before, r.x, r.y);
        layer?.touch();
        doc.changed(kind, { layer, rect: r });
      },
      redo: () => {
        canvas.getContext('2d').putImageData(after, r.x, r.y);
        layer?.touch();
        doc.changed(kind, { layer, rect: r });
      },
      bytes: before.data.length * 2,
      at: Date.now(),
    });
    doc.changed(kind, { layer, rect: r });
    return result;
  }

  /** Replaces a layer's whole canvas (and offset) undoably; `apply()` must return the new { canvas, x, y }. */
  replaceCanvas(label, layer, apply) {
    const before = { canvas: layer.canvas, x: layer.x, y: layer.y };
    const after = apply();
    layer.canvas = after.canvas;
    layer.x = after.x ?? layer.x;
    layer.y = after.y ?? layer.y;
    layer.touch();
    const doc = this.doc;
    const set = (s) => {
      layer.canvas = s.canvas;
      layer.x = s.x;
      layer.y = s.y;
      layer.touch();
      doc.changed('pixels', { layer });
    };
    this.push({ label, undo: () => set(before), redo: () => set({ canvas: after.canvas, x: layer.x, y: layer.y }), bytes: (before.canvas.width * before.canvas.height + after.canvas.width * after.canvas.height) * 4, at: Date.now() });
    doc.changed('pixels', { layer });
  }

  /** Starts a stroke on a canvas: keeps a copy so endStroke can diff the dirty rect into one entry. */
  beginStroke(canvas, { label = 'Brush', layer = null, kind = 'pixels' } = {}) {
    this.stroke = { canvas, backup: copyCanvas(canvas), label, layer, kind, dirty: null };
    return this.stroke;
  }

  /** Extends the stroke's dirty rect (canvas-local). */
  touchStroke(rect) {
    if (!this.stroke || !rect) return;
    const s = this.stroke;
    s.dirty = s.dirty ? unionRect(s.dirty, rect) : { ...rect };
  }

  endStroke(rect = this.stroke?.dirty) {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return null;
    const r = rect ? intersectRect(rect, { x: 0, y: 0, width: s.canvas.width, height: s.canvas.height }) : null;
    if (!r) return null;
    const before = s.backup.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.width, r.height);
    const after = s.canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.width, r.height);
    s.layer?.touch();
    const doc = this.doc;
    const { canvas, layer, kind } = s;
    const entry = this.push({
      label: s.label,
      undo: () => {
        canvas.getContext('2d').putImageData(before, r.x, r.y);
        layer?.touch();
        doc.changed(kind, { layer, rect: r });
      },
      redo: () => {
        canvas.getContext('2d').putImageData(after, r.x, r.y);
        layer?.touch();
        doc.changed(kind, { layer, rect: r });
      },
      bytes: before.data.length * 2,
      at: Date.now(),
    });
    doc.changed(kind, { layer, rect: r });
    return entry;
  }

  /** Restores the canvas to the pre-stroke pixels (cancel). */
  cancelStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    const ctx = s.canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(s.backup, 0, 0);
    ctx.restore();
    s.layer?.touch();
    this.doc.changed(s.kind, { layer: s.layer });
  }

  undo() {
    if (!this.canUndo) return false;
    const entry = this.entries[this.index];
    this.index--;
    entry.undo();
    this.onChange();
    this.doc.changed('history');
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.index++;
    this.entries[this.index].redo();
    this.onChange();
    this.doc.changed('history');
    return true;
  }

  /** Jumps to a state: -1 = before the first entry. */
  goTo(index) {
    while (this.index > index && this.undo());
    while (this.index < index && this.redo());
  }

  clear() {
    this.entries = [];
    this.index = -1;
    this.savedIndex = -1;
    this.onChange();
  }

  /** Stores a named snapshot of the full document composite for the History panel. */
  snapshot(name, canvas) {
    const copy = createCanvas(canvas.width, canvas.height);
    copy.getContext('2d').drawImage(canvas, 0, 0);
    this.snapshots.push({ name, canvas: copy, at: Date.now() });
    this.onChange();
  }
}

function unionRect(a, b) {
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width), y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
