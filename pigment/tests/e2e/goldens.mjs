// The 0.5 goldens' cases and the page code that drives them (CONTRACT-05 Part 2, step 0). record-goldens.spec.mjs
// recorded tests/fixtures/brush-golden/ and tests/fixtures/psd-golden/ with this code on the 0.4.0 tree; the specs
// that check 0.5 against those files (brush-golden.spec.mjs, skeleton-05.spec.mjs "psd") build the same strokes and
// documents through it, so a case means the same thing in the recording and in the check. Change nothing here that
// alters a case: the files were recorded from 0.4's code and cannot be recorded again once the skeleton has landed.
//
// pageStrokeCases and pagePsdGolden run inside the page (page.evaluate serialises them): they reference nothing
// outside their own bodies.

export const W = 160, H = 120;

const round3 = (v) => Math.round(v * 1000) / 1000;
/** n + 1 samples from a to b, with uneven steps (as a real pointer gives) and an optional pressure ramp. */
function line([x0, y0], [x1, y1], n, pressure = null) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i + 0.35 * Math.sin(i * 1.7) * (i > 0 && i < n ? 1 : 0)) / n;
    const s = { x: round3(x0 + (x1 - x0) * t), y: round3(y0 + (y1 - y0) * t) };
    if (pressure) s.pressure = round3(pressure[0] + (pressure[1] - pressure[0]) * (i / n));
    out.push(s);
  }
  return out;
}
/** An S curve across the canvas: one period of a sine. */
function sCurve(n = 40, amp = 30, cy = 60, x0 = 20, x1 = 140) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: round3(x0 + (x1 - x0) * t), y: round3(cy - Math.sin(t * Math.PI * 2) * amp) });
  }
  return out;
}

/** 0.4's StrokeTool.baseSettings defaults (paint.js) where a case does not set a key: the flat 0.4 settings form. */
export const BASE_SETTINGS = { size: 24, hardness: 0.8, opacity: 1, flow: 1, smoothing: 0.2, spacing: 0.12, pressureSize: true, pressureOpacity: false, blend: 'normal', angle: 0, roundness: 1, color: '#d02040', mode: 'paint', maskValue: 1, lockTransparency: false, antialias: true, label: 'Brush' };

/**
 * The stroke cases. base: 'empty' (transparent), 'pattern' (pageStrokeCases' pattern), 'mask' (a white, fully
 * revealing layer mask the stroke targets). sampler { kind: 'clone', offset }: 0.4's Clone Stamp sampler (Aligned,
 * Sample: Current Layer) reading the target before the stroke. selection: an antialiased Selection.fromEllipse.
 * aliased: Pencil-like whole-pixel dabs (S2.3: equal, not within tolerance, once a new engine lands).
 */
export const CASES = [
  { id: 'hard-line', what: 'hard 20 px line', base: 'empty', settings: { size: 20, hardness: 1 }, samples: line([20, 60], [140, 60], 24) },
  { id: 'soft-s-curve', what: 'soft 40 px S curve, flow 0.5, opacity 0.8', base: 'empty', settings: { size: 40, hardness: 0, flow: 0.5, opacity: 0.8 }, samples: sCurve() },
  { id: 'angle-roundness', what: 'angle 45, roundness 0.3', base: 'empty', settings: { size: 30, hardness: 0.8, angle: 45, roundness: 0.3 }, samples: line([20, 30], [140, 90], 20) },
  { id: 'pencil', what: 'Pencil 3 px (0.4 PencilTool overrides)', base: 'empty', aliased: true, settings: { size: 3, hardness: 1, flow: 1, smoothing: 0, antialias: false, pressureSize: false, label: 'Pencil' }, samples: line([15, 100], [145, 20], 30) },
  { id: 'soft-eraser', what: 'soft Eraser on the pattern', base: 'pattern', settings: { size: 30, hardness: 0, mode: 'erase', label: 'Eraser' }, samples: line([20, 40], [140, 95], 22) },
  { id: 'mask-black', what: 'black on a layer mask', base: 'mask', target: 'mask', settings: { size: 24, hardness: 0.8, mode: 'mask', maskValue: 0, color: '#000000' }, samples: sCurve(30, 25) },
  { id: 'pressure-size', what: 'pressure ramp 0.1 to 1 with pressureSize', base: 'empty', settings: { size: 30, hardness: 0.8, pressureSize: true }, samples: line([20, 60], [140, 60], 24, [0.1, 1]) },
  { id: 'pressure-opacity', what: 'pressure ramp 0.1 to 1 with pressureOpacity (0.4 scales the flow)', base: 'empty', settings: { size: 30, hardness: 0.8, pressureSize: false, pressureOpacity: true }, samples: line([20, 60], [140, 60], 24, [0.1, 1]) },
  { id: 'multiply', what: 'Multiply on the pattern', base: 'pattern', settings: { size: 30, hardness: 0.6, blend: 'multiply', color: '#40c060' }, samples: sCurve(36, 35) },
  { id: 'vivid-light', what: 'Vivid Light on the pattern (a per-pixel blend)', base: 'pattern', settings: { size: 30, hardness: 0.6, blend: 'vivid-light', color: '#e0a020', opacity: 0.9 }, samples: sCurve(36, 35) },
  { id: 'lock-transparency', what: 'Lock Transparency on the pattern', base: 'pattern', settings: { size: 36, hardness: 0.5, lockTransparency: true, color: '#2040e0' }, samples: line([80, 10], [80, 115], 20) },
  { id: 'clone-stamp', what: 'Clone Stamp sampler, offset (-40, 0)', base: 'pattern', settings: { size: 28, hardness: 0.7, label: 'Clone stamp' }, sampler: { kind: 'clone', offset: { x: -40, y: 0 } }, samples: line([70, 20], [140, 70], 18) },
  { id: 'spacing-0.5', what: 'spacing 0.5', base: 'empty', settings: { size: 24, hardness: 0.9, spacing: 0.5 }, samples: line([20, 60], [140, 60], 24) },
  { id: 'airbrush-soft-65', what: '"Airbrush Soft 65 (low flow)" (BUILTIN_BRUSHES id airbrush)', base: 'empty', preset: 'airbrush', settings: { size: 65, hardness: 0, flow: 0.12, spacing: 0.08 }, samples: sCurve(40, 20) },
  { id: 'selection-clip', what: 'clipped by an elliptical selection', base: 'empty', settings: { size: 30, hardness: 0.5 }, selection: { kind: 'ellipse', rect: { x: 30, y: 20, width: 100, height: 80 } }, samples: line([10, 60], [150, 60], 26) },
].map((c) => ({ ...c, settings: { ...BASE_SETTINGS, ...c.settings } }));

/** The options set on 0.4's painting tools before their strokeSettings is read (paint.js, retouch.js). */
export const TOOL_OPTIONS = {
  brush: { size: 30, hardness: 0.6, opacity: 0.7, flow: 0.8, smoothing: 0.3, pressureSize: false, pressureOpacity: true, blend: 'multiply', angle: 30, roundness: 0.5, lockAlpha: false },
  pencil: { size: 5, opacity: 0.9, blend: 'screen', autoErase: false },
  eraser: { size: 26, hardness: 0.4, opacity: 0.6, flow: 0.7, smoothing: 0.1, pressureSize: true, eraseToHistory: false },
  clone: { size: 22, hardness: 0.5, opacity: 0.8, flow: 0.9, smoothing: 0.25, pressureSize: false, pressureOpacity: false, aligned: true, sampleAll: false },
};
export const TOOL_SETTINGS = [
  { id: 'brush', tool: 'brush' },
  { id: 'pencil', tool: 'pencil' },
  { id: 'eraser-brush', tool: 'eraser', options: { mode: 'brush' } },
  { id: 'eraser-pencil', tool: 'eraser', options: { mode: 'pencil' } },
  { id: 'eraser-block', tool: 'eraser', options: { mode: 'block' } },
  { id: 'clone', tool: 'clone' },
];
/** What pageToolSettings sets around the tools: the colours and 0.4's settings.brush.spacing. */
export const TOOL_CONTEXT = { foreground: '#d02040', background: '#20a040', spacing: 0.2, point: { x: 60, y: 40, pressure: 1 } };

/**
 * In the page, with a document of W x H whose active layer is a raster layer: runs each case through
 * `window.__goldenStroke(c, { target, layer, settings, selection, history })` when the caller defined one (the 0.5
 * checks drive other settings forms or tools), else through `new BrushStroke(...)` driven as 0.4's tools did:
 * begin(samples[0]); extend(each later sample); then 0.4's StrokeTool.onPointerUp finish (s.smoothing = 0, extend(the
 * last sample), smoothing restored); end(). With `log`, BrushStroke.prototype.dab is wrapped for the call and every
 * dab is logged with the size and flow 0.4's dab() computes. Returns [{ id, dirty, rgba (base64 straight RGBA of the
 * target after end()), png (base64, when `png`), dabs (when `log`) }].
 */
export async function pageStrokeCases({ cases, W, H, log = false, png = false }) {
  const app = window.pigmentApp;
  const doc = app.doc;
  const { BrushStroke } = await import('/lib/brush.js');
  const { Selection } = await import('/lib/selection.js');
  const { createCanvas } = await import('/lib/document.js');
  const { encodeRgba8 } = await import('/shared/pixels/png.js');
  const layer = doc.active;
  const pattern = () => {
    // rows 0..79 opaque, 90..99 at alpha 128, else transparent; red rises left to right, blue falls, green waves
    const img = new ImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      img.data[i] = Math.round((x * 255) / (W - 1));
      img.data[i + 1] = 128 + Math.round(60 * Math.sin(y / 9));
      img.data[i + 2] = 255 - Math.round((x * 255) / (W - 1));
      img.data[i + 3] = y < 80 ? 255 : y >= 90 && y < 100 ? 128 : 0;
    }
    return img;
  };
  const canvasOf = (img) => {
    const c = createCanvas(W, H);
    if (img) c.getContext('2d').putImageData(img, 0, 0);
    return c;
  };
  const white = () => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    return c;
  };
  const b64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  let dabs = null;
  const dab = BrushStroke.prototype.dab;
  if (log) {
    BrushStroke.prototype.dab = function loggedDab(x, y, pressure = 1) {
      let flow = this.s.flow;
      if (this.s.pressureOpacity && pressure !== undefined) flow *= Math.max(0.05, pressure);
      dabs?.push({ x, y, pressure, size: this.effectiveSize(pressure), flow });
      return dab.call(this, x, y, pressure);
    };
  }
  const results = [];
  try {
    for (const c of cases) {
      layer.canvas = c.base === 'pattern' ? canvasOf(pattern()) : canvasOf(null);
      layer.x = layer.y = 0;
      layer.mask = c.base === 'mask' ? { canvas: white(), enabled: true, linked: true } : null;
      layer.touch();
      const target = c.target === 'mask' ? { canvas: layer.mask.canvas, x: 0, y: 0, mask: true } : { canvas: layer.canvas, x: 0, y: 0, mask: false };
      const settings = { ...c.settings };
      if (c.sampler?.kind === 'clone') {
        // CloneStampTool.strokeSettings with Sample: Current Layer: a snapshot of the target before the stroke
        const snapshot = canvasOf(target.canvas.getContext('2d').getImageData(0, 0, W, H));
        const off = c.sampler.offset;
        settings.sampler = (tctx, lx, ly, w, h) => tctx.drawImage(snapshot, Math.round(lx + off.x), Math.round(ly + off.y), w, h, 0, 0, w, h);
      }
      const selection = c.selection ? Selection.fromEllipse(W, H, c.selection.rect) : null;
      dabs = log ? [] : null;
      let dirty;
      if (window.__goldenStroke) dirty = await window.__goldenStroke(c, { target, layer, settings, selection, history: doc.history });
      else {
        const stroke = new BrushStroke({ target, layer, settings, selection, history: doc.history });
        stroke.begin(c.samples[0]);
        for (const s of c.samples.slice(1)) stroke.extend(s);
        const last = c.samples[c.samples.length - 1];
        const smoothing = stroke.s.smoothing;
        stroke.s.smoothing = 0;
        stroke.extend(last);
        stroke.s.smoothing = smoothing;
        dirty = stroke.dirty;
        stroke.end();
      }
      const img = target.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
      const r = { id: c.id, dirty, rgba: b64(new Uint8Array(img.data.buffer)) };
      if (png) r.png = b64(await encodeRgba8({ width: W, height: H, data: img.data }));
      if (log) r.dabs = dabs;
      results.push(r);
    }
  } finally {
    BrushStroke.prototype.dab = dab;
    dabs = null;
  }
  return results;
}

/**
 * In the page, with a document whose active layer is a raster layer: sets `context` and each tool's options, and
 * returns what tool.strokeSettings(point, layer, tool.strokeTarget(layer)) gives (functions as '[function]', other
 * objects as '[object]').
 */
export async function pageToolSettings({ toolOptions, toolSettings, context, W, H }) {
  const app = window.pigmentApp;
  const { createCanvas } = await import('/lib/document.js');
  const layer = app.doc.active;
  layer.canvas = createCanvas(W, H);
  layer.x = layer.y = 0;
  layer.mask = null;
  app.setColors({ foreground: context.foreground, background: context.background });
  app.settings.brush = { ...(app.settings.brush ?? {}), spacing: context.spacing };
  const out = [];
  for (const t of toolSettings) {
    const tool = app.tools.get(t.tool);
    const options = { ...toolOptions[t.tool], ...(t.options ?? {}) };
    for (const [k, v] of Object.entries(options)) app.tools.setOpt(t.tool, k, v);
    if (t.tool === 'clone') {
      tool.source = { x: 20, y: 30 };
      tool.offset = { x: -40, y: 0 };
    }
    const s = tool.strokeSettings({ ...context.point }, layer, tool.strokeTarget(layer));
    const settings = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'function' ? '[function]' : v && typeof v === 'object' ? '[object]' : v]));
    out.push({ id: t.id, tool: t.tool, options, settings });
  }
  return out;
}

/** The six PSD golden documents (pagePsdGolden builds each). */
export const PSD_GOLDEN_DOCS = ['text', 'adjustments', 'masks', 'styles', 'guides', 'grayscale'];

/**
 * In the page: makes the document `which` (a new document, left active), writes it with
 * `window.__goldenWritePsd(doc)` when the caller defined one, else 0.4's `writePsdDocument(doc, doc.view.compositor)`,
 * and returns readPsd of the bytes without image data as JSON (canvases as { $canvas: [w, h] }, typed arrays as
 * { $bytes: [...] }).
 */
export async function pagePsdGolden(which) {
  const app = window.pigmentApp;
  const { RasterLayer, TextLayer, createCanvas } = await import('/lib/document.js');
  const { structural } = await import('/lib/layer-ops.js');
  const M = await import('/lib/type/model.js');
  const { writePsdDocument } = await import('/lib/io.js');
  const { readPsd } = await import('ag-psd');
  const fill = (w, h, color, rect = null) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    if (rect) ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    else ctx.fillRect(0, 0, w, h);
    return c;
  };
  const rectPath = (x, y, w, h) => ({ subpaths: [{ closed: true, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => ({ x: px, y: py, anchor: { x: px, y: py }, in: { x: px, y: py }, out: { x: px, y: py } })) }] });
  const add = (layer) => structural(app, 'Add', () => {
    app.doc.add(layer);
    app.doc.setActive(layer);
  });
  const text = (name, plain, char, para, at, width = null) => {
    const l = new TextLayer({ content: M.fromPlain(plain, char, para), x: at[0], y: at[1], width });
    l.name = name;
    return l;
  };
  app.newDocument({ width: 120, height: 90, name: which, ...(which === 'grayscale' ? { mode: 'grayscale' } : {}) });
  const d = app.doc;
  if (which === 'text') {
    add(text('Point', 'Golden', { size: 24, color: '#202060' }, {}, [10, 30]));
    add(text('Box', 'Box text that wraps', { size: 14, tracking: 50 }, { align: 'center' }, [10, 50], 90));
  } else if (which === 'adjustments') {
    add(new RasterLayer({ name: 'Colour', canvas: fill(120, 90, '#c08040'), x: 0, y: 0 }));
    await app.commands.run('layer:new-adjustment', { kind: 'levels', params: { rgb: { inBlack: 20, inWhite: 220, gamma: 1.2, outBlack: 0, outWhite: 255 } } }, 'api');
    await app.commands.run('layer:new-adjustment', { kind: 'hue-saturation', params: { hue: 30, saturation: -20, lightness: 5 } }, 'api');
    await app.commands.run('layer:new-adjustment', 'invert', 'api');
    await app.commands.run('layer:new-adjustment', { kind: 'brightness-contrast', params: { brightness: 20, contrast: 10 } }, 'api');
  } else if (which === 'masks') {
    add(new RasterLayer({ name: 'Masked', canvas: fill(120, 90, '#ff0000'), x: 0, y: 0, mask: { canvas: fill(120, 90, '#ffffff', { x: 0, y: 0, width: 60, height: 90 }), enabled: true, linked: true } }));
    add(new RasterLayer({ name: 'Vector', canvas: fill(120, 90, '#0000ff'), x: 0, y: 0 }));
    await app.commands.run('layer:vector-mask', { op: 'current-path', path: rectPath(10, 10, 80, 50) }, 'api');
  } else if (which === 'styles') {
    add(new RasterLayer({ name: 'Styled', canvas: fill(60, 40, '#20a020'), x: 30, y: 25, styles: { dropShadow: { enabled: true, distance: 5, size: 4 } } }));
    add(new RasterLayer({ name: 'BlendIf', canvas: fill(120, 90, '#e0e0e0'), x: 0, y: 0, opacity: 0.8, blend: 'multiply', blending: { blendIf: { gray: { this: [0, 0, 200, 230], under: [30, 60, 255, 255] } } } }));
  } else if (which === 'guides') {
    add(new RasterLayer({ name: 'Layer', canvas: fill(40, 40, '#808080'), x: 20, y: 20 }));
    d.store.add('guides', { axis: 'x', pos: 30 }, { label: 'New Guide' });
    d.store.add('guides', { axis: 'y', pos: 45.5, color: '#ff8800' }, { label: 'New Guide' });
    d.store.add('guides', { axis: 'x', pos: 100 }, { label: 'New Guide' });
  } else if (which === 'grayscale') {
    add(new RasterLayer({ name: 'Coloured', canvas: fill(120, 90, '#c03030'), x: 0, y: 0, opacity: 0.7 }));
    add(text('Grey text', 'Grey', { size: 20, color: '#808080' }, {}, [10, 30]));
    add(text('Red text', 'Red', { size: 20, color: '#ff0000' }, {}, [10, 60]));
  } else throw new Error(`no PSD golden document ${which}`);
  const bytes = window.__goldenWritePsd ? await window.__goldenWritePsd(d) : writePsdDocument(d, d.view.compositor);
  const psd = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  return JSON.stringify(psd, (k, v) => {
    if (v && typeof v === 'object') {
      if (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) return { $canvas: [v.width, v.height] };
      if (ArrayBuffer.isView(v)) return { $bytes: Array.from(v) };
    }
    return v;
  }, 1);
}
