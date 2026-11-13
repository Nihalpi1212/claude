// Adjustment frame (ARCHITECTURE.md "0.4 features", I.1; E8). pixelEditDialog (dialog mode) and the Properties
// adjustment section (panel mode) wrap an adjustment editor in it. Stub by the 0.4 skeleton, complete in behaviour
// with the plain `preset` widget; owned by adjust-tonal, which keeps these exports.
//
// Rows, top to bottom, each shown only when the editor offers it (I.2): the preset menu (the `preset` widget of the
// kind's preset kind), the editor element, the eyedropper buttons and the on-image tool button (an armed one pushes
// a canvas-capture handler, I.3; in a dialog the canvas is let through with setCanvasThrough), the Auto button
// (Alt-click: editor.auto.options()), and the Preview checkbox in dialog mode. A 0.3 editor offers none of the extra
// rows, so a 0.3 dialog looks as before.
import { createWidget } from '../fields.js';
import { adjustmentPresetKind } from './presets.js';
import { icon } from '../icons.js';

const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/**
 * buildAdjustmentFrame(app, kind, editor, { mode, sample(x, y), getParams(), setParams(params), onReset(),
 *   source?, preview? }) -> { element, dispose() }
 * `source` (an addition): the ImageDataLike Auto computes from (the session base in a dialog, the composite below in
 * a panel), or a function returning it. `preview` (an addition, dialog mode): { checked, onChange(on) } for the
 * Preview checkbox, which keeps 0.3's markup (input[data-key="__preview"]).
 */
export function buildAdjustmentFrame(app, kind, editor, opts = {}) {
  const mode = opts.mode === 'panel' ? 'panel' : 'dialog';
  const root = document.createElement('div');
  root.className = `adjust-frame adjust-frame-${mode}`;
  root.dataset.kind = kind;
  const cleanups = [];
  let armed = null; // { id, release, dialog, button }

  // ---- preset menu
  const presetKindId = adjustmentPresetKind(kind, editor);
  let presetWidget = null;
  if (presetKindId) {
    presetWidget = createWidget('preset', {
      kind: presetKindId,
      onPick: (preset) => opts.setParams?.(clone(preset.data)),
      getData: () => opts.getParams?.(),
      defaultName: 'Preset',
    }, { app });
    const r = document.createElement('div');
    r.className = 'adjust-frame-row adjust-frame-presets';
    r.appendChild(presetWidget.element);
    root.appendChild(r);
  }

  // ---- the editor
  if (editor?.element) root.appendChild(editor.element);

  // ---- eyedroppers and the on-image tool
  const disarm = () => {
    if (!armed) return;
    const a = armed;
    armed = null;
    a.release();
    if (a.dialog) app.dialogs?.setCanvasThrough?.(a.dialog, false);
    a.button?.setAttribute('aria-pressed', 'false');
  };
  const rgbaAt = (p) => (typeof opts.sample === 'function' ? opts.sample(Math.floor(p.x), Math.floor(p.y)) : null);
  const arm = (id, button, handler) => {
    const again = armed?.id === id;
    disarm();
    if (again || !app.canvasCapture) return; // a second click on the armed button disarms it
    const dialog = mode === 'dialog' ? root.closest('.dialog') : null;
    if (dialog) app.dialogs?.setCanvasThrough?.(dialog, true);
    const release = app.canvasCapture.push({ id: `adjust-frame:${id}`, cursor: handler.cursor ?? 'crosshair', ...handler });
    armed = { id, release, dialog, button };
    button.setAttribute('aria-pressed', 'true');
  };
  const tools = [];
  for (const ed of editor?.eyedroppers ?? []) {
    const b = toolButton(ed.label, ed.icon ?? 'eyedropper');
    b.dataset.eyedropper = ed.id;
    b.addEventListener('click', () => arm(`eyedropper:${ed.id}`, b, {
      down: (p) => {
        const rgba = rgbaAt(p);
        if (rgba) ed.pick(rgba, { x: p.x, y: p.y });
      },
    }));
    tools.push(b);
  }
  if (editor?.onImage) {
    const oi = editor.onImage;
    const b = toolButton(oi.label, oi.icon ?? 'hand');
    b.dataset.onImage = '';
    b.addEventListener('click', () => arm('on-image', b, {
      cursor: oi.cursor,
      down: (p, view) => oi.down?.(rgbaAt(p), p, view),
      move: (p, view, dragging) => (dragging ? oi.move?.(rgbaAt(p), p, view) : undefined),
      up: (p, view) => oi.up?.(rgbaAt(p), p, view),
    }));
    tools.push(b);
  }
  // ---- Auto
  if (editor?.auto?.run) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.dataset.act = 'auto';
    b.textContent = 'Auto';
    b.title = 'Automatic settings (Alt-click: options)';
    b.addEventListener('click', async (e) => {
      if (e.altKey && editor.auto.options) {
        await editor.auto.options();
        return;
      }
      const src = typeof opts.source === 'function' ? opts.source() : opts.source;
      if (!src) return;
      const params = editor.auto.run(src);
      if (params) opts.setParams?.(params);
    });
    tools.push(b);
  }
  if (tools.length) {
    const r = document.createElement('div');
    r.className = 'adjust-frame-row adjust-frame-tools';
    r.append(...tools);
    root.appendChild(r);
  }

  // ---- Preview (dialog mode)
  if (mode === 'dialog' && opts.preview) {
    const pv = document.createElement('label');
    pv.className = 'checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!opts.preview.checked;
    input.dataset.key = '__preview';
    input.addEventListener('change', () => opts.preview.onChange?.(input.checked));
    pv.append(input, document.createTextNode('Preview'));
    root.appendChild(pv);
  }

  // a panel's armed tool ends with the tool, the document or the section
  if (mode === 'panel') {
    cleanups.push(app.on?.('tool:changed', disarm), app.on?.('doc:closed', disarm));
  }

  let disposed = false;
  return {
    element: root,
    disarm,
    dispose() {
      if (disposed) return;
      disposed = true;
      disarm();
      for (const off of cleanups) off?.();
      presetWidget?.destroy?.();
      editor?.dispose?.();
    },
  };
}

function toolButton(label, iconName) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pbtn adjust-frame-tool';
  b.title = label;
  b.setAttribute('aria-pressed', 'false');
  b.innerHTML = icon(iconName);
  return b;
}

/**
 * (x, y) -> [r, g, b, a] | null: the full-resolution composite below an adjustment layer at a document point (what
 * the layer adjusts), cached until the document changes. adjustmentSource (adjust-ui.js) stays for histograms: it is
 * downscaled to 512 px.
 */
export function sampleBelow(app, layer) {
  let cache = null; // { key, data, width, height }
  return (x, y) => {
    const d = app.doc;
    if (!d || !layer.parent) return null;
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    const key = `${d.id}:${d.version}:${d.root.version}`;
    if (cache?.key !== key) {
      const skip = new Set();
      let found = false;
      for (const l of d.layers()) {
        if (l === layer) found = true;
        if (found) skip.add(l);
      }
      const c = d.view.compositor.composite(d, { skip });
      cache = { key, data: c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data, width: c.width };
    }
    const i = (y * cache.width + x) * 4;
    return [cache.data[i], cache.data[i + 1], cache.data[i + 2], cache.data[i + 3]];
  };
}
