// 16 and 32 bits per channel (see ARCHITECTURE.md "16 and 32 bits per channel").
//
// A raster layer of a deep document keeps its real pixels in `layer.deep` ({ type: 'u16'|'f32', data },
// straight RGBA, the size of the layer canvas) and the canvas is their 8-bit proxy: everything that
// paints, composites and previews keeps working on canvases, and this module keeps the two in step.
//
//  - Image > Mode > 8/16/32 Bits/Channel (`image:depth`) allocates or drops the deep pixels, one undo entry.
//  - An adjustment committed through a pixel-edit session ('pixels:committed' with meta.adjustment) is run again
//    on the deep pixels (pixels/deep.js: exact float maths for most kinds) and the proxy is regenerated from them.
//  - Every other pixel change (brush strokes, filters, transforms, fills: 8-bit work) is taken over from the
//    proxy by the sync pass: only the pixels whose proxy no longer matches the deep samples change, so the
//    rest of the layer keeps its precision. The pass is content based (it compares pixels, not events), which
//    makes it independent of who changed the canvas and how: undo and redo simply bring the proxy back, and the
//    deep samples that proxy used to stand for are put back from a small per-layer stash.
//  - 16-bit PNG, TIFF and TGA open and export through lib/io.js's registries; .pigment stores `layer.deep` itself.
//
// Masks stay 8-bit (Photoshop keeps 16-bit masks; Pigment does not). 32-bit samples are display-referred
// floats (1 = white, more is HDR headroom the proxy clamps), not linear light as in Photoshop.
import { ADJUSTMENTS } from '../../shared/pixels/adjust.js';
import { hasEnabledStyles } from '../../shared/pixels/styles.js';
import { maskCanvasFor, hasEffectiveMask } from './mask-render.js';
import {
  DEEP_TYPES, DEEP_BITS, fromCanvasData, toCanvasData, convertDepth, createDeep, extractRect, writeRect, mixRect, hasPrecision, syncFromProxy,
  applyAdjustmentDeep, isExactKind, lutCovers, blendDeep, resampleDeep, carryOver, statistics, DEEP_BLEND_MODES, q8u16, q8f32, toPs16,
} from '../../shared/pixels/deep.js';
import { encodePng, decodePng, toRgba16, isPng, pngInfo } from '../../shared/pixels/png.js';
import { encodeTiff, decodeTiff, toRgba, isTiff } from '../../shared/pixels/tiff.js';
import { encodeTga, decodeTga } from '../../shared/pixels/tga.js';
import { parseColor } from '../../shared/pixels/color.js';
import { Document, RasterLayer, createCanvas, isDefaultBlending } from './document.js';
import { flattenDocument } from './compositor.js';
import { registerExportFormat, registerOpenFormat, baseName, extOf } from './io.js';
import { SAVE_FILTERS } from './documents.js';
import { bridge } from './bridge.js';

const SYNC_DELAY = 150; // ms of quiet after the last change before the deep pixels follow the proxy
const STASH_PATCHES = 8; // precise patches remembered per canvas for undo/redo ...
const STASH_BYTES = 128 * 1024 * 1024; // ... and their memory bound
const DETACHED_BYTES = 384 * 1024 * 1024; // deep pixels kept for layers that only live in the undo history
const DEPTH_NAMES = { 8: '8 Bits/Channel', 16: '16 Bits/Channel', 32: '32 Bits/Channel' };
// Image > Mode: bitmap, indexed and duotone are 8-bit only; 32 bits need RGB or Grayscale (the menu greys the rest out)
const allowedDepths = (mode) => (['bitmap', 'indexed', 'duotone'].includes(mode) ? [8] : ['rgb', 'grayscale'].includes(mode ?? 'rgb') ? [8, 16, 32] : [8, 16]);

const isDeepLayer = (l) => l.type === 'raster' && !l.quickMask && !l.preview;
const ctx2d = (canvas) => canvas.getContext('2d', { willReadFrequently: true });
const planesOf = (layer) => ({ type: layer.deep.type, data: layer.deep.data, width: layer.canvas.width, height: layer.canvas.height });

export function install(app) {
  // ---- keeping deep pixels in step ------------------------------------------------------------------------------
  // canvas -> { deep, version, stash }: `version` is the layer version the deep pixels were last checked at;
  // `stash` holds precise patches the proxy has overwritten (newest first) so an undo can bring them back.
  // Keyed by canvas because history swaps whole canvases (Free Transform, Image Size, layers growing under a brush)
  // and puts them back on undo: the deep pixels of a canvas stay with it.
  const states = new WeakMap();
  // deep sample array -> { canvas, width, height, x, y, ... }: which canvas an array describes and where that canvas
  // sat. Image-wide commands clone layer objects (the clone still points at the old array) and layers swap their
  // canvas under a brush: an array that belongs to another canvas is never written to, it is where the new canvas's
  // pixels are carried over from (pixels/deep.js carryOver).
  const owners = new WeakMap();
  const ledger = []; // every array this module keeps, newest first: the bound on what undo history may hold on to

  function remember(layer) {
    const canvas = layer.canvas;
    const st = { deep: layer.deep, version: layer.version, stash: [], bytes: 0 };
    states.set(canvas, st);
    const data = layer.deep.data;
    let rec = owners.get(data);
    if (!rec) {
      rec = { data: new WeakRef(data), bytes: data.byteLength, layers: [] };
      owners.set(data, rec);
      ledger.unshift(rec);
    }
    Object.assign(rec, { canvas: new WeakRef(canvas), width: canvas.width, height: canvas.height, x: layer.x, y: layer.y });
    if (!rec.layers.some((r) => r.deref() === layer)) rec.layers.push(new WeakRef(layer));
    return st;
  }

  function stashPatch(st, patch) {
    if (!patch || !hasPrecision(patch)) return; // 8-bit values are rebuilt from the proxy anyway
    st.stash.unshift(patch);
    st.bytes += patch.data.byteLength;
    while (st.stash.length > STASH_PATCHES || (st.bytes > STASH_BYTES && st.stash.length > 1)) st.bytes -= st.stash.pop().data.byteLength;
  }

  /**
   * Deep pixels of layers that are no longer in a document (they wait in the undo history: before a crop, a
   * flatten, a transform) are kept so an undo gets them back, newest first up to DETACHED_BYTES; older ones are
   * dropped, and a layer that returns without them starts again from its 8-bit proxy.
   */
  function prune() {
    const live = new Set();
    for (const doc of app.docs?.docs ?? []) for (const l of doc.layers()) if (l.deep?.data) live.add(l.deep.data);
    let detached = 0;
    for (let i = 0; i < ledger.length; i++) {
      const rec = ledger[i];
      const data = rec.data.deref();
      if (!data) {
        ledger.splice(i--, 1);
        continue;
      }
      if (live.has(data)) continue;
      detached += rec.bytes;
      if (detached <= DETACHED_BYTES) continue;
      const canvas = rec.canvas?.deref();
      if (canvas && states.get(canvas)?.deep.data === data) states.delete(canvas);
      for (const ref of rec.layers) {
        const l = ref.deref();
        if (l?.deep?.data === data) l.deep = null;
      }
      owners.delete(data);
      ledger.splice(i--, 1);
    }
  }

  /**
   * Makes one raster layer's deep pixels describe its canvas. `override` ({ rect, img }) reads that part of the
   * proxy from `img` instead of the canvas (the state before a pixel-edit session, to redo the edit at full depth).
   */
  function syncLayer(doc, layer, override = null) {
    const type = DEEP_TYPES[doc.depth];
    const canvas = layer.canvas;
    const w = canvas.width, h = canvas.height, n = w * h * 4;
    let st = states.get(canvas);
    if (st && (st.deep.type !== type || st.deep.data.length !== n)) st = null;
    const given = layer.deep?.data ? layer.deep : null;
    const owner = given ? owners.get(given.data) : null;
    let external = false;
    let from = null; // planes of another canvas these pixels may have come from
    if (given && !owner && given.data.length === n) {
      // deep pixels this module has not seen: a file just read, a cloned layer, a merged HDR result. They are the truth
      if (given.type !== type) layer.deep = { type, data: convertDepth({ type: given.type, data: given.data }, type).data };
      st = remember(layer);
      external = true;
    } else if (st) {
      // the canvas is known; when the layer points at another canvas's pixels (an undo put this canvas back), take its own
      if (given?.data !== st.deep.data) layer.deep = st.deep;
      const rec = owners.get(st.deep.data);
      if (rec) {
        rec.x = layer.x;
        rec.y = layer.y;
        if (!rec.layers.some((r) => r.deref() === layer)) rec.layers.push(new WeakRef(layer));
      }
      if (st.version === layer.version && !override) return;
    } else if (owner && owner.width * owner.height * 4 === given.data.length) {
      from = { type: given.type, data: given.data, width: owner.width, height: owner.height, x: owner.x, y: owner.y };
    }
    const img = ctx2d(canvas).getImageData(0, 0, w, h);
    if (override) {
      const { rect, img: part } = override;
      for (let y = 0; y < rect.height; y++) img.data.set(part.data.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * w + rect.x) * 4);
    }
    if (!st) {
      // a canvas without deep pixels yet. Pixels that only moved here from another canvas (a crop, a flip, a layer that
      // grew under a brush) bring their samples along; the rest (new, pasted, resampled) starts as the proxy's
      const data = from ? carryOver(img, from, { dx: from.x - layer.x, dy: from.y - layer.y, type }).planes.data : fromCanvasData(img, type).data;
      layer.deep = { type, data };
      remember(layer).version = override ? -1 : layer.version;
      return;
    }
    const planes = planesOf(layer);
    const res = syncFromProxy(planes, img, { restore: st.stash, loose: external, backup: true });
    if (res.before && res.bounds) stashPatch(st, extractRect({ type, data: res.before, width: w, height: h }, res.bounds));
    if (external && res.loosePixels) {
      // a proxy rounded another way than ours: the deep pixels are the truth, the canvas is rewritten from them
      const proxy = toCanvasData(planes);
      ctx2d(canvas).putImageData(new ImageData(proxy.data, w, h), 0, 0);
      layer.touch();
      doc.view?.invalidate?.();
    }
    st.version = override ? -1 : layer.version;
  }

  /** Brings every raster layer of the document in step with its depth (drops deep pixels of 8-bit documents). */
  function syncNow(doc) {
    if (!doc?.root) return;
    clearTimeout(timers.get(doc));
    timers.delete(doc);
    const deep = doc.depth === 16 || doc.depth === 32;
    for (const layer of doc.layers()) {
      if (layer.type !== 'raster') continue;
      if (!deep || !isDeepLayer(layer)) {
        if (layer.deep) layer.deep = null; // a layer that came from a deep document into an 8-bit one
        continue;
      }
      try {
        syncLayer(doc, layer);
      } catch (err) {
        console.warn('depth: could not sync a layer', err);
      }
    }
    if (deep) prune();
  }

  const timers = new WeakMap(); // doc -> timeout id

  /** Syncs the document once it has been quiet for SYNC_DELAY (slider drags and strokes change pixels many times a second). */
  function schedule(doc) {
    if (!doc || !(doc.depth > 8)) return;
    clearTimeout(timers.get(doc));
    timers.set(doc, setTimeout(() => {
      timers.delete(doc);
      if (!app.docs?.docs?.includes(doc)) return;
      // a stroke in progress repaints the canvas on every pointer move: wait for it to end. The same goes for a
      // preview a dialog or an on-canvas session shows on a layer (lib/adjust-ui.js counts them in previewHolds):
      // it is not an edit until it is committed, and taking it over would round the samples under it even when
      // the session is cancelled (the stash that brings samples back only holds a few patches)
      if (doc.history?.stroke || doc.previewHolds > 0) return schedule(doc);
      syncNow(doc);
    }, SYNC_DELAY));
  }

  app.on('doc:opened', (doc) => {
    if (!doc?.layers) return;
    if (!(doc.depth > 8)) {
      // Image > Duplicate (lib/image-ops.js) clones the layers, deep pixels included, into a document it creates
      // without a depth: a new document whose raster layers all carry deep pixels of one type is a deep document
      const rasters = doc.layers().filter(isDeepLayer);
      const type = rasters[0]?.deep?.type;
      if (DEEP_BITS[type] && rasters.every((l) => l.deep?.type === type && l.deep.data?.length === l.canvas.width * l.canvas.height * 4)) {
        doc.depth = DEEP_BITS[type];
        app.syncUiState();
      }
    }
    if (doc.depth > 8 || doc.layers().some((l) => l.deep)) syncNow(doc);
  });
  app.on('doc:change', (e) => {
    const doc = e?.doc;
    if (!doc || !(doc.depth > 8)) return;
    if (e.kind === 'pixels' || e.kind === 'tree' || e.kind === 'canvas' || e.kind === 'history') schedule(doc);
  });

  /** Selection coverage (0..255) of a layer-local rect, the way a pixel-edit session blends its result. */
  function selectionAlpha(doc, docRect) {
    const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
    if (!sel) return null;
    const out = new Uint8ClampedArray(docRect.width * docRect.height);
    for (let y = 0; y < docRect.height; y++) {
      const sy = docRect.y + y;
      if (sy < 0 || sy >= doc.height) continue;
      for (let x = 0; x < docRect.width; x++) {
        const sx = docRect.x + x;
        if (sx >= 0 && sx < doc.width) out[y * docRect.width + x] = sel.mask[sy * doc.width + sx];
      }
    }
    return out;
  }

  /**
   * Writes a patch of deep samples back into the canvas they were taken from (undo and redo of an adjustment). The
   * content-based pass cannot do this: it only looks at samples whose 8-bit value differs from the proxy, so after
   * the undo of a subtle edit (or of any edit to float values above white, which the proxy clamps) it would find
   * the proxy "in step" with the edited samples and leave them in place.
   */
  function putPatch(layer, canvas, patch, inStep) {
    const st = states.get(canvas);
    if (layer.canvas !== canvas || !st || st.deep.type !== patch.type || st.deep.data.length !== canvas.width * canvas.height * 4) return;
    writeRect({ type: st.deep.type, data: st.deep.data, width: canvas.width, height: canvas.height }, patch);
    layer.deep = st.deep;
    // The patch only covers its own rect. When the samples were not in step before this entry ran (the entry next to
    // it in the history was undone or redone in the same breath: a click in the History panel, two quick Ctrl+Z),
    // the pass that change scheduled must still run for the rest of the canvas: it leaves the patch alone, because
    // the proxy shows exactly its 8-bit value.
    if (inStep) st.version = layer.version;
  }
  /** Whether a layer's deep samples describe its canvas right now (nothing is waiting for the sync pass). */
  const inStep = (layer, canvas) => layer.canvas === canvas && states.get(canvas)?.version === layer.version;

  // an adjustment committed at 8 bits is run again on the deep pixels; anything else is picked up by the sync pass
  app.on('pixels:committed', (e) => {
    const { doc, layer, rect, local, isMask, original, after, entry, meta } = e ?? {};
    if (!doc || !(doc.depth > 8) || isMask || !layer || !isDeepLayer(layer)) return;
    const adj = meta?.adjustment;
    const def = adj && Object.prototype.hasOwnProperty.call(ADJUSTMENTS, adj.kind) ? ADJUSTMENTS[adj.kind] : null;
    if (!def || def.placeholder || !local || !original || layer.canvas.width < local.x + local.width || layer.canvas.height < local.y + local.height) return schedule(doc);
    try {
      // the deep pixels as they were when the session began (previews may have been taken over in between)
      syncLayer(doc, layer, { rect: local, img: original });
      const st = states.get(layer.canvas);
      const planes = planesOf(layer);
      const before = extractRect(planes, local);
      // ctx (I.4): the planes are the layer's, whose (0, 0) is the layer position in the document
      applyAdjustmentDeep(planes, adj.kind, adj.params ?? {}, local, { origin: { x: layer.x, y: layer.y }, docWidth: doc.width, docHeight: doc.height, scale: 1 });
      // image modes that constrain pixels to grey (lib/modes.js) do so on the 8-bit result; mirror it
      if (doc.mode === 'grayscale') applyAdjustmentDeep(planes, 'desaturate', {}, local);
      const alpha = selectionAlpha(doc, rect);
      if (alpha) mixRect(planes, before, alpha);
      stashPatch(st, before);
      // the proxy and the undo entry's "after" pixels become the quantised deep result, so redo shows exactly this
      const proxy = toCanvasData(planes, { rect: local });
      ctx2d(layer.canvas).putImageData(new ImageData(proxy.data, local.width, local.height), local.x, local.y);
      if (after?.data?.length === proxy.data.length) after.data.set(proxy.data);
      layer.touch();
      st.version = layer.version;
      if (entry) {
        // the undo entry only holds 8-bit pixels: it also puts the deep samples of the rect back, exactly
        const canvas = layer.canvas;
        const result = extractRect(planes, local);
        const { undo, redo } = entry;
        const step = (run, patch) => () => {
          const was = inStep(layer, canvas);
          run();
          putPatch(layer, canvas, patch, was);
        };
        entry.undo = step(undo, before);
        entry.redo = step(redo, result);
        entry.bytes = (entry.bytes ?? 0) + before.data.byteLength + result.data.byteLength;
        // the entry was pushed (and the history trimmed to its memory bound) before it grew by the two patches
        if (doc.history.entries.includes(entry)) {
          doc.history.trim();
          doc.history.onChange();
        }
      }
      doc.changed('pixels', { layer, rect });
    } catch (err) {
      console.warn('depth: the adjustment was kept at 8 bits', err);
      schedule(doc);
    }
  });

  // ---- Image > Mode > Bits/Channel ------------------------------------------------------------------------------
  function setDepth(doc, depth, { dither = app.settings.depthDither !== false } = {}) {
    const from = doc.depth ?? 8;
    if (depth === from) return false;
    syncNow(doc);
    const type = DEEP_TYPES[depth] ?? null;
    const records = [];
    let bytes = 0;
    for (const layer of doc.layers()) {
      if (!isDeepLayer(layer)) continue;
      const canvas = layer.canvas, w = canvas.width, h = canvas.height;
      const rec = { layer, canvas, before: layer.deep, after: null, pixelsBefore: null, pixelsAfter: null };
      if (type) rec.after = layer.deep ? { type, data: convertDepth(planesOf(layer), type).data } : { type, data: fromCanvasData(ctx2d(canvas).getImageData(0, 0, w, h), type).data };
      else if (dither && layer.deep && hasPrecision(layer.deep)) {
        // going down to 8 bits: in-between values become noise instead of bands
        const img = toCanvasData(planesOf(layer), { dither: true });
        rec.pixelsBefore = ctx2d(canvas).getImageData(0, 0, w, h);
        rec.pixelsAfter = new ImageData(img.data, w, h);
        bytes += w * h * 8;
      }
      bytes += (rec.before?.data.byteLength ?? 0) + (rec.after?.data.byteLength ?? 0);
      records.push(rec);
    }
    const apply = (to, which) => {
      doc.depth = to;
      for (const rec of records) {
        const { layer, canvas } = rec;
        if (layer.canvas !== canvas) {
          // the canvas was swapped since (it cannot be, with a linear history; be safe): the sync pass rebuilds this layer
          if (to === 8) layer.deep = null;
          continue;
        }
        const pixels = which === 'after' ? rec.pixelsAfter : rec.pixelsBefore;
        if (pixels) {
          ctx2d(canvas).putImageData(pixels, 0, 0);
          layer.touch();
        }
        layer.deep = which === 'after' ? rec.after : rec.before;
        if (layer.deep) remember(layer);
        else states.delete(canvas);
      }
      doc.changed('props');
      app.syncUiState();
      app.commands.invalidate();
      schedule(doc);
    };
    doc.history.run(DEPTH_NAMES[depth], () => {
      apply(depth, 'after');
      return { undo: () => apply(from, 'before'), redo: () => apply(depth, 'after') };
    }, { bytes });
    return true;
  }

  function depthCommand(arg) {
    const doc = app.doc;
    if (!doc) return;
    const depth = Number(arg && typeof arg === 'object' ? arg.depth : arg);
    if (![8, 16, 32].includes(depth)) return;
    if (!allowedDepths(doc.mode).includes(depth)) {
      app.dialogs.toast(`${DEPTH_NAMES[depth]} is not available in this image mode`, { kind: 'error' });
      return;
    }
    const lostHdr = doc.depth === 32 && depth < 32;
    const changed = setDepth(doc, depth, arg && typeof arg === 'object' && 'dither' in arg ? { dither: !!arg.dither } : undefined);
    if (changed && lostHdr) app.dialogs.toast('Highlights brighter than white were clipped', { timeout: 2600 });
  }

  app.commands.registerAll({
    'image:depth': { enabled: () => !!app.doc, run: depthCommand, label: 'Bits/Channel' },
  });
  // the module replaces a stub that listed this id as unavailable
  if (Array.isArray(app.stubbed)) {
    const i = app.stubbed.indexOf('image:depth');
    if (i >= 0) app.stubbed.splice(i, 1);
  }

  // ---- flattening at full depth ---------------------------------------------------------------------------------
  const styled = (layer) => hasEnabledStyles(layer.styles);

  /**
   * How the document can be composited in float: the layers in drawing order, or the reason it cannot (then the
   * 8-bit composite is scaled up). Float covers raster, text, shape, fill and smart layers with the Normal,
   * Multiply and Screen blend modes, opacity, fill opacity and masks, Pass Through groups, and adjustment layers
   * whose kind has deep maths. `layers` limits the plan to those layers (a merge); `neutral` is the layer a merge
   * draws at full opacity in Normal mode (Merge Down hands the lower layer's blend mode and opacity to the result).
   */
  function planFlatten(doc, layers = null, neutral = null) {
    const steps = [];
    let reason = null;
    const walk = (group) => {
      const kids = group.children;
      for (let i = 0; i < kids.length && !reason; i++) {
        const layer = kids[i];
        if (!layer.visible) continue;
        const name = `“${layer.name}”`;
        if (layer.clip && kids.slice(0, i).some((k) => !k.clip)) reason = `${name} is a clipping mask`;
        else if (layer.type === 'adjustment') {
          const def = Object.prototype.hasOwnProperty.call(ADJUSTMENTS, layer.kind) ? ADJUSTMENTS[layer.kind] : null;
          if (!def || !(isExactKind(layer.kind, layer.params ?? {}) || lutCovers(layer.kind, layer.params ?? {}))) reason = `the ${def?.name ?? layer.kind} adjustment layer works at 8 bits`;
          else steps.push({ adjust: layer });
        } else if (!isDefaultBlending(layer.blending)) reason = `${name} has advanced blending options`; // knockout, Blend If, channels (K.3)
        else if (layer.isGroup) {
          if (layer.blend === 'pass-through' && layer.opacity >= 1 && !hasEffectiveMask(layer) && !styled(layer)) walk(layer); // mask (K.1)
          else reason = `the group ${name} is not a plain Pass Through group`;
        } else if (styled(layer)) reason = `${name} has layer effects`;
        else if (layer !== neutral && !DEEP_BLEND_MODES.includes(layer.blend)) reason = `${name} uses the ${String(layer.blend).replace(/-/g, ' ')} blend mode`;
        else steps.push({ layer });
      }
    };
    if (doc.depth > 8) {
      if (doc.mode === 'duotone' || doc.mode === 'indexed' || doc.mode === 'bitmap') reason = 'this image mode is rendered at 8 bits';
      else walk(layers ? { children: layers } : doc.root);
    } else reason = 'the document is 8 bits/channel';
    return reason ? { exact: false, reason } : { exact: true, steps };
  }

  function maskOf(layer, doc) {
    const c = maskCanvasFor(layer, doc, { purpose: 'bake' }); // mask (K.1)
    if (!c) return null;
    // mask canvases sit at the document origin; their alpha is the coverage
    return { data: ctx2d(c).getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height, x: 0, y: 0, channels: 4, offset: 3 };
  }

  /**
   * The flattened document as deep planes ({ type, width, height, data } plus exact and reason): composited in
   * float when planFlatten allows it, else the 8-bit composite scaled up (exact: false, reason says why).
   * With `layers` (and `neutral`, see planFlatten) only those layers are composited, the way a merge renders them:
   * without the mode's display pass, and with no 8-bit fallback (exact: false then comes without pixels).
   */
  function flattenDeep(doc, { type = doc.depth === 32 ? 'f32' : 'u16', compositor = doc.view?.compositor, layers = null, neutral = null } = {}) {
    syncNow(doc);
    const plan = planFlatten(doc, layers, neutral);
    if (!plan.exact) {
      if (layers) return { exact: false, reason: plan.reason };
      const flat = flattenDocument(doc, compositor);
      const planes = fromCanvasData(ctx2d(flat).getImageData(0, 0, flat.width, flat.height), type);
      return { ...planes, exact: false, reason: plan.reason };
    }
    const acc = createDeep(doc.width, doc.height, type);
    for (const step of plan.steps) {
      if (step.adjust) {
        const layer = step.adjust;
        const mask = maskOf(layer, doc);
        const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
        if (!(opacity > 0)) continue;
        const partial = opacity < 1 || mask;
        const before = partial ? extractRect(acc) : null;
        applyAdjustmentDeep(acc, layer.kind, layer.params ?? {});
        if (partial) {
          const alpha = new Uint8ClampedArray(doc.width * doc.height);
          for (let y = 0; y < doc.height; y++) {
            for (let x = 0; x < doc.width; x++) {
              const m = mask ? (x < mask.width && y < mask.height ? mask.data[(y * mask.width + x) * 4 + 3] : 0) : 255;
              alpha[y * doc.width + x] = m * opacity;
            }
          }
          mixRect(acc, before, alpha);
        }
        continue;
      }
      const layer = step.layer;
      let src, x, y;
      if (layer.type === 'raster' && layer.deep) {
        src = planesOf(layer);
        x = layer.x;
        y = layer.y;
      } else {
        // text, shapes, fills and smart objects render at 8 bits; they still blend in float
        const s = layer.type === 'raster' ? { canvas: layer.canvas, x: layer.x, y: layer.y } : compositor?.layerSource?.(layer) ?? (typeof layer.render === 'function' ? layer.render() : null);
        if (!s?.canvas?.width) continue;
        src = fromCanvasData(ctx2d(s.canvas).getImageData(0, 0, s.canvas.width, s.canvas.height), 'u16');
        x = s.x ?? 0;
        y = s.y ?? 0;
      }
      const plain = layer === neutral;
      blendDeep(acc, src, { alpha: (plain ? 1 : layer.opacity ?? 1) * (layer.fillOpacity ?? 1), mode: plain ? 'normal' : layer.blend, x, y, mask: maskOf(layer, doc) });
    }
    // Grayscale documents show (and export) the luma of the composite, so coloured layers cannot leak colour
    if (doc.mode === 'grayscale' && !layers) applyAdjustmentDeep(acc, 'desaturate');
    return { ...acc, exact: true, reason: null };
  }

  // Image > Flatten Image composites on canvases (8 bits). In a deep document the same composite is made in float
  // first and handed to the flattened layer, so flattening before an export does not cost the extra bits. The
  // command of lib/layer-ops.js is wrapped: its undo entry holds the layer object, which carries the deep pixels.
  const flattenBase = app.commands.commands.get('image:flatten');
  if (flattenBase) {
    /** The float composite over white (Flatten Image fills what is transparent with white), or null when 8 bits will do. */
    const floatFlat = (d) => {
      if (!(d?.depth > 8)) return null;
      try {
        const f = flattenDeep(d);
        if (!f.exact) return null;
        const white = createDeep(f.width, f.height, f.type);
        white.data.fill(f.type === 'f32' ? 1 : 65535);
        return blendDeep(white, f);
      } catch (err) {
        console.warn('depth: flattening at 8 bits', err);
        return null;
      }
    };
    /** Hands the float composite to the flattened (or merged) layer when that layer really shows the same picture. */
    const adopt = (d, flat, layer = d?.root.children.length === 1 ? d.root.children[0] : null) => {
      if (!flat || layer?.type !== 'raster' || layer.x !== 0 || layer.y !== 0 || layer.canvas.width !== flat.width || layer.canvas.height !== flat.height) return;
      const proxy = toCanvasData(flat);
      const shown = ctx2d(layer.canvas).getImageData(0, 0, flat.width, flat.height).data;
      // canvas blending rounds differently from float by a level or two; anything further off is another picture
      const step = Math.max(4, (Math.floor(shown.length / 4 / 2048) || 1) * 4);
      let off = 0, checked = 0;
      for (let i = 0; i < shown.length; i += step, checked++) {
        // coverage counts too (a merged layer may be translucent); a canvas keeps little colour under thin coverage
        if (Math.abs(shown[i + 3] - proxy.data[i + 3]) > 3) off++;
        else if (shown[i + 3] >= 128 && (Math.abs(shown[i] - proxy.data[i]) > 3 || Math.abs(shown[i + 1] - proxy.data[i + 1]) > 3 || Math.abs(shown[i + 2] - proxy.data[i + 2]) > 3)) off++;
      }
      if (off > checked * 0.02) return;
      layer.deep = { type: flat.type, data: flat.data };
      ctx2d(layer.canvas).putImageData(new ImageData(proxy.data, flat.width, flat.height), 0, 0);
      layer.touch();
      remember(layer);
      d.changed('pixels', { layer });
    };
    app.commands.register('image:flatten', {
      ...flattenBase,
      // synchronous like the command it wraps: callers (mode conversions) go on in the same tick
      run: (arg, ctx) => {
        const d = app.doc;
        const flat = floatFlat(d);
        const result = flattenBase.run(arg, ctx);
        if (result && typeof result.then === 'function') return result.then((r) => (adopt(d, flat), r));
        adopt(d, flat);
        return result;
      },
    });

    // The merges of lib/layer-ops.js composite on canvases as well, which would rebuild the whole merged layer from
    // 8 bits (256 levels, float highlights clipped at white) even when an empty layer is merged down. They are wrapped
    // the same way: the layers about to be merged are composited in float first, and the merged layer adopts that.
    const inOrder = (d, list) => {
      const order = d.layers();
      // a layer inside a selected group is drawn by that group
      return list.filter((l) => !list.some((o) => o !== l && isInside(l, o))).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    };
    const isInside = (layer, group) => {
      for (let p = layer.parent; p; p = p.parent) if (p === group) return true;
      return false;
    };
    /**
     * Whether the float composite of the layers is the picture the canvas merge makes. lib/layer-ops.js
     * (renderLayersFlat) bakes in every group around a merged layer that will not be around the result as well: its
     * opacity, mask, blend mode and effects, and a hidden group hides the layer. planFlatten only walks the merged
     * layers themselves, so the float path is for merges where such groups change nothing.
     */
    const likeCanvasMerge = (layers) => {
      const kept = new Set(); // the groups the result stays inside of (it takes the topmost layer's place): they go on applying
      for (let p = layers[layers.length - 1].parent; p; p = p.parent) kept.add(p);
      for (const l of layers) {
        for (let p = l.parent; p && !kept.has(p); p = p.parent) {
          if (!p.visible || p.clip || p.blend !== 'pass-through' || p.opacity < 1 || hasEffectiveMask(p) || hasEnabledStyles(p.styles) || !isDefaultBlending(p.blending)) return false;
        }
      }
      return true;
    };
    const MERGES = {
      'layer:merge-down': (d) => {
        const top = d.active;
        const below = top?.parent?.children[top.parent.children.indexOf(top) - 1];
        return below ? { layers: [below, top], neutral: below } : null;
      },
      'layer:merge-selected': (d) => (d.selected.size > 1 ? { layers: inOrder(d, [...d.selected].filter((l) => l !== d.root)) } : null),
      'layer:merge-visible': (d) => ({ layers: d.root.children.filter((l) => l.visible) }),
    };
    for (const [id, pick] of Object.entries(MERGES)) {
      const base = app.commands.commands.get(id);
      if (!base) continue;
      app.commands.register(id, {
        ...base,
        run: (arg, ctx) => {
          const d = app.doc;
          let flat = null, merging = null;
          if (d?.depth > 8) {
            try {
              merging = pick(d);
              // every layer must be shown: the merge refuses hidden ones (and Merge Visible never gets any)
              const f = merging && merging.layers.length > 1 && merging.layers.every((l) => l.visible) && likeCanvasMerge(merging.layers) ? flattenDeep(d, merging) : null;
              if (f?.exact) flat = f;
            } catch (err) {
              console.warn('depth: merging at 8 bits', err);
            }
          }
          const result = base.run(arg, ctx);
          // the merged layer is the new active one; a merge that was refused leaves the old layers in the document
          const finish = (r) => {
            const merged = d?.active;
            if (flat && merged && !merging.layers.includes(merged) && !merging.layers.some((l) => d.layers().includes(l))) adopt(d, flat, merged);
            return r;
          };
          return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
        },
      });
    }

    // Image > Duplicate with "merged layers only" builds its one layer from the 8-bit composite: give it the float one.
    // lib/image-ops.js says which kind of duplicate it made. A copy with its layers kept is left alone: cloned layers
    // bring their own samples, and the composite is not what such a layer holds (pixels its mask hides, its opacity).
    app.on('image:duplicated', ({ source: d, copy, merged } = {}) => {
      try {
        const layer = merged && copy && copy !== d && copy.root.children.length === 1 ? copy.root.children[0] : null;
        if (d?.depth > 8 && copy.depth === d.depth && app.docs.docs.includes(d) && layer?.type === 'raster') {
          syncNow(copy);
          // nothing to gain when the 8-bit composite already holds all there is
          if (layer.deep && !hasPrecision(layer.deep)) {
            const f = flattenDeep(d);
            if (f.exact) adopt(copy, f, layer);
          }
        }
      } catch (err) {
        console.warn('depth: the duplicate was kept at 8 bits', err);
      }
    });
  }

  /**
   * Gives a raster layer of a deep document new deep pixels (a Uint16Array or Float32Array of its canvas size) and
   * the proxy that shows them, as one undo step: how other modules hand over results they computed in float.
   */
  function setPixels(doc, layer, data, label = 'Edit') {
    const type = DEEP_TYPES[doc?.depth];
    const canvas = layer?.canvas;
    if (!type || !canvas || !isDeepLayer(layer) || data?.length !== canvas.width * canvas.height * 4) return false;
    syncNow(doc);
    const w = canvas.width, h = canvas.height;
    const given = { type: data instanceof Float32Array ? 'f32' : 'u16', data };
    const deep = { type, data: (given.type === type ? given : convertDepth(given, type)).data };
    const before = { deep: layer.deep, pixels: ctx2d(canvas).getImageData(0, 0, w, h) };
    const after = { deep, pixels: new ImageData(toCanvasData({ ...deep, width: w, height: h }).data, w, h) };
    const apply = (state) => {
      if (layer.canvas !== canvas) return; // the sync pass sorts out a layer whose canvas was swapped
      ctx2d(canvas).putImageData(state.pixels, 0, 0);
      layer.deep = state.deep;
      layer.touch();
      if (layer.deep) remember(layer);
      doc.changed('pixels', { layer });
    };
    doc.history.run(label, () => {
      apply(after);
      return { undo: () => apply(before), redo: () => apply(after) };
    }, { bytes: w * h * 8 + deep.data.byteLength + (before.deep?.data.byteLength ?? 0) });
    return true;
  }

  // ---- export ---------------------------------------------------------------------------------------------------
  /** The flattened image as deep planes at the export size and over the export background. */
  function exportPlanes(doc, opts, compositor, type) {
    let flat;
    if (opts.canvas) {
      // a ready-made canvas (Export Layers to Files renders each layer on its own): 8-bit pixels
      flat = { ...fromCanvasData(ctx2d(opts.canvas).getImageData(0, 0, opts.canvas.width, opts.canvas.height), type), exact: false };
    } else flat = flattenDeep(doc, { type, compositor });
    const { exact } = flat;
    let planes = { type: flat.type, width: flat.width, height: flat.height, data: flat.data };
    if (opts.background) {
      const [r, g, b] = parseColor(opts.background, [255, 255, 255, 1]);
      const k = type === 'f32' ? 1 / 255 : 257;
      const bg = createDeep(planes.width, planes.height, type);
      const white = type === 'f32' ? 1 : 65535;
      for (let i = 0; i < bg.data.length; i += 4) {
        bg.data[i] = r * k;
        bg.data[i + 1] = g * k;
        bg.data[i + 2] = b * k;
        bg.data[i + 3] = white;
      }
      planes = blendDeep(bg, planes);
    }
    const w = Math.max(1, Math.round(opts.width ?? planes.width * (opts.scale ?? 1)));
    const h = Math.max(1, Math.round(opts.height ?? planes.height * (opts.scale ?? 1)));
    if (w !== planes.width || h !== planes.height) planes = resampleDeep(planes, w, h);
    return { planes, exact };
  }

  /** Drops the alpha channel when every pixel is opaque (smaller files, and what other programs expect). */
  function packChannels(planes, depth) {
    const { width, height, data } = planes;
    const white = depth === 32 ? 1 : depth === 16 ? 65535 : 255;
    let opaque = true;
    for (let i = 3; i < data.length && opaque; i += 4) if (data[i] < white) opaque = false;
    if (!opaque) return { width, height, channels: 4, depth, data };
    const n = width * height;
    const out = new data.constructor(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = data[i * 4];
      out[i * 3 + 1] = data[i * 4 + 1];
      out[i * 3 + 2] = data[i * 4 + 2];
    }
    return { width, height, channels: 3, depth, data: out };
  }

  /** The 8-bit flattened image at the export size (the sizing and background rules of io.js exportImage). */
  function exportImageData(doc, opts, compositor) {
    let canvas = opts.canvas ?? flattenDocument(doc, compositor);
    const w = Math.max(1, Math.round(opts.width ?? canvas.width * (opts.scale ?? 1)));
    const h = Math.max(1, Math.round(opts.height ?? canvas.height * (opts.scale ?? 1)));
    if (w !== canvas.width || h !== canvas.height || opts.background) {
      const out = createCanvas(w, h);
      const ctx = out.getContext('2d');
      if (opts.background) {
        ctx.fillStyle = opts.background;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, w, h);
      canvas = out;
    }
    return ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  }

  /** Lets the page breathe between the slow halves of an export (Export As also encodes for its size estimate). */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function encodePng16(doc, opts = {}, compositor) {
    const { planes } = exportPlanes(doc, opts, compositor, 'u16');
    await tick();
    // trying all five row filters on megapixels of 16-bit samples blocks for a second and saves about 1%
    return encodePng(packChannels(planes, 16), { dpi: doc.dpi, adaptive: planes.width * planes.height <= 1e6 });
  }

  async function encodeTiffDocument(doc, opts = {}, compositor) {
    const asked = Number(opts.tiffDepth);
    const depth = [8, 16, 32].includes(asked) ? asked : opts.canvas ? 8 : doc.depth ?? 8;
    const compression = ['none', 'lzw', 'packbits', 'deflate'].includes(opts.compression) ? opts.compression : 'lzw';
    let planes;
    if (depth === 8) {
      const img = exportImageData(doc, opts, compositor);
      planes = packChannels({ width: img.width, height: img.height, data: img.data }, 8);
    } else planes = packChannels(exportPlanes(doc, opts, compositor, depth === 32 ? 'f32' : 'u16').planes, depth);
    await tick();
    return encodeTiff(planes, { compression, dpi: doc.dpi });
  }

  async function encodeTgaDocument(doc, opts = {}, compositor) {
    const img = exportImageData(doc, opts, compositor);
    return encodeTga({ width: img.width, height: img.height, data: img.data }, { rle: opts.tgaRle !== false });
  }

  /** A line under the format's options that says whether the file gets a true 16-bit composite. */
  function depthNote(wantsDeep = () => true) {
    return (values, _set, form) => {
      const el = document.createElement('div');
      el.className = 'muted depth-note';
      const update = (v) => {
        const doc = app.doc;
        if (!doc) return;
        if (!wantsDeep(v, doc)) el.textContent = '8 bits/channel.';
        else {
          const plan = planFlatten(doc);
          el.textContent = plan.exact
            ? `Composited at ${doc.depth} bits/channel.`
            : doc.depth > 8
              ? `8-bit composite: ${plan.reason}, so the file holds the 8-bit result at a higher bit depth.`
              : '8-bit composite: the document is 8 bits/channel, so the file holds the same pixels at a higher bit depth.';
        }
        el.dataset.exact = String(wantsDeep(v, doc) && planFlatten(doc).exact);
      };
      update(values);
      // the form only re-syncs a custom field when its own key is set: follow the other fields through their events
      form?.element?.addEventListener('change', () => update(form.values));
      return el;
    };
  }
  const note = (key, wantsDeep) => ({ key, type: 'custom', render: depthNote(wantsDeep) });

  registerExportFormat('png16', {
    name: 'PNG 16-bit',
    ext: 'png',
    extensions: [], // .png keeps routing to the 8-bit PNG; this format is chosen in Export As (and for deep documents on Save)
    mime: 'image/png',
    encode: encodePng16,
    options: [note('png16Note')],
  });
  const tiffDeep = (v, doc) => (Number(v?.tiffDepth) || doc.depth || 8) > 8;
  registerExportFormat('tiff', {
    name: 'TIFF image',
    ext: 'tif',
    extensions: ['tif', 'tiff'],
    mime: 'image/tiff',
    encode: encodeTiffDocument,
    options: [
      { key: 'tiffDepth', label: 'Depth', type: 'select', value: 0, options: [[0, 'Same as the document'], [8, '8 bits/channel'], [16, '16 bits/channel'], [32, '32 bits/channel (float)']] },
      { key: 'compression', label: 'Compression', type: 'select', value: 'lzw', options: [['lzw', 'LZW'], ['deflate', 'ZIP (Deflate)'], ['packbits', 'PackBits'], ['none', 'None']] },
      note('tiffNote', tiffDeep),
    ],
  });
  registerExportFormat('tga', {
    name: 'Targa image',
    ext: 'tga',
    extensions: ['tga'],
    mime: 'image/x-tga',
    encode: encodeTgaDocument,
    options: [{ key: 'tgaRle', label: 'Compress (RLE)', type: 'checkbox', value: true }],
  });
  // Save As lists the flat formats this module writes (documents.js reads the array when the dialog opens)
  for (const f of [{ name: 'TIFF image', extensions: ['tif', 'tiff'] }, { name: 'Targa image', extensions: ['tga'] }]) {
    if (!SAVE_FILTERS.some((s) => s.name === f.name)) SAVE_FILTERS.push(f);
  }

  // ---- open -----------------------------------------------------------------------------------------------------
  /** A one-layer document from RGBA planes at their own depth ({ width, height, depth, data }). */
  function documentFromPlanes(img, { name, dpi }) {
    const { width, height, depth, data } = img;
    // no canvas can hold more (Chromium: 65535 px a side, 16384 x 16384 in all): refuse it instead of opening a blank
    // document. A long strip or panorama inside those bounds opens like the same picture as an 8-bit PNG does
    if (!(width > 0 && height > 0) || width > 65535 || height > 65535 || width * height > 2 ** 28) throw new Error(`The image is too large to open (${width} × ${height} pixels)`);
    const doc = new Document({ width, height, dpi: dpi > 0 ? Math.round(dpi) : 72, name: baseName(name), depth });
    const layer = new RasterLayer({ name: 'Background', width, height });
    const proxy = depth === 8 ? data : toCanvasData({ type: DEEP_TYPES[depth], data, width, height }).data;
    layer.canvas.getContext('2d').putImageData(new ImageData(proxy instanceof Uint8ClampedArray ? proxy : new Uint8ClampedArray(proxy), width, height), 0, 0);
    if (depth > 8) layer.deep = { type: DEEP_TYPES[depth], data };
    doc.root.children.push(layer);
    layer.parent = doc.root;
    doc.active = layer;
    doc.selected.add(layer);
    return doc;
  }

  registerOpenFormat({
    id: 'png16',
    // 8-bit PNGs keep the browser's decoder; only files that really carry 16-bit samples come here
    test: (bytes) => {
      try {
        return isPng(bytes) && pngInfo(bytes).bitDepth === 16;
      } catch {
        return false;
      }
    },
    read: async (bytes, { name }) => {
      const dec = await decodePng(bytes);
      const rgba = toRgba16(dec);
      // a copy: decodePng may hand out its own buffer, and the layer owns its samples
      return documentFromPlanes({ width: rgba.width, height: rgba.height, depth: 16, data: new Uint16Array(rgba.data) }, { name, dpi: dec.dpi });
    },
  });
  registerOpenFormat({
    id: 'tiff',
    name: 'TIFF images',
    extensions: ['tif', 'tiff'],
    test: (bytes, name) => isTiff(bytes) || ['tif', 'tiff'].includes(extOf(name)),
    read: async (bytes, { name }) => {
      const dec = await decodeTiff(bytes);
      const doc = documentFromPlanes(toRgba(dec), { name, dpi: dec.dpi });
      if (dec.pages > 1) doc.meta.note = `This TIFF holds ${dec.pages} images; Pigment opened the first one.`;
      return doc;
    },
  });
  registerOpenFormat({
    id: 'tga',
    name: 'Targa images',
    extensions: ['tga'],
    read: async (bytes, { name }) => {
      const img = decodeTga(bytes);
      return documentFromPlanes({ width: img.width, height: img.height, depth: 8, data: img.data }, { name });
    },
  });
  app.on('doc:opened', (doc) => {
    if (doc?.meta?.note && /^This TIFF holds/.test(doc.meta.note)) {
      app.dialogs.toast(doc.meta.note, { timeout: 4000 });
      delete doc.meta.note;
    }
  });

  // ---- saving ---------------------------------------------------------------------------------------------------
  // Deep pixels must describe the canvas before they are written (.pigment stores layer.deep as it is), a deep
  // document saved to .png keeps its depth (the registry routes .png to the 8-bit encoder), and PSD cannot hold
  // them: say so once per document. documents.js has no "about to save" event, so writeTo is wrapped here.
  const warnedPsd = new WeakSet();
  const docs = app.docs;
  if (docs && typeof docs.writeTo === 'function') {
    const writeTo = docs.writeTo.bind(docs);
    docs.writeTo = async (doc, path, opts = {}) => {
      if (!doc || !(doc.depth > 8)) return writeTo(doc, path, opts);
      app.tools?.active?.commit?.();
      syncNow(doc);
      const ext = extOf(path);
      if (ext === 'png') {
        try {
          const bytes = await app.busy(`Saving ${path.split(/[\\/]/).pop()}…`, () => encodePng16(doc, {}, doc.view.compositor));
          await bridge.writeFile(path, bytes);
          if (!opts.copy) doc.history.markSaved(flattenDocument(doc, doc.view.compositor));
          app.dialogs.toast(`Saved ${path.split(/[\\/]/).pop()} (16 bits/channel)`, { kind: 'success', timeout: 1600 });
          app.emit('doc:saved', doc);
          return true;
        } catch (err) {
          app.reportError(err, 'Could not save');
          return false;
        }
      }
      const ok = await writeTo(doc, path, opts);
      if (ok && ext === 'psd' && !warnedPsd.has(doc)) {
        warnedPsd.add(doc);
        app.dialogs.toast(`PSD files are written at 8 bits/channel. Save as .pigment, TIFF or PNG to keep ${doc.depth} bits.`, { timeout: 6000 });
      } else if (ok && !['pigment', 'psd', 'tif', 'tiff'].includes(ext) && !warnedPsd.has(doc)) {
        // every other format a document can be saved to (JPEG, WebP, TGA, GIF and whatever registers later) is 8-bit
        warnedPsd.add(doc);
        app.dialogs.toast(`${ext.toUpperCase()} files hold 8 bits/channel. Save as .pigment, TIFF or PNG to keep ${doc.depth} bits.`, { timeout: 6000 });
      }
      return ok;
    };
  }

  // ---- Info panel -----------------------------------------------------------------------------------------------
  /**
   * The deep value under a document pixel: { depth, values: [r, g, b, a], text: [..], precise }. The composite is
   * 8-bit, so the readout takes the deep samples of the topmost layer whose pixel is what the composite shows there
   * (precise: true) and falls back to the composite's 8-bit value scaled up. 16-bit values are shown on
   * Photoshop's 0..32768 scale (settings.info16Range = 65535 shows raw samples), 32-bit ones as floats.
   */
  function readout(doc, x, y) {
    if (!doc || !(doc.depth > 8) || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
    let rgba;
    try {
      const comp = doc.view.compositor.composite(doc);
      rgba = ctx2d(comp).getImageData(x, y, 1, 1).data;
    } catch {
      return null;
    }
    const f32 = doc.depth === 32;
    const q = f32 ? q8f32 : q8u16;
    let values = null;
    const layers = doc.layers();
    for (let i = layers.length - 1; i >= 0 && !values; i--) {
      const l = layers[i];
      if (!l.visible || !isDeepLayer(l) || !l.deep) continue;
      const lx = x - l.x, ly = y - l.y;
      if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height || l.deep.data.length !== l.canvas.width * l.canvas.height * 4) continue;
      const o = (ly * l.canvas.width + lx) * 4, d = l.deep.data;
      if (q(d[o]) === rgba[0] && q(d[o + 1]) === rgba[1] && q(d[o + 2]) === rgba[2] && q(d[o + 3]) > 0) values = [d[o], d[o + 1], d[o + 2], d[o + 3]];
    }
    const precise = !!values;
    if (!values) values = f32 ? [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3] / 255] : [rgba[0] * 257, rgba[1] * 257, rgba[2] * 257, rgba[3] * 257];
    const raw = app.settings.info16Range === 65535;
    const text = values.map((v, i) => (i === 3 ? `${Math.round((f32 ? Math.min(1, v) : v / 65535) * 100)}%` : f32 ? v.toFixed(4) : String(raw ? v : toPs16(v))));
    return { depth: doc.depth, values, text, precise };
  }

  let infoBlock = null;
  let pointer = null;
  let infoFrame = 0;
  function infoElement() {
    if (infoBlock?.isConnected) return infoBlock;
    const panel = app.panels?.panels?.get('info')?.panel?.element;
    // the pointer block's second column (X, Y) has room under it, next to the 8-bit RGB values
    const anchor = panel?.querySelectorAll('.info-pointer .info-col')[1];
    if (!anchor) return null;
    infoBlock = document.createElement('div');
    infoBlock.className = 'info-deep';
    infoBlock.hidden = true;
    infoBlock.innerHTML = `
      <div class="info-title muted" data-k="deep-title">16-bit</div>
      <div class="info-grid info-deep-grid">
        <span class="k">R</span><span data-k="deep-r">—</span>
        <span class="k">G</span><span data-k="deep-g">—</span>
        <span class="k">B</span><span data-k="deep-b">—</span>
        <span class="k">A</span><span data-k="deep-a">—</span>
      </div>`;
    anchor.appendChild(infoBlock);
    return infoBlock;
  }
  function renderInfo() {
    infoFrame = 0;
    const doc = app.doc;
    const deep = !!doc && doc.depth > 8;
    if (!deep && !infoBlock) return; // nothing to show and nothing shown: leave the panel alone
    const el = infoElement();
    if (!el) return;
    el.hidden = !deep;
    if (!deep) return;
    const p = pointer && pointer.doc === doc ? pointer : null;
    const r = p ? readout(doc, Math.floor(p.x), Math.floor(p.y)) : null;
    const set = (k, v) => {
      el.querySelector(`[data-k="deep-${k}"]`).textContent = v;
    };
    set('title', `${doc.depth}-bit${doc.depth === 16 ? (app.settings.info16Range === 65535 ? ' (0–65535)' : ' (0–32768)') : ' (float)'}${r && !r.precise ? ' · from 8-bit' : ''}`);
    ['r', 'g', 'b', 'a'].forEach((k, i) => set(k, r ? r.text[i] : '—'));
  }
  const scheduleInfo = () => {
    if (infoFrame) return;
    infoFrame = requestAnimationFrame(renderInfo);
  };
  app.on('pointer:moved', ({ view, x, y }) => {
    pointer = { doc: view?.doc ?? app.doc, x, y };
    if ((app.doc?.depth > 8 || infoBlock) && app.panels?.isVisible?.('info')) scheduleInfo();
  });
  app.on('doc:activated', () => {
    pointer = null;
    scheduleInfo();
  });
  app.on('doc:change', (e) => {
    if (e?.doc === app.doc && (e.kind === 'props' || e.kind === 'pixels' || e.kind === 'history') && (app.doc?.depth > 8 || infoBlock)) scheduleInfo();
  });

  // ---- for other modules and tests ------------------------------------------------------------------------------
  app.deep = {
    /** Brings the deep pixels of a document in step with its canvases now (the debounced pass does it otherwise). */
    sync: (doc = app.doc) => syncNow(doc),
    setDepth: (doc, depth, opts) => setDepth(doc, depth, opts),
    allowedDepths,
    /** A float copy of a raster layer's pixels: { width, height, data: Float32Array RGBA, 0..1 }. */
    toFloat(layer) {
      if (!layer || layer.type !== 'raster') return null;
      const w = layer.canvas.width, h = layer.canvas.height;
      const doc = app.docs?.docs?.find((d) => d.layers().includes(layer));
      if (doc?.depth > 8) syncNow(doc);
      const planes = layer.deep?.data?.length === w * h * 4 ? planesOf(layer) : fromCanvasData(ctx2d(layer.canvas).getImageData(0, 0, w, h), 'f32');
      return { width: w, height: h, data: planes.type === 'f32' ? planes.data.slice() : convertDepth(planes, 'f32').data };
    },
    /** Replaces a layer's pixels with deep samples computed elsewhere (one undo step); false when it does not apply. */
    setPixels: (layer, data, label) => setPixels(app.docs?.docs?.find((d) => d.layers().includes(layer)) ?? app.doc, layer, data, label),
    /** Deep planes of a layer ({ type, data, width, height }, the live arrays) or null. */
    planes: (layer) => (layer?.deep ? planesOf(layer) : null),
    flatten: (doc = app.doc, opts) => flattenDeep(doc, opts),
    plan: (doc = app.doc) => planFlatten(doc),
    readout,
    statistics: (layer, rect) => (layer?.deep ? statistics(planesOf(layer), rect) : null),
  };
}
