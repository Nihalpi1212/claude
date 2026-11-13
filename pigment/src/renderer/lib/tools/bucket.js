// Paint Bucket tool (moved out of tools/fill.js by the 0.4 skeleton; owned by patterns). It fills the similar pixels
// around a click with the foreground colour (Alt: the background colour) or a pattern. Registered after the Gradient
// tool in the same toolbox slot (MODULES puts this file right after tools/fill.js).
//
// The 'pattern' source paints the `pattern` option (a PatternRef, H: the `pattern` widget) when one is set, else the
// current pattern of app.patterns (L.6), as 0.3 painted app.currentPattern. With no pattern at all it fills with the
// colour, as 0.3 did.
import { Tool } from '../tools.js';
import { Selection, selectionOps } from '../selection.js';
import { createCanvas } from '../document.js';
import { drawBlended, drawOnMask } from '../brush.js';
import { BLEND_OPTIONS } from './fill.js';
import { sampleMerged } from '../sample.js';

export class BucketTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'bucket',
      name: 'Paint Bucket Tool',
      icon: 'bucket',
      cursor: 'crosshair',
      hint: 'Click to fill similar pixels with the foreground colour (Alt: background colour).',
      options: [
        { kind: 'select', key: 'source', label: 'Fill', options: [['foreground', 'Foreground colour'], ['pattern', 'Pattern']], default: 'foreground' },
        // shown once a `pattern` widget is registered (lib/fields.js); unknown option kinds are not drawn
        { kind: 'pattern', key: 'pattern', label: 'Pattern', default: null, when: (t) => t.opt('source') === 'pattern' },
        { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal' },
        { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
        { kind: 'number', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, default: 32 },
        { kind: 'checkbox', key: 'antialias', label: 'Anti-alias', default: true },
        { kind: 'checkbox', key: 'contiguous', label: 'Contiguous', default: true },
        { kind: 'checkbox', key: 'sampleMerged', label: 'All layers', default: false },
      ],
    });
  }
  onOptionChanged(key) {
    // the pattern picker shows with the 'pattern' source only
    if (key === 'source') this.app.tools.renderOptions();
  }
  /** The pattern to paint: the option's PatternRef, else the current pattern; a canvas or null. */
  patternCanvas() {
    const ref = this.opt('pattern');
    const data = ref ? this.app.patterns?.resolve?.(ref) : null;
    if (data) {
      const c = createCanvas(data.width, data.height);
      c.getContext('2d').putImageData(data, 0, 0);
      return c;
    }
    return this.app.patterns?.current()?.canvas ?? null;
  }
  onPointerDown(p) {
    const doc = this.doc;
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster' && !(this.app.ui.editingMask && layer.mask)) {
      this.app.rasterizePrompt(layer).then((ok) => ok && this.onPointerDown(p));
      return;
    }
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    // sample image (merged or the layer in document space)
    let img;
    const mask = this.app.ui.editingMask && layer.mask?.canvas;
    if (mask) img = layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    else if (this.opt('sampleMerged')) img = sampleMerged(this.app, doc).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height); // sample (lib/sample.js)
    else {
      const tmp = createCanvas(doc.width, doc.height);
      tmp.getContext('2d').drawImage(layer.canvas, layer.x, layer.y);
      img = tmp.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    }
    let region = selectionOps.floodFill(img, x, y, { tolerance: this.opt('tolerance') ?? 32, contiguous: this.opt('contiguous') !== false, antialias: this.opt('antialias') !== false });
    if (doc.selection && !doc.selection.isEmpty) region = selectionOps.combineMasks(region, doc.selection.mask, 'intersect');
    const sel = Selection.fromMask(doc.width, doc.height, region);
    const b = sel.bounds;
    if (!b) return;
    const color = p.alt ? this.app.settings.background : this.app.settings.foreground;
    if (!mask) layer.ensureCovers(b); // may replace layer.canvas: build the target after it
    const target = mask ? { canvas: layer.mask.canvas, x: 0, y: 0 } : { canvas: layer.canvas, x: layer.x, y: layer.y };
    const local = { x: b.x - target.x, y: b.y - target.y, width: b.width, height: b.height };
    const pattern = this.opt('source') === 'pattern' ? this.patternCanvas() : null;
    doc.history.pixels('Paint bucket', target.canvas, local, (ctx) => {
      const fillCanvas = createCanvas(b.width, b.height);
      const fctx = fillCanvas.getContext('2d');
      if (pattern) fctx.fillStyle = fctx.createPattern(pattern, 'repeat');
      else fctx.fillStyle = color;
      fctx.fillRect(0, 0, b.width, b.height);
      fctx.globalCompositeOperation = 'destination-in';
      fctx.drawImage(sel.toCanvas(), -b.x, -b.y);
      if (mask) drawOnMask(ctx, fillCanvas, local.x, local.y, this.opt('opacity') ?? 1);
      else drawBlended(ctx, fillCanvas, local.x, local.y, this.opt('blend') ?? 'normal', this.opt('opacity') ?? 1, { lockTransparency: !!layer.locked.transparency });
    }, { layer, kind: mask ? 'mask' : 'pixels' });
  }
}

export function install(app) {
  app.tools.register(new BucketTool(app), 'fill');
}
