// Horizontal and Vertical Type Mask tools (0.5, type-menu-commands; ARCHITECTURE.md "0.5 features", S11.5).
//
// They are Type tools (tools/text.js TypeTool) with `mask: true`: the same options, the same editing session (the
// editor, the box handles, Ctrl to move, the type commands), Shift+T cycles them in the `text` slot. While the
// session runs the text lives on a temporary layer drawn at opacity 0, and the tool's overlay covers the canvas in
// the quick-mask red with the letters cut out of it, as in Photoshop. Committing (✓, Ctrl/Cmd+Enter, a click outside,
// another command or tool) closes the editor, turns what the text covers into a selection (its anti-aliasing, warp
// and transform included), and drops the temporary layer with its creation entry, so the whole gesture is one
// "Type Mask" entry (S11.5). Shift at the first click adds to the current selection. A Type Mask tool always starts
// new text: a click on an existing text layer does not edit it, and it does not set text on a path.
import { TypeTool, registerTypeTool } from './text.js';
import { createCanvas } from '../document.js';
import { Selection } from '../selection.js';

const RED = 'rgba(255, 0, 0, 0.5)'; // Photoshop's quick-mask overlay

export class TypeMaskTool extends TypeTool {
  constructor(app, vertical = false) {
    super(app, {
      id: vertical ? 'type-mask-vertical' : 'type-mask-horizontal',
      name: vertical ? 'Vertical Type Mask Tool' : 'Horizontal Type Mask Tool',
      icon: vertical ? 'type-mask-vertical' : 'type-mask',
      vertical,
      mask: true,
      hint: 'Click or drag to type a selection in the shape of text. Ctrl/Cmd+Enter or ✓ makes the selection, Esc cancels. Shift-click adds to the selection.',
    });
    this.maskMode = 'replace';
    this.scratch = null;
  }
  /** Only the session's own text is hit: a Type Mask tool never edits a text layer. */
  hitTextLayer(p) {
    const s = this.session;
    if (!s) return null;
    return super.hitTextLayer(p) === s.layer ? s.layer : null;
  }
  pathHit() {
    return null;
  }
  /** No placeholder text: the selection is what is typed. */
  placeholderFor() {
    return '';
  }
  onPointerDown(p) {
    if (!this.session) this.maskMode = p.shift ? 'add' : 'replace';
    super.onPointerDown(p);
  }
  beginNew(at, box) {
    super.beginNew(at, box, {});
    const l = this.session?.layer;
    // the letters show as holes in the red overlay, not as type
    if (l) {
      l.opacity = 0;
      l.name = 'Type Mask';
      l.touch();
    }
  }
  /** The selection the text covers (document space), or null when it covers nothing. */
  selectionOf(layer, doc) {
    const r = layer.render();
    const W = doc.width, H = doc.height;
    const cw = r.canvas.width, ch = r.canvas.height;
    const ox = Math.round(r.x), oy = Math.round(r.y);
    const x1 = Math.max(0, ox), y1 = Math.max(0, oy), x2 = Math.min(W, ox + cw), y2 = Math.min(H, oy + ch);
    if (x2 <= x1 || y2 <= y1) return null;
    const data = r.canvas.getContext('2d').getImageData(x1 - ox, y1 - oy, x2 - x1, y2 - y1).data;
    const mask = new Uint8ClampedArray(W * H);
    const w = x2 - x1;
    let any = false;
    for (let y = y1; y < y2; y++) {
      let k = ((y - y1) * w) * 4 + 3, o = y * W + x1;
      for (let x = x1; x < x2; x++, k += 4, o++) {
        const a = data[k];
        if (a) {
          mask[o] = a;
          any = true;
        }
      }
    }
    return any ? Selection.fromMask(W, H, mask) : null;
  }
  /** Closes the editor, makes the selection, drops the temporary layer: one "Type Mask" entry (S11.5). */
  commitSession() {
    const s = this.closeEditor();
    if (!s) return false;
    const { doc, layer } = s;
    let sel = null;
    if (layer.parent && layer.text.trim()) {
      try {
        sel = this.selectionOf(layer, doc);
      } catch (err) {
        console.warn('Type Mask: the selection could not be made', err);
      }
    }
    if (s.isNew) this.dropNew(s);
    if (sel && this.app.doc === doc) this.app.applySelection(sel, this.maskMode, 'Type Mask');
    return true;
  }
  drawOverlay(ctx, view) {
    const s = this.session;
    if (s && s.doc === view.doc) {
      try {
        this.drawMask(ctx, view, s.layer);
      } catch (err) {
        console.warn('Type Mask overlay failed', err);
      }
    }
    super.drawOverlay(ctx, view);
  }
  /** The red overlay over the document with the text cut out of it. */
  drawMask(ctx, view, layer) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    if (!this.scratch || this.scratch.width !== W || this.scratch.height !== H) this.scratch = createCanvas(W, H);
    const c = this.scratch.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    const m = ctx.getTransform().multiply(view.matrix());
    c.setTransform(m);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = RED;
    c.fillRect(0, 0, view.doc.width, view.doc.height);
    const r = layer.render();
    c.globalCompositeOperation = 'destination-out';
    c.drawImage(r.canvas, r.x, r.y);
    c.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.scratch, 0, 0);
    ctx.restore();
  }
}

/** Registers the two tools in the `text` slot in Photoshop's order (after the two Type tools: Vertical, Horizontal). */
export function installTypeMaskTools(app) {
  const v = registerTypeTool(new TypeMaskTool(app, true));
  const h = registerTypeTool(new TypeMaskTool(app, false));
  app.tools.register(v, 'text');
  app.tools.register(h, 'text');
  return { horizontal: h, vertical: v };
}
