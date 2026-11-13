// The Adjustment Brush tool (adjust-color; Photoshop 2025's): paint an adjustment onto the image. The first stroke
// makes a new adjustment layer of the kind chosen in the options bar, with a mask that hides everything, and paints
// the mask white where the brush goes; while that layer (or any adjustment layer of the same kind with a mask) stays
// selected, further strokes paint its mask. Subtract (or Alt) paints the mask black. The adjustment's settings are
// edited in the Properties panel, which opens after the first stroke. A painting tool (`paints: true`, L.12).
//
// The new layer and the first stroke are one undo step: the tool joins the two history entries it made itself.
import { StrokeTool } from './paint.js';
import { BRUSH_OPTIONS } from '../tools.js';
import { BrushStroke } from '../brush.js';
import { AdjustmentLayer, createCanvas } from '../document.js';
import { structural } from '../layer-ops.js';
import { LAYER_KINDS } from '../adjust-ui.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { registerIcons } from '../icons.js';

registerIcons({
  'adjustment-brush': '<path d="M9.06 11.9 17.1 3.86a2.1 2.1 0 0 1 3 3L12.1 14.9"/><path d="M7 14c-1.7 0-3 1.3-3 3 0 1.3-1 2-2 2 1 1.5 2.7 2 4 2 2.2 0 4-1.8 4-4 0-1.7-1.3-3-3-3z"/><circle cx="18" cy="17" r="3"/><path d="M18 14v6"/>',
});

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const DEFAULT_KIND = 'brightness-contrast';

export class AdjustmentBrushTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'adjustment-brush',
      name: 'Adjustment Brush Tool',
      icon: 'adjustment-brush',
      hint: 'Paint an adjustment onto the image: the first stroke adds an adjustment layer whose mask you paint. Alt subtracts. Change the settings in Properties.',
      options: [
        { kind: 'select', key: 'kind', label: 'Adjustment', options: LAYER_KINDS.map((k) => [k, ADJUSTMENTS[k].name]), default: DEFAULT_KIND },
        { kind: 'segment', key: 'mode', label: '', options: [['add', 'Add'], ['subtract', 'Subtract']], default: 'add' },
        ...BRUSH_OPTIONS.filter((o) => o.kind !== 'brush'),
      ],
    });
    this.paints = true; // L.12: digits set this tool's opacity
    this.created = null;
  }

  /** The adjustment layer the next stroke paints: the active one when it is of the chosen kind and has a mask. */
  targetLayer() {
    const d = this.doc;
    const kind = LAYER_KINDS.includes(this.opt('kind')) ? this.opt('kind') : DEFAULT_KIND;
    const a = d?.active;
    if (a?.type === 'adjustment' && a.kind === kind && a.mask?.canvas) return { layer: a, kind };
    return { layer: null, kind };
  }

  onPointerDown(p) {
    const d = this.doc;
    if (!d) return;
    const subtract = this.opt('mode') === 'subtract' || !!p.alt;
    let { layer, kind } = this.targetLayer();
    this.created = null;
    if (!layer) {
      if (subtract) {
        this.app.dialogs.toast('Select an adjustment layer made with this brush to subtract from it', { kind: 'error', timeout: 2200 });
        return;
      }
      if (d.active?.locked?.all) {
        this.app.dialogs.toast(`"${d.active.name}" is locked`, { kind: 'error', timeout: 1800 });
        return;
      }
      const def = this.app.adjustments?.[kind] ?? { name: ADJUSTMENTS[kind].name, defaults: ADJUSTMENTS[kind].defaults };
      const made = new AdjustmentLayer({ name: def.name, kind, params: clone(def.defaults ?? {}) });
      // a mask that hides everything: the brush reveals the adjustment where it paints (empty = transparent = hidden)
      made.mask = { canvas: createCanvas(d.width, d.height), enabled: true, linked: true };
      const ok = structural(this.app, `New ${def.name} layer`, () => {
        d.add(made);
        d.setActive(made);
      });
      if (ok === false) return;
      layer = made;
      this.created = { doc: d, entry: d.history.entries[d.history.index] };
    }
    const target = { canvas: layer.mask.canvas, x: 0, y: 0, mask: true };
    const settings = { ...this.baseSettings(layer, target), mode: 'mask', maskValue: subtract ? 0 : 1, lockTransparency: false, label: 'Adjustment Brush' };
    this.stroke = new BrushStroke({ target, layer, settings, selection: d.selection?.isEmpty === false ? d.selection : null, history: d.history, onDirty: (rect) => this.view?.invalidate(rect) });
    this.stroke.begin(p);
  }

  onPointerUp(p) {
    super.onPointerUp(p);
    const c = this.created;
    this.created = null;
    if (!c) return;
    // one undo step for "new layer + first stroke"
    const h = c.doc.history;
    const i = h.index;
    if (i >= 1 && h.entries[i - 1] === c.entry && h.entries[i] !== c.entry) {
      const a = h.entries[i - 1], b = h.entries[i];
      h.entries.splice(i - 1, 2, {
        label: a.label,
        undo: () => {
          b.undo();
          a.undo();
        },
        redo: () => {
          a.redo();
          b.redo();
        },
        bytes: (a.bytes ?? 0) + (b.bytes ?? 0),
        at: Date.now(),
      });
      h.index = i - 1;
      h.onChange();
      c.doc.changed('history');
    }
    if (this.app.panels?.panels?.has('properties')) this.app.panels.show('properties', { reveal: true });
  }

  cancel() {
    const had = super.cancel();
    this.created = null;
    return had;
  }
}

export function installAdjustmentBrush(app) {
  if (app.tools.get('adjustment-brush')) return;
  app.tools.register(new AdjustmentBrushTool(app), 'brush');
}
