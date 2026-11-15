// Pattern paints (patterns package; ARCHITECTURE.md "0.4 features", G.2, G.3, G.5, L.9): the 'pattern' paint
// renderer, the 'pattern' paint editor (Layer > New Fill Layer > Pattern, Layer Content Options, the Properties fill
// section) and the drop handler that makes a Pattern Fill layer from a pattern dragged out of the Patterns panel.
//
// PatternPaint (G.2): { canvas, scale (1 = 100 %), angle (degrees, counter-clockwise as in Photoshop), link (Link
// with Layer), origin ([x, y] document px: where the tiling starts, moved by dragging in the Pattern Fill dialog;
// Snap to Origin puts it back to [0, 0]), presetId, name }.
//
// Where the tiles start (the anchor): with Link with Layer on, the placement box's top-left corner (fill layers: the
// document, so the document origin; shapes: the shape's bounds, so the pattern travels with the shape); off, the
// document origin whatever the box. A paint without `link` (0.3's) keeps 0.3's anchor, the context's (0, 0), so old
// documents draw as before. `origin` is added to the anchor, then the tiles are turned by `angle` and scaled around it.
import { registerPaintRenderer } from './paint.js';
import { registerPaintEditor } from './paint-editors.js';
import { formDialog } from './form.js';
import { numericField } from './numeric-field.js';
import { PATTERN_MIME, patternFromCanvas } from './patterns.js';
import { patternWidget } from './pattern-widget.js';

/** The renderer (G.3): a CanvasPattern placed by link, origin, angle and scale. */
export function patternPaintStyle(ctx, paint, box, opts = {}) {
  const p = paint?.pattern;
  if (!p?.canvas) return 'transparent';
  const pat = ctx.createPattern(p.canvas, 'repeat');
  if (!pat) return 'transparent';
  const m = patternMatrix(p, box, opts.origin ?? [0, 0]);
  if (!m.isIdentity) pat.setTransform(m);
  return pat;
}

/** The pattern space -> ctx space matrix of a PatternPaint (see the file comment). */
export function patternMatrix(p, box, origin = [0, 0]) {
  const scale = Number(p.scale) > 0 ? Number(p.scale) : 1;
  const angle = Number(p.angle) || 0;
  const off = Array.isArray(p.origin) ? p.origin : [0, 0];
  let ax = 0, ay = 0;
  if (p.link === false) {
    ax = -origin[0];
    ay = -origin[1];
  } else if (p.link === true) {
    ax = box?.x ?? 0;
    ay = box?.y ?? 0;
  }
  let m = new DOMMatrix().translate(ax + (Number(off[0]) || 0), ay + (Number(off[1]) || 0));
  if (angle) m = m.rotate(-angle);
  if (scale !== 1) m = m.scale(scale);
  return m;
}

const urls = new WeakMap(); // pattern canvas -> its data URL (encoded once; the paint object stays as it is)

/** The ref of a paint's pattern (for the widget): its pixels as a data URL, plus where it came from. */
export function paintRef(paint) {
  const p = paint?.pattern;
  if (!p?.canvas) return null;
  let url = urls.get(p.canvas);
  if (!url) {
    url = patternFromCanvas(p.canvas);
    urls.set(p.canvas, url);
  }
  return { dataUrl: url, ...(p.presetId ? { presetId: p.presetId } : {}), ...(p.name ? { name: p.name } : {}) };
}

/** A pattern paint from a library entry or a ref's canvas. */
export function makePatternPaint(canvas, { scale = 1, angle = 0, link = true, origin = [0, 0], presetId, name } = {}) {
  return { type: 'pattern', pattern: { canvas, scale, angle, link, origin: [origin[0], origin[1]], ...(presetId ? { presetId } : {}), ...(name ? { name } : {}) } };
}

const fieldsOf = (paint) => {
  const p = paint?.pattern ?? {};
  return { scale: Math.round((p.scale ?? 1) * 1000) / 10, angle: Number(p.angle) || 0, link: p.link !== false, origin: Array.isArray(p.origin) ? [...p.origin] : [0, 0] };
};

/**
 * The Pattern Fill dialog (Layer Content Options of a Pattern Fill layer): the pattern, Angle, Scale, Link with Layer
 * and Snap to Origin; while it is open, dragging in the document moves the pattern. Previews through `live`.
 */
export async function editPatternFill(app, layer, paint, { live = () => {} } = {}) {
  let canvas = paint.pattern?.canvas ?? null;
  let ref = paintRef(paint);
  const start = fieldsOf(paint);
  const build = (v) => makePatternPaint(canvas, { scale: Math.max(0.01, v.scale / 100), angle: v.angle, link: !!v.link, origin: v.origin, presetId: ref?.presetId, name: ref?.name });
  let form = null;
  let release = null;
  const values = await formDialog(app, {
    title: 'Pattern Fill',
    className: 'pattern-fill-dialog',
    width: 420,
    intro: 'Drag in the document to move the pattern.',
    fields: [
      { key: 'pattern', label: 'Pattern', type: 'pattern', value: ref },
      { key: 'angle', label: 'Angle', type: 'slider', value: start.angle, min: -180, max: 180, unit: '°' },
      { key: 'scale', label: 'Scale', type: 'slider', value: start.scale, min: 1, max: 1000, unit: '%' },
      { key: 'link', label: 'Link with Layer', type: 'checkbox', value: start.link },
      {
        key: 'origin',
        type: 'custom',
        value: start.origin,
        render: (v, set) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn small';
          b.dataset.act = 'snap-origin';
          b.textContent = 'Snap to Origin';
          b.title = 'Start the pattern at the document origin';
          b.addEventListener('click', () => set('origin', [0, 0]));
          return b;
        },
      },
    ],
    onChange: (v, key, f) => {
      form = f;
      if (key !== 'pattern') return;
      ref = v.pattern;
      app.patterns.canvasOf(ref).then((c) => {
        if (!c || ref !== v.pattern) return;
        canvas = c;
        f.set('rev', (f.values.rev ?? 0) + 1); // previews again with the new pixels
      });
    },
    onOpen: (dialog, f) => {
      form = f;
      // the document under the dialog takes the drag (I.3): the pattern's origin follows the pointer
      app.dialogs.setCanvasThrough?.(dialog, true);
      let drag = null;
      release = app.canvasCapture?.push({
        id: 'pattern-fill-move',
        cursor: 'move',
        down: (p) => {
          drag = { x: p.x, y: p.y, origin: [...(form.values.origin ?? [0, 0])] };
        },
        move: (p, view, dragging) => {
          if (!drag || dragging === false) return;
          form.set('origin', [Math.round(drag.origin[0] + p.x - drag.x), Math.round(drag.origin[1] + p.y - drag.y)]);
        },
        up: () => {
          drag = null;
        },
      }) ?? null;
    },
    live: { apply: (v) => live(build(v)), revert: () => live(null) },
  });
  release?.();
  if (!values || !canvas) return null;
  const next = build(values);
  const same = JSON.stringify(fieldsOf(next)) === JSON.stringify(start) && next.pattern.canvas === paint.pattern?.canvas;
  return same ? null : next;
}

/** The Properties fill section body of a Pattern Fill layer: pattern, Angle, Scale, Link with Layer, Snap to Origin. */
export function patternFillSection(app, layer, paint, onChange) {
  const box = document.createElement('div');
  box.className = 'pattern-fill-section';
  const v = fieldsOf(paint);
  let canvas = paint.pattern?.canvas ?? null;
  let ref = paintRef(paint);
  const commit = () => onChange(makePatternPaint(canvas, { scale: Math.max(0.01, v.scale / 100), angle: v.angle, link: v.link, origin: v.origin, presetId: ref?.presetId, name: ref?.name }));
  const row = (label, control, key) => {
    const r = document.createElement('div');
    r.className = 'prop-row';
    if (key) r.dataset.key = key;
    const l = document.createElement('span');
    l.textContent = label;
    r.append(l, control);
    box.appendChild(r);
  };
  const widget = patternWidget({ compact: true }, {
    app,
    value: ref,
    onChange: async (next) => {
      const c = await app.patterns.canvasOf(next);
      if (!c) return;
      canvas = c;
      ref = next;
      commit();
    },
  });
  row('Pattern', widget.element, 'pattern');
  const num = (key, label, min, max, unit, step = 1) => {
    const f = numericField({ key, min, max, step, unit, width: 60, value: v[key], onChange: (n) => {
      if (n === v[key]) return;
      v[key] = n;
      commit();
    } });
    row(label, f.element, key);
  };
  num('angle', 'Angle', -180, 180, '°', 0.1);
  num('scale', 'Scale', 1, 1000, '%', 0.1);
  const flags = document.createElement('div');
  flags.className = 'prop-row pattern-fill-flags';
  const l = document.createElement('label');
  l.className = 'checkbox';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.key = 'link';
  cb.checked = v.link;
  cb.addEventListener('change', () => {
    v.link = cb.checked;
    commit();
  });
  l.append(cb, document.createTextNode(' Link with Layer'));
  const snap = document.createElement('button');
  snap.type = 'button';
  snap.className = 'btn small';
  snap.dataset.act = 'snap-origin';
  snap.textContent = 'Snap to Origin';
  snap.disabled = !v.origin[0] && !v.origin[1];
  snap.addEventListener('click', () => {
    v.origin = [0, 0];
    commit();
  });
  flags.append(l, snap);
  box.appendChild(flags);
  return box;
}

// ---- New Fill Layer and the drop handler ---------------------------------------------------------------------------------

let dropped = null; // the paint a drop asked layer:new-fill to use (no dialog then)

/** A Pattern Fill layer from a dropped PatternRef (JSON), above `target` (or the active layer). */
export async function dropPattern(app, data, target = null) {
  const doc = app.doc;
  if (!doc) return;
  let ref;
  try {
    ref = JSON.parse(data);
  } catch {
    return;
  }
  const canvas = await app.patterns.canvasOf(ref);
  if (!canvas) return;
  if (target) doc.setActive(target);
  dropped = makePatternPaint(canvas, { presetId: ref.presetId, name: ref.name });
  try {
    await app.commands.run('layer:new-fill', 'pattern', 'api');
  } finally {
    dropped = null;
  }
}

export function installPatternPaint(app) {
  registerPaintRenderer('pattern', (ctx, paint, box, opts) => patternPaintStyle(ctx, paint, box, opts));
  registerPaintEditor('pattern', {
    label: 'Pattern',
    // New Fill Layer > Pattern: the current pattern, then the Pattern Fill dialog live on the new layer (as the
    // gradient editor does); a drop makes the layer without a dialog
    get editAfterCreate() {
      return !dropped;
    },
    async create(app2) {
      if (dropped) return dropped;
      await app2.patterns.ready?.();
      const current = app2.patterns.current();
      if (!current?.canvas) {
        app2.dialogs.toast('Define a pattern first (Edit › Define Pattern)', { kind: 'error' });
        return null;
      }
      return makePatternPaint(current.canvas, { presetId: current.id, name: current.name });
    },
    edit: (app2, layer, paint, { live }) => editPatternFill(app2, layer, paint, { live }),
    section: (app2, layer, paint, onChange) => patternFillSection(app2, layer, paint, onChange),
  });
  app.registerDropHandler?.(PATTERN_MIME, {
    canvas: (data) => dropPattern(app, data),
    layer: (data, layer) => dropPattern(app, data, layer),
  });
}
