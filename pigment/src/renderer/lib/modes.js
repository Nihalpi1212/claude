// Image > Mode (see ARCHITECTURE.md "Image modes"): Bitmap, Grayscale, Duotone, Indexed Color, RGB,
// CMYK, Lab and Multichannel, plus Color Table, Trap, Conditional Mode Change and Save for Web.
//
// A document always stores RGBA canvases. Its mode is three things, all installed here:
//   - a compositor pass (registerModeRenderer) that shows the composite the way the mode defines it:
//     grey, black/white, the duotone inks, the colour table, the remaining spot channels;
//   - constraints on what is painted: app.colorConstraint snaps picked colours, app.pixelConstraint
//     snaps the result of pixel edits (filters, adjustments);
//   - a conversion (convertDocument) that rewrites the raster layers with shared/pixels/modes.js and
//     records the whole change (layers, mode, colour table, inks, channels) as one history entry.
// What a mode only shows (ink colours, table snapping) is baked into the pixels when the document
// leaves that mode, so "what you see" survives every conversion.
//
// State that document.js does not carry lives in doc.meta.imageMode (saved in .pigment files):
// { transparentIndex } for indexed documents, { multichannel: { source, duotone, spots } } for
// multichannel ones. Spot channels are ordinary saved channels (doc.channels) flagged `spot`.
import { registerModeRenderer, Compositor } from './compositor.js';
import { RasterLayer, createCanvas, newId } from './document.js';
import { hasEnabledStyles } from '../../shared/pixels/styles.js';
import { snapshotTree, restoreTree } from './layer-ops.js';
import { Selection } from './selection.js';
import { parseColor, rgbaToHex } from '../../shared/pixels/color.js';
import { MODES, FLATTENING_MODES, DUOTONE_PRESETS, convertPixels, renderMode, constrainImage, constrainColor, normalizeDuotone, trap, splitChannels } from '../../shared/pixels/modes.js';
import { createMapper } from '../../shared/pixels/quantize.js';
import { bitmapDialog, duotoneDialog, indexedDialog, colorTableDialog, trapDialog, conditionalDialog, flattenChoice, modeChoice, bitmapPatternTile } from './modes/dialogs.js';
import { installFormats } from './modes/formats.js';
import { saveForWeb } from './modes/save-for-web.js';

/** Modes whose pixels are limited to what the mode can hold. */
const CONSTRAINED = new Set(['grayscale', 'bitmap', 'duotone', 'indexed']);
/** Modes that store plain RGB: converting between them changes no pixel. */
const FREE = new Set(['rgb', 'cmyk', 'lab']);
const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));
const hex = (c) => rgbaToHex([...parseColor(c).slice(0, 3), 1]);

// ---- mode state ------------------------------------------------------------------------------------------------

/** What the pixel module needs to know about a document's mode: { colorTable, transparentIndex, duotone, multichannel }. */
export function modeState(doc) {
  const extra = doc?.meta?.imageMode ?? {};
  const state = { colorTable: doc?.colorTable ?? null, transparentIndex: Number.isInteger(extra.transparentIndex) ? extra.transparentIndex : -1, duotone: doc?.duotone ?? null, multichannel: null };
  if (doc?.mode === 'multichannel' && extra.multichannel) {
    // the inks still printed are the spot channels still in the Channels panel
    state.multichannel = { source: extra.multichannel.source ?? 'rgb', duotone: extra.multichannel.duotone ?? null, keys: doc.channels.filter((c) => c.spot).map((c) => c.spot.key) };
  }
  return state;
}

function setExtra(doc, extra) {
  const meta = { ...(doc.meta ?? {}) };
  if (extra && Object.keys(extra).length) meta.imageMode = extra;
  else delete meta.imageMode;
  doc.meta = meta;
}

/** Spot flags are not part of a saved channel's description: they come back from meta.imageMode when a file opens. */
function hydrateSpots(doc) {
  const spots = doc.meta?.imageMode?.multichannel?.spots;
  if (!spots) return;
  for (const ch of doc.channels) if (spots[ch.id] && !ch.spot) ch.spot = { key: spots[ch.id].key, color: spots[ch.id].color ?? null };
}

export const isConstrained = (doc) => !!doc && CONSTRAINED.has(doc.mode);

/** True when the document is one plain, full-size raster layer: nothing a flatten would change. */
export function isSimple(doc) {
  const kids = doc.root.children.filter((l) => !l.preview && !l.quickMask);
  if (kids.length !== 1) return false;
  const l = kids[0];
  const styled = hasEnabledStyles(l.styles);
  return l.type === 'raster' && l.visible && l.opacity >= 1 && (l.fillOpacity ?? 1) >= 1 && l.blend === 'normal' && !l.mask && !styled && l.x === 0 && l.y === 0 && l.canvas.width === doc.width && l.canvas.height === doc.height;
}

/**
 * Whether converting `doc` to `to` flattens: 'required' (the target or the current mode cannot keep
 * layers apart: bitmap, indexed, multichannel), 'optional' (layers survive, but blending grey or
 * ink-mapped layers can look different from the flattened picture: Photoshop asks) or 'none'.
 */
export function flattenPlan(doc, to) {
  const from = doc.mode;
  if (isSimple(doc)) return 'none';
  if (FLATTENING_MODES.includes(to) || FLATTENING_MODES.includes(from)) return 'required';
  if (FREE.has(from) && FREE.has(to)) return 'none';
  return doc.layers().filter((l) => !l.preview && !l.quickMask).length > 1 ? 'optional' : 'none';
}

const imageOf = (canvas) => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
function canvasOf(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

/** 16/32-bit pixels (lib/depth.js) made grey with the same luma weights as the 8-bit proxy. */
function greyDeep(deep) {
  if (!deep?.data) return deep ?? null;
  const src = deep.data, data = new src.constructor(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const v = src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114;
    data[i] = data[i + 1] = data[i + 2] = deep.type === 'u16' ? Math.round(v) : v;
    data[i + 3] = src[i + 3];
  }
  return { type: deep.type, data };
}

function resampleMask(mask, w, h, nw, nh) {
  const src = createCanvas(w, h);
  const img = new ImageData(w, h);
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = mask[i];
    img.data[j + 3] = 255;
  }
  src.getContext('2d').putImageData(img, 0, 0);
  const dst = createCanvas(nw, nh);
  const ctx = dst.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, nw, nh);
  const d = ctx.getImageData(0, 0, nw, nh).data;
  const out = new Uint8ClampedArray(nw * nh);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

export function install(app) {
  const has = () => !!app.doc;

  // ---- what a mode shows ---------------------------------------------------------------------------------------
  // One pass over the finished composite (view, exports, thumbnails). Grayscale desaturates here as well, so a
  // coloured adjustment, fill or text layer cannot leak colour into a grey document.
  const render = (doc, canvas, rect, opts) => {
    // A composite of some layers only (opts.skip: merges, Flatten Image, Rasterize, an adjustment's histogram)
    // becomes layer pixels or reads them: it stays raw, or duotone inks would be baked in and mapped a second
    // time when the merged layer is shown.
    if (opts?.skip) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    renderMode(img, doc.mode, modeState(doc));
    ctx.putImageData(img, 0, 0);
  };
  for (const mode of ['grayscale', 'bitmap', 'duotone', 'indexed', 'multichannel']) registerModeRenderer(mode, render);

  // ---- constraints -----------------------------------------------------------------------------------------------
  function colorConstraint(color, doc) {
    if (!isConstrained(doc)) return color;
    const st = modeState(doc);
    const rgb = constrainColor(doc.mode, parseColor(color).slice(0, 3), st.colorTable, st.transparentIndex);
    return rgbaToHex([rgb[0], rgb[1], rgb[2], 1]);
  }
  function pixelConstraint(doc, img) {
    if (!isConstrained(doc)) return img;
    const st = modeState(doc);
    return constrainImage(doc.mode, img, st.colorTable, null, st.transparentIndex);
  }
  app.colorConstraint = colorConstraint;

  // The foreground and background colours are global. A grey or indexed document shows (and paints) their snapped
  // versions; the colours the user really picked come back when a colour document is activated again.
  let stash = null; // { fg, bg, snapFg, snapBg }
  function syncColors(doc = app.doc) {
    const fg0 = hex(app.settings.foreground ?? '#000000'), bg0 = hex(app.settings.background ?? '#ffffff');
    if (isConstrained(doc)) {
      const fg = colorConstraint(fg0, doc), bg = colorConstraint(bg0, doc);
      if (fg === fg0 && bg === bg0) return;
      const keep = stash && stash.snapFg === fg0 && stash.snapBg === bg0 ? stash : { fg: fg0, bg: bg0 };
      stash = { fg: keep.fg, bg: keep.bg, snapFg: fg, snapBg: bg };
      app.setColors({ foreground: fg, background: bg });
    } else if (stash && doc) {
      const { fg, bg, snapFg, snapBg } = stash;
      stash = null;
      // only when the snapped colours are still the current ones: a colour picked meanwhile is the user's choice
      if (fg0 === snapFg && bg0 === snapBg) app.setColors({ foreground: fg, background: bg });
    }
  }

  /** The pixel constraint is only installed while it has work to do: sessions test it to choose fast paths. */
  function refreshHooks() {
    app.pixelConstraint = isConstrained(app.doc) ? pixelConstraint : null;
  }

  function modeChanged(doc) {
    refreshHooks();
    if (doc === app.doc) syncColors(doc);
    app.emit('mode:changed', { doc, mode: doc.mode });
    app.syncUiState();
    app.commands.invalidate();
  }

  app.on('doc:activated', (doc) => {
    refreshHooks();
    if (doc) syncColors(doc);
  });
  app.on('doc:opened', (doc) => {
    hydrateSpots(doc);
    // a new document in a grey mode starts with pixels the mode can hold (the New dialog's background colour)
    if (isConstrained(doc) && !doc.path && doc.mode !== 'indexed') {
      for (const l of doc.layers()) if (l.type === 'raster') {
        const ctx = l.canvas.getContext('2d', { willReadFrequently: true });
        const img = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
        constrainImage(doc.mode, img);
        ctx.putImageData(img, 0, 0);
        l.touch();
      }
    }
    refreshHooks();
  });
  // spot channels deleted in the Channels panel stop printing: the composite has to be redrawn
  app.on('channels:changed', (doc) => {
    if (doc?.mode === 'multichannel') {
      doc.root.touch();
      doc.view?.invalidate();
    }
  });

  // ---- conversion ----------------------------------------------------------------------------------------------

  /** Everything a mode conversion can change, by reference (conversions replace canvases, they never draw into them). */
  function capture(doc) {
    return {
      tree: snapshotTree(doc),
      rasters: doc.layers().filter((l) => l.type === 'raster').map((l) => ({ layer: l, canvas: l.canvas, x: l.x, y: l.y, deep: l.deep ?? null })),
      mode: doc.mode,
      colorTable: doc.colorTable,
      duotone: doc.duotone,
      extra: clone(doc.meta?.imageMode ?? null),
      channels: doc.channels.slice(),
      selection: doc.selection,
      savedSelection: doc.savedSelection ?? null,
      guides: doc.guides.slice(),
      dpi: doc.dpi,
    };
  }

  function restore(doc, s) {
    for (const r of s.rasters) {
      r.layer.canvas = r.canvas;
      r.layer.x = r.x;
      r.layer.y = r.y;
      r.layer.deep = r.deep;
    }
    doc.mode = s.mode;
    doc.colorTable = s.colorTable;
    doc.duotone = s.duotone;
    setExtra(doc, clone(s.extra));
    doc.channels = s.channels.slice();
    doc.selection = s.selection;
    doc.savedSelection = s.savedSelection;
    doc.guides = s.guides.slice();
    doc.dpi = s.dpi;
    restoreTree(doc, s.tree); // sets the size, touches every layer, emits 'tree' or 'canvas'
    doc.changed('selection');
    doc.changed('channels');
    doc.changed('props');
    app.emit('channels:changed', doc);
    modeChanged(doc);
  }

  /** Records `before` → now as one entry. */
  function record(doc, label, before, bytes = 0) {
    const after = capture(doc);
    doc.history.push({ label, undo: () => restore(doc, before), redo: () => restore(doc, after), bytes, at: Date.now() });
    doc.changed('history');
  }

  /** Merges the document to one Background layer holding the unrendered composite (the conversion bakes the mode). */
  function flattenRaw(doc, { white = true } = {}) {
    const comp = new Compositor().composite(doc, { rawMode: true });
    const c = createCanvas(doc.width, doc.height);
    const ctx = c.getContext('2d');
    if (white) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, doc.width, doc.height);
    }
    ctx.drawImage(comp, 0, 0);
    const layer = new RasterLayer({ name: 'Background', canvas: c, x: 0, y: 0 });
    for (const l of doc.root.children.slice()) doc.remove(l);
    doc.add(layer, doc.root, 0);
    doc.setActive(layer);
    return layer;
  }

  /**
   * Converts `doc` to mode `to` as one history entry.
   * @param {{ flatten?: boolean, options?: object, label?: string }} [opts] options are the target mode's
   *   (bitmap: method, dpi, frequency, angle, shape, pattern; duotone: duotone; indexed: colors, palette, forced,
   *   transparency, matte, dither, ditherAmount, preserveExactColors, custom; grayscale: method)
   * @returns {boolean} false when nothing was converted
   */
  function convertDocument(doc, to, { flatten = false, options = {}, label = null } = {}) {
    const from = doc.mode;
    if (!MODES[to] || from === to) return false;
    const st = modeState(doc);
    const source = { colorTable: st.colorTable, transparentIndex: st.transparentIndex, duotone: st.duotone, multichannel: st.multichannel };
    const before = capture(doc);
    let bytes = 0;
    if (flatten || (flattenPlan(doc, to) === 'required')) flattenRaw(doc, { white: to !== 'indexed' });
    const opts = { ...options };
    let scale = 1;
    if (to === 'bitmap') {
      const outDpi = Math.max(1, Math.min(9600, Number(opts.dpi) || doc.dpi));
      scale = outDpi / doc.dpi;
      // the screen frequency is in lines per inch of the output
      opts.dpi = outDpi;
      if (opts.method === 'custom-pattern') opts.pattern = bitmapPatternTile(opts.pattern);
    }
    // the inks belong to the document, whether or not it has a raster layer to convert
    const next = { colorTable: null, duotone: to === 'duotone' ? normalizeDuotone(opts.duotone ?? DUOTONE_PRESETS[0]) : null, extra: {}, channels: doc.channels.filter((c) => !c.spot) };
    if (next.duotone) opts.duotone = next.duotone;
    const rasters = doc.layers().filter((l) => l.type === 'raster' && !l.preview && !l.quickMask);
    const pixelsChange = !(FREE.has(from) && FREE.has(to));
    for (const layer of rasters) {
      let canvas = layer.canvas;
      if (to === 'bitmap' && Math.abs(scale - 1) > 1e-6) {
        // Bitmap's output resolution resamples the (flattened) image: more dots per inch for the same print size
        const w = Math.max(1, Math.round(doc.width * scale)), h = Math.max(1, Math.round(doc.height * scale));
        const scaled = createCanvas(w, h);
        const sctx = scaled.getContext('2d');
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(canvas, 0, 0, w, h);
        canvas = scaled;
      }
      if (!pixelsChange && to !== 'multichannel') continue;
      const out = convertPixels(imageOf(canvas), from, to, { ...opts, source });
      layer.canvas = canvasOf(out);
      // 16/32-bit pixels: grey like the proxy; unchanged when a grey document only gains colour channels; otherwise
      // dropped so lib/depth.js rebuilds them from the converted proxy
      if (layer.deep) layer.deep = to === 'grayscale' ? greyDeep(layer.deep) : from === 'grayscale' && FREE.has(to) ? layer.deep : null;
      layer.touch();
      bytes += out.data.length;
      if (out.colorTable) {
        next.colorTable = out.colorTable.map((c) => [c[0], c[1], c[2]]);
        if (out.transparentIndex >= 0) next.extra.transparentIndex = out.transparentIndex;
      }
      if (out.channels) {
        const spots = {};
        const made = out.channels.map((c) => {
          const ch = { id: newId('C'), name: c.name, mask: c.data, spot: { key: c.key, color: c.color } };
          spots[ch.id] = { key: c.key, color: c.color };
          bytes += c.data.length;
          return ch;
        });
        next.channels = [...made, ...next.channels];
        next.extra.multichannel = { source: out.multichannel.source, duotone: out.multichannel.duotone ?? null, spots };
      }
    }
    if (to === 'bitmap' && Math.abs(scale - 1) > 1e-6) {
      const w = Math.max(1, Math.round(doc.width * scale)), h = Math.max(1, Math.round(doc.height * scale));
      next.channels = next.channels.map((c) => ({ ...c, mask: resampleMask(c.mask, doc.width, doc.height, w, h) }));
      doc.guides = doc.guides.map((g) => ({ ...g, pos: Number.isFinite(g.pos) ? g.pos * scale : g.pos }));
      if (doc.selection && !doc.selection.isEmpty) doc.selection = Selection.fromMask(w, h, resampleMask(doc.selection.mask, doc.width, doc.height, w, h));
      doc.savedSelection = null;
      doc.width = w;
      doc.height = h;
      doc.dpi = opts.dpi;
    }
    doc.mode = to;
    doc.colorTable = next.colorTable;
    doc.duotone = next.duotone;
    doc.channels = next.channels;
    setExtra(doc, next.extra);
    record(doc, label ?? MODES[to].name, before, bytes);
    restore(doc, capture(doc)); // one code path announces the change (events, hooks, menu state) for do, undo and redo
    return true;
  }

  /** Changes the inks of a duotone document (Image > Mode > Duotone on a duotone document). */
  function setDuotone(doc, duotone, label = 'Duotone Options') {
    const before = capture(doc);
    doc.duotone = normalizeDuotone(duotone);
    record(doc, label, before);
    restore(doc, capture(doc));
  }

  /**
   * Replaces the colour table of an indexed document. Pixels keep their index, as in a real indexed image: a
   * pixel showing entry n of the old table shows entry n of the new one; the transparent entry is alpha 0.
   */
  function setColorTable(doc, table, transparentIndex = -1, label = 'Color Table') {
    const st = modeState(doc);
    const oldTable = st.colorTable ?? [], oldTi = st.transparentIndex;
    const newTable = table.slice(0, 256).map((c) => [c[0] & 255, c[1] & 255, c[2] & 255]);
    if (!newTable.length) return false;
    const ti = transparentIndex >= 0 && transparentIndex < newTable.length ? transparentIndex : -1;
    const before = capture(doc);
    let bytes = 0;
    if (oldTable.length) {
      const mapper = createMapper(oldTable, oldTi);
      const fallback = createMapper(newTable, ti);
      for (const layer of doc.layers()) {
        if (layer.type !== 'raster') continue;
        const img = imageOf(layer.canvas);
        const d = img.data;
        let prevKey = -1, prevIndex = 0;
        for (let i = 0; i < d.length; i += 4) {
          let k;
          if (d[i + 3] < 128) {
            if (oldTi < 0) continue; // transparency outside the table (a layer edge) stays what it is
            k = oldTi;
          } else {
            const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
            if (key !== prevKey) {
              prevKey = key;
              prevIndex = mapper.nearest(d[i], d[i + 1], d[i + 2]);
            }
            k = prevIndex;
          }
          if (k === ti) {
            d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
            continue;
          }
          const c = newTable[k] ?? newTable[fallback.nearest(d[i], d[i + 1], d[i + 2])];
          d[i] = c[0];
          d[i + 1] = c[1];
          d[i + 2] = c[2];
          d[i + 3] = 255;
        }
        layer.canvas = canvasOf(img);
        layer.touch();
        bytes += d.length;
      }
    }
    doc.colorTable = newTable;
    const extra = { ...(doc.meta?.imageMode ?? {}) };
    if (ti >= 0) extra.transparentIndex = ti;
    else delete extra.transparentIndex;
    setExtra(doc, extra);
    record(doc, label, before, bytes);
    restore(doc, capture(doc));
    return true;
  }

  // ---- Image > Mode ----------------------------------------------------------------------------------------------

  const lastOptions = (mode) => clone(app.settings.modeOptions?.[mode] ?? null) ?? defaultOptions(mode);
  function defaultOptions(mode) {
    if (mode === 'bitmap') return { method: '50-threshold' };
    if (mode === 'indexed') return { palette: 'adaptive', colors: 256, forced: 'none', transparency: true, matte: null, dither: 'diffusion', ditherAmount: 75, preserveExactColors: false };
    if (mode === 'duotone') return { duotone: null };
    return {};
  }
  function rememberOptions(mode, options) {
    if (!['bitmap', 'indexed', 'duotone'].includes(mode)) return;
    const stored = { ...options };
    delete stored.dpi; // the output resolution belongs to the document, not to the next one
    app.settings.modeOptions = { ...(app.settings.modeOptions ?? {}), [mode]: stored };
    app.saveSettingsSoon();
  }

  /**
   * image:mode. arg: a mode id (asks what the conversion needs) or { mode, flatten?, options?, silent? } which
   * converts without dialogs when it says enough (recorded actions, Conditional Mode Change, the Assistant).
   */
  async function modeCommand(arg, ctx = null) {
    const doc = app.doc;
    if (!doc) return ctx?.cancel();
    let req = typeof arg === 'string' ? { mode: arg } : arg && typeof arg === 'object' ? { ...arg } : null;
    if (!req) {
      // no mode named (an action step set to show its dialog, Insert Menu Item): ask which
      const mode = await modeChoice(app, doc.mode);
      if (!mode) return ctx?.cancel();
      req = { mode };
    } else if (ctx?.source === 'action' && req.silent === undefined) req.silent = true; // a played action does not stop to ask
    if (!MODES[req.mode] || !app.docs.docs.includes(doc)) return ctx?.cancel();
    const to = req.mode, from = doc.mode;
    if (to === from) {
      // Photoshop opens Duotone Options again on a duotone document; every other mode has nothing to ask
      if (to !== 'duotone') return ctx?.cancel();
      const duotone = req.options?.duotone ?? (req.silent ? null : (await duotoneDialog(app, doc, { duotone: doc.duotone, title: 'Duotone Options' }))?.duotone);
      if (!duotone) return ctx?.cancel();
      setDuotone(doc, duotone);
      ctx?.setReplayArg({ mode: to, options: { duotone: normalizeDuotone(duotone) } });
      return true;
    }
    if ((doc.depth ?? 8) !== 8 && !MODES[to].depths.includes(doc.depth)) {
      ctx?.cancel();
      app.dialogs.toast(`${MODES[to].name} needs ${to === 'cmyk' || to === 'lab' || to === 'multichannel' ? '8 or 16' : '8'} bits per channel: choose Image > Mode > 8 Bits/Channel first`, { kind: 'error' });
      return false;
    }
    const plan = flattenPlan(doc, to);
    let flatten = plan === 'required';
    if (plan === 'required' && req.flatten === undefined && !req.silent) {
      const ok = await app.dialogs.confirm(`Converting to ${MODES[to].name} flattens the image. Flatten layers?`, { title: MODES[to].name, okLabel: 'Flatten', detail: FLATTENING_MODES.includes(to) ? `${MODES[to].name} documents hold a single layer.` : `${MODES[from].name} layers cannot be converted one by one.` });
      if (!ok) return ctx?.cancel();
    } else if (plan === 'optional') {
      if (typeof req.flatten === 'boolean') flatten = req.flatten;
      else if (req.silent) flatten = false;
      else {
        const choice = await flattenChoice(app, MODES[to].name);
        if (!choice) return ctx?.cancel();
        flatten = choice === 'flatten';
      }
    }
    let options = req.options ?? null;
    if (!options) {
      if (req.silent) options = lastOptions(to);
      else if (to === 'bitmap') options = await bitmapDialog(app, doc, lastOptions(to));
      else if (to === 'duotone') options = await duotoneDialog(app, doc, { duotone: lastOptions(to).duotone, title: 'Duotone Options' });
      else if (to === 'indexed') options = await indexedDialog(app, doc, lastOptions(to));
      else options = {};
      if (!options) return ctx?.cancel();
    }
    // the document may have been closed or changed mode behind a dialog
    if (!app.docs.docs.includes(doc) || doc.mode !== from) return ctx?.cancel();
    try {
      await app.busy(`Converting to ${MODES[to].name}…`, async () => convertDocument(doc, to, { flatten, options }));
    } catch (err) {
      ctx?.cancel();
      app.reportError(err, `Could not convert to ${MODES[to].name}`);
      return false;
    }
    rememberOptions(to, options);
    ctx?.setReplayArg({ mode: to, flatten, options: clone(options) });
    return true;
  }

  // ---- Color Table, Trap, Conditional Mode Change ----------------------------------------------------------------

  async function colorTableCommand(arg, ctx = null) {
    const doc = app.doc;
    if (!doc || doc.mode !== 'indexed') return ctx?.cancel();
    const st = modeState(doc);
    const result = arg && typeof arg === 'object' && Array.isArray(arg.table) ? arg : await colorTableDialog(app, { table: st.colorTable ?? [], transparentIndex: st.transparentIndex });
    if (!result) return ctx?.cancel();
    const ti = Number.isInteger(result.transparentIndex) ? result.transparentIndex : -1;
    await app.busy('Color Table…', async () => setColorTable(doc, result.table, ti));
    ctx?.setReplayArg({ table: result.table.map((c) => [c[0], c[1], c[2]]), transparentIndex: ti });
    return true;
  }

  async function trapCommand(arg, ctx = null) {
    const doc = app.doc;
    if (!doc || doc.mode !== 'cmyk') return ctx?.cancel();
    const params = arg && typeof arg === 'object' && Number(arg.width) > 0 ? { width: Number(arg.width) } : await trapDialog(app, { width: app.settings.modeOptions?.trap?.width ?? 1, dpi: doc.dpi });
    if (!params) return ctx?.cancel();
    const session = app.beginPixelEdit({ label: 'Trap', margin: Math.ceil(params.width) });
    if (!session) return ctx?.cancel();
    try {
      const img = await app.busy('Trap…', async () => {
        const copy = { width: session.base.width, height: session.base.height, data: new Uint8ClampedArray(session.base.data) };
        return trap(copy, { width: params.width });
      });
      session.commit('Trap', img);
    } catch (err) {
      session.cancel();
      ctx?.cancel();
      app.reportError(err, 'Trap failed');
      return false;
    }
    app.settings.modeOptions = { ...(app.settings.modeOptions ?? {}), trap: { width: params.width } };
    app.saveSettingsSoon();
    ctx?.setReplayArg({ width: params.width });
    return true;
  }

  /** file:automate-conditional-mode. arg { sources: [mode ids], target } converts only when the document is in one of the source modes. */
  async function conditionalCommand(arg, ctx = null) {
    const doc = app.doc;
    if (!doc) return ctx?.cancel();
    const params = arg && typeof arg === 'object' && MODES[arg.target] ? { sources: Array.isArray(arg.sources) ? arg.sources.filter((m) => MODES[m]) : Object.keys(MODES), target: arg.target } : await conditionalDialog(app, { current: doc.mode, ...(app.settings.modeOptions?.conditional ?? {}) });
    if (!params) return ctx?.cancel();
    app.settings.modeOptions = { ...(app.settings.modeOptions ?? {}), conditional: { sources: params.sources, target: params.target } };
    app.saveSettingsSoon();
    ctx?.setReplayArg({ sources: params.sources.slice(), target: params.target });
    if (!params.sources.includes(doc.mode) || doc.mode === params.target) return false;
    // meant for actions and Batch: the conversion runs with the last used options and asks nothing
    return modeCommand({ mode: params.target, silent: true });
  }

  app.commands.registerAll({
    'image:mode': { label: 'Mode', enabled: has, dialog: true, run: modeCommand },
    'image:color-table': { label: 'Color Table…', enabled: () => app.doc?.mode === 'indexed', dialog: true, run: colorTableCommand },
    'image:trap': { label: 'Trap…', enabled: () => app.doc?.mode === 'cmyk' && !!app.doc.active, dialog: true, run: trapCommand },
    'file:automate-conditional-mode': { label: 'Conditional Mode Change…', enabled: has, dialog: true, run: conditionalCommand },
    'file:save-for-web': { label: 'Save for Web (Legacy)…', enabled: has, dialog: true, run: (arg, ctx) => saveForWeb(app, arg, ctx) },
  });

  /** For other modules (actions' conditionals, the Assistant, tests). */
  app.modes = {
    MODES,
    state: modeState,
    isConstrained,
    flattenPlan,
    convert: (doc, to, opts) => convertDocument(doc, to, opts),
    setColorTable,
    setDuotone,
    splitChannels,
  };

  installFormats(app, { modeState });
  refreshHooks();
}
