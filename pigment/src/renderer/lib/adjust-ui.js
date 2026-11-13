// Image › Adjustments: dialogs with live preview on the canvas, Levels/Curves editors, auto tone,
// Fade, adjustment-layer editors (shared with the Properties panel) and fill-layer editing.
// Destructive edits run through a "pixel edit session" (also used by filter-ui.js) that limits
// the change to the selection, previews in place and records one undo entry.
import { ADJUSTMENTS, ADJUSTMENT_KINDS, applyAdjustment, autoLevels, autoContrast, autoColor } from '../../shared/pixels/adjust.js';
import { tonalSpace, clippingView, weightedHistogram, autoLevelsParams, autoOptions } from '../../shared/pixels/adjust-tonal.js';
import { CANVAS_BLEND, blendImages } from '../../shared/pixels/blend.js';
import { BLEND_MODES, createCanvas, intersectRect } from './document.js';
import { buildForm, formDialog, frameThrottle } from './form.js';
import { flattenDocument } from './compositor.js';
import { setLayerProps } from './layer-ops.js';
import { editPaint } from './paint-editors.js';
import { buildAdjustmentFrame } from './adjust/frame.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export const ADJUSTMENT_ICONS = {
  'brightness-contrast': 'adjust', levels: 'adjust', curves: 'adjust', exposure: 'adjust', vibrance: 'color', 'hue-saturation': 'color',
  'color-balance': 'color', 'black-white': 'adjust', 'photo-filter': 'color', 'channel-mixer': 'channels', invert: 'adjust',
  posterize: 'adjust', threshold: 'adjust', 'gradient-map': 'gradient', 'selective-color': 'color', desaturate: 'adjust',
  equalize: 'adjust', 'shadows-highlights': 'adjust',
};

/** Kinds that make sense as adjustment layers (Photoshop's list), plus registry kinds flagged `layer: true` once implemented (Color Lookup). */
const BASE_LAYER_KINDS = ['brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation', 'color-balance', 'black-white', 'photo-filter', 'channel-mixer', 'invert', 'posterize', 'threshold', 'gradient-map', 'selective-color'];
export const LAYER_KINDS = [...BASE_LAYER_KINDS, ...ADJUSTMENT_KINDS.filter((k) => ADJUSTMENTS[k].layer && !ADJUSTMENTS[k].placeholder && !BASE_LAYER_KINDS.includes(k))];
// Color Lookup sits after Channel Mixer in Photoshop's lists
if (LAYER_KINDS.includes('color-lookup')) LAYER_KINDS.splice(LAYER_KINDS.indexOf('channel-mixer') + 1, 0, ...LAYER_KINDS.splice(LAYER_KINDS.indexOf('color-lookup'), 1));

/**
 * Custom adjustment editors (0.3): lib/adjust-more-ui.js registers { editor(kind, params, onChange, { source }) ->
 * { element }, width?, start?(app) -> params } for kinds whose dialog is more than a list of fields (Color Lookup,
 * HDR Toning, Match Color, Replace Color). buildAdjustmentEditor() and the Image > Adjustments dialogs consult it.
 */
export const ADJUST_EDITORS = new Map();
/** Destructive-only kinds (no adjustment layer). */
const DIRECT_ONLY = ['desaturate', 'equalize', 'shadows-highlights'];
const NO_PARAMS = new Set(['invert', 'desaturate', 'equalize']);
/**
 * Dialogs that open with their last settings, as in Photoshop (and 0.3): Shadows/Highlights, Replace Color, Match
 * Color, HDR Toning, Color Lookup. The others open with the defaults since 0.4; Alt+Ctrl+L / M / U / B reopen Levels,
 * Curves, Hue/Saturation and Color Balance with the last values (adjust-tonal).
 */
const REMEMBERS_LAST = new Set(['shadows-highlights', 'replace-color', 'match-color', 'hdr-toning', 'color-lookup']);
/** Where Photoshop's dialogs start (the engine's defaults are the identity). */
const START_VALUES = { 'photo-filter': { density: 25 }, 'shadows-highlights': { shadows: 35 } };
const startParams = (kind) => ({ ...clone(ADJUSTMENTS[kind].defaults), ...(START_VALUES[kind] ?? {}) });

// ---- path helpers --------------------------------------------------------------------------------------------

export function getPath(obj, path) {
  let v = obj;
  for (const k of path.split('.')) {
    if (v === null || v === undefined) return undefined;
    v = v[k];
  }
  return v;
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let v = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (v[k] === null || v[k] === undefined || typeof v[k] !== 'object') v[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    v = v[k];
  }
  v[keys[keys.length - 1]] = value;
}

// ---- generic field specs ------------------------------------------------------------------------------------

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const CB = (key, label, extra = {}) => ({ key, label, type: 'checkbox', ...extra });

const HUE_RANGES = [['master', 'Master'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas']];
const SEL_RANGES = [['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['whites', 'Whites'], ['neutrals', 'Neutrals'], ['blacks', 'Blacks']];
const TONES = [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']];

function fieldSpecs(kind, params) {
  switch (kind) {
    case 'brightness-contrast':
      return [S('brightness', 'Brightness', -150, 150), S('contrast', 'Contrast', -100, 100), CB('legacy', 'Use legacy')];
    case 'exposure':
      return [S('exposure', 'Exposure', -20, 20, 0.01), S('offset', 'Offset', -0.5, 0.5, 0.0001), S('gamma', 'Gamma correction', 0.01, 9.99, 0.01)];
    case 'vibrance':
      return [S('vibrance', 'Vibrance', -100, 100), S('saturation', 'Saturation', -100, 100)];
    case 'hue-saturation': {
      const off = (v) => !v.colorize, on = (v) => !!v.colorize;
      return [
        { key: 'range', label: 'Range', type: 'select', options: HUE_RANGES, when: off },
        S('hue', 'Hue', -180, 180, 1, { when: off }),
        S('saturation', 'Saturation', -100, 100, 1, { when: off }),
        S('lightness', 'Lightness', -100, 100, 1, { when: off }),
        CB('colorize', 'Colorize'),
        S('colorizeHue', 'Hue', 0, 360, 1, { when: on }),
        S('colorizeSat', 'Saturation', 0, 100, 1, { when: on }),
        S('colorizeLight', 'Lightness', -100, 100, 1, { when: on }),
      ];
    }
    case 'color-balance': {
      const out = [{ key: '__tone', label: 'Tone', type: 'segment', options: TONES, value: 'midtones', span: true }];
      for (const [t] of TONES) {
        const when = (v) => v.__tone === t;
        out.push(S(`${t}.0`, 'Cyan ↔ Red', -100, 100, 1, { when }), S(`${t}.1`, 'Magenta ↔ Green', -100, 100, 1, { when }), S(`${t}.2`, 'Yellow ↔ Blue', -100, 100, 1, { when }));
      }
      out.push(CB('preserveLuminosity', 'Preserve luminosity'));
      return out;
    }
    case 'black-white': {
      const tint = (v) => !!v.__tint;
      return [
        S('reds', 'Reds', -200, 300), S('yellows', 'Yellows', -200, 300), S('greens', 'Greens', -200, 300),
        S('cyans', 'Cyans', -200, 300), S('blues', 'Blues', -200, 300), S('magentas', 'Magentas', -200, 300),
        CB('__tint', 'Tint', { value: !!params.tint }),
        S('tint.hue', 'Hue', 0, 360, 1, { when: tint, value: params.tint?.hue ?? 42 }),
        S('tint.sat', 'Saturation', 0, 100, 1, { when: tint, value: params.tint?.sat ?? 20 }),
      ];
    }
    case 'photo-filter':
      return [{ key: 'color', label: 'Filter color', type: 'color' }, S('density', 'Density', 0, 100), CB('preserveLuminosity', 'Preserve luminosity')];
    case 'channel-mixer': {
      const out = [CB('monochrome', 'Monochrome'), { key: '__out', label: 'Output channel', type: 'select', value: 'r', options: [['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], when: (v) => !v.monochrome }];
      for (const o of ['r', 'g', 'b', 'gray']) {
        const when = o === 'gray' ? (v) => !!v.monochrome : (v) => !v.monochrome && v.__out === o;
        out.push(S(`${o}.r`, 'Red', -200, 200, 1, { when }), S(`${o}.g`, 'Green', -200, 200, 1, { when }), S(`${o}.b`, 'Blue', -200, 200, 1, { when }), S(`${o}.constant`, 'Constant', -200, 200, 1, { when }));
      }
      return out;
    }
    case 'posterize':
      return [S('levels', 'Levels', 2, 255)];
    case 'threshold':
      return [S('level', 'Threshold level', 1, 255)];
    case 'gradient-map': {
      const n = Math.max(2, params.stops?.length ?? 2);
      return [{ key: 'stops.0.color', label: 'Shadows', type: 'color' }, { key: `stops.${n - 1}.color`, label: 'Highlights', type: 'color' }, CB('reverse', 'Reverse')];
    }
    case 'selective-color': {
      const out = [{ key: '__range', label: 'Colors', type: 'select', value: 'reds', options: SEL_RANGES, span: true }];
      for (const [r] of SEL_RANGES) {
        const when = (v) => v.__range === r;
        out.push(S(`${r}.c`, 'Cyan', -100, 100, 1, { when }), S(`${r}.m`, 'Magenta', -100, 100, 1, { when }), S(`${r}.y`, 'Yellow', -100, 100, 1, { when }), S(`${r}.k`, 'Black', -100, 100, 1, { when }));
      }
      out.push({ key: 'relative', label: 'Method', type: 'segment', options: [[true, 'Relative'], [false, 'Absolute']] });
      return out;
    }
    case 'shadows-highlights':
      return [S('shadows', 'Shadows amount', 0, 100), S('highlights', 'Highlights amount', 0, 100), S('radius', 'Tonal width (radius)', 0, 250)];
    default:
      // registry kinds may declare their dialog fields as data (adjust-def.js `fields`)
      return ADJUSTMENTS[kind]?.fields ? clone(ADJUSTMENTS[kind].fields) : [];
  }
}

/** Values for buildForm from params (paths), with defaults filled in. */
function formValues(kind, params, fields) {
  const def = ADJUSTMENTS[kind]?.defaults ?? {};
  const v = {};
  for (const f of fields) {
    if (!f.key) continue;
    if (f.key.startsWith('__')) v[f.key] = f.value;
    else {
      const x = getPath(params, f.key);
      v[f.key] = x ?? getPath(def, f.key) ?? f.value ?? (f.type === 'checkbox' ? false : f.type === 'color' ? '#000000' : 0);
    }
  }
  return v;
}

function paramsFromForm(kind, base, values, fields) {
  const p = clone(base) ?? {};
  for (const f of fields) {
    if (!f.key || f.key.startsWith('__')) continue;
    if (kind === 'black-white' && f.key.startsWith('tint.')) continue;
    setPath(p, f.key, values[f.key]);
  }
  if (kind === 'black-white') p.tint = values.__tint ? { hue: values['tint.hue'] ?? 42, sat: values['tint.sat'] ?? 20 } : null;
  if (kind === 'channel-mixer' && p.monochrome && !p.gray) p.gray = { r: 40, g: 40, b: 20, constant: 0 };
  return p;
}

/**
 * Editor element for an adjustment's parameters. onChange(params) fires on every edit.
 * source: ImageDataLike used for histograms (Levels, Curves). Further options reach registered editors unchanged
 * (adjust-tonal: `clip(which | null)`, the dialog's clipping display).
 */
export function buildAdjustmentEditor(kind, params, onChange, { source = null, app = null, ...rest } = {}) {
  const base = { ...clone(ADJUSTMENTS[kind]?.defaults ?? {}), ...clone(params ?? {}) };
  const custom = ADJUST_EDITORS.get(kind);
  // a registered editor may return, besides `element`, the capabilities of I.2 (setParams, presetKind, eyedroppers,
  // onImage, auto, dispose): the adjustment frame (lib/adjust/frame.js) offers them. Levels, Curves, Exposure,
  // Threshold and Brightness/Contrast are registered by lib/adjust/tonal.js (adjust-tonal).
  if (custom?.editor) return custom.editor(kind, base, onChange, { source, app, ...rest });
  const fields = fieldSpecs(kind, base);
  if (!fields.length) {
    const el = document.createElement('p');
    el.className = 'muted';
    el.textContent = 'This adjustment has no settings.';
    return { element: el };
  }
  let current = base;
  const form = buildForm(fields, {
    values: formValues(kind, base, fields),
    onChange: (values) => {
      current = paramsFromForm(kind, current, values, fields);
      onChange(clone(current));
    },
  });
  return { element: form.element, form };
}

// ---- pixel edit sessions ------------------------------------------------------------------------------------

/**
 * Starts a destructive edit of the active pixels (layer or mask) limited to the selection.
 * Returns { base, rect, show(img), commit(label), cancel() } or null. `base` is an ImageDataLike
 * copy of the affected region (colour for layers, grey for masks); show() previews a processed
 * copy of base in place.
 */
export function beginPixelEdit(app, { quiet = false, label = 'Edit', margin = 0, ignoreSelection = false } = {}) {
  const d = app.doc;
  if (!d) return null;
  const t = app.pixelTarget?.({ quiet });
  if (!t) return null;
  const canvas = t.canvas;
  // ignoreSelection (adjust-tonal): the whole layer (Equalize entire image based on selected area)
  const sel = !ignoreSelection && d.selection && !d.selection.isEmpty ? d.selection : null;
  const layerRect = { x: t.x, y: t.y, width: canvas.width, height: canvas.height };
  // neighbourhood filters read a margin around the selection so its edges blend with the surroundings
  const selRect = sel && margin > 0 ? { x: sel.bounds.x - margin, y: sel.bounds.y - margin, width: sel.bounds.width + margin * 2, height: sel.bounds.height + margin * 2 } : sel?.bounds;
  const docRect = sel ? intersectRect(selRect, layerRect) : layerRect;
  if (!docRect) {
    if (!quiet) app.dialogs.toast('The selected area is empty on this layer', { kind: 'error' });
    return null;
  }
  const local = { x: docRect.x - t.x, y: docRect.y - t.y, width: docRect.width, height: docRect.height };
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const original = ctx.getImageData(local.x, local.y, local.width, local.height);
  // selection alpha for the region
  let selAlpha = null;
  if (sel) {
    selAlpha = new Uint8ClampedArray(local.width * local.height);
    for (let y = 0; y < local.height; y++) {
      const sy = docRect.y + y;
      if (sy < 0 || sy >= d.height) continue;
      for (let x = 0; x < local.width; x++) {
        const sx = docRect.x + x;
        if (sx < 0 || sx >= d.width) continue;
        selAlpha[y * local.width + x] = sel.mask[sy * d.width + sx];
      }
    }
  }
  const isMask = !!t.mask;
  // masks are edited as grey images (alpha -> grey)
  const toWork = (img) => {
    const data = new Uint8ClampedArray(img.data);
    if (isMask) for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = data[i + 3];
      data[i + 3] = 255;
    }
    return { width: img.width, height: img.height, data };
  };
  const base = toWork(original);
  let shown = false;
  // While a preview sits on the canvas the document counts it in `previewHolds`: those pixels are not an edit yet.
  // lib/depth.js waits for the count to reach zero before it lets 16/32-bit samples follow the 8-bit canvas, or
  // a session left open for a moment would round the samples under the preview for good, even when cancelled.
  let held = false;
  const hold = (on) => {
    if (held === on) return;
    held = on;
    d.previewHolds = Math.max(0, (d.previewHolds ?? 0) + (on ? 1 : -1));
  };
  const compose = (img) => {
    const out = new ImageData(local.width, local.height);
    const o = out.data, src = original.data, res = img.data;
    for (let i = 0, p = 0; i < o.length; i += 4, p++) {
      let r, g, b, a;
      if (isMask) {
        const grey = (res[i] * 299 + res[i + 1] * 587 + res[i + 2] * 114) / 1000;
        r = g = b = 255;
        a = grey;
      } else {
        r = res[i];
        g = res[i + 1];
        b = res[i + 2];
        a = res[i + 3];
      }
      if (selAlpha) {
        const k = selAlpha[p] / 255;
        o[i] = src[i] + (r - src[i]) * k;
        o[i + 1] = src[i + 1] + (g - src[i + 1]) * k;
        o[i + 2] = src[i + 2] + (b - src[i + 2]) * k;
        o[i + 3] = src[i + 3] + (a - src[i + 3]) * k;
      } else {
        o[i] = r;
        o[i + 1] = g;
        o[i + 2] = b;
        o[i + 3] = a;
      }
    }
    return out;
  };
  const session = {
    target: t,
    base,
    rect: docRect,
    local,
    show(img) {
      // image modes (lib/modes.js) snap edited colours to the mode: grey, black/white or the colour table
      if (!isMask && app.pixelConstraint) img = app.pixelConstraint(d, img, t.layer) ?? img;
      hold(true);
      ctx.putImageData(compose(img), local.x, local.y);
      shown = true;
      t.layer.touch();
      d.changed(isMask ? 'mask' : 'pixels', { layer: t.layer, rect: docRect });
    },
    restore() {
      if (!shown) return;
      ctx.putImageData(original, local.x, local.y);
      shown = false;
      hold(false);
      t.layer.touch();
      d.changed(isMask ? 'mask' : 'pixels', { layer: t.layer, rect: docRect });
    },
    cancel() {
      session.restore();
    },
    /**
     * Records the current (shown) state as one undo entry; img (optional) is applied first. `meta` describes
     * the edit for listeners of 'pixels:committed' ({ adjustment: { kind, params } } or { filter: { kind, params } }),
     * which lib/depth.js uses to redo the edit on 16/32-bit pixels instead of taking the 8-bit result.
     */
    commit(entryLabel = label, img = null, meta = {}) {
      if (img) session.show(img);
      if (!shown) return null;
      hold(false); // what is on the canvas is the edit now
      const after = ctx.getImageData(local.x, local.y, local.width, local.height);
      // An image mode that snaps pixels (lib/modes.js) can take the whole edit back: Levels on a Bitmap document ends
      // as the same black and white. Nothing changed, so nothing is recorded and the document is not marked modified
      // (16/32-bit documents excepted: their samples can move where the 8-bit proxy does not).
      if (!isMask && app.pixelConstraint && !(d.depth > 8) && samePixels(after.data, original.data)) {
        shown = false;
        return null;
      }
      const apply = (data) => {
        canvas.getContext('2d').putImageData(data, local.x, local.y);
        t.layer.touch();
        d.changed(isMask ? 'mask' : 'pixels', { layer: t.layer, rect: docRect });
      };
      const entry = { label: entryLabel, undo: () => apply(original), redo: () => apply(after), bytes: original.data.length * 2, at: Date.now() };
      d.history.push(entry);
      d.changed('history');
      app.lastPixelEdit = { doc: d, entry, label: entryLabel, canvas, local, original, after, layer: t.layer, isMask };
      app.commands.invalidate();
      app.emit('pixels:committed', { doc: d, layer: t.layer, rect: docRect, local, isMask, original, after, entry, meta: meta ?? {} });
      return after;
    },
  };
  return session;
}

function samePixels(a, b) {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2), y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** The adjustment ctx (I.4) of a pixel edit session: its base image starts at the document point session.rect. */
export function editCtx(app, session) {
  const d = app.doc;
  return session?.rect ? { origin: { x: session.rect.x, y: session.rect.y }, docWidth: d?.width ?? session.rect.width, docHeight: d?.height ?? session.rect.height, scale: 1 } : null;
}

/** Runs fn(img) on a copy of the session base and returns it. */
export function processed(session, fn) {
  const img = { width: session.base.width, height: session.base.height, data: new Uint8ClampedArray(session.base.data) };
  fn(img);
  return img;
}

/**
 * Generic dialog driving a pixel edit: editor(onChange, session, { refresh }) -> { element }, run(img, params,
 * session, { preview }) edits img in place (`preview` is false for the committed result; refresh() redraws the
 * preview). Resolves with the params (committed) or null. `frame: { kind }` (0.4, I.1) wraps the editor in the adjustment
 * frame (preset menu, eyedroppers, on-image tool, Auto, Preview: each row only when the editor offers it); the filter
 * dialogs pass none and look as in 0.3.
 */
export async function pixelEditDialog(app, { title, label = title, params, editor, run, width = 420, extraButtons, margin = 0, meta = null, frame = null }) {
  const session = beginPixelEdit(app, { label, margin });
  if (!session) return null;
  let current = params;
  let preview = app.settings.dialogPreview !== false;
  let done = false;
  const refresh = frameThrottle(() => {
    if (done) return;
    if (!preview) return session.restore();
    try {
      session.show(processed(session, (img) => run(img, current, session, { preview: true })));
    } catch (err) {
      console.error(err);
    }
  });
  let built = null;
  const ed = editor((p) => {
    current = p;
    built?.paramsChanged?.(p);
    refresh();
  }, session, { refresh: () => refresh() });
  const setPreview = (on) => {
    preview = on;
    app.settings.dialogPreview = preview;
    app.saveSettingsSoon();
    refresh();
  };
  let content;
  let onReset;
  if (frame?.kind) {
    // the adjustment frame (lib/adjust/frame.js, I.1): it samples the session base (the pixels before the edit)
    const base = session.base, rect = session.rect;
    const start = clone(params);
    const setParams = (p) => {
      current = clone(p);
      ed.setParams?.(current);
      refresh();
    };
    built = buildAdjustmentFrame(app, frame.kind, ed, {
      mode: 'dialog',
      sample: (x, y) => {
        const ix = x - rect.x, iy = y - rect.y;
        if (ix < 0 || iy < 0 || ix >= base.width || iy >= base.height) return null;
        const i = (iy * base.width + ix) * 4;
        return [base.data[i], base.data[i + 1], base.data[i + 2], base.data[i + 3]];
      },
      source: base,
      getParams: () => clone(current),
      setParams,
      onReset: () => setParams(start),
      preview: { checked: preview, onChange: setPreview },
    });
    // Alt turns Cancel into Reset (I.3, conventions-shortcuts-fields): the dialog resets to the parameters it opened with
    onReset = () => setParams(start);
    content = built.element;
  } else {
    content = document.createElement('div');
    content.appendChild(ed.element);
    const pv = document.createElement('label');
    pv.className = 'checkbox';
    const pvInput = document.createElement('input');
    pvInput.type = 'checkbox';
    pvInput.checked = preview;
    pvInput.dataset.key = '__preview';
    pvInput.addEventListener('change', () => setPreview(pvInput.checked));
    pv.append(pvInput, document.createTextNode('Preview'));
    content.appendChild(pv);
  }
  const result = await app.dialogs.open({
    title,
    content,
    width,
    buttons: [...(extraButtons ?? []), { label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: () => refresh(),
    onReset,
  });
  done = true;
  refresh.cancel();
  built?.dispose();
  if (!result) {
    session.cancel();
    return null;
  }
  try {
    const img = await app.busy(`${title}…`, async () => processed(session, (x) => run(x, current, session, { preview: false })));
    session.commit(label, img, typeof meta === 'function' ? meta(current) : meta ?? {});
  } catch (err) {
    session.cancel();
    app.reportError(err, `${title} failed`);
    return null;
  }
  return current;
}

// ---- install --------------------------------------------------------------------------------------------------

export function install(app) {
  const has = () => !!app.doc?.active;
  app.adjustments = Object.fromEntries(ADJUSTMENT_KINDS.map((k) => [k, { name: ADJUSTMENTS[k].name, defaults: startParams(k) }]));
  app.buildAdjustmentEditor = buildAdjustmentEditor;
  /** 0.3 modules register custom editors here (see ADJUST_EDITORS). */
  app.adjustEditors = { register: (kind, def) => ADJUST_EDITORS.set(kind, def), get: (kind) => ADJUST_EDITORS.get(kind) ?? null };
  app.beginPixelEdit = (opts) => beginPixelEdit(app, opts);
  app.pixelEditDialog = (opts) => pixelEditDialog(app, opts);

  const lastParams = () => (app.settings.adjustLast ??= {});

  /**
   * The edit's description for 'pixels:committed' (lib/depth.js redoes it on 16/32-bit pixels): only when deep.js can
   * redo it faithfully. Levels and Curves in the CMYK and Lab spaces cannot go through its tables (`lut` is exact
   * on the grey axis only), so the sync pass takes the 8-bit result over instead.
   */
  const editMeta = (kind, params) => {
    if ((kind === 'levels' || kind === 'curves') && ['cmyk', 'lab'].includes(tonalSpace(params))) return {};
    return { adjustment: { kind, params: clone(params) } };
  };

  /** Selection weights (one byte per pixel of a session's base) for the area the session covers. */
  const selectionWeights = (session, sel, d) => {
    if (!sel) return null;
    const { x: rx, y: ry } = session.rect, w = session.base.width, h = session.base.height;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = ry + y;
      if (sy < 0 || sy >= d.height) continue;
      for (let x = 0; x < w; x++) {
        const sx = rx + x;
        if (sx >= 0 && sx < d.width) out[y * w + x] = sel.mask[sy * d.width + sx];
      }
    }
    return out;
  };

  /**
   * Equalize with a selection asks Photoshop's question: the selected area only, or the entire image based on the
   * selected area (its histogram, applied to the whole layer). arg { scope: 'selection' | 'image' } answers it
   * (actions record it); without a selection Equalize runs as in 0.3.
   */
  async function equalize(arg, ctx) {
    const d = app.doc;
    const sel = d?.selection && !d.selection.isEmpty ? d.selection : null;
    let scope = arg && typeof arg === 'object' ? arg.scope ?? null : null;
    if (sel && !scope) {
      const v = await formDialog(app, {
        title: 'Equalize',
        width: 380,
        fields: [{ key: 'scope', label: 'Equalize', type: 'segment', value: 'selection', span: true, options: [['selection', 'Selected area only'], ['image', 'Entire image based on selected area']] }],
      });
      if (!v) return ctx?.cancel();
      scope = v.scope;
    }
    const session = beginPixelEdit(app, { label: 'Equalize', ignoreSelection: !!sel && scope === 'image' });
    if (!session) return ctx?.cancel();
    let params = {};
    if (sel) {
      // the histogram of the selected pixels only: the session's rect (the selection's bounds, or the whole layer for
      // 'image') also holds unselected ones
      params = { hist: Array.from(weightedHistogram(session.base, null, selectionWeights(session, sel, d)).l) };
    }
    const img = processed(session, (x) => applyAdjustment(x, 'equalize', params, null, editCtx(app, session)));
    session.commit('Equalize', img, editMeta('equalize', params));
    if (sel) ctx?.setReplayArg({ scope });
  }

  /**
   * Image > Adjustments > <kind>: a dialog (opens with the defaults; `last: true`, the Alt+Ctrl commands, with the
   * last-used values: Photoshop's behaviour since 0.4), or with an object argument the adjustment at once (replays).
   */
  async function adjust(kind, arg, ctx = null, { last = false } = {}) {
    const def = ADJUSTMENTS[kind];
    if (!def) return;
    if (def.placeholder) {
      ctx?.cancel();
      return app.dialogs.toast(`${def.name} is not available yet`, { kind: 'error' });
    }
    // I.2: an editor's prepare runs before the dialog opens and before a replayed step applies; false cancels
    const prep = ADJUST_EDITORS.get(kind)?.prepare;
    if (prep && !(await prep(app, arg, ctx))) return ctx?.cancel();
    const d = app.doc;
    // smart objects (lib/smart-object.js): an adjustment on a smart layer becomes a smart filter, not a pixel edit
    const smart = def.smart !== false ? app.smartFilters?.intercept(d?.active, `adjust:${kind}`, arg && typeof arg === 'object' ? arg : null, def.name) : null;
    if (smart) {
      const used = await smart.done;
      if (used) ctx?.setReplayArg(clone(used));
      else ctx?.cancel();
      return;
    }
    if (d?.active?.type === 'adjustment' && !app.ui.editingMask) {
      ctx?.cancel();
      return app.dialogs.toast('Select a pixel layer (or add an adjustment layer from the Layers panel)', { kind: 'error' });
    }
    if (kind === 'equalize') return equalize(arg, ctx);
    if (NO_PARAMS.has(kind) || (arg && typeof arg === 'object')) {
      const session = beginPixelEdit(app, { label: def.name });
      if (!session) return ctx?.cancel();
      const params = arg && typeof arg === 'object' ? arg : {};
      const img = processed(session, (x) => applyAdjustment(x, kind, params, null, editCtx(app, session)));
      session.commit(def.name, img, editMeta(kind, params));
      if (last && arg && typeof arg === 'object') ctx?.setReplayCommand?.(`image:adjust-${kind}`, clone(params));
      return;
    }
    const custom = ADJUST_EDITORS.get(kind);
    const fresh = () => (custom?.start ? custom.start(app) : null) ?? startParams(kind);
    // Photoshop's adjustment dialogs open with the defaults, except those that keep their last settings (an editor
    // registration may say so with `remember`)
    const remember = last || (custom?.remember ?? REMEMBERS_LAST.has(kind));
    const start = clone((remember ? lastParams()[kind] : null) ?? fresh());
    let clipMode = null; // Levels / Curves: the clipping display while a black or white point is Alt-dragged
    const used = await pixelEditDialog(app, {
      title: def.name,
      params: start,
      width: custom?.width ?? 420,
      editor: (onChange, session, { refresh } = {}) => buildAdjustmentEditor(kind, start, onChange, {
        source: session.base,
        app,
        clip: (which) => {
          clipMode = which;
          refresh?.();
        },
      }),
      run: (img, params, session, { preview = false } = {}) => {
        if (preview && clipMode) clippingView(img, kind, params, clipMode);
        else applyAdjustment(img, kind, params, null, editCtx(app, session));
      },
      meta: (params) => editMeta(kind, params),
      frame: { kind },
    });
    if (used) {
      lastParams()[kind] = used;
      app.saveSettingsSoon();
      // an action records the plain command with the values (the Alt+Ctrl variants only choose where the dialog starts)
      if (last && ctx?.setReplayCommand) ctx.setReplayCommand(`image:adjust-${kind}`, clone(used));
      else ctx?.setReplayArg(clone(used));
    } else ctx?.cancel();
  }
  app.adjustDialog = (kind, arg, ctx, opts) => adjust(kind, arg, ctx, opts);

  /**
   * Image > Auto Tone / Auto Contrast / Auto Color. Until options are saved as the defaults (Auto Color Correction
   * Options), 0.3's recipes (0.1 % clipping); then Photoshop's: the command's algorithm (Per Channel Contrast,
   * Monochromatic Contrast, Find Dark & Light Colors with Snap Neutral Midtones) with the saved clipping and targets.
   */
  function auto(kind) {
    const fn = { tone: autoLevels, contrast: autoContrast, color: autoColor }[kind];
    const label = { tone: 'Auto Tone', contrast: 'Auto Contrast', color: 'Auto Color' }[kind];
    const session = beginPixelEdit(app, { label });
    if (!session) return;
    const saved = app.settings.adjust?.autoOptions;
    if (saved) {
      const algorithm = { tone: 'perChannel', contrast: 'mono', color: 'darkLight' }[kind];
      const params = autoLevelsParams(session.base, { ...autoOptions(saved), algorithm, snap: kind === 'color' });
      session.commit(label, processed(session, (img) => applyAdjustment(img, 'levels', params, null, editCtx(app, session))), editMeta('levels', params));
      return;
    }
    session.commit(label, processed(session, (img) => fn(img, { clip: 0.1 })));
  }

  /** Fade applies only while the last pixel edit is the current history state (not after undo + a new action). */
  function canFade() {
    const e = app.lastPixelEdit, d = app.doc;
    return !!e && !!d && e.doc === d && d.history.entries[d.history.index] === e.entry;
  }
  // The record holds the edit's pixels before and after (and, through the entry, the 16/32-bit patches lib/depth.js
  // hangs on it): megabytes that Purge and closing the document are meant to free. Once the entry has left its
  // history (purged, trimmed by the memory bound, replaced by a new edit after an undo) it can never be faded again.
  app.on('doc:change', (e) => {
    const last = app.lastPixelEdit;
    if (last && e?.doc === last.doc && !last.doc.history.entries.includes(last.entry)) app.lastPixelEdit = null;
  });
  app.on('doc:closed', (id) => {
    if (app.lastPixelEdit?.doc.id === id) app.lastPixelEdit = null;
  });

  async function fade() {
    const e = app.lastPixelEdit;
    const d = app.doc;
    if (!canFade()) return app.dialogs.toast('Nothing to fade', { kind: 'error' });
    const render = (opacity, mode) => {
      const w = e.local.width, h = e.local.height;
      if (mode === 'normal') {
        // interpolation between before and after, alpha included. Colour is weighted by alpha (premultiplied): where
        // the filter made a pixel transparent (Lens Correction's edge, a distortion) its "after" colour is an empty
        // 0,0,0 that must not darken the faded pixel, only make it more transparent
        const A = e.original.data, B = e.after.data;
        const img = new ImageData(w, h);
        const o = img.data;
        for (let i = 0; i < A.length; i += 4) {
          const aa = A[i + 3], ba = B[i + 3];
          if (aa === ba) {
            for (let c = 0; c < 3; c++) o[i + c] = A[i + c] + (B[i + c] - A[i + c]) * opacity;
            o[i + 3] = aa;
            continue;
          }
          const wa = aa * (1 - opacity), wb = ba * opacity, sum = wa + wb;
          for (let c = 0; c < 3; c++) o[i + c] = sum > 0 ? (A[i + c] * wa + B[i + c] * wb) / sum : A[i + c];
          o[i + 3] = sum;
        }
        return img;
      }
      if (!CANVAS_BLEND[mode]) {
        // modes Canvas 2D lacks (vivid light, hard mix, subtract, ...): blend in JS, keep the original alpha
        const dst = { width: w, height: h, data: new Uint8ClampedArray(e.original.data) };
        blendImages(mode, { width: w, height: h, data: e.after.data }, dst, opacity);
        for (let i = 3; i < dst.data.length; i += 4) dst.data[i] = e.original.data[i];
        return new ImageData(dst.data, w, h);
      }
      const a = createCanvas(w, h), b = createCanvas(w, h);
      a.getContext('2d').putImageData(e.original, 0, 0);
      b.getContext('2d').putImageData(e.after, 0, 0);
      const out = createCanvas(w, h);
      const ctx = out.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(a, 0, 0);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = CANVAS_BLEND[mode] ?? 'source-over';
      ctx.drawImage(b, 0, 0);
      // keep the original alpha
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(a, 0, 0);
      return ctx.getImageData(0, 0, w, h);
    };
    const put = (data) => {
      e.canvas.getContext('2d').putImageData(data, e.local.x, e.local.y);
      e.layer.touch();
      d.changed('pixels', { layer: e.layer });
    };
    const opts = await formDialog(app, {
      title: `Fade ${e.label}`,
      fields: [
        { key: 'opacity', label: 'Opacity', type: 'slider', value: 100, min: 0, max: 100, unit: '%' },
        { key: 'mode', label: 'Mode', type: 'select', value: 'normal', options: BLEND_MODES.filter(Boolean).filter(([v]) => v !== 'pass-through') },
      ],
      live: {
        apply: (v) => put(render(v.opacity / 100, v.mode)),
        revert: () => put(e.after),
      },
    });
    if (!opts) return;
    const result = render(opts.opacity / 100, opts.mode);
    put(result);
    d.history.push({ label: `Fade ${e.label}`, undo: () => put(e.after), redo: () => put(result), bytes: result.data.length, at: Date.now() });
    d.changed('history');
  }

  async function editAdjustmentLayer(id) {
    const d = app.doc;
    const layer = (typeof id === 'string' && d.find(id)) || d.active;
    if (!layer || layer.type !== 'adjustment') return;
    if (app.panels?.panels?.has('properties')) {
      d.setActive(layer);
      app.panels.show('properties', { reveal: true });
      return;
    }
    // fallback: modal editor
    const before = clone(layer.params);
    const source = adjustmentSource(app, layer);
    const ed = buildAdjustmentEditor(layer.kind, layer.params, (p) => {
      layer.params = p;
      layer.touch();
      d.changed('props', { layer });
    }, { source, app });
    const ok = await app.dialogs.open({ title: layer.name, content: ed.element, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] });
    const after = clone(layer.params);
    layer.params = before;
    if (ok) setLayerProps(app, layer, { params: after }, `Edit ${layer.name}`);
    else {
      layer.touch();
      d.changed('props', { layer });
    }
  }

  // Layer Content Options of a fill layer: the paint editors of lib/paint-editors.js (G.5, E21)
  function editFillLayer(id) {
    const d = app.doc;
    const layer = (typeof id === 'string' && d?.find(id)) || d?.active;
    if (!layer || layer.type !== 'fill') return;
    return editPaint(app, layer);
  }

  app.adjustmentLayerMenu = () => [
    { type: 'title', label: 'Fill' },
    { label: 'Solid Color…', icon: 'fill', onSelect: () => app.commands.run('layer:new-fill', 'solid', 'panel') },
    { label: 'Gradient…', icon: 'gradient', onSelect: () => app.commands.run('layer:new-fill', 'gradient', 'panel') },
    { label: 'Pattern…', icon: 'pattern-stamp', onSelect: () => app.commands.run('layer:new-fill', 'pattern', 'panel') },
    { type: 'separator' },
    { type: 'title', label: 'Adjustment' },
    ...LAYER_KINDS.map((k) => ({ label: `${ADJUSTMENTS[k].name}…`, icon: ADJUSTMENT_ICONS[k] ?? 'adjust', onSelect: () => app.commands.run('layer:new-adjustment', k, 'panel') })),
  ];

  const cmds = {
    'image:adjust': { enabled: has, run: (kind, ctx) => adjust(kind, undefined, ctx), dialog: true },
    'image:auto-tone': { enabled: has, run: () => auto('tone'), label: 'Auto Tone' },
    'image:auto-contrast': { enabled: has, run: () => auto('contrast'), label: 'Auto Contrast' },
    'image:auto-color': { enabled: has, run: () => auto('color'), label: 'Auto Color' },
    'edit:fade': { enabled: () => canFade(), run: fade, label: 'Fade…' },
    'layer:edit-adjustment': { enabled: () => app.doc?.active?.type === 'adjustment', run: editAdjustmentLayer },
    'layer:edit-fill': { enabled: () => app.doc?.active?.type === 'fill', run: editFillLayer },
  };
  for (const k of ADJUSTMENT_KINDS) cmds[`image:adjust-${k}`] = { enabled: () => has() && !ADJUSTMENTS[k].placeholder, run: (arg, ctx) => adjust(k, arg, ctx), label: `${ADJUSTMENTS[k].name}${NO_PARAMS.has(k) ? '' : '…'}`, dialog: !NO_PARAMS.has(k) };
  app.commands.registerAll(cmds);
  void DIRECT_ONLY;
}

/** Composite of everything below an adjustment layer (for its histogram). */
export function adjustmentSource(app, layer) {
  const d = app.doc;
  try {
    const skip = new Set();
    let found = false;
    for (const l of d.layers()) {
      if (l === layer) found = true;
      if (found) skip.add(l);
    }
    const c = d.view.compositor.composite(d, { skip });
    const small = createCanvas(Math.min(512, d.width), Math.max(1, Math.round((Math.min(512, d.width) / d.width) * d.height)));
    small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
    return small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, small.width, small.height);
  } catch {
    const flat = flattenDocument(d);
    return flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, flat.width, flat.height);
  }
}
